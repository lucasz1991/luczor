pub mod agent;
pub mod browser;
pub mod codex;
pub mod device_jobs;
pub mod device_key;
pub mod local_model;
pub mod local_tasks;
pub mod mini_chat;
pub mod notifications;
pub mod project_workspace;
pub mod repository_graph;
pub mod system;
pub mod voice;
pub mod workflow_http;

mod process;

use tauri::WebviewWindow;

pub(crate) const MAIN_WEBVIEW_LABEL: &str = "main";
pub(crate) const BROWSER_WEBVIEW_LABEL: &str = "luczor-browser";

pub(crate) fn ensure_webview_label(actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err("This command is not available to the calling webview.".into())
    }
}

pub(crate) fn ensure_main_webview(window: &WebviewWindow) -> Result<(), String> {
    ensure_webview_label(window.label(), MAIN_WEBVIEW_LABEL)
}

pub(crate) fn ensure_browser_webview(window: &WebviewWindow) -> Result<(), String> {
    ensure_webview_label(window.label(), BROWSER_WEBVIEW_LABEL)
}

#[cfg(test)]
mod tests {
    use super::{ensure_webview_label, BROWSER_WEBVIEW_LABEL, MAIN_WEBVIEW_LABEL};

    #[test]
    fn native_commands_keep_main_and_remote_browser_trust_separate() {
        assert!(ensure_webview_label(MAIN_WEBVIEW_LABEL, MAIN_WEBVIEW_LABEL).is_ok());
        assert!(ensure_webview_label(BROWSER_WEBVIEW_LABEL, BROWSER_WEBVIEW_LABEL).is_ok());
        assert!(ensure_webview_label(BROWSER_WEBVIEW_LABEL, MAIN_WEBVIEW_LABEL).is_err());
        assert!(ensure_webview_label(MAIN_WEBVIEW_LABEL, BROWSER_WEBVIEW_LABEL).is_err());
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
            capability["windows"],
            serde_json::json!([BROWSER_WEBVIEW_LABEL])
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
            serde_json::json!(["default", "browser", "mini-chat"])
        );

        let main_runtime = include_str!("../../permissions/main-runtime.toml");
        for command in [
            "codex_runtime_status",
            "codex_desktop_open",
            "codex_job_start",
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
            "local_model_prepare",
            "local_model_infer",
            "local_model_cancel",
            "local_model_stop",
        ] {
            assert!(main_runtime.contains(command));
            assert!(!capability.to_string().contains(command));
        }
    }
}
