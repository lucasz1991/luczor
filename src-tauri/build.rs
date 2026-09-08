use std::{env, fs, path::Path};

const APP_COMMANDS: &[&str] = &[
    "open_user_link",
    "execution_gate_update",
    "desktop_observe",
    "codex_job_list",
    "codex_session_list",
    "mini_chat_open",
    "mini_chat_action",
    "mini_chat_publish",
    "mini_chat_snapshot",
    "mini_chat_drag",
    "mini_chat_window",
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
    "verify_device_job",
    "agent_cli_detect",
    "codex_runtime_status",
    "codex_desktop_open",
    "codex_job_start",
    "codex_job_status",
    "codex_job_cancel",
    "agent_cli_run",
    "agent_write_bridge",
    "wf_file_read",
    "wf_file_write",
    "wf_run_script",
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
    "local_graph_status",
    "local_graph_search",
    "local_graph_read_snippets",
    "local_graph_unbind",
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
    "local_model_cancel",
    "local_model_stop",
    "local_model_get_resource_config",
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
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build the Tauri application manifest")
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
