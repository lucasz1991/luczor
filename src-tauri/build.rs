use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

/// Bind workflow test evidence to all native contracts without embedding source text in the executable.
fn workflow_source_fingerprint() -> String {
    fn collect(directory: &Path, files: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(directory)
            .expect("native source directory")
            .flatten()
        {
            let kind = entry.file_type().expect("native source metadata");
            let path = entry.path();
            if kind.is_dir() {
                collect(&path, files);
            } else if kind.is_file()
                && matches!(
                    path.extension().and_then(|value| value.to_str()),
                    Some("rs" | "js" | "json" | "toml")
                )
            {
                files.push(path);
            }
        }
    }
    let mut files = Vec::new();
    for directory in ["src", "permissions", "capabilities"] {
        println!("cargo:rerun-if-changed={directory}");
        if Path::new(directory).is_dir() {
            collect(Path::new(directory), &mut files);
        }
    }
    files.extend(["Cargo.toml", "Cargo.lock", "build.rs", "tauri.conf.json"].map(PathBuf::from));
    files.sort();
    let mut hash = Sha256::new();
    for path in files {
        println!("cargo:rerun-if-changed={}", path.display());
        hash.update(path.to_string_lossy().replace('\\', "/").as_bytes());
        hash.update([0]);
        hash.update(fs::read(&path).expect("native source fingerprint input"));
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

const APP_COMMANDS: &[&str] = &[
    "open_user_link",
    "execution_gate_update",
    "execution_scope_register",
    "execution_scope_revoke",
    "device_run_journal_read",
    "device_run_journal_list",
    "device_run_journal_transition",
    "wf_execution_cancel",
    "wf_watch_start",
    "wf_watch_stop",
    "wf_watch_drain",
    "wf_watch_ack",
    "desktop_adapter_status",
    "desktop_portal_setup",
    "desktop_portal_close",
    "desktop_accessibility_observe",
    "desktop_accessibility_action",
    "desktop_observe",
    "desktop_control_status",
    "desktop_control_save",
    "desktop_control_preview",
    "codex_job_list",
    "codex_session_list",
    "mini_chat_open",
    "mini_chat_action",
    "mini_chat_publish",
    "mini_chat_snapshot",
    "mini_chat_drag",
    "mini_chat_drag_by",
    "mini_chat_snap",
    "mini_chat_window",
    "system_status_window_open",
    "system_status_window_set_mode",
    "system_status_window_close",
    "system_status_open_memory",
    "capture_screen",
    "read_clipboard",
    "list_windows",
    "list_monitors",
    "system_metrics",
    "system_diagnostics",
    "move_mouse",
    "mouse_click",
    "type_text",
    "press_key",
    "scroll",
    "hotkey",
    "open_url",
    "local_stt",
    "local_stt_rs",
    "local_tts",
    "voice_runtime_status",
    "voice_input_store",
    "voice_input_claim",
    "voice_input_status",
    "voice_input_stt",
    "install_voice_runtime",
    "lan_peer_identity",
    "lan_agent_lease_verify",
    "lan_peer_start",
    "lan_peer_stop",
    "lan_peer_status",
    "lan_peer_send",
    "lan_peer_drain",
    "lan_peer_ack",
    "lan_peer_flush",
    "verify_device_job",
    "agent_cli_detect",
    "codex_runtime_status",
    "codex_desktop_open",
    "codex_job_start",
    "codex_model_capabilities",
    "agent_default_model_resolve",
    "claude_runtime_status",
    "claude_job_start",
    "claude_job_status",
    "claude_job_cancel",
    "codex_job_status",
    "codex_job_cancel",
    "agent_cli_run",
    "agent_write_bridge",
    "wf_scoped_file_read",
    "wf_scoped_file_write",
    "wf_file_read",
    "wf_file_write",
    "wf_run_script",
    "wf_runtime_capabilities",
    "wf_http_request",
    "show_native_notification",
    "browser_open",
    "browser_navigate",
    "browser_close",
    "browser_click",
    "browser_read",
    "browser_report",
    "browser_action_admit",
    "device_key_get",
    "device_key_set",
    "device_key_delete",
    "memory_key_get_or_create",
    "local_graph_bind",
    "local_graph_index",
    "local_graph_cancel_index",
    "local_graph_status",
    "local_graph_inspect",
    "local_graph_search",
    "local_graph_read_snippets",
    "local_graph_unbind",
    "project_mirror_stage_begin",
    "project_mirror_stage_page",
    "project_mirror_stage_commit",
    "project_mirror_recover",
    "app_quit_commit",
    "project_mirror_test_workspace",
    "project_mirror_scan",
    "project_mirror_scan_page",
    "project_mirror_chunk_read",
    "project_mirror_chunk_put",
    "project_mirror_materialize",
    "project_mirror_watch_start",
    "project_mirror_watch_stop",
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
    "local_model_recover_memory",
    "local_model_prepare",
    "local_model_infer",
    "local_model_reasoning_control",
    "browser_panel_layout",
    "browser_panel_status",
    "wf_browser_action",
    "wf_browser_cleanup",
    "wf_image_action",
    "local_model_cancel",
    "local_model_stop",
    "local_model_get_resource_config",
    "local_model_resource_system_check",
    "local_model_set_resource_config",
    "local_model_apply_resource_config",
    "local_model_begin_resource_work",
    "local_model_end_resource_work",
];

fn main() {
    println!("cargo:rerun-if-env-changed=LUCZOR_VOICE_MANIFEST_PUBLIC_KEY_B64");
    println!("cargo:rerun-if-env-changed=LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64");
    println!("cargo:rerun-if-env-changed=LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID");
    println!("cargo:rerun-if-changed=../.env.voice");
    println!("cargo:rerun-if-changed=../.env.local-model");
    let key = env::var("LUCZOR_VOICE_MANIFEST_PUBLIC_KEY_B64")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(read_voice_env);
    if let Some(key) = key {
        println!(
            "cargo:rustc-env=LUCZOR_VOICE_MANIFEST_PUBLIC_KEY_B64={}",
            key.trim()
        );
    } else {
        println!("cargo:warning=Voice manifest public key is not configured; local STT/TTS installation will stay disabled.");
    }
    let local_public_key = env::var("LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            read_env_value(
                "../.env.local-model",
                "LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64",
            )
        });
    let local_key_id = env::var("LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| read_env_value("../.env.local-model", "LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID"));
    if let (Some(public_key), Some(key_id)) = (&local_public_key, &local_key_id) {
        println!(
            "cargo:rustc-env=LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64={}",
            public_key.trim()
        );
        println!(
            "cargo:rustc-env=LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID={}",
            key_id.trim()
        );
    } else if local_public_key.is_some() || local_key_id.is_some() {
        panic!("Configure both local-model public key and key id, or omit both for automatic HTTPS discovery.");
    } else {
        println!("cargo:warning=Local-model verification will use the Luczor HTTPS signing-key endpoint.");
    }
    if let Err(error) = tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    ) {
        let target = env::var("TARGET").unwrap_or_else(|_| "unknown-target".into());
        panic!("failed to build the Tauri application manifest for {target}: {error}");
    }
    println!(
        "cargo:rustc-env=LUCZOR_NATIVE_WORKFLOW_CODE_HASH={}",
        workflow_source_fingerprint()
    );
}

fn read_voice_env() -> Option<String> {
    let path = Path::new("../.env.voice");
    let content = fs::read_to_string(path).ok()?;
    content.lines().find_map(|line| {
        line.trim()
            .strip_prefix("LUCZOR_VOICE_MANIFEST_PUBLIC_KEY_B64=")
            .map(|value| value.trim().trim_matches('"').to_string())
            .filter(|value| !value.is_empty())
    })
}

fn read_env_value(path: &str, key: &str) -> Option<String> {
    let content = fs::read_to_string(Path::new(path)).ok()?;
    content.lines().find_map(|line| {
        line.trim()
            .strip_prefix(&format!("{key}="))
            .map(|value| value.trim().trim_matches('"').to_string())
            .filter(|value| !value.is_empty())
    })
}
