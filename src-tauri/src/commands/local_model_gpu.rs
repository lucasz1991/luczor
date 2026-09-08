//! GPU selection is based on the verified llama.cpp build, not just installed hardware.
//! Raw runtime output is drained and discarded; only bounded device names and numeric
//! startup measurements cross into the UI. No prompts, paths or credentials are retained.
use super::resource_config::{DeviceBinding, LocalResourceConfig};
use super::resource_runtime::RuntimeOptions;
use super::{
    attach_process_lifetime_guard, configure_process, copy_minimal_environment, nvml_gpu_snapshot,
    open_artifact_guard, reject_runtime_reparse_points, sha256_open_file_cancellable,
    terminate_process, valid_hash, RuntimeArtifact,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::process::{ChildStderr, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MIB: u64 = 1024 * 1024;
const GPU_RESERVE_MIB: u64 = 1024;
const MAX_PROBE_BYTES: usize = 128 * 1024;

pub(super) fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeAcceleration {
    pub(super) resource_revision: u64,
    pub(super) requested_mode: String,
    pub(super) device_ids: Vec<String>,
    pub(super) fallback_reason_code: Option<String>,
    pub(super) backend: String,
    pub(super) device_names: Vec<String>,
    pub(super) offloaded_layers: Option<u32>,
    pub(super) total_layers: Option<u32>,
    pub(super) gpu_memory_bytes: Option<u64>,
    pub(super) mode: String,
    pub(super) verified: bool,
    pub(super) reason_code: Option<String>,
    #[serde(skip)]
    buffer_sizes: HashMap<String, u64>,
    #[serde(skip)]
    measurement_open: bool,
    #[serde(skip)]
    last_measurement: Option<Instant>,
    #[serde(skip)]
    capacity_failure: bool,
}

#[derive(Debug, Clone)]
pub(super) struct AccelerationPlan {
    pub(super) gpu_budget_bytes: u64,
    device_budgets: HashMap<String, u64>,
    pub(super) require_full_offload: bool,
    pub(super) arguments: Vec<String>,
    pub(super) status: RuntimeAcceleration,
    pub(super) runtime_options: RuntimeOptions,
}

impl AccelerationPlan {
    pub(super) fn cpu(reason: &str) -> Self {
        Self {
            gpu_budget_bytes: 0,
            device_budgets: HashMap::new(),
            require_full_offload: false,
            runtime_options: RuntimeOptions::default(),
            arguments: vec![
                "--n-gpu-layers".into(),
                "0".into(),
                "--device".into(),
                "none".into(),
            ],
            status: RuntimeAcceleration {
                resource_revision: 0,
                requested_mode: "auto".into(),
                device_ids: Vec::new(),
                fallback_reason_code: None,
                backend: "cpu".into(),
                device_names: Vec::new(),
                offloaded_layers: None,
                total_layers: None,
                gpu_memory_bytes: None,
                mode: "unknown".into(),
                verified: false,
                reason_code: Some(reason.into()),
                buffer_sizes: HashMap::new(),
                measurement_open: true,
                last_measurement: None,
                capacity_failure: false,
            },
        }
    }

    pub(super) fn with_options(mut self, options: RuntimeOptions) -> Self {
        if !self.uses_gpu() && options.fit {
            self.arguments.extend(["--fit".into(), "off".into()]);
        }
        self.runtime_options = options;
        self
    }

    pub(super) fn uses_gpu(&self) -> bool {
        self.status.backend != "cpu"
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeDevice {
    id: String,
    backend: String,
    name: String,
    total_mib: Option<u64>,
    available_mib: Option<u64>,
}

pub(super) fn validate_runtime_metadata(runtime: &RuntimeArtifact) -> Result<(), String> {
    if runtime
        .backend
        .as_deref()
        .is_some_and(|backend| !matches!(backend, "auto" | "cpu" | "cuda" | "vulkan" | "metal"))
    {
        return Err("Signed runtime backend is invalid.".into());
    }
    if let Some(files) = &runtime.files {
        if files.len() > 128 {
            return Err("Signed runtime support-file count is invalid.".into());
        }
        let mut names = HashSet::new();
        for file in files {
            if !valid_support_name(&file.name)
                || !valid_hash(&file.sha256)
                || !names.insert(file.name.to_ascii_lowercase())
            {
                return Err("Signed runtime support-file metadata is invalid.".into());
            }
        }
    }
    Ok(())
}

fn valid_support_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !name.is_empty()
        && name.len() <= 160
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
        && [".dll", ".so", ".dylib"]
            .iter()
            .any(|suffix| lower.ends_with(suffix))
}

pub(super) fn verify_support_files(
    executable: &Path,
    runtime: &RuntimeArtifact,
    cancel: &AtomicBool,
) -> Result<Vec<File>, String> {
    validate_runtime_metadata(runtime)?;
    let directory = executable
        .parent()
        .ok_or("Verified runtime directory is unavailable.")?;
    let mut guards = Vec::new();
    for support in runtime.files.as_deref().unwrap_or_default() {
        let path = directory.join(&support.name);
        reject_runtime_reparse_points(&path)?;
        let mut guard = open_artifact_guard(&path)?;
        if !guard
            .metadata()
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= 2 * 1024 * 1024 * 1024)
            || sha256_open_file_cancellable(&mut guard, cancel)? != support.sha256
        {
            return Err("Runtime support-file hash does not match the signed manifest.".into());
        }
        guards.push(guard);
    }
    Ok(guards)
}

/// Both executable and optional signed support files are already locked and hashed.
/// These probes never load a model, open a server or inherit model/provider settings.
#[allow(clippy::too_many_arguments)]
pub(super) fn choose_acceleration(
    executable: &Path,
    metadata: &RuntimeArtifact,
    min_vram_bytes: u64,
    memory_scope: &str,
    model_bytes: u64,
    config: &LocalResourceConfig,
    bindings: &[DeviceBinding],
    revision: u64,
    cancel: &AtomicBool,
) -> Result<AccelerationPlan, String> {
    let help = match probe(executable, "--help", cancel) {
        Ok(output) => output,
        Err(_) if !cancel.load(Ordering::SeqCst) => {
            return Ok(AccelerationPlan::cpu("runtime_gpu_probe_unavailable"));
        }
        Err(error) => return Err(error),
    };
    let options = RuntimeOptions::from_help(&help);
    if config.mode == "cpu" {
        if min_vram_bytes > 0 {
            return Err("cpu_mode_disallowed_by_manifest".into());
        }
        let mut plan = AccelerationPlan::cpu("resource_cpu_requested").with_options(options);
        plan.status.resource_revision = revision;
        plan.status.requested_mode = config.mode.clone();
        return Ok(plan);
    }
    if metadata.backend.as_deref() == Some("cpu") {
        return Ok(AccelerationPlan::cpu("runtime_cpu_configured").with_options(options));
    }
    let devices = match probe(executable, "--list-devices", cancel) {
        Ok(output) => parse_devices(&output),
        Err(_) if !cancel.load(Ordering::SeqCst) => {
            return Ok(AccelerationPlan::cpu("runtime_gpu_probe_unavailable").with_options(options));
        }
        Err(error) => return Err(error),
    };
    let mut devices = devices;
    // CUDA's Windows allocator and NVML can report different budgets. Never
    // promise the larger number; the native --fit allocator remains decisive.
    // Only the global NVML free-memory measurement is relevant here; the
    // separate DXGI inventory cannot prove a CUDA budget or backend support.
    let hardware = nvml_gpu_snapshot();
    for device in &mut devices {
        if device.backend != "cuda" {
            continue;
        }
        let matches = hardware
            .iter()
            .filter(|gpu| gpu.name == device.name)
            .collect::<Vec<_>>();
        // Never equate CUDA indices from two different enumerators. For duplicate
        // names, the smallest observed free budget is conservative for every card.
        if let Some(free) = matches.iter().filter_map(|gpu| gpu.available_bytes).min() {
            device.available_mib = Some(device.available_mib.unwrap_or(free / MIB).min(free / MIB));
        }
    }
    let inventory = super::gpu_snapshot();
    if config.gpu_device_ids.is_some() {
        if bindings.len() != config.gpu_device_ids.as_ref().map_or(0, Vec::len)
            || bindings
                .iter()
                .any(|bound| !inventory.iter().any(|gpu| bound.matches(gpu)))
        {
            return Err("resource_gpu_selection_changed".into());
        }
        let mut runtime_ids = HashSet::new();
        for bound in bindings {
            let matched = devices
                .iter()
                .filter(|device| {
                    device.name == bound.name
                        && (bound.backend == "unknown" || device.backend == bound.backend)
                        && bound
                            .total_bytes
                            .zip(device.total_mib)
                            .is_some_and(|(a, b)| a.abs_diff(b.saturating_mul(MIB)) <= 64 * MIB)
                })
                .collect::<Vec<_>>();
            if matched.len() != 1 || !runtime_ids.insert(matched[0].id.clone()) {
                return Err("resource_gpu_selection_ambiguous".into());
            }
        }
        devices.retain(|device| runtime_ids.contains(&device.id));
    }
    let mut plan = select_configured_plan(
        &devices,
        &help,
        metadata.backend.as_deref(),
        min_vram_bytes,
        memory_scope,
        model_bytes,
        config,
    )?;
    plan.runtime_options = options;
    plan.status.resource_revision = revision;
    plan.status.requested_mode = config.mode.clone();
    Ok(plan)
}

#[cfg(test)]
fn select_plan(
    devices: &[RuntimeDevice],
    help: &str,
    preferred: Option<&str>,
    min_vram_bytes: u64,
) -> AccelerationPlan {
    select_configured_plan(
        devices,
        help,
        preferred,
        min_vram_bytes,
        "single_device",
        0,
        &LocalResourceConfig::default(),
    )
    .unwrap()
}

#[allow(clippy::too_many_arguments)]
fn select_configured_plan(
    devices: &[RuntimeDevice],
    help: &str,
    preferred: Option<&str>,
    min_vram_bytes: u64,
    memory_scope: &str,
    model_bytes: u64,
    config: &LocalResourceConfig,
) -> Result<AccelerationPlan, String> {
    let cpu = |reason: &str| {
        let mut plan = AccelerationPlan::cpu(reason);
        if config.mode == "gpu" {
            plan.status.fallback_reason_code = Some("gpu_mode_auto_fallback_unavailable".into());
        }
        Ok(plan)
    };
    if config.mode == "cpu" {
        return cpu("resource_cpu_requested");
    }
    let matching = devices
        .iter()
        .filter(|device| {
            preferred.is_none_or(|backend| backend == "auto" || backend == device.backend)
        })
        .collect::<Vec<_>>();
    if matching.is_empty() {
        return cpu("runtime_gpu_unavailable");
    }
    if !help.contains("--fit ") || !help.contains("--fit-target") {
        return cpu("runtime_gpu_fit_unavailable");
    }
    let reserve_mib = config
        .vram_reserve_bytes
        .unwrap_or(GPU_RESERVE_MIB * MIB)
        .div_ceil(MIB);
    let mut eligible = matching
        .into_iter()
        .filter(|device| {
            device
                .available_mib
                .is_some_and(|free| free >= reserve_mib + 256)
        })
        .collect::<Vec<_>>();
    eligible.sort_by_key(|device| {
        let preference = match device.backend.as_str() {
            "cuda" => 3,
            "vulkan" => 2,
            _ => 1,
        };
        std::cmp::Reverse((preference, device.available_mib.unwrap_or_default()))
    });
    let multi_supported = help.contains("--split-mode") && help.contains("--tensor-split");
    let mut chosen = Vec::new();
    let mut partial_candidate = Vec::new();
    for backend in ["cuda", "vulkan", "metal"] {
        let group = eligible
            .iter()
            .copied()
            .filter(|device| device.backend == backend)
            .collect::<Vec<_>>();
        if group.is_empty() {
            continue;
        }
        let mut candidate = Vec::new();
        for device in group {
            candidate.push(device);
            let signed_qualified = if memory_scope == "compatible_group" {
                candidate
                    .iter()
                    .map(|d| d.total_mib.unwrap_or(0).saturating_mul(MIB))
                    .sum::<u64>()
                    >= min_vram_bytes
            } else {
                candidate
                    .iter()
                    .any(|d| d.total_mib.unwrap_or(0).saturating_mul(MIB) >= min_vram_bytes)
            };
            let budget = candidate
                .iter()
                .map(|d| {
                    d.available_mib
                        .unwrap_or(0)
                        .saturating_sub(reserve_mib)
                        .saturating_mul(MIB)
                })
                .sum::<u64>();
            if signed_qualified
                && (budget >= model_bytes.saturating_add(model_bytes / 10) || !multi_supported)
            {
                chosen = candidate.clone();
                break;
            }
            if !multi_supported {
                candidate.clear();
            }
        }
        if chosen.is_empty() && !candidate.is_empty() {
            let qualified = if memory_scope == "compatible_group" {
                candidate
                    .iter()
                    .map(|d| d.total_mib.unwrap_or(0).saturating_mul(MIB))
                    .sum::<u64>()
                    >= min_vram_bytes
            } else {
                candidate
                    .iter()
                    .any(|d| d.total_mib.unwrap_or(0).saturating_mul(MIB) >= min_vram_bytes)
            };
            if qualified {
                chosen = candidate;
            }
        }
        if !chosen.is_empty() {
            let budget = chosen
                .iter()
                .map(|d| {
                    d.available_mib
                        .unwrap_or(0)
                        .saturating_sub(reserve_mib)
                        .saturating_mul(MIB)
                })
                .sum::<u64>();
            if budget >= model_bytes.saturating_add(model_bytes / 10) {
                break;
            }
            if partial_candidate.is_empty() {
                partial_candidate = chosen.clone();
            }
            chosen.clear();
        }
    }
    if chosen.is_empty() {
        chosen = partial_candidate;
    }
    let Some(device) = chosen.first() else {
        return cpu("runtime_gpu_memory_unavailable");
    };
    let full_supported = help.contains("all") && help.contains("--n-gpu-layers");
    let gpu_budget_bytes = chosen
        .iter()
        .map(|d| {
            d.available_mib
                .unwrap_or(0)
                .saturating_sub(reserve_mib)
                .saturating_mul(MIB)
        })
        .sum();
    let full = config.mode == "gpu" && full_supported && model_bytes <= gpu_budget_bytes;
    let mut arguments = vec![
        "--device".into(),
        chosen
            .iter()
            .map(|d| d.id.as_str())
            .collect::<Vec<_>>()
            .join(","),
        "--n-gpu-layers".into(),
        if full { "all" } else { "auto" }.into(),
        "--fit".into(),
        if full { "off" } else { "on" }.into(),
        "--fit-target".into(),
        if chosen.len() == 1 {
            reserve_mib.to_string()
        } else {
            chosen
                .iter()
                .map(|_| reserve_mib.to_string())
                .collect::<Vec<_>>()
                .join(",")
        },
    ];
    if chosen.len() > 1 {
        arguments.extend(["--split-mode".into(), "layer".into()]);
        // The b10809 fitter refuses an explicit multi-device tensor split when
        // it must resize placement. Leave Auto to its free-memory allocator;
        // only full offload without fitting uses our explicit weighted split.
        if full {
            arguments.extend([
                "--tensor-split".into(),
                chosen
                    .iter()
                    .map(|d| {
                        d.available_mib
                            .unwrap_or(0)
                            .saturating_sub(reserve_mib)
                            .to_string()
                    })
                    .collect::<Vec<_>>()
                    .join(","),
            ]);
        }
    }
    arguments.extend(startup_measurement_arguments(help));
    Ok(AccelerationPlan {
        gpu_budget_bytes,
        device_budgets: chosen
            .iter()
            .map(|d| {
                (
                    d.id.clone(),
                    d.available_mib
                        .unwrap_or(0)
                        .saturating_sub(reserve_mib)
                        .saturating_mul(MIB),
                )
            })
            .collect(),
        require_full_offload: full,
        runtime_options: RuntimeOptions::from_help(help),
        arguments,
        status: RuntimeAcceleration {
            resource_revision: 0,
            requested_mode: config.mode.clone(),
            device_ids: chosen.iter().map(|d| d.id.clone()).collect(),
            fallback_reason_code: (config.mode == "gpu" && !full).then(|| {
                if full_supported {
                    "gpu_mode_auto_fallback_capacity"
                } else {
                    "gpu_mode_auto_fallback_unsupported"
                }
                .into()
            }),
            backend: device.backend.clone(),
            device_names: chosen.iter().map(|d| d.name.clone()).collect(),
            offloaded_layers: None,
            total_layers: None,
            gpu_memory_bytes: None,
            mode: "unknown".into(),
            verified: false,
            reason_code: Some("runtime_gpu_measurement_pending".into()),
            buffer_sizes: HashMap::new(),
            measurement_open: true,
            last_measurement: None,
            capacity_failure: false,
        },
    })
}

fn startup_measurement_arguments(help: &str) -> Vec<String> {
    let supported = |flag: &str| {
        help.split_whitespace()
            .any(|word| word.trim_end_matches(',') == flag)
    };
    let verbosity = if supported("--verbosity") {
        "--verbosity"
    } else if supported("--log-verbosity") {
        "--log-verbosity"
    } else {
        return Vec::new();
    };
    // llama.cpp routes its model-loader INFO counters through trace level 4.
    // Level 5/infinite logging is unnecessary; only bounded startup numbers
    // are retained, and measurement closes before any user inference.
    let mut arguments = vec![verbosity.into(), "4".into()];
    if supported("--log-colors") {
        arguments.extend(["--log-colors".into(), "off".into()]);
    }
    for flag in ["--no-log-prefix", "--no-log-timestamps"] {
        if supported(flag) {
            arguments.push(flag.into());
        }
    }
    arguments
}

fn parse_devices(output: &str) -> Vec<RuntimeDevice> {
    let devices: Vec<RuntimeDevice> = output
        .lines()
        .filter_map(|line| {
            let (id, description) = line.trim().split_once(": ")?;
            let backend = [("CUDA", "cuda"), ("Vulkan", "vulkan"), ("Metal", "metal")]
                .iter()
                .find_map(|(prefix, backend)| {
                    id.strip_prefix(prefix)
                        .filter(|index| {
                            !index.is_empty() && index.bytes().all(|b| b.is_ascii_digit())
                        })
                        .map(|_| *backend)
                })?;
            let (name, memory) = description.rsplit_once(" (")?;
            if name.is_empty() || name.len() > 160 || name.chars().any(char::is_control) {
                return None;
            }
            let available_mib = memory
                .split(", ")
                .find_map(|part| part.trim().strip_suffix(" MiB free)")?.parse::<u64>().ok());
            let total_mib = memory
                .split_once(" MiB,")
                .and_then(|(total, _)| total.parse::<u64>().ok());
            if id.len() > 32
                || total_mib.is_some_and(|total| total == 0 || total > 16 * 1024 * 1024)
                || available_mib
                    .zip(total_mib)
                    .is_some_and(|(free, total)| free > total)
            {
                return None;
            }
            Some(RuntimeDevice {
                id: id.into(),
                backend: backend.into(),
                name: name.into(),
                total_mib,
                available_mib,
            })
        })
        .take(32)
        .collect();
    let mut counts = HashMap::new();
    for device in &devices {
        *counts.entry(device.id.clone()).or_insert(0) += 1;
    }
    devices
        .into_iter()
        .filter(|device| counts[&device.id] == 1)
        .collect()
}

fn probe(executable: &Path, argument: &str, cancel: &AtomicBool) -> Result<String, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Local runtime probe was cancelled.".into());
    }
    let mut command = Command::new(executable);
    command
        .arg(argument)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(directory) = executable.parent() {
        command.current_dir(directory);
    }
    copy_minimal_environment(&mut command);
    configure_process(&mut command);
    let mut child = command
        .spawn()
        .map_err(|_| "Local runtime GPU probe could not start.")?;
    let _lifetime = match attach_process_lifetime_guard(&child) {
        Ok(guard) => guard,
        Err(error) => {
            terminate_process(&mut child);
            return Err(error);
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or("Runtime probe output is unavailable.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Runtime probe diagnostics are unavailable.")?;
    let output_reader = std::thread::spawn(move || drain_probe(stdout));
    let error_reader = std::thread::spawn(move || drain_probe(stderr));
    let started = Instant::now();
    let result = loop {
        if cancel.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(10) {
            terminate_process(&mut child);
            break Err("Local runtime GPU probe was cancelled or timed out.");
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break Ok(()),
            Ok(Some(_)) | Err(_) => {
                terminate_process(&mut child);
                break Err("Local runtime GPU probe failed.");
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    // Close the job before joins so even a surviving probe child cannot retain pipes.
    drop(_lifetime);
    let stdout = output_reader.join().unwrap_or_default();
    let stderr = error_reader.join().unwrap_or_default();
    result?;
    Ok(format!(
        "{}\n{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    ))
}

fn drain_probe(mut reader: impl Read) -> Vec<u8> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 4096];
    while let Ok(read) = reader.read(&mut buffer) {
        if read == 0 {
            break;
        }
        let remaining = MAX_PROBE_BYTES.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    output
}

pub(super) fn monitor_startup(stderr: ChildStderr, state: Arc<Mutex<RuntimeAcceleration>>) {
    std::thread::spawn(move || {
        drain_startup(stderr, |line| {
            if let Ok(mut status) = state.lock() {
                apply_measurement(&mut status, line);
            }
        })
    });
}

pub(super) fn confirm_started(state: &Arc<Mutex<RuntimeAcceleration>>, plan: &AccelerationPlan) {
    if let Ok(mut status) = state.lock() {
        // Freeze the numeric startup evidence before the first user request.
        // The reader keeps draining its pipe, but later request/KV logs cannot
        // change the readiness evidence. No queued text is retained for replay.
        status.measurement_open = false;
        if !plan.uses_gpu() {
            // A healthy server with --device none and zero GPU layers is
            // explicit CPU execution even if that build emits no layer summary.
            status.mode = "cpu".into();
            status.offloaded_layers = Some(0);
            status.verified = true;
        }
    }
}

/// Health is checked first. Drain the already-produced startup counters to a
/// bounded quiet point before freezing evidence or running any benchmark.
pub(super) fn finish_measurement(
    state: &Arc<Mutex<RuntimeAcceleration>>,
    plan: &AccelerationPlan,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let started = Instant::now();
    if plan.uses_gpu() {
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("Local operation was cancelled.".into());
            }
            let complete = {
                let status = state
                    .lock()
                    .map_err(|_| "runtime_gpu_measurement_unavailable")?;
                status.verified
                    && status
                        .last_measurement
                        .is_some_and(|at| at.elapsed() >= Duration::from_millis(100))
            };
            if complete || started.elapsed() >= timeout.min(Duration::from_secs(2)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    confirm_started(state, plan);
    let status = state
        .lock()
        .map_err(|_| "runtime_gpu_measurement_unavailable")?;
    if !status.verified {
        return Err("runtime_gpu_measurement_unavailable".into());
    }
    if plan.require_full_offload
        && (status.offloaded_layers != status.total_layers || status.offloaded_layers == Some(0))
    {
        return Err("gpu_full_offload_not_verified".into());
    }
    if plan.require_full_offload {
        for (device, budget) in &plan.device_budgets {
            let values = status
                .buffer_sizes
                .iter()
                .filter(|(key, _)| key.starts_with(&format!("{device}:")))
                .map(|(_, value)| *value)
                .collect::<Vec<_>>();
            if values.is_empty() {
                return Err("runtime_gpu_measurement_unavailable".into());
            }
            if values.into_iter().sum::<u64>() > *budget {
                return Err("runtime_gpu_capacity_unavailable".into());
            }
        }
    }
    Ok(())
}

pub(super) fn capacity_failure(state: &Arc<Mutex<RuntimeAcceleration>>) -> bool {
    state.lock().is_ok_and(|s| s.capacity_failure)
}

pub(super) fn auto_fallback(plan: &AccelerationPlan, cause: &str) -> AccelerationPlan {
    let mut fallback = plan.clone();
    fallback.require_full_offload = false;
    for pair in fallback.arguments.chunks_mut(2) {
        if pair.len() == 2 && pair[0] == "--n-gpu-layers" {
            pair[1] = "auto".into();
        }
        if pair.len() == 2 && pair[0] == "--fit" {
            pair[1] = "on".into();
        }
    }
    if let Some(index) = fallback
        .arguments
        .iter()
        .position(|arg| arg == "--tensor-split")
    {
        fallback.arguments.drain(index..index + 2);
    }
    fallback.status.fallback_reason_code = Some(
        if cause == "gpu_full_offload_not_verified" {
            "gpu_mode_auto_fallback_unconfirmed"
        } else {
            "gpu_mode_auto_fallback_capacity"
        }
        .into(),
    );
    fallback
}

fn drain_startup(mut reader: impl Read, mut measure: impl FnMut(&str)) {
    let mut buffer = [0_u8; 4096];
    let mut line = Vec::new();
    let mut oversized = false;
    let mut measured_bytes = 0_usize;
    while let Ok(read) = reader.read(&mut buffer) {
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            if *byte == b'\n' {
                if !oversized && measured_bytes < 256 * 1024 {
                    measured_bytes = measured_bytes.saturating_add(line.len());
                    if let Ok(text) = std::str::from_utf8(&line) {
                        measure(text);
                    }
                }
                line.clear();
                oversized = false;
            } else if line.len() < 8192 && !oversized {
                line.push(*byte);
            } else {
                oversized = true;
                line.clear();
            }
        }
    }
}

fn apply_measurement(status: &mut RuntimeAcceleration, line: &str) {
    if !status.measurement_open {
        return;
    }
    let line = line.trim();
    let lower = line.to_ascii_lowercase();
    if lower.contains("out of memory")
        || lower.contains("failed to allocate")
        || lower.contains("cudamalloc failed")
    {
        status.capacity_failure = true;
    }
    if !(line.starts_with("load_tensors:")
        || line.starts_with("llm_load_tensors:")
        || line.starts_with("llama_kv_cache")
        || line.starts_with("llama_context:")
        || line.starts_with("llama_memory_recurrent:")
        || line.starts_with("sched_reserve:"))
    {
        return;
    }
    status.last_measurement = Some(Instant::now());
    if let Some(measurement) = line.split_once("offloaded ").map(|(_, rest)| rest) {
        if let Some((layers, _)) = measurement.split_once(" layers to GPU") {
            if let Some((loaded, total)) = layers.split_once('/') {
                if let (Ok(loaded), Ok(total)) = (loaded.parse::<u32>(), total.parse::<u32>()) {
                    if total > 0 && total <= 100_000 && loaded <= total {
                        status.offloaded_layers = Some(loaded);
                        status.total_layers = Some(total);
                        status.verified = true;
                        status.mode = if loaded == 0 {
                            "cpu"
                        } else if loaded < total {
                            "hybrid"
                        } else {
                            "gpu"
                        }
                        .into();
                        if loaded == 0 {
                            status.backend = "cpu".into();
                            status.device_names.clear();
                            if status.reason_code.as_deref()
                                == Some("runtime_gpu_measurement_pending")
                                || status.reason_code.is_none()
                            {
                                status.reason_code = Some("runtime_gpu_no_layers_offloaded".into());
                            }
                        } else {
                            status.reason_code = None;
                        }
                    }
                }
            }
        }
    }
    if let Some((prefix, memory)) = line.split_once(" buffer size =") {
        let device = prefix.split_whitespace().find(|word| {
            ["CUDA", "Vulkan", "Metal"].iter().any(|backend| {
                word.strip_prefix(backend).is_some_and(|index| {
                    !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
                })
            })
        });
        let kind = prefix
            .split_whitespace()
            .last()
            .filter(|kind| matches!(*kind, "model" | "KV" | "RS" | "compute"));
        if let (Some(device), Some(kind)) = (device, kind) {
            if let Some(amount) = memory
                .trim()
                .strip_suffix("MiB")
                .and_then(|number| number.trim().parse::<f64>().ok())
            {
                if amount.is_finite()
                    && (0.0..1_048_576.0).contains(&amount)
                    && status.buffer_sizes.len() < 128
                {
                    status
                        .buffer_sizes
                        .insert(format!("{device}:{kind}"), (amount * MIB as f64) as u64);
                    status.gpu_memory_bytes = Some(status.buffer_sizes.values().copied().sum());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const HELP: &str = "--fit [on|off]\n--fit-target MiB\n--device devices\n--n-gpu-layers N";
    fn multi_help() -> String {
        format!("{HELP}\n'auto', or 'all'\n--split-mode layer\n--tensor-split N0,N1")
    }
    #[test]
    fn duplicate_runtime_device_ids_never_count_twice_towards_signed_capacity() {
        let devices =
            parse_devices("CUDA0: A (8192 MiB, 7000 MiB free)\nCUDA0: A (8192 MiB, 7000 MiB free)");
        assert!(devices.is_empty());
        assert!(!select_configured_plan(
            &devices,
            &multi_help(),
            None,
            16_000 * MIB,
            "compatible_group",
            12000 * MIB,
            &LocalResourceConfig::default()
        )
        .unwrap()
        .uses_gpu());
    }
    #[test]
    fn a_backend_that_fits_precedes_a_higher_priority_backend_needing_host_offload() {
        let devices = parse_devices(
            "CUDA0: Small (8192 MiB, 7000 MiB free)\nVulkan0: Large (24575 MiB, 22000 MiB free)",
        );
        let config = LocalResourceConfig {
            mode: "gpu".into(),
            ..Default::default()
        };
        let plan = select_configured_plan(
            &devices,
            &multi_help(),
            None,
            0,
            "single_device",
            18000 * MIB,
            &config,
        )
        .unwrap();
        assert_eq!(plan.status.backend, "vulkan");
        assert!(plan.require_full_offload);
    }
    #[test]
    fn automatic_adds_compatible_gpus_only_when_needed_and_weights_by_free_budget() {
        let devices = parse_devices("CUDA0: Card A (12288 MiB, 10000 MiB free)\nCUDA1: Card B (12288 MiB, 6000 MiB free)\nVulkan0: Other card (32768 MiB, 30000 MiB free)");
        let plan = select_configured_plan(
            &devices,
            &multi_help(),
            None,
            0,
            "single_device",
            12_500 * MIB,
            &LocalResourceConfig::default(),
        )
        .unwrap();
        assert_eq!(plan.status.device_ids, ["CUDA0", "CUDA1"]);
        assert!(!plan.arguments.iter().any(|arg| arg == "--tensor-split"));
        assert_eq!(plan.gpu_budget_bytes, (8976 + 4976) * MIB);
        assert!(plan
            .arguments
            .windows(2)
            .any(|pair| pair == ["--split-mode", "layer"]));
        assert!(!plan
            .arguments
            .iter()
            .any(|arg| arg == "row" || arg == "tensor"));
        let small = select_configured_plan(
            &devices,
            &multi_help(),
            None,
            0,
            "single_device",
            1000 * MIB,
            &LocalResourceConfig::default(),
        )
        .unwrap();
        assert_eq!(small.status.device_ids, ["CUDA0"]);
    }
    #[test]
    fn signed_single_card_minimum_is_never_satisfied_by_summing_two_cards() {
        let devices = parse_devices(
            "CUDA0: A (12288 MiB, 11000 MiB free)\nCUDA1: B (12288 MiB, 10000 MiB free)",
        );
        let config = LocalResourceConfig::default();
        assert!(!select_configured_plan(
            &devices,
            &multi_help(),
            None,
            16_000 * MIB,
            "single_device",
            15_000 * MIB,
            &config
        )
        .unwrap()
        .uses_gpu());
        assert!(select_configured_plan(
            &devices,
            &multi_help(),
            None,
            16_000 * MIB,
            "compatible_group",
            15_000 * MIB,
            &config
        )
        .unwrap()
        .uses_gpu());
        assert!(!select_configured_plan(
            &devices,
            HELP,
            None,
            16_000 * MIB,
            "compatible_group",
            15_000 * MIB,
            &config
        )
        .unwrap()
        .uses_gpu());
    }
    #[test]
    fn full_gpu_split_is_weighted_but_automatic_fallback_does_not_disable_the_runtime_fitter() {
        let devices = parse_devices(
            "CUDA0: A (12288 MiB, 10000 MiB free)\nCUDA1: B (12288 MiB, 6000 MiB free)",
        );
        let config = LocalResourceConfig {
            mode: "gpu".into(),
            ..Default::default()
        };
        let plan = select_configured_plan(
            &devices,
            &multi_help(),
            None,
            0,
            "single_device",
            12500 * MIB,
            &config,
        )
        .unwrap();
        assert!(plan
            .arguments
            .windows(2)
            .any(|pair| pair == ["--tensor-split", "8976,4976"]));
        assert!(plan
            .arguments
            .windows(2)
            .any(|pair| pair == ["--fit", "off"]));
        let fallback = auto_fallback(&plan, "runtime_gpu_capacity_unavailable");
        assert!(!fallback.arguments.iter().any(|arg| arg == "--tensor-split"));
        assert!(fallback
            .arguments
            .windows(2)
            .any(|pair| pair == ["--fit", "on"]));
        assert!(fallback
            .arguments
            .windows(2)
            .any(|pair| pair == ["--split-mode", "layer"]));
        assert!(fallback
            .arguments
            .windows(2)
            .any(|pair| pair == ["--fit-target", "1024,1024"]));
    }
    #[test]
    fn gpu_preference_attempts_full_offload_and_explains_automatic_capacity_fallback() {
        let devices = parse_devices("CUDA0: A (24575 MiB, 22000 MiB free)");
        let config = LocalResourceConfig {
            mode: "gpu".into(),
            ..Default::default()
        };
        let full = select_configured_plan(
            &devices,
            &multi_help(),
            None,
            0,
            "single_device",
            17000 * MIB,
            &config,
        )
        .unwrap();
        assert!(full.require_full_offload);
        assert!(full
            .arguments
            .windows(2)
            .any(|pair| pair == ["--n-gpu-layers", "all"]));
        assert!(full
            .arguments
            .windows(2)
            .any(|pair| pair == ["--fit", "off"]));
        let fallback = auto_fallback(&full, "runtime_gpu_capacity_unavailable");
        assert_eq!(
            auto_fallback(&full, "gpu_full_offload_not_verified")
                .status
                .fallback_reason_code
                .as_deref(),
            Some("gpu_mode_auto_fallback_unconfirmed")
        );
        assert!(!fallback.require_full_offload);
        assert!(fallback
            .arguments
            .windows(2)
            .any(|pair| pair == ["--n-gpu-layers", "auto"]));
        assert_eq!(
            fallback.status.fallback_reason_code.as_deref(),
            Some("gpu_mode_auto_fallback_capacity")
        );
        let oversized = select_configured_plan(
            &devices,
            &multi_help(),
            None,
            0,
            "single_device",
            24000 * MIB,
            &config,
        )
        .unwrap();
        assert!(!oversized.require_full_offload);
        assert_eq!(
            oversized.status.fallback_reason_code.as_deref(),
            Some("gpu_mode_auto_fallback_capacity")
        );
    }
    #[test]
    fn explicit_cpu_does_not_choose_any_detected_gpu() {
        let devices = parse_devices("CUDA0: A (24575 MiB, 22000 MiB free)");
        let config = LocalResourceConfig {
            mode: "cpu".into(),
            ..Default::default()
        };
        let plan = select_configured_plan(
            &devices,
            &multi_help(),
            None,
            0,
            "single_device",
            1000 * MIB,
            &config,
        )
        .unwrap();
        assert!(!plan.uses_gpu());
        assert!(plan
            .arguments
            .windows(2)
            .any(|pair| pair == ["--device", "none"]));
        assert!(plan
            .arguments
            .windows(2)
            .any(|pair| pair == ["--n-gpu-layers", "0"]));
    }
    #[test]
    fn measurement_finishes_before_readiness_and_missing_gpu_evidence_is_not_cpu() {
        let plan = select_plan(
            &parse_devices("CUDA0: A (24575 MiB, 22000 MiB free)"),
            HELP,
            None,
            0,
        );
        let state = Arc::new(Mutex::new(plan.status.clone()));
        assert_eq!(
            finish_measurement(&state, &plan, Duration::ZERO, &AtomicBool::new(false)).unwrap_err(),
            "runtime_gpu_measurement_unavailable"
        );
        assert_eq!(state.lock().unwrap().mode, "unknown");
        assert!(!state.lock().unwrap().verified);
        let state = Arc::new(Mutex::new(plan.status.clone()));
        let reader_state = state.clone();
        let reader = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            apply_measurement(
                &mut reader_state.lock().unwrap(),
                "load_tensors: offloaded 66/66 layers to GPU",
            );
        });
        finish_measurement(
            &state,
            &plan,
            Duration::from_secs(1),
            &AtomicBool::new(false),
        )
        .unwrap();
        reader.join().unwrap();
        assert!(!state.lock().unwrap().measurement_open);
        assert_eq!(state.lock().unwrap().offloaded_layers, Some(66));
    }
    #[test]
    fn full_offload_requires_actual_complete_layer_measurement() {
        let config = LocalResourceConfig {
            mode: "gpu".into(),
            ..Default::default()
        };
        let plan = select_configured_plan(
            &parse_devices("CUDA0: A (24575 MiB, 22000 MiB free)"),
            &multi_help(),
            None,
            0,
            "single_device",
            1000 * MIB,
            &config,
        )
        .unwrap();
        let state = Arc::new(Mutex::new(plan.status.clone()));
        apply_measurement(
            &mut state.lock().unwrap(),
            "load_tensors: offloaded 12/66 layers to GPU",
        );
        assert_eq!(
            finish_measurement(&state, &plan, Duration::ZERO, &AtomicBool::new(false)).unwrap_err(),
            "gpu_full_offload_not_verified"
        );
    }
    #[test]
    fn full_gpu_success_still_falls_back_if_measured_buffers_consume_the_reserve() {
        let config = LocalResourceConfig {
            mode: "gpu".into(),
            vram_reserve_bytes: Some(2_000 * MIB),
            ..Default::default()
        };
        let plan = select_configured_plan(
            &parse_devices("CUDA0: A (24575 MiB, 22000 MiB free)"),
            &multi_help(),
            None,
            0,
            "single_device",
            17000 * MIB,
            &config,
        )
        .unwrap();
        let state = Arc::new(Mutex::new(plan.status.clone()));
        {
            let mut status = state.lock().unwrap();
            apply_measurement(&mut status, "load_tensors: offloaded 66/66 layers to GPU");
            apply_measurement(
                &mut status,
                "load_tensors: CUDA0 model buffer size = 17000.00 MiB",
            );
            apply_measurement(
                &mut status,
                "llama_kv_cache: CUDA0 KV buffer size = 4000.00 MiB",
            );
        }
        assert_eq!(
            finish_measurement(&state, &plan, Duration::ZERO, &AtomicBool::new(false)).unwrap_err(),
            "runtime_gpu_capacity_unavailable"
        );
    }
    #[test]
    fn gpu_measurement_enables_only_supported_bounded_logging_without_prompt_or_file_logs() {
        let help = format!(
            "{HELP}\n-lv, --verbosity, --log-verbosity N\n\
             --log-colors [on|off|auto]\n\
             --log-prefix, --no-log-prefix\n\
             --log-timestamps, --no-log-timestamps\n\
             -v, --verbose, --log-verbose\n--log-file FNAME\n--log-prompts-dir PATH"
        );
        let plan = select_plan(
            &parse_devices("CUDA0: NVIDIA (24575 MiB, 22000 MiB free)"),
            &help,
            None,
            0,
        );
        assert_eq!(
            &plan.arguments[8..],
            [
                "--verbosity",
                "4",
                "--log-colors",
                "off",
                "--no-log-prefix",
                "--no-log-timestamps"
            ]
        );
        assert_eq!(
            startup_measurement_arguments("--log-verbosity N"),
            ["--log-verbosity", "4"]
        );
        assert!(startup_measurement_arguments(
            "--verbose --log-colors [on|off|auto] --no-log-prefix"
        )
        .is_empty());
        assert!(startup_measurement_arguments("--verbosity-extra N").is_empty());
        assert!(!plan.status.verified);
    }

    #[test]
    fn chooses_verified_cuda_or_vulkan_device_with_memory_reserve_and_fixed_context_untouched() {
        let devices = parse_devices("Available devices:\n  CUDA0: NVIDIA RTX 3090 (24575 MiB, 22000 MiB free)\n  Vulkan1: AMD Radeon (8192 MiB, 7000 MiB free)\nRPC0: remote (10000 MiB, 9000 MiB free)");
        assert_eq!(devices.len(), 2);
        let plan = select_plan(&devices, HELP, None, 0);
        assert_eq!(plan.status.backend, "cuda");
        assert_eq!(
            plan.arguments,
            [
                "--device",
                "CUDA0",
                "--n-gpu-layers",
                "auto",
                "--fit",
                "on",
                "--fit-target",
                "1024"
            ]
        );
        assert!(!plan.status.verified);
        assert_eq!(
            select_plan(&devices, HELP, Some("vulkan"), 0)
                .status
                .backend,
            "vulkan"
        );
        assert_eq!(
            select_plan(&devices, "old build", None, 0)
                .status
                .reason_code
                .as_deref(),
            Some("runtime_gpu_fit_unavailable")
        );
    }
    #[test]
    fn insufficient_or_unknown_gpu_memory_selects_explained_cpu_fallback() {
        let devices = parse_devices("CUDA0: NVIDIA (24575 MiB, 1000 MiB free)");
        assert_eq!(
            select_plan(&devices, HELP, None, 0)
                .status
                .reason_code
                .as_deref(),
            Some("runtime_gpu_memory_unavailable")
        );
        assert_eq!(
            select_plan(&devices, HELP, Some("vulkan"), 0)
                .status
                .reason_code
                .as_deref(),
            Some("runtime_gpu_unavailable")
        );
        assert!(parse_devices("CUDA0: secret\n--rpc: endpoint").is_empty());
    }
    #[test]
    fn real_offload_counters_distinguish_full_partial_and_cpu_without_retaining_logs() {
        let mut status = select_plan(
            &parse_devices("CUDA0: NVIDIA (24575 MiB, 22000 MiB free)"),
            HELP,
            None,
            0,
        )
        .status;
        apply_measurement(&mut status, "load_tensors: offloaded 21/65 layers to GPU");
        apply_measurement(
            &mut status,
            "load_tensors: CUDA0 model buffer size = 10000.50 MiB",
        );
        apply_measurement(
            &mut status,
            "llama_kv_cache: CUDA0 KV buffer size = 100.00 MiB",
        );
        apply_measurement(
            &mut status,
            "load_tensors: CUDA_Host model buffer size = 100.00 MiB",
        );
        apply_measurement(
            &mut status,
            "request prompt=DO_NOT_RETAIN offloaded 65/65 layers to GPU",
        );
        assert_eq!(status.mode, "hybrid");
        assert!(status.verified);
        assert_eq!(status.gpu_memory_bytes, Some((10100.5 * MIB as f64) as u64));
        assert!(!serde_json::to_string(&status)
            .unwrap()
            .contains("DO_NOT_RETAIN"));
        apply_measurement(&mut status, "load_tensors: offloaded 65/65 layers to GPU");
        assert_eq!(status.mode, "gpu");
        apply_measurement(&mut status, "load_tensors: offloaded 0/65 layers to GPU");
        assert_eq!(status.mode, "cpu");
        assert_eq!(status.backend, "cpu");
    }

    #[test]
    fn installed_build_trace_counters_prove_full_offload_and_exclude_host_memory() {
        let mut status = select_plan(
            &parse_devices("CUDA0: NVIDIA RTX 3090 (24575 MiB, 22000 MiB free)"),
            HELP,
            None,
            0,
        )
        .status;
        // Numeric lines observed in the b10809 / 5266f24da startup smoke.
        let startup = "load_tensors: offloaded 66/66 layers to GPU\n\
                       load_tensors: CPU_Mapped model buffer size = 682.03 MiB\n\
                       load_tensors: CUDA0 model buffer size = 16028.79 MiB\n\
                       llama_kv_cache: CUDA0 KV buffer size = 2048.00 MiB\n\
                       llama_context: CUDA_Host output buffer size = 0.95 MiB\n\
                       llama_memory_recurrent: CUDA0 RS buffer size = 149.62 MiB\n\
                       sched_reserve: CUDA0 compute buffer size = 38.50 MiB\n\
                       sched_reserve: CUDA_Host compute buffer size = 13.00 MiB\n";
        drain_startup(startup.as_bytes(), |line| {
            apply_measurement(&mut status, line)
        });
        assert_eq!(status.backend, "cuda");
        assert_eq!(status.mode, "gpu");
        assert_eq!(status.offloaded_layers, Some(66));
        assert_eq!(status.total_layers, Some(66));
        assert_eq!(
            status.gpu_memory_bytes,
            Some(
                (16028.79 * MIB as f64) as u64
                    + 2048 * MIB
                    + (149.62 * MIB as f64) as u64
                    + (38.50 * MIB as f64) as u64
            )
        );
        assert!(status.verified);
        assert!(status.reason_code.is_none());
    }

    #[test]
    fn malformed_measurements_and_oversized_lines_are_discarded_but_pipe_is_drained() {
        let mut status = AccelerationPlan::cpu("fixture").status;
        for line in [
            "load_tensors: offloaded 66/65 layers to GPU",
            "load_tensors: offloaded 0/0 layers to GPU",
            "llama_context: CUDA0 compute buffer size = NaN MiB",
        ] {
            apply_measurement(&mut status, line);
        }
        assert!(!status.verified);
        assert_eq!(status.gpu_memory_bytes, None);
        let input = format!(
            "{}\nload_tensors: offloaded 0/65 layers to GPU\n",
            "x".repeat(40_000)
        );
        drain_startup(input.as_bytes(), |line| {
            apply_measurement(&mut status, line)
        });
        assert_eq!(status.total_layers, Some(65));
    }
    #[test]
    fn support_file_names_are_bounded_basenames_without_paths_or_extensions_for_execution() {
        for name in [
            "ggml-cuda.dll",
            "cublas64_12.dll",
            "libggml.so",
            "libggml.dylib",
            "GGML.DLL",
        ] {
            assert!(valid_support_name(name));
        }
        for name in [
            "../ggml.dll",
            "sub\\ggml.dll",
            "C:ggml.dll",
            "lib.exe",
            ".dll",
            "-a.dll",
            "ä.dll",
            "ggml.dll ",
        ] {
            assert!(!valid_support_name(name));
        }
    }

    fn runtime_fixture() -> serde_json::Value {
        serde_json::json!({
            "id": "llama.cpp", "version": "b10809", "sha256": "a".repeat(64),
            "min_context_tokens": 1024, "max_context_tokens": 32768
        })
    }

    #[test]
    fn optional_runtime_pins_keep_legacy_serialization_and_reject_null_duplicate_or_unsafe_contracts(
    ) {
        let legacy = runtime_fixture();
        let runtime: RuntimeArtifact = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(runtime).unwrap(), legacy);
        for field in ["backend", "files"] {
            let mut value = legacy.clone();
            value[field] = serde_json::Value::Null;
            assert!(serde_json::from_value::<RuntimeArtifact>(value).is_err());
        }
        for files in [
            serde_json::json!([{"name": "ggml-cuda.dll", "sha256": "a".repeat(64)}, {"name": "GGML-CUDA.DLL", "sha256": "b".repeat(64)}]),
            serde_json::json!([{"name": "../ggml-cuda.dll", "sha256": "a".repeat(64)}]),
            serde_json::json!([{"name": "ggml-cuda.dll", "sha256": "A".repeat(64)}]),
        ] {
            let mut value = legacy.clone();
            value["files"] = files;
            let runtime: RuntimeArtifact = serde_json::from_value(value).unwrap();
            assert!(validate_runtime_metadata(&runtime).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn signed_support_files_remain_locked_and_reject_tampering_or_missing_dependencies() {
        let directory =
            std::env::temp_dir().join(format!("luczor-gpu-pins-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let support_path = directory.join("ggml-cuda.dll");
        let contents = b"test fixture, never executed";
        std::fs::write(&support_path, contents).unwrap();
        let mut value = runtime_fixture();
        value["files"] = serde_json::json!([{"name": "ggml-cuda.dll", "sha256": super::super::sha256_bytes(contents)}]);
        let runtime: RuntimeArtifact = serde_json::from_value(value).unwrap();
        let cancel = AtomicBool::new(false);
        let executable = directory.join("never-executed.exe");
        let guards = verify_support_files(&executable, &runtime, &cancel).unwrap();
        assert!(std::fs::OpenOptions::new()
            .write(true)
            .open(&support_path)
            .is_err());
        drop(guards);
        std::fs::write(&support_path, b"tampered fixture").unwrap();
        assert!(verify_support_files(&executable, &runtime, &cancel).is_err());
        std::fs::remove_file(&support_path).unwrap();
        assert!(verify_support_files(&executable, &runtime, &cancel).is_err());
        std::fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn startup_evidence_freezes_at_health_and_repeated_buffer_lines_are_not_double_counted() {
        let plan = select_plan(
            &parse_devices("CUDA0: NVIDIA (24575 MiB, 22000 MiB free)"),
            HELP,
            None,
            0,
        );
        let mut status = plan.status.clone();
        for _ in 0..3 {
            apply_measurement(
                &mut status,
                "load_tensors: CUDA0 model buffer size = 100.00 MiB",
            );
        }
        assert_eq!(status.gpu_memory_bytes, Some(100 * MIB));
        apply_measurement(&mut status, "load_tensors: offloaded 0/65 layers to GPU");
        assert_eq!(
            status.reason_code.as_deref(),
            Some("runtime_gpu_no_layers_offloaded")
        );
        let state = Arc::new(Mutex::new(status));
        confirm_started(&state, &plan);
        apply_measurement(
            &mut state.lock().unwrap(),
            "load_tensors: offloaded 65/65 layers to GPU",
        );
        assert_eq!(state.lock().unwrap().offloaded_layers, Some(0));
    }

    #[test]
    fn signed_gpu_capacity_uses_runtime_device_memory_for_vulkan_too() {
        let devices = parse_devices("Vulkan0: AMD Radeon (8192 MiB, 7000 MiB free)");
        assert!(select_plan(&devices, HELP, None, 8 * 1024 * MIB).uses_gpu());
        assert!(!select_plan(&devices, HELP, None, 16 * 1024 * MIB).uses_gpu());
    }
}
