//! Managed Codex CLI jobs. No credentials, arbitrary executable paths, shell
//! strings or unverified external session IDs cross this command boundary.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use super::agent_effort::{validate_codex_effort, AgentEffort};
use super::ensure_main_webview;
use super::execution::{admit, ExecutionLease, Guarded};
use super::process::run_bounded_command;
use super::project_workspace::agent_workspace_snapshot;

const MAX_JOBS: usize = 50;
const MAX_ACTIVE: usize = 3;
const MAX_OUTPUT: usize = 200_000;
const MAX_LINE: usize = 512_000;
const MAX_ERROR: usize = 8_000;

static WORKSPACE_LEASES: OnceLock<Mutex<HashMap<String, (PathBuf, bool)>>> = OnceLock::new();

/// Shared with the legacy CLI entry point so a device job cannot race a
/// managed coding agent in the same directory or any parent/child directory.
pub(crate) struct WorkspaceLease {
    id: String,
}

pub(crate) fn acquire_workspace_lease(
    root: &Path,
    writing: bool,
) -> Result<WorkspaceLease, String> {
    let mut leases = WORKSPACE_LEASES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Coding-agent workspace leases unavailable.")?;
    if leases.values().any(|(active, active_write)| {
        (*active_write || writing) && workspaces_overlap(active, root)
    }) {
        return Err("Another coding agent is already running in this workspace or an overlapping directory.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    leases.insert(id.clone(), (root.to_path_buf(), writing));
    Ok(WorkspaceLease { id })
}

impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        if let Some(leases) = WORKSPACE_LEASES.get() {
            if let Ok(mut leases) = leases.lock() {
                leases.remove(&self.id);
            }
        }
    }
}

pub struct CodexJobs {
    entries: Mutex<HashMap<String, Arc<Job>>>,
    runtime_id: String,
}
impl Default for CodexJobs {
    fn default() -> Self {
        Self {
            entries: Mutex::default(),
            runtime_id: format!(
                "{}:{}:{}",
                std::process::id(),
                process_stamp(std::process::id()).unwrap_or(0),
                uuid::Uuid::new_v4()
            ),
        }
    }
}

struct Job {
    principal_id: String,
    project_id: String,
    root: PathBuf,
    binding_version: i64,
    cancel: AtomicBool,
    writing: bool,
    execution: Option<ExecutionLease>,
    database: Option<PathBuf>,
    runtime_id: String,
    snapshot: Mutex<CodexJobSnapshot>,
}

impl CodexJobs {
    pub fn cancel_all(&self) {
        if let Ok(entries) = self.entries.lock() {
            for job in entries.values() {
                job.cancel.store(true, Ordering::Release);
            }
        }
    }
}

impl Drop for CodexJobs {
    fn drop(&mut self) {
        self.cancel_all();
    }
}

#[derive(Clone, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CodexPermission {
    #[default]
    ReadOnly,
    WorkspaceWrite,
}

impl CodexPermission {
    fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexStartPayload {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    prompt: String,
    model: Option<String>,
    effort: Option<AgentEffort>,
    capability_revision: Option<String>,
    default_model_revision: Option<String>,
    #[serde(default)]
    permission: CodexPermission,
    external_thread_id: Option<String>,
    timeout_seconds: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexJobPayload {
    principal_id: String,
    project_id: String,
    job_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexJobSnapshot {
    id: String,
    principal_id: String,
    project_id: String,
    status: String,
    external_thread_id: Option<String>,
    output: String,
    error: Option<String>,
    output_truncated: bool,
    created_at: u64,
    finished_at: Option<u64>,
    events: Vec<CodexEvent>,
    #[serde(skip)]
    turn_completed: bool,
    #[serde(skip)]
    turn_failed: bool,
}

#[derive(Clone, Serialize)]
pub struct CodexEvent {
    r#type: String,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeStatus {
    available: bool,
    desktop_available: bool,
    desktop_project_creation: bool,
    transport: &'static str,
}

#[tauri::command]
pub async fn codex_runtime_status(window: WebviewWindow) -> Result<CodexRuntimeStatus, String> {
    ensure_main_webview(&window)?;
    Ok(CodexRuntimeStatus {
        available: find_codex().is_some(),
        desktop_available: tauri::async_runtime::spawn_blocking(desktop_installed)
            .await
            .unwrap_or(false),
        desktop_project_creation: false,
        transport: "codex-exec-jsonl",
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexDesktopPayload {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    external_thread_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDesktopResult {
    dispatched: bool,
    saved_project_created: bool,
}

/// Open the installed Desktop's new-task screen in the bound workspace. The
/// URI is generated from the official Codex Windows launcher's exact format.
/// Dispatch does not mean that Desktop has saved a project or submitted a task.
#[tauri::command]
pub async fn codex_desktop_open(
    app: AppHandle,
    window: WebviewWindow,
    payload: CodexDesktopPayload,
) -> Result<CodexDesktopResult, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !desktop_installed() {
            return Err("The Codex Desktop app is not installed or could not be detected.".into());
        }
        let (root, version) =
            agent_workspace_snapshot(&app, &payload.principal_id, &payload.project_id)?;
        verify_expected_binding(
            &root,
            version,
            &payload.expected_root_path,
            payload.expected_workspace_updated_at,
        )?;
        let target = if let Some(thread_id) = payload.external_thread_id {
            uuid::Uuid::parse_str(&thread_id)
                .map_err(|_| "A managed Codex thread UUID is required.")?;
            verify_link_scope(
                &link_database_path(&app)?,
                (&payload.principal_id, &payload.project_id),
                &root,
                version,
                &thread_id,
            )?;
            format!("codex://threads/{thread_id}")
        } else {
            desktop_project_url(&root)
        };
        open_desktop_url(&target)?;
        Ok(CodexDesktopResult {
            dispatched: true,
            saved_project_created: false,
        })
    })
    .await
    .map_err(|_| "Desktop launch worker failed.")?
}

fn desktop_project_url(root: &Path) -> String {
    // reqwest re-exports Url; its query serializer matches the official
    // url::form_urlencoded::Serializer, including spaces, Unicode and UNC paths.
    let mut url = reqwest::Url::parse("codex://threads/new").expect("constant Codex URL");
    url.query_pairs_mut()
        .append_pair("path", &root.to_string_lossy());
    url.into()
}

#[cfg(windows)]
fn desktop_installed() -> bool {
    let Some(system_root) = std::env::var_os("SYSTEMROOT") else {
        return false;
    };
    let executable = PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let mut command = Command::new(executable);
    command.args(["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Where-Object AppID -Like 'OpenAI.Codex_*!App' | Select-Object -First 1 -ExpandProperty AppID"]);
    run_bounded_command(command, None, Duration::from_secs(10), 1024)
        .is_ok_and(|result| result.success && result.stdout.trim().starts_with("OpenAI.Codex_"))
}

#[cfg(not(windows))]
fn desktop_installed() -> bool {
    false
}

#[cfg(windows)]
fn open_desktop_url(url: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            window: *mut std::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }
    let operation: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let target: Vec<u16> = std::ffi::OsStr::new(url)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result > 32 {
        Ok(())
    } else {
        Err("Windows could not open the registered Codex Desktop protocol.".into())
    }
}

#[cfg(not(windows))]
fn open_desktop_url(_url: &str) -> Result<(), String> {
    Err("Desktop handoff is currently supported on Windows only.".into())
}

#[tauri::command]
pub async fn codex_job_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, CodexJobs>,
    payload: Guarded<CodexStartPayload>,
) -> Result<CodexJobSnapshot, String> {
    ensure_main_webview(&window)?;
    let writing = matches!(payload.permission, CodexPermission::WorkspaceWrite);
    let execution = admit(&payload.execution, writing)?;
    let payload = payload.request;
    validate_start(&payload)?;
    validate_codex_effort(
        payload.model.as_deref(),
        payload.effort,
        payload.capability_revision.as_deref(),
    )?;
    let (root, binding_version) =
        agent_workspace_snapshot(&app, &payload.principal_id, &payload.project_id)?;
    verify_expected_binding(
        &root,
        binding_version,
        &payload.expected_root_path,
        payload.expected_workspace_updated_at,
    )?;
    let executable = find_codex().ok_or("Codex CLI executable was not found in PATH.")?;
    let database = link_database_path(&app)?;
    ensure_no_foreign_runtime(&database, &state.runtime_id)?;
    if let Some(thread_id) = &payload.external_thread_id {
        verify_link(&database, &payload, &root, binding_version, thread_id)?;
    }
    let lease = acquire_workspace_lease(&root, writing)?;
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "Agent job state unavailable.")?;
    entries.retain(|_, job| {
        job.snapshot.lock().map_or(true, |snapshot| {
            !is_terminal(&snapshot.status)
                || now_ms().saturating_sub(snapshot.finished_at.unwrap_or(0)) < 3_600_000
        })
    });
    let active: Vec<_> = entries
        .values()
        .filter(|job| {
            job.snapshot
                .lock()
                .map_or(true, |snapshot| !is_terminal(&snapshot.status))
        })
        .collect();
    if active.len() >= MAX_ACTIVE {
        return Err("Maximum number of concurrent Codex jobs reached.".into());
    }
    if active
        .iter()
        .any(|job| (job.writing || writing) && workspaces_overlap(&job.root, &root))
    {
        return Err("A Codex job is already running in this workspace.".into());
    }
    if payload.external_thread_id.as_ref().is_some_and(|thread| {
        active.iter().any(|job| {
            job.snapshot.lock().map_or(true, |snapshot| {
                snapshot.external_thread_id.as_ref() == Some(thread)
            })
        })
    }) {
        return Err("The managed Codex session already has an active turn; parallel readers need separate sessions.".into());
    }
    if entries.len() >= MAX_JOBS {
        let oldest = entries
            .iter()
            .filter_map(|(id, job)| {
                let snapshot = job.snapshot.lock().ok()?;
                is_terminal(&snapshot.status).then_some((id.clone(), snapshot.created_at))
            })
            .min_by_key(|entry| entry.1)
            .map(|entry| entry.0);
        if let Some(id) = oldest {
            entries.remove(&id);
        }
    }
    let initial = CodexJobSnapshot {
        id: uuid::Uuid::new_v4().to_string(),
        principal_id: payload.principal_id.clone(),
        project_id: payload.project_id.clone(),
        status: "starting".into(),
        external_thread_id: payload.external_thread_id.clone(),
        output: String::new(),
        error: None,
        output_truncated: false,
        created_at: now_ms(),
        finished_at: None,
        events: Vec::new(),
        turn_completed: false,
        turn_failed: false,
    };
    let job = Arc::new(Job {
        principal_id: payload.principal_id.clone(),
        project_id: payload.project_id.clone(),
        root,
        binding_version,
        cancel: AtomicBool::new(false),
        writing,
        execution: Some(execution),
        database: Some(database.clone()),
        runtime_id: state.runtime_id.clone(),
        snapshot: Mutex::new(initial.clone()),
    });
    check_execution(&job)?;
    persist_job_admitted(&database, &state.runtime_id, &initial)?;
    entries.insert(initial.id.clone(), Arc::clone(&job));
    drop(entries);
    thread::spawn(move || {
        let _lease = lease;
        let result = run_job(&app, &database, &executable, &job, &payload);
        if let Err(error) = result {
            finish(&job, "failed", Some(error));
        }
    });
    Ok(initial)
}

#[tauri::command]
pub async fn codex_job_status(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, CodexJobs>,
    payload: CodexJobPayload,
) -> Result<CodexJobSnapshot, String> {
    ensure_main_webview(&window)?;
    let job = match owned_job(&state, &payload) {
        Ok(job) => job,
        Err(error) => {
            let rows = load_jobs(
                &link_database_path(&app)?,
                &state.runtime_id,
                &payload.principal_id,
                Some(&payload.project_id),
            )?;
            return rows
                .into_iter()
                .find(|row| row.id == payload.job_id)
                .ok_or(error);
        }
    };
    let result = job
        .snapshot
        .lock()
        .map_err(|_| "Agent job state unavailable.")?
        .clone();
    Ok(result)
}

#[tauri::command]
pub async fn codex_job_cancel(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, CodexJobs>,
    payload: CodexJobPayload,
) -> Result<CodexJobSnapshot, String> {
    ensure_main_webview(&window)?;
    let job = match owned_job(&state, &payload) {
        Ok(job) => job,
        Err(error) => {
            let rows = load_jobs(
                &link_database_path(&app)?,
                &state.runtime_id,
                &payload.principal_id,
                Some(&payload.project_id),
            )?;
            return rows
                .into_iter()
                .find(|row| row.id == payload.job_id)
                .ok_or(error);
        }
    };
    let mut snapshot = job
        .snapshot
        .lock()
        .map_err(|_| "Agent job state unavailable.")?;
    if !is_terminal(&snapshot.status) {
        job.cancel.store(true, Ordering::Release);
        snapshot.status = "cancelling".into();
    }
    Ok(snapshot.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexListPayload {
    principal_id: String,
    project_id: Option<String>,
}

#[tauri::command]
pub async fn codex_job_list(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, CodexJobs>,
    payload: CodexListPayload,
) -> Result<Vec<CodexJobSnapshot>, String> {
    ensure_main_webview(&window)?;
    let mut history = load_jobs(
        &link_database_path(&app)?,
        &state.runtime_id,
        &payload.principal_id,
        payload.project_id.as_deref(),
    )?;
    let entries = state
        .entries
        .lock()
        .map_err(|_| "Agent job state unavailable.")?;
    for job in entries.values().filter(|job| {
        job.principal_id == payload.principal_id
            && payload
                .project_id
                .as_ref()
                .is_none_or(|project| &job.project_id == project)
    }) {
        let live = job
            .snapshot
            .lock()
            .map_err(|_| "Agent job state unavailable.")?
            .clone();
        history.retain(|row| row.id != live.id);
        history.push(live);
    }
    history.sort_by_key(|row| std::cmp::Reverse(row.created_at));
    history.truncate(200);
    Ok(history)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexSessionsPayload {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSession {
    thread_id: String,
    updated_at: Option<u64>,
}

#[tauri::command]
pub async fn codex_session_list(
    app: AppHandle,
    window: WebviewWindow,
    payload: CodexSessionsPayload,
) -> Result<Vec<CodexSession>, String> {
    ensure_main_webview(&window)?;
    let (root, version) =
        agent_workspace_snapshot(&app, &payload.principal_id, &payload.project_id)?;
    verify_expected_binding(
        &root,
        version,
        &payload.expected_root_path,
        payload.expected_workspace_updated_at,
    )?;
    let connection = open_links(&link_database_path(&app)?)?;
    let mut statement = connection.prepare("SELECT l.thread_id,t.updated_at FROM codex_links l LEFT JOIN codex_session_times t ON t.thread_id=l.thread_id WHERE l.principal_id=?1 AND l.project_id=?2 AND l.root_path=?3 AND l.binding_version=?4 ORDER BY t.updated_at DESC LIMIT 200").map_err(|_| "Managed sessions unavailable.")?;
    let rows = statement
        .query_map(
            params![
                payload.principal_id,
                payload.project_id,
                root.to_string_lossy(),
                version
            ],
            |row| {
                Ok(CodexSession {
                    thread_id: row.get(0)?,
                    updated_at: row.get::<_, Option<i64>>(1)?.map(|n| n.max(0) as u64),
                })
            },
        )
        .map_err(|_| "Managed sessions unavailable.")?;
    rows.filter_map(|row| match row {
        Ok(session)
            if uuid::Uuid::parse_str(&session.thread_id)
                .is_ok_and(|id| id.to_string() == session.thread_id) =>
        {
            Some(Ok(session))
        }
        Ok(_) => None,
        Err(_) => Some(Err("Managed sessions unavailable.".into())),
    })
    .collect()
}

// Only metadata survives restart. Prompts, output, errors, command text and
// project roots are deliberately absent from this table.
fn persist_job(path: &Path, runtime_id: &str, row: &CodexJobSnapshot) -> Result<(), String> {
    let connection = open_links(path)?;
    write_job_metadata(&connection, runtime_id, row)
}
fn persist_job_admitted(
    path: &Path,
    runtime_id: &str,
    row: &CodexJobSnapshot,
) -> Result<(), String> {
    let mut connection = open_links(path)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "Agent runtime admission unavailable.")?;
    reconcile_jobs(&transaction, runtime_id)?;
    let foreign:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM codex_jobs WHERE runtime_id<>?1 AND status NOT IN ('completed','failed','cancelled','timed_out','interrupted'))",[runtime_id],|r|r.get(0)).map_err(|_|"Agent runtime admission unavailable.")?;
    if foreign {
        return Err("Another Luczor process owns active Codex jobs.".into());
    }
    write_job_metadata(&transaction, runtime_id, row)?;
    transaction
        .commit()
        .map_err(|_| "Agent runtime admission could not be saved.".into())
}
fn write_job_metadata(
    connection: &Connection,
    runtime_id: &str,
    row: &CodexJobSnapshot,
) -> Result<(), String> {
    connection.execute("INSERT INTO codex_jobs(id,principal_id,project_id,runtime_id,status,external_thread_id,output_truncated,created_at,finished_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET status=excluded.status,external_thread_id=excluded.external_thread_id,output_truncated=excluded.output_truncated,finished_at=excluded.finished_at", params![row.id,row.principal_id,row.project_id,runtime_id,row.status,row.external_thread_id,row.output_truncated,row.created_at as i64,row.finished_at.map(|n|n as i64)]).map_err(|_| "Agent job metadata could not be saved.")?;
    connection.execute("DELETE FROM codex_jobs WHERE status IN ('completed','failed','cancelled','timed_out','interrupted') AND id NOT IN (SELECT id FROM codex_jobs ORDER BY created_at DESC LIMIT 1000)", []).map_err(|_| "Agent job history cleanup failed.")?;
    Ok(())
}
fn persist_current(job: &Job) {
    if let (Some(path), Ok(snapshot)) = (&job.database, job.snapshot.lock()) {
        let _ = persist_job(path, &job.runtime_id, &snapshot);
    }
}
fn reconcile_jobs(connection: &Connection, runtime_id: &str) -> Result<(), String> {
    let mut statement = connection.prepare("SELECT DISTINCT runtime_id FROM codex_jobs WHERE status NOT IN ('completed','failed','cancelled','timed_out','interrupted') AND runtime_id<>?1").map_err(|_| "Agent job reconciliation unavailable.")?;
    let runtimes = statement
        .query_map([runtime_id], |row| row.get::<_, String>(0))
        .map_err(|_| "Agent job reconciliation unavailable.")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Agent job reconciliation unavailable.")?;
    for old in runtimes.into_iter().filter(|old| !runtime_alive(old)) {
        connection.execute("UPDATE codex_jobs SET status='interrupted',finished_at=?2 WHERE runtime_id=?1 AND status NOT IN ('completed','failed','cancelled','timed_out','interrupted')",params![old,now_ms() as i64]).map_err(|_| "Agent job reconciliation failed.")?;
    }
    Ok(())
}
fn ensure_no_foreign_runtime(path: &Path, runtime_id: &str) -> Result<(), String> {
    let connection = open_links(path)?;
    reconcile_jobs(&connection, runtime_id)?;
    let active: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM codex_jobs WHERE runtime_id<>?1 AND status NOT IN ('completed','failed','cancelled','timed_out','interrupted'))",[runtime_id],|row|row.get(0)).map_err(|_| "Agent runtime ownership unavailable.")?;
    if active {
        Err(
            "Another Luczor process owns active Codex jobs. Stop them in that app instance first."
                .into(),
        )
    } else {
        Ok(())
    }
}
fn load_jobs(
    path: &Path,
    runtime_id: &str,
    principal: &str,
    project: Option<&str>,
) -> Result<Vec<CodexJobSnapshot>, String> {
    let connection = open_links(path)?;
    reconcile_jobs(&connection, runtime_id)?;
    let mut statement = connection.prepare("SELECT id,principal_id,project_id,status,external_thread_id,output_truncated,created_at,finished_at FROM codex_jobs WHERE principal_id=?1 AND (?2 IS NULL OR project_id=?2) ORDER BY created_at DESC LIMIT 200").map_err(|_| "Agent job history unavailable.")?;
    let rows = statement
        .query_map(params![principal, project], |row| {
            let status: String = row.get(3)?;
            Ok(CodexJobSnapshot {
                id: row.get(0)?,
                principal_id: row.get(1)?,
                project_id: row.get(2)?,
                error: (status == "interrupted").then(|| {
                    "The owning app process ended; no job was automatically resumed.".into()
                }),
                status,
                external_thread_id: row.get(4)?,
                output_truncated: row.get(5)?,
                created_at: row.get::<_, i64>(6)?.max(0) as u64,
                finished_at: row.get::<_, Option<i64>>(7)?.map(|n| n.max(0) as u64),
                output: String::new(),
                events: vec![],
                turn_completed: false,
                turn_failed: false,
            })
        })
        .map_err(|_| "Agent job history unavailable.")?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Agent job history unavailable.".into())
}
fn runtime_alive(runtime: &str) -> bool {
    let mut parts = runtime.split(':');
    let Some(pid) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
        return false;
    };
    let Some(started) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    process_stamp(pid) == Some(started)
}
#[cfg(windows)]
fn process_stamp(pid: u32) -> Option<u64> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::Threading::{
            GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut created = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        let mut code = 0;
        let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0
            && GetExitCodeProcess(handle, &mut code) != 0
            && code == 259;
        CloseHandle(handle);
        ok.then_some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
}
#[cfg(not(windows))]
fn process_stamp(_pid: u32) -> Option<u64> {
    None
}

fn owned_job(state: &CodexJobs, payload: &CodexJobPayload) -> Result<Arc<Job>, String> {
    let entries = state
        .entries
        .lock()
        .map_err(|_| "Agent job state unavailable.")?;
    let job = entries
        .get(&payload.job_id)
        .ok_or("Agent job does not exist in this app session.")?;
    if job.principal_id != payload.principal_id || job.project_id != payload.project_id {
        return Err("Agent job belongs to another project or account.".into());
    }
    Ok(Arc::clone(job))
}

fn validate_start(payload: &CodexStartPayload) -> Result<(), String> {
    if payload.prompt.trim().is_empty()
        || payload.prompt.chars().count() > 100_000
        || payload.prompt.contains('\0')
    {
        return Err("Agent prompt is empty, too long or contains a null character.".into());
    }
    if let Some(model) = &payload.model {
        if model.is_empty()
            || model.len() > 160
            || !model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/' | b':'))
        {
            return Err("Invalid Codex model ID.".into());
        }
    }
    if let Some(id) = &payload.external_thread_id {
        uuid::Uuid::parse_str(id).map_err(|_| "A managed Codex thread UUID is required.")?;
    }
    if payload
        .timeout_seconds
        .is_some_and(|seconds| seconds == 0 || seconds > 3600)
    {
        return Err("Codex timeout must be between 1 and 3600 seconds.".into());
    }
    Ok(())
}

fn verify_expected_binding(
    root: &Path,
    version: i64,
    expected_root: &str,
    expected_version: i64,
) -> Result<(), String> {
    if root != Path::new(expected_root) || version != expected_version {
        Err("Project workspace changed since the agent request was prepared.".into())
    } else {
        Ok(())
    }
}

fn workspaces_overlap(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    let (left, right) = (
        PathBuf::from(left.to_string_lossy().to_lowercase()),
        PathBuf::from(right.to_string_lossy().to_lowercase()),
    );
    left.starts_with(&right) || right.starts_with(&left)
}

pub(crate) fn find_codex() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    // Native executable only: Windows .cmd shims invoke a shell and cannot be
    // used safely for arbitrary model-generated prompt data or project names.
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
}

fn codex_args(payload: &CodexStartPayload) -> Vec<String> {
    let mut args = vec![
        "--ask-for-approval".into(),
        "never".into(),
        // Pin the reviewer so a user's auto-review default cannot silently
        // replace headless `never` with automatic permission escalation.
        "--config".into(),
        "approvals_reviewer=\"user\"".into(),
        // Codex's legacy workspace profile otherwise inherits extra roots and
        // network settings from user/project configuration, including resume.
        "--config".into(),
        "sandbox_workspace_write.writable_roots=[]".into(),
        "--config".into(),
        "sandbox_workspace_write.network_access=false".into(),
        "--config".into(),
        "sandbox_workspace_write.exclude_tmpdir_env_var=true".into(),
        "--config".into(),
        "sandbox_workspace_write.exclude_slash_tmp=true".into(),
        "exec".into(),
        "--sandbox".into(),
        payload.permission.as_str().into(),
        "--json".into(),
        "--color".into(),
        "never".into(),
    ];
    if let Some(model) = &payload.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = payload.effort {
        args.extend([
            "--config".into(),
            format!("model_reasoning_effort=\"{}\"", effort.as_str()),
        ]);
    }
    if let Some(id) = &payload.external_thread_id {
        args.extend(["resume".into(), id.clone()]);
    }
    args.push("-".into());
    args
}

fn run_job(
    app: &AppHandle,
    database: &Path,
    executable: &Path,
    job: &Arc<Job>,
    payload: &CodexStartPayload,
) -> Result<(), String> {
    if job.cancel.load(Ordering::Acquire) {
        finish(job, "cancelled", None);
        return Ok(());
    }
    check_execution(job)?;
    ensure_binding(app, job)?;
    super::agent_effort::validate_default_binding(
        app,
        &super::agent_effort::DefaultModelRequest {
            adapter_id: "codex".into(),
            principal_id: job.principal_id.clone(),
            project_id: job.project_id.clone(),
            expected_root_path: job.root.to_string_lossy().into_owned(),
            expected_workspace_updated_at: job.binding_version,
        },
        payload.model.as_deref(),
        payload.default_model_revision.as_deref(),
        executable,
        &|| {
            check_execution(job)
                .and_then(|_| ensure_binding(app, job))
                .and_then(|_| {
                    if job.cancel.load(Ordering::Acquire) {
                        Err("Codex job cancelled.".into())
                    } else {
                        Ok(())
                    }
                })
        },
    )?;
    validate_codex_effort(
        payload.model.as_deref(),
        payload.effort,
        payload.capability_revision.as_deref(),
    )?;
    let mut command = Command::new(executable);
    command
        .args(codex_args(payload))
        .current_dir(&job.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Codex could not start: {e}"))?;
    let lifetime = match LifetimeGuard::attach(&child) {
        Ok(guard) => guard,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    // A cancellation/rebind during spawn must stop before the prompt is sent.
    // Before stdin arrives the CLI has no task to execute.
    if job.cancel.load(Ordering::Acquire) {
        drop(lifetime);
        let _ = child.wait();
        finish(job, "cancelled", None);
        return Ok(());
    }
    if let Err(error) = check_execution(job).and_then(|_| ensure_binding(app, job)) {
        drop(lifetime);
        let _ = child.wait();
        return Err(error);
    }
    if let Ok(mut snapshot) = job.snapshot.lock() {
        if snapshot.status != "cancelling" {
            snapshot.status = "running".into();
        }
    }
    persist_current(job);
    let mut stdin = child.stdin.take().ok_or("Codex stdin unavailable.")?;
    let prompt = payload.prompt.as_bytes().to_vec();
    let input_job = Arc::clone(job);
    let input = thread::spawn(move || {
        if input_job.cancel.load(Ordering::Acquire) || check_execution(&input_job).is_err() {
            return Ok(());
        }
        stdin.write_all(&prompt)
    });
    let stdout = child.stdout.take().ok_or("Codex stdout unavailable.")?;
    let stderr = child.stderr.take().ok_or("Codex stderr unavailable.")?;
    let output_job = Arc::clone(job);
    let output = thread::spawn(move || read_jsonl(stdout, &output_job));
    let errors = thread::spawn(move || read_bounded(stderr, MAX_ERROR));
    let deadline = Instant::now() + Duration::from_secs(payload.timeout_seconds.unwrap_or(900));
    let mut binding_check = Instant::now();
    let mut terminal = "failed";
    let mut failure = None;
    let mut success = false;
    loop {
        if check_execution(job).is_err() {
            terminal = "cancelled";
            failure = Some("Execution policy changed; Codex job stopped.".into());
            break;
        }
        if job.cancel.load(Ordering::Acquire) {
            terminal = "cancelled";
            break;
        }
        if Instant::now() >= deadline {
            terminal = "timed_out";
            break;
        }
        if binding_check.elapsed() >= Duration::from_secs(1) {
            if let Err(error) = check_execution(job).and_then(|_| ensure_binding(app, job)) {
                failure = Some(error);
                break;
            }
            binding_check = Instant::now();
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                success = status.success();
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(error) => {
                failure = Some(format!("Codex process failed: {error}"));
                break;
            }
        }
    }
    // Closing the Windows job kills remaining descendants even if the CLI has
    // already exited, before waiting for pipe readers and child stdin.
    drop(lifetime);
    let _ = child.kill();
    let _ = child.wait();
    let drain_deadline = Instant::now() + Duration::from_secs(2);
    let input_result = super::process::finish_thread(input, drain_deadline, "Codex input")?;
    super::process::finish_thread(output, drain_deadline, "Codex output")?;
    let _error_output = super::process::finish_thread(errors, drain_deadline, "Codex error")?;
    let snapshot = job
        .snapshot
        .lock()
        .map_err(|_| "Agent job state unavailable.")?
        .clone();
    if !matches!(terminal, "cancelled" | "timed_out") {
        if job.cancel.load(Ordering::Acquire) {
            terminal = "cancelled";
        } else if success
            && snapshot.turn_completed
            && !snapshot.turn_failed
            && input_result.is_ok()
            && failure.is_none()
        {
            terminal = "completed";
        } else if failure.is_none() {
            failure = snapshot.error.clone().or_else(|| Some("Codex ended without a successful completed turn. Check the CLI installation, login and selected model in Codex.".into()));
        }
    }
    if let Some(thread_id) = &snapshot.external_thread_id {
        ensure_binding(app, job)?;
        save_link(database, payload, &job.root, job.binding_version, thread_id)?;
    }
    finish(job, terminal, failure);
    Ok(())
}

fn check_execution(job: &Job) -> Result<(), String> {
    job.execution
        .as_ref()
        .ok_or("Missing native execution admission.")?
        .check()
}

fn ensure_binding(app: &AppHandle, job: &Job) -> Result<(), String> {
    let current = agent_workspace_snapshot(app, &job.principal_id, &job.project_id)?;
    if current != (job.root.clone(), job.binding_version) {
        Err("Project workspace binding changed; Codex job stopped.".into())
    } else {
        Ok(())
    }
}

fn read_jsonl(mut reader: impl Read, job: &Job) {
    let mut buffer = [0u8; 8192];
    let mut line = Vec::new();
    let mut overflow = false;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                for byte in &buffer[..size] {
                    if *byte == b'\n' {
                        if !overflow {
                            apply_event(job, &line);
                        }
                        line.clear();
                        overflow = false;
                    } else if line.len() < MAX_LINE {
                        line.push(*byte);
                    } else {
                        overflow = true;
                        if let Ok(mut state) = job.snapshot.lock() {
                            state.output_truncated = true;
                        }
                    }
                }
            }
        }
    }
    if !overflow && !line.is_empty() {
        apply_event(job, &line);
    }
}

fn apply_event(job: &Job, bytes: &[u8]) {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return;
    };
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return;
    };
    let Ok(mut snapshot) = job.snapshot.lock() else {
        return;
    };
    let mut detail = None;
    match kind {
        "thread.started" => {
            if let Some(id) = value.get("thread_id").and_then(Value::as_str).filter(|id| {
                uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == *id)
            }) {
                if snapshot
                    .external_thread_id
                    .as_ref()
                    .is_some_and(|expected| expected != id)
                {
                    snapshot.turn_failed = true;
                    snapshot.error = Some(
                        "Codex returned a different session than the managed resume target.".into(),
                    );
                    job.cancel.store(true, Ordering::Release);
                } else {
                    snapshot.external_thread_id = Some(id.into());
                }
            }
        }
        "turn.completed" => snapshot.turn_completed = true,
        "turn.failed" => {
            snapshot.turn_failed = true;
            snapshot.error = Some(
                "Codex reported a failed turn. Check the CLI login and selected model in Codex."
                    .into(),
            );
        }
        "error" => {
            snapshot.error = Some(
                "Codex reported a runtime error. Check the CLI installation and login in Codex."
                    .into(),
            );
        }
        "turn.started" => {}
        "item.started" | "item.completed" | "item.updated" => {
            let Some(item_type) = value.pointer("/item/type").and_then(Value::as_str) else {
                return;
            };
            // Do not forward reasoning, commands, arguments or tool payloads.
            if !matches!(
                item_type,
                "agent_message"
                    | "command_execution"
                    | "file_change"
                    | "mcp_tool_call"
                    | "web_search"
                    | "todo_list"
            ) {
                return;
            }
            detail = Some(item_type.into());
            if kind == "item.completed" && item_type == "agent_message" {
                if let Some(text) = value.pointer("/item/text").and_then(Value::as_str) {
                    let remaining = MAX_OUTPUT.saturating_sub(snapshot.output.len());
                    let retained = truncate(text, remaining);
                    snapshot.output_truncated |= retained.len() < text.len();
                    if !snapshot.output.is_empty() && remaining > 1 {
                        snapshot.output.push('\n');
                    }
                    let remaining = MAX_OUTPUT.saturating_sub(snapshot.output.len());
                    snapshot.output.push_str(&truncate(&retained, remaining));
                }
            }
        }
        _ => return,
    }
    if snapshot.events.len() >= 100 {
        snapshot.events.remove(0);
    }
    snapshot.events.push(CodexEvent {
        r#type: kind.into(),
        detail,
    });
    drop(snapshot);
    if kind == "thread.started" {
        persist_current(job);
        if let Some(database) = &job.database {
            let id = job
                .snapshot
                .lock()
                .ok()
                .and_then(|snapshot| snapshot.external_thread_id.clone());
            if let Some(id) = id {
                if save_link_scope(
                    database,
                    (&job.principal_id, &job.project_id),
                    &job.root,
                    job.binding_version,
                    &id,
                )
                .is_err()
                {
                    job.cancel.store(true, Ordering::Release);
                    if let Ok(mut state) = job.snapshot.lock() {
                        state.error =
                            Some("Managed Codex session identity could not be saved.".into());
                    }
                }
            }
        }
    }
}

fn read_bounded(mut reader: impl Read, max: usize) -> String {
    let mut result = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                result.extend_from_slice(&buffer[..read.min(max.saturating_sub(result.len()))])
            }
        }
    }
    String::from_utf8_lossy(&result).into_owned()
}

fn truncate(value: &str, max: usize) -> String {
    let mut end = value.len().min(max);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].into()
}

fn is_terminal(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "cancelled" | "timed_out" | "interrupted"
    )
}

fn finish(job: &Job, status: &str, error: Option<String>) {
    if let Ok(mut snapshot) = job.snapshot.lock() {
        snapshot.status = status.into();
        snapshot.finished_at = Some(now_ms());
        if let Some(error) = error {
            snapshot.error = Some(truncate(&error, MAX_ERROR));
        }
    }
    persist_current(job);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn link_database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "App data path unavailable.")?
        .join("local-context")
        .join("v1");
    std::fs::create_dir_all(&directory).map_err(|_| "Managed agent storage unavailable.")?;
    Ok(directory.join("codex-links.sqlite3"))
}

fn open_links(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|_| "Managed agent links unavailable.")?;
    connection
        .execute_batch(
            "PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS codex_links (
            thread_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
            root_path TEXT NOT NULL, binding_version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS codex_session_times (thread_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS codex_jobs (
            id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
            runtime_id TEXT NOT NULL, status TEXT NOT NULL, external_thread_id TEXT,
            output_truncated INTEGER NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER);
        CREATE INDEX IF NOT EXISTS codex_jobs_scope ON codex_jobs(principal_id,project_id,created_at);",
        )
        .map_err(|_| "Managed agent links unavailable.")?;
    Ok(connection)
}

fn verify_link(
    path: &Path,
    payload: &CodexStartPayload,
    root: &Path,
    version: i64,
    id: &str,
) -> Result<(), String> {
    verify_link_scope(
        path,
        (&payload.principal_id, &payload.project_id),
        root,
        version,
        id,
    )
}

fn verify_link_scope(
    path: &Path,
    identity: (&str, &str),
    root: &Path,
    version: i64,
    id: &str,
) -> Result<(), String> {
    let connection = open_links(path)?;
    let exists: Option<i64> = connection.query_row(
        "SELECT 1 FROM codex_links WHERE thread_id=?1 AND principal_id=?2 AND project_id=?3 AND root_path=?4 AND binding_version=?5",
        params![id, identity.0, identity.1, root.to_string_lossy(), version], |row| row.get(0))
        .optional().map_err(|_| "Managed agent link could not be verified.")?;
    if exists.is_some() {
        Ok(())
    } else {
        Err("Codex thread is not managed by this project and workspace binding.".into())
    }
}

fn save_link(
    path: &Path,
    payload: &CodexStartPayload,
    root: &Path,
    version: i64,
    id: &str,
) -> Result<(), String> {
    save_link_scope(
        path,
        (&payload.principal_id, &payload.project_id),
        root,
        version,
        id,
    )
}
fn save_link_scope(
    path: &Path,
    identity: (&str, &str),
    root: &Path,
    version: i64,
    id: &str,
) -> Result<(), String> {
    if !uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id) {
        return Err("Managed session ID is not canonical.".into());
    }
    let connection = open_links(path)?;
    connection.execute("INSERT OR IGNORE INTO codex_links (thread_id,principal_id,project_id,root_path,binding_version) VALUES (?1,?2,?3,?4,?5)",params![id,identity.0,identity.1,root.to_string_lossy(),version]).map_err(|_|"Managed Codex session link could not be saved.")?;
    verify_link_scope(path, identity, root, version, id)?;
    connection
        .execute(
            "INSERT OR REPLACE INTO codex_session_times(thread_id,updated_at) VALUES (?1,?2)",
            params![id, now_ms() as i64],
        )
        .map_err(|_| "Managed session timestamp could not be saved.")?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn configure_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0000_0004 | 0x0000_0200 | 0x0800_0000);
}

#[cfg(unix)]
pub(crate) fn configure_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn configure_process(_command: &mut Command) {}

pub(crate) struct LifetimeGuard {
    handle: isize,
}

#[cfg(windows)]
impl LifetimeGuard {
    pub(crate) fn attach(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("Codex process protection could not be created.".into());
            }
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle().cast()) == 0
            {
                CloseHandle(handle);
                return Err("Codex process could not be bound to its protected lifetime.".into());
            }
            let guard = Self {
                handle: handle as isize,
            };
            // The child was created suspended. No user code can create an
            // escaping descendant before the Job Object owns its lifetime.
            resume_suspended_child(child)?;
            Ok(guard)
        }
    }
}

#[cfg(windows)]
fn resume_suspended_child(child: &Child) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("Protected process thread enumeration failed.".into());
        }
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut found = None;
        let mut next = Thread32First(snapshot, &mut entry);
        while next != 0 {
            if entry.th32OwnerProcessID == child.id() {
                found = Some(entry.th32ThreadID);
                break;
            }
            next = Thread32Next(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        let thread = OpenThread(
            THREAD_SUSPEND_RESUME,
            0,
            found.ok_or("Protected process startup thread unavailable.")?,
        );
        if thread.is_null() {
            return Err("Protected process startup thread could not be opened.".into());
        }
        let prior_count = ResumeThread(thread);
        CloseHandle(thread);
        if prior_count != 1 {
            return Err(
                "Protected process startup thread had an unexpected suspension state.".into(),
            );
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for LifetimeGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}

#[cfg(not(windows))]
impl LifetimeGuard {
    pub(crate) fn attach(_child: &Child) -> Result<Self, String> {
        Err(
            "Managed Codex jobs require Windows process lifetime protection on this version."
                .into(),
        )
    }
}

#[cfg(not(windows))]
impl Drop for LifetimeGuard {
    fn drop(&mut self) {
        let _ = self.handle;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> CodexStartPayload {
        serde_json::from_value(serde_json::json!({"principalId":"account:1","projectId":"one","expectedRootPath":"test","expectedWorkspaceUpdatedAt":1,"prompt":"Review; $(do not execute) `quoted`"})).unwrap()
    }

    fn job() -> Job {
        Job {
            principal_id: "account:1".into(),
            project_id: "one".into(),
            root: PathBuf::from("test"),
            binding_version: 1,
            cancel: AtomicBool::new(false),
            writing: false,
            execution: None,
            database: None,
            runtime_id: "test".into(),
            snapshot: Mutex::new(CodexJobSnapshot {
                id: "job".into(),
                principal_id: "account:1".into(),
                project_id: "one".into(),
                status: "running".into(),
                external_thread_id: None,
                output: String::new(),
                error: None,
                output_truncated: false,
                created_at: 0,
                finished_at: None,
                events: vec![],
                turn_completed: false,
                turn_failed: false,
            }),
        }
    }

    #[test]
    fn prompts_never_enter_cli_arguments_and_sandbox_is_explicit() {
        let mut data = payload();
        let args = codex_args(&data);
        assert!(!args.contains(&data.prompt));
        assert!(args.contains(&"read-only".into()));
        assert_eq!(args.last().unwrap(), "-");
        data.permission = CodexPermission::WorkspaceWrite;
        data.external_thread_id = Some(uuid::Uuid::new_v4().to_string());
        assert!(codex_args(&data)
            .windows(2)
            .any(|a| a == ["--sandbox", "workspace-write"]));
        assert!(codex_args(&data).contains(&"resume".into()));
        assert!(!codex_args(&data)
            .iter()
            .any(|arg| arg.contains("dangerous")));
        for config in [
            "approvals_reviewer=\"user\"",
            "sandbox_workspace_write.writable_roots=[]",
            "sandbox_workspace_write.network_access=false",
            "sandbox_workspace_write.exclude_tmpdir_env_var=true",
            "sandbox_workspace_write.exclude_slash_tmp=true",
        ] {
            assert!(codex_args(&data)
                .windows(2)
                .any(|pair| pair == ["--config", config]));
        }
    }

    #[test]
    fn explicit_model_and_typed_effort_are_preserved_for_new_and_resumed_jobs() {
        let mut data = payload();
        data.model = Some("gpt-6-astra".into());
        data.effort = Some(AgentEffort::Ultra);
        for resume in [None, Some(uuid::Uuid::new_v4().to_string())] {
            data.external_thread_id = resume;
            let args = codex_args(&data);
            assert!(args
                .windows(2)
                .any(|pair| pair == ["--model", "gpt-6-astra"]));
            assert!(args
                .windows(2)
                .any(|pair| pair == ["--config", "model_reasoning_effort=\"ultra\""]));
            assert!(!args.contains(&data.prompt));
        }
    }

    #[test]
    fn reject_invalid_input_and_unknown_permissions() {
        let mut data = payload();
        data.model = Some("--dangerously-bypass-approvals-and-sandbox evil".into());
        assert!(validate_start(&data).is_err());
        data.model = None;
        data.external_thread_id = Some("--last".into());
        assert!(validate_start(&data).is_err());
        assert!(serde_json::from_value::<CodexStartPayload>(serde_json::json!({"principalId":"a","projectId":"p","prompt":"x","permission":"danger-full-access"})).is_err());
    }

    #[test]
    fn output_filters_reasoning_and_keeps_only_verified_session_ids() {
        let data = job();
        apply_event(
            &data,
            br#"{"type":"thread.started","thread_id":"not-a-uuid"}"#,
        );
        apply_event(
            &data,
            br#"{"type":"item.completed","item":{"type":"reasoning","text":"private reasoning"}}"#,
        );
        apply_event(&data, br#"{"type":"item.completed","item":{"type":"agent_message","text":"Finished review"}}"#);
        apply_event(
            &data,
            br#"{"type":"turn.failed","error":{"message":"failed"}}"#,
        );
        let state = data.snapshot.lock().unwrap();
        assert!(state.external_thread_id.is_none());
        assert_eq!(state.output, "Finished review");
        assert!(state.turn_failed);
        assert!(!state.turn_completed);
        assert!(!serde_json::to_string(&*state)
            .unwrap()
            .contains("private reasoning"));
    }

    #[test]
    fn jsonl_reader_drains_oversize_lines_and_preserves_utf8_boundaries() {
        let data = job();
        let mut input = vec![b'x'; MAX_LINE + 50];
        input.extend_from_slice(b"\n{\"type\":\"turn.completed\"}\n");
        read_jsonl(&input[..], &data);
        let state = data.snapshot.lock().unwrap();
        assert!(state.output_truncated && state.turn_completed);
        assert_eq!(truncate("äöü", 3), "ä");
    }

    #[test]
    fn managed_resume_is_scoped_to_principal_project_root_and_version() {
        let directory =
            std::env::temp_dir().join(format!("luczor-codex-links-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("links.sqlite3");
        let id = uuid::Uuid::new_v4().to_string();
        let mut data = payload();
        save_link(&database, &data, &directory, 1, &id).unwrap();
        assert!(verify_link(&database, &data, &directory, 1, &id).is_ok());
        assert!(verify_link(&database, &data, &directory, 2, &id).is_err());
        assert!(verify_link(&database, &data, Path::new("another"), 1, &id).is_err());
        data.project_id = "foreign".into();
        assert!(verify_link(&database, &data, &directory, 1, &id).is_err());
        data.project_id = "one".into();
        data.principal_id = "account:2".into();
        assert!(verify_link(&database, &data, &directory, 1, &id).is_err());
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn status_and_cancel_cannot_access_other_projects() {
        let registry = CodexJobs::default();
        registry
            .entries
            .lock()
            .unwrap()
            .insert("job".into(), Arc::new(job()));
        let mut request = CodexJobPayload {
            principal_id: "account:1".into(),
            project_id: "one".into(),
            job_id: "job".into(),
        };
        assert!(owned_job(&registry, &request).is_ok());
        request.project_id = "two".into();
        assert!(owned_job(&registry, &request).is_err());
    }

    #[test]
    fn expected_workspace_snapshot_prevents_dispatch_after_rebinding() {
        assert!(verify_expected_binding(Path::new("one"), 3, "one", 3).is_ok());
        assert!(verify_expected_binding(Path::new("two"), 3, "one", 3).is_err());
        assert!(verify_expected_binding(Path::new("one"), 4, "one", 3).is_err());
    }

    #[test]
    fn nested_workspaces_cannot_run_conflicting_jobs() {
        assert!(workspaces_overlap(
            Path::new("project"),
            Path::new("project/src")
        ));
        assert!(!workspaces_overlap(
            Path::new("project"),
            Path::new("project-other")
        ));
        #[cfg(windows)]
        assert!(workspaces_overlap(
            Path::new("PROJECT"),
            Path::new("project/src")
        ));
    }

    #[test]
    fn shared_workspace_lease_excludes_legacy_and_managed_overlap_until_release() {
        let root =
            std::env::temp_dir().join(format!("luczor-workspace-lease-{}", uuid::Uuid::new_v4()));
        let lease = acquire_workspace_lease(&root, true).unwrap();
        assert!(acquire_workspace_lease(&root, true).is_err());
        assert!(acquire_workspace_lease(&root.join("src"), false).is_err());
        let separate = acquire_workspace_lease(
            &root.with_file_name(format!("luczor-other-{}", uuid::Uuid::new_v4())),
            true,
        )
        .unwrap();
        drop(separate);
        drop(lease);
        assert!(acquire_workspace_lease(&root, true).is_ok());
    }

    #[test]
    fn shared_read_leases_allow_readers_and_reject_overlapping_writer() {
        let root = std::env::temp_dir().join(format!("luczor-read-lease-{}", uuid::Uuid::new_v4()));
        let one = acquire_workspace_lease(&root, false).unwrap();
        let two = acquire_workspace_lease(&root.join("src"), false).unwrap();
        assert!(acquire_workspace_lease(&root, true).is_err());
        drop(one);
        drop(two);
        assert!(acquire_workspace_lease(&root, true).is_ok());
    }

    #[test]
    fn durable_history_reconciles_only_dead_runtimes_and_never_stores_content() {
        let directory =
            std::env::temp_dir().join(format!("luczor-job-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("jobs.sqlite3");
        let data = job();
        let mut snapshot = data.snapshot.lock().unwrap().clone();
        snapshot.output = "PROMPT_AND_RESULT_SECRET".into();
        snapshot.error = Some("PRIVATE_RUNTIME_ERROR".into());
        snapshot.external_thread_id = Some(uuid::Uuid::new_v4().to_string());
        persist_job(&path, "dead-runtime", &snapshot).unwrap();
        assert!(load_jobs(&path, "current", "another", None)
            .unwrap()
            .is_empty());
        assert!(load_jobs(&path, "current", "account:1", Some("another"))
            .unwrap()
            .is_empty());
        let rows = load_jobs(&path, "current", "account:1", Some("one")).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "interrupted");
        assert!(rows[0].finished_at.is_some());
        assert!(rows[0].output.is_empty());
        assert_eq!(rows[0].external_thread_id, snapshot.external_thread_id);
        let bytes = std::fs::read(&path).unwrap();
        let disk = String::from_utf8_lossy(&bytes);
        assert!(!disk.contains("PROMPT_AND_RESULT_SECRET"));
        assert!(!disk.contains("PRIVATE_RUNTIME_ERROR"));
        snapshot.id = "current-job".into();
        persist_job(&path, "current", &snapshot).unwrap();
        let rows = load_jobs(&path, "current", "account:1", None).unwrap();
        assert_eq!(
            rows.iter()
                .find(|row| row.id == "current-job")
                .unwrap()
                .status,
            "running"
        );
        #[cfg(windows)]
        {
            let live = CodexJobs::default();
            snapshot.id = "live-other-instance".into();
            persist_job(&path, &live.runtime_id, &snapshot).unwrap();
            assert!(ensure_no_foreign_runtime(&path, "other").is_err());
            let rows = load_jobs(&path, "other", "account:1", None).unwrap();
            assert_eq!(
                rows.iter()
                    .find(|row| row.id == "live-other-instance")
                    .unwrap()
                    .status,
                "running"
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn guarded_payload_deserializes_execution_without_weakening_inner_validation() {
        let value = serde_json::json!({"execution":{"sessionId":uuid::Uuid::new_v4().to_string(),"generation":1},"principalId":"a","projectId":"p","expectedRootPath":"test","expectedWorkspaceUpdatedAt":1,"prompt":"x"});
        assert!(serde_json::from_value::<Guarded<CodexStartPayload>>(value.clone()).is_ok());
        let mut invalid = value;
        invalid["unapprovedOption"] = true.into();
        assert!(serde_json::from_value::<Guarded<CodexStartPayload>>(invalid).is_err());
    }

    #[test]
    fn desktop_handoff_encodes_the_bound_path_as_one_query_value() {
        let path = Path::new(r"C:\Users\Example\A & B\ä?prompt=evil");
        let url = reqwest::Url::parse(&desktop_project_url(path)).unwrap();
        assert_eq!(url.scheme(), "codex");
        assert_eq!(url.host_str(), Some("threads"));
        assert_eq!(url.path(), "/new");
        let parameters: Vec<_> = url.query_pairs().collect();
        assert_eq!(parameters.len(), 1);
        assert_eq!(parameters[0].0, "path");
        assert_eq!(parameters[0].1, path.to_string_lossy());
    }

    #[cfg(windows)]
    #[test]
    fn process_cannot_execute_before_its_job_object_is_attached() {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C", "exit 7"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process(&mut command);
        let mut child = command.spawn().unwrap();
        thread::sleep(Duration::from_millis(75));
        assert!(child.try_wait().unwrap().is_none());
        let guard = LifetimeGuard::attach(&child).unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(child.wait().unwrap().code(), Some(7));
        drop(guard);
    }

    #[cfg(windows)]
    #[test]
    fn dropping_process_guard_terminates_the_owned_child() {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C", "ping 127.0.0.1 -n 20 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process(&mut command);
        let mut child = command.spawn().unwrap();
        let guard = LifetimeGuard::attach(&child).unwrap();
        thread::sleep(Duration::from_millis(100));
        assert!(child.try_wait().unwrap().is_none());
        drop(guard);
        let started = Instant::now();
        while child.try_wait().unwrap().is_none() {
            assert!(started.elapsed() < Duration::from_secs(4));
            thread::sleep(Duration::from_millis(20));
        }
        // Windows kill-on-close can report exit code zero; observed process
        // termination before the 20-second workload is the relevant evidence.
        child.wait().unwrap();
    }
}
