//! Conservative cold-start budgets, derived from local hardware rather than a
//! fixed desktop preset. A budget is not an OS reservation or a speed promise.
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::System;

const GIB: u64 = 1024 * 1024 * 1024;
pub(super) const STARTUP_RAM_PRESSURE: &str =
    "Local runtime startup stopped to protect available RAM (runtime_startup_ram_pressure).";

pub(super) struct StartupMemoryGuard {
    floor_bytes: u64,
    below_since: Option<Instant>,
    low_samples: u8,
}

impl StartupMemoryGuard {
    pub(super) fn new(total_ram: u64) -> Self {
        Self {
            floor_bytes: (total_ram / 50).clamp(GIB / 2, GIB),
            below_since: None,
            low_samples: 0,
        }
    }

    pub(super) fn observe(
        &mut self,
        total_ram: u64,
        available_ram: u64,
        now: Instant,
    ) -> Result<(), String> {
        if total_ram == 0 || available_ram >= self.floor_bytes {
            self.below_since = None;
            self.low_samples = 0;
            return Ok(());
        }
        // An observed near-empty system cannot wait through staging hysteresis.
        if available_ram < GIB / 8 {
            return Err(STARTUP_RAM_PRESSURE.into());
        }
        self.low_samples = self.low_samples.saturating_add(1);
        let since = self.below_since.get_or_insert(now);
        if self.low_samples >= 3 && now.saturating_duration_since(*since) >= Duration::from_secs(1)
        {
            return Err(STARTUP_RAM_PRESSURE.into());
        }
        Ok(())
    }
}

struct Sampler {
    system: System,
    last_cpu_sample: Instant,
    cpu_load: Option<f32>,
}

static SAMPLER: OnceLock<Mutex<Sampler>> = OnceLock::new();

#[derive(Debug, Clone)]
pub(super) struct ResourceSnapshot {
    pub(super) logical_cores: usize,
    pub(super) physical_cores: Option<usize>,
    pub(super) available_logical_cores: usize,
    pub(super) cpu_load: Option<f32>,
    pub(super) total_ram_bytes: u64,
    pub(super) available_ram_bytes: u64,
}

pub(super) fn sample_hardware() -> Result<ResourceSnapshot, String> {
    let sampler = SAMPLER.get_or_init(|| {
        let mut system = System::new();
        system.refresh_cpu_all();
        Mutex::new(Sampler {
            system,
            last_cpu_sample: Instant::now(),
            cpu_load: None,
        })
    });
    let mut sampler = sampler
        .lock()
        .map_err(|_| "Local resource sampler is unavailable.")?;
    if sampler.last_cpu_sample.elapsed() >= sysinfo::MINIMUM_CPU_UPDATE_INTERVAL {
        sampler.system.refresh_cpu_all();
        let usage = sampler.system.global_cpu_usage();
        sampler.cpu_load = usage.is_finite().then_some(usage.clamp(0.0, 100.0));
        sampler.last_cpu_sample = Instant::now();
    }
    sampler.system.refresh_memory();
    let logical = sampler.system.cpus().len().max(1);
    // available_parallelism includes the process's actual scheduler/affinity
    // restrictions; never assume every machine-wide logical core is available.
    let available = std::thread::available_parallelism()
        .map_or(1, usize::from)
        .min(logical);
    Ok(ResourceSnapshot {
        logical_cores: logical,
        physical_cores: sampler.system.physical_core_count(),
        available_logical_cores: available,
        cpu_load: sampler.cpu_load,
        total_ram_bytes: sampler.system.total_memory(),
        available_ram_bytes: sampler.system.available_memory(),
    })
}

#[derive(Debug, Clone, Default)]
pub(super) struct RuntimeOptions {
    pub(super) fit: bool,
    resource_controls: bool,
    load_mode: bool,
    buffered_load_mode: bool,
    mmap: bool,
    no_mmap: bool,
    polling: bool,
    http_threads: bool,
    flash_attn: bool,
    kv_cache_quant: bool,
    pub(super) slot_save_path: bool,
}

impl RuntimeOptions {
    pub(super) fn from_help(help: &str) -> Self {
        let supported = |flag: &str| {
            help.split_whitespace()
                .any(|word| word.trim_end_matches(',') == flag)
        };
        Self {
            fit: supported("--fit"),
            resource_controls: [
                "--threads ",
                "--threads-batch ",
                "--batch-size ",
                "--ubatch-size ",
            ]
            .iter()
            .all(|flag| help.contains(flag)),
            load_mode: supported("--load-mode"),
            buffered_load_mode: supported("--load-mode")
                && help
                    .lines()
                    .any(|line| line.trim_start().starts_with("- none:")),
            mmap: supported("--mmap"),
            no_mmap: supported("--no-mmap"),
            polling: help.contains("--poll ") && help.contains("--poll-batch "),
            http_threads: help.contains("--threads-http "),
            // Quantized KV cache (anything other than f16) requires flash attention in
            // llama.cpp, so both are gated on --flash-attn advertising support.
            flash_attn: supported("--flash-attn"),
            kv_cache_quant: supported("--cache-type-k") && supported("--cache-type-v"),
            slot_save_path: supported("--slot-save-path"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum LoadMode {
    Mmap,
    Buffered,
    RuntimeDefault,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResourcePlan {
    resource_revision: u64,
    requested_mode: String,
    schema_version: u8,
    profile: String,
    logical_cores: usize,
    physical_cores: Option<usize>,
    available_logical_cores: usize,
    threads: usize,
    threads_batch: usize,
    reserved_logical_cores: usize,
    total_ram_bytes: u64,
    available_ram_bytes: u64,
    ram_headroom_bytes: u64,
    batch_size: u32,
    micro_batch_size: u32,
    context_tokens: u32,
    load_mode: LoadMode,
    mmap: bool,
    parallel_slots: u8,
    applied: bool,
    reason_codes: Vec<String>,
    #[serde(skip)]
    arguments: Vec<String>,
}

impl ResourcePlan {
    pub(super) fn arguments(&self) -> &[String] {
        &self.arguments
    }

    pub(super) fn confirm_started(&mut self) {
        self.applied = !self.arguments.is_empty();
    }

    pub(super) fn total_ram_bytes(&self) -> u64 {
        self.total_ram_bytes
    }
}

pub(super) fn plan_resources(
    hardware: &ResourceSnapshot,
    context_tokens: u32,
    model_bytes: u64,
    backend: &str,
    options: &RuntimeOptions,
) -> ResourcePlan {
    plan_resources_for_platform(
        hardware,
        context_tokens,
        model_bytes,
        backend,
        options,
        cfg!(windows),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn plan_resources_configured(
    hardware: &ResourceSnapshot,
    context_tokens: u32,
    model_bytes: u64,
    backend: &str,
    options: &RuntimeOptions,
    config: &super::resource_config::LocalResourceConfig,
    gpu_budget_bytes: u64,
    revision: u64,
) -> Result<ResourcePlan, String> {
    for value in [config.threads, config.threads_batch].into_iter().flatten() {
        if value == 0 || value > hardware.available_logical_cores {
            return Err("resource_threads_invalid".into());
        }
    }
    let headroom = config
        .ram_reserve_bytes
        .unwrap_or((hardware.total_ram_bytes / 12).clamp(GIB, 4 * GIB));
    if config.ram_reserve_bytes.is_some()
        && (headroom < GIB || headroom > hardware.total_ram_bytes.saturating_sub(GIB))
    {
        return Err("resource_ram_reserve_invalid".into());
    }
    let host_model = if backend == "cpu" {
        model_bytes
    } else {
        model_bytes.saturating_sub(gpu_budget_bytes)
    };
    if host_model > hardware.available_ram_bytes.saturating_sub(headroom) {
        return Err("ram_budget_insufficient".into());
    }
    if (config.threads.is_some() || config.threads_batch.is_some()) && !options.resource_controls {
        return Err("resource_thread_controls_unavailable".into());
    }
    let mut adjusted = hardware.clone();
    // Reserve the estimated host weight remainder separately from GPU budgets.
    // This is a conservative batch planning input, not a claim about GGUF/KV fit.
    if backend != "cpu" {
        adjusted.available_ram_bytes = adjusted.available_ram_bytes.saturating_sub(host_model);
    }
    let default_headroom = (hardware.total_ram_bytes / 12).clamp(GIB, 4 * GIB);
    adjusted.available_ram_bytes = adjusted
        .available_ram_bytes
        .saturating_sub(headroom.saturating_sub(default_headroom));
    let mut plan = plan_resources(&adjusted, context_tokens, model_bytes, backend, options);
    plan.resource_revision = revision;
    plan.requested_mode = config.mode.clone();
    plan.available_ram_bytes = hardware.available_ram_bytes;
    plan.ram_headroom_bytes = headroom;
    if let Some(threads) = config.threads {
        plan.threads = threads;
    }
    if let Some(threads) = config.threads_batch {
        plan.threads_batch = threads;
    }
    if config.threads.is_some() || config.threads_batch.is_some() {
        plan.reserved_logical_cores = hardware
            .available_logical_cores
            .saturating_sub(plan.threads.max(plan.threads_batch));
    }
    for pair in plan.arguments.chunks_mut(2) {
        if pair.len() == 2 && pair[0] == "--threads" {
            pair[1] = plan.threads.to_string();
        }
        if pair.len() == 2 && pair[0] == "--threads-batch" {
            pair[1] = plan.threads_batch.to_string();
        }
    }
    if config.threads.is_some() || config.threads_batch.is_some() {
        plan.reason_codes.push("resource_expert_threads".into());
    }
    if config.ram_reserve_bytes.is_some() {
        plan.reason_codes.push("resource_expert_ram_reserve".into());
    }
    if host_model > 0 && backend != "cpu" {
        plan.reason_codes.push("hybrid_host_weight_budget".into());
    }
    Ok(plan)
}

fn plan_resources_for_platform(
    hardware: &ResourceSnapshot,
    context_tokens: u32,
    model_bytes: u64,
    backend: &str,
    options: &RuntimeOptions,
    windows: bool,
) -> ResourcePlan {
    let gpu_selected = backend != "cpu";
    let available = hardware
        .available_logical_cores
        .max(1)
        .min(hardware.logical_cores.max(1));
    let reserved = match available {
        1 => 0,
        2..=7 => 1,
        _ => 2,
    };
    let usable = available.saturating_sub(reserved).max(1);
    let physical = hardware.physical_cores.filter(|cores| *cores > 0);
    let physical_budget = physical
        .unwrap_or(available)
        .min(available)
        .saturating_sub(usize::from(available > 2))
        .max(1);
    let headroom = (hardware.total_ram_bytes / 12)
        .clamp(GIB, 4 * GIB)
        .min(hardware.available_ram_bytes);
    let host_budget = hardware.available_ram_bytes.saturating_sub(headroom);
    let working_budget = host_budget.saturating_sub(if gpu_selected { 0 } else { model_bytes });
    let memory_pressure = hardware.available_ram_bytes < 4 * GIB
        || hardware.available_ram_bytes < hardware.total_ram_bytes / 10
        || working_budget < 4 * GIB;
    let cpu_pressure = hardware.cpu_load.is_some_and(|usage| usage >= 85.0);
    let (profile, batch, micro_batch) = if memory_pressure {
        ("memory_saving", 128, 32)
    } else if gpu_selected && working_budget >= 12 * GIB && !cpu_pressure {
        ("throughput", 1024, 256)
    } else {
        ("balanced", 512, 128)
    };
    let mut threads = physical_budget
        .min(usable)
        .min(if gpu_selected { 8 } else { 32 });
    if cpu_pressure {
        threads = threads.div_ceil(2);
    }
    let threads_batch = if memory_pressure || cpu_pressure {
        threads
    } else {
        usable.min(if gpu_selected { 16 } else { 32 }).max(threads)
    };
    let context_tokens = context_tokens.max(1);
    let batch_size = batch.min(context_tokens);
    let micro_batch_size = micro_batch.min(batch_size);
    let mut reasons = vec!["single_local_slot".into(), "ram_headroom_target".into()];
    if reserved > 0 {
        reasons.push("cpu_ui_headroom".into());
    }
    if memory_pressure {
        reasons.push("memory_pressure_reduced_batch".into());
    }
    if cpu_pressure {
        reasons.push("cpu_pressure_reduced_threads".into());
    }
    if physical.is_none() {
        reasons.push("physical_cpu_count_unavailable".into());
    }
    if available < hardware.logical_cores {
        reasons.push("process_cpu_limit".into());
    }
    if !gpu_selected && model_bytes > host_budget {
        reasons.push("cpu_model_ram_budget".into());
    }
    // This Windows llama.cpp loader retains the complete mmap view after CUDA
    // upload. For large mappings, buffered loading avoids that additional host
    // working set. CUDA's non-mmap loader uses bounded upload staging instead.
    let prefer_buffered = windows
        && backend == "cuda"
        && model_bytes >= 2 * GIB
        && (memory_pressure || model_bytes >= host_budget.saturating_sub(host_budget / 4));
    let buffered_supported = options.buffered_load_mode || options.no_mmap;
    let load_mode = if !options.resource_controls {
        LoadMode::RuntimeDefault
    } else if prefer_buffered && buffered_supported {
        LoadMode::Buffered
    } else if options.load_mode || options.mmap {
        LoadMode::Mmap
    } else {
        LoadMode::RuntimeDefault
    };
    if prefer_buffered && !buffered_supported {
        reasons.push("runtime_buffered_loading_unavailable".into());
    }
    let mut arguments = Vec::new();
    if options.resource_controls {
        arguments.extend([
            "--threads".into(),
            threads.to_string(),
            "--threads-batch".into(),
            threads_batch.to_string(),
            "--batch-size".into(),
            batch_size.to_string(),
            "--ubatch-size".into(),
            micro_batch_size.to_string(),
        ]);
        if load_mode == LoadMode::Buffered {
            if options.buffered_load_mode {
                arguments.extend(["--load-mode".into(), "none".into()]);
            } else {
                arguments.push("--no-mmap".into());
            }
            reasons.push("windows_cuda_buffered_loading".into());
        } else if load_mode == LoadMode::Mmap {
            if options.load_mode {
                arguments.extend(["--load-mode".into(), "mmap".into()]);
            } else {
                arguments.push("--mmap".into());
            }
            reasons.push("mmap_without_memory_lock".into());
        }
        if options.polling {
            arguments.extend([
                "--poll".into(),
                "0".into(),
                "--poll-batch".into(),
                "0".into(),
            ]);
        }
        if options.http_threads {
            arguments.extend(["--threads-http".into(), "2".into()]);
        }
    } else {
        reasons.push("runtime_resource_controls_unavailable".into());
    }
    // Flash attention lowers attention working memory with no measured quality loss and,
    // on the GPU backends where VRAM is the binding constraint, unlocks quantized KV
    // cache storage (q8_0 halves KV cache bytes versus f16 for a negligible perplexity
    // cost). llama.cpp requires flash attention to be active before it will accept a
    // non-f16 cache type, so the two flags are only ever emitted together.
    if options.flash_attn {
        arguments.push("--flash-attn".into());
        reasons.push("flash_attention_enabled".into());
        if gpu_selected && options.kv_cache_quant {
            arguments.extend([
                "--cache-type-k".into(),
                "q8_0".into(),
                "--cache-type-v".into(),
                "q8_0".into(),
            ]);
            reasons.push("kv_cache_q8_quantized".into());
        }
    }
    ResourcePlan {
        resource_revision: 0,
        requested_mode: "auto".into(),
        schema_version: 1,
        profile: profile.into(),
        logical_cores: hardware.logical_cores.max(1),
        physical_cores: physical,
        available_logical_cores: available,
        threads,
        threads_batch,
        reserved_logical_cores: reserved,
        total_ram_bytes: hardware.total_ram_bytes,
        available_ram_bytes: hardware.available_ram_bytes,
        ram_headroom_bytes: headroom,
        batch_size,
        micro_batch_size,
        context_tokens,
        load_mode,
        mmap: load_mode == LoadMode::Mmap,
        parallel_slots: 1,
        applied: false,
        reason_codes: reasons,
        arguments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expert_configuration_is_applied_and_cpu_or_hybrid_host_weights_remain_budgeted() {
        let mut hardware = hardware();
        hardware.available_ram_bytes = 20 * GIB;
        let config = super::super::resource_config::LocalResourceConfig {
            threads: Some(4),
            threads_batch: Some(6),
            ram_reserve_bytes: Some(3 * GIB),
            ..Default::default()
        };
        let plan = plan_resources_configured(
            &hardware,
            32768,
            18 * GIB,
            "cuda",
            &options(),
            &config,
            16 * GIB,
            7,
        )
        .unwrap();
        assert_eq!(
            (plan.threads, plan.threads_batch, plan.ram_headroom_bytes),
            (4, 6, 3 * GIB)
        );
        assert_eq!(plan.resource_revision, 7);
        assert!(plan
            .reason_codes
            .iter()
            .any(|code| code == "hybrid_host_weight_budget"));
        assert!(plan
            .arguments
            .windows(2)
            .any(|pair| pair == ["--threads", "4"]));
        assert_eq!(
            plan_resources_configured(&hardware, 32768, 18 * GIB, "cpu", &options(), &config, 0, 7)
                .unwrap_err(),
            "ram_budget_insufficient"
        );
        assert_eq!(
            plan_resources_configured(
                &hardware,
                32768,
                35 * GIB,
                "cuda",
                &options(),
                &config,
                16 * GIB,
                7
            )
            .unwrap_err(),
            "ram_budget_insufficient"
        );
    }
    #[test]
    fn changed_cpu_affinity_and_unavailable_expert_flags_are_revalidated_at_start() {
        let mut hardware = hardware();
        hardware.available_logical_cores = 2;
        let config = super::super::resource_config::LocalResourceConfig {
            threads: Some(3),
            ..Default::default()
        };
        assert_eq!(
            plan_resources_configured(&hardware, 32768, GIB, "cpu", &options(), &config, 0, 1)
                .unwrap_err(),
            "resource_threads_invalid"
        );
        let config = super::super::resource_config::LocalResourceConfig {
            threads: Some(2),
            ..Default::default()
        };
        assert_eq!(
            plan_resources_configured(
                &hardware,
                32768,
                GIB,
                "cpu",
                &RuntimeOptions::default(),
                &config,
                0,
                1
            )
            .unwrap_err(),
            "resource_thread_controls_unavailable"
        );
    }
    fn hardware() -> ResourceSnapshot {
        ResourceSnapshot {
            logical_cores: 24,
            physical_cores: Some(12),
            available_logical_cores: 24,
            cpu_load: Some(15.0),
            total_ram_bytes: 64 * GIB,
            available_ram_bytes: 32 * GIB,
        }
    }
    fn options() -> RuntimeOptions {
        RuntimeOptions::from_help("--threads N\n--threads-batch N\n--batch-size N\n--ubatch-size N\n--load-mode MODE\n- none: no special loading mode\n--poll N\n--poll-batch N\n--threads-http N")
    }
    #[test]
    fn large_gpu_machine_uses_bounded_parallelism_without_context_or_residency_changes() {
        let plan = plan_resources(&hardware(), 32768, 17 * GIB, "cuda", &options());
        assert_eq!(plan.profile, "throughput");
        assert_eq!(
            (
                plan.threads,
                plan.threads_batch,
                plan.reserved_logical_cores
            ),
            (8, 16, 2)
        );
        assert_eq!((plan.batch_size, plan.micro_batch_size), (1024, 256));
        assert_eq!(plan.context_tokens, 32768);
        assert!(!plan.applied);
        assert!(!plan
            .arguments
            .iter()
            .any(|value| value.contains("mlock") || value == "--ctx-size"));
    }
    #[test]
    fn low_memory_and_affinity_limits_leave_ui_room_and_reduce_batch_work() {
        let mut hardware = hardware();
        hardware.available_logical_cores = 4;
        hardware.available_ram_bytes = 3 * GIB;
        let plan = plan_resources(&hardware, 32768, 17 * GIB, "cuda", &options());
        assert_eq!((plan.threads, plan.threads_batch), (3, 3));
        assert_eq!((plan.batch_size, plan.micro_batch_size), (128, 32));
        assert_eq!(plan.profile, "memory_saving");
        assert!(plan
            .reason_codes
            .iter()
            .any(|reason| reason == "process_cpu_limit"));
        assert!(plan.ram_headroom_bytes <= hardware.available_ram_bytes);
    }
    #[test]
    fn cpu_fallback_recomputes_ram_budget_and_cpu_pressure_does_not_expand_threads() {
        let mut hardware = hardware();
        hardware.available_ram_bytes = 20 * GIB;
        let gpu = plan_resources(&hardware, 32768, 17 * GIB, "cuda", &options());
        let cpu = plan_resources(&hardware, 32768, 17 * GIB, "cpu", &options());
        assert!(cpu.batch_size < gpu.batch_size);
        hardware.cpu_load = Some(98.0);
        let busy = plan_resources(&hardware, 32768, 17 * GIB, "cpu", &options());
        assert!(busy.threads < cpu.threads);
        assert_eq!(busy.threads, busy.threads_batch);
    }
    #[test]
    fn one_cpu_small_context_and_unknown_cli_never_claim_applied_resource_settings() {
        let mut hardware = hardware();
        hardware.logical_cores = 1;
        hardware.available_logical_cores = 1;
        hardware.physical_cores = None;
        let mut plan = plan_resources(&hardware, 16, 1, "cpu", &RuntimeOptions::default());
        assert_eq!(plan.threads, 1);
        assert_eq!(plan.reserved_logical_cores, 0);
        assert_eq!(plan.batch_size, 16);
        assert_eq!(plan.micro_batch_size, 16);
        plan.confirm_started();
        assert!(!plan.applied);
        assert!(plan.arguments.is_empty());
        assert_eq!(plan.load_mode, LoadMode::RuntimeDefault);
        assert!(!plan.mmap);
    }
    #[test]
    fn old_mmap_flag_remains_supported_and_health_changes_only_applied_state() {
        let options = RuntimeOptions::from_help(
            "--threads N --threads-batch N --batch-size N --ubatch-size N --mmap",
        );
        let mut plan = plan_resources(&hardware(), 32768, GIB, "cpu", &options);
        assert!(plan.arguments.iter().any(|arg| arg == "--mmap"));
        assert!(!plan.arguments.iter().any(|arg| arg == "--load-mode"));
        plan.confirm_started();
        assert!(plan.applied);
        assert!(!serde_json::to_string(&plan).unwrap().contains("arguments"));
    }

    #[test]
    fn slot_save_path_capability_requires_advertised_runtime_support() {
        assert!(!RuntimeOptions::default().slot_save_path);
        assert!(
            RuntimeOptions::from_help("--threads N --slot-save-path PATH").slot_save_path
        );
    }

    #[test]
    fn flash_attention_and_kv_quantization_require_advertised_runtime_support() {
        // No advertised support: neither flag is ever emitted, on any backend.
        let plan = plan_resources(&hardware(), 32768, 17 * GIB, "cuda", &RuntimeOptions::default());
        assert!(!plan.arguments.iter().any(|arg| arg == "--flash-attn"));
        assert!(!plan.arguments.iter().any(|arg| arg == "--cache-type-k"));
    }

    #[test]
    fn flash_attention_alone_is_enabled_without_kv_quantization_support() {
        let options = RuntimeOptions::from_help(
            "--threads N --threads-batch N --batch-size N --ubatch-size N --flash-attn",
        );
        let plan = plan_resources(&hardware(), 32768, 17 * GIB, "cuda", &options);
        assert!(plan.arguments.iter().any(|arg| arg == "--flash-attn"));
        assert!(!plan.arguments.iter().any(|arg| arg == "--cache-type-k"));
        assert!(plan
            .reason_codes
            .iter()
            .any(|reason| reason == "flash_attention_enabled"));
    }

    #[test]
    fn kv_cache_is_quantized_to_q8_on_gpu_backends_once_flash_attention_is_available() {
        let options = RuntimeOptions::from_help(
            "--threads N --threads-batch N --batch-size N --ubatch-size N --flash-attn --cache-type-k TYPE --cache-type-v TYPE",
        );
        let gpu = plan_resources(&hardware(), 32768, 17 * GIB, "cuda", &options);
        assert!(gpu.arguments.iter().any(|arg| arg == "--flash-attn"));
        assert!(gpu
            .arguments
            .windows(2)
            .any(|pair| pair == ["--cache-type-k", "q8_0"]));
        assert!(gpu
            .arguments
            .windows(2)
            .any(|pair| pair == ["--cache-type-v", "q8_0"]));
        assert!(gpu
            .reason_codes
            .iter()
            .any(|reason| reason == "kv_cache_q8_quantized"));
        // CPU-only inference keeps flash attention's compute-time benefit but skips the
        // KV quantization step, which targets VRAM pressure specifically.
        let cpu = plan_resources(&hardware(), 32768, GIB, "cpu", &options);
        assert!(cpu.arguments.iter().any(|arg| arg == "--flash-attn"));
        assert!(!cpu.arguments.iter().any(|arg| arg == "--cache-type-k"));
    }

    #[test]
    fn windows_cuda_large_mapping_uses_buffered_loading_with_unchanged_inference_settings() {
        let mut hardware = hardware();
        hardware.total_ram_bytes = 32 * GIB;
        hardware.available_ram_bytes = 14 * GIB;
        let mut plan =
            plan_resources_for_platform(&hardware, 32768, 17 * GIB, "cuda", &options(), true);
        assert_eq!(plan.load_mode, LoadMode::Buffered);
        assert!(!plan.mmap);
        assert!(!plan.applied);
        assert!(plan
            .arguments
            .windows(2)
            .any(|pair| pair == ["--load-mode", "none"]));
        assert_eq!((plan.threads, plan.threads_batch), (8, 16));
        assert_eq!((plan.batch_size, plan.micro_batch_size), (512, 128));
        assert_eq!(plan.context_tokens, 32768);
        assert_eq!(plan.parallel_slots, 1);
        assert!(plan
            .reason_codes
            .iter()
            .any(|reason| reason == "windows_cuda_buffered_loading"));
        plan.confirm_started();
        let value = serde_json::to_value(&plan).unwrap();
        assert_eq!(value["loadMode"], "buffered");
        assert_eq!(value["mmap"], false);
        assert_eq!(value["applied"], true);
    }

    #[test]
    fn buffered_loading_is_limited_to_windows_cuda_and_large_relative_mappings() {
        let mut constrained = hardware();
        constrained.available_ram_bytes = 3 * GIB;
        for (windows, backend, model_size, snapshot) in [
            (false, "cuda", 17 * GIB, &constrained),
            (true, "cpu", 17 * GIB, &constrained),
            (true, "vulkan", 17 * GIB, &constrained),
            (true, "metal", 17 * GIB, &constrained),
            (true, "cuda", GIB, &constrained),
            (true, "cuda", 17 * GIB, &hardware()),
        ] {
            let plan = plan_resources_for_platform(
                snapshot,
                32768,
                model_size,
                backend,
                &options(),
                windows,
            );
            assert_eq!(plan.load_mode, LoadMode::Mmap, "{windows}/{backend}");
            assert!(plan.mmap);
        }
        constrained.available_ram_bytes = 20 * GIB; // 16 GiB after headroom
        for (model_bytes, expected) in [
            (12 * GIB - 1, LoadMode::Mmap),
            (12 * GIB, LoadMode::Buffered),
        ] {
            let plan = plan_resources_for_platform(
                &constrained,
                32768,
                model_bytes,
                "cuda",
                &options(),
                true,
            );
            assert_eq!(plan.load_mode, expected);
        }
    }

    #[test]
    fn buffered_loading_requires_advertised_none_mode_or_exact_legacy_no_mmap_flag() {
        let mut hardware = hardware();
        hardware.available_ram_bytes = 3 * GIB;
        let controls = "--threads N --threads-batch N --batch-size N --ubatch-size N";
        for cli in [
            format!("{controls} --mmap, --no-mmap"),
            format!("{controls} --load-mode MODE --no-mmap"),
        ] {
            let plan = plan_resources_for_platform(
                &hardware,
                32768,
                17 * GIB,
                "cuda",
                &RuntimeOptions::from_help(&cli),
                true,
            );
            assert_eq!(plan.load_mode, LoadMode::Buffered);
            assert!(plan.arguments.iter().any(|arg| arg == "--no-mmap"));
            assert!(!plan.arguments.iter().any(|arg| arg == "--load-mode"));
        }
        for (cli, expected) in [
            (format!("{controls} --mmap --no-mmap-extra"), LoadMode::Mmap),
            (format!("{controls} --load-mode MODE"), LoadMode::Mmap),
            (
                "--load-mode MODE\n- none: supported".into(),
                LoadMode::RuntimeDefault,
            ),
            (String::new(), LoadMode::RuntimeDefault),
        ] {
            let mut plan = plan_resources_for_platform(
                &hardware,
                32768,
                17 * GIB,
                "cuda",
                &RuntimeOptions::from_help(&cli),
                true,
            );
            assert_eq!(plan.load_mode, expected);
            assert!(!plan
                .arguments
                .iter()
                .any(|arg| arg == "none" || arg == "--no-mmap"));
            plan.confirm_started();
            assert_eq!(plan.applied, expected != LoadMode::RuntimeDefault);
        }
    }

    #[test]
    fn startup_ram_guard_stops_immediately_below_128_mib_without_rejecting_unknown_measurements() {
        let start = Instant::now();
        for available in [0, 6 * 1024 * 1024, GIB / 8 - 1] {
            let mut guard = StartupMemoryGuard::new(32 * GIB);
            assert_eq!(
                guard.observe(32 * GIB, available, start).unwrap_err(),
                STARTUP_RAM_PRESSURE
            );
        }
        let mut guard = StartupMemoryGuard::new(32 * GIB);
        assert!(guard.observe(32 * GIB, GIB / 8, start).is_ok());
        assert!(guard.observe(0, 0, start).is_ok());
    }

    #[test]
    fn startup_ram_guard_allows_transient_staging_but_rejects_sustained_critical_pressure() {
        let start = Instant::now();
        let mut guard = StartupMemoryGuard::new(32 * GIB);
        assert!(guard.observe(32 * GIB, 2 * GIB, start).is_ok());
        assert!(guard
            .observe(32 * GIB, GIB / 4, start + Duration::from_millis(200))
            .is_ok());
        assert!(guard
            .observe(32 * GIB, 2 * GIB, start + Duration::from_millis(600))
            .is_ok());
        for offset in [1000, 1500] {
            assert!(guard
                .observe(32 * GIB, GIB / 4, start + Duration::from_millis(offset))
                .is_ok());
        }
        assert_eq!(
            guard
                .observe(32 * GIB, GIB / 4, start + Duration::from_millis(2100))
                .unwrap_err(),
            STARTUP_RAM_PRESSURE
        );
        assert!(guard
            .observe(0, 0, start + Duration::from_millis(2200))
            .is_ok());
    }

    #[test]
    #[ignore = "read-only resource-plan sample of the current hardware; run explicitly"]
    fn resource_plan_live_readonly() {
        let hardware = sample_hardware().unwrap();
        let plan = plan_resources(&hardware, 32768, 17 * GIB, "cuda", &options());
        println!("{}", serde_json::to_string(&plan).unwrap());
        assert!(plan.threads <= hardware.available_logical_cores);
        assert!(!plan.applied);
    }
}
