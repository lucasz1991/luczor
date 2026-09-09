//! App-owned SDK worker. Host user rights are explicit; project binding is not a sandbox.
use super::agent_effort::{valid_claude_model, AgentEffort};
use super::codex::{acquire_workspace_lease, LifetimeGuard};
use super::execution::{admit, ExecutionLease, Guarded};
use super::project_workspace::agent_workspace_snapshot;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State, WebviewWindow};

const MAX_OUTPUT: usize = 200_000;
const READ_TOOLS: &[&str] = &["Read", "Glob", "Grep"];
const WRITE_TOOLS: &[&str] = &[
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "NotebookEdit",
    "Bash",
];

#[derive(Default)]
pub struct ClaudeJobs {
    entries: Mutex<HashMap<String, Arc<Job>>>,
}
impl ClaudeJobs {
    pub fn cancel_all(&self) {
        if let Ok(entries) = self.entries.lock() {
            for job in entries.values() {
                job.cancel.store(true, Ordering::Release);
            }
        }
    }
}
impl Drop for ClaudeJobs {
    fn drop(&mut self) {
        self.cancel_all();
    }
}
struct Job {
    principal: String,
    project: String,
    root: PathBuf,
    revision: i64,
    writing: bool,
    execution: ExecutionLease,
    cancel: AtomicBool,
    snapshot: Mutex<ClaudeSnapshot>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSnapshot {
    id: String,
    principal_id: String,
    project_id: String,
    status: String,
    output: String,
    output_truncated: bool,
    error: Option<String>,
    model: Option<String>,
    applied_effort: Option<AgentEffort>,
    tool_calls: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeStart {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    prompt: String,
    model: Option<String>,
    effort: Option<AgentEffort>,
    default_model_revision: Option<String>,
    permission: String,
    execution_profile: String,
    host_access_acknowledged: bool,
    timeout_seconds: Option<u64>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeJobIdentity {
    principal_id: String,
    project_id: String,
    job_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRuntimeStatus {
    available: bool,
    sdk_version: &'static str,
    cli_version: &'static str,
    execution_profile: &'static str,
    reason: Option<String>,
}

fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    let packaged = app
        .path()
        .resource_dir()
        .map_err(|_| "Agent runtime directory unavailable.")?
        .join("claude-agent");
    if packaged.join("runtime.json").is_file() {
        return Ok(packaged);
    }
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.lmzdev/artifacts/runtime/claude-agent");
        if development.join("runtime.json").is_file() {
            return Ok(development);
        }
    }
    Err("Managed Claude runtime is not packaged. Build the app-owned agent runtime first.".into())
}
fn verify_runtime(root: &Path) -> Result<(), String> {
    let bytes = std::fs::read(root.join("runtime.json"))
        .map_err(|_| "Agent runtime manifest unavailable.")?;
    if bytes.len() > 16384 {
        return Err("Agent runtime manifest invalid.".into());
    }
    let manifest: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Agent runtime manifest invalid.")?;
    if manifest["sdkVersion"] != "0.3.266" || manifest["cliVersion"] != "2.1.266" {
        return Err("Unsupported managed Claude runtime version.".into());
    }
    for file in [
        "node.exe",
        "claude.exe",
        "worker.mjs",
        "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    ] {
        if !root.join(file).is_file() {
            return Err("Managed Claude runtime is incomplete.".into());
        }
    }
    Ok(())
}

pub(crate) fn metadata_executable(app: &AppHandle) -> Result<PathBuf, String> {
    let root = runtime_root(app)?;
    verify_runtime(&root)?;
    Ok(root.join("claude.exe"))
}

#[tauri::command]
pub fn claude_runtime_status(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<ClaudeRuntimeStatus, String> {
    super::ensure_main_webview(&window)?;
    let validation = runtime_root(&app).and_then(|root| verify_runtime(&root));
    Ok(ClaudeRuntimeStatus {
        available: validation.is_ok(),
        sdk_version: "0.3.266",
        cli_version: "2.1.266",
        execution_profile: "host-user",
        reason: validation.err(),
    })
}

fn validate_start(input: &ClaudeStart) -> Result<(), String> {
    if input.prompt.trim().is_empty() || input.prompt.len() > 100_000 || input.prompt.contains('\0')
    {
        return Err("Invalid Claude prompt.".into());
    }
    if !matches!(input.permission.as_str(), "read-only" | "workspace-write")
        || input.execution_profile != "host-user"
        || !input.host_access_acknowledged
    {
        return Err("Claude requires the reviewed Windows host-user execution profile.".into());
    }
    if input
        .model
        .as_deref()
        .is_some_and(|model| !valid_claude_model(model))
    {
        return Err("Invalid Claude model.".into());
    }
    if matches!(
        input.effort,
        Some(AgentEffort::None | AgentEffort::Minimal | AgentEffort::Ultra)
    ) || (input.effort.is_some() && input.model.is_none())
    {
        return Err("Claude effort requires an explicit supported model.".into());
    }
    if let Some(effort) = input.effort {
        if !claude_model_supports_effort(input.model.as_deref().unwrap_or_default(), effort) {
            return Err("Claude effort is unsupported or unknown for this model.".into());
        }
    }
    if input
        .timeout_seconds
        .is_some_and(|seconds| seconds == 0 || seconds > 3600)
        || input
            .max_turns
            .is_some_and(|turns| turns == 0 || turns > 200)
        || input
            .max_budget_usd
            .is_some_and(|amount| !amount.is_finite() || amount <= 0.0 || amount > 100.0)
    {
        return Err("Invalid Claude execution budget.".into());
    }
    Ok(())
}

fn claude_model_supports_effort(model: &str, effort: AgentEffort) -> bool {
    let common = matches!(
        effort,
        AgentEffort::Low | AgentEffort::Medium | AgentEffort::High | AgentEffort::Max
    );
    match model.strip_suffix("[1m]").unwrap_or(model) {
        "claude-opus-4-6" | "claude-sonnet-4-6" => common,
        "claude-opus-4-7" | "claude-opus-4-8" | "claude-opus-5" | "claude-sonnet-5"
        | "claude-fable-5" | "claude-fable-5-1" => common || effort == AgentEffort::Xhigh,
        _ => false,
    }
}

fn scope(app: &AppHandle, job: &Job) -> Result<(), String> {
    job.execution.check()?;
    if job.cancel.load(Ordering::Acquire) {
        return Err("Claude job cancelled.".into());
    }
    let (root, revision) = agent_workspace_snapshot(app, &job.principal, &job.project)?;
    if root != job.root || revision != job.revision {
        return Err("Claude project binding changed.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn claude_job_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ClaudeJobs>,
    payload: Guarded<ClaudeStart>,
) -> Result<ClaudeSnapshot, String> {
    super::ensure_main_webview(&window)?;
    validate_start(&payload.request)?;
    let writing = payload.permission == "workspace-write";
    let execution = admit(&payload.execution, writing)?;
    let input = payload.request;
    let (root, revision) = agent_workspace_snapshot(&app, &input.principal_id, &input.project_id)?;
    if root != Path::new(&input.expected_root_path)
        || revision != input.expected_workspace_updated_at
    {
        return Err("Claude project binding changed.".into());
    }
    let runtime = runtime_root(&app)?;
    verify_runtime(&runtime)?;
    let lease = acquire_workspace_lease(&root, writing)?;
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "Claude job registry unavailable.")?;
    let active = entries
        .values()
        .filter(|job| job.snapshot.lock().map_or(true, |s| !terminal(&s.status)))
        .count();
    if active >= 3 {
        return Err("Claude concurrency limit reached.".into());
    }
    if entries.len() >= 50 {
        entries.retain(|_, job| job.snapshot.lock().map_or(true, |s| !terminal(&s.status)));
    }
    let snapshot = ClaudeSnapshot {
        id: uuid::Uuid::new_v4().to_string(),
        principal_id: input.principal_id.clone(),
        project_id: input.project_id.clone(),
        status: "starting".into(),
        output: String::new(),
        output_truncated: false,
        error: None,
        model: input.model.clone(),
        applied_effort: None,
        tool_calls: 0,
    };
    let job = Arc::new(Job {
        principal: input.principal_id.clone(),
        project: input.project_id.clone(),
        root,
        revision,
        writing,
        execution,
        cancel: AtomicBool::new(false),
        snapshot: Mutex::new(snapshot.clone()),
    });
    entries.insert(snapshot.id.clone(), job.clone());
    drop(entries);
    std::thread::spawn(move || {
        let _lease = lease;
        let result = run_worker(&app, &runtime, &job, &input);
        if let Err(error) = result {
            finish(
                &job,
                if job.cancel.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "failed"
                },
                Some(error),
            );
        }
    });
    Ok(snapshot)
}
fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "timed_out")
}
fn owned(state: &ClaudeJobs, input: &ClaudeJobIdentity) -> Result<Arc<Job>, String> {
    let entries = state
        .entries
        .lock()
        .map_err(|_| "Claude job registry unavailable.")?;
    let job = entries
        .get(&input.job_id)
        .ok_or("Claude job unavailable in this app session.")?;
    if job.principal != input.principal_id || job.project != input.project_id {
        return Err("Claude job belongs to another account or project.".into());
    }
    Ok(job.clone())
}
#[tauri::command]
pub fn claude_job_status(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ClaudeJobs>,
    payload: ClaudeJobIdentity,
) -> Result<ClaudeSnapshot, String> {
    super::ensure_main_webview(&window)?;
    let job = owned(&state, &payload)?;
    let current_scope = scope(&app, &job).is_ok();
    if !current_scope {
        job.cancel.store(true, Ordering::Release);
    }
    let mut snapshot = job
        .snapshot
        .lock()
        .map_err(|_| "Claude snapshot unavailable.")?
        .clone();
    // Terminal state remains pollable until cleanup, but revoked scopes receive no old output.
    if !current_scope {
        snapshot.output.clear();
    }
    Ok(snapshot)
}
#[tauri::command]
pub fn claude_job_cancel(
    window: WebviewWindow,
    state: State<'_, ClaudeJobs>,
    payload: ClaudeJobIdentity,
) -> Result<ClaudeSnapshot, String> {
    super::ensure_main_webview(&window)?;
    let job = owned(&state, &payload)?;
    job.cancel.store(true, Ordering::Release);
    let mut snapshot = job
        .snapshot
        .lock()
        .map_err(|_| "Claude snapshot unavailable.")?;
    if !terminal(&snapshot.status) {
        snapshot.status = "cancelling".into();
    }
    Ok(snapshot.clone())
}
fn finish(job: &Job, status: &str, error: Option<String>) {
    if let Ok(mut snapshot) = job.snapshot.lock() {
        snapshot.status = status.into();
        snapshot.error = error;
    }
}
fn append(job: &Job, text: &str) {
    if let Ok(mut s) = job.snapshot.lock() {
        let remaining = MAX_OUTPUT.saturating_sub(s.output.len());
        let mut end = text.len().min(remaining);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        s.output.push_str(&text[..end]);
        s.output_truncated |= end < text.len();
    }
}

fn run_worker(
    app: &AppHandle,
    runtime: &Path,
    job: &Arc<Job>,
    input: &ClaudeStart,
) -> Result<(), String> {
    scope(app, job)?;
    super::agent_effort::validate_default_binding(
        app,
        &super::agent_effort::DefaultModelRequest {
            adapter_id: "claude".into(),
            principal_id: job.principal.clone(),
            project_id: job.project.clone(),
            expected_root_path: job.root.to_string_lossy().into_owned(),
            expected_workspace_updated_at: job.revision,
        },
        input.model.as_deref(),
        input.default_model_revision.as_deref(),
        &runtime.join("claude.exe"),
        &|| scope(app, job),
    )?;
    let mut command = Command::new(runtime.join("node.exe"));
    command
        .arg(runtime.join("worker.mjs"))
        .current_dir(&job.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0004 | 0x0000_0200 | 0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Managed Claude worker could not start.")?;
    let lifetime = match LifetimeGuard::attach(&child) {
        Ok(guard) => guard,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let result = (|| {
        scope(app, job)?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or("Claude worker input unavailable.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Claude worker output unavailable.")?;
        let (sender, receiver) = mpsc::sync_channel(64);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                // Bounded line reader; malformed workers never allocate unbounded memory.
                use std::io::Read;
                let read = reader.by_ref().take(250_001).read_until(b'\n', &mut line);
                if !matches!(read, Ok(n) if n > 0) {
                    break;
                }
                if line.len() > 250_000 || line.last() != Some(&b'\n') {
                    let _ = sender.send(Err(()));
                    break;
                }
                if sender
                    .send(serde_json::from_slice::<Value>(&line).map_err(|_| ()))
                    .is_err()
                {
                    break;
                }
            }
        });
        let token = uuid::Uuid::new_v4().to_string();
        let start = json!({"type":"start","token":token,"model":input.model.as_deref().unwrap_or("default"),"effort":input.effort,"prompt":input.prompt,"cwd":job.root,"permission":input.permission,"maxTurns":input.max_turns.unwrap_or(24),"maxBudgetUsd":input.max_budget_usd});
        serde_json::to_writer(&mut stdin, &start).map_err(|_| "Claude worker input failed.")?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|_| "Claude worker input failed.")?;
        if let Ok(mut snapshot) = job.snapshot.lock() {
            snapshot.status = "running".into();
        }
        let deadline = Instant::now() + Duration::from_secs(input.timeout_seconds.unwrap_or(900));
        let mut completed = None;
        loop {
            scope(app, job)?;
            if Instant::now() >= deadline {
                return Err("claude_timeout".into());
            }
            match receiver.recv_timeout(Duration::from_millis(40)) {
                Ok(Ok(event)) => {
                    if event.get("token").and_then(Value::as_str) != Some(&token) {
                        return Err("Invalid Claude worker event identity.".into());
                    }
                    match event["type"].as_str() {
                        Some("gate") => {
                            let tool = event["tool"]
                                .as_str()
                                .ok_or("Invalid Claude tool request.")?;
                            let id = event["id"].as_str().ok_or("Invalid Claude gate ID.")?;
                            uuid::Uuid::parse_str(id).map_err(|_| "Invalid Claude gate ID.")?;
                            scope(app, job)?;
                            let allowed = (if job.writing { WRITE_TOOLS } else { READ_TOOLS })
                                .contains(&tool);
                            let response = json!({"type":"gate_result","token":token,"id":id,"allowed":allowed});
                            serde_json::to_writer(&mut stdin, &response)
                                .map_err(|_| "Claude gate response failed.")?;
                            stdin
                                .write_all(b"\n")
                                .and_then(|_| stdin.flush())
                                .map_err(|_| "Claude gate response failed.")?;
                            if let Ok(mut s) = job.snapshot.lock() {
                                s.tool_calls = s.tool_calls.saturating_add(1);
                            }
                        }
                        Some("text") => {
                            if let Some(text) = event["text"].as_str() {
                                append(job, text);
                            }
                        }
                        Some("model") => {
                            if let Some(model) = event["model"]
                                .as_str()
                                .filter(|model| valid_claude_model(model))
                            {
                                if let Ok(mut s) = job.snapshot.lock() {
                                    s.model = Some(model.into());
                                }
                            }
                        }
                        Some("effort") => {
                            let effort: AgentEffort =
                                serde_json::from_value(event["level"].clone())
                                    .map_err(|_| "Invalid applied Claude effort.")?;
                            if matches!(
                                effort,
                                AgentEffort::None | AgentEffort::Minimal | AgentEffort::Ultra
                            ) {
                                return Err("Invalid applied Claude effort.".into());
                            }
                            if let Ok(mut s) = job.snapshot.lock() {
                                s.applied_effort = Some(effort);
                            }
                        }
                        Some("result") => {
                            if completed.is_some() {
                                return Err("Duplicate Claude terminal result.".into());
                            }
                            completed = Some(event["ok"].as_bool() == Some(true));
                            if job.snapshot.lock().is_ok_and(|s| s.output.is_empty()) {
                                if let Some(text) = event["text"].as_str() {
                                    append(job, text);
                                }
                            }
                        }
                        Some("failure") => {
                            completed = Some(false);
                        }
                        _ => return Err("Unsupported Claude worker event.".into()),
                    }
                }
                Ok(Err(())) => return Err("Invalid Claude worker output.".into()),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break;
                }
            }
            if child
                .try_wait()
                .map_err(|_| "Claude worker status unavailable.")?
                .is_some()
            {
                // Continue draining the bounded pipe before deciding whether the result was complete.
                if completed.is_some() {
                    break;
                }
            }
        }
        if completed != Some(true)
            || !job
                .snapshot
                .lock()
                .is_ok_and(|s| !s.output.trim().is_empty())
        {
            return Err("Claude did not provide a successful, usable result.".into());
        }
        Ok(())
    })();
    // A model result alone is not process completion. Stop all descendants before releasing the lease.
    drop(lifetime);
    let _ = child.kill();
    let _ = child.wait();
    match result {
        Ok(()) => {
            scope(app, job)?;
            finish(job, "completed", None);
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_host_profile_and_bounded_efforts_are_admitted() {
        let value = json!({"principalId":"a","projectId":"p","expectedRootPath":"x","expectedWorkspaceUpdatedAt":1,"prompt":"review","permission":"read-only","executionProfile":"host-user","hostAccessAcknowledged":true});
        let mut input: ClaudeStart = serde_json::from_value(value).unwrap();
        assert!(validate_start(&input).is_ok());
        input.host_access_acknowledged = false;
        assert!(validate_start(&input).is_err());
        input.host_access_acknowledged = true;
        input.effort = Some(AgentEffort::Ultra);
        assert!(validate_start(&input).is_err());
    }
    #[test]
    fn read_profile_cannot_run_shell_or_hidden_subagents() {
        assert!(!READ_TOOLS.contains(&"Bash"));
        assert!(!WRITE_TOOLS.contains(&"Agent"));
        assert!(!WRITE_TOOLS.contains(&"CronCreate"));
    }

    #[test]
    fn native_effort_validation_cannot_be_bypassed_by_a_forged_renderer_payload() {
        assert!(claude_model_supports_effort(
            "claude-opus-5[1m]",
            AgentEffort::Xhigh
        ));
        assert!(!claude_model_supports_effort(
            "claude-opus-5[1m][1m]",
            AgentEffort::Xhigh
        ));
        assert!(claude_model_supports_effort(
            "claude-opus-4-7",
            AgentEffort::Xhigh
        ));
        assert!(!claude_model_supports_effort(
            "claude-opus-4-6",
            AgentEffort::Xhigh
        ));
        assert!(!claude_model_supports_effort("opus", AgentEffort::High));
        assert!(!claude_model_supports_effort("invented", AgentEffort::Low));
        assert!(!claude_model_supports_effort(
            "claude-opus-4-7",
            AgentEffort::Ultra
        ));
    }
}
