// src/commands/local_tasks.rs
//
// SOLL §14 P15b (client side) — local filesystem + runtime execution for
// workflow client tasks (file.read / file.write / python.run / node.run).
//
// The server compiles a vetted `workflow.task` bundle, the device job pipeline
// verifies its signature, and the frontend runner (workflowTaskRunner.ts) calls
// these commands. Security posture (SOLL §0):
//  - File helper operations are confined to an app-managed root. Explicitly
//    reviewed scripts run with Windows user rights; their checked project cwd
//    is not a filesystem or network sandbox.
//  - Interpreters are chosen from a fixed allowlist and resolved against PATH;
//    the user never supplies a raw binary path.
//  - Subprocesses run off the async runtime, with a wall-clock timeout and a
//    captured-output cap, and no console window flashes on Windows.

use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
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
pub(super) fn safe_path(root: &Path, raw: &str, create: bool) -> Result<PathBuf, String> {
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
pub(super) fn is_link_like(metadata: &std::fs::Metadata) -> bool {
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
#[serde(deny_unknown_fields)]
pub struct RunScriptPayload {
    pub runtime: String,
    pub code: String,
    pub timeout_seconds: Option<u64>,
    #[serde(rename = "fullAccessAcknowledged", default)]
    pub full_access_acknowledged: bool,
    pub scope: Option<super::workflow_artifacts::WorkflowArtifactScope>,
    pub input: Option<Value>,
    #[serde(rename = "outputSchema")]
    pub output_schema: Option<Value>,
    pub environment: Option<super::script_environment::ScriptEnvironment>,
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
    pub duration_ms: u64,
    pub runtime: String,
    pub interpreter: String,
    pub runtime_version: Option<String>,
    pub execution_profile: &'static str,
    pub input_mode: &'static str,
    pub code_sha256: String,
    pub environment: Option<super::script_environment::EnvironmentReport>,
}

fn validate_script(input: &RunScriptPayload) -> Result<(), String> {
    if !input.full_access_acknowledged {
        return Err("Local scripts require the reviewed Windows host-user profile; the project is not a filesystem sandbox.".into());
    }
    if input.code.trim().is_empty() || input.code.len() > 200_000 || input.code.contains('\0') {
        return Err("workflow_script_code_invalid".into());
    }
    if runtime_candidates(&input.runtime).is_none() {
        return Err("workflow_script_runtime_unsupported".into());
    }
    if let Some(environment) = &input.environment {
        if input.scope.is_none() { return Err("workflow_script_environment_requires_project".into()); }
        environment.validate(&input.runtime)?;
    }
    if let Some(data) = &input.input {
        if input.scope.is_none()
            || !data.is_object()
            || serde_json::to_vec(data)
                .map_err(|_| "workflow_script_json_invalid")?
                .len()
                > MAX_OUTPUT_BYTES
        {
            return Err("workflow_script_json_input_invalid".into());
        }
        #[cfg(windows)]
        if input.code.encode_utf16().count() > 28000 {
            return Err("workflow_script_exceeds_windows_argument_limit".into());
        }
    }
    if input
        .output_schema
        .as_ref()
        .is_some_and(|schema| !schema.is_object() || schema.to_string().len() > 50000)
    {
        return Err("workflow_script_output_schema_invalid".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRuntimeCapability {
    runtime: &'static str,
    available: bool,
    version: Option<String>,
    execution_profile: &'static str,
    json_input: bool,
}

fn native_contract_fingerprint() -> String {
    env!("LUCZOR_NATIVE_WORKFLOW_CODE_HASH").into()
}

fn runtime_version(exe: &Path, runtime: &str) -> Option<String> {
    let mut command = Command::new(exe);
    command
        .arg("--version")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("PYTHONSTARTUP");
    let result =
        super::process::run_bounded_command(command, None, Duration::from_secs(3), 256).ok()?;
    if !result.success || result.stdout_truncated || result.stderr_truncated {
        return None;
    }
    let version = if result.stdout.trim().is_empty() {
        result.stderr.trim()
    } else {
        result.stdout.trim()
    };
    if version.len() > 80
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ' '))
        || !(if runtime == "node" {
            version.starts_with('v')
        } else {
            version.starts_with("Python ")
        })
    {
        return None;
    }
    Some(version.into())
}

/// Only --version probes, never user code, package installation, login or model preparation.
#[tauri::command]
pub async fn wf_runtime_capabilities(window: WebviewWindow) -> Result<Value, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(|| {
        let runtimes: Vec<_> = ["node", "python"].into_iter().map(|runtime| {
            let exe = runtime_candidates(runtime).and_then(find_executable);
            let version = exe.as_deref().and_then(|exe| runtime_version(exe, runtime));
            WorkflowRuntimeCapability { runtime, available: version.is_some(), version, execution_profile: "host-user", json_input: true }
        }).collect();
        let browser = super::workflow_browser::capabilities();
        let ocr = super::workflow_image::ocr_capabilities().unwrap_or_else(|_| serde_json::json!({"ocrAvailable":false,"ocrLanguages":[],"ocrReason":"windows_ocr_unavailable"}));
        let capture = xcap::Monitor::all().is_ok_and(|monitors| !monitors.is_empty());
        let image = serde_json::json!({"capture":capture,"compare":true,"ocr":ocr["ocrAvailable"],"ocrLanguages":ocr["ocrLanguages"],"prepareVision":true,"vision":false,"visionReason":"local_multimodal_runtime_unavailable"});
        let build = serde_json::json!({"appVersion":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"contractFingerprint":native_contract_fingerprint()});
        let mut report = serde_json::json!({"runtimes":runtimes,"browser":browser,"image":image,"build":build});
        let fingerprint = format!("{:x}", Sha256::digest(report.to_string().as_bytes()));
        report["runtimeFingerprint"] = Value::String(fingerprint);
        report
    }).await.map_err(|_| "workflow_runtime_probe_failed".into())
}

/// Run a Python/Node snippet headlessly with a timeout and bounded output.
#[tauri::command]
pub async fn wf_run_script(
    app: AppHandle,
    window: WebviewWindow,
    payload: Guarded<RunScriptPayload>,
) -> Result<RunScriptResult, String> {
    ensure_main_webview(&window)?;
    validate_script(&payload.request)?;
    if payload.scope.is_some() && payload.execution.workflow_execution_id.is_none() {
        return Err("workflow_execution_identity_required".into());
    }
    // Existing unscoped clients retain the old global mode requirement. A durable job already owns its scoped host grant.
    let gate = admit_full(&payload.execution, true, payload.scope.is_none())?;
    let payload = payload.request;
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
        let check = || {
            gate.check()?;
            if let Some(scope) = &payload.scope {
                scope.check(&app)?;
            }
            Ok(())
        };
        check()?;
        let root = payload
            .scope
            .as_ref()
            .map(|scope| PathBuf::from(&scope.expected_root_path));
        let _lease = root
            .as_deref()
            .map(|root| super::codex::acquire_workspace_lease(root, true))
            .transpose()?;
        let version = runtime_version(&exe, &payload.runtime);
        if version.is_none() {
            return Err("workflow_runtime_probe_failed".into());
        }
        check()?;
        run_script_blocking(
            &exe,
            &payload,
            root.as_deref(),
            timeout,
            Some(gate.clone()),
            version,
            &check,
        )
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

fn run_script_blocking(
    exe: &Path,
    payload: &RunScriptPayload,
    root: Option<&Path>,
    timeout: Duration,
    execution: Option<super::execution::ExecutionLease>,
    version: Option<String>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<RunScriptResult, String> {
    let started = Instant::now();
    let prepared = payload.environment.as_ref().map(|environment| {
        super::script_environment::prepare(environment, &payload.runtime, exe,
            version.as_deref().ok_or("workflow_runtime_probe_failed")?,
            root.ok_or("workflow_script_environment_requires_project")?,
            started + timeout, execution.clone(), check)
    }).transpose()?;
    check()?;
    let selected_exe = prepared.as_ref().map_or(exe, |env| env.interpreter.as_path());
    let (mut command, stdin) = script_command(selected_exe, payload, root)?;
    if let Some(env) = &prepared { env.apply(&mut command, &payload.runtime); }
    let remaining = timeout.checked_sub(started.elapsed()).filter(|v| !v.is_zero())
        .ok_or("workflow_script_environment_timeout")?;
    let output = super::process::run_bounded_command_scoped(
        command,
        Some(stdin),
        remaining,
        MAX_OUTPUT_BYTES,
        execution,
        Some(check),
    )?;

    Ok(RunScriptResult {
        ok: output.success,
        code: output.code,
        stdout: output.stdout,
        stderr: output.stderr,
        timed_out: output.timed_out,
        stdout_truncated: output.stdout_truncated,
        stderr_truncated: output.stderr_truncated,
        duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        runtime: payload.runtime.clone(),
        interpreter: exe
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| payload.runtime.clone()),
        runtime_version: version,
        execution_profile: "host-user",
        input_mode: if payload.input.is_some() {
            "json-stdin"
        } else {
            "code-stdin"
        },
        code_sha256: format!("{:x}", Sha256::digest(payload.code.as_bytes())),
        environment: prepared.map(|env| env.report),
    })
}

fn script_command(
    exe: &Path,
    payload: &RunScriptPayload,
    root: Option<&Path>,
) -> Result<(Command, Vec<u8>), String> {
    let mut command = Command::new(exe);
    command
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("PYTHONSTARTUP");
    if let Some(root) = root {
        command.current_dir(root);
    }
    let stdin = if let Some(input) = &payload.input {
        command
            .arg(if payload.runtime == "node" {
                "-e"
            } else {
                "-c"
            })
            .arg(&payload.code);
        serde_json::to_vec(input).map_err(|_| "workflow_script_json_invalid")?
    } else {
        command.arg("-");
        payload.code.as_bytes().to_vec()
    };
    Ok((command, stdin))
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

    fn fixture(runtime: &str) -> RunScriptPayload {
        RunScriptPayload {
            runtime: runtime.into(),
            code: "print('code')\n".into(),
            timeout_seconds: Some(10),
            full_access_acknowledged: true,
            scope: Some(super::super::workflow_artifacts::WorkflowArtifactScope {
                principal_id: "user".into(),
                project_id: "project".into(),
                expected_root_path: "E:\\project".into(),
                expected_workspace_updated_at: 7,
                run_id: uuid::Uuid::new_v4().to_string(),
            }),
            input: Some(serde_json::json!({"text":"'; touch injected; ${1+1}"})),
            output_schema: None,
            environment: None,
        }
    }

    #[test]
    fn durable_scripts_pass_exact_code_as_argument_and_json_only_on_stdin() {
        for (runtime, switch) in [("node", "-e"), ("python", "-c")] {
            let input = fixture(runtime);
            assert!(validate_script(&input).is_ok());
            let (command, stdin) = script_command(
                Path::new("interpreter"),
                &input,
                Some(Path::new("project-root")),
            )
            .unwrap();
            let args: Vec<_> = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            assert_eq!(args, vec![switch.to_string(), input.code.clone()]);
            assert_eq!(command.get_current_dir(), Some(Path::new("project-root")));
            assert_eq!(
                serde_json::from_slice::<Value>(&stdin).unwrap(),
                input.input.unwrap()
            );
        }
    }

    #[test]
    fn legacy_stdin_code_stays_compatible_and_invalid_json_scope_is_rejected() {
        let mut input = fixture("python");
        input.scope = None;
        assert!(validate_script(&input).is_err());
        input.input = None;
        assert!(validate_script(&input).is_ok());
        let (command, stdin) = script_command(Path::new("python"), &input, None).unwrap();
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new("-")]
        );
        assert_eq!(stdin, input.code.as_bytes());
        input.full_access_acknowledged = false;
        assert!(validate_script(&input).is_err());
        input = fixture("node");
        input.input = Some(serde_json::json!([1, 2]));
        assert!(validate_script(&input).is_err());
        input.input = Some(serde_json::json!({}));
        input.output_schema = Some(Value::String("schema".into()));
        assert!(validate_script(&input).is_err());
    }

    #[test]
    fn fingerprint_is_a_stable_hash_of_the_compiled_source_contracts() {
        let fingerprint = native_contract_fingerprint();
        assert_eq!(fingerprint.len(), 64);
        assert_eq!(fingerprint, native_contract_fingerprint());
        assert_ne!(
            fingerprint,
            format!("{:x}", Sha256::digest(env!("CARGO_PKG_VERSION").as_bytes()))
        );
    }

    #[test]
    #[ignore = "Explicit installed-runtime smoke: starts only fixed JSON echo programs, never models or agents."]
    fn installed_json_interpreters_preserve_untrusted_input() {
        let directory = std::env::temp_dir().join(format!("luczor-json-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        let result = (|| -> Result<(), String> {
            for runtime in ["node", "python"] {
                let exe = find_executable(runtime_candidates(runtime).unwrap())
                    .ok_or_else(|| format!("{runtime} runtime unavailable"))?;
                let version = runtime_version(&exe, runtime)
                    .ok_or_else(|| format!("{runtime} version unavailable"))?;
                let mut input = fixture(runtime);
                input.code = if runtime == "node" { "const fs=require('node:fs');process.stdout.write(JSON.stringify({received:JSON.parse(fs.readFileSync(0,'utf8'))}));" } else { "import sys,json\njson.dump({'received':json.load(sys.stdin)},sys.stdout)" }.into();
                let output = run_script_blocking(
                    &exe,
                    &input,
                    Some(&directory),
                    Duration::from_secs(5),
                    None,
                    Some(version.clone()),
                    &|| Ok(()),
                )?;
                assert!(output.ok && !output.stdout_truncated && !output.timed_out);
                assert_eq!(
                    serde_json::from_str::<Value>(&output.stdout).unwrap()["received"],
                    input.input.unwrap()
                );
                assert_eq!(output.input_mode, "json-stdin");
                assert_eq!(output.execution_profile, "host-user");
                println!("Installed {runtime} {version}: exact JSON stdin roundtrip succeeded.");
            }
            Ok(())
        })();
        std::fs::remove_dir(directory).unwrap();
        result.unwrap();
    }
}
