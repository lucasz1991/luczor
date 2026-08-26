use std::{env, fs, path::Path};

const APP_COMMANDS: &[&str] = &[
    "capture_screen",
    "read_clipboard",
    "list_windows",
    "system_metrics",
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
    "install_voice_runtime",
    "verify_device_job",
    "agent_cli_detect",
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
];

fn main() {
    println!("cargo:rerun-if-env-changed=LUCZOR_VOICE_MANIFEST_PUBLIC_KEY_B64");
    println!("cargo:rerun-if-changed=../.env.voice");
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
