//! Detached Chat Playground. Tool execution stays in the trusted main webview;
//! this window can only submit bounded, project-bound requests through that host.
use super::{ensure_main_webview, ensure_webview_label, CallerWebview, MAIN_WEBVIEW_LABEL};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

pub const CHAT_PLAYGROUND_LABEL: &str = "luczor-chat-playground";
pub const ACTION_EVENT: &str = "luczor://chat-playground-action";
pub const REPLY_EVENT: &str = "luczor://chat-playground-reply";
pub const STATE_EVENT: &str = "luczor://chat-playground-state";
pub const CLOSED_EVENT: &str = "luczor://chat-playground-closed";
pub const SESSION_REPLACED_EVENT: &str = "luczor://chat-playground-session-replaced";
const MAX_REQUEST_BYTES: usize = 220_000;
const MAX_REPLY_BYTES: usize = 1_048_576;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlaygroundMode {
    Observe,
    Act,
    Unrestricted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaygroundBinding {
    pub session_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub project_name: String,
    pub workspace_name: String,
    pub workspace_ready: bool,
    pub mode: PlaygroundMode,
    pub kill_switch: bool,
}

#[derive(Default)]
pub struct ChatPlaygroundState(pub Mutex<Option<PlaygroundBinding>>);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaygroundRuntime {
    Node,
    Python,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaygroundBrowserAction {
    Status,
    Open,
    Navigate,
    Close,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum PlaygroundAction {
    FilesList {
        path: String,
    },
    FilesRead {
        path: String,
    },
    TerminalRun {
        runtime: PlaygroundRuntime,
        code: String,
        #[serde(rename = "timeoutSeconds")]
        timeout_seconds: u16,
    },
    Browser {
        action: PlaygroundBrowserAction,
        #[serde(default)]
        url: Option<String>,
    },
    BindFolder,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaygroundRequest {
    pub session_id: String,
    pub request_id: String,
    pub action: PlaygroundAction,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRequest {
    pub session_id: String,
    pub request_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub action: PlaygroundAction,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaygroundReply {
    pub session_id: String,
    pub request_id: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenPayload {
    pub project_id: String,
    #[serde(default)]
    pub conversation_id: String,
    pub project_name: String,
    #[serde(default)]
    pub workspace_name: String,
    pub workspace_ready: bool,
    pub mode: PlaygroundMode,
    pub kill_switch: bool,
}

fn valid_id(value: &str, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= 200
        && !value.chars().any(char::is_control)
}

fn validate_binding(binding: &PlaygroundBinding) -> Result<(), String> {
    if !valid_id(&binding.project_id, false)
        || !valid_id(&binding.conversation_id, true)
        || !valid_id(&binding.project_name, false)
        || !valid_id(&binding.workspace_name, true)
        || uuid::Uuid::parse_str(&binding.session_id).is_err()
    {
        return Err("Chat-Playground-Zuordnung ungültig.".into());
    }
    Ok(())
}

fn validate_action(action: &PlaygroundAction) -> Result<(), String> {
    let encoded = serde_json::to_vec(action).map_err(|_| "Playground-Aktion ungültig")?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err("Playground-Aktion ist zu groß.".into());
    }
    match action {
        PlaygroundAction::FilesList { path } | PlaygroundAction::FilesRead { path } => {
            if path.is_empty() || path.len() > 1_024 || path.chars().any(char::is_control) {
                return Err("Projektpfad ungültig.".into());
            }
        }
        PlaygroundAction::TerminalRun {
            code,
            timeout_seconds,
            ..
        } => {
            if code.trim().is_empty() || code.chars().count() > 200_000 {
                return Err("Der Projektlauf benötigt Code mit höchstens 200000 Zeichen.".into());
            }
            if !(1..=30).contains(timeout_seconds) {
                return Err("Die Laufzeit muss zwischen 1 und 30 Sekunden liegen.".into());
            }
        }
        PlaygroundAction::Browser { action, url } => {
            let needs_url = matches!(
                action,
                PlaygroundBrowserAction::Open | PlaygroundBrowserAction::Navigate
            );
            if needs_url != url.as_ref().is_some_and(|value| !value.trim().is_empty()) {
                return Err("Browser-Adresse fehlt oder ist für diese Aktion unzulässig.".into());
            }
            if url
                .as_ref()
                .is_some_and(|value| value.len() > 2_048 || value.chars().any(char::is_control))
            {
                return Err("Browser-Adresse ungültig.".into());
            }
        }
        PlaygroundAction::BindFolder => {}
    }
    Ok(())
}

fn binding(state: &ChatPlaygroundState, session_id: &str) -> Result<PlaygroundBinding, String> {
    let binding = state
        .0
        .lock()
        .map_err(|_| "Chat Playground nicht verfügbar.")?
        .clone()
        .ok_or("Chat Playground ist nicht gebunden.")?;
    if binding.session_id != session_id {
        return Err("Diese Chat-Playground-Sitzung ist abgelaufen.".into());
    }
    Ok(binding)
}

pub fn open(
    app: &AppHandle,
    state: &ChatPlaygroundState,
    payload: OpenPayload,
) -> Result<PlaygroundBinding, String> {
    if !valid_id(&payload.project_id, false)
        || !valid_id(&payload.conversation_id, true)
        || !valid_id(&payload.project_name, false)
        || !valid_id(&payload.workspace_name, true)
    {
        return Err("Chat-Playground-Zuordnung ungültig.".into());
    }
    let previous = state
        .0
        .lock()
        .map_err(|_| "Chat Playground nicht verfügbar.")?
        .clone();
    let same_context = previous.as_ref().is_some_and(|previous| {
        previous.project_id == payload.project_id
            && previous.conversation_id == payload.conversation_id
    });
    let binding = PlaygroundBinding {
        session_id: previous
            .as_ref()
            .filter(|_| same_context)
            .map(|previous| previous.session_id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        project_id: payload.project_id,
        conversation_id: payload.conversation_id,
        project_name: payload.project_name,
        workspace_name: payload.workspace_name,
        workspace_ready: payload.workspace_ready,
        mode: payload.mode,
        kill_switch: payload.kill_switch,
    };
    validate_binding(&binding)?;
    *state
        .0
        .lock()
        .map_err(|_| "Chat Playground nicht verfügbar.")? = Some(binding.clone());
    if let Some(previous) = previous.filter(|_| !same_context) {
        let _ = app.emit_to(
            tauri::EventTarget::webview_window(MAIN_WEBVIEW_LABEL),
            SESSION_REPLACED_EVENT,
            previous.clone(),
        );
        if super::workflow_browser::panel_project_id().as_deref()
            == Some(previous.project_id.as_str())
        {
            let _ = super::workflow_browser::stop_all(app);
        }
    }

    if let Some(window) = app.get_webview_window(CHAT_PLAYGROUND_LABEL) {
        window
            .set_title(&format!("Chat Playground · {}", binding.project_name))
            .map_err(|e| e.to_string())?;
        window
            .emit(STATE_EVENT, binding.clone())
            .map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(binding);
    }

    WebviewWindowBuilder::new(
        app,
        CHAT_PLAYGROUND_LABEL,
        WebviewUrl::App("index.html#chat-playground".into()),
    )
    .title(&format!("Chat Playground · {}", binding.project_name))
    .inner_size(1_180.0, 780.0)
    .min_inner_size(560.0, 420.0)
    .resizable(true)
    .maximizable(true)
    .minimizable(true)
    .decorations(true)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?
    .show()
    .map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window(CHAT_PLAYGROUND_LABEL) {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(binding)
}

#[tauri::command]
pub fn chat_playground_window_open(
    window: CallerWebview,
    app: AppHandle,
    state: State<'_, ChatPlaygroundState>,
    payload: OpenPayload,
) -> Result<PlaygroundBinding, String> {
    ensure_main_webview(&window)?;
    open(&app, &state, payload)
}

#[tauri::command]
pub fn chat_playground_snapshot(
    window: CallerWebview,
    state: State<'_, ChatPlaygroundState>,
) -> Result<Option<PlaygroundBinding>, String> {
    ensure_webview_label(window.label(), CHAT_PLAYGROUND_LABEL)?;
    Ok(state
        .0
        .lock()
        .map_err(|_| "Chat Playground nicht verfügbar.")?
        .clone())
}

#[tauri::command]
pub fn chat_playground_action(
    window: CallerWebview,
    app: AppHandle,
    state: State<'_, ChatPlaygroundState>,
    payload: PlaygroundRequest,
) -> Result<(), String> {
    ensure_webview_label(window.label(), CHAT_PLAYGROUND_LABEL)?;
    if uuid::Uuid::parse_str(&payload.request_id).is_err() {
        return Err("Playground-Anfrage ungültig.".into());
    }
    validate_action(&payload.action)?;
    let bound = binding(&state, &payload.session_id)?;
    app.emit_to(
        tauri::EventTarget::webview_window(MAIN_WEBVIEW_LABEL),
        ACTION_EVENT,
        HostRequest {
            session_id: bound.session_id,
            request_id: payload.request_id,
            project_id: bound.project_id,
            conversation_id: bound.conversation_id,
            action: payload.action,
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_playground_respond(
    window: CallerWebview,
    app: AppHandle,
    state: State<'_, ChatPlaygroundState>,
    payload: PlaygroundReply,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let bound = binding(&state, &payload.session_id)?;
    if uuid::Uuid::parse_str(&payload.request_id).is_err()
        || payload
            .result
            .as_ref()
            .is_some_and(|value| value.to_string().len() > MAX_REPLY_BYTES)
        || payload
            .error
            .as_ref()
            .is_some_and(|error| error.chars().count() > 4_000)
        || (payload.result.is_some() == payload.error.is_some())
    {
        return Err("Playground-Antwort ungültig.".into());
    }
    app.emit_to(
        tauri::EventTarget::webview_window(CHAT_PLAYGROUND_LABEL),
        REPLY_EVENT,
        serde_json::json!({"sessionId": bound.session_id, "requestId": payload.request_id, "result": payload.result, "error": payload.error}),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_playground_window_close(
    window: CallerWebview,
    state: State<'_, ChatPlaygroundState>,
    session_id: String,
) -> Result<(), String> {
    ensure_webview_label(window.label(), CHAT_PLAYGROUND_LABEL)?;
    let _bound = binding(&state, &session_id)?;
    window.close().map_err(|e| e.to_string())
}

pub fn on_window_destroyed(app: &AppHandle, state: &ChatPlaygroundState) {
    let binding = state.0.lock().ok().and_then(|mut state| state.take());
    if let Some(binding) = binding {
        if super::workflow_browser::panel_project_id().as_deref()
            == Some(binding.project_id.as_str())
        {
            let _ = super::workflow_browser::stop_all(app);
        }
        let _ = app.emit_to(
            tauri::EventTarget::webview_window(MAIN_WEBVIEW_LABEL),
            CLOSED_EVENT,
            binding,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_contract_is_narrow_bounded_and_rejects_unknown_fields() {
        let fs: PlaygroundAction =
            serde_json::from_value(serde_json::json!({"type":"files_list","path":"."})).unwrap();
        assert!(validate_action(&fs).is_ok());
        let run: PlaygroundAction = serde_json::from_value(serde_json::json!({"type":"terminal_run","runtime":"node","code":"console.log(1)","timeoutSeconds":30})).unwrap();
        assert!(validate_action(&run).is_ok());
        assert!(serde_json::from_value::<PlaygroundAction>(serde_json::json!({"type":"terminal_run","runtime":"powershell","code":"whoami","timeoutSeconds":30})).is_err());
        assert!(serde_json::from_value::<PlaygroundAction>(
            serde_json::json!({"type":"files_read","path":"x","projectId":"foreign"})
        )
        .is_err());
        let bad: PlaygroundAction = serde_json::from_value(serde_json::json!({"type":"terminal_run","runtime":"python","code":"print(1)","timeoutSeconds":600})).unwrap();
        assert!(validate_action(&bad).is_err());
    }

    #[test]
    fn browser_actions_require_a_url_only_for_navigation() {
        let status: PlaygroundAction =
            serde_json::from_value(serde_json::json!({"type":"browser","action":"status"}))
                .unwrap();
        assert!(validate_action(&status).is_ok());
        let open: PlaygroundAction = serde_json::from_value(
            serde_json::json!({"type":"browser","action":"open","url":"https://example.com"}),
        )
        .unwrap();
        assert!(validate_action(&open).is_ok());
        assert!(serde_json::from_value::<PlaygroundAction>(serde_json::json!({"type":"browser","action":"navigate","url":"https://example.com","path":"."})).is_err());
    }

    #[test]
    fn playground_client_capability_does_not_expose_execution_commands() {
        let capability: Value =
            serde_json::from_str(include_str!("../../capabilities/chat-playground.json")).unwrap();
        assert_eq!(
            capability["windows"],
            serde_json::json!([CHAT_PLAYGROUND_LABEL])
        );
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "core:default",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "chat-playground-client"
            ])
        );
        let perms = include_str!("../../permissions/chat-playground.toml");
        assert!(!perms.contains("wf_run_script"));
        assert!(!perms.contains("project_fs_read"));
        assert!(!perms.contains("wf_browser_action"));
    }
}
