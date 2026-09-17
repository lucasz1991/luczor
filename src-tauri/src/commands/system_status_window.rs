//! Native, movable Systemstatus window. It receives only read-only telemetry commands.
use super::{ensure_main_webview, ensure_webview_label};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

pub const SYSTEM_STATUS_LABEL: &str = "luczor-system-status";

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemStatusWindowMode {
    Tabs,
    Dashboard,
}

impl SystemStatusWindowMode {
    fn route(self) -> &'static str {
        match self {
            Self::Tabs => "tabs",
            Self::Dashboard => "dashboard",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Tabs => "Luczor · Systemstatus",
            Self::Dashboard => "Luczor · Systemstatus Dashboard",
        }
    }

    fn size(self) -> LogicalSize<f64> {
        match self {
            Self::Tabs => LogicalSize::new(900.0, 720.0),
            Self::Dashboard => LogicalSize::new(1_360.0, 920.0),
        }
    }
}

fn apply_mode(window: &tauri::Window, mode: SystemStatusWindowMode) -> Result<(), String> {
    window
        .set_title(mode.title())
        .map_err(|error| error.to_string())?;
    window
        .set_size(mode.size())
        .map_err(|error| error.to_string())
}

pub fn show(app: AppHandle, mode: SystemStatusWindowMode) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SYSTEM_STATUS_LABEL) {
        apply_mode(&window.as_ref().window(), mode)?;
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }

    let window = WebviewWindowBuilder::new(
        &app,
        SYSTEM_STATUS_LABEL,
        WebviewUrl::App(format!("index.html#system-status?mode={}", mode.route()).into()),
    )
    .title(mode.title())
    .inner_size(mode.size().width, mode.size().height)
    .min_inner_size(480.0, 440.0)
    .resizable(true)
    .maximizable(true)
    .minimizable(true)
    // Keep the platform titlebar: it is the familiar, accessible drag surface.
    .decorations(true)
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn system_status_window_open(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    mode: SystemStatusWindowMode,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    show(app, mode)
}

#[tauri::command]
pub fn system_status_window_set_mode(
    window: crate::commands::CallerWebview,
    mode: SystemStatusWindowMode,
) -> Result<(), String> {
    ensure_webview_label(window.label(), SYSTEM_STATUS_LABEL)?;
    apply_mode(&window, mode)
}

#[tauri::command]
pub fn system_status_window_close(window: crate::commands::CallerWebview) -> Result<(), String> {
    ensure_webview_label(window.label(), SYSTEM_STATUS_LABEL)?;
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn system_status_open_memory(
    window: crate::commands::CallerWebview,
    app: AppHandle,
) -> Result<(), String> {
    ensure_webview_label(window.label(), SYSTEM_STATUS_LABEL)?;
    let main = app
        .get_webview_window("main")
        .ok_or("Hauptfenster nicht verfügbar.")?;
    main.emit("luczor-memory-explorer-open", ())
        .map_err(|error| error.to_string())?;
    main.show().map_err(|error| error.to_string())?;
    main.unminimize().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_status_modes_use_bounded_window_sizes_and_distinct_routes() {
        assert_eq!(SystemStatusWindowMode::Tabs.route(), "tabs");
        assert_eq!(SystemStatusWindowMode::Dashboard.route(), "dashboard");
        assert!(SystemStatusWindowMode::Tabs.size().width >= 480.0);
        assert!(
            SystemStatusWindowMode::Dashboard.size().width
                > SystemStatusWindowMode::Tabs.size().width
        );
    }
}
