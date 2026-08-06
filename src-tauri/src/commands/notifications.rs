use notify_rust::{Notification, NotificationResponse, Urgency};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub const NATIVE_NOTIFICATION_ACTION_EVENT: &str = "luczor://notification-action";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeNotificationPayload {
    notification_id: String,
    title: String,
    body: String,
    category: String,
    priority: String,
    action_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeNotificationAction {
    notification_id: String,
    action_url: Option<String>,
}

/// Desktop notification bridge with a real activation callback.
///
/// The official Tauri notification plugin is still used for the permission
/// contract. Its desktop transport intentionally discards notification action
/// metadata, so this bridge uses the same underlying native library and keeps
/// the handle alive until the toast is activated or dismissed.
#[tauri::command]
pub fn show_native_notification(
    app: AppHandle,
    payload: NativeNotificationPayload,
) -> Result<(), String> {
    validate_payload(&payload)?;

    let mut notification = Notification::new();
    notification
        .appname("Luczor")
        .summary(&payload.title)
        .subtitle(&payload.category)
        .body(&payload.body)
        .action("default", "Öffnen");

    #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
    notification.urgency(if payload.priority == "low" {
        Urgency::Low
    } else {
        Urgency::Normal
    });

    #[cfg(target_os = "windows")]
    set_windows_app_id_when_installed(&app, &mut notification);

    #[cfg(target_os = "macos")]
    {
        let application = if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            app.config().identifier.as_str()
        };
        let _ = notify_rust::set_application(application);
    }

    let handle = notification.show().map_err(|error| {
        format!("Native Benachrichtigung konnte nicht angezeigt werden: {error}")
    })?;
    let action = NativeNotificationAction {
        notification_id: payload.notification_id,
        action_url: payload
            .action_url
            .filter(|url| url.starts_with("luczor://")),
    };

    tauri::async_runtime::spawn_blocking(move || {
        let _ = handle.wait_for_response(move |response: &NotificationResponse| {
            let activated = matches!(response, NotificationResponse::Default)
                || matches!(
                    response,
                    NotificationResponse::Action(identifier)
                        if identifier == "default" || identifier == "open"
                );
            if !activated {
                return;
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit(NATIVE_NOTIFICATION_ACTION_EVENT, action);
        });
    });

    Ok(())
}

fn validate_payload(payload: &NativeNotificationPayload) -> Result<(), String> {
    if payload.notification_id.trim().is_empty() || payload.notification_id.len() > 160 {
        return Err("Ungültige Benachrichtigungs-ID.".into());
    }
    if payload.title.trim().is_empty() || payload.title.len() > 160 {
        return Err("Ungültiger Benachrichtigungstitel.".into());
    }
    if payload.body.len() > 2_000 {
        return Err("Benachrichtigungstext ist zu lang.".into());
    }
    if !matches!(
        payload.category.as_str(),
        "general" | "agent" | "workflow" | "device" | "security"
    ) {
        return Err("Ungültige Benachrichtigungskategorie.".into());
    }
    if !matches!(payload.priority.as_str(), "low" | "normal" | "high") {
        return Err("Ungültige Benachrichtigungspriorität.".into());
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn set_windows_app_id_when_installed(app: &AppHandle, notification: &mut Notification) {
    use std::path::MAIN_SEPARATOR as SEP;

    let Ok(executable) = tauri::utils::platform::current_exe() else {
        return;
    };
    let Some(directory) = executable.parent() else {
        return;
    };
    let directory = directory.display().to_string();
    if directory.ends_with(format!("{SEP}target{SEP}debug").as_str())
        || directory.ends_with(format!("{SEP}target{SEP}release").as_str())
    {
        return;
    }

    notification.app_id(&app.config().identifier);
}

#[cfg(test)]
mod tests {
    use super::{validate_payload, NativeNotificationPayload};

    fn payload() -> NativeNotificationPayload {
        NativeNotificationPayload {
            notification_id: "workflow-run:42".into(),
            title: "Workflow abgeschlossen".into(),
            body: "Der Lauf wurde erfolgreich beendet.".into(),
            category: "workflow".into(),
            priority: "normal".into(),
            action_url: Some("luczor://notifications/workflow-run:42".into()),
        }
    }

    #[test]
    fn validates_the_closed_notification_contract() {
        assert!(validate_payload(&payload()).is_ok());

        let mut invalid = payload();
        invalid.category = "external".into();
        assert!(validate_payload(&invalid).is_err());

        invalid = payload();
        invalid.priority = "urgent".into();
        assert!(validate_payload(&invalid).is_err());
    }
}
