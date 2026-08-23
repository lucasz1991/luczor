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
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

use super::ensure_main_webview;
use super::process::run_bounded_command;

const MAX_AGENT_OUTPUT_BYTES: usize = 500_000;
const MAX_BRIDGE_BYTES: usize = 1_000_000;
const DEFAULT_AGENT_TIMEOUT_SECS: u64 = 900;
const MAX_AGENT_TIMEOUT_SECS: u64 = 3_600;

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
pub async fn agent_cli_detect(window: WebviewWindow) -> Result<Vec<AgentInfo>, String> {
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
    window: WebviewWindow,
    payload: AgentRunPayload,
) -> Result<AgentRunResult, String> {
    ensure_main_webview(&window)?;
    let prompt = payload.prompt.trim();
    if prompt.is_empty() {
        return Err("Empty prompt".into());
    }
    if prompt.chars().count() > 100_000 {
        return Err("Prompt too long".into());
    }

    let names = candidates_for(&payload.agent)
        .ok_or_else(|| format!("Unknown agent: {}", payload.agent))?;
    // Headless invocation per CLI: claude uses `-p`, codex uses `exec`.
    let args: Vec<String> = match payload.agent.as_str() {
        "claude" => vec!["-p".into(), prompt.to_string()],
        "codex" => vec!["exec".into(), prompt.to_string()],
        other => return Err(format!("Unknown agent: {other}")),
    };

    let exe =
        find_executable(names).ok_or_else(|| format!("{} CLI not found in PATH", payload.agent))?;
    let mut command = Command::new(exe);
    command.args(&args);
    if let Some(dir) = payload.project_dir.as_ref() {
        if !dir.is_empty() {
            command.current_dir(validate_project_dir(dir)?);
        }
    }
    let timeout = Duration::from_secs(
        payload
            .timeout_seconds
            .unwrap_or(DEFAULT_AGENT_TIMEOUT_SECS)
            .clamp(1, MAX_AGENT_TIMEOUT_SECS),
    );
    let output = tauri::async_runtime::spawn_blocking(move || {
        run_bounded_command(command, None, timeout, MAX_AGENT_OUTPUT_BYTES)
    })
    .await
    .map_err(|error| format!("join failed: {error}"))??;
    Ok(AgentRunResult {
        ok: output.success,
        code: output.code,
        stdout: output.stdout,
        stderr: output.stderr,
        timed_out: output.timed_out,
        stdout_truncated: output.stdout_truncated,
        stderr_truncated: output.stderr_truncated,
    })
}

#[derive(Deserialize)]
pub struct BridgePayload {
    pub project_dir: String,
    pub content: String,
}

/// Write/refresh the shared `LUCZOR.md` bridge file in a project directory.
#[tauri::command]
pub async fn agent_write_bridge(
    window: WebviewWindow,
    payload: BridgePayload,
) -> Result<String, String> {
    ensure_main_webview(&window)?;
    validate_bridge_content(&payload.content)?;
    let dir = validate_project_dir(&payload.project_dir)?;
    let file = dir.join("LUCZOR.md");
    atomic_write(&file, payload.content.as_bytes())?;
    Ok(file.to_string_lossy().into_owned())
}

fn validate_bridge_content(content: &str) -> Result<(), String> {
    if content.len() > MAX_BRIDGE_BYTES {
        Err("Bridge content exceeds the 1 MB limit.".into())
    } else {
        Ok(())
    }
}

fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
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
        atomic_replace(&temp, target).map_err(|error| format!("bridge replace failed: {error}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
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
fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::rename(source, target)
}

#[cfg(test)]
mod tests {
    use super::{atomic_write, validate_bridge_content, validate_project_dir, MAX_BRIDGE_BYTES};

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
