// src/commands/local_tasks.rs
//
// SOLL §14 P15b (client side) — local filesystem + runtime execution for
// workflow client tasks (file.read / file.write / python.run / node.run).
//
// The server compiles a vetted `workflow.task` bundle, the device job pipeline
// verifies its signature, and the frontend runner (workflowTaskRunner.ts) calls
// these commands. Security posture (SOLL §0):
//  - Filesystem access is confined to a single app-managed root; traversal,
//    absolute paths and `..` are rejected.
//  - Interpreters are chosen from a fixed allowlist and resolved against PATH;
//    the user never supplies a raw binary path.
//  - Subprocesses run off the async runtime, with a wall-clock timeout and a
//    captured-output cap, and no console window flashes on Windows.

use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};

use super::ensure_main_webview;
use super::execution::{admit, admit_full, Guarded};

const MAX_OUTPUT_BYTES: usize = 200_000;
const MAX_FILE_BYTES: usize = 5_000_000;
const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 600;

/// The single writable root all workflow file tasks are confined to.
fn files_root(app: &AppHandle, create: bool) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?
        .join("workflow-files");
    if create {
        std::fs::create_dir_all(&root).map_err(|e| format!("cannot create files root: {e}"))?;
    }
    let metadata =
        std::fs::symlink_metadata(&root).map_err(|_| "Workflow files root unavailable.")?;
    if is_link_like(&metadata) || !metadata.is_dir() {
        return Err("Workflow files root must be a real directory.".into());
    }
    root.canonicalize()
        .map_err(|e| format!("files root cannot be resolved: {e}"))
}

/// Resolve a caller-supplied relative path against the confined root, rejecting
/// anything that could escape it (absolute paths, `..`, root/prefix components).
fn safe_path(root: &Path, raw: &str, create: bool) -> Result<PathBuf, String> {
    let rel = Path::new(raw.trim());
    if raw.trim().is_empty() {
        return Err("path is empty".into());
    }
    for component in rel.components() {
        match component {
            Component::Normal(name) => {
                let text = name.to_string_lossy();
                let base = text.split('.').next().unwrap_or("").to_ascii_uppercase();
                let device = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
                    || ["COM", "LPT"].iter().any(|prefix| {
                        base.strip_prefix(prefix).is_some_and(|suffix| {
                            matches!(
                                suffix,
                                "0" | "1"
                                    | "2"
                                    | "3"
                                    | "4"
                                    | "5"
                                    | "6"
                                    | "7"
                                    | "8"
                                    | "9"
                                    | "\u{00b9}"
                                    | "\u{00b2}"
                                    | "\u{00b3}"
                            )
                        })
                    });
                if text.contains(':') || text.ends_with(['.', ' ']) || device {
                    return Err("Ambiguous workflow path component.".into());
                }
            }
            _ => return Err("path must be a relative path without '..' or a drive/root".into()),
        }
    }
    let joined = root.join(rel);
    let mut current = root.to_path_buf();
    for component in rel.components() {
        current.push(component.as_os_str());
        if let Ok(metadata) = std::fs::symlink_metadata(&current) {
            if is_link_like(&metadata) {
                return Err("Workflow paths must not contain links or reparse points.".into());
            }
        }
    }
    let parent = joined.parent().ok_or("path has no parent")?;
    if create {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create target dir: {e}"))?;
    }
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| "Workflow file directory does not exist.")?;
    if !canonical_parent.starts_with(root) {
        return Err("path escapes the workflow files root".into());
    }
    Ok(canonical_parent.join(joined.file_name().ok_or("path has no file name")?))
}
fn is_link_like(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[derive(Deserialize)]
pub struct FileReadPayload {
    pub path: String,
}

#[derive(Serialize)]
pub struct FileReadResult {
    pub content: String,
    pub bytes: usize,
    pub truncated: bool,
}

/// Read a UTF-8 (lossy) file from the confined workflow files root.
#[tauri::command]
pub async fn wf_file_read(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<FileReadPayload>,
) -> Result<FileReadResult, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, false)?;
    let payload = payload.request;
    let root = files_root(&app, false)?;
    let path = safe_path(&root, &payload.path, false)?;
    use std::io::Read;
    gate.check()?;
    let file = std::fs::File::open(&path).map_err(|_| "Workflow file could not be opened.")?;
    let total = file
        .metadata()
        .map_err(|_| "Workflow file metadata unavailable.")?
        .len();
    let mut data = Vec::new();
    file.take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|_| "Workflow file read failed.")?;
    gate.check()?;
    let truncated = data.len() > MAX_FILE_BYTES;
    let slice = if truncated {
        &data[..MAX_FILE_BYTES]
    } else {
        &data[..]
    };
    Ok(FileReadResult {
        content: String::from_utf8_lossy(slice).into_owned(),
        bytes: total.min(usize::MAX as u64) as usize,
        truncated,
    })
}

#[derive(Deserialize)]
pub struct FileWritePayload {
    pub path: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct FileWriteResult {
    pub path: String,
    pub bytes: usize,
}

/// Atomically write a file into the confined workflow files root.
#[tauri::command]
pub async fn wf_file_write(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<FileWritePayload>,
) -> Result<FileWriteResult, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
    if payload.content.len() > MAX_FILE_BYTES {
        return Err("content exceeds the maximum file size".into());
    }
    gate.check()?;
    let root = files_root(&app, true)?;
    let path = safe_path(&root, &payload.path, true)?;
    let partial = path.with_extension(format!("{}.part", uuid::Uuid::new_v4()));
    gate.check()?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|e| format!("write failed: {e}"))?;
    let result = (|| {
        file.write_all(payload.content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "Workflow file write failed.")?;
        drop(file);
        gate.check()?;
        let current = safe_path(&root, &payload.path, false)?;
        if current != path {
            return Err("Workflow file directory changed during write.".into());
        }
        super::agent::atomic_replace(&partial, &path)
            .map_err(|_| "Workflow file replacement failed.".to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result?;
    Ok(FileWriteResult {
        path: path.to_string_lossy().into_owned(),
        bytes: payload.content.len(),
    })
}

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

/// Fixed interpreter allowlist — the runtime is chosen by name, never a raw path.
fn runtime_candidates(runtime: &str) -> Option<&'static [&'static str]> {
    match runtime {
        "python" => Some(&["python.exe", "python3", "python"]),
        "node" => Some(&["node.exe", "node"]),
        _ => None,
    }
}

#[derive(Deserialize)]
pub struct RunScriptPayload {
    pub runtime: String,
    pub code: String,
    pub timeout_seconds: Option<u64>,
    #[serde(rename = "fullAccessAcknowledged", default)]
    pub full_access_acknowledged: bool,
}

#[derive(Serialize)]
pub struct RunScriptResult {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

/// Run a Python/Node snippet headlessly with a timeout and bounded output.
#[tauri::command]
pub async fn wf_run_script(
    window: WebviewWindow,
    payload: Guarded<RunScriptPayload>,
) -> Result<RunScriptResult, String> {
    ensure_main_webview(&window)?;
    let gate = admit_full(&payload.execution, true, true)?;
    let payload = payload.request;
    if !payload.full_access_acknowledged {
        return Err("Local scripts run with full OS user access. Explicit acknowledgement is required; this is not a sandbox.".into());
    }
    let code = payload.code.trim().to_string();
    if code.is_empty() {
        return Err("code is empty".into());
    }
    if code.len() > 200_000 {
        return Err("code is too large".into());
    }
    let names = runtime_candidates(&payload.runtime)
        .ok_or_else(|| format!("Unsupported runtime: {}", payload.runtime))?;
    let exe = find_executable(names)
        .ok_or_else(|| format!("{} runtime not found in PATH", payload.runtime))?;
    let timeout = Duration::from_secs(
        payload
            .timeout_seconds
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );

    // Run the potentially long subprocess off the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        gate.check()?;
        run_script_blocking(exe, &payload.runtime, code, timeout, Some(gate))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

fn run_script_blocking(
    exe: PathBuf,
    runtime: &str,
    code: String,
    timeout: Duration,
    execution: Option<super::execution::ExecutionLease>,
) -> Result<RunScriptResult, String> {
    let mut command = Command::new(exe);
    // Read the program from stdin: `python -` / `node -` avoids writing temp files.
    command.arg("-");
    let output = super::process::run_bounded_command_guarded(
        command,
        Some(code.into_bytes()),
        timeout,
        MAX_OUTPUT_BYTES,
        execution,
    )?;
    let _ = runtime;

    Ok(RunScriptResult {
        ok: output.success,
        code: output.code,
        stdout: output.stdout,
        stderr: output.stderr,
        timed_out: output.timed_out,
        stdout_truncated: output.stdout_truncated,
        stderr_truncated: output.stderr_truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_path_rejects_traversal_and_absolute() {
        let root = std::env::temp_dir().join("luczor_wf_test_root");
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();

        assert!(safe_path(&root, "../escape.txt", true).is_err());
        assert!(safe_path(&root, "", true).is_err());
        #[cfg(windows)]
        assert!(safe_path(&root, "C:/abs.txt", true).is_err());
        #[cfg(not(windows))]
        assert!(safe_path(&root, "/abs.txt", true).is_err());

        let ok = safe_path(&root, "sub/note.txt", true).expect("relative path allowed");
        assert!(ok.starts_with(&root));
    }

    #[test]
    fn read_resolution_never_creates_parents_and_rejects_ambiguous_names() {
        let root = std::env::temp_dir().join(format!("luczor-read-scope-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        assert!(safe_path(&root, "missing/note.txt", false).is_err());
        assert!(!root.join("missing").exists());
        assert!(safe_path(&root, "a:stream", true).is_err());
        assert!(safe_path(&root, "CON.txt", false).is_err());
        assert!(safe_path(&root, "sub/LPT1", true).is_err());
        assert!(safe_path(&root, "a. ", true).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_allowlist_is_closed() {
        assert!(runtime_candidates("python").is_some());
        assert!(runtime_candidates("node").is_some());
        assert!(runtime_candidates("ruby").is_none());
        assert!(runtime_candidates("sh").is_none());
    }
}
