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
use serde::{Deserialize, Serialize};

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
        let title = w.title().to_string();
        if title.trim().is_empty() {
            continue;
        }
        out.push(WindowInfo {
            title,
            app_name: w.app_name().to_string(),
            width: w.width(),
            height: w.height(),
        });
    }
    Ok(out)
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
 * Apps / shell
 * ========================================================= */

#[derive(Debug, Deserialize)]
pub struct OpenPathPayload {
    /// A file path, folder, URL, or app that the OS knows how to open.
    pub target: String,
}

/// Open a path/URL with the OS default handler (Windows: `cmd /C start`).
#[tauri::command]
pub async fn open_path(payload: OpenPathPayload) -> Result<(), String> {
    let target = payload.target.trim();
    if target.is_empty() {
        return Err("Empty target".into());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", target])
            .spawn()
            .map_err(|e| format!("open_path failed: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("open_path failed: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("open_path failed: {e}"))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct RunCommandPayload {
    /// Program name. Only allow-listed programs are permitted.
    pub program: String,
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct RunCommandResult {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// A conservative allow-list of programs the assistant may run.
const ALLOWED_PROGRAMS: &[&str] = &[
    "notepad", "calc", "explorer", "mspaint", "cmd", "powershell", "where", "whoami", "hostname",
    "ipconfig", "tasklist",
];

#[tauri::command]
pub async fn run_command(payload: RunCommandPayload) -> Result<RunCommandResult, String> {
    let program = payload.program.trim().to_lowercase();
    let base = program.trim_end_matches(".exe");
    if !ALLOWED_PROGRAMS.contains(&base) {
        return Err(format!(
            "Programm '{program}' ist nicht in der Allow-Liste. Erlaubt: {}",
            ALLOWED_PROGRAMS.join(", ")
        ));
    }

    let output = std::process::Command::new(&program)
        .args(payload.args.unwrap_or_default())
        .output()
        .map_err(|e| format!("run_command failed: {e}"))?;

    Ok(RunCommandResult {
        ok: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}
