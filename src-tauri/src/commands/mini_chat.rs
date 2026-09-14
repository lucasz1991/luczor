use super::{ensure_main_webview, ensure_webview_label};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl};

pub const MINI_LABEL: &str = "luczor-mini";
const ACTION_EVENT: &str = "luczor://mini-action";
const STATE_EVENT: &str = "luczor://mini-state";

#[derive(Default)]
pub struct MiniChatState(pub Mutex<Option<serde_json::Value>>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum MiniAction {
    Ready,
    ThinkingTier {
        #[serde(rename = "sessionId")]
        session_id: String,
        tier: MiniThinkingTier,
    },
    ThinkingControl {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "controlId")]
        control_id: String,
        action: MiniThinkingControl,
        sequence: u64,
    },
    AgentMode {
        #[serde(rename = "sessionId")]
        session_id: String,
        enabled: bool,
    },
    VoicePushToTalk {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    VoiceWakeWord {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Send {
        #[serde(rename = "sessionId")]
        session_id: String,
        text: String,
    },
    Stop {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Reset {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Decide {
        #[serde(rename = "sessionId")]
        session_id: String,
        id: String,
        approved: bool,
    },
    Mode {
        mode: MiniMode,
    },
    View {
        #[serde(rename = "sessionId")]
        session_id: String,
        view: MiniView,
    },
    SelectProject {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
    },
    SelectConversation {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "conversationId")]
        conversation_id: String,
    },
    NewConversation {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
    },
    WorkspaceOpen {
        #[serde(rename = "sessionId")]
        session_id: String,
        panel: MiniWorkspacePanel,
    },
    WorkflowOpen {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(rename = "workflowId")]
        workflow_id: u64,
    },
    WorkflowImprove {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(rename = "workflowId")]
        workflow_id: u64,
    },
    WorkflowAction {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(rename = "workflowId")]
        workflow_id: u64,
        action: MiniWorkflowAction,
    },
    MainDecide {
        id: String,
        approved: bool,
    },
    KillSwitch {
        enabled: bool,
    },
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MiniMode {
    Observe,
    Act,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MiniThinkingTier {
    Fast,
    Balanced,
    Thorough,
    Max,
    Ultra,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MiniThinkingControl {
    More,
    Answer,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MiniWorkflowAction {
    Test,
    Start,
    Stop,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MiniView {
    Chat,
    Workspace,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MiniWorkspacePanel {
    Agents,
    ProjectFolder,
    Desktop,
    Planning,
    Workflows,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MiniWindowAction {
    Expand,
    Collapse,
    Peek,
    Hide,
    Pin,
    Unpin,
    Main,
    ResetPosition,
    Left,
    Right,
    Up,
    Down,
}

fn validate_action(action: &MiniAction) -> Result<(), String> {
    let encoded = serde_json::to_vec(action).map_err(|_| "Invalid mini chat action")?;
    if encoded.len() > 50_000 {
        return Err("Mini chat action is too large.".into());
    }
    match action {
        MiniAction::Send { session_id, .. }
        | MiniAction::ThinkingTier { session_id, .. }
        | MiniAction::ThinkingControl { session_id, .. }
        | MiniAction::AgentMode { session_id, .. }
        | MiniAction::VoicePushToTalk { session_id }
        | MiniAction::VoiceWakeWord { session_id }
        | MiniAction::Stop { session_id }
        | MiniAction::Reset { session_id }
        | MiniAction::Decide { session_id, .. }
        | MiniAction::View { session_id, .. }
        | MiniAction::SelectProject { session_id, .. }
        | MiniAction::SelectConversation { session_id, .. }
        | MiniAction::NewConversation { session_id, .. }
        | MiniAction::WorkflowOpen { session_id, .. }
        | MiniAction::WorkflowImprove { session_id, .. }
        | MiniAction::WorkflowAction { session_id, .. }
        | MiniAction::WorkspaceOpen { session_id, .. } => validate_identifier(session_id)?,
        _ => {}
    }
    if let MiniAction::SelectProject { project_id, .. }
    | MiniAction::SelectConversation { project_id, .. }
    | MiniAction::NewConversation { project_id, .. } = action
    {
        validate_identifier(project_id)?;
    }
    if let MiniAction::SelectConversation {
        conversation_id, ..
    } = action
    {
        validate_identifier(conversation_id)?;
    }
    if let MiniAction::ThinkingControl {
        request_id,
        control_id,
        sequence,
        ..
    } = action
    {
        validate_identifier(request_id)?;
        validate_identifier(control_id)?;
        if *sequence > 9_007_199_254_740_991 {
            return Err("Invalid budget sequence.".into());
        }
    }
    if let MiniAction::WorkflowOpen {
        message_id,
        workflow_id,
        ..
    }
    | MiniAction::WorkflowImprove {
        message_id,
        workflow_id,
        ..
    }
    | MiniAction::WorkflowAction {
        message_id,
        workflow_id,
        ..
    } = action
    {
        validate_identifier(message_id)?;
        if *workflow_id == 0 || *workflow_id > 9_007_199_254_740_991 {
            return Err("Invalid mini workflow identifier.".into());
        }
    }
    if let MiniAction::Send { text, .. } = action {
        if text.trim().is_empty() || text.chars().count() > 12_000 {
            return Err("Die Nachricht muss zwischen 1 und 12000 Zeichen enthalten.".into());
        }
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > 200 {
        return Err("Invalid mini chat identifier.".into());
    }
    Ok(())
}

fn fit_position(position: (f64, f64), size: (f64, f64), area: (f64, f64, f64, f64)) -> (f64, f64) {
    let (x, y) = position;
    let (width, height) = size;
    let (left, top, area_width, area_height) = area;
    (
        x.clamp(left, left + (area_width - width).max(0.0)),
        y.clamp(top, top + (area_height - height).max(0.0)),
    )
}

/// Which screen edge the nudge is flush against.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Edge {
    Left,
    Right,
}
impl Edge {
    fn as_str(self) -> &'static str {
        match self {
            Edge::Left => "left",
            Edge::Right => "right",
        }
    }
}

/// Nearer edge for a window whose horizontal center sits at `center_x` within a monitor
/// work area starting at `area_left` and `area_width` wide.
fn edge_side(center_x: f64, area_left: f64, area_width: f64) -> Edge {
    if center_x < area_left + area_width / 2.0 {
        Edge::Left
    } else {
        Edge::Right
    }
}

/// The x position that puts a window of `width` flush against `edge`, no margin.
fn edge_flush_x(edge: Edge, width: f64, area_left: f64, area_width: f64) -> f64 {
    match edge {
        Edge::Left => area_left,
        Edge::Right => area_left + area_width - width,
    }
}

/// (left, top, width, height) of the window's current monitor work area, in physical pixels.
fn work_area(window: &tauri::Window) -> Result<(f64, f64, f64, f64), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("Kein Bildschirm verfügbar.")?;
    let area = monitor.work_area();
    Ok((
        f64::from(area.position.x),
        f64::from(area.position.y),
        f64::from(area.size.width),
        f64::from(area.size.height),
    ))
}

/// Flush the window against `edge` (x) and offset it by `dy` (y, clamped to the monitor), keeping
/// its current size. Used for the arrow-key nudge and for settling after a native drag.
fn snap_to_edge(window: &tauri::Window, edge: Edge, dy: i32) -> Result<(), String> {
    let (area_left, area_top, area_width, area_height) = work_area(window)?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let x = edge_flush_x(edge, f64::from(size.width), area_left, area_width);
    let y = f64::from(pos.y + dy);
    let (x, y) = fit_position(
        (x, y),
        (f64::from(size.width), f64::from(size.height)),
        (area_left, area_top, area_width, area_height),
    );
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|e| e.to_string())
}

fn resize(window: &tauri::Window, width: f64, height: f64, reset: bool) -> Result<(), String> {
    let (area_left, area_top, area_width, area_height) = work_area(window)?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let width = (width * scale).min(area_width);
    let height = (height * scale).min(area_height);
    // Reset always lands on the right edge (the nudge's default side); otherwise stay on
    // whichever edge the window is already nearest to — every resize keeps it flush, no margin.
    let edge = if reset {
        Edge::Right
    } else {
        edge_side(
            f64::from(pos.x) + f64::from(size.width) / 2.0,
            area_left,
            area_width,
        )
    };
    let x = edge_flush_x(edge, width, area_left, area_width);
    let y = if reset {
        area_top + area_height - height - 20.0 * scale
    } else {
        f64::from(pos.y) + f64::from(size.height) - height
    };
    let (x, y) = fit_position(
        (x, y),
        (width, height),
        (area_left, area_top, area_width, area_height),
    );
    window
        .set_size(PhysicalSize::new(
            width.round() as u32,
            height.round() as u32,
        ))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|e| e.to_string())
}

pub async fn show(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MINI_LABEL) {
        // Recover a widget left on a disconnected monitor.
        let size = window.inner_size().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        resize(
            &window.as_ref().window(),
            f64::from(size.width) / scale,
            f64::from(size.height) / scale,
            false,
        )?;
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        MINI_LABEL,
        WebviewUrl::App("index.html#mini-chat".into()),
    )
    .title("Luczor Mini")
    .inner_size(148.0, 184.0)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .disable_drag_drop_handler()
    .build()
    .map_err(|e| e.to_string())?;
    resize(&window.as_ref().window(), 148.0, 184.0, true)?;
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mini_chat_open(
    window: crate::commands::CallerWebview,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    show(app).await
}

#[tauri::command]
pub fn mini_chat_action(
    window: crate::commands::CallerWebview,
    app: tauri::AppHandle,
    action: MiniAction,
) -> Result<(), String> {
    ensure_webview_label(window.label(), MINI_LABEL)?;
    validate_action(&action)?;
    app.emit_to(
        tauri::EventTarget::webview_window("main"),
        ACTION_EVENT,
        action,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mini_chat_publish(
    window: crate::commands::CallerWebview,
    app: tauri::AppHandle,
    state: State<'_, MiniChatState>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    if !snapshot.is_object() || snapshot.to_string().len() > 1_048_576 {
        return Err("Invalid mini chat snapshot.".into());
    }
    *state.0.lock().map_err(|_| "Mini chat state unavailable")? = Some(snapshot.clone());
    app.emit_to(
        tauri::EventTarget::webview_window(MINI_LABEL),
        STATE_EVENT,
        snapshot,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mini_chat_snapshot(
    window: crate::commands::CallerWebview,
    state: State<'_, MiniChatState>,
) -> Result<Option<serde_json::Value>, String> {
    ensure_webview_label(window.label(), MINI_LABEL)?;
    Ok(state
        .0
        .lock()
        .map_err(|_| "Mini chat state unavailable")?
        .clone())
}

#[tauri::command]
pub fn mini_chat_drag(window: crate::commands::CallerWebview) -> Result<(), String> {
    ensure_webview_label(window.label(), MINI_LABEL)?;
    window.start_dragging().map_err(|e| e.to_string())
}

/// Called by the frontend once a native drag settles (its own move events go quiet). Flushes the
/// window against whichever screen edge it ended up nearest to and reports that edge, so the
/// capsule can mirror its rounded corners and fly-out direction onto the correct side.
#[tauri::command]
pub fn mini_chat_snap(window: crate::commands::CallerWebview) -> Result<String, String> {
    ensure_webview_label(window.label(), MINI_LABEL)?;
    let (area_left, _, area_width, _) = work_area(&window)?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let edge = edge_side(
        f64::from(pos.x) + f64::from(size.width) / 2.0,
        area_left,
        area_width,
    );
    snap_to_edge(&window, edge, 0)?;
    Ok(edge.as_str().to_string())
}

#[tauri::command]
pub fn mini_chat_window(
    window: crate::commands::CallerWebview,
    app: tauri::AppHandle,
    action: MiniWindowAction,
) -> Result<(), String> {
    ensure_webview_label(window.label(), MINI_LABEL)?;
    match action {
        // The nudge is edge-locked: Left/Right jump it to that screen edge outright, Up/Down
        // nudge it along the edge it is already on (re-flushing x in case it drifted).
        MiniWindowAction::Left | MiniWindowAction::Right => {
            let edge = if matches!(action, MiniWindowAction::Left) {
                Edge::Left
            } else {
                Edge::Right
            };
            snap_to_edge(&window, edge, 0)
        }
        MiniWindowAction::Up | MiniWindowAction::Down => {
            let scale = window.scale_factor().map_err(|e| e.to_string())?;
            let step = (24.0 * scale) as i32;
            let pos = window.outer_position().map_err(|e| e.to_string())?;
            let size = window.outer_size().map_err(|e| e.to_string())?;
            let (area_left, _, area_width, _) = work_area(&window)?;
            let edge = edge_side(
                f64::from(pos.x) + f64::from(size.width) / 2.0,
                area_left,
                area_width,
            );
            let dy = if matches!(action, MiniWindowAction::Up) {
                -step
            } else {
                step
            };
            snap_to_edge(&window, edge, dy)
        }
        // Wider than before: the grip icons stay visible to the right of the expanded chat page.
        MiniWindowAction::Expand => resize(&window, 480.0, 640.0, false),
        MiniWindowAction::Collapse => resize(&window, 148.0, 184.0, false),
        MiniWindowAction::Peek => resize(&window, 380.0, 370.0, false),
        MiniWindowAction::Hide => window.hide().map_err(|e| e.to_string()),
        MiniWindowAction::Pin => window.set_always_on_top(true).map_err(|e| e.to_string()),
        MiniWindowAction::Unpin => window.set_always_on_top(false).map_err(|e| e.to_string()),
        MiniWindowAction::ResetPosition => {
            let size = window.inner_size().map_err(|e| e.to_string())?;
            let scale = window.scale_factor().map_err(|e| e.to_string())?;
            resize(
                &window,
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
                true,
            )
        }
        MiniWindowAction::Main => {
            let main = app
                .get_window("main")
                .ok_or("Hauptfenster nicht verfügbar.")?;
            main.show().map_err(|e| e.to_string())?;
            main.unminimize().map_err(|e| e.to_string())?;
            main.set_focus().map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unrecognized_actions_modes_and_oversized_input() {
        assert!(
            serde_json::from_str::<MiniAction>(r#"{"type":"execute","command":"whoami"}"#).is_err()
        );
        assert!(
            serde_json::from_str::<MiniAction>(r#"{"type":"mode","mode":"unrestricted"}"#).is_err()
        );
        assert!(validate_action(&MiniAction::Send {
            session_id: "a".into(),
            text: " ".into()
        })
        .is_err());
        assert!(validate_action(&MiniAction::Send {
            session_id: "a".into(),
            text: "x".repeat(12001)
        })
        .is_err());
    }
    #[test]
    fn accepts_workspace_actions_and_preserves_the_wire_format() {
        for payload in [
            serde_json::json!({"type": "view", "sessionId": "session", "view": "chat"}),
            serde_json::json!({"type": "view", "sessionId": "session", "view": "workspace"}),
            serde_json::json!({"type": "select_project", "sessionId": "session", "projectId": "project"}),
            serde_json::json!({"type": "workspace_open", "sessionId": "session", "panel": "agents"}),
            serde_json::json!({"type": "workspace_open", "sessionId": "session", "panel": "project_folder"}),
            serde_json::json!({"type": "workspace_open", "sessionId": "session", "panel": "desktop"}),
            serde_json::json!({"type": "workspace_open", "sessionId": "session", "panel": "planning"}),
            serde_json::json!({"type": "workspace_open", "sessionId": "session", "panel": "workflows"}),
            serde_json::json!({"type": "workflow_open", "sessionId": "session", "messageId": "message", "workflowId": 7}),
            serde_json::json!({"type": "workflow_improve", "sessionId": "session", "messageId": "message", "workflowId": 7}),
            serde_json::json!({"type": "workflow_action", "sessionId": "session", "messageId": "message", "workflowId": 7, "action": "test"}),
            serde_json::json!({"type": "workflow_action", "sessionId": "session", "messageId": "message", "workflowId": 7, "action": "start"}),
            serde_json::json!({"type": "workflow_action", "sessionId": "session", "messageId": "message", "workflowId": 7, "action": "stop"}),
        ] {
            let action = serde_json::from_value::<MiniAction>(payload.clone()).unwrap();
            assert!(validate_action(&action).is_ok());
            assert_eq!(serde_json::to_value(action).unwrap(), payload);
        }
    }
    #[test]
    fn rejects_unknown_workspace_values_and_extra_fields() {
        for payload in [
            serde_json::json!({"type": "view", "sessionId": "session", "view": "unrestricted"}),
            serde_json::json!({"type": "workspace_open", "sessionId": "session", "panel": "shell"}),
            serde_json::json!({"type": "view", "sessionId": "session", "view": "chat", "command": "whoami"}),
            serde_json::json!({"type": "select_project", "sessionId": "session", "projectId": "project", "path": "C:/"}),
            serde_json::json!({"type": "workspace_open", "sessionId": "session", "panel": "desktop", "approved": true}),
            serde_json::json!({"type": "workflow_open", "sessionId": "session", "messageId": "message", "workflowId": 7, "projectId": "foreign"}),
            serde_json::json!({"type": "workflow_improve", "sessionId": "session", "messageId": "message", "workflowId": 7, "text": "injected"}),
            serde_json::json!({"type": "workflow_action", "sessionId": "session", "messageId": "message", "workflowId": 7, "action": "shell"}),
            serde_json::json!({"type": "workflow_action", "sessionId": "session", "messageId": "message", "workflowId": 7, "action": "start", "approved": true}),
            serde_json::json!({"type": "workflow_action", "sessionId": "session", "messageId": "message", "workflowId": 7, "action": "stop", "runId": "foreign"}),
        ] {
            assert!(serde_json::from_value::<MiniAction>(payload).is_err());
        }
    }
    #[test]
    fn thinking_control_requires_bounded_ack_identity_and_roundtrips_exactly() {
        let payload = serde_json::json!({"type":"thinking_control","sessionId":"session",
            "requestId":"generation","controlId":"control-1","action":"answer","sequence":7});
        let action: MiniAction = serde_json::from_value(payload.clone()).unwrap();
        assert!(validate_action(&action).is_ok());
        assert_eq!(serde_json::to_value(action).unwrap(), payload);
        let mut missing = payload.clone();
        missing.as_object_mut().unwrap().remove("controlId");
        assert!(serde_json::from_value::<MiniAction>(missing).is_err());
        for id in [String::new(), "x".repeat(201)] {
            let mut changed = payload.clone();
            changed["controlId"] = serde_json::json!(id);
            let action: MiniAction = serde_json::from_value(changed).unwrap();
            assert!(validate_action(&action).is_err());
        }
    }
    #[test]
    fn rejects_empty_and_oversized_identifiers_for_all_session_actions() {
        for session_id in [String::new(), " ".into(), "x".repeat(201)] {
            for payload in [
                serde_json::json!({"type": "send", "sessionId": session_id, "text": "Hello"}),
                serde_json::json!({"type": "stop", "sessionId": session_id}),
                serde_json::json!({"type": "reset", "sessionId": session_id}),
                serde_json::json!({"type": "decide", "sessionId": session_id, "id": "decision", "approved": false}),
                serde_json::json!({"type": "view", "sessionId": session_id, "view": "chat"}),
                serde_json::json!({"type": "select_project", "sessionId": session_id, "projectId": "project"}),
                serde_json::json!({"type": "workspace_open", "sessionId": session_id, "panel": "agents"}),
                serde_json::json!({"type": "workflow_open", "sessionId": session_id, "messageId": "message", "workflowId": 7}),
                serde_json::json!({"type": "workflow_improve", "sessionId": session_id, "messageId": "message", "workflowId": 7}),
                serde_json::json!({"type": "workflow_action", "sessionId": session_id, "messageId": "message", "workflowId": 7, "action": "start"}),
            ] {
                let action = serde_json::from_value::<MiniAction>(payload).unwrap();
                assert!(validate_action(&action).is_err());
            }
        }
        for project_id in [String::new(), " ".into(), "x".repeat(201)] {
            assert!(validate_action(&MiniAction::SelectProject {
                session_id: "session".into(),
                project_id,
            })
            .is_err());
        }
        assert!(validate_action(&MiniAction::SelectProject {
            session_id: "s".repeat(200),
            project_id: "ä".repeat(200),
        })
        .is_ok());
    }
    #[test]
    fn rejects_workflow_actions_with_invalid_card_identifiers() {
        for workflow_id in [0, 9_007_199_254_740_992] {
            assert!(validate_action(&MiniAction::WorkflowOpen {
                session_id: "session".into(),
                message_id: "message".into(),
                workflow_id,
            })
            .is_err());
            assert!(validate_action(&MiniAction::WorkflowAction {
                session_id: "session".into(),
                message_id: "message".into(),
                workflow_id,
                action: MiniWorkflowAction::Start,
            })
            .is_err());
        }
        assert!(validate_action(&MiniAction::WorkflowImprove {
            session_id: "session".into(),
            message_id: " ".into(),
            workflow_id: 1,
        })
        .is_err());
        assert!(validate_action(&MiniAction::WorkflowAction {
            session_id: "session".into(),
            message_id: " ".into(),
            workflow_id: 1,
            action: MiniWorkflowAction::Stop,
        })
        .is_err());
    }
    #[test]
    fn retains_the_serialized_action_size_limit() {
        let action = MiniAction::Send {
            session_id: "session".into(),
            text: "\u{0000}".repeat(10_000),
        };
        assert!(validate_action(&action).is_err());
    }
    #[test]
    fn positions_stay_on_work_area_with_negative_monitor_coordinates() {
        assert_eq!(
            fit_position(
                (-3000.0, 1200.0),
                (420.0, 660.0),
                (-1920.0, 0.0, 1920.0, 1040.0)
            ),
            (-1920.0, 380.0)
        );
        assert_eq!(
            fit_position((500.0, 500.0), (420.0, 660.0), (0.0, 0.0, 320.0, 480.0)),
            (0.0, 0.0)
        );
    }
    #[test]
    fn mini_cannot_access_main_runtime_or_store_or_emit_events() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/mini-chat.json")).unwrap();
        assert_eq!(caps["windows"], serde_json::json!([MINI_LABEL]));
        assert_eq!(
            caps["permissions"],
            serde_json::json!([
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "mini-chat-client"
            ])
        );
        assert!(ensure_webview_label("luczor-browser", MINI_LABEL).is_err());
        assert!(ensure_webview_label("main", MINI_LABEL).is_err());
        assert!(ensure_webview_label(MINI_LABEL, "main").is_err());
    }
}
