//! Run-bound internal browser. Unrestricted web/file navigation; typed, isolated DOM automation.
use super::execution::{admit, ExecutionLease, Guarded};
use super::workflow_artifacts::{self, WorkflowArtifactScope, MAX_ARTIFACT_BYTES};
use super::BROWSER_WEBVIEW_LABEL;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Webview, WebviewUrl};

struct Session {
    id: String,
    scope: WorkflowArtifactScope,
    busy: AtomicBool,
    allowed_hosts: Option<Vec<String>>,
    automated: bool,
    gate: Mutex<Option<ExecutionLease>>,
    policy_violation: AtomicBool,
    navigation: Mutex<NavigationTracker>,
}

#[derive(Default)]
struct NavigationTracker {
    generation: u64,
    requested: Option<RequestedNavigation>,
}
struct RequestedNavigation {
    target: String,
    id: Option<u64>,
    complete: Option<bool>,
}
impl NavigationTracker {
    fn begin(&mut self, target: &str) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.requested = Some(RequestedNavigation {
            target: target.into(),
            id: None,
            complete: None,
        });
        self.generation
    }
    fn started(&mut self, id: u64, uri: &str) {
        #[cfg(all(test, feature = "native-browser-smoke"))]
        eprintln!(
            "BROWSER_NAV_START id={id} uri={uri} requested={:?}",
            self.requested
                .as_ref()
                .map(|request| (&request.target, request.id))
        );
        if let Some(request) = &mut self.requested {
            if request.id.is_none() && uri == request.target {
                request.id = Some(id);
            } else if request.id.is_some_and(|expected| expected != id) {
                request.complete = Some(false);
            }
        }
    }
    fn finished(&mut self, id: u64, success: bool) {
        #[cfg(all(test, feature = "native-browser-smoke"))]
        eprintln!("BROWSER_NAV_FINISH id={id} success={success}");
        if let Some(request) = &mut self.requested {
            if request.id == Some(id) && request.complete.is_none() {
                request.complete = Some(success);
            }
        }
    }
    fn status(&self, generation: u64) -> Result<Option<bool>, String> {
        if generation != self.generation {
            return Err("workflow_browser_navigation_changed".into());
        }
        Ok(self.requested.as_ref().and_then(|request| request.complete))
    }
}
pub(crate) fn panel_project_id() -> Option<String> {
    sessions()
        .lock()
        .ok()?
        .as_ref()
        .map(|s| s.scope.project_id.clone())
}

fn sessions() -> &'static Mutex<Option<Arc<Session>>> {
    static SESSION: OnceLock<Mutex<Option<Arc<Session>>>> = OnceLock::new();
    SESSION.get_or_init(Mutex::default)
}

pub(crate) fn stop_all(app: &AppHandle) -> Result<(), String> {
    let mut session = sessions()
        .try_lock()
        .map_err(|_| "workflow_browser_stop_pending")?;
    if let Some(current) = session.as_ref() {
        current.policy_violation.store(true, Ordering::Release);
    }
    if let Some(view) = app.get_webview(BROWSER_WEBVIEW_LABEL) {
        view.close().map_err(|_| "workflow_browser_close_failed")?;
    }
    *session = None;
    Ok(())
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
    Scan,
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
    pub allowed_hosts: Option<Vec<String>>,
    #[serde(default)]
    pub automated: bool,
    pub action: BrowserOperation,
    pub url: Option<String>,
    pub expected_url: Option<String>,
    pub selector: Option<String>,
    pub value: Option<String>,
    pub name: Option<String>,
    pub timeout_ms: Option<u64>,
    pub query: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub max_chars: Option<usize>,
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
    validate_hosts(input.allowed_hosts.as_deref(), input.automated)?;
    if input.query.as_ref().is_some_and(|q| q.len() > 800)
        || input.offset.is_some_and(|v| {
            v > if input.action == BrowserOperation::Read {
                100_000_000
            } else {
                20000
            }
        })
        || input.limit.is_some_and(|v| v == 0 || v > 200)
        || input.max_chars.is_some_and(|v| v == 0 || v > 20000)
    {
        return Err("workflow_browser_scan_options_invalid".into());
    }
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
fn validate_hosts(hosts: Option<&[String]>, _automated: bool) -> Result<(), String> {
    // Accepted for older workflow payloads only; domain restrictions were explicitly removed.
    if let Some(hosts) = hosts {
        if hosts.len() > 30 || hosts.iter().any(|host| host.len() > 260) {
            return Err("workflow_browser_allowed_hosts_invalid".into());
        }
    }
    Ok(())
}
fn host_allowed(url: &tauri::Url, _hosts: Option<&[String]>) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if !matches!(url.scheme(), "http" | "https" | "file")
        || (url.scheme() != "file" && url.host_str().is_none())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    true
}
pub(super) fn url(value: &str) -> Result<tauri::Url, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err("workflow_browser_url_invalid".into());
    }
    let parsed = if std::path::Path::new(value).is_absolute() {
        tauri::Url::from_file_path(value).map_err(|_| "workflow_browser_url_invalid")?
    } else {
        tauri::Url::parse(value).map_err(|_| "workflow_browser_url_invalid")?
    };
    if !host_allowed(&parsed, None) {
        return Err("workflow_browser_url_invalid".into());
    }
    Ok(parsed)
}
fn check(app: &AppHandle, session: &Session, gate: &ExecutionLease) -> Result<(), String> {
    gate.check()?;
    if session.policy_violation.load(Ordering::Acquire) {
        return Err("workflow_browser_host_not_allowed".into());
    }
    session.scope.check(app)?;
    let current = sessions()
        .lock()
        .map_err(|_| "workflow_browser_registry_unavailable")?;
    if current.as_ref().is_none_or(|value| value.id != session.id) {
        return Err("workflow_browser_session_changed".into());
    }
    Ok(())
}
fn check_session(app: &AppHandle, session: &Session) -> Result<(), String> {
    let gate = session
        .gate
        .lock()
        .map_err(|_| "workflow_browser_gate_unavailable")?
        .clone()
        .ok_or("workflow_browser_gate_unavailable")?;
    check(app, session, &gate)
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
        if let Some(window) = app.get_webview(BROWSER_WEBVIEW_LABEL) {
            let _ = window.close();
        }
    }
}

/// Cleanup is owned by the original run snapshot and remains possible after its execution grant was revoked.
#[tauri::command]
pub async fn wf_browser_cleanup(
    app: AppHandle,
    window: crate::commands::CallerWebview,
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
        while app.get_webview(BROWSER_WEBVIEW_LABEL).is_some() {
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
    window: crate::commands::CallerWebview,
    payload: Guarded<WorkflowBrowserAction>,
) -> Result<WorkflowBrowserResult, String> {
    super::ensure_main_webview(&window)?;
    let (_operation, _) = super::owned_processes::Operation::begin()?;
    validate(&payload.request)?;
    super::research::check_scope_execution(&app, &payload.scope, &payload.execution)?;
    if capabilities()["available"] != true {
        return Err("workflow_browser_requires_windows_webview2".into());
    }
    if payload.execution.workflow_execution_id.is_none() {
        return Err("workflow_execution_identity_required".into());
    }
    let writing = !matches!(
        payload.action,
        BrowserOperation::Read
            | BrowserOperation::Scan
            | BrowserOperation::Wait
            | BrowserOperation::Screenshot
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
                && app.get_webview(BROWSER_WEBVIEW_LABEL).is_none()
        }) {
            *current = None;
        }
        if let Some(session) = current.as_ref() {
            if session.scope != input.scope
                || session.automated != input.automated
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
            if app.get_webview(BROWSER_WEBVIEW_LABEL).is_some() {
                return Err("workflow_browser_window_already_in_use".into());
            }
            let session = Arc::new(Session {
                id: uuid::Uuid::new_v4().to_string(),
                scope: input.scope.clone(),
                busy: AtomicBool::new(false),
                allowed_hosts: None,
                automated: input.automated,
                gate: Mutex::new(None),
                policy_violation: AtomicBool::new(false),
                navigation: Mutex::new(NavigationTracker::default()),
            });
            *current = Some(session.clone());
            session
        }
    };
    let _busy = lock_session(&session)?;
    *session
        .gate
        .lock()
        .map_err(|_| "workflow_browser_gate_unavailable")? = Some(gate.clone());
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
    // expectedUrl is the source-page precondition. Check it before navigation or any other mutation.
    if let Some(expected) = &input.expected_url {
        let source = app
            .get_webview(BROWSER_WEBVIEW_LABEL)
            .ok_or("workflow_browser_window_unavailable")?
            .url()
            .map_err(|_| "workflow_browser_url_unavailable")?;
        if source.as_str() != expected {
            return Err("workflow_browser_url_changed".into());
        }
    }
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
    let mut navigation_generation = None;
    super::desktop_control::browser_feedback(app, gate.permit()).await?;
    gate.check()?;
    if input.action == BrowserOperation::Open && app.get_webview(BROWSER_WEBVIEW_LABEL).is_none() {
        let target = input.url.as_deref().map(url).transpose()?.unwrap_or(
            tauri::Url::parse("about:blank").map_err(|_| "workflow_browser_url_invalid")?,
        );
        if !host_allowed(&target, session.allowed_hosts.as_deref()) {
            return Err("workflow_browser_host_not_allowed".into());
        }
        check(app, session, gate)?;
        let navigation_app = app.clone();
        let navigation_session = session.clone();
        let builder = tauri::webview::WebviewBuilder::new(
            BROWSER_WEBVIEW_LABEL,
            WebviewUrl::External(
                tauri::Url::parse("about:blank").map_err(|_| "workflow_browser_url_invalid")?,
            ),
        )
        .on_navigation(move |url| {
            if !host_allowed(url, navigation_session.allowed_hosts.as_deref()) {
                navigation_session
                    .policy_violation
                    .store(true, Ordering::Release);
                return false;
            }
            check_session(&navigation_app, &navigation_session).is_ok()
        })
        .on_new_window({
            let popup_app = app.clone();
            let popup_session = session.clone();
            move |target, _| {
                // Keep target=_blank links inside the owned internal surface.
                if host_allowed(&target, None) && check_session(&popup_app, &popup_session).is_ok()
                {
                    if let Some(view) = popup_app.get_webview(BROWSER_WEBVIEW_LABEL) {
                        let _ = view.navigate(target);
                    }
                }
                tauri::webview::NewWindowResponse::Deny
            }
        });
        let main = app
            .get_window("main")
            .ok_or("browser_panel_main_unavailable")?;
        let browser = main
            .add_child(
                builder,
                tauri::LogicalPosition::new(0.0, 0.0),
                tauri::LogicalSize::new(1.0, 1.0),
            )
            .map_err(|e| format!("workflow_browser_create_failed: {e}"))?;
        browser.hide().map_err(|e| e.to_string())?;
        super::browser_panel::apply(app, &browser, &session.scope.project_id)?;
        install_navigation_tracking(&browser, app.clone(), session.clone()).await?;
        check(app, session, gate)?;
        navigation_generation = Some(
            session
                .navigation
                .lock()
                .map_err(|_| "workflow_browser_navigation_unavailable")?
                .begin(target.as_str()),
        );
        browser
            .navigate(target)
            .map_err(|_| "workflow_browser_navigation_failed")?;
    } else if matches!(
        input.action,
        BrowserOperation::Open | BrowserOperation::Navigate
    ) {
        if let Some(target) = input.url.as_deref() {
            check(app, session, gate)?;
            let target = url(target)?;
            if !host_allowed(&target, session.allowed_hosts.as_deref()) {
                return Err("workflow_browser_host_not_allowed".into());
            }
            navigation_generation = Some(
                session
                    .navigation
                    .lock()
                    .map_err(|_| "workflow_browser_navigation_unavailable")?
                    .begin(target.as_str()),
            );
            app.get_webview(BROWSER_WEBVIEW_LABEL)
                .ok_or("workflow_browser_window_unavailable")?
                .navigate(target)
                .map_err(|_| "workflow_browser_navigation_failed")?;
        } else if input.action == BrowserOperation::Navigate {
            return Err("workflow_browser_url_required".into());
        }
    }
    let browser = app
        .get_webview(BROWSER_WEBVIEW_LABEL)
        .ok_or("workflow_browser_window_unavailable")?;
    let current_url = browser
        .url()
        .map_err(|_| "workflow_browser_url_unavailable")?
        .to_string();
    if !matches!(
        input.action,
        BrowserOperation::Open | BrowserOperation::Navigate
    ) && input
        .expected_url
        .as_ref()
        .is_some_and(|expected| expected != &current_url)
    {
        return Err("workflow_browser_url_changed".into());
    }
    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(15000));
    let mut data = match input.action {
        BrowserOperation::Open | BrowserOperation::Navigate => {
            let deadline = Instant::now() + timeout;
            loop {
                check(app, session, gate)?;
                let completed = if let Some(generation) = navigation_generation {
                    match session
                        .navigation
                        .lock()
                        .map_err(|_| "workflow_browser_navigation_unavailable")?
                        .status(generation)?
                    {
                        Some(false) => return Err("workflow_browser_navigation_failed".into()),
                        Some(true) => true,
                        None => false,
                    }
                } else {
                    true
                };
                let state = evaluate(&browser, json!({"expression":"({url:location.href,ready:document.readyState})","returnByValue":true}), app.clone(), session.clone(), gate.clone(), Duration::from_secs(2)).await;
                if let Ok(state) = state {
                    let value = &state["result"]["value"];
                    let actual = browser
                        .url()
                        .map_err(|_| "workflow_browser_url_unavailable")?;
                    if completed
                        && value["ready"] == "complete"
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
        BrowserOperation::Download => {
            download::download(app, &browser, session, gate, input, timeout).await?
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
                BrowserOperation::Scan => "scan",
                _ => return Err("workflow_browser_action_invalid".into()),
            };
            let mut params = json!({"action":action,"selector":input.selector,"value":input.value,"url":input.url,"expectedUrl":current_url,"timeoutMs":timeout.as_millis(),"maxChars":input.max_chars.unwrap_or(20000),"query":input.query,"offset":input.offset,"limit":input.limit,"showCursor":super::desktop_control::config()?.show_cursor});
            if matches!(
                input.action,
                BrowserOperation::Click | BrowserOperation::Fill | BrowserOperation::Select
            ) {
                let deadline = Instant::now() + timeout;
                loop {
                    check(app, session, gate)?;
                    let mut probe = params.clone();
                    probe["action"] = json!("prepare");
                    probe["operation"] = json!(action);
                    let prepared = dom_call(
                        &browser,
                        probe,
                        app.clone(),
                        session.clone(),
                        gate.clone(),
                        Duration::from_secs(2),
                    )
                    .await?;
                    if prepared["ok"] == true {
                        params["selector"] = prepared["ref"].clone();
                        params["prepared"] = json!(true);
                        break;
                    }
                    let code = prepared["code"]
                        .as_str()
                        .unwrap_or("workflow_browser_action_failed_outcome_unknown");
                    if !matches!(
                        code,
                        "browser_target_not_actionable"
                            | "browser_target_missing_or_ambiguous"
                            | "browser_page_not_ready"
                    ) || Instant::now() >= deadline
                    {
                        return Err(code.to_string());
                    }
                    tauri::async_runtime::spawn_blocking(|| {
                        std::thread::sleep(Duration::from_millis(50))
                    })
                    .await
                    .map_err(|_| "workflow_browser_task_failed")?;
                }
            }
            // Admission is rechecked after waiting. The effect phase is never retried.
            check(app, session, gate)?;
            let expression = format!(
                "{}\nluczorWorkflowBrowser({});",
                include_str!("workflow_browser_script.js"),
                params
            );
            let raw = evaluate(
                &browser,
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
            value
        }
    };
    check(app, session, gate)?;
    if input.action == BrowserOperation::Read {
        use sha2::{Digest, Sha256};
        if let Some(text) = data.get("text").and_then(Value::as_str) {
            let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
            data["contentSha256"] = json!(hash);
        }
        data["retrievedAt"] = json!(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "research_clock_unavailable")?
            .as_millis() as u64);
    }
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

#[path = "workflow_browser_download.rs"]
mod download;

async fn dom_call(
    browser: &Webview,
    params: Value,
    app: AppHandle,
    session: Arc<Session>,
    gate: ExecutionLease,
    timeout: Duration,
) -> Result<Value, String> {
    let expression = format!(
        "{}\nluczorWorkflowBrowser({});",
        include_str!("workflow_browser_script.js"),
        params
    );
    let raw = evaluate(
        browser,
        json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
        app,
        session,
        gate,
        timeout,
    )
    .await?;
    if raw.get("exceptionDetails").is_some() {
        return Err("workflow_browser_action_failed_outcome_unknown".into());
    }
    Ok(raw["result"]["value"].clone())
}

/// State and element refs cannot be overwritten by the visited page's JavaScript.
async fn evaluate(
    browser: &Webview,
    params: Value,
    app: AppHandle,
    session: Arc<Session>,
    gate: ExecutionLease,
    timeout: Duration,
) -> Result<Value, String> {
    #[cfg(windows)]
    let params = {
        let tree = devtools(
            browser,
            "Page.getFrameTree",
            json!({}),
            app.clone(),
            session.clone(),
            gate.clone(),
            timeout,
        )
        .await?;
        let frame = tree["frameTree"]["frame"]["id"]
            .as_str()
            .ok_or("workflow_browser_frame_unavailable")?;
        let world = devtools(browser, "Page.createIsolatedWorld", json!({"frameId":frame,"worldName":"luczor-native-automation","grantUniveralAccess":false}), app.clone(), session.clone(), gate.clone(), timeout).await?;
        let id = world["executionContextId"]
            .as_u64()
            .ok_or("workflow_browser_world_unavailable")?;
        let mut params = params;
        params["contextId"] = json!(id);
        params
    };
    devtools(
        browser,
        "Runtime.evaluate",
        params,
        app,
        session,
        gate,
        timeout,
    )
    .await
}

/// Track actual navigation completion; WebView security and IPC isolation remain unchanged.
#[cfg(windows)]
async fn install_navigation_tracking(
    window: &Webview,
    app: AppHandle,
    session: Arc<Session>,
) -> Result<(), String> {
    use windows_webview::core::PWSTR;
    let (sender, receiver) = mpsc::sync_channel(1);
    let callback_app = app.clone();
    let callback_session = session.clone();
    window
        .with_webview(move |view| {
            let result = (|| {
                check_session(&callback_app, &callback_session)?;
                unsafe {
                    let webview = view
                        .controller()
                        .CoreWebView2()
                        .map_err(|_| "workflow_browser_host_boundary_unavailable")?;
                    let starting_session = callback_session.clone();
                    let starting = webview2_com::NavigationStartingEventHandler::create(Box::new(
                        move |_, args| {
                            if let Some(args) = args {
                                let mut id = 0;
                                let mut uri = PWSTR::null();
                                args.NavigationId(&mut id)?;
                                args.Uri(&mut uri)?;
                                let target = webview2_com::take_pwstr(uri);
                                if let Ok(mut tracker) = starting_session.navigation.lock() {
                                    tracker.started(id, &target);
                                }
                            }
                            Ok(())
                        },
                    ));
                    let completed_session = callback_session.clone();
                    let completed = webview2_com::NavigationCompletedEventHandler::create(
                        Box::new(move |_, args| {
                            if let Some(args) = args {
                                let mut id = 0;
                                let mut success = windows_webview::core::BOOL::default();
                                args.NavigationId(&mut id)?;
                                args.IsSuccess(&mut success)?;
                                if let Ok(mut tracker) = completed_session.navigation.lock() {
                                    tracker.finished(id, success.as_bool());
                                }
                            }
                            Ok(())
                        }),
                    );
                    let mut starting_token = 0;
                    let mut completed_token = 0;
                    webview
                        .add_NavigationStarting(&starting, &mut starting_token)
                        .map_err(|_| "workflow_browser_navigation_tracking_unavailable")?;
                    webview
                        .add_NavigationCompleted(&completed, &mut completed_token)
                        .map_err(|_| "workflow_browser_navigation_tracking_unavailable")?;
                }
                Ok(())
            })();
            let _ = sender.try_send(result);
        })
        .map_err(|_| "workflow_browser_host_boundary_unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            check_session(&app, &session)?;
            match receiver.recv_timeout(Duration::from_millis(40)) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                _ => return Err("workflow_browser_host_boundary_unavailable".into()),
            }
        }
    })
    .await
    .map_err(|_| "workflow_browser_task_failed")?
}
#[cfg(target_os = "linux")]
#[path = "workflow_browser_linux.rs"]
mod linux;
#[cfg(target_os = "linux")]
use linux::{devtools, install_navigation_tracking};
#[cfg(not(any(windows, target_os = "linux")))]
async fn install_navigation_tracking(
    _window: &Webview,
    _app: AppHandle,
    _session: Arc<Session>,
) -> Result<(), String> {
    Err("workflow_browser_host_boundary_unavailable".into())
}

pub(crate) fn capabilities() -> Value {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
        let mut raw = windows_webview::core::PWSTR::null();
        let version = unsafe {
            GetAvailableCoreWebView2BrowserVersionString(
                windows_webview::core::PCWSTR::null(),
                &mut raw,
            )
        }
        .ok()
        .map(|_| webview2_com::take_pwstr(raw))
        .filter(|value| !value.trim().is_empty() && value.len() < 200);
        json!({"available":version.is_some(),"backend":"webview2","version":version,"navigation":"all-http-https-and-local-files","domScan":true,"vision":"explicit-only"})
    }
    #[cfg(target_os = "linux")]
    {
        json!({"available":true,"backend":"webkitgtk","navigation":"all-http-https-and-local-files","domScan":true,"vision":"explicit-only","platformAcceptance":"requires-device-test"})
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        json!({"available":false,"backend":"unavailable","reason":"windows_webview2_required"})
    }
}

#[cfg(windows)]
async fn devtools(
    window: &Webview,
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
#[cfg(not(any(windows, target_os = "linux")))]
async fn devtools(
    _window: &Webview,
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
                research_id: None,
                principal_id: "u".into(),
                project_id: "p".into(),
                expected_root_path: "root".into(),
                expected_workspace_updated_at: 1,
                run_id: uuid::Uuid::new_v4().to_string(),
            },
            busy: AtomicBool::new(false),
            allowed_hosts: None,
            automated: false,
            gate: Mutex::new(None),
            policy_violation: AtomicBool::new(false),
            navigation: Mutex::new(NavigationTracker::default()),
        });
        let guard = lock_session(&session).unwrap();
        assert!(lock_session(&session).is_err());
        drop(guard);
        assert!(lock_session(&session).is_ok());
    }
    #[test]
    fn internal_navigation_accepts_all_domains_and_local_files() {
        assert!(validate_hosts(None, true).is_ok());
        assert!(validate_hosts(Some(&[]), true).is_ok());
        let legacy = vec!["previous.test".to_string()];
        for target in [
            "https://foreign.test/redirect",
            "http://localhost:8080/",
            "https://[::1]:443/",
            "file:///C:/my%20project/index.html",
            "file:///home/user/index.html",
            "about:blank",
        ] {
            assert!(host_allowed(&url(target).unwrap(), Some(&legacy)));
        }
        for target in [
            "javascript:alert(1)",
            "data:text/html,hello",
            "tauri://localhost",
            "https://user:pass@example.com",
        ] {
            assert!(url(target).is_err());
        }
    }

    #[test]
    fn readiness_requires_the_requested_navigation_id_not_an_old_complete_document() {
        let mut tracker = NavigationTracker::default();
        let generation = tracker.begin("https://example.com/new");
        tracker.started(40, "https://example.com/old");
        tracker.finished(40, true);
        assert_eq!(tracker.status(generation).unwrap(), None);
        tracker.started(41, "https://example.com/new");
        tracker.started(41, "https://example.com/redirected");
        tracker.finished(40, true);
        assert_eq!(tracker.status(generation).unwrap(), None);
        tracker.finished(41, true);
        assert_eq!(tracker.status(generation).unwrap(), Some(true));
        let reloaded = tracker.begin("https://example.com/new");
        tracker.finished(41, true);
        assert_eq!(tracker.status(reloaded).unwrap(), None);
        assert!(tracker.status(generation).is_err());
        tracker.started(42, "https://example.com/new");
        tracker.finished(42, false);
        assert_eq!(tracker.status(reloaded).unwrap(), Some(false));
    }

    #[test]
    fn a_superseding_navigation_cannot_confirm_the_requested_document() {
        let mut tracker = NavigationTracker::default();
        let generation = tracker.begin("https://example.com/new");
        tracker.started(50, "https://example.com/new");
        tracker.started(51, "https://example.com/unrequested");
        tracker.finished(51, true);
        tracker.finished(50, true);
        assert_eq!(tracker.status(generation).unwrap(), Some(false));
    }
}
