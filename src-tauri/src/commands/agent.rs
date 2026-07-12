// src/commands/agent.rs
//
// External coding-agent orchestration (SOLL §8b, mode C/D). Luczor can drive a
// locally installed Claude Code / OpenAI Codex CLI *headless* in a project
// directory — no API key, reusing the tool's own login — and drop a shared
// `LUCZOR.md` bridge file so both agents have common project context.
//
// These commands only spawn already-installed, user-authenticated CLIs. They
// are surfaced as mutating, approval-gated tools in the frontend registry.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

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
pub async fn agent_cli_detect() -> Result<Vec<AgentInfo>, String> {
    Ok(vec![detect_one("claude"), detect_one("codex")])
}

#[derive(Deserialize)]
pub struct AgentRunPayload {
    /// "claude" or "codex".
    pub agent: String,
    pub prompt: String,
    /// Working directory the agent runs in (its config folder lives here).
    pub project_dir: Option<String>,
}

#[derive(Serialize)]
pub struct AgentRunResult {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run a local coding-agent CLI headlessly and return its captured output.
#[tauri::command]
pub async fn agent_cli_run(payload: AgentRunPayload) -> Result<AgentRunResult, String> {
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

    let output = command.output().map_err(|e| format!("spawn failed: {e}"))?;
    Ok(AgentRunResult {
        ok: output.status.success(),
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[derive(Deserialize)]
pub struct BridgePayload {
    pub project_dir: String,
    pub content: String,
}

/// Write/refresh the shared `LUCZOR.md` bridge file in a project directory.
#[tauri::command]
pub async fn agent_write_bridge(payload: BridgePayload) -> Result<String, String> {
    let dir = validate_project_dir(&payload.project_dir)?;
    let file = dir.join("LUCZOR.md");
    std::fs::write(&file, payload.content).map_err(|e| format!("write failed: {e}"))?;
    Ok(file.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::validate_project_dir;

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
}
