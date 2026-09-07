use super::{ensure_main_webview, ensure_webview_label};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow};

pub const MINI_LABEL: &str = "luczor-mini";
const ACTION_EVENT: &str = "luczor://mini-action";
const STATE_EVENT: &str = "luczor://mini-state";

#[derive(Default)]
pub struct MiniChatState(pub Mutex<Option<serde_json::Value>>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum MiniAction {
    Ready,
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
    WorkspaceOpen {
        #[serde(rename = "sessionId")]
        session_id: String,
        panel: MiniWorkspacePanel,
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
        | MiniAction::Stop { session_id }
        | MiniAction::Reset { session_id }
        | MiniAction::Decide { session_id, .. }
        | MiniAction::View { session_id, .. }
        | MiniAction::SelectProject { session_id, .. }
        | MiniAction::WorkspaceOpen { session_id, .. } => validate_identifier(session_id)?,
        _ => {}
    }
    if let MiniAction::SelectProject { project_id, .. } = action {
        validate_identifier(project_id)?;
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

fn resize(window: &WebviewWindow, width: f64, height: f64, reset: bool) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("Kein Bildschirm verfügbar.")?;
    let area = monitor.work_area();
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let width = (width * scale).min(f64::from(area.size.width));
    let height = (height * scale).min(f64::from(area.size.height));
    let (x, y) = if reset {
        (
            f64::from(area.position.x) + f64::from(area.size.width) - width - 20.0 * scale,
            f64::from(area.position.y) + f64::from(area.size.height) - height - 20.0 * scale,
        )
    } else {
        (
            f64::from(pos.x) + f64::from(size.width) - width,
            f64::from(pos.y) + f64::from(size.height) - height,
        )
    };
    let (x, y) = fit_position(
        (x, y),
        (width, height),
        (
            f64::from(area.position.x),
            f64::from(area.position.y),
            f64::from(area.size.width),
            f64::from(area.size.height),
        ),
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
            &window,
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
    resize(&window, 148.0, 184.0, true)?;
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mini_chat_open(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    ensure_main_webview(&window)?;
    show(app).await
}

#[tauri::command]
pub fn mini_chat_action(
    window: WebviewWindow,
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
    window: WebviewWindow,
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
    window: WebviewWindow,
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
pub fn mini_chat_drag(window: WebviewWindow) -> Result<(), String> {
    ensure_webview_label(window.label(), MINI_LABEL)?;
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mini_chat_window(
    window: WebviewWindow,
    app: tauri::AppHandle,
    action: MiniWindowAction,
) -> Result<(), String> {
    ensure_webview_label(window.label(), MINI_LABEL)?;
    match action {
        MiniWindowAction::Left
        | MiniWindowAction::Right
        | MiniWindowAction::Up
        | MiniWindowAction::Down => {
            let pos = window.outer_position().map_err(|e| e.to_string())?;
            let scale = window.scale_factor().map_err(|e| e.to_string())?;
            let step = (24.0 * scale) as i32;
            let (dx, dy) = match action {
                MiniWindowAction::Left => (-step, 0),
                MiniWindowAction::Right => (step, 0),
                MiniWindowAction::Up => (0, -step),
                _ => (0, step),
            };
            window
                .set_position(PhysicalPosition::new(pos.x + dx, pos.y + dy))
                .map_err(|e| e.to_string())?;
            let size = window.inner_size().map_err(|e| e.to_string())?;
            resize(
                &window,
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
                false,
            )
        }
        MiniWindowAction::Expand => resize(&window, 420.0, 660.0, false),
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
                .get_webview_window("main")
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
        ] {
            assert!(serde_json::from_value::<MiniAction>(payload).is_err());
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
