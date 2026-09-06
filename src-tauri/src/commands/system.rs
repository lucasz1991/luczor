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
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::{Components, System, MINIMUM_CPU_UPDATE_INTERVAL};
use tauri::WebviewWindow;

use super::desktop_target::{DesktopActionGuard, DesktopObservation, InputPayload, ObservePayload};
use super::ensure_main_webview;
use super::execution::{admit, Guarded};

#[tauri::command]
pub async fn desktop_observe(
    window: WebviewWindow,
    payload: ObservePayload,
) -> Result<DesktopObservation, String> {
    ensure_main_webview(&window)?;
    super::desktop_target::observe(payload)
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

fn monitor_info(monitor: &xcap::Monitor) -> Result<MonitorInfo, String> {
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
pub async fn list_monitors(window: WebviewWindow) -> Result<Vec<MonitorInfo>, String> {
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
    window: WebviewWindow,
    payload: Option<ScreenCapturePayload>,
) -> Result<ScreenCapture, String> {
    ensure_main_webview(&window)?;
    let monitors = xcap::Monitor::all().map_err(|e| format!("Monitor::all failed: {e}"))?;
    let infos: Vec<_> = monitors
        .iter()
        .map(monitor_info)
        .collect::<Result<_, _>>()?;
    let index = select_monitor_index(&infos, payload.and_then(|payload| payload.monitor_id))?;
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
pub async fn read_clipboard(window: WebviewWindow) -> Result<String, String> {
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
pub async fn list_windows(window: WebviewWindow) -> Result<Vec<WindowInfo>, String> {
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

#[derive(Debug, Serialize, Clone)]
pub struct SystemMetrics {
    pub cpu_percent: f32,
    pub ram_percent: f32,
    pub ram_used_mb: u64,
    pub ram_total_mb: u64,
    pub gpu_percent: Option<f32>,
    pub cpu_temp_c: Option<f32>,
    pub gpu_temp_c: Option<f32>,
}

static METRICS_CACHE: OnceLock<Mutex<Option<(Instant, SystemMetrics)>>> = OnceLock::new();

#[tauri::command]
pub async fn system_metrics(window: WebviewWindow) -> Result<SystemMetrics, String> {
    ensure_main_webview(&window)?;
    let cache = METRICS_CACHE.get_or_init(|| Mutex::new(None));
    if let Some((updated_at, metrics)) = cache
        .lock()
        .map_err(|_| "System metrics cache unavailable")?
        .as_ref()
    {
        if updated_at.elapsed() < Duration::from_secs(2) {
            return Ok(metrics.clone());
        }
    }

    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_usage();
    std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_cpu_usage();

    let total_memory = system.total_memory();
    let used_memory = system.used_memory();
    let ram_percent = if total_memory > 0 {
        (used_memory as f32 / total_memory as f32) * 100.0
    } else {
        0.0
    };

    let (cpu_temp_c, sensor_gpu_temp_c) = component_temperatures();
    let (gpu_percent, nvml_gpu_temp_c) = gpu_telemetry();

    let metrics = SystemMetrics {
        cpu_percent: clamp_percent(system.global_cpu_usage()),
        ram_percent: clamp_percent(ram_percent),
        ram_used_mb: used_memory / 1024 / 1024,
        ram_total_mb: total_memory / 1024 / 1024,
        gpu_percent: gpu_percent.map(clamp_percent),
        cpu_temp_c,
        gpu_temp_c: nvml_gpu_temp_c.or(sensor_gpu_temp_c),
    };
    *cache
        .lock()
        .map_err(|_| "System metrics cache unavailable")? = Some((Instant::now(), metrics.clone()));
    Ok(metrics)
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

fn component_temperatures() -> (Option<f32>, Option<f32>) {
    let components = Components::new_with_refreshed_list();
    let mut cpu_temp = None;
    let mut gpu_temp = None;
    let mut fallback_temp = None;

    for component in &components {
        let Some(temp) = clean_temp(component.temperature()) else {
            continue;
        };

        let label = component.label().to_lowercase();
        fallback_temp = hotter(fallback_temp, temp);

        if label.contains("gpu")
            || label.contains("nvidia")
            || label.contains("geforce")
            || label.contains("radeon")
            || label.contains("amd graphics")
        {
            gpu_temp = hotter(gpu_temp, temp);
        } else if label.contains("cpu")
            || label.contains("package")
            || label.contains("core")
            || label.contains("tctl")
            || label.contains("tdie")
        {
            cpu_temp = hotter(cpu_temp, temp);
        }
    }

    (cpu_temp.or(fallback_temp), gpu_temp)
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
    window: WebviewWindow,
    payload: InputPayload<MoveMousePayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let guard = DesktopActionGuard::acquire(&payload.execution, &payload.observation_id)?;
    let payload = payload.request;
    validate_coordinates(payload.x, payload.y)?;
    guard.point(payload.x, payload.y)?;
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
    window: WebviewWindow,
    payload: InputPayload<MouseClickPayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let guard = DesktopActionGuard::acquire(&payload.execution, &payload.observation_id)?;
    let payload = payload.request;
    // Validate the complete request before constructing an input session or moving.
    let button = validate_mouse_click(&payload)?;
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
    window: WebviewWindow,
    payload: InputPayload<TypeTextPayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
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
    window: WebviewWindow,
    payload: InputPayload<PressKeyPayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let guard = DesktopActionGuard::acquire(&payload.execution, &payload.observation_id)?;
    let payload = payload.request;
    let key = parse_key(&payload.key)?;
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
    window: WebviewWindow,
    payload: InputPayload<ScrollPayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let guard = DesktopActionGuard::acquire(&payload.execution, &payload.observation_id)?;
    let payload = payload.request;
    let amount = validate_scroll_amount(payload.amount)?;
    let axis = parse_scroll_axis(payload.axis.as_deref())?;
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
    window: WebviewWindow,
    payload: InputPayload<HotkeyPayload>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let guard = DesktopActionGuard::acquire(&payload.execution, &payload.observation_id)?;
    let payload = payload.request;
    let modifiers = parse_hotkey_modifiers(&payload.modifiers)?;
    let key = parse_key(&payload.key)?;
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
    window: WebviewWindow,
    payload: Guarded<OpenUrlPayload>,
) -> Result<(), String> {
    // Both trusted local chat surfaces can open a user-clicked HTTP(S) link.
    if window.label() != super::mini_chat::MINI_LABEL {
        ensure_main_webview(&window)?;
    }
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
    let url = payload.url.trim();
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
pub async fn open_user_link(window: WebviewWindow, payload: OpenUrlPayload) -> Result<(), String> {
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
