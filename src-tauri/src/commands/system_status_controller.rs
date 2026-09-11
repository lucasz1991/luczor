use tauri::{Manager};

use super::system_status_model::SystemMetrics;

/// Authorizes the caller and schedules the blocking telemetry collector away
/// from Tauri's async command runtime.
#[tauri::command]
pub async fn system_metrics(window: crate::commands::CallerWebview) -> Result<SystemMetrics, String> {
    super::ensure_main_or_system_status_webview(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        super::system::collect_system_metrics_for_app(Some(&app))
    })
    .await
    .map_err(|_| "System metric worker could not finish.".to_string())?
}
