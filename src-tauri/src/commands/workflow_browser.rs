//! One run-bound WebView2 session; only fixed, typed operations are exposed to IPC.
use super::execution::{admit, ExecutionLease, Guarded};
use super::workflow_artifacts::{self, WorkflowArtifactScope, MAX_ARTIFACT_BYTES};
use super::BROWSER_WEBVIEW_LABEL;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

struct Session {
    id: String,
    scope: WorkflowArtifactScope,
    busy: AtomicBool,
    created: Instant,
}
fn sessions() -> &'static Mutex<Option<Arc<Session>>> {
    static SESSION: OnceLock<Mutex<Option<Arc<Session>>>> = OnceLock::new();
    SESSION.get_or_init(Mutex::default)
}
pub(crate) fn ensure_unbound() -> Result<(), String> {
    if sessions()
        .lock()
        .map_err(|_| "workflow_browser_registry_unavailable")?
        .is_some()
    {
        Err("Browser belongs to an active workflow session; close that session first.".into())
    } else {
        Ok(())
    }
}
struct Busy(Arc<Session>);
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}
fn lock_session(session: &Arc<Session>) -> Result<Busy, String> {
    session
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "workflow_browser_session_busy")?;
    Ok(Busy(session.clone()))
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserOperation {
    Open,
    Navigate,
    Click,
    Fill,
    Select,
    Wait,
    Read,
    Screenshot,
    Download,
    Close,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowBrowserAction {
    pub scope: WorkflowArtifactScope,
    pub session_id: Option<String>,
    pub expected_tab_id: Option<String>,
    pub action: BrowserOperation,
    pub url: Option<String>,
    pub expected_url: Option<String>,
    pub selector: Option<String>,
    pub value: Option<String>,
    pub name: Option<String>,
    pub timeout_ms: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowBrowserResult {
    pub ok: bool,
    pub session_id: String,
    pub tab_id: &'static str,
    pub url: String,
    pub data: Value,
}

fn validate(input: &WorkflowBrowserAction) -> Result<(), String> {
    if input
        .expected_tab_id
        .as_deref()
        .is_some_and(|id| id != BROWSER_WEBVIEW_LABEL)
    {
        return Err("workflow_browser_tab_changed".into());
    }
    if input
        .session_id
        .as_deref()
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        || input.timeout_ms.is_some_and(|ms| ms == 0 || ms > 60000)
    {
        return Err("workflow_browser_options_invalid".into());
    }
    if input
        .selector
        .as_ref()
        .is_some_and(|value| value.len() > 4096 || value.chars().any(char::is_control))
        || input
            .value
            .as_ref()
            .is_some_and(|value| value.len() > 100_000 || value.contains('\0'))
    {
        return Err("workflow_browser_input_invalid".into());
    }
    if matches!(
        input.action,
        BrowserOperation::Click | BrowserOperation::Fill | BrowserOperation::Select
    ) && input
        .selector
        .as_ref()
        .is_none_or(|selector| selector.trim().is_empty())
    {
        return Err("workflow_browser_selector_required".into());
    }
    if matches!(
        input.action,
        BrowserOperation::Fill | BrowserOperation::Select
    ) && input.value.is_none()
    {
        return Err("workflow_browser_value_required".into());
    }
    if matches!(
        input.action,
        BrowserOperation::Navigate | BrowserOperation::Download
    ) && input
        .url
        .as_ref()
        .is_none_or(|value| value.trim().is_empty())
    {
        return Err("workflow_browser_url_required".into());
    }
    Ok(())
}
fn url(value: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(value).map_err(|_| "workflow_browser_url_invalid")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("workflow_browser_url_invalid".into());
    }
    Ok(parsed)
}
fn check(app: &AppHandle, session: &Session, gate: &ExecutionLease) -> Result<(), String> {
    gate.check()?;
    session.scope.check(app)?;
    let current = sessions()
        .lock()
        .map_err(|_| "workflow_browser_registry_unavailable")?;
    if !current.as_ref().is_some_and(|value| value.id == session.id) {
        return Err("workflow_browser_session_changed".into());
    }
    Ok(())
}
fn retire(app: &AppHandle, session: &Session) {
    let mut close = false;
    if let Ok(mut current) = sessions().lock() {
        if current.as_ref().is_some_and(|value| value.id == session.id) {
            *current = None;
            close = true;
        }
    }
    if close {
        if let Some(window) = app.get_webview_window(BROWSER_WEBVIEW_LABEL) {
            let _ = window.close();
        }
    }
}

/// Cleanup is owned by the original run snapshot and remains possible after its execution grant was revoked.
#[tauri::command]
pub async fn wf_browser_cleanup(
    app: AppHandle,
    window: WebviewWindow,
    payload: WorkflowArtifactScope,
) -> Result<bool, String> {
    super::ensure_main_webview(&window)?;
    let current = sessions()
        .lock()
        .map_err(|_| "workflow_browser_registry_unavailable")?
        .clone();
    let Some(session) = current else {
        return Ok(false);
    };
    if session.scope != payload {
        return Err("workflow_browser_owned_by_another_run".into());
    }
    retire(&app, &session);
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        while app.get_webview_window(BROWSER_WEBVIEW_LABEL).is_some() {
            if Instant::now() >= deadline {
                return Err("workflow_browser_cleanup_pending".into());
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        Ok(true)
    })
    .await
    .map_err(|_| "workflow_browser_cleanup_failed")?
}

#[tauri::command]
pub async fn wf_browser_action(
    app: AppHandle,
    window: WebviewWindow,
    payload: Guarded<WorkflowBrowserAction>,
) -> Result<WorkflowBrowserResult, String> {
    super::ensure_main_webview(&window)?;
    validate(&payload.request)?;
    if payload.execution.workflow_execution_id.is_none() {
        return Err("workflow_execution_identity_required".into());
    }
    let writing = !matches!(
        payload.action,
        BrowserOperation::Read | BrowserOperation::Wait | BrowserOperation::Screenshot
    );
    let gate = admit(&payload.execution, writing)?;
    let input = payload.request;
    input.scope.check(&app)?;
    let session = {
        let mut current = sessions()
            .lock()
            .map_err(|_| "workflow_browser_registry_unavailable")?;
        if current.as_ref().is_some_and(|session| {
            !session.busy.load(Ordering::Acquire)
                && (session.created.elapsed() > Duration::from_secs(7200)
                    || app.get_webview_window(BROWSER_WEBVIEW_LABEL).is_none())
        }) {
            *current = None;
        }
        if let Some(session) = current.as_ref() {
            if session.scope != input.scope
                || input
                    .session_id
                    .as_ref()
                    .is_some_and(|id| id != &session.id)
            {
                return Err("workflow_browser_owned_by_another_run".into());
            }
            session.clone()
        } else {
            if input.action != BrowserOperation::Open || input.session_id.is_some() {
                return Err("workflow_browser_session_unavailable".into());
            }
            if app.get_webview_window(BROWSER_WEBVIEW_LABEL).is_some() {
                return Err("workflow_browser_window_already_in_use".into());
            }
            let session = Arc::new(Session {
                id: uuid::Uuid::new_v4().to_string(),
                scope: input.scope.clone(),
                busy: AtomicBool::new(false),
                created: Instant::now(),
            });
            *current = Some(session.clone());
            session
        }
    };
    let _busy = lock_session(&session)?;
    let result = run(&app, &session, &gate, &input).await;
    if result.is_err()
        && (check(&app, &session, &gate).is_err() || input.action == BrowserOperation::Open)
    {
        retire(&app, &session);
    }
    result
}

async fn run(
    app: &AppHandle,
    session: &Arc<Session>,
    gate: &ExecutionLease,
    input: &WorkflowBrowserAction,
) -> Result<WorkflowBrowserResult, String> {
    check(app, session, gate)?;
    if input.action == BrowserOperation::Close {
        retire(app, session);
        return Ok(WorkflowBrowserResult {
            ok: true,
            session_id: session.id.clone(),
            tab_id: BROWSER_WEBVIEW_LABEL,
            url: String::new(),
            data: json!({"closed":true}),
        });
    }
    if input.action == BrowserOperation::Open
        && app.get_webview_window(BROWSER_WEBVIEW_LABEL).is_none()
    {
        let target = input.url.as_deref().map(url).transpose()?.unwrap_or(
            tauri::Url::parse("about:blank").map_err(|_| "workflow_browser_url_invalid")?,
        );
        check(app, session, gate)?;
        let browser =
            WebviewWindowBuilder::new(app, BROWSER_WEBVIEW_LABEL, WebviewUrl::External(target))
                .title("Luczor Workflow Browser")
                .inner_size(1200., 800.)
                .build()
                .map_err(|_| "workflow_browser_window_failed")?;
        let session_id = session.id.clone();
        browser.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut current) = sessions().lock() {
                    if current
                        .as_ref()
                        .is_some_and(|session| session.id == session_id)
                    {
                        *current = None;
                    }
                }
            }
        });
    } else if matches!(
        input.action,
        BrowserOperation::Open | BrowserOperation::Navigate
    ) {
        if let Some(target) = input.url.as_deref() {
            check(app, session, gate)?;
            app.get_webview_window(BROWSER_WEBVIEW_LABEL)
                .ok_or("workflow_browser_window_unavailable")?
                .navigate(url(target)?)
                .map_err(|_| "workflow_browser_navigation_failed")?;
        } else if input.action == BrowserOperation::Navigate {
            return Err("workflow_browser_url_required".into());
        }
    }
    let browser = app
        .get_webview_window(BROWSER_WEBVIEW_LABEL)
        .ok_or("workflow_browser_window_unavailable")?;
    let current_url = browser
        .url()
        .map_err(|_| "workflow_browser_url_unavailable")?
        .to_string();
    if input
        .expected_url
        .as_ref()
        .is_some_and(|expected| expected != &current_url)
    {
        return Err("workflow_browser_url_changed".into());
    }
    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(15000));
    let data = match input.action {
        BrowserOperation::Open | BrowserOperation::Navigate => {
            let deadline = Instant::now() + timeout;
            loop {
                check(app, session, gate)?;
                let state = devtools(&browser, "Runtime.evaluate", json!({"expression":"({url:location.href,ready:document.readyState})","returnByValue":true}), app.clone(), session.clone(), gate.clone(), Duration::from_secs(2)).await;
                if let Ok(state) = state {
                    let value = &state["result"]["value"];
                    let actual = browser
                        .url()
                        .map_err(|_| "workflow_browser_url_unavailable")?;
                    if value["ready"] == "complete"
                        && value["url"].as_str() == Some(actual.as_str())
                        && (input.url.is_none() || actual.as_str() != "about:blank")
                    {
                        break;
                    }
                }
                if Instant::now() >= deadline {
                    return Err("workflow_browser_navigation_timeout".into());
                }
                tauri::async_runtime::spawn_blocking(|| {
                    std::thread::sleep(Duration::from_millis(50))
                })
                .await
                .map_err(|_| "workflow_browser_task_failed")?;
            }
            json!({"opened":true,"readiness":"ready"})
        }
        BrowserOperation::Screenshot => {
            let raw = devtools(
                &browser,
                "Page.captureScreenshot",
                json!({"format":"png","captureBeyondViewport":false,"fromSurface":true}),
                app.clone(),
                session.clone(),
                gate.clone(),
                timeout,
            )
            .await?;
            let data = raw["data"]
                .as_str()
                .ok_or("workflow_browser_screenshot_invalid")?;
            if data.len() > MAX_ARTIFACT_BYTES * 2 {
                return Err("workflow_artifact_size_exceeded".into());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| "workflow_browser_screenshot_invalid")?;
            if browser
                .url()
                .map_err(|_| "workflow_browser_url_unavailable")?
                .as_str()
                != current_url
            {
                return Err("workflow_browser_url_changed".into());
            }
            serde_json::to_value(workflow_artifacts::store(
                app,
                &session.scope,
                &bytes,
                "image/png",
                input.name.as_deref().unwrap_or("browser.png"),
                &|| check(app, session, gate),
            )?)
            .map_err(|_| "workflow_artifact_invalid")?
        }
        action => {
            let action = match action {
                BrowserOperation::Click => "click",
                BrowserOperation::Fill => "fill",
                BrowserOperation::Select => "select",
                BrowserOperation::Wait => "wait",
                BrowserOperation::Read => "read",
                BrowserOperation::Download => "download",
                _ => return Err("workflow_browser_action_invalid".into()),
            };
            let params = json!({"action":action,"selector":input.selector,"value":input.value,"url":input.url,"expectedUrl":current_url,"timeoutMs":timeout.as_millis(),"maxChars":20000,"maxBytes":MAX_ARTIFACT_BYTES});
            let expression = format!(
                "{}\nluczorWorkflowBrowser({});",
                include_str!("workflow_browser_script.js"),
                params
            );
            let raw = devtools(
                &browser,
                "Runtime.evaluate",
                json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
                app.clone(),
                session.clone(),
                gate.clone(),
                timeout + Duration::from_millis(250),
            )
            .await?;
            if raw.get("exceptionDetails").is_some() {
                return Err("workflow_browser_action_failed_outcome_unknown".into());
            }
            let value = raw["result"]["value"].clone();
            if value["ok"] != true {
                return Err(value["code"]
                    .as_str()
                    .filter(|code| code.len() <= 100 && code.starts_with("browser_"))
                    .unwrap_or("workflow_browser_action_failed_outcome_unknown")
                    .to_string());
            }
            if input.action == BrowserOperation::Download {
                let encoded = value["base64"]
                    .as_str()
                    .ok_or("workflow_browser_download_invalid")?;
                if encoded.len() > MAX_ARTIFACT_BYTES * 2 {
                    return Err("workflow_artifact_size_exceeded".into());
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| "workflow_browser_download_invalid")?;
                let mime = value["mime"].as_str().unwrap_or("application/octet-stream");
                serde_json::to_value(workflow_artifacts::store(
                    app,
                    &session.scope,
                    &bytes,
                    mime,
                    input.name.as_deref().unwrap_or("download"),
                    &|| check(app, session, gate),
                )?)
                .map_err(|_| "workflow_artifact_invalid")?
            } else {
                value
            }
        }
    };
    check(app, session, gate)?;
    let url = browser
        .url()
        .map_err(|_| "workflow_browser_url_unavailable")?
        .to_string();
    Ok(WorkflowBrowserResult {
        ok: true,
        session_id: session.id.clone(),
        tab_id: BROWSER_WEBVIEW_LABEL,
        url,
        data,
    })
}

#[cfg(windows)]
async fn devtools(
    window: &WebviewWindow,
    method: &'static str,
    params: Value,
    app: AppHandle,
    session: Arc<Session>,
    gate: ExecutionLease,
    timeout: Duration,
) -> Result<Value, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let before_app = app.clone();
    let before_session = session.clone();
    let before_gate = gate.clone();
    window
        .with_webview(move |view| {
            if let Err(error) = check(&before_app, &before_session, &before_gate) {
                let _ = sender.send(Err(error));
                return;
            }
            let completion = sender.clone();
            let handler = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(
                Box::new(move |result, text| {
                    let value = result
                        .map_err(|_| "workflow_browser_protocol_failed_outcome_unknown".into())
                        .and_then(|_| {
                            if text.len() > MAX_ARTIFACT_BYTES * 2 {
                                return Err("workflow_browser_output_exceeded".into());
                            }
                            serde_json::from_str::<Value>(&text)
                                .map_err(|_| "workflow_browser_protocol_invalid".into())
                        });
                    let _ = completion.try_send(value);
                    Ok(())
                }),
            );
            let method = webview2_com::CoTaskMemPWSTR::from(method);
            let serialized = params.to_string();
            let parameters = webview2_com::CoTaskMemPWSTR::from(serialized.as_str());
            let result = unsafe {
                view.controller().CoreWebView2().and_then(|webview| {
                    webview.CallDevToolsProtocolMethod(
                        *method.as_ref().as_pcwstr(),
                        *parameters.as_ref().as_pcwstr(),
                        &handler,
                    )
                })
            };
            if result.is_err() {
                let _ = sender.try_send(Err("workflow_browser_protocol_unavailable".into()));
            }
        })
        .map_err(|_| "workflow_browser_protocol_unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + timeout;
        loop {
            check(&app, &session, &gate)?;
            match receiver.recv_timeout(Duration::from_millis(40)) {
                Ok(result) => {
                    check(&app, &session, &gate)?;
                    return result;
                }
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                _ => return Err("workflow_browser_timeout_outcome_unknown".into()),
            }
        }
    })
    .await
    .map_err(|_| "workflow_browser_task_failed")?
}
#[cfg(not(windows))]
async fn devtools(
    _window: &WebviewWindow,
    _method: &'static str,
    _params: Value,
    _app: AppHandle,
    _session: Arc<Session>,
    _gate: ExecutionLease,
    _timeout: Duration,
) -> Result<Value, String> {
    Err("workflow_browser_requires_windows_webview2".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_actions_reject_script_injection_and_credential_urls() {
        assert!(url("javascript:alert(1)").is_err());
        assert!(url("https://user:password@example.com").is_err());
        assert!(url("https://example.com/path").is_ok());
        assert!(serde_json::from_str::<BrowserOperation>("\"evaluate\"").is_err());
    }
    #[test]
    fn session_busy_guard_serializes_actions_and_releases_on_drop() {
        let session = Arc::new(Session {
            id: "s".into(),
            scope: WorkflowArtifactScope {
                principal_id: "u".into(),
                project_id: "p".into(),
                expected_root_path: "root".into(),
                expected_workspace_updated_at: 1,
                run_id: uuid::Uuid::new_v4().to_string(),
            },
            busy: AtomicBool::new(false),
            created: Instant::now(),
        });
        let guard = lock_session(&session).unwrap();
        assert!(lock_session(&session).is_err());
        drop(guard);
        assert!(lock_session(&session).is_ok());
    }
}
