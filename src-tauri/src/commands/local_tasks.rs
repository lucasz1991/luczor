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

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const MAX_OUTPUT_BYTES: usize = 200_000;
const MAX_FILE_BYTES: usize = 5_000_000;
const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 600;

/// The single writable root all workflow file tasks are confined to.
fn files_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?
        .join("workflow-files");
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create files root: {e}"))?;
    root.canonicalize().map_err(|e| format!("files root cannot be resolved: {e}"))
}

/// Resolve a caller-supplied relative path against the confined root, rejecting
/// anything that could escape it (absolute paths, `..`, root/prefix components).
fn safe_path(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let rel = Path::new(raw.trim());
    if raw.trim().is_empty() {
        return Err("path is empty".into());
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err("path must be a relative path without '..' or a drive/root".into()),
        }
    }
    let joined = root.join(rel);
    // The parent must resolve to somewhere inside the root; the leaf need not exist.
    let parent = joined.parent().unwrap_or(root);
    std::fs::create_dir_all(parent).map_err(|e| format!("cannot create target dir: {e}"))?;
    let canonical_parent = parent.canonicalize().map_err(|e| format!("path cannot be resolved: {e}"))?;
    if !canonical_parent.starts_with(root) {
        return Err("path escapes the workflow files root".into());
    }
    Ok(canonical_parent.join(joined.file_name().ok_or("path has no file name")?))
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
pub async fn wf_file_read(app: AppHandle, payload: FileReadPayload) -> Result<FileReadResult, String> {
    let root = files_root(&app)?;
    let path = safe_path(&root, &payload.path)?;
    let data = std::fs::read(&path).map_err(|e| format!("read failed: {e}"))?;
    let truncated = data.len() > MAX_FILE_BYTES;
    let slice = if truncated { &data[..MAX_FILE_BYTES] } else { &data[..] };
    Ok(FileReadResult {
        content: String::from_utf8_lossy(slice).into_owned(),
        bytes: data.len(),
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
pub async fn wf_file_write(app: AppHandle, payload: FileWritePayload) -> Result<FileWriteResult, String> {
    if payload.content.len() > MAX_FILE_BYTES {
        return Err("content exceeds the maximum file size".into());
    }
    let root = files_root(&app)?;
    let path = safe_path(&root, &payload.path)?;
    let partial = path.with_extension("part");
    std::fs::write(&partial, payload.content.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    std::fs::rename(&partial, &path).map_err(|e| format!("rename failed: {e}"))?;
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

#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

#[derive(Deserialize)]
pub struct RunScriptPayload {
    pub runtime: String,
    pub code: String,
    pub timeout_seconds: Option<u64>,
}

#[derive(Serialize)]
pub struct RunScriptResult {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Run a Python/Node snippet headlessly with a timeout and bounded output.
#[tauri::command]
pub async fn wf_run_script(payload: RunScriptPayload) -> Result<RunScriptResult, String> {
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
        payload.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, MAX_TIMEOUT_SECS),
    );

    // Run the potentially long subprocess off the async runtime.
    tauri::async_runtime::spawn_blocking(move || run_script_blocking(exe, &payload.runtime, code, timeout))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

fn run_script_blocking(exe: PathBuf, runtime: &str, code: String, timeout: Duration) -> Result<RunScriptResult, String> {
    let mut command = Command::new(exe);
    // Read the program from stdin: `python -` / `node -` avoids writing temp files.
    command.arg("-");
    hide_console_window(&mut command);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| format!("spawn failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        // node reads the whole stream; python executes stdin as a script.
        let _ = stdin.write_all(code.as_bytes());
        let _ = runtime; // runtime kept for clarity/future per-runtime tweaks
    }

    // Drain stdout/stderr on their own threads so full pipe buffers never deadlock.
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_handle = thread::spawn(move || drain(out.as_mut()));
    let err_handle = thread::spawn(move || drain(err.as_mut()));

    let deadline = Instant::now() + timeout;
    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status, false),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let status = child.wait().ok();
                    break (status.unwrap_or_else(|| child.wait().expect("wait after kill")), true);
                }
                thread::sleep(Duration::from_millis(40));
            }
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    };

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();

    Ok(RunScriptResult {
        ok: status.success() && !timed_out,
        code: status.code().unwrap_or(-1),
        stdout: cap(stdout),
        stderr: cap(stderr),
        timed_out,
    })
}

fn drain(reader: Option<&mut impl Read>) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(r) = reader {
        let _ = r.take(MAX_OUTPUT_BYTES as u64 + 1).read_to_end(&mut buf);
    }
    buf
}

fn cap(bytes: Vec<u8>) -> String {
    let slice = if bytes.len() > MAX_OUTPUT_BYTES { &bytes[..MAX_OUTPUT_BYTES] } else { &bytes[..] };
    String::from_utf8_lossy(slice).into_owned()
}

// Silence an unused-import warning when the mpsc helper is not compiled in.
#[allow(unused_imports)]
use mpsc as _mpsc_marker;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_path_rejects_traversal_and_absolute() {
        let root = std::env::temp_dir().join("luczor_wf_test_root");
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();

        assert!(safe_path(&root, "../escape.txt").is_err());
        assert!(safe_path(&root, "").is_err());
        #[cfg(windows)]
        assert!(safe_path(&root, "C:/abs.txt").is_err());
        #[cfg(not(windows))]
        assert!(safe_path(&root, "/abs.txt").is_err());

        let ok = safe_path(&root, "sub/note.txt").expect("relative path allowed");
        assert!(ok.starts_with(&root));
    }

    #[test]
    fn runtime_allowlist_is_closed() {
        assert!(runtime_candidates("python").is_some());
        assert!(runtime_candidates("node").is_some());
        assert!(runtime_candidates("ruby").is_none());
        assert!(runtime_candidates("sh").is_none());
    }
}
