// src-tauri/src/commands/system.rs
//
// OS perception + control commands for Luczor.
//
// SAFETY: These are powerful. The trusted local main webview calls them through
// the tool registry, which enforces the observe/act mode, global kill switch,
// and per-call approval. Native label/capability checks isolate remote webviews;
// the main webview itself remains the explicit trust boundary.

use base64::Engine;
#[cfg(not(windows))]
use enigo::Coordinate;
use enigo::{Axis, Button, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use nvml_wrapper::{enum_wrappers::device::TemperatureSensor, Nvml};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::{
    Components, ProcessRefreshKind, ProcessesToUpdate, System, MINIMUM_CPU_UPDATE_INTERVAL,
};

use super::desktop_target::{DesktopActionGuard, DesktopObservation, InputPayload, ObservePayload};
use super::ensure_main_webview;
use super::execution::{admit, Guarded};
use super::system_status_model::SystemMetrics;

#[path = "system_disk.rs"]
pub(crate) mod system_disk;

#[cfg(windows)]
#[path = "system_gpu.rs"]
mod system_gpu;

#[tauri::command]
pub async fn system_diagnostics(
    window: crate::commands::CallerWebview,
    payload: Guarded<super::system_diagnostics::DiagnosticsPayload>,
) -> Result<super::system_diagnostics::DiagnosticsReport, String> {
    ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, false)?;
    tauri::async_runtime::spawn_blocking(move || {
        super::system_diagnostics::collect(payload.request, lease)
    })
    .await
    .map_err(|_| "System diagnostic worker could not finish.".to_string())?
}

#[tauri::command]
pub async fn desktop_observe(
    window: crate::commands::CallerWebview,
    payload: ObservePayload,
) -> Result<DesktopObservation, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || super::desktop_target::observe(payload))
        .await
        .map_err(|_| "desktop_control_observation_worker_failed")?
}

/* =========================================================
 * Perception
 * ========================================================= */

#[derive(Debug, Serialize, Clone)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    pub primary: bool,
}

pub(super) fn monitor_info(monitor: &xcap::Monitor) -> Result<MonitorInfo, String> {
    let info = MonitorInfo {
        id: monitor
            .id()
            .map_err(|e| format!("Monitor::id failed: {e}"))?,
        name: monitor
            .name()
            .map_err(|e| format!("Monitor::name failed: {e}"))?,
        x: monitor.x().map_err(|e| format!("Monitor::x failed: {e}"))?,
        y: monitor.y().map_err(|e| format!("Monitor::y failed: {e}"))?,
        width: monitor
            .width()
            .map_err(|e| format!("Monitor::width failed: {e}"))?,
        height: monitor
            .height()
            .map_err(|e| format!("Monitor::height failed: {e}"))?,
        scale_factor: monitor
            .scale_factor()
            .map_err(|e| format!("Monitor::scale_factor failed: {e}"))?,
        primary: monitor
            .is_primary()
            .map_err(|e| format!("Monitor::is_primary failed: {e}"))?,
    };
    if info.width == 0
        || info.height == 0
        || !info.scale_factor.is_finite()
        || info.scale_factor <= 0.0
    {
        return Err("Monitor geometry is unavailable.".into());
    }
    Ok(info)
}

/// Native desktop coordinates, including negative origins on secondary displays.
#[tauri::command]
pub async fn list_monitors(
    window: crate::commands::CallerWebview,
) -> Result<Vec<MonitorInfo>, String> {
    ensure_main_webview(&window)?;
    let monitors = xcap::Monitor::all().map_err(|e| format!("Monitor::all failed: {e}"))?;
    if monitors.is_empty() {
        return Err("No monitor found".into());
    }
    monitors.iter().map(monitor_info).collect()
}

fn select_monitor_index(
    monitors: &[MonitorInfo],
    requested_id: Option<u32>,
) -> Result<usize, String> {
    monitors
        .iter()
        .position(|monitor| match requested_id {
            Some(id) => monitor.id == id,
            None => monitor.primary,
        })
        .ok_or_else(|| match requested_id {
            Some(_) => "Selected monitor is no longer available. Refresh os_environment.".into(),
            None => "Primary monitor is unavailable.".into(),
        })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenCapturePayload {
    pub monitor_id: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct ScreenCapture {
    pub base64: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub monitor: MonitorInfo,
}

/// Capture the primary or explicitly selected monitor as a PNG (base64).
#[tauri::command]
pub async fn capture_screen(
    window: crate::commands::CallerWebview,
    payload: Option<ScreenCapturePayload>,
) -> Result<ScreenCapture, String> {
    ensure_main_webview(&window)?;
    let monitor_id = super::desktop_control::capture_monitor(payload.and_then(|p| p.monitor_id))?;
    #[cfg(target_os = "linux")]
    if super::desktop_linux::is_wayland() {
        return tauri::async_runtime::spawn_blocking(move || {
            super::desktop_accessibility::portal::capture(Some(monitor_id))
        })
        .await
        .map_err(|_| "desktop_portal_capture_worker_failed")?;
    }
    let monitors = xcap::Monitor::all().map_err(|e| format!("Monitor::all failed: {e}"))?;
    let infos: Vec<_> = monitors
        .iter()
        .map(monitor_info)
        .collect::<Result<_, _>>()?;
    let index = select_monitor_index(&infos, Some(monitor_id))?;
    let monitor = &monitors[index];

    let img = monitor
        .capture_image()
        .map_err(|e| format!("capture_image failed: {e}"))?;

    let (w, h) = (img.width(), img.height());

    let mut buf: Vec<u8> = Vec::new();
    {
        use image::codecs::png::PngEncoder;
        use image::{ExtendedColorType, ImageEncoder};
        let encoder = PngEncoder::new(&mut buf);
        encoder
            .write_image(img.as_raw(), w, h, ExtendedColorType::Rgba8)
            .map_err(|e| format!("PNG encode failed: {e}"))?;
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok(ScreenCapture {
        base64: b64,
        mime: "image/png".to_string(),
        width: w,
        height: h,
        monitor: infos[index].clone(),
    })
}

/// Read the system clipboard (text).
#[tauri::command]
pub async fn read_clipboard(window: crate::commands::CallerWebview) -> Result<String, String> {
    ensure_main_webview(&window)?;
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("Clipboard init failed: {e}"))?;
    cb.get_text()
        .map_err(|e| format!("Clipboard read failed: {e}"))
}

#[derive(Debug, Serialize)]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub focused: bool,
    pub minimized: bool,
}

/// List visible windows (title + owning app). Read-only perception.
#[tauri::command]
pub async fn list_windows(
    window: crate::commands::CallerWebview,
) -> Result<Vec<WindowInfo>, String> {
    ensure_main_webview(&window)?;
    let windows = xcap::Window::all().map_err(|e| format!("Window::all failed: {e}"))?;
    let mut out = Vec::new();
    for w in windows {
        let title = w
            .title()
            .map_err(|e| format!("Window::title failed: {e}"))?;
        if title.trim().is_empty() {
            continue;
        }
        out.push(WindowInfo {
            id: w.id().map_err(|e| format!("Window::id failed: {e}"))?,
            title,
            app_name: w
                .app_name()
                .map_err(|e| format!("Window::app_name failed: {e}"))?,
            x: w.x().map_err(|e| format!("Window::x failed: {e}"))?,
            y: w.y().map_err(|e| format!("Window::y failed: {e}"))?,
            width: w
                .width()
                .map_err(|e| format!("Window::width failed: {e}"))?,
            height: w
                .height()
                .map_err(|e| format!("Window::height failed: {e}"))?,
            focused: w
                .is_focused()
                .map_err(|e| format!("Window::is_focused failed: {e}"))?,
            minimized: w
                .is_minimized()
                .map_err(|e| format!("Window::is_minimized failed: {e}"))?,
        });
    }
    Ok(out)
}

static METRICS_CACHE: OnceLock<Mutex<Option<(Instant, SystemMetrics)>>> = OnceLock::new();

#[cfg(test)]
fn collect_system_metrics() -> Result<SystemMetrics, String> {
    collect_system_metrics_for_app(None)
}

pub(crate) fn collect_system_metrics_for_app(
    app: Option<&tauri::AppHandle>,
) -> Result<SystemMetrics, String> {
    let cache = METRICS_CACHE.get_or_init(|| Mutex::new(None));
    // A status view and a read-only tool can request the same sample together.
    // Serialize the short native observation instead of collecting overlapping windows.
    let mut cached = cache
        .lock()
        .map_err(|_| "System metrics cache unavailable")?;
    if let Some((updated_at, metrics)) = cached.as_ref() {
        if updated_at.elapsed() < Duration::from_secs(2) {
            return Ok(metrics.clone());
        }
    }

    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_all();
    let process_refresh = ProcessRefreshKind::new().with_memory().with_cpu();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh);
    let before = process_samples(&system);
    let model_directory = app.and_then(super::local_model::configured_model_directory_for_metrics);
    let disk_samplers = system_disk::DiskSampler::start(model_directory.as_deref());
    let model_before = super::local_model::managed_runtime_process_id();
    #[cfg(windows)]
    let gpu_sampler = system_gpu::WindowsGpuSampler::start();
    std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_cpu_usage();
    system.refresh_memory();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh);
    let after = process_samples(&system);
    let model_after = super::local_model::managed_runtime_process_id();

    let total_memory = system.total_memory();
    let used_memory = system.used_memory();
    let ram_percent = if total_memory > 0 {
        (used_memory as f32 / total_memory as f32) * 100.0
    } else {
        0.0
    };

    let (cpu_temp_c, sensor_gpu_temp_c) = component_temperatures();
    let (gpu_percent, nvml_gpu_temp_c) = gpu_telemetry();
    let model_identity = if model_before == model_after {
        model_after
    } else {
        Err(())
    };
    let scopes = select_process_scopes(&after, std::process::id(), model_identity);
    let app = scoped_process_metrics(
        scopes.app.as_ref(),
        &before,
        &after,
        system.cpus().len(),
        total_memory,
    );
    let model = scoped_process_metrics(
        scopes.model.as_ref(),
        &before,
        &after,
        system.cpus().len(),
        total_memory,
    );
    #[cfg(windows)]
    let (engine_gpu_percent, app_gpu_percent, model_gpu_percent) =
        if let Some(sampler) = gpu_sampler {
            let empty = HashSet::new();
            let measured = sampler.finish(
                scopes.app.as_ref().unwrap_or(&empty),
                scopes.model.as_ref().unwrap_or(&empty),
            );
            (
                measured.total_percent,
                measured
                    .total_percent
                    .and(scopes.app.as_ref())
                    .and(measured.app_percent),
                measured
                    .total_percent
                    .and(scopes.model.as_ref())
                    .and(measured.model_percent),
            )
        } else {
            (None, None, None)
        };
    #[cfg(not(windows))]
    let (engine_gpu_percent, app_gpu_percent, model_gpu_percent) = (None, None, None);
    let gpu_source = if engine_gpu_percent.is_some() {
        "windows_engine"
    } else if gpu_percent.is_some() {
        "nvml"
    } else {
        "unavailable"
    };

    let disks: Vec<_> = disk_samplers
        .into_iter()
        .map(system_disk::DiskSampler::finish)
        .collect();
    let app_disk = disks
        .iter()
        .find(|disk| disk.scopes.contains(&"app"))
        .cloned()
        .or_else(|| disks.first().cloned());
    let metrics = SystemMetrics {
        disks,
        disk: app_disk,
        cpu_percent: clamp_percent(system.global_cpu_usage()),
        ram_percent: clamp_percent(ram_percent),
        ram_used_mb: used_memory / 1024 / 1024,
        ram_total_mb: total_memory / 1024 / 1024,
        gpu_percent: engine_gpu_percent.or(gpu_percent).map(clamp_percent),
        cpu_temp_c,
        gpu_temp_c: nvml_gpu_temp_c.or(sensor_gpu_temp_c),
        app_cpu_percent: app.cpu,
        app_ram_percent: app.ram,
        app_ram_used_mb: app.ram_bytes.map(|bytes| bytes / 1024 / 1024),
        app_gpu_percent,
        model_cpu_percent: model.cpu,
        model_ram_percent: model.ram,
        model_ram_used_mb: model.ram_bytes.map(|bytes| bytes / 1024 / 1024),
        model_gpu_percent,
        model_running: scopes.model_running,
        gpu_source,
        network_local: super::local_model::network_snapshot(),
    };
    *cached = Some((Instant::now(), metrics.clone()));
    Ok(metrics)
}

#[derive(Debug, Clone)]
struct ProcessSample {
    parent: Option<u32>,
    started_at: u64,
    cpu: f32,
    ram_bytes: u64,
}

fn process_samples(system: &System) -> HashMap<u32, ProcessSample> {
    system
        .processes()
        .iter()
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                ProcessSample {
                    parent: process.parent().map(|parent| parent.as_u32()),
                    started_at: process.start_time(),
                    cpu: process.cpu_usage(),
                    ram_bytes: process.memory(),
                },
            )
        })
        .collect()
}

/// Parent links are the only association: process names, command lines, and
/// unrelated llama servers are neither inspected nor returned to the webview.
fn process_tree(processes: &HashMap<u32, ProcessSample>, root: u32) -> Option<HashSet<u32>> {
    processes.get(&root)?;
    let mut selected = HashSet::from([root]);
    loop {
        let children: Vec<_> = processes
            .iter()
            .filter_map(|(pid, process)| {
                if selected.contains(pid) {
                    return None;
                }
                let parent = process.parent?;
                let parent_process = processes.get(&parent)?;
                (selected.contains(&parent)
                    && (parent_process.started_at == 0
                        || process.started_at >= parent_process.started_at))
                    .then_some(*pid)
            })
            .collect();
        if children.is_empty() {
            break;
        }
        selected.extend(children);
    }
    Some(selected)
}

struct ProcessScopes {
    app: Option<HashSet<u32>>,
    model: Option<HashSet<u32>>,
    model_running: Option<bool>,
}

fn select_process_scopes(
    processes: &HashMap<u32, ProcessSample>,
    app_pid: u32,
    model_pid: Result<Option<u32>, ()>,
) -> ProcessScopes {
    let Ok(model_pid) = model_pid else {
        // Without a trustworthy model identity, subtracting a guessed process
        // would either attribute model work to the app or hide unrelated work.
        return ProcessScopes {
            app: None,
            model: None,
            model_running: None,
        };
    };
    let mut app = process_tree(processes, app_pid);
    let model = model_pid.and_then(|pid| process_tree(processes, pid));
    if model_pid.is_some() && model.is_none() {
        app = None;
    }
    if let (Some(app), Some(model)) = (&mut app, &model) {
        app.retain(|pid| !model.contains(pid));
    }
    ProcessScopes {
        app,
        model,
        model_running: Some(model_pid.is_some()),
    }
}

#[derive(Default)]
struct ScopedProcessMetrics {
    cpu: Option<f32>,
    ram: Option<f32>,
    ram_bytes: Option<u64>,
}

fn scoped_process_metrics(
    selected: Option<&HashSet<u32>>,
    before: &HashMap<u32, ProcessSample>,
    after: &HashMap<u32, ProcessSample>,
    logical_cpus: usize,
    total_memory: u64,
) -> ScopedProcessMetrics {
    let Some(selected) = selected.filter(|ids| !ids.is_empty()) else {
        return ScopedProcessMetrics::default();
    };
    let current: Option<Vec<_>> = selected.iter().map(|pid| after.get(pid)).collect();
    let Some(current) = current else {
        return ScopedProcessMetrics::default();
    };
    let cpu = if logical_cpus > 0
        && selected.iter().all(|pid| {
            before
                .get(pid)
                .zip(after.get(pid))
                .is_some_and(|(old, new)| old.started_at == new.started_at)
        })
        && current
            .iter()
            .all(|process| process.cpu.is_finite() && process.cpu >= 0.0)
    {
        Some(clamp_percent(
            current
                .iter()
                .map(|process| process.cpu as f64)
                .sum::<f64>() as f32
                / logical_cpus as f32,
        ))
    } else {
        None
    };
    // sysinfo's Windows memory is Working Set, which may include shared pages.
    // A zero resident size cannot demonstrate a readable live process sample.
    let ram_bytes = current.iter().try_fold(0u64, |sum, process| {
        if process.ram_bytes == 0 {
            None
        } else {
            sum.checked_add(process.ram_bytes)
        }
    });
    let ram = ram_bytes
        .filter(|_| total_memory > 0)
        .map(|bytes| clamp_percent((bytes as f64 / total_memory as f64 * 100.0) as f32));
    ScopedProcessMetrics {
        cpu,
        ram,
        ram_bytes,
    }
}

fn clamp_percent(v: f32) -> f32 {
    if v.is_finite() {
        v.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

fn clean_temp(v: f32) -> Option<f32> {
    if v.is_finite() && v > 0.0 && v < 130.0 {
        Some((v * 10.0).round() / 10.0)
    } else {
        None
    }
}

fn hotter(current: Option<f32>, next: f32) -> Option<f32> {
    match current {
        Some(v) if v >= next => Some(v),
        _ => Some(next),
    }
}

fn is_gpu_component(label: &str) -> bool {
    label.contains("gpu")
        || label.contains("nvidia")
        || label.contains("geforce")
        || label.contains("radeon")
        || label.contains("amd graphics")
}

fn is_cpu_component(label: &str) -> bool {
    label.contains("cpu")
        || label.contains("package")
        || label.contains("core")
        || label.contains("tctl")
        || label.contains("tdie")
        || label.contains("k10temp")
        || label.contains("zenpower")
        || label.contains("ryzen")
        || label.contains("intel core")
}

fn component_temperatures() -> (Option<f32>, Option<f32>) {
    let components = Components::new_with_refreshed_list();
    let mut cpu_temp = None;
    let mut gpu_temp = None;

    for component in &components {
        let Some(temp) = clean_temp(component.temperature()) else {
            continue;
        };

        let label = component.label().to_ascii_lowercase();
        if is_gpu_component(&label) {
            gpu_temp = hotter(gpu_temp, temp);
        } else if is_cpu_component(&label) {
            cpu_temp = hotter(cpu_temp, temp);
        }
    }

    // Do not map an arbitrary thermal-zone value to CPU. An unavailable CPU
    // sensor is more useful and safer than a temperature from another device.
    (cpu_temp, gpu_temp)
}

fn gpu_telemetry() -> (Option<f32>, Option<f32>) {
    // NVML is loaded dynamically by the wrapper. If no compatible NVIDIA
    // driver exists, metrics remain unavailable without spawning a process.
    let Ok(nvml) = Nvml::init() else {
        return (None, None);
    };
    let Ok(count) = nvml.device_count() else {
        return (None, None);
    };

    let mut busiest = None;
    let mut hottest = None;
    for index in 0..count {
        let Ok(device) = nvml.device_by_index(index) else {
            continue;
        };
        if let Ok(utilization) = device.utilization_rates() {
            busiest = hotter(busiest, utilization.gpu as f32);
        }
        if let Ok(temp) = device.temperature(TemperatureSensor::Gpu) {
            hottest = hotter(hottest, temp as f32);
        }
    }

    (busiest, hottest)
}

/* =========================================================
 * Control (input simulation)
 * ========================================================= */

fn new_enigo() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|e| format!("Enigo init failed: {e}"))
}

#[derive(Debug, Deserialize)]
pub struct MoveMousePayload {
    pub x: i32,
    pub y: i32,
}

fn validate_coordinates(x: i32, y: i32) -> Result<(), String> {
    if x.unsigned_abs() > 100_000 || y.unsigned_abs() > 100_000 {
        return Err("Coordinates must be between -100000 and 100000.".into());
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn place_physical_pointer(
    x: i32,
    y: i32,
    monitors: &[MonitorInfo],
    place: impl FnOnce(i32, i32) -> Result<(), String>,
    locate: impl FnOnce() -> Result<(i32, i32), String>,
) -> Result<(), String> {
    validate_coordinates(x, y)?;
    let visible = monitors.iter().any(|monitor| {
        i64::from(x) >= i64::from(monitor.x)
            && i64::from(y) >= i64::from(monitor.y)
            && i64::from(x) < i64::from(monitor.x) + i64::from(monitor.width)
            && i64::from(y) < i64::from(monitor.y) + i64::from(monitor.height)
    });
    if !visible {
        return Err("Target is outside the current monitors. Refresh os_environment.".into());
    }
    place(x, y)?;
    if locate()? != (x, y) {
        return Err("Pointer did not reach the requested position; no click was sent.".into());
    }
    Ok(())
}

#[cfg(windows)]
fn move_pointer(x: i32, y: i32) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::POINT,
        UI::WindowsAndMessaging::{GetPhysicalCursorPos, SetPhysicalCursorPos},
    };
    let monitors = xcap::Monitor::all().map_err(|e| format!("Monitor::all failed: {e}"))?;
    let infos: Vec<_> = monitors
        .iter()
        .map(monitor_info)
        .collect::<Result<_, _>>()?;
    // Enigo 0.3 normalizes absolute moves against the primary display only.
    // Physical Win32 coordinates preserve negative origins and mixed DPI:
    // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setphysicalcursorpos
    place_physical_pointer(
        x,
        y,
        &infos,
        |x, y| {
            // SAFETY: Win32 accepts scalar physical coordinates; no pointers are passed.
            if unsafe { SetPhysicalCursorPos(x, y) } == 0 {
                return Err(format!(
                    "move_mouse failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        },
        || {
            let mut position = POINT { x: 0, y: 0 };
            // SAFETY: position is valid writable storage for this synchronous call.
            if unsafe { GetPhysicalCursorPos(&mut position) } == 0 {
                return Err(format!(
                    "Pointer verification failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok((position.x, position.y))
        },
    )
}

#[cfg(not(windows))]
fn move_pointer(x: i32, y: i32) -> Result<(), String> {
    validate_coordinates(x, y)?;
    new_enigo()?
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| format!("move_mouse failed: {e}"))
}

#[tauri::command]
pub async fn move_mouse(
    window: crate::commands::CallerWebview,
    payload: InputPayload<MoveMousePayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || move_mouse_bound(payload))
        .await
        .map_err(|_| "desktop_control_worker_failed")?
}

fn move_mouse_bound(payload: InputPayload<MoveMousePayload>) -> Result<(), String> {
    let guard = DesktopActionGuard::acquire(&payload.execution, &payload.observation_id)?;
    let payload = payload.request;
    validate_coordinates(payload.x, payload.y)?;
    guard.point(payload.x, payload.y)?;
    guard.show_point(payload.x, payload.y)?;
    if guard.isolated() {
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    if super::desktop_linux::is_wayland() {
        return super::desktop_accessibility::portal::move_to(&guard, payload.x, payload.y);
    }
    move_pointer(payload.x, payload.y)
}

#[derive(Debug, Deserialize)]
pub struct MouseClickPayload {
    /// "left" | "right" | "middle" (default left)
    pub button: Option<String>,
    /// optional absolute position to move to before clicking
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub double: Option<bool>,
}

fn validate_mouse_click(payload: &MouseClickPayload) -> Result<Button, String> {
    match (payload.x, payload.y) {
        (Some(x), Some(y)) => validate_coordinates(x, y)?,
        (None, None) => {}
        _ => return Err("x and y must be supplied together.".into()),
    }
    match payload.button.as_deref().unwrap_or("left") {
        "left" => Ok(Button::Left),
        "right" => Ok(Button::Right),
        "middle" => Ok(Button::Middle),
        _ => Err("Mouse button must be left, right or middle.".into()),
    }
}

#[tauri::command]
pub async fn mouse_click(
    window: crate::commands::CallerWebview,
    payload: InputPayload<MouseClickPayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || mouse_click_bound(payload))
        .await
        .map_err(|_| "desktop_control_worker_failed")?
}

fn mouse_click_bound(payload: InputPayload<MouseClickPayload>) -> Result<(), String> {
    let guard = DesktopActionGuard::acquire(&payload.execution, &payload.observation_id)?;
    let payload = payload.request;
    // Validate the complete request before constructing an input session or moving.
    let button = validate_mouse_click(&payload)?;
    if let Some((x, y)) = payload.x.zip(payload.y) {
        guard.show_point(x, y)?;
    }
    #[cfg(windows)]
    if guard.isolated() {
        guard.show_keyboard()?;
        return super::desktop_window_input::click(
            &guard,
            payload.button.as_deref().unwrap_or("left"),
            payload.double.unwrap_or(false),
        );
    }
    #[cfg(target_os = "linux")]
    if super::desktop_linux::is_wayland() {
        let (x, y) = payload
            .x
            .zip(payload.y)
            .ok_or("desktop_wayland_click_requires_observed_coordinates")?;
        return super::desktop_accessibility::portal::click(
            &guard,
            x,
            y,
            button,
            payload.double.unwrap_or(false),
        );
    }
    let mut enigo = new_enigo()?;
    if let (Some(x), Some(y)) = (payload.x, payload.y) {
        guard.point(x, y)?;
        move_pointer(x, y)?;
    }
    let times = if payload.double.unwrap_or(false) {
        2
    } else {
        1
    };
    for _ in 0..times {
        guard.current_point()?;
        enigo
            .button(button, Direction::Click)
            .map_err(|e| format!("click failed: {e}"))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct TypeTextPayload {
    pub text: String,
}

#[tauri::command]
pub async fn type_text(
    window: crate::commands::CallerWebview,
    payload: InputPayload<TypeTextPayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || type_text_bound(payload))
        .await
        .map_err(|_| "desktop_control_worker_failed")?
}

fn type_text_bound(payload: InputPayload<TypeTextPayload>) -> Result<(), String> {
    let guard = DesktopActionGuard::acquire(&payload.execution, &payload.observation_id)?;
    let payload = payload.request;
    if payload.text.is_empty() {
        return Err("Empty text".into());
    }
    // Mirror the server-side DeviceToolPolicy cap so a runaway/injected request
    // cannot inject an unbounded keystroke stream.
    if payload.text.chars().count() > 10_000 {
        return Err("Text too long".into());
    }
    guard.show_keyboard()?;
    #[cfg(windows)]
    if guard.isolated() {
        return super::desktop_window_input::text(&guard, &payload.text);
    }
    #[cfg(target_os = "linux")]
    if super::desktop_linux::is_wayland() {
        for character in payload.text.chars() {
            super::desktop_accessibility::portal::press(
                &guard,
                match character {
                    '\n' => Key::Return,
                    '\t' => Key::Tab,
                    c => Key::Unicode(c),
                },
                &[],
            )?;
        }
        return Ok(());
    }
    let mut enigo = new_enigo()?;
    for character in payload.text.chars() {
        guard.check()?;
        enigo
            .text(&character.to_string())
            .map_err(|e| format!("type_text failed: {e}"))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct PressKeyPayload {
    /// e.g. "enter", "tab", "escape", "space", "backspace", "delete",
    /// "up", "down", "left", "right", or a single character.
    pub key: String,
}

fn parse_key(name: &str) -> Result<Key, String> {
    if name.chars().any(char::is_control) {
        return Err("Key must not contain control characters.".into());
    }
    let k = name.trim().to_lowercase();
    Ok(match k.as_str() {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        other => {
            let mut chars = other.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => Key::Unicode(c),
                _ => return Err(format!("Unknown key: {name}")),
            }
        }
    })
}

#[tauri::command]
pub async fn press_key(
    window: crate::commands::CallerWebview,
    payload: InputPayload<PressKeyPayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || press_key_bound(payload))
        .await
        .map_err(|_| "desktop_control_worker_failed")?
}

fn press_key_bound(payload: InputPayload<PressKeyPayload>) -> Result<(), String> {
    let guard = DesktopActionGuard::acquire(&payload.execution, &payload.observation_id)?;
    let payload = payload.request;
    let key = parse_key(&payload.key)?;
    guard.show_keyboard()?;
    #[cfg(windows)]
    if guard.isolated() {
        return super::desktop_window_input::key(&guard, &payload.key, &[]);
    }
    #[cfg(target_os = "linux")]
    if super::desktop_linux::is_wayland() {
        return super::desktop_accessibility::portal::press(&guard, key, &[]);
    }
    let mut enigo = new_enigo()?;
    guard.check()?;
    enigo
        .key(key, Direction::Click)
        .map_err(|e| format!("press_key failed: {e}"))
}

const MAX_SCROLL_AMOUNT: i32 = 100;
const MAX_HOTKEY_MODIFIERS: usize = 4;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollPayload {
    /// Signed number of scroll steps. Positive/negative direction follows the
    /// platform convention exposed by Enigo.
    pub amount: i32,
    /// "vertical" (default) or "horizontal".
    pub axis: Option<String>,
}

fn validate_scroll_amount(amount: i32) -> Result<i32, String> {
    if amount == 0 || amount.unsigned_abs() > MAX_SCROLL_AMOUNT as u32 {
        Err(format!(
            "Scroll amount must be between -{MAX_SCROLL_AMOUNT} and {MAX_SCROLL_AMOUNT}, excluding zero."
        ))
    } else {
        Ok(amount)
    }
}

fn parse_scroll_axis(value: Option<&str>) -> Result<Axis, String> {
    match value
        .unwrap_or("vertical")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "vertical" | "v" => Ok(Axis::Vertical),
        "horizontal" | "h" => Ok(Axis::Horizontal),
        _ => Err("Scroll axis must be vertical or horizontal.".into()),
    }
}

#[tauri::command]
pub async fn scroll(
    window: crate::commands::CallerWebview,
    payload: InputPayload<ScrollPayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || scroll_bound(payload))
        .await
        .map_err(|_| "desktop_control_worker_failed")?
}

fn scroll_bound(payload: InputPayload<ScrollPayload>) -> Result<(), String> {
    let guard = DesktopActionGuard::acquire(&payload.execution, &payload.observation_id)?;
    let payload = payload.request;
    let amount = validate_scroll_amount(payload.amount)?;
    let axis = parse_scroll_axis(payload.axis.as_deref())?;
    guard.show_keyboard()?;
    #[cfg(windows)]
    if guard.isolated() {
        return super::desktop_window_input::scroll(
            &guard,
            amount,
            matches!(axis, Axis::Horizontal),
        );
    }
    #[cfg(target_os = "linux")]
    if super::desktop_linux::is_wayland() {
        return super::desktop_accessibility::portal::scroll(&guard, amount, axis);
    }
    let mut enigo = new_enigo()?;
    guard.current_point()?;
    enigo
        .scroll(amount, axis)
        .map_err(|e| format!("scroll failed: {e}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyPayload {
    /// One to four unique modifiers: control, alt, shift, meta/windows.
    pub modifiers: Vec<String>,
    /// One safe named key accepted by press_key, or a single character.
    pub key: String,
}

fn parse_modifier(name: &str) -> Result<(&'static str, Key), String> {
    match name.trim().to_ascii_lowercase().as_str() {
        "control" | "ctrl" => Ok(("control", Key::Control)),
        "alt" | "option" => Ok(("alt", Key::Alt)),
        "shift" => Ok(("shift", Key::Shift)),
        "meta" | "super" | "windows" | "win" | "command" | "cmd" => Ok(("meta", Key::Meta)),
        _ => Err(format!("Unsupported hotkey modifier: {name}")),
    }
}

fn parse_hotkey_modifiers(values: &[String]) -> Result<Vec<Key>, String> {
    if values.is_empty() || values.len() > MAX_HOTKEY_MODIFIERS {
        return Err(format!(
            "A hotkey requires one to {MAX_HOTKEY_MODIFIERS} modifiers."
        ));
    }
    let mut names = Vec::new();
    let mut keys = Vec::new();
    for value in values {
        let (name, key) = parse_modifier(value)?;
        if names.contains(&name) {
            return Err(format!("Duplicate hotkey modifier: {name}"));
        }
        names.push(name);
        keys.push(key);
    }
    Ok(keys)
}

#[tauri::command]
pub async fn hotkey(
    window: crate::commands::CallerWebview,
    payload: InputPayload<HotkeyPayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || hotkey_bound(payload))
        .await
        .map_err(|_| "desktop_control_worker_failed")?
}

fn hotkey_bound(payload: InputPayload<HotkeyPayload>) -> Result<(), String> {
    let guard = DesktopActionGuard::acquire(&payload.execution, &payload.observation_id)?;
    let payload = payload.request;
    let modifiers = parse_hotkey_modifiers(&payload.modifiers)?;
    let key = parse_key(&payload.key)?;
    guard.show_keyboard()?;
    #[cfg(windows)]
    if guard.isolated() {
        return super::desktop_window_input::key(&guard, &payload.key, &payload.modifiers);
    }
    #[cfg(target_os = "linux")]
    if super::desktop_linux::is_wayland() {
        return super::desktop_accessibility::portal::press(&guard, key, &modifiers);
    }
    let mut enigo = new_enigo()?;
    let mut pressed = Vec::new();
    for modifier in &modifiers {
        if let Err(error) = guard.check() {
            for pressed_key in pressed.iter().rev() {
                let _ = enigo.key(*pressed_key, Direction::Release);
            }
            return Err(error);
        }
        if let Err(error) = enigo.key(*modifier, Direction::Press) {
            for pressed_key in pressed.iter().rev() {
                let _ = enigo.key(*pressed_key, Direction::Release);
            }
            return Err(format!("hotkey modifier press failed: {error}"));
        }
        pressed.push(*modifier);
    }

    let click_result = guard.check().and_then(|()| {
        enigo
            .key(key, Direction::Click)
            .map_err(|error| error.to_string())
    });
    let mut release_error = None;
    for modifier in pressed.iter().rev() {
        if let Err(error) = enigo.key(*modifier, Direction::Release) {
            release_error.get_or_insert_with(|| error.to_string());
        }
    }
    click_result.map_err(|error| format!("hotkey key press failed: {error}"))?;
    if let Some(error) = release_error {
        return Err(format!("hotkey modifier release failed: {error}"));
    }
    Ok(())
}

/* =========================================================
 * Browser
 * ========================================================= */

#[derive(Debug, Deserialize)]
pub struct OpenUrlPayload {
    pub url: String,
}

#[tauri::command]
pub async fn open_url(
    window: crate::commands::CallerWebview,
    payload: Guarded<OpenUrlPayload>,
) -> Result<(), String> {
    // Both trusted local chat surfaces can open a user-clicked HTTP(S) link.
    if window.label() != super::mini_chat::MINI_LABEL {
        ensure_main_webview(&window)?;
    }
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
    let url = payload.url.trim();
    if super::desktop_control::isolated() {
        return Err(
            "desktop_control_external_browser_launch_uses_system_focus_use_browser_open".into(),
        );
    }
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || url.chars().any(char::is_control)
    {
        return Err("Only valid http(s) URLs may be opened.".into());
    }
    gate.check()?;
    webbrowser::open(url).map_err(|error| format!("open_url failed: {error}"))?;
    Ok(())
}

/// Explicit user navigation from rendered messages; never registered as an agent tool.
#[tauri::command]
pub async fn open_user_link(
    window: crate::commands::CallerWebview,
    payload: OpenUrlPayload,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let url = reqwest::Url::parse(payload.url.trim()).map_err(|_| "Invalid link URL.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || payload.url.chars().any(char::is_control)
    {
        return Err("Only HTTP(S) user links may be opened.".into());
    }
    webbrowser::open(url.as_str()).map_err(|_| "User link could not be opened.".into())
}

#[cfg(test)]
mod tests {
    use super::{
        parse_hotkey_modifiers, parse_key, parse_scroll_axis, place_physical_pointer,
        select_monitor_index, validate_coordinates, validate_mouse_click, validate_scroll_amount,
        MonitorInfo, MouseClickPayload, WindowInfo, MAX_SCROLL_AMOUNT,
    };
    use enigo::{Axis, Button, Key};
    use std::collections::{HashMap, HashSet};

    fn process_fixture(
        parent: Option<u32>,
        started_at: u64,
        cpu: f32,
        ram_bytes: u64,
    ) -> super::ProcessSample {
        super::ProcessSample {
            parent,
            started_at,
            cpu,
            ram_bytes,
        }
    }

    #[test]
    fn telemetry_splits_the_real_process_trees_and_excludes_unrelated_processes() {
        let processes = HashMap::from([
            (10, process_fixture(None, 100, 100.0, 100)),
            (11, process_fixture(Some(10), 101, 50.0, 200)),
            (12, process_fixture(Some(11), 102, 25.0, 100)),
            (20, process_fixture(Some(10), 110, 300.0, 400)),
            (21, process_fixture(Some(20), 111, 100.0, 200)),
            // An unrelated runtime is never selected by its executable name.
            (30, process_fixture(None, 100, 800.0, 900)),
            (31, process_fixture(Some(30), 101, 100.0, 100)),
        ]);
        let scopes = super::select_process_scopes(&processes, 10, Ok(Some(20)));
        assert_eq!(scopes.app, Some(HashSet::from([10, 11, 12])));
        assert_eq!(scopes.model, Some(HashSet::from([20, 21])));
        assert_eq!(scopes.model_running, Some(true));
        let app =
            super::scoped_process_metrics(scopes.app.as_ref(), &processes, &processes, 8, 2000);
        let model =
            super::scoped_process_metrics(scopes.model.as_ref(), &processes, &processes, 8, 2000);
        assert_eq!(app.cpu, Some(21.875));
        assert_eq!(app.ram, Some(20.0));
        assert_eq!(app.ram_bytes, Some(400));
        assert_eq!(model.cpu, Some(50.0));
        assert_eq!(model.ram, Some(30.0));
    }

    #[test]
    fn telemetry_preserves_stopped_versus_unknown_model_identity() {
        let processes = HashMap::from([(10, process_fixture(None, 100, 0.0, 100))]);
        let stopped = super::select_process_scopes(&processes, 10, Ok(None));
        assert_eq!(stopped.app, Some(HashSet::from([10])));
        assert_eq!(stopped.model_running, Some(false));
        assert!(stopped.model.is_none());
        let unknown = super::select_process_scopes(&processes, 10, Err(()));
        assert!(unknown.app.is_none());
        assert!(unknown.model.is_none());
        assert_eq!(unknown.model_running, None);
        let unreadable_model = super::select_process_scopes(&processes, 10, Ok(Some(20)));
        assert!(unreadable_model.app.is_none());
        assert!(unreadable_model.model.is_none());
        assert_eq!(unreadable_model.model_running, Some(true));
    }

    #[test]
    fn telemetry_ignores_recycled_parent_ids_and_terminates_cycles() {
        let processes = HashMap::from([
            (10, process_fixture(None, 100, 0.0, 100)),
            (11, process_fixture(Some(10), 90, 0.0, 100)),
            (12, process_fixture(Some(11), 91, 0.0, 100)),
            (13, process_fixture(Some(10), 101, 0.0, 100)),
            (14, process_fixture(Some(15), 102, 0.0, 100)),
            (15, process_fixture(Some(14), 102, 0.0, 100)),
        ]);
        assert_eq!(
            super::process_tree(&processes, 10),
            Some(HashSet::from([10, 13]))
        );
        assert_eq!(
            super::process_tree(&processes, 14),
            Some(HashSet::from([14, 15]))
        );
        assert!(super::process_tree(&processes, 99).is_none());
    }

    #[test]
    fn telemetry_requires_a_cpu_baseline_for_every_current_process() {
        let before = HashMap::from([(10, process_fixture(None, 100, 0.0, 100))]);
        let mut after = before.clone();
        after.insert(11, process_fixture(Some(10), 101, 300.0, 100));
        let selected = HashSet::from([10, 11]);
        let result = super::scoped_process_metrics(Some(&selected), &before, &after, 8, 1000);
        assert!(result.cpu.is_none());
        assert_eq!(result.ram, Some(20.0));
        // Reused PIDs must not inherit a previous process's CPU denominator.
        after.get_mut(&10).unwrap().started_at = 200;
        let result =
            super::scoped_process_metrics(Some(&HashSet::from([10])), &before, &after, 8, 1000);
        assert!(result.cpu.is_none());
    }

    #[test]
    fn telemetry_handles_zero_and_invalid_scope_measurements_without_fake_values() {
        let selected = HashSet::from([10]);
        let mut processes = HashMap::from([(10, process_fixture(None, 100, 0.0, 100))]);
        let result =
            super::scoped_process_metrics(Some(&selected), &processes, &processes, 8, 1000);
        assert_eq!(result.cpu, Some(0.0));
        assert_eq!(result.ram, Some(10.0));
        for invalid in [f32::NAN, f32::INFINITY, -1.0] {
            processes.get_mut(&10).unwrap().cpu = invalid;
            assert!(super::scoped_process_metrics(
                Some(&selected),
                &processes,
                &processes,
                8,
                1000
            )
            .cpu
            .is_none());
        }
        processes.get_mut(&10).unwrap().cpu = 900.0;
        assert_eq!(
            super::scoped_process_metrics(Some(&selected), &processes, &processes, 8, 1000).cpu,
            Some(100.0)
        );
        let invalid_denominators =
            super::scoped_process_metrics(Some(&selected), &processes, &processes, 0, 0);
        assert!(invalid_denominators.cpu.is_none());
        assert!(invalid_denominators.ram.is_none());
        processes.get_mut(&10).unwrap().ram_bytes = 0;
        assert!(
            super::scoped_process_metrics(Some(&selected), &processes, &processes, 8, 1000)
                .ram_bytes
                .is_none()
        );
        assert!(
            super::scoped_process_metrics(None, &processes, &processes, 8, 1000)
                .cpu
                .is_none()
        );
    }

    #[test]
    fn temperature_labels_never_treat_an_unrelated_thermal_zone_as_cpu() {
        assert!(super::is_cpu_component("cpu package"));
        assert!(super::is_cpu_component("k10temp tdie"));
        assert!(super::is_gpu_component("nvidia geforce gpu"));
        assert!(!super::is_cpu_component("acpi thermal zone"));
        assert!(!super::is_gpu_component("acpi thermal zone"));
    }

    #[test]
    #[ignore = "read-only hardware smoke; run explicitly, starts no model"]
    fn native_system_scope_metrics_smoke() {
        let metrics =
            super::collect_system_metrics().expect("collect bounded device/process telemetry");
        assert!(metrics.cpu_percent.is_finite());
        assert!(metrics.app_cpu_percent.is_some());
        assert!(metrics.app_ram_used_mb.is_some_and(|mb| mb > 0));
        assert_eq!(metrics.model_running, Some(false));
        assert!(metrics.model_cpu_percent.is_none());
        println!(
            "cpu={}, app_cpu={:?}, ram={}, app_ram={:?}, gpu={:?}, app_gpu={:?}, gpu_source={}",
            metrics.cpu_percent,
            metrics.app_cpu_percent,
            metrics.ram_percent,
            metrics.app_ram_percent,
            metrics.gpu_percent,
            metrics.app_gpu_percent,
            metrics.gpu_source
        );
    }

    fn monitor_fixture(id: u32, primary: bool, x: i32) -> MonitorInfo {
        MonitorInfo {
            id,
            name: format!("Display {id}"),
            x,
            y: 0,
            width: 1920,
            height: 1080,
            scale_factor: 1.25,
            primary,
        }
    }

    #[test]
    fn capture_selects_real_primary_or_exact_monitor_and_never_falls_back() {
        let monitors = [
            monitor_fixture(7, false, -1920),
            monitor_fixture(9, true, 0),
        ];
        assert_eq!(select_monitor_index(&monitors, None).unwrap(), 1);
        assert_eq!(select_monitor_index(&monitors, Some(7)).unwrap(), 0);
        assert!(select_monitor_index(&monitors, Some(99)).is_err());
        assert!(select_monitor_index(&monitors[..1], None).is_err());
        assert!(select_monitor_index(&[], None).is_err());
        let value = serde_json::to_value(&monitors[0]).unwrap();
        assert_eq!(value["x"], -1920);
        assert_eq!(value["scale_factor"], 1.25);
    }

    #[test]
    fn pointer_adapter_preserves_secondary_pixels_and_rejects_offscreen_targets_before_input() {
        let monitors = [
            monitor_fixture(7, false, -1920),
            monitor_fixture(9, true, 0),
        ];
        let placed = std::cell::Cell::new(None);
        place_physical_pointer(
            -1200,
            60,
            &monitors,
            |x, y| {
                placed.set(Some((x, y)));
                Ok(())
            },
            || Ok((-1200, 60)),
        )
        .unwrap();
        assert_eq!(placed.get(), Some((-1200, 60)));
        let result = place_physical_pointer(
            1920,
            60,
            &monitors,
            |_, _| panic!("offscreen input"),
            || panic!("offscreen read"),
        );
        assert!(result.unwrap_err().contains("outside"));
    }

    #[test]
    fn pointer_failure_and_position_mismatch_prevent_the_click_path() {
        let monitors = [monitor_fixture(9, true, 0)];
        let result = place_physical_pointer(
            120,
            60,
            &monitors,
            |_, _| Err("access denied".into()),
            || panic!("read after failed move"),
        );
        assert_eq!(result.unwrap_err(), "access denied");
        let result = place_physical_pointer(120, 60, &monitors, |_, _| Ok(()), || Ok((100, 60)));
        assert!(result.unwrap_err().contains("no click"));
        let result = place_physical_pointer(
            120,
            60,
            &monitors,
            |_, _| Ok(()),
            || Err("read failed".into()),
        );
        assert_eq!(result.unwrap_err(), "read failed");
    }

    #[test]
    #[ignore = "read-only smoke requires an interactive desktop; run explicitly"]
    fn native_monitor_geometry_smoke() {
        let monitors = xcap::Monitor::all().expect("enumerate monitors");
        let infos: Vec<_> = monitors
            .iter()
            .map(super::monitor_info)
            .collect::<Result<_, _>>()
            .expect("native monitor metadata");
        assert!(!infos.is_empty());
        assert_eq!(infos.iter().filter(|monitor| monitor.primary).count(), 1);
        let primary = &infos[select_monitor_index(&infos, None).unwrap()];
        println!(
            "monitors={}, primary_id={}, primary_bounds=({}, {}, {}, {}), primary_scale={}",
            infos.len(),
            primary.id,
            primary.x,
            primary.y,
            primary.width,
            primary.height,
            primary.scale_factor
        );
        let windows = xcap::Window::all().expect("enumerate windows");
        let mut geometry_count = 0;
        for window in windows {
            // Do not read or print application names or window titles.
            if let (Ok(x), Ok(y), Ok(width), Ok(height)) =
                (window.x(), window.y(), window.width(), window.height())
            {
                assert!(i64::from(x) + i64::from(width) <= i64::from(i32::MAX));
                assert!(i64::from(y) + i64::from(height) <= i64::from(i32::MAX));
                geometry_count += 1;
            }
        }
        assert!(geometry_count > 0);
        println!("readable_window_geometries={geometry_count}; no screenshot or input performed");
    }

    #[test]
    fn click_rejects_invalid_buttons_or_incomplete_coordinates_before_input() {
        let mut payload = MouseClickPayload {
            button: None,
            x: None,
            y: None,
            double: None,
        };
        assert_eq!(validate_mouse_click(&payload).unwrap(), Button::Left);
        payload.button = Some("unknown".into());
        assert!(validate_mouse_click(&payload).is_err());
        payload.button = Some("right".into());
        payload.x = Some(-120);
        assert!(validate_mouse_click(&payload).is_err());
        payload.y = Some(50);
        assert_eq!(validate_mouse_click(&payload).unwrap(), Button::Right);
        payload.x = Some(i32::MIN);
        assert!(validate_mouse_click(&payload).is_err());
        assert!(validate_coordinates(0, 100_001).is_err());
    }

    #[test]
    fn window_snapshot_serializes_the_real_focus_field() {
        let window = WindowInfo {
            id: 42,
            title: "Editor".into(),
            app_name: "Code".into(),
            x: -1920,
            y: 40,
            width: 1200,
            height: 800,
            focused: true,
            minimized: false,
        };
        let value = serde_json::to_value(window).expect("serialize window info");
        assert_eq!(value["focused"], true);
        assert_eq!(value["x"], -1920);
        assert_eq!(value["id"], 42);
        assert_eq!(value["minimized"], false);
    }

    #[test]
    fn scroll_is_bounded_and_axis_is_closed() {
        assert_eq!(validate_scroll_amount(1).unwrap(), 1);
        assert_eq!(validate_scroll_amount(-MAX_SCROLL_AMOUNT).unwrap(), -100);
        assert!(validate_scroll_amount(0).is_err());
        assert!(validate_scroll_amount(MAX_SCROLL_AMOUNT + 1).is_err());
        assert_eq!(parse_scroll_axis(None).unwrap(), Axis::Vertical);
        assert_eq!(
            parse_scroll_axis(Some("horizontal")).unwrap(),
            Axis::Horizontal
        );
        assert!(parse_scroll_axis(Some("diagonal")).is_err());
    }

    #[test]
    fn hotkey_modifiers_are_allowlisted_unique_and_bounded() {
        let modifiers = parse_hotkey_modifiers(&["ctrl".into(), "shift".into()]).unwrap();
        assert_eq!(modifiers, vec![Key::Control, Key::Shift]);
        assert!(parse_hotkey_modifiers(&[]).is_err());
        assert!(parse_hotkey_modifiers(&["ctrl".into(), "control".into()]).is_err());
        assert!(parse_hotkey_modifiers(&["hyper".into()]).is_err());
        assert_eq!(parse_key("s").unwrap(), Key::Unicode('s'));
        assert!(parse_key("\0").is_err());
        assert!(parse_key("launch calculator").is_err());
    }
}
