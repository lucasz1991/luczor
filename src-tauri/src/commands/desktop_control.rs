//! Device-local display boundary. Input mode never changes implicitly after a failed action.
use super::desktop_target::WindowTarget;
use super::system::MonitorInfo;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

static CONFIG: OnceLock<Mutex<DesktopControlConfig>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn feedback_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    super::desktop_control_overlay::plugin()
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputMode {
    #[default]
    Isolated,
    Shared,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonitorSelection {
    pub id: u32,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopControlConfig {
    pub revision: u64,
    pub monitor: Option<MonitorSelection>,
    pub input_mode: InputMode,
    pub prefer_internal_browser: bool,
    pub show_cursor: bool,
}

impl Default for DesktopControlConfig {
    fn default() -> Self {
        Self {
            revision: 1,
            monitor: None,
            input_mode: InputMode::Isolated,
            prefer_internal_browser: true,
            show_cursor: true,
        }
    }
}

pub fn initialize(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let config = config_path(app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<DesktopControlConfig>(&bytes).ok())
        .filter(|config| config.revision > 0 && config.revision < 9_007_199_254_740_991)
        .unwrap_or_default();
    CONFIG.get_or_init(|| Mutex::new(config));
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("desktop-control.json"))
        .map_err(|_| "desktop_control_storage_unavailable".into())
}

pub fn config() -> Result<DesktopControlConfig, String> {
    CONFIG
        .get_or_init(|| Mutex::new(DesktopControlConfig::default()))
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "desktop_control_config_unavailable".into())
}

pub fn isolated() -> bool {
    config().map_or(true, |config| config.input_mode == InputMode::Isolated)
}

pub fn stop_feedback() {
    if let Some(app) = APP.get() {
        super::desktop_control_overlay::hide(app);
    }
}

pub fn monitors() -> Result<Vec<MonitorInfo>, String> {
    xcap::Monitor::all()
        .map_err(|_| "desktop_control_monitors_unavailable")?
        .iter()
        .map(super::system::monitor_info)
        .collect()
}

pub fn selected_monitor() -> Result<MonitorInfo, String> {
    let selection = config()?
        .monitor
        .ok_or("desktop_control_monitor_required")?;
    monitors()?
        .into_iter()
        .find(|monitor| monitor.id == selection.id && monitor.name == selection.name)
        .ok_or("desktop_control_monitor_unavailable".into())
}

pub fn contains_rect(monitor: &MonitorInfo, x: i32, y: i32, width: u32, height: u32) -> bool {
    width > 0
        && height > 0
        && x >= monitor.x
        && y >= monitor.y
        && i64::from(x) + i64::from(width) <= i64::from(monitor.x) + i64::from(monitor.width)
        && i64::from(y) + i64::from(height) <= i64::from(monitor.y) + i64::from(monitor.height)
}

pub fn check_target(target: &WindowTarget) -> Result<(), String> {
    let monitor = selected_monitor()?;
    if !contains_rect(&monitor, target.x, target.y, target.width, target.height) {
        return Err("desktop_control_window_outside_selected_monitor".into());
    }
    Ok(())
}

pub fn capture_monitor(requested: Option<u32>) -> Result<u32, String> {
    let selected = selected_monitor()?;
    if requested.is_some_and(|id| id != selected.id) {
        return Err("desktop_control_capture_outside_selected_monitor".into());
    }
    Ok(selected.id)
}

pub fn check_browser_display(app: &AppHandle) -> Result<Option<MonitorInfo>, String> {
    if config()?.monitor.is_none() {
        return Ok(None);
    }
    let monitor = selected_monitor()?;
    let main = app
        .get_window("main")
        .ok_or("browser_panel_main_unavailable")?;
    let origin = main
        .inner_position()
        .map_err(|_| "browser_monitor_position_unavailable")?;
    let (x, y, width, height) = if let Some(browser) = app.get_webview(super::BROWSER_WEBVIEW_LABEL)
    {
        let bounds = browser
            .bounds()
            .map_err(|_| "browser_monitor_position_unavailable")?;
        let scale = main
            .scale_factor()
            .map_err(|_| "browser_monitor_position_unavailable")?;
        let position = bounds.position.to_physical::<i32>(scale);
        let size = bounds.size.to_physical::<u32>(scale);
        (
            origin.x.saturating_add(position.x),
            origin.y.saturating_add(position.y),
            size.width,
            size.height,
        )
    } else {
        let size = main
            .inner_size()
            .map_err(|_| "browser_monitor_position_unavailable")?;
        (origin.x, origin.y, size.width, size.height)
    };
    if !contains_rect(&monitor, x, y, width, height) {
        return Err("browser_outside_selected_monitor_move_luczor_window".into());
    }
    Ok(Some(monitor))
}

pub async fn browser_feedback(
    app: &AppHandle,
    permit: &super::execution::ExecutionPermit,
) -> Result<(), String> {
    if let Some(monitor) = check_browser_display(app)? {
        let app = app.clone();
        let permit = permit.clone();
        let feedback = tauri::async_runtime::spawn_blocking(move || {
            super::desktop_control_overlay::show(&app, &monitor, 0, None, Some(permit))
        })
        .await
        .map_err(|_| "browser_control_feedback_unavailable")?;
        internal_browser_overlay_feedback(feedback)?;
    }
    check_browser_display(app)?;
    Ok(())
}

fn internal_browser_overlay_feedback(result: Result<(), String>) -> Result<(), String> {
    match result {
        // The internal browser has its own DOM cursor and does not use OS input.
        // Wayland's missing monitor overlay must not block that independent route.
        // Display bounds and the execution permit are still checked by the caller.
        Err(error)
            if error == "desktop_control_wayland_overlay_unavailable_use_internal_browser" =>
        {
            Ok(())
        }
        other => other,
    }
}

pub fn activity(
    target: &WindowTarget,
    point: Option<(i32, i32)>,
    execution: Option<&super::execution::ExecutionPermit>,
) -> Result<(), String> {
    let app = APP.get().ok_or("desktop_control_not_initialized")?;
    let monitor = selected_monitor()?;
    let current = config()?;
    super::desktop_control_overlay::show(
        app,
        &monitor,
        target.window_id,
        if current.show_cursor { point } else { None },
        execution.cloned(),
    )
}

#[tauri::command]
pub fn desktop_control_status(window: super::CallerWebview) -> Result<serde_json::Value, String> {
    super::ensure_main_webview(&window)?;
    let config = config()?;
    let monitors = monitors()?;
    let selected = config.monitor.as_ref().is_some_and(|selection| {
        monitors
            .iter()
            .any(|monitor| monitor.id == selection.id && monitor.name == selection.name)
    });
    Ok(
        serde_json::json!({"config":config,"monitors":monitors,"selectedAvailable":selected,
        "isolatedBackend": if cfg!(windows) { "win32_window_messages" } else if cfg!(target_os="linux") { "at_spi" } else { "internal_browser_only" },
        "systemInputIndependent":false,"internalBrowserIndependent":true,
        "guidance":"Interner Browser: eigene DOM-Eingaben. Getrennte Fenstereingaben: unterstützte klassische Windows-Steuerelemente. Systemeingaben teilen Maus und Tastatur mit dem Benutzer; kein automatischer Rückfall."}),
    )
}

#[tauri::command]
pub fn desktop_control_save(
    window: super::CallerWebview,
    app: AppHandle,
    payload: DesktopControlConfig,
) -> Result<DesktopControlConfig, String> {
    super::ensure_main_webview(&window)?;
    let _input = super::desktop_target::lock_input()?;
    if let Some(selection) = &payload.monitor {
        if !monitors()?
            .iter()
            .any(|monitor| monitor.id == selection.id && monitor.name == selection.name)
        {
            return Err("desktop_control_monitor_unavailable".into());
        }
    }
    let mut current = CONFIG
        .get_or_init(|| Mutex::new(DesktopControlConfig::default()))
        .lock()
        .map_err(|_| "desktop_control_config_unavailable")?;
    if current.revision != payload.revision {
        return Err("desktop_control_config_changed".into());
    }
    let next = DesktopControlConfig {
        revision: current
            .revision
            .checked_add(1)
            .ok_or("desktop_control_revision_exhausted")?,
        ..payload
    };
    let path = config_path(&app)?;
    std::fs::create_dir_all(path.parent().ok_or("desktop_control_storage_unavailable")?)
        .map_err(|_| "desktop_control_storage_unavailable")?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec(&next).map_err(|_| "desktop_control_config_invalid")?,
    )
    .map_err(|_| "desktop_control_save_failed")?;
    std::fs::rename(&temporary, &path).map_err(|_| "desktop_control_save_failed")?;
    *current = next.clone();
    drop(current);
    super::desktop_control_overlay::hide(&app);
    Ok(next)
}

#[tauri::command]
pub async fn desktop_control_preview(
    window: super::CallerWebview,
    app: AppHandle,
) -> Result<(), String> {
    super::ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let monitor = selected_monitor()?;
        super::desktop_control_overlay::show(
            &app,
            &monitor,
            0,
            Some((
                monitor.x + (monitor.width / 2) as i32,
                monitor.y + (monitor.height / 2) as i32,
            )),
            None,
        )
    })
    .await
    .map_err(|_| "desktop_control_preview_failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_do_not_bridge_monitors_or_overflow() {
        let monitor = MonitorInfo {
            id: 1,
            name: "test".into(),
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
            scale_factor: 1.5,
            primary: false,
        };
        assert!(contains_rect(&monitor, -1900, 20, 800, 600));
        assert!(!contains_rect(&monitor, -10, 20, 800, 600));
        assert!(!contains_rect(&monitor, -1900, 20, u32::MAX, 600));
        assert!(!contains_rect(&monitor, -1900, 20, 0, 600));
    }
    #[test]
    fn default_never_touches_system_input_or_guesses_a_display() {
        let config = DesktopControlConfig::default();
        assert_eq!(config.input_mode, InputMode::Isolated);
        assert!(config.monitor.is_none());
        assert!(config.prefer_internal_browser && config.show_cursor);
    }

    #[test]
    fn internal_browser_accepts_only_the_unsupported_wayland_overlay() {
        assert!(internal_browser_overlay_feedback(Ok(())).is_ok());
        assert!(internal_browser_overlay_feedback(Err(
            "desktop_control_wayland_overlay_unavailable_use_internal_browser".into()
        ))
        .is_ok());
        for error in [
            "desktop_control_execution_stopped",
            "desktop_control_overlay_superseded",
            "desktop_control_monitor_unavailable",
            "browser_outside_selected_monitor_move_luczor_window",
            "desktop_control_overlay_unavailable",
        ] {
            assert_eq!(
                internal_browser_overlay_feedback(Err(error.into())),
                Err(error.into())
            );
        }
    }
}
