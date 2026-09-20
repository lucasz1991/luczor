//! One device-local cancellation barrier shared by manual stop and real app exit.
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopResult {
    complete: bool,
    process_count: usize,
    pending_count: usize,
    errors: Vec<String>,
}

#[tauri::command]
pub(crate) async fn app_stop_agents(
    app: AppHandle,
    window: super::CallerWebview,
) -> Result<StopResult, String> {
    super::ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || stop_all(&app, false, true))
        .await
        .map_err(|_| "native_agent_stop_failed".into())
}

pub(crate) fn stop_all(app: &AppHandle, closing: bool, close_browser: bool) -> StopResult {
    let _stop = match super::owned_processes::begin_stop(closing) {
        Ok(guard) => guard,
        Err(error) => {
            return StopResult {
                complete: false,
                process_count: 0,
                pending_count: super::owned_processes::pending_operations().max(1),
                errors: vec![error],
            }
        }
    };
    // Final Exit has no live event loop to drain; the grace/commit path already
    // waited, so only perform a short final owned-handle sweep there.
    let deadline = Instant::now() + Duration::from_millis(if close_browser { 4500 } else { 100 });
    let mut errors = Vec::new();
    if let Err(error) = super::execution::stop_all() {
        errors.push(error);
    }
    app.state::<super::codex::CodexJobs>().cancel_all();
    app.state::<super::claude::ClaudeJobs>().cancel_all();
    let _ = super::local_model::signal_stop_all();
    let _ = super::repository_graph::stop_all();
    super::desktop_control::stop_feedback();
    if close_browser {
        if let Err(error) = super::browser::stop_all() {
            errors.push(error);
        }
        if let Err(error) = super::workflow_browser::stop_all(app) {
            errors.push(error);
        }
    }
    // Handles include full Windows Job Objects, so blocked SDK stdin and script
    // descendants cannot evade cancellation by ignoring cooperative flags.
    let process = super::owned_processes::terminate_registered(
        deadline.min(Instant::now() + Duration::from_secs(2)),
    );
    errors.extend(process.errors);
    let pending = loop {
        let _ = super::repository_graph::stop_all();
        let runtime_pending = !super::local_model::shutdown_all().unwrap_or(false);
        let browser_pending =
            close_browser && app.get_webview(super::BROWSER_WEBVIEW_LABEL).is_some();
        let pending = super::owned_processes::pending_operations()
            + usize::from(runtime_pending)
            + usize::from(browser_pending)
            + process.pending_count;
        if pending == 0 || Instant::now() >= deadline {
            break pending;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    if pending > 0 {
        errors.push("native_agent_stop_pending".into());
    } else if let Err(error) = super::local_model::finish_stop_bookkeeping() {
        errors.push(error);
    }
    errors.sort();
    errors.dedup();
    StopResult {
        complete: pending == 0 && errors.is_empty(),
        process_count: process.process_count,
        pending_count: pending,
        errors,
    }
}
