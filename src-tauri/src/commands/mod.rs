pub mod agent;
pub mod agent_effort;
pub(crate) mod agent_shutdown;
pub mod browser;
pub mod browser_panel;
pub mod chat_playground;
pub mod claude;
pub mod codex;
pub mod desktop_accessibility;
pub mod desktop_control;
mod desktop_control_overlay;
#[cfg(all(test, windows, feature = "native-browser-smoke"))]
mod desktop_control_smoke;
#[cfg(target_os = "linux")]
mod desktop_linux;
#[cfg(target_os = "linux")]
mod desktop_pipewire;
mod desktop_target;
#[cfg(windows)]
mod desktop_window_input;
pub mod device_jobs;
pub mod device_key;
pub mod device_run_journal;
pub mod execution;
pub mod lan_peer;
pub mod local_model;
pub mod local_tasks;
pub mod mini_chat;
pub mod notifications;
pub mod project_mirror;
pub mod project_workspace;
pub mod repository_graph;
pub mod research;
pub mod run_archive;
mod script_environment;
pub mod system;
mod system_diagnostics;
pub mod system_status_controller;
mod system_status_model;
pub mod system_status_window;
#[cfg(windows)]
mod system_temperature;
pub mod voice;
pub mod voice_input;
pub mod workflow_artifacts;
pub mod workflow_browser;
pub mod workflow_http;
pub mod workflow_image;
pub mod workflow_watch;

pub(crate) mod owned_processes;
mod process;

/// Command identity must follow the calling webview, even in a split window.
/// Tauri's WebviewWindow extractor rejects multi-webview windows.
pub struct CallerWebview {
    webview: tauri::Webview,
    window: tauri::Window,
}
impl std::ops::Deref for CallerWebview {
    type Target = tauri::Window;
    fn deref(&self) -> &Self::Target {
        &self.window
    }
}
impl CallerWebview {
    pub fn label(&self) -> &str {
        self.webview.label()
    }
}
impl<'de> tauri::ipc::CommandArg<'de, tauri::Wry> for CallerWebview {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, tauri::Wry>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let webview =
            <tauri::Webview as tauri::ipc::CommandArg<'de, tauri::Wry>>::from_command(command)?;
        Ok(Self {
            window: webview.window(),
            webview,
        })
    }
}

pub(crate) const MAIN_WEBVIEW_LABEL: &str = "main";
pub(crate) const BROWSER_WEBVIEW_LABEL: &str = "luczor-browser";

pub(crate) fn ensure_webview_label(actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err("This command is not available to the calling webview.".into())
    }
}

pub(crate) fn ensure_main_webview(window: &CallerWebview) -> Result<(), String> {
    ensure_webview_label(window.label(), MAIN_WEBVIEW_LABEL)
}

/// The detached Systemstatus display has a deliberately narrow, read-only
/// capability. It may use the two status reads below, never the main runtime.
pub(crate) fn ensure_main_or_system_status_webview(window: &CallerWebview) -> Result<(), String> {
    if window.label() == MAIN_WEBVIEW_LABEL
        || window.label() == system_status_window::SYSTEM_STATUS_LABEL
    {
        Ok(())
    } else {
        Err("This command is not available to the calling webview.".into())
    }
}

pub(crate) fn ensure_main_or_chat_playground_webview(window: &CallerWebview) -> Result<(), String> {
    if window.label() == MAIN_WEBVIEW_LABEL
        || window.label() == chat_playground::CHAT_PLAYGROUND_LABEL
    {
        Ok(())
    } else {
        Err("This command is not available to the calling webview.".into())
    }
}

pub(crate) fn ensure_browser_webview(window: &CallerWebview) -> Result<(), String> {
    ensure_webview_label(window.label(), BROWSER_WEBVIEW_LABEL)
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_webview_label, system_status_window, BROWSER_WEBVIEW_LABEL, MAIN_WEBVIEW_LABEL,
    };

    #[test]
    fn native_commands_keep_main_and_remote_browser_trust_separate() {
        assert!(ensure_webview_label(MAIN_WEBVIEW_LABEL, MAIN_WEBVIEW_LABEL).is_ok());
        assert!(ensure_webview_label(BROWSER_WEBVIEW_LABEL, BROWSER_WEBVIEW_LABEL).is_ok());
        assert!(ensure_webview_label(BROWSER_WEBVIEW_LABEL, MAIN_WEBVIEW_LABEL).is_err());
        assert!(ensure_webview_label(MAIN_WEBVIEW_LABEL, BROWSER_WEBVIEW_LABEL).is_err());
    }

    #[test]
    fn status_window_label_stays_distinct_from_main_and_remote_browser() {
        assert!(ensure_webview_label(
            system_status_window::SYSTEM_STATUS_LABEL,
            system_status_window::SYSTEM_STATUS_LABEL
        )
        .is_ok());
        assert!(ensure_webview_label(
            system_status_window::SYSTEM_STATUS_LABEL,
            MAIN_WEBVIEW_LABEL
        )
        .is_err());
        assert!(ensure_webview_label(
            system_status_window::SYSTEM_STATUS_LABEL,
            BROWSER_WEBVIEW_LABEL
        )
        .is_err());
    }

    #[test]
    fn browser_capability_exposes_only_the_report_permission() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/browser.json"))
                .expect("browser capability must be valid JSON");
        let main_capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/default.json"))
                .expect("main capability must be valid JSON");
        let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
            .expect("Tauri config must be valid JSON");
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["browser-report"])
        );
        assert_eq!(
            capability["webviews"],
            serde_json::json!([BROWSER_WEBVIEW_LABEL])
        );
        assert!(capability.get("windows").is_none());
        assert!(main_capability.get("windows").is_none());
        assert_eq!(
            main_capability["webviews"],
            serde_json::json!([MAIN_WEBVIEW_LABEL])
        );
        assert!(main_capability["permissions"]
            .as_array()
            .expect("main permissions")
            .contains(&serde_json::json!("main-runtime")));
        assert!(!main_capability["permissions"]
            .as_array()
            .expect("main permissions")
            .contains(&serde_json::json!("store:default")));
        assert!(main_capability["permissions"]
            .as_array()
            .expect("main permissions")
            .contains(&serde_json::json!("store:allow-delete")));
        assert_eq!(
            config["app"]["security"]["capabilities"],
            serde_json::json!(["default", "browser", "mini-chat", "system-status"])
        );

        let status_capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/system-status.json"))
                .expect("system-status capability must be valid JSON");
        assert_eq!(
            status_capability["windows"],
            serde_json::json!([system_status_window::SYSTEM_STATUS_LABEL])
        );
        assert!(status_capability["permissions"]
            .as_array()
            .expect("system-status permissions")
            .contains(&serde_json::json!("system-status-client")));

        let main_runtime = include_str!("../../permissions/main-runtime.toml");
        for command in [
            "research_preview",
            "research_prepare",
            "research_read",
            "research_write",
            "research_read_artifact",
            "research_export_artifact",
            "research_verify",
            "research_open",
            "research_release",
            "system_diagnostics",
            "codex_runtime_status",
            "codex_desktop_open",
            "codex_job_start",
            "codex_model_capabilities",
            "claude_runtime_status",
            "claude_job_start",
            "claude_job_status",
            "claude_job_cancel",
            "codex_job_status",
            "codex_job_cancel",
            "memory_key_get_or_create",
            "local_graph_bind",
            "local_graph_index",
            "local_graph_status",
            "local_graph_search",
            "local_graph_read_snippets",
            "local_graph_unbind",
            "scroll",
            "hotkey",
            "project_workspace_bind",
            "project_workspace_get",
            "project_workspace_unbind",
            "project_fs_list",
            "project_fs_stat",
            "project_fs_read",
            "project_fs_search",
            "project_fs_write",
            "project_fs_create_dir",
            "project_fs_move",
            "project_fs_delete",
            "local_model_register_manifest_session",
            "local_model_begin_manifest_acceptance",
            "local_model_verify_manifest",
            "local_model_status",
            "local_model_hardware_snapshot",
            "local_model_resource_system_check",
            "local_model_prepare",
            "local_model_infer",
            "local_model_reasoning_control",
            "wf_browser_action",
            "wf_browser_cleanup",
            "wf_image_action",
            "wf_runtime_capabilities",
            "local_model_cancel",
            "local_model_stop",
        ] {
            assert!(main_runtime.contains(command));
            assert!(!capability.to_string().contains(command));
        }
    }
}
