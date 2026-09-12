// src/commands/agent.rs
//
// External coding-agent orchestration (SOLL §8b, mode C/D). Luczor can drive a
// locally installed Claude Code / OpenAI Codex CLI *headless* in a project
// directory — no API key, reusing the tool's own login — and drop a shared
// `LUCZOR.md` bridge file so both agents have common project context.
//
// These commands only spawn already-installed, user-authenticated CLIs. They
// are surfaced as mutating, approval-gated tools in the frontend registry.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::ensure_main_webview;
use super::execution::{admit, ExecutionLease, Guarded};
use super::project_workspace::with_workspace_mutation;

const MAX_BRIDGE_BYTES: usize = 1_000_000;

#[derive(Serialize)]
pub struct AgentInfo {
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
}

/// Resolve an executable by scanning PATH for any of the candidate file names.
fn find_executable(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn candidates_for(agent: &str) -> Option<&'static [&'static str]> {
    match agent {
        "claude" => Some(&["claude.cmd", "claude.exe", "claude"]),
        "codex" => Some(&["codex.cmd", "codex.exe", "codex"]),
        _ => None,
    }
}

fn detect_one(agent: &str) -> AgentInfo {
    let path = candidates_for(agent).and_then(find_executable);
    AgentInfo {
        name: agent.to_string(),
        available: path.is_some(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Resolve a user-supplied project directory and reject filesystem roots.
/// A bridge file or coding agent launched at `C:\`, `/`, etc. would escape
/// every meaningful project boundary.
#[cfg(test)]
fn validate_project_dir(raw: &str) -> Result<PathBuf, String> {
    let dir = Path::new(raw);
    if !dir.is_dir() {
        return Err("project_dir is not a directory".into());
    }

    let canonical = dir
        .canonicalize()
        .map_err(|e| format!("project_dir cannot be resolved: {e}"))?;
    if canonical.parent().is_none() {
        return Err("project_dir must not be a filesystem root".into());
    }

    Ok(canonical)
}

/// Report which local coding-agent CLIs are installed (PATH-detected).
#[tauri::command]
pub async fn agent_cli_detect(
    window: crate::commands::CallerWebview,
) -> Result<Vec<AgentInfo>, String> {
    ensure_main_webview(&window)?;
    Ok(vec![detect_one("claude"), detect_one("codex")])
}

#[derive(Deserialize)]
pub struct AgentRunPayload {
    /// "claude" or "codex".
    pub agent: String,
    pub prompt: String,
    /// Working directory the agent runs in (its config folder lives here).
    pub project_dir: Option<String>,
    /// Wall-clock limit; defaults to 15 minutes and is capped at one hour.
    pub timeout_seconds: Option<u64>,
}

#[derive(Serialize)]
pub struct AgentRunResult {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

/// Run a local coding-agent CLI headlessly and return its captured output.
#[tauri::command]
pub async fn agent_cli_run(
    window: crate::commands::CallerWebview,
    payload: AgentRunPayload,
) -> Result<AgentRunResult, String> {
    ensure_main_webview(&window)?;
    let _ = (
        payload.agent,
        payload.prompt,
        payload.project_dir,
        payload.timeout_seconds,
    );
    Err("Legacy agent CLI execution is disabled. Use a reviewed managed Codex job with a bound project, sandbox, cancellation and persistent session.".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgePayload {
    pub principal_id: String,
    pub project_id: String,
    pub expected_root_path: String,
    pub expected_workspace_updated_at: i64,
    pub content: String,
}

/// Write/refresh the shared `LUCZOR.md` bridge file in a project directory.
#[tauri::command]
pub async fn agent_write_bridge(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    payload: Guarded<BridgePayload>,
) -> Result<String, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
    validate_bridge_content(&payload.content)?;
    with_workspace_mutation(
        &app,
        &payload.principal_id,
        &payload.project_id,
        &payload.expected_root_path,
        payload.expected_workspace_updated_at,
        &gate,
        |root, gate| {
            let file = root.join("LUCZOR.md");
            atomic_write_guarded(&file, payload.content.as_bytes(), Some(gate))?;
            Ok("LUCZOR.md".to_string())
        },
    )
}

fn validate_bridge_content(content: &str) -> Result<(), String> {
    if content.len() > MAX_BRIDGE_BYTES {
        Err("Bridge content exceeds the 1 MB limit.".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_guarded(target, bytes, None)
}

fn atomic_write_guarded(
    target: &Path,
    bytes: &[u8],
    gate: Option<&ExecutionLease>,
) -> Result<(), String> {
    let temp = target.with_file_name(format!(".LUCZOR.md.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| format!("temporary bridge write failed: {error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("temporary bridge write failed: {error}"))?;
        if let Some(gate) = gate {
            gate.check()?;
        }
        atomic_replace(&temp, target).map_err(|error| format!("bridge replace failed: {error}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(windows)]
pub(crate) fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::rename(source, target)
}

#[cfg(test)]
mod tests {
    use super::{
        atomic_write, validate_bridge_content, validate_project_dir, BridgePayload,
        MAX_BRIDGE_BYTES,
    };
    use crate::commands::execution::Guarded;

    #[test]
    fn bridge_payload_accepts_the_guarded_camel_case_command_contract_only() {
        let payload: Guarded<BridgePayload> = serde_json::from_value(serde_json::json!({
            "execution": { "sessionId": "session-a", "generation": 7 },
            "principalId": "principal-a",
            "projectId": "project-a",
            "expectedRootPath": "E:\\project",
            "expectedWorkspaceUpdatedAt": 42,
            "content": "# Bridge"
        }))
        .expect("camelCase renderer payload");

        assert_eq!(payload.request.principal_id, "principal-a");
        assert_eq!(payload.request.project_id, "project-a");
        assert_eq!(payload.request.expected_root_path, "E:\\project");
        assert_eq!(payload.request.expected_workspace_updated_at, 42);
        assert_eq!(payload.request.content, "# Bridge");
        assert!(
            serde_json::from_value::<Guarded<BridgePayload>>(serde_json::json!({
                "execution": { "sessionId": "session-a", "generation": 7 },
                "principalId": "principal-a",
                "projectId": "project-a",
                "expectedRootPath": "E:\\project",
                "expectedWorkspaceUpdatedAt": 42,
                "content": "# Bridge",
                "unexpected": true
            }))
            .is_err()
        );
    }

    #[test]
    fn project_directory_validation_rejects_the_filesystem_root() {
        let current = std::env::current_dir().expect("current directory");
        let root = current.ancestors().last().expect("filesystem root");

        let error = validate_project_dir(root.to_string_lossy().as_ref())
            .expect_err("filesystem root must be rejected");

        assert!(error.contains("filesystem root"));
    }

    #[test]
    fn project_directory_validation_accepts_a_real_project_directory() {
        let current = std::env::current_dir().expect("current directory");

        assert!(validate_project_dir(current.to_string_lossy().as_ref()).is_ok());
    }

    #[test]
    fn bridge_write_is_bounded_and_replaces_the_complete_file() {
        let root = std::env::temp_dir().join(format!("luczor-agent-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("temporary directory");
        let target = root.join("LUCZOR.md");
        std::fs::write(&target, "old").expect("seed bridge");

        atomic_write(&target, b"new complete content").expect("atomic bridge write");
        assert_eq!(
            std::fs::read_to_string(&target).expect("read bridge"),
            "new complete content"
        );
        assert!(validate_bridge_content(&"x".repeat(MAX_BRIDGE_BYTES)).is_ok());
        assert!(validate_bridge_content(&"x".repeat(MAX_BRIDGE_BYTES + 1)).is_err());

        std::fs::remove_dir_all(root).expect("remove temporary directory");
    }
}
