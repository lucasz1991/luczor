// src-tauri/src/commands/system.rs
//
// OS perception + control commands for Luczor.
//
// SAFETY: These are powerful. The frontend only ever calls them through the
// tool registry, which enforces the observe/act mode, the global kill switch,
// and per-call user approval. Nothing here bypasses that gate.

use base64::Engine;
use enigo::{
    Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings,
};
use nvml_wrapper::{enum_wrappers::device::TemperatureSensor, Nvml};
use serde::{Deserialize, Serialize};
use sysinfo::{Components, System, MINIMUM_CPU_UPDATE_INTERVAL};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/* =========================================================
 * Perception
 * ========================================================= */

#[derive(Debug, Serialize)]
pub struct ScreenCapture {
    pub base64: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

/// Capture the primary monitor as a PNG (base64).
#[tauri::command]
pub async fn capture_screen() -> Result<ScreenCapture, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("Monitor::all failed: {e}"))?;
    let monitor = monitors
        .into_iter()
        .next()
        .ok_or_else(|| "No monitor found".to_string())?;

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
    })
}

/// Read the system clipboard (text).
#[tauri::command]
pub async fn read_clipboard() -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("Clipboard init failed: {e}"))?;
    cb.get_text().map_err(|e| format!("Clipboard read failed: {e}"))
}

#[derive(Debug, Serialize)]
pub struct WindowInfo {
    pub title: String,
    pub app_name: String,
    pub width: u32,
    pub height: u32,
}

/// List visible windows (title + owning app). Read-only perception.
#[tauri::command]
pub async fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let windows = xcap::Window::all().map_err(|e| format!("Window::all failed: {e}"))?;
    let mut out = Vec::new();
    for w in windows {
        let title = w.title().map_err(|e| format!("Window::title failed: {e}"))?;
        if title.trim().is_empty() {
            continue;
        }
        out.push(WindowInfo {
            title,
            app_name: w
                .app_name()
                .map_err(|e| format!("Window::app_name failed: {e}"))?,
            width: w.width().map_err(|e| format!("Window::width failed: {e}"))?,
            height: w
                .height()
                .map_err(|e| format!("Window::height failed: {e}"))?,
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
pub async fn system_metrics() -> Result<SystemMetrics, String> {
    let cache = METRICS_CACHE.get_or_init(|| Mutex::new(None));
    if let Some((updated_at, metrics)) = cache.lock().map_err(|_| "System metrics cache unavailable" )?.as_ref() {
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
    *cache.lock().map_err(|_| "System metrics cache unavailable" )? = Some((Instant::now(), metrics.clone()));
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

#[tauri::command]
pub async fn move_mouse(payload: MoveMousePayload) -> Result<(), String> {
    let mut enigo = new_enigo()?;
    enigo
        .move_mouse(payload.x, payload.y, Coordinate::Abs)
        .map_err(|e| format!("move_mouse failed: {e}"))
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

#[tauri::command]
pub async fn mouse_click(payload: MouseClickPayload) -> Result<(), String> {
    let mut enigo = new_enigo()?;
    if let (Some(x), Some(y)) = (payload.x, payload.y) {
        enigo
            .move_mouse(x, y, Coordinate::Abs)
            .map_err(|e| format!("move failed: {e}"))?;
    }
    let button = match payload.button.as_deref() {
        Some("right") => Button::Right,
        Some("middle") => Button::Middle,
        _ => Button::Left,
    };
    let times = if payload.double.unwrap_or(false) { 2 } else { 1 };
    for _ in 0..times {
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
pub async fn type_text(payload: TypeTextPayload) -> Result<(), String> {
    if payload.text.is_empty() {
        return Err("Empty text".into());
    }
    // Mirror the server-side DeviceToolPolicy cap so a runaway/injected request
    // cannot inject an unbounded keystroke stream.
    if payload.text.chars().count() > 10_000 {
        return Err("Text too long".into());
    }
    let mut enigo = new_enigo()?;
    enigo
        .text(&payload.text)
        .map_err(|e| format!("type_text failed: {e}"))
}

#[derive(Debug, Deserialize)]
pub struct PressKeyPayload {
    /// e.g. "enter", "tab", "escape", "space", "backspace", "delete",
    /// "up", "down", "left", "right", or a single character.
    pub key: String,
}

fn parse_key(name: &str) -> Result<Key, String> {
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
pub async fn press_key(payload: PressKeyPayload) -> Result<(), String> {
    let key = parse_key(&payload.key)?;
    let mut enigo = new_enigo()?;
    enigo
        .key(key, Direction::Click)
        .map_err(|e| format!("press_key failed: {e}"))
}

/* =========================================================
 * Browser
 * ========================================================= */

#[derive(Debug, Deserialize)]
pub struct OpenUrlPayload {
    pub url: String,
}

#[tauri::command]
pub async fn open_url(payload: OpenUrlPayload) -> Result<(), String> {
    let url = payload.url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.chars().any(char::is_control) {
        return Err("Only valid http(s) URLs may be opened.".into());
    }
    webbrowser::open(url).map_err(|error| format!("open_url failed: {error}"))?;
    Ok(())
}
