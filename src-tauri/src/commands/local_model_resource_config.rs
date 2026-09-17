//! Device-local resource preferences and workflow barriers. No catalog rotation.
use super::*;
const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcePercentageLimits {
    pub response_cpu: u8,
    pub context_cpu: u8,
    pub ram: u8,
    pub gpu: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ram_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_enabled: Option<bool>,
}

impl ResourcePercentageLimits {
    pub(super) fn gpu_percent(&self) -> u8 {
        if self.gpu_enabled == Some(false) {
            100
        } else {
            self.gpu
        }
    }
}

/// Integer percentage without intermediate overflow; always rounds down.
pub(super) fn percentage_budget(value: u64, percent: u8) -> u64 {
    value / 100 * u64::from(percent) + value % 100 * u64::from(percent) / 100
}

pub(super) fn maximum_resource_threads(logical: usize, available: usize) -> usize {
    let available = available.min(logical).max(1);
    let reserved = match available {
        1 => 0,
        2..=7 => 1,
        _ => 2,
    };
    available.saturating_sub(reserved).max(1)
}

/// Resolve again at admission, not just from a renderer's earlier inventory.
pub(super) fn resolve_percentage_host_config(
    config: &LocalResourceConfig,
    hardware: &resource_runtime::ResourceSnapshot,
) -> Result<LocalResourceConfig, String> {
    validate_shape(config)?;
    let mut resolved = config.clone();
    if let Some(limits) = &config.percentage_limits {
        let maximum =
            maximum_resource_threads(hardware.logical_cores, hardware.available_logical_cores)
                as u64;
        let response = if limits.cpu_enabled == Some(false) {
            100
        } else {
            limits.response_cpu
        };
        let context = if limits.cpu_enabled == Some(false) {
            100
        } else {
            limits.context_cpu
        };
        resolved.threads = Some(percentage_budget(maximum, response).max(1) as usize);
        resolved.threads_batch = Some(percentage_budget(maximum, context).max(1) as usize);
        let reserve = (hardware.total_ram_bytes / 12).clamp(GIB, 4 * GIB);
        let budget = hardware
            .available_ram_bytes
            .min(hardware.total_ram_bytes)
            .saturating_sub(reserve);
        let ram = if limits.ram_enabled == Some(false) {
            100
        } else {
            limits.ram
        };
        resolved.ram_reserve_bytes = Some(reserve + budget - percentage_budget(budget, ram));
    }
    Ok(resolved)
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalResourceConfig {
    pub mode: String,
    pub gpu_device_ids: Option<Vec<String>>,
    pub threads: Option<usize>,
    pub threads_batch: Option<usize>,
    pub ram_reserve_bytes: Option<u64>,
    pub vram_reserve_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percentage_limits: Option<ResourcePercentageLimits>,
}
impl Default for LocalResourceConfig {
    fn default() -> Self {
        Self {
            mode: "auto".into(),
            gpu_device_ids: None,
            threads: None,
            threads_batch: None,
            ram_reserve_bytes: None,
            vram_reserve_bytes: None,
            percentage_limits: None,
        }
    }
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalResourceConfigState {
    pub requested: LocalResourceConfig,
    pub applied: LocalResourceConfig,
    pub revision: u64,
    pub applied_revision: u64,
    pub pending: bool,
    pub reason_code: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeviceBinding {
    pub id: String,
    pub name: String,
    pub backend: String,
    pub total_bytes: Option<u64>,
}
impl DeviceBinding {
    fn from_gpu(gpu: &AcceleratorSnapshot) -> Self {
        Self {
            id: gpu.id.clone(),
            name: gpu.name.clone(),
            backend: gpu.backend.clone(),
            total_bytes: gpu.total_bytes,
        }
    }
    pub(super) fn matches(&self, gpu: &AcceleratorSnapshot) -> bool {
        self.id == gpu.id
            && self.name == gpu.name
            && self.backend == gpu.backend
            && self.total_bytes == gpu.total_bytes
    }
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ResourceSettings {
    pub state: LocalResourceConfigState,
    pub requested_bindings: Vec<DeviceBinding>,
    pub applied_bindings: Vec<DeviceBinding>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceWork {
    lease_id: String,
    resource_revision: u64,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("local-model")
        .join("resource-config.json"))
}
pub(super) fn ensure_loaded(app: &AppHandle, guard: &mut ManagerState) -> Result<(), String> {
    if guard.resource_settings_loaded {
        return Ok(());
    }
    let path = config_path(app)?;
    if path.exists() {
        reject_runtime_reparse_points(&path)?;
        let file = File::open(path).map_err(|_| "resource_config_read_failed")?;
        if file
            .metadata()
            .map_err(|_| "resource_config_read_failed")?
            .len()
            > 32768
        {
            return Err("resource_config_invalid".into());
        }
        let settings: ResourceSettings =
            serde_json::from_reader(file).map_err(|_| "resource_config_invalid")?;
        validate_shape(&settings.state.requested)?;
        validate_shape(&settings.state.applied)?;
        if settings.state.applied_revision > settings.state.revision
            || settings.state.revision > 9_007_199_254_740_991
            || settings.state.pending
                != (settings.state.revision != settings.state.applied_revision)
            || (!settings.state.pending && settings.state.requested != settings.state.applied)
        {
            return Err("resource_config_invalid".into());
        }
        guard.resource_settings = settings;
    }
    guard.resource_settings_loaded = true;
    Ok(())
}
fn persist(app: &AppHandle, settings: &ResourceSettings) -> Result<(), String> {
    let path = config_path(app)?;
    create_private_directory(path.parent().ok_or("resource_config_write_failed")?)?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec(settings).map_err(|_| "resource_config_write_failed")?;
    write_private_file(&temporary, &bytes)?;
    let result = atomic_replace(&temporary, &path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
pub(super) fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err("resource_config_write_failed".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, destination).map_err(|_| "resource_config_write_failed".into())
    }
}
pub(super) fn validate_shape(config: &LocalResourceConfig) -> Result<(), String> {
    if config.percentage_limits.as_ref().is_some_and(|limits| {
        [
            limits.response_cpu,
            limits.context_cpu,
            limits.ram,
            limits.gpu,
        ]
        .into_iter()
        .any(|value| !(1..=100).contains(&value))
    }) {
        return Err("resource_percentage_invalid".into());
    }
    if !matches!(config.mode.as_str(), "auto" | "gpu" | "cpu" | "hybrid") {
        return Err("resource_mode_invalid".into());
    }
    if let Some(ids) = &config.gpu_device_ids {
        let mut unique = HashSet::new();
        if ids.is_empty()
            || ids.len() > 32
            || ids.iter().any(|id| {
                id.is_empty()
                    || id.len() > 160
                    || !id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"-_:".contains(&c))
                    || !unique.insert(id)
            })
        {
            return Err("resource_gpu_selection_invalid".into());
        }
    }
    Ok(())
}
pub(super) fn validate_hardware(
    config: &LocalResourceConfig,
    hardware: &resource_runtime::ResourceSnapshot,
    gpus: &[AcceleratorSnapshot],
) -> Result<Vec<DeviceBinding>, String> {
    validate_shape(config)?;
    for value in [config.threads, config.threads_batch].into_iter().flatten() {
        if value == 0 || value > hardware.available_logical_cores {
            return Err("resource_threads_invalid".into());
        }
    }
    if config
        .ram_reserve_bytes
        .is_some_and(|v| v < GIB || v > hardware.total_ram_bytes.saturating_sub(GIB))
    {
        return Err("resource_ram_reserve_invalid".into());
    }
    // Retain previous GPU preferences while using CPU. A later GPU/Auto
    // change validates their availability and creates fresh device bindings.
    if config.mode == "cpu" {
        return Ok(Vec::new());
    }
    let selected = if let Some(ids) = &config.gpu_device_ids {
        ids.iter()
            .map(|id| {
                gpus.iter()
                    .find(|g| &g.id == id)
                    .ok_or("resource_gpu_selection_unavailable")
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        gpus.iter().collect()
    };
    if let Some(reserve) = config.vram_reserve_bytes {
        let fits = |gpu: &&AcceleratorSnapshot| {
            gpu.total_bytes
                .is_some_and(|total| reserve <= total.saturating_sub(256 * MIB))
        };
        let selection_fits = if config.gpu_device_ids.is_some() {
            !selected.is_empty() && selected.iter().all(fits)
        } else {
            // Automatic placement can leave a tiny integrated GPU unused.
            selected.iter().any(fits)
        };
        if reserve < 256 * MIB || !selection_fits {
            return Err("resource_vram_reserve_invalid".into());
        }
    }
    Ok(if config.gpu_device_ids.is_some() {
        selected.into_iter().map(DeviceBinding::from_gpu).collect()
    } else {
        Vec::new()
    })
}
pub(super) fn require_revision(guard: &ManagerState, revision: Option<u64>) -> Result<u64, String> {
    require_no_system_check(guard)?;
    let state = &guard.resource_settings.state;
    let revision = match revision {
        Some(revision) => revision,
        None if state.applied_revision == 0 && state.applied == LocalResourceConfig::default() => 0,
        None => return Err("resource_revision_required".into()),
    };
    if revision != state.applied_revision {
        return Err("resource_revision_mismatch".into());
    }
    if state.pending && guard.resource_work_leases.is_empty() {
        return Err("resource_config_pending".into());
    }
    Ok(revision)
}
fn check_expected(settings: &ResourceSettings, expected: u64) -> Result<(), String> {
    if settings.state.revision != expected {
        return Err("resource_revision_mismatch".into());
    }
    Ok(())
}

#[tauri::command]
pub fn local_model_get_resource_config(
    window: crate::commands::CallerWebview,
    app: AppHandle,
) -> Result<LocalResourceConfigState, String> {
    ensure_main_webview(&window)?;
    let mut guard = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.")?;
    ensure_loaded(&app, &mut guard)?;
    Ok(guard.resource_settings.state.clone())
}
#[tauri::command]
pub async fn local_model_set_resource_config(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    config: LocalResourceConfig,
    expected_revision: u64,
) -> Result<LocalResourceConfigState, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let hardware = resource_runtime::sample_hardware()?;
        let config = resolve_percentage_host_config(&config, &hardware)?;
        let gpus = if config.mode == "cpu" {
            Vec::new()
        } else {
            gpu_snapshot()
        };
        let bindings = validate_hardware(&config, &hardware, &gpus)?;
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.")?;
        ensure_loaded(&app, &mut guard)?;
        check_expected(&guard.resource_settings, expected_revision)?;
        if guard.resource_settings.state.requested == config
            && guard.resource_settings.requested_bindings == bindings
        {
            return Ok(guard.resource_settings.state.clone());
        }
        let mut candidate = guard.resource_settings.clone();
        candidate.state.revision = candidate
            .state
            .revision
            .checked_add(1)
            .filter(|r| *r <= 9_007_199_254_740_991)
            .ok_or("resource_revision_exhausted")?;
        candidate.state.requested = config;
        candidate.requested_bindings = bindings;
        candidate.state.pending = true;
        candidate.state.reason_code = Some("resource_config_pending".into());
        persist(&app, &candidate)?;
        guard.resource_settings = candidate;
        Ok(guard.resource_settings.state.clone())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn local_model_apply_resource_config(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    expected_revision: u64,
) -> Result<LocalResourceConfigState, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.")?;
        ensure_loaded(&app, &mut guard)?;
        check_expected(&guard.resource_settings, expected_revision)?;
        require_apply_idle(&guard)?;
        if !guard.resource_settings.state.pending {
            return Ok(guard.resource_settings.state.clone());
        }
        let mut candidate = guard.resource_settings.clone();
        candidate.state.applied = candidate.state.requested.clone();
        candidate.state.applied_revision = candidate.state.revision;
        candidate.state.pending = false;
        candidate.state.reason_code = None;
        candidate.applied_bindings = candidate.requested_bindings.clone();
        persist(&app, &candidate)?;
        // Keep the barrier locked until our old process has fully exited.
        if let Some(mut runtime) = guard.runtime.take() {
            runtime.stop();
        }
        guard.readiness.clear();
        guard.failures.clear();
        guard.cooldown_until_ms.clear();
        guard.last_error = None;
        guard.resource_settings = candidate;
        Ok(guard.resource_settings.state.clone())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn require_apply_idle(guard: &ManagerState) -> Result<(), String> {
    require_no_system_check(guard)?;
    if guard.active_request_id.is_some() || !guard.resource_work_leases.is_empty() {
        return Err("resource_config_busy".into());
    }
    Ok(())
}

fn require_no_system_check(guard: &ManagerState) -> Result<(), String> {
    if guard.resource_system_check_id.is_some() {
        return Err("resource_config_busy".into());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceHardwareCheck {
    hardware: Option<HardwareSnapshot>,
    runtime_unloaded: bool,
    reason_code: Option<String>,
}

struct SystemCheckReservation(String);
impl Drop for SystemCheckReservation {
    fn drop(&mut self) {
        if let Ok(mut guard) = state().lock() {
            if guard.resource_system_check_id.as_deref() == Some(self.0.as_str()) {
                guard.resource_system_check_id = None;
            }
        }
    }
}

fn reserve_system_check(
    guard: &mut ManagerState,
    id: &str,
) -> Result<Option<ManagedRuntime>, String> {
    require_apply_idle(guard).map_err(|_| "resource_system_check_busy".to_string())?;
    if guard.pending_catalog_generation.is_some() {
        return Err("resource_system_check_busy".into());
    }
    guard.resource_system_check_id = Some(id.into());
    guard.readiness.clear();
    Ok(guard.runtime.take())
}

/// Release only the app-owned idle inference process before a fresh capacity sample.
#[tauri::command]
pub async fn local_model_resource_system_check(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    cleanup: Option<bool>,
) -> Result<ResourceHardwareCheck, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if cleanup != Some(true) {
            return Ok(ResourceHardwareCheck {
                hardware: Some(collect_hardware_snapshot(Some(&app))?),
                runtime_unloaded: false,
                reason_code: None,
            });
        }
        let id = Uuid::new_v4().to_string();
        let runtime = {
            let mut guard = state().lock().map_err(|_| "resource_system_check_failed")?;
            reserve_system_check(&mut guard, &id)?
        };
        let _reservation = SystemCheckReservation(id);
        let runtime_unloaded = runtime.is_some();
        // Teardown (including blocking KV-save and process wait) completes BEFORE sampling.
        // No other apps, model files, disk caches or operating-system caches are purged.
        drop(runtime);
        let sample = collect_hardware_snapshot(Some(&app));
        Ok(ResourceHardwareCheck {
            reason_code: sample
                .as_ref()
                .err()
                .map(|_| "resource_system_check_failed".into()),
            hardware: sample.ok(),
            runtime_unloaded,
        })
    })
    .await
    .map_err(|_| "resource_system_check_failed".to_string())?
}
pub fn on_main_navigation(label: &str, started: bool) {
    if label != "main" || !started {
        return;
    }
    if let Ok(mut guard) = state().lock() {
        clear_navigation_leases(&mut guard);
    }
}
fn clear_navigation_leases(guard: &mut ManagerState) {
    // Covers renderer reloads even before any model catalog/session existed.
    // An active native operation keeps its own separate apply barrier.
    guard.resource_work_leases.clear();
}
#[tauri::command]
pub fn local_model_begin_resource_work(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    lease_id: String,
) -> Result<ResourceWork, String> {
    ensure_main_webview(&window)?;
    if !safe_id(&lease_id) {
        return Err("resource_work_lease_invalid".into());
    }
    let mut guard = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.")?;
    ensure_loaded(&app, &mut guard)?;
    require_no_system_check(&guard)?;
    if guard.resource_settings.state.pending {
        return Err("resource_config_pending".into());
    }
    if guard.resource_work_leases.len() >= 128
        || !guard.resource_work_leases.insert(lease_id.clone())
    {
        return Err("resource_work_lease_conflict".into());
    }
    Ok(ResourceWork {
        lease_id,
        resource_revision: guard.resource_settings.state.applied_revision,
    })
}
#[tauri::command]
pub fn local_model_end_resource_work(
    window: crate::commands::CallerWebview,
    lease_id: String,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    if !safe_id(&lease_id) {
        return Err("resource_work_lease_invalid".into());
    }
    let mut guard = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.")?;
    guard.resource_work_leases.remove(&lease_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn percentage_limits_round_trip_and_recompute_from_fresh_hardware() {
        let hardware = resource_runtime::ResourceSnapshot {
            logical_cores: 24,
            available_logical_cores: 16,
            physical_cores: Some(12),
            cpu_load: None,
            total_ram_bytes: 32 * GIB,
            available_ram_bytes: 20 * GIB,
        };
        let config = LocalResourceConfig {
            percentage_limits: Some(ResourcePercentageLimits {
                response_cpu: 50,
                context_cpu: 75,
                ram: 50,
                gpu: 50,
                cpu_enabled: None,
                ram_enabled: None,
                gpu_enabled: None,
            }),
            ..Default::default()
        };
        let resolved = resolve_percentage_host_config(&config, &hardware).unwrap();
        assert_eq!(resolved.threads, Some(7));
        assert_eq!(resolved.threads_batch, Some(10));
        let mut cpu_unthrottled = config.clone();
        cpu_unthrottled
            .percentage_limits
            .as_mut()
            .unwrap()
            .cpu_enabled = Some(false);
        let full_cpu = resolve_percentage_host_config(&cpu_unthrottled, &hardware).unwrap();
        assert_eq!(full_cpu.threads, Some(14));
        assert_eq!(full_cpu.threads_batch, Some(14));
        assert_eq!(
            full_cpu.percentage_limits.as_ref().unwrap().response_cpu,
            50
        );
        assert_eq!(full_cpu.ram_reserve_bytes, resolved.ram_reserve_bytes);
        assert_eq!(
            full_cpu.percentage_limits.as_ref().unwrap().gpu_percent(),
            50
        );
        let restored: LocalResourceConfig =
            serde_json::from_slice(&serde_json::to_vec(&full_cpu).unwrap()).unwrap();
        assert_eq!(
            restored.percentage_limits.as_ref().unwrap().cpu_enabled,
            Some(false)
        );
        let mut ram_unthrottled = config.clone();
        ram_unthrottled
            .percentage_limits
            .as_mut()
            .unwrap()
            .ram_enabled = Some(false);
        let full_ram = resolve_percentage_host_config(&ram_unthrottled, &hardware).unwrap();
        assert_eq!(
            full_ram.ram_reserve_bytes,
            Some(hardware.total_ram_bytes / 12)
        );
        assert_eq!(full_ram.threads, resolved.threads);
        assert_eq!(full_ram.threads_batch, resolved.threads_batch);
        assert_eq!(
            full_ram.percentage_limits.as_ref().unwrap().gpu_percent(),
            50
        );
        assert_eq!(full_ram.percentage_limits.as_ref().unwrap().ram, 50);
        let mut restored_ram: LocalResourceConfig =
            serde_json::from_slice(&serde_json::to_vec(&full_ram).unwrap()).unwrap();
        assert_eq!(
            restored_ram.percentage_limits.as_ref().unwrap().ram_enabled,
            Some(false)
        );
        restored_ram.percentage_limits.as_mut().unwrap().ram_enabled = Some(true);
        assert_eq!(
            resolve_percentage_host_config(&restored_ram, &hardware)
                .unwrap()
                .ram_reserve_bytes,
            resolved.ram_reserve_bytes
        );
        let maximum = hardware.available_ram_bytes - hardware.total_ram_bytes / 12;
        assert_eq!(
            hardware.available_ram_bytes - resolved.ram_reserve_bytes.unwrap(),
            percentage_budget(maximum, 50)
        );
        let encoded = serde_json::to_vec(&resolved).unwrap();
        assert_eq!(
            serde_json::from_slice::<LocalResourceConfig>(&encoded).unwrap(),
            resolved
        );
        let smaller = resource_runtime::ResourceSnapshot {
            available_logical_cores: 2,
            available_ram_bytes: 6 * GIB,
            ..hardware
        };
        let fresh = resolve_percentage_host_config(&resolved, &smaller).unwrap();
        assert_eq!(fresh.threads, Some(1));
        assert!(fresh.ram_reserve_bytes.unwrap() < 6 * GIB);
        let legacy = serde_json::to_value(LocalResourceConfig::default()).unwrap();
        assert!(legacy.get("percentageLimits").is_none());
        assert!(serde_json::from_value::<LocalResourceConfig>(legacy)
            .unwrap()
            .percentage_limits
            .is_none());
    }
    #[test]
    fn invalid_percentages_are_rejected_without_weakening_resource_guards() {
        for value in [0, 101, 255] {
            let config = LocalResourceConfig {
                percentage_limits: Some(ResourcePercentageLimits {
                    response_cpu: 100,
                    context_cpu: 100,
                    ram: value,
                    gpu: 100,
                    cpu_enabled: None,
                    ram_enabled: None,
                    gpu_enabled: None,
                }),
                ..Default::default()
            };
            assert_eq!(
                validate_shape(&config).unwrap_err(),
                "resource_percentage_invalid"
            );
        }
        assert_eq!(percentage_budget(u64::MAX, 100), u64::MAX);
        assert_eq!(maximum_resource_threads(24, 4), 3);
        assert_eq!(maximum_resource_threads(1, 1), 1);
    }
    #[test]
    fn forced_split_persists_without_changing_the_default() {
        let config = super::LocalResourceConfig {
            mode: "hybrid".into(),
            ..Default::default()
        };
        super::validate_shape(&config).unwrap();
        let encoded = serde_json::to_vec(&config).unwrap();
        let decoded: super::LocalResourceConfig = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.mode, "hybrid");
        assert_eq!(super::LocalResourceConfig::default().mode, "auto");
    }
    use super::*;
    #[test]
    fn system_check_refuses_live_work_and_reserves_native_admission_without_revising_settings() {
        let mut guard = ManagerState::default();
        guard.resource_work_leases.insert("whole-chat".into());
        assert_eq!(
            reserve_system_check(&mut guard, "check").unwrap_err(),
            "resource_system_check_busy"
        );
        assert!(guard.resource_system_check_id.is_none());
        assert!(guard.resource_work_leases.contains("whole-chat"));
        guard.resource_work_leases.clear();
        guard.active_request_id = Some("prepare".into());
        assert_eq!(
            reserve_system_check(&mut guard, "check").unwrap_err(),
            "resource_system_check_busy"
        );
        assert_eq!(guard.active_request_id.as_deref(), Some("prepare"));
        guard.active_request_id = None;
        guard.pending_catalog_generation = Some(2);
        assert!(reserve_system_check(&mut guard, "check").is_err());
        guard.pending_catalog_generation = None;
        assert!(reserve_system_check(&mut guard, "check").unwrap().is_none());
        assert_eq!(guard.resource_system_check_id.as_deref(), Some("check"));
        assert_eq!(
            require_revision(&guard, Some(0)).unwrap_err(),
            "resource_config_busy"
        );
        assert!(require_apply_idle(&guard).is_err());
        assert!(require_no_system_check(&guard).is_err());
        assert!(reserve_system_check(&mut guard, "other-check").is_err());
        clear_navigation_leases(&mut guard);
        assert_eq!(guard.resource_system_check_id.as_deref(), Some("check"));
        assert_eq!(guard.resource_settings.state.revision, 0);
        guard.resource_system_check_id = None;
        assert_eq!(require_revision(&guard, Some(0)).unwrap(), 0);
    }
    #[test]
    fn main_navigation_releases_orphaned_work_before_catalog_registration_without_cancelling_native_work(
    ) {
        let mut guard = ManagerState::default();
        guard.resource_work_leases.insert("orphan".into());
        guard.active_request_id = Some("preparing".into());
        guard.resource_settings.state.pending = true;
        clear_navigation_leases(&mut guard);
        assert!(guard.resource_work_leases.is_empty());
        assert_eq!(guard.active_request_id.as_deref(), Some("preparing"));
        assert!(guard.resource_settings.state.pending);
        assert_eq!(
            require_apply_idle(&guard).unwrap_err(),
            "resource_config_busy"
        );
    }
    #[test]
    fn atomic_settings_replacement_preserves_complete_json_and_pending_state() {
        let root =
            std::env::temp_dir().join(format!("luczor-resource-config-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source = root.join("candidate.json");
        let destination = root.join("resource.json");
        fs::write(&destination, b"old").unwrap();
        let mut settings = ResourceSettings::default();
        settings.state.requested.mode = "cpu".into();
        settings.state.revision = 1;
        settings.state.pending = true;
        fs::write(&source, serde_json::to_vec(&settings).unwrap()).unwrap();
        atomic_replace(&source, &destination).unwrap();
        let restored: ResourceSettings =
            serde_json::from_reader(File::open(&destination).unwrap()).unwrap();
        assert!(restored.state.pending);
        assert_eq!(restored.state.applied.mode, "auto");
        assert_eq!(restored.state.requested.mode, "cpu");
        assert!(!source.exists());
        fs::remove_file(destination).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn expert_validation_uses_available_cores_and_smallest_selected_gpu() {
        let hardware = resource_runtime::ResourceSnapshot {
            logical_cores: 24,
            physical_cores: Some(12),
            available_logical_cores: 4,
            cpu_load: None,
            total_ram_bytes: 32 * GIB,
            available_ram_bytes: 20 * GIB,
        };
        let gpus = vec![AcceleratorSnapshot {
            id: "cuda-0".into(),
            backend: "cuda".into(),
            name: "A".into(),
            total_bytes: Some(8 * GIB),
            available_bytes: Some(6 * GIB),
            detection_source: "nvml".into(),
            dedicated_system_bytes: None,
            shared_system_limit_bytes: None,
        }];
        let mut config = LocalResourceConfig {
            gpu_device_ids: Some(vec!["cuda-0".into()]),
            threads: Some(4),
            ram_reserve_bytes: Some(GIB),
            vram_reserve_bytes: Some(256 * MIB),
            ..Default::default()
        };
        let binding = validate_hardware(&config, &hardware, &gpus).unwrap();
        assert!(binding[0].matches(&gpus[0]));
        config.threads = Some(5);
        assert_eq!(
            validate_hardware(&config, &hardware, &gpus).unwrap_err(),
            "resource_threads_invalid"
        );
        config.threads = Some(4);
        config.vram_reserve_bytes = Some(8 * GIB);
        assert_eq!(
            validate_hardware(&config, &hardware, &gpus).unwrap_err(),
            "resource_vram_reserve_invalid"
        );
        config.vram_reserve_bytes = None;
        config.ram_reserve_bytes = Some(32 * GIB);
        assert_eq!(
            validate_hardware(&config, &hardware, &gpus).unwrap_err(),
            "resource_ram_reserve_invalid"
        );
    }
    #[test]
    fn automatic_reserve_accepts_a_suitable_gpu_but_manual_selection_requires_every_card() {
        let hardware = resource_runtime::ResourceSnapshot {
            logical_cores: 8,
            physical_cores: Some(4),
            available_logical_cores: 8,
            cpu_load: None,
            total_ram_bytes: 32 * GIB,
            available_ram_bytes: 20 * GIB,
        };
        let make_gpu = |id: &str, total_bytes: Option<u64>| AcceleratorSnapshot {
            id: id.into(),
            backend: "unknown".into(),
            name: id.into(),
            total_bytes,
            available_bytes: None,
            detection_source: "dxgi".into(),
            dedicated_system_bytes: None,
            shared_system_limit_bytes: None,
        };
        let gpus = vec![
            make_gpu("large", Some(24 * GIB)),
            make_gpu("integrated", Some(128 * MIB)),
        ];
        let mut config = LocalResourceConfig {
            vram_reserve_bytes: Some(GIB),
            ..Default::default()
        };
        assert!(validate_hardware(&config, &hardware, &gpus).is_ok());
        assert_eq!(
            validate_hardware(&config, &hardware, &gpus[1..]).unwrap_err(),
            "resource_vram_reserve_invalid"
        );
        assert_eq!(
            validate_hardware(&config, &hardware, &[make_gpu("unknown", None)]).unwrap_err(),
            "resource_vram_reserve_invalid"
        );
        config.gpu_device_ids = Some(vec!["large".into(), "integrated".into()]);
        assert_eq!(
            validate_hardware(&config, &hardware, &gpus).unwrap_err(),
            "resource_vram_reserve_invalid"
        );
        config.gpu_device_ids = Some(vec!["large".into()]);
        assert_eq!(
            validate_hardware(&config, &hardware, &gpus).unwrap().len(),
            1
        );
    }
    #[test]
    fn cpu_retains_old_gpu_preferences_without_hardware_and_revalidates_on_later_gpu_change() {
        let hardware = resource_runtime::ResourceSnapshot {
            logical_cores: 8,
            physical_cores: Some(4),
            available_logical_cores: 8,
            cpu_load: None,
            total_ram_bytes: 32 * GIB,
            available_ram_bytes: 20 * GIB,
        };
        let mut config = LocalResourceConfig {
            mode: "cpu".into(),
            gpu_device_ids: Some(vec!["previous-card".into()]),
            threads: Some(4),
            ram_reserve_bytes: Some(GIB),
            vram_reserve_bytes: Some(GIB),
            ..Default::default()
        };
        assert!(validate_hardware(&config, &hardware, &[])
            .unwrap()
            .is_empty());
        assert_eq!(config.gpu_device_ids.as_ref().unwrap(), &["previous-card"]);
        config.mode = "gpu".into();
        assert_eq!(
            validate_hardware(&config, &hardware, &[]).unwrap_err(),
            "resource_gpu_selection_unavailable"
        );
        config.mode = "cpu".into();
        config.threads = Some(9);
        assert_eq!(
            validate_hardware(&config, &hardware, &[]).unwrap_err(),
            "resource_threads_invalid"
        );
        config.threads = Some(4);
        config.ram_reserve_bytes = Some(32 * GIB);
        assert_eq!(
            validate_hardware(&config, &hardware, &[]).unwrap_err(),
            "resource_ram_reserve_invalid"
        );
        config.ram_reserve_bytes = Some(GIB);
        config.gpu_device_ids = Some(vec!["--invalid device".into()]);
        assert_eq!(
            validate_hardware(&config, &hardware, &[]).unwrap_err(),
            "resource_gpu_selection_invalid"
        );
    }
    #[test]
    fn revisions_and_workflow_barrier_cannot_be_bypassed_by_legacy_requests() {
        let mut guard = ManagerState::default();
        assert_eq!(require_revision(&guard, None).unwrap(), 0);
        guard.resource_settings.state.revision = 1;
        guard.resource_settings.state.pending = true;
        assert_eq!(
            require_revision(&guard, Some(0)).unwrap_err(),
            "resource_config_pending"
        );
        guard.resource_work_leases.insert("active-work".into());
        assert_eq!(require_revision(&guard, Some(0)).unwrap(), 0);
        assert_eq!(
            require_apply_idle(&guard).unwrap_err(),
            "resource_config_busy"
        );
        guard.resource_work_leases.clear();
        guard.resource_settings.state.pending = false;
        guard.resource_settings.state.applied_revision = 1;
        assert_eq!(
            require_revision(&guard, None).unwrap_err(),
            "resource_revision_required"
        );
        assert_eq!(
            require_revision(&guard, Some(0)).unwrap_err(),
            "resource_revision_mismatch"
        );
        assert!(require_revision(&guard, Some(1)).is_ok());
        guard.active_request_id = Some("prepare".into());
        assert!(require_apply_idle(&guard).is_err());
    }
    #[test]
    fn configuration_rejects_cli_injection_duplicate_devices_and_stale_cas() {
        let mut config = LocalResourceConfig {
            gpu_device_ids: Some(vec!["cuda-0 --rpc bad".into()]),
            ..Default::default()
        };
        assert!(validate_shape(&config).is_err());
        config.gpu_device_ids = Some(vec!["cuda-0".into(), "cuda-0".into()]);
        assert!(validate_shape(&config).is_err());
        assert!(check_expected(&ResourceSettings::default(), 1).is_err());
    }
}
