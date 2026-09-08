//! Local, project-bound workspace and filesystem commands.
//!
//! A workspace binding is local-only and keyed by the verified account
//! principal plus Luczor project ID. Model-facing filesystem calls never
//! accept an absolute root: they resolve relative paths through this binding.
//! The installed Tauri capability makes the local `main` webview the native
//! trust boundary; model-facing tool results must continue to omit root paths.

use ignore::{overrides::OverrideBuilder, DirEntry, WalkBuilder};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewWindow};
use uuid::Uuid;

use super::ensure_main_webview;
use super::execution::{admit, ExecutionLease, Guarded};

const DEFAULT_LIST_ENTRIES: usize = 200;
const MAX_LIST_ENTRIES: usize = 1_000;
const DEFAULT_LIST_DEPTH: usize = 1;
const MAX_LIST_DEPTH: usize = 6;
const MAX_LIST_SCANNED_ENTRIES: usize = 10_000;
const DEFAULT_READ_BYTES: usize = 64 * 1024;
const MAX_READ_BYTES: usize = 256 * 1024;
const MAX_TEXT_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LINE_NUMBER: usize = 1_000_000;
const MAX_LINE_SPAN: usize = 5_000;
const DEFAULT_SEARCH_RESULTS: usize = 50;
const MAX_SEARCH_RESULTS: usize = 200;
const DEFAULT_SEARCH_FILES: usize = 5_000;
const MAX_SEARCH_FILES: usize = 20_000;
const MAX_SEARCH_DEPTH: usize = 32;
const MAX_SEARCH_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SEARCH_DURATION: Duration = Duration::from_secs(5);
const MAX_SEARCH_QUERY_CHARS: usize = 512;
const MAX_SEARCH_PREVIEW_CHARS: usize = 500;
const MAX_RELATIVE_PATH_CHARS: usize = 4_096;
const MAX_PATH_SEGMENT_CHARS: usize = 255;

#[derive(Debug, Clone)]
struct BoundWorkspace {
    principal_id: String,
    project_id: String,
    root_path: PathBuf,
    display_name: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBinding {
    principal_id: String,
    project_id: String,
    root_path: String,
    display_name: String,
    is_git_repository: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_root_path: Option<String>,
    status: String,
    created_at: i64,
    updated_at: i64,
}

impl WorkspaceBinding {
    fn from_bound(bound: &BoundWorkspace) -> Self {
        let status = workspace_status(&bound.root_path);
        let git_root = (status == "ready")
            .then(|| find_git_root(&bound.root_path))
            .flatten();
        Self {
            principal_id: bound.principal_id.clone(),
            project_id: bound.project_id.clone(),
            root_path: bound.root_path.to_string_lossy().to_string(),
            display_name: bound.display_name.clone(),
            is_git_repository: git_root.is_some(),
            git_root_path: git_root.map(|path| path.to_string_lossy().to_string()),
            status: status.into(),
            created_at: bound.created_at,
            updated_at: bound.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBindPayload {
    principal_id: String,
    project_id: String,
    root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdentityPayload {
    principal_id: String,
    project_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUnbindResult {
    removed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListPayload {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    path: Option<String>,
    max_depth: Option<usize>,
    #[serde(alias = "maxEntries")]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStatPayload {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadPayload {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_bytes: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsSearchPayload {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    query: String,
    path: Option<String>,
    glob: Option<String>,
    case_sensitive: Option<bool>,
    #[serde(alias = "maxResults")]
    limit: Option<usize>,
    max_files: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWritePayload {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    path: String,
    content: String,
    expected_sha256: Option<String>,
    #[serde(default)]
    origin_run_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCreateDirPayload {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    path: String,
    recursive: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsMovePayload {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    from_path: String,
    to_path: String,
    overwrite: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsDeletePayload {
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    path: String,
    recursive: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    path: String,
    name: String,
    kind: String,
    bytes: u64,
    modified_at: Option<i64>,
    readonly: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListResult {
    path: String,
    entries: Vec<FsEntry>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStatResult {
    path: String,
    name: String,
    kind: String,
    bytes: u64,
    modified_at: Option<i64>,
    readonly: bool,
    sha256: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadResult {
    path: String,
    content: String,
    start_line: usize,
    end_line: usize,
    total_lines: usize,
    bytes: u64,
    sha256: String,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsSearchMatch {
    path: String,
    line: usize,
    column: usize,
    preview: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsSearchResult {
    path: String,
    query: String,
    matches: Vec<FsSearchMatch>,
    scanned_files: usize,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteResult {
    path: String,
    bytes: usize,
    sha256: String,
    created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCreateDirResult {
    path: String,
    created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsMoveResult {
    from_path: String,
    to_path: String,
    kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsDeleteResult {
    path: String,
    kind: String,
    deleted: bool,
}

#[tauri::command]
pub async fn project_workspace_bind(
    window: WebviewWindow,
    app: AppHandle,
    payload: WorkspaceBindPayload,
) -> Result<WorkspaceBinding, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = mutation_guard()?;
        let mut connection = open_database(&app)?;
        bind_workspace(
            &mut connection,
            &payload.principal_id,
            &payload.project_id,
            Path::new(&payload.root_path),
        )
        .map(|bound| WorkspaceBinding::from_bound(&bound))
    })
    .await
    .map_err(|error| format!("Workspace bind task failed: {error}"))?
}

#[tauri::command]
pub async fn project_workspace_get(
    window: WebviewWindow,
    app: AppHandle,
    payload: WorkspaceIdentityPayload,
) -> Result<Option<WorkspaceBinding>, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = mutation_guard()?;
        let connection = open_database(&app)?;
        Ok(
            get_workspace(&connection, &payload.principal_id, &payload.project_id)?
                .map(|bound| WorkspaceBinding::from_bound(&bound)),
        )
    })
    .await
    .map_err(|error| format!("Workspace status task failed: {error}"))?
}

#[tauri::command]
pub async fn project_workspace_unbind(
    window: WebviewWindow,
    app: AppHandle,
    payload: WorkspaceIdentityPayload,
) -> Result<WorkspaceUnbindResult, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = mutation_guard()?;
        let connection = open_database(&app)?;
        validate_identity(&payload.principal_id, &payload.project_id)?;
        let removed = connection
            .execute(
                "DELETE FROM project_workspace_bindings WHERE principal_id = ?1 AND project_id = ?2",
                params![payload.principal_id, payload.project_id],
            )
            .map_err(db_error)?
            > 0;
        Ok(WorkspaceUnbindResult { removed })
    })
    .await
    .map_err(|error| format!("Workspace unbind task failed: {error}"))?
}

#[tauri::command]
pub async fn project_fs_list(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<FsListPayload>,
) -> Result<FsListResult, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, false)?;
    let payload = payload.request;
    tauri::async_runtime::spawn_blocking(move || {
        with_workspace(
            &app,
            &payload.principal_id,
            &payload.project_id,
            &payload.expected_root_path,
            payload.expected_workspace_updated_at,
            |root| {
                gate.check()?;
                list_directory(
                    root,
                    payload.path.as_deref().unwrap_or(""),
                    payload
                        .limit
                        .unwrap_or(DEFAULT_LIST_ENTRIES)
                        .clamp(1, MAX_LIST_ENTRIES),
                    payload
                        .max_depth
                        .unwrap_or(DEFAULT_LIST_DEPTH)
                        .clamp(1, MAX_LIST_DEPTH),
                )
            },
        )
    })
    .await
    .map_err(|error| format!("Project file list task failed: {error}"))?
}

#[tauri::command]
pub async fn project_fs_stat(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<FsStatPayload>,
) -> Result<FsStatResult, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, false)?;
    let payload = payload.request;
    tauri::async_runtime::spawn_blocking(move || {
        with_workspace(
            &app,
            &payload.principal_id,
            &payload.project_id,
            &payload.expected_root_path,
            payload.expected_workspace_updated_at,
            |root| {
                gate.check()?;
                stat_path(root, &payload.path)
            },
        )
    })
    .await
    .map_err(|error| format!("Project file stat task failed: {error}"))?
}

#[tauri::command]
pub async fn project_fs_read(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<FsReadPayload>,
) -> Result<FsReadResult, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, false)?;
    let payload = payload.request;
    tauri::async_runtime::spawn_blocking(move || {
        with_workspace(
            &app,
            &payload.principal_id,
            &payload.project_id,
            &payload.expected_root_path,
            payload.expected_workspace_updated_at,
            |root| {
                gate.check()?;
                read_text(
                    root,
                    &payload.path,
                    payload.start_line,
                    payload.end_line,
                    payload.max_bytes,
                )
            },
        )
    })
    .await
    .map_err(|error| format!("Project file read task failed: {error}"))?
}

#[tauri::command]
pub async fn project_fs_search(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<FsSearchPayload>,
) -> Result<FsSearchResult, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, false)?;
    let payload = payload.request;
    tauri::async_runtime::spawn_blocking(move || {
        with_workspace(
            &app,
            &payload.principal_id,
            &payload.project_id,
            &payload.expected_root_path,
            payload.expected_workspace_updated_at,
            |root| {
                gate.check()?;
                search_text(
                    root,
                    payload.path.as_deref().unwrap_or(""),
                    &payload.query,
                    payload.glob.as_deref(),
                    payload.case_sensitive.unwrap_or(false),
                    payload
                        .limit
                        .unwrap_or(DEFAULT_SEARCH_RESULTS)
                        .clamp(1, MAX_SEARCH_RESULTS),
                    payload
                        .max_files
                        .unwrap_or(DEFAULT_SEARCH_FILES)
                        .clamp(1, MAX_SEARCH_FILES),
                )
            },
        )
    })
    .await
    .map_err(|error| format!("Project file search task failed: {error}"))?
}

#[tauri::command]
pub async fn project_fs_write(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<FsWritePayload>,
) -> Result<FsWriteResult, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
    tauri::async_runtime::spawn_blocking(move || {
        with_workspace_mutation(
            &app,
            &payload.principal_id,
            &payload.project_id,
            &payload.expected_root_path,
            payload.expected_workspace_updated_at,
            &gate,
            |root, gate| {
                let result = write_text_locked(
                    root,
                    &payload.path,
                    &payload.content,
                    payload.expected_sha256.as_deref(),
                    Some(gate),
                )?;
                if let Some(origin) = &payload.origin_run_id {
                    super::workflow_watch::record_write(
                        root,
                        &payload.path,
                        &result.sha256,
                        origin,
                    );
                }
                Ok(result)
            },
        )
    })
    .await
    .map_err(|error| format!("Project file write task failed: {error}"))?
}

#[tauri::command]
pub async fn project_fs_create_dir(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<FsCreateDirPayload>,
) -> Result<FsCreateDirResult, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
    tauri::async_runtime::spawn_blocking(move || {
        with_workspace_mutation(
            &app,
            &payload.principal_id,
            &payload.project_id,
            &payload.expected_root_path,
            payload.expected_workspace_updated_at,
            &gate,
            |root, gate| {
                create_directory_locked(
                    root,
                    &payload.path,
                    payload.recursive.unwrap_or(false),
                    Some(gate),
                )
            },
        )
    })
    .await
    .map_err(|error| format!("Project directory creation task failed: {error}"))?
}

#[tauri::command]
pub async fn project_fs_move(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<FsMovePayload>,
) -> Result<FsMoveResult, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
    tauri::async_runtime::spawn_blocking(move || {
        with_workspace_mutation(
            &app,
            &payload.principal_id,
            &payload.project_id,
            &payload.expected_root_path,
            payload.expected_workspace_updated_at,
            &gate,
            |root, gate| {
                move_path_locked(
                    root,
                    &payload.from_path,
                    &payload.to_path,
                    payload.overwrite.unwrap_or(false),
                    Some(gate),
                )
            },
        )
    })
    .await
    .map_err(|error| format!("Project file move task failed: {error}"))?
}

#[tauri::command]
pub async fn project_fs_delete(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<FsDeletePayload>,
) -> Result<FsDeleteResult, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, true)?;
    let payload = payload.request;
    tauri::async_runtime::spawn_blocking(move || {
        with_workspace_mutation(
            &app,
            &payload.principal_id,
            &payload.project_id,
            &payload.expected_root_path,
            payload.expected_workspace_updated_at,
            &gate,
            |root, gate| {
                delete_path_locked(
                    root,
                    &payload.path,
                    payload.recursive.unwrap_or(false),
                    Some(gate),
                )
            },
        )
    })
    .await
    .map_err(|error| format!("Project file delete task failed: {error}"))?
}

/// Capture the authoritative binding for a managed native agent. The version
/// lets a running job stop when a project is rebound while it is working.
pub(crate) fn agent_workspace_snapshot(
    app: &AppHandle,
    principal_id: &str,
    project_id: &str,
) -> Result<(PathBuf, i64), String> {
    let connection = open_database(app)?;
    let bound = get_workspace(&connection, principal_id, project_id)?
        .ok_or_else(|| "No local workspace is bound to this project.".to_string())?;
    Ok((validate_bound_root(&bound.root_path)?, bound.updated_at))
}

fn with_workspace<T>(
    app: &AppHandle,
    principal_id: &str,
    project_id: &str,
    expected_root_path: &str,
    expected_workspace_updated_at: i64,
    operation: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let connection = open_database(app)?;
    let bound = get_workspace(&connection, principal_id, project_id)?
        .ok_or_else(|| "No local workspace is bound to this project.".to_string())?;
    validate_expected_workspace(&bound, expected_root_path, expected_workspace_updated_at)?;
    let root = validate_bound_root(&bound.root_path)?;
    operation(&root)
}

fn validate_expected_workspace(
    bound: &BoundWorkspace,
    expected_root_path: &str,
    expected_workspace_updated_at: i64,
) -> Result<(), String> {
    if bound.root_path != Path::new(expected_root_path)
        || bound.updated_at != expected_workspace_updated_at
    {
        return Err("The project workspace binding changed before execution.".into());
    }
    Ok(())
}

pub(crate) fn with_workspace_mutation<T>(
    app: &AppHandle,
    principal_id: &str,
    project_id: &str,
    expected_root_path: &str,
    expected_workspace_updated_at: i64,
    gate: &ExecutionLease,
    operation: impl FnOnce(&Path, &ExecutionLease) -> Result<T, String>,
) -> Result<T, String> {
    let _workspace = mutation_guard()?;
    with_workspace(
        app,
        principal_id,
        project_id,
        expected_root_path,
        expected_workspace_updated_at,
        |root| {
            gate.check()?;
            operation(root, gate)
        },
    )
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve the local application data directory.".to_string())?
        .join("local-context")
        .join("v1");
    fs::create_dir_all(&directory)
        .map_err(|_| "Cannot create the local workspace database directory.".to_string())?;
    let connection = Connection::open(directory.join("local-context.sqlite3")).map_err(db_error)?;
    initialize_schema(&connection)?;
    Ok(connection)
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS project_workspace_bindings (
                principal_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                root_path TEXT NOT NULL,
                display_name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(principal_id, project_id),
                UNIQUE(principal_id, workspace_id)
             );
             CREATE UNIQUE INDEX IF NOT EXISTS project_workspace_principal_root_unique
             ON project_workspace_bindings(principal_id, root_path COLLATE NOCASE);",
        )
        .map_err(db_error)
}

fn bind_workspace(
    connection: &mut Connection,
    principal_id: &str,
    project_id: &str,
    root_path: &Path,
) -> Result<BoundWorkspace, String> {
    validate_identity(principal_id, project_id)?;
    let root = validate_workspace_root(root_path)?;
    let display_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Workspace")
        .to_string();
    let now = unix_timestamp();
    let root_string = root.to_string_lossy().to_string();
    let root_owner: Option<String> = connection
        .query_row(
            "SELECT project_id FROM project_workspace_bindings
             WHERE principal_id = ?1 AND root_path = ?2 COLLATE NOCASE AND project_id <> ?3",
            params![principal_id, root_string, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if root_owner.is_some() {
        return Err("Workspace root is already bound to another project.".into());
    }
    let existing: Option<(String, i64)> = connection
        .query_row(
            "SELECT workspace_id, created_at FROM project_workspace_bindings
             WHERE principal_id = ?1 AND project_id = ?2",
            params![principal_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    let workspace_id = existing
        .as_ref()
        .map(|value| value.0.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let created_at = existing.as_ref().map(|value| value.1).unwrap_or(now);
    if existing.is_some() {
        connection
            .execute(
                "UPDATE project_workspace_bindings
                 SET root_path = ?3, display_name = ?4, updated_at = ?5
                 WHERE principal_id = ?1 AND project_id = ?2",
                params![principal_id, project_id, root_string, display_name, now],
            )
            .map_err(db_error)?;
    } else {
        connection
            .execute(
                "INSERT INTO project_workspace_bindings
                    (principal_id, project_id, workspace_id, root_path, display_name, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    principal_id,
                    project_id,
                    workspace_id,
                    root_string,
                    display_name,
                    created_at,
                    now
                ],
            )
            .map_err(db_error)?;
    }
    Ok(BoundWorkspace {
        principal_id: principal_id.to_string(),
        project_id: project_id.to_string(),
        root_path: root,
        display_name,
        created_at,
        updated_at: now,
    })
}

fn get_workspace(
    connection: &Connection,
    principal_id: &str,
    project_id: &str,
) -> Result<Option<BoundWorkspace>, String> {
    validate_identity(principal_id, project_id)?;
    connection
        .query_row(
            "SELECT project_id, root_path, display_name, created_at, updated_at
             FROM project_workspace_bindings WHERE principal_id = ?1 AND project_id = ?2",
            params![principal_id, project_id],
            |row| {
                Ok(BoundWorkspace {
                    principal_id: principal_id.to_string(),
                    project_id: row.get(0)?,
                    root_path: PathBuf::from(row.get::<_, String>(1)?),
                    display_name: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(db_error)
}

fn validate_identity(principal_id: &str, project_id: &str) -> Result<(), String> {
    if principal_id.trim() != principal_id
        || principal_id.is_empty()
        || principal_id.len() > 200
        || !principal_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
    {
        return Err("Principal ID is invalid.".into());
    }
    if project_id.trim() != project_id
        || project_id.is_empty()
        || project_id.chars().count() > 120
        || project_id.chars().any(char::is_control)
    {
        return Err("Project ID is invalid.".into());
    }
    Ok(())
}

fn validate_workspace_root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Workspace root must be an absolute directory selected by the user.".into());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "Workspace root does not exist or cannot be read.".to_string())?;
    if is_link_like(&metadata) {
        return Err("Workspace root must not be a symbolic link or junction.".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Workspace root cannot be resolved.".to_string())?;
    let canonical_metadata = fs::symlink_metadata(&canonical)
        .map_err(|_| "Workspace root cannot be inspected.".to_string())?;
    if !canonical_metadata.is_dir()
        || canonical.parent().is_none()
        || is_link_like(&canonical_metadata)
    {
        return Err("Workspace root must be a real directory below a filesystem root.".into());
    }
    Ok(canonical)
}

fn validate_bound_root(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "The bound workspace is no longer available.".to_string())?;
    if !metadata.is_dir() || is_link_like(&metadata) {
        return Err("The bound workspace is no longer a safe directory.".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "The bound workspace cannot be resolved.".to_string())?;
    if canonical.parent().is_none() || canonical != path {
        return Err("The bound workspace changed since it was selected.".into());
    }
    Ok(canonical)
}

fn workspace_status(path: &Path) -> &'static str {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return "missing",
        Err(_) => return "inaccessible",
    };
    if !metadata.is_dir() || is_link_like(&metadata) || path.parent().is_none() {
        return "inaccessible";
    }
    match path.canonicalize() {
        Ok(canonical) if canonical == path => "ready",
        _ => "inaccessible",
    }
}

fn find_git_root(path: &Path) -> Option<PathBuf> {
    fs::symlink_metadata(path.join(".git"))
        .ok()
        .filter(|metadata| !is_link_like(metadata))
        .map(|_| path.to_path_buf())
}

fn validate_relative_path(raw: &str, allow_root: bool) -> Result<PathBuf, String> {
    if raw.contains('\0') || raw.chars().any(char::is_control) {
        return Err("Path contains forbidden control characters.".into());
    }
    if raw.trim() != raw || raw.chars().count() > MAX_RELATIVE_PATH_CHARS {
        return Err("Path is malformed or too long.".into());
    }
    if raw.contains(':') {
        return Err("Path must not contain a drive prefix or alternate data stream.".into());
    }
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err("Path must be relative to the bound workspace.".into());
    }

    let mut normalized = PathBuf::new();
    for component in Path::new(raw).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(segment) => {
                let value = segment
                    .to_str()
                    .ok_or_else(|| "Path must be valid Unicode.".to_string())?;
                validate_path_segment(value)?;
                normalized.push(segment);
            }
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Path traversal and absolute paths are forbidden.".into())
            }
        }
    }
    if normalized.as_os_str().is_empty() && !allow_root {
        return Err("Path must identify an item below the workspace root.".into());
    }
    if is_secret_path(&normalized) {
        return Err("Access to secret-bearing files and directories is blocked.".into());
    }
    Ok(normalized)
}

fn validate_path_segment(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.chars().count() > MAX_PATH_SEGMENT_CHARS
        || value.ends_with('.')
        || value.ends_with(' ')
        || value.contains(':')
    {
        return Err("Path contains an unsafe segment.".into());
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
    ) || stem.strip_prefix("COM").is_some_and(|suffix| {
        matches!(
            suffix,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
    }) || stem.strip_prefix("LPT").is_some_and(|suffix| {
        matches!(
            suffix,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
    });
    if reserved {
        return Err("Path contains a reserved device name.".into());
    }
    Ok(())
}

pub(crate) fn is_secret_path(relative: &Path) -> bool {
    let parts = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str().map(|value| value.to_ascii_lowercase()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if parts.iter().any(|part| {
        matches!(
            part.as_str(),
            ".ssh"
                | ".gnupg"
                | ".aws"
                | ".azure"
                | ".kube"
                | ".docker"
                | ".password-store"
                | ".secrets"
                | "secrets"
        )
    }) {
        return true;
    }
    for (index, name) in parts.iter().enumerate() {
        let is_last = index + 1 == parts.len();
        let safe_env_template = is_last
            && matches!(
                name.as_str(),
                ".env.example" | ".env.sample" | ".env.template" | ".env.dist"
            );
        if name == ".env" || (name.starts_with(".env.") && !safe_env_template) {
            return true;
        }
        if matches!(
            name.as_str(),
            ".netrc"
                | "_netrc"
                | ".npmrc"
                | ".pypirc"
                | ".git-credentials"
                | ".vault-token"
                | ".htpasswd"
                | "auth.json"
                | "credentials"
                | "credentials.json"
                | "client_secret.json"
                | "client_secrets.json"
                | "service-account.json"
                | "service_account.json"
                | "secrets.json"
                | "secrets.yaml"
                | "secrets.yml"
                | "terraform.tfstate"
                | "terraform.tfstate.backup"
                | "id_rsa"
                | "id_dsa"
                | "id_ecdsa"
                | "id_ed25519"
        ) || name.ends_with(".tfvars")
            || name.ends_with(".tfvars.json")
            || Path::new(name)
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension,
                        "pem" | "key" | "p8" | "p12" | "pfx" | "ppk" | "jks" | "keystore" | "kdbx"
                    )
                })
        {
            return true;
        }
    }
    parts
        .windows(2)
        .any(|pair| pair[0] == ".git" && matches!(pair[1].as_str(), "config" | "credentials"))
}

fn resolve_existing(
    root: &Path,
    raw: &str,
    allow_root: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let relative = validate_relative_path(raw, allow_root)?;
    let path = inspect_components(root, &relative, false)?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "Project path does not exist or cannot be resolved.".to_string())?;
    if !canonical.starts_with(root) {
        return Err("Project path escaped the bound workspace.".into());
    }
    Ok((relative, canonical))
}

fn resolve_new_target(root: &Path, raw: &str) -> Result<(PathBuf, PathBuf), String> {
    let relative = validate_relative_path(raw, false)?;
    let path = inspect_components(root, &relative, true)?;
    Ok((relative, path))
}

fn inspect_components(
    root: &Path,
    relative: &Path,
    allow_missing_tail: bool,
) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    let mut missing = false;
    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(segment) = component else {
            return Err("Project path contains an unsafe component.".into());
        };
        current.push(segment);
        if missing {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if is_link_like(&metadata) {
                    return Err("Symbolic links and junctions are blocked in project paths.".into());
                }
                if index + 1 < components.len() && !metadata.is_dir() {
                    return Err("A project path parent is not a directory.".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing_tail => {
                missing = true;
            }
            Err(_) => return Err("Project path does not exist or cannot be inspected.".into()),
        }
    }
    Ok(current)
}

fn list_directory(
    root: &Path,
    raw: &str,
    max_entries: usize,
    max_depth: usize,
) -> Result<FsListResult, String> {
    let (relative, path) = resolve_existing(root, raw, true)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "Project directory cannot be inspected.".to_string())?;
    if !metadata.is_dir() {
        return Err("Project list path must be a directory.".into());
    }
    let mut entries = Vec::new();
    let scan_budget = max_entries
        .saturating_mul(8)
        .max(max_entries.saturating_add(1))
        .min(MAX_LIST_SCANNED_ENTRIES);
    let mut traversal = ListTraversal {
        max_depth,
        stop_after: max_entries.saturating_add(1),
        scan_budget,
        scanned_entries: 0,
        scan_truncated: false,
    };
    collect_directory_entries(&path, &relative, 1, &mut traversal, &mut entries)?;
    entries.sort_by(|left, right| left.path.to_lowercase().cmp(&right.path.to_lowercase()));
    let truncated = entries.len() > max_entries || traversal.scan_truncated;
    entries.truncate(max_entries);
    Ok(FsListResult {
        path: relative_string(&relative),
        entries,
        truncated,
    })
}

struct ListTraversal {
    max_depth: usize,
    stop_after: usize,
    scan_budget: usize,
    scanned_entries: usize,
    scan_truncated: bool,
}

fn collect_directory_entries(
    directory: &Path,
    relative_directory: &Path,
    depth: usize,
    traversal: &mut ListTraversal,
    entries: &mut Vec<FsEntry>,
) -> Result<(), String> {
    if entries.len() >= traversal.stop_after || traversal.scanned_entries >= traversal.scan_budget {
        traversal.scan_truncated |= traversal.scanned_entries >= traversal.scan_budget;
        return Ok(());
    }
    let remaining_scan = traversal
        .scan_budget
        .saturating_sub(traversal.scanned_entries);
    let mut children = Vec::new();
    for child in
        fs::read_dir(directory).map_err(|_| "Project directory cannot be read.".to_string())?
    {
        if children.len() >= remaining_scan {
            traversal.scan_truncated = true;
            break;
        }
        children.push(child.map_err(|_| "A project directory entry cannot be read.".to_string())?);
    }
    traversal.scanned_entries += children.len();
    children.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
    for child in children {
        if entries.len() >= traversal.stop_after {
            break;
        }
        let child_relative = relative_directory.join(child.file_name());
        if is_secret_path(&child_relative) {
            continue;
        }
        let metadata = fs::symlink_metadata(child.path())
            .map_err(|_| "A project directory entry cannot be inspected.".to_string())?;
        let blocked_link = is_link_like(&metadata);
        entries.push(entry_metadata(&child_relative, &metadata));
        let name = child.file_name().to_string_lossy().to_ascii_lowercase();
        let hard_excluded = matches!(
            name.as_str(),
            ".git" | "node_modules" | "vendor" | "target" | "dist" | "build" | ".idea"
        );
        if depth < traversal.max_depth && metadata.is_dir() && !blocked_link && !hard_excluded {
            collect_directory_entries(
                &child.path(),
                &child_relative,
                depth + 1,
                traversal,
                entries,
            )?;
        }
    }
    Ok(())
}

fn stat_path(root: &Path, raw: &str) -> Result<FsStatResult, String> {
    let (relative, path) = resolve_existing(root, raw, true)?;
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "Project path cannot be inspected.".to_string())?;
    if is_link_like(&metadata) {
        return Err("Symbolic links and junctions are blocked in project paths.".into());
    }
    let sha256 = if metadata.is_file() && metadata.len() <= MAX_TEXT_FILE_BYTES {
        Some(hash_file(&path)?)
    } else {
        None
    };
    Ok(FsStatResult {
        path: relative_string(&relative),
        name: relative
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(".")
            .to_string(),
        kind: file_kind(&metadata).to_string(),
        bytes: metadata.len(),
        modified_at: modified_timestamp(&metadata),
        readonly: metadata.permissions().readonly(),
        sha256,
    })
}

fn read_text(
    root: &Path,
    raw: &str,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_bytes: Option<usize>,
) -> Result<FsReadResult, String> {
    let (relative, path) = resolve_existing(root, raw, false)?;
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "Project file cannot be inspected.".to_string())?;
    if !metadata.is_file() {
        return Err("Project read path must be a regular file.".into());
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err("Project text file exceeds the 5 MB safety limit.".into());
    }
    let bytes = fs::read(&path).map_err(|_| "Project file cannot be read.".to_string())?;
    if bytes.contains(&0) {
        return Err("Binary files cannot be read as project text.".into());
    }
    let digest = sha256(&bytes);
    let text = String::from_utf8(bytes)
        .map_err(|_| "Project file is not valid UTF-8 text.".to_string())?;
    let total_lines = if text.is_empty() {
        0
    } else {
        text.lines().count()
    };
    let start = start_line.unwrap_or(1);
    if start == 0 || start > MAX_LINE_NUMBER {
        return Err("startLine is outside the supported range.".into());
    }
    let requested_end = end_line.unwrap_or(total_lines.max(start));
    if requested_end < start
        || requested_end > MAX_LINE_NUMBER
        || requested_end - start + 1 > MAX_LINE_SPAN
    {
        return Err("Requested line range is invalid or too large.".into());
    }
    if total_lines > 0 && start > total_lines {
        return Err("startLine is past the end of the project file.".into());
    }
    let effective_end = requested_end.min(total_lines);
    let limit = max_bytes
        .unwrap_or(DEFAULT_READ_BYTES)
        .clamp(1, MAX_READ_BYTES);
    let mut content = String::new();
    let mut actual_end = if total_lines == 0 {
        0
    } else {
        start.saturating_sub(1)
    };
    let mut truncated = false;
    for (index, line) in text.split_inclusive('\n').enumerate() {
        let line_number = index + 1;
        if line_number < start {
            continue;
        }
        if line_number > effective_end {
            break;
        }
        if content.len() + line.len() > limit {
            let remaining = limit.saturating_sub(content.len());
            content.push_str(truncate_utf8_bytes(line, remaining));
            actual_end = line_number;
            truncated = true;
            break;
        }
        content.push_str(line);
        actual_end = line_number;
    }
    Ok(FsReadResult {
        path: relative_string(&relative),
        content,
        start_line: if total_lines == 0 { 0 } else { start },
        end_line: actual_end,
        total_lines,
        bytes: metadata.len(),
        sha256: digest,
        truncated,
    })
}

fn search_text(
    root: &Path,
    raw: &str,
    query: &str,
    glob: Option<&str>,
    case_sensitive: bool,
    max_results: usize,
    max_files: usize,
) -> Result<FsSearchResult, String> {
    let query = query.trim();
    if query.is_empty()
        || query.chars().count() > MAX_SEARCH_QUERY_CHARS
        || query.chars().any(char::is_control)
    {
        return Err("Search query is empty, too long, or contains control characters.".into());
    }
    let (relative, search_root) = resolve_existing(root, raw, true)?;
    let search_metadata = fs::symlink_metadata(&search_root)
        .map_err(|_| "Project search path cannot be inspected.".to_string())?;
    if !search_metadata.is_dir() && !search_metadata.is_file() {
        return Err("Project search path must be a regular file or directory.".into());
    }

    let mut matches = Vec::new();
    let mut scanned_files = 0usize;
    let mut scanned_bytes = 0_u64;
    let mut truncated = false;
    let started_at = Instant::now();
    let needle = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };
    let filter_root = root.to_path_buf();
    let mut builder = WalkBuilder::new(&search_root);
    builder
        .follow_links(false)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .max_depth(Some(MAX_SEARCH_DEPTH))
        .filter_entry(move |entry| safe_search_entry(&filter_root, entry));
    if let Some(glob) = glob.map(normalize_search_glob).transpose()?.flatten() {
        let mut overrides = OverrideBuilder::new(&search_root);
        overrides
            .add(&glob)
            .map_err(|_| "Search glob is invalid.".to_string())?;
        builder.overrides(
            overrides
                .build()
                .map_err(|_| "Search glob is invalid.".to_string())?,
        );
    }

    for result in builder.build() {
        if started_at.elapsed() >= MAX_SEARCH_DURATION {
            truncated = true;
            break;
        }
        let entry = match result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) if metadata.is_file() && !is_link_like(&metadata) => metadata,
            _ => continue,
        };
        if metadata.len() > MAX_TEXT_FILE_BYTES {
            continue;
        }
        if scanned_files >= max_files {
            truncated = true;
            break;
        }
        if scanned_bytes.saturating_add(metadata.len()) > MAX_SEARCH_TOTAL_BYTES {
            truncated = true;
            break;
        }
        scanned_files += 1;
        scanned_bytes += metadata.len();
        let file_relative = match entry.path().strip_prefix(root) {
            Ok(path) if !path.as_os_str().is_empty() && !is_secret_path(path) => path.to_path_buf(),
            _ => continue,
        };
        let bytes = match fs::read(entry.path()) {
            Ok(bytes) if !bytes.contains(&0) => bytes,
            _ => continue,
        };
        let content = match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => continue,
        };
        for (line_index, line) in content.lines().enumerate() {
            let haystack = if case_sensitive {
                line.to_string()
            } else {
                line.to_lowercase()
            };
            let Some(column) = haystack.find(&needle) else {
                continue;
            };
            matches.push(FsSearchMatch {
                path: relative_string(&file_relative),
                line: line_index + 1,
                column: column + 1,
                preview: clip_chars(line.trim(), MAX_SEARCH_PREVIEW_CHARS),
            });
            if matches.len() >= max_results {
                truncated = true;
                break;
            }
        }
        if matches.len() >= max_results {
            break;
        }
    }

    Ok(FsSearchResult {
        path: relative_string(&relative),
        query: query.to_string(),
        matches,
        scanned_files,
        truncated,
    })
}

fn normalize_search_glob(raw: &str) -> Result<Option<String>, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value != raw
        || value.chars().count() > MAX_RELATIVE_PATH_CHARS
        || value.chars().any(char::is_control)
        || value.contains(':')
        || value.starts_with('/')
        || value.starts_with('\\')
        || value
            .split(['/', '\\'])
            .any(|segment| segment == ".." || segment.ends_with('.') || segment.ends_with(' '))
    {
        return Err("Search glob must stay relative to the workspace.".into());
    }
    Ok(Some(value.replace('\\', "/")))
}

fn safe_search_entry(root: &Path, entry: &DirEntry) -> bool {
    if entry.path() == root {
        return true;
    }
    let Ok(relative) = entry.path().strip_prefix(root) else {
        return false;
    };
    if is_secret_path(relative) {
        return false;
    }
    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
    if entry.file_type().is_some_and(|kind| kind.is_dir())
        && matches!(
            name.as_str(),
            ".git" | "node_modules" | "vendor" | "target" | "dist" | "build" | ".idea"
        )
    {
        return false;
    }
    fs::symlink_metadata(entry.path())
        .map(|metadata| !is_link_like(&metadata))
        .unwrap_or(false)
}

#[cfg(test)]
fn write_text(
    root: &Path,
    raw: &str,
    content: &str,
    expected_sha256: Option<&str>,
) -> Result<FsWriteResult, String> {
    let _mutation = mutation_guard()?;
    write_text_locked(root, raw, content, expected_sha256, None)
}

fn write_text_locked(
    root: &Path,
    raw: &str,
    content: &str,
    expected_sha256: Option<&str>,
    gate: Option<&ExecutionLease>,
) -> Result<FsWriteResult, String> {
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err("Project text write exceeds the 5 MB safety limit.".into());
    }
    let (relative, target) = resolve_new_target(root, raw)?;
    let parent = target
        .parent()
        .ok_or_else(|| "Project file has no parent directory.".to_string())?;
    let parent_relative = relative.parent().unwrap_or_else(|| Path::new(""));
    inspect_components(root, parent_relative, false)?;
    let parent_metadata = fs::symlink_metadata(parent)
        .map_err(|_| "Project file parent directory does not exist.".to_string())?;
    if !parent_metadata.is_dir() || is_link_like(&parent_metadata) {
        return Err("Project file parent must be a safe existing directory.".into());
    }

    let existing = match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if is_link_like(&metadata) || !metadata.is_file() {
                return Err("Project write target must be a regular non-link file.".into());
            }
            Some(metadata)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("Project write target cannot be inspected.".into()),
    };
    let created = existing.is_none();
    match (existing.as_ref(), expected_sha256) {
        (None, None) => {}
        (None, Some(_)) => return Err("CAS conflict: expected file does not exist.".into()),
        (Some(_), None) => {
            return Err("CAS conflict: expectedSha256 is required when replacing a file.".into())
        }
        (Some(metadata), Some(expected)) => {
            validate_sha256(expected)?;
            if metadata.len() > MAX_TEXT_FILE_BYTES {
                return Err("Existing project file exceeds the CAS safety limit.".into());
            }
            let current = hash_file(&target)?;
            if !current.eq_ignore_ascii_case(expected) {
                return Err("CAS conflict: project file changed since it was read.".into());
            }
        }
    }

    atomic_write(&target, content.as_bytes(), expected_sha256, gate)?;
    let digest = sha256(content.as_bytes());
    Ok(FsWriteResult {
        path: relative_string(&relative),
        bytes: content.len(),
        sha256: digest,
        created,
    })
}

#[cfg(test)]
fn create_directory(root: &Path, raw: &str, recursive: bool) -> Result<FsCreateDirResult, String> {
    let _mutation = mutation_guard()?;
    create_directory_locked(root, raw, recursive, None)
}

fn create_directory_locked(
    root: &Path,
    raw: &str,
    recursive: bool,
    gate: Option<&ExecutionLease>,
) -> Result<FsCreateDirResult, String> {
    let (relative, target) = resolve_new_target(root, raw)?;
    if recursive {
        let mut current = root.to_path_buf();
        let mut created = false;
        for component in relative.components() {
            let Component::Normal(segment) = component else {
                return Err("Project directory contains an unsafe component.".into());
            };
            current.push(segment);
            match fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.is_dir() && !is_link_like(&metadata) => {}
                Ok(_) => {
                    return Err(
                        "A recursive project directory component is not a safe directory.".into(),
                    )
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if let Some(gate) = gate {
                        gate.check()?;
                    }
                    fs::create_dir(&current)
                        .map_err(|_| "Project directory could not be created.".to_string())?;
                    let metadata = fs::symlink_metadata(&current).map_err(|_| {
                        "Created project directory cannot be inspected.".to_string()
                    })?;
                    if !metadata.is_dir() || is_link_like(&metadata) {
                        return Err("Created project directory is not safe.".into());
                    }
                    created = true;
                }
                Err(_) => return Err("Project directory component cannot be inspected.".into()),
            }
        }
        return Ok(FsCreateDirResult {
            path: relative_string(&relative),
            created,
        });
    }
    let parent_relative = relative.parent().unwrap_or_else(|| Path::new(""));
    let parent = inspect_components(root, parent_relative, false)?;
    let parent_metadata = fs::symlink_metadata(&parent)
        .map_err(|_| "Project directory parent does not exist.".to_string())?;
    if !parent_metadata.is_dir() || is_link_like(&parent_metadata) {
        return Err("Project directory parent must be a safe existing directory.".into());
    }
    match fs::symlink_metadata(&target) {
        Ok(_) => return Err("Project directory target already exists.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Project directory target cannot be inspected.".into()),
    }
    if let Some(gate) = gate {
        gate.check()?;
    }
    fs::create_dir(&target).map_err(|_| "Project directory could not be created.".to_string())?;
    Ok(FsCreateDirResult {
        path: relative_string(&relative),
        created: true,
    })
}

#[cfg(test)]
fn move_path(
    root: &Path,
    from_raw: &str,
    to_raw: &str,
    overwrite: bool,
) -> Result<FsMoveResult, String> {
    let _mutation = mutation_guard()?;
    move_path_locked(root, from_raw, to_raw, overwrite, None)
}

fn move_path_locked(
    root: &Path,
    from_raw: &str,
    to_raw: &str,
    overwrite: bool,
    gate: Option<&ExecutionLease>,
) -> Result<FsMoveResult, String> {
    if overwrite {
        return Err("Project move never overwrites an existing destination.".into());
    }
    let (from_relative, source) = resolve_existing(root, from_raw, false)?;
    let source_metadata = fs::symlink_metadata(&source)
        .map_err(|_| "Project move source cannot be inspected.".to_string())?;
    if is_link_like(&source_metadata) {
        return Err("Symbolic links and junctions cannot be moved by project tools.".into());
    }
    let (to_relative, target) = resolve_new_target(root, to_raw)?;
    if from_relative == to_relative {
        return Err("Project move source and destination are identical.".into());
    }
    let parent_relative = to_relative.parent().unwrap_or_else(|| Path::new(""));
    let parent = inspect_components(root, parent_relative, false)?;
    let parent_metadata = fs::symlink_metadata(&parent)
        .map_err(|_| "Project move destination parent does not exist.".to_string())?;
    if !parent_metadata.is_dir() || is_link_like(&parent_metadata) {
        return Err("Project move destination parent must be a safe existing directory.".into());
    }
    match fs::symlink_metadata(&target) {
        Ok(_) => return Err("Project move destination already exists.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Project move destination cannot be inspected.".into()),
    }
    if let Some(gate) = gate {
        gate.check()?;
    }
    atomic_move_noreplace(&source, &target)
        .map_err(|_| "Project item could not be moved without overwriting.".to_string())?;
    Ok(FsMoveResult {
        from_path: relative_string(&from_relative),
        to_path: relative_string(&to_relative),
        kind: file_kind(&source_metadata).to_string(),
    })
}

#[cfg(test)]
fn delete_path(root: &Path, raw: &str, recursive: bool) -> Result<FsDeleteResult, String> {
    let _mutation = mutation_guard()?;
    delete_path_locked(root, raw, recursive, None)
}

fn delete_path_locked(
    root: &Path,
    raw: &str,
    recursive: bool,
    gate: Option<&ExecutionLease>,
) -> Result<FsDeleteResult, String> {
    if recursive {
        return Err("Recursive deletion is not available to project tools.".into());
    }
    let (relative, target) = resolve_existing(root, raw, false)?;
    let metadata = fs::symlink_metadata(&target)
        .map_err(|_| "Project delete target cannot be inspected.".to_string())?;
    if is_link_like(&metadata) {
        return Err("Symbolic links and junctions cannot be deleted by project tools.".into());
    }
    let kind = file_kind(&metadata).to_string();
    if let Some(gate) = gate {
        gate.check()?;
    }
    if metadata.is_file() {
        fs::remove_file(&target).map_err(|_| "Project file could not be deleted.".to_string())?;
    } else if metadata.is_dir() {
        fs::remove_dir(&target)
            .map_err(|_| "Project directory must be empty before it can be deleted.".to_string())?;
    } else {
        return Err("Only regular files and empty directories can be deleted.".into());
    }
    Ok(FsDeleteResult {
        path: relative_string(&relative),
        kind,
        deleted: true,
    })
}

fn entry_metadata(relative: &Path, metadata: &fs::Metadata) -> FsEntry {
    FsEntry {
        path: relative_string(relative),
        name: relative
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
        kind: if is_link_like(metadata) {
            "blocked_link".into()
        } else {
            file_kind(metadata).into()
        },
        bytes: metadata.len(),
        modified_at: modified_timestamp(metadata),
        readonly: metadata.permissions().readonly(),
    }
}

fn file_kind(metadata: &fs::Metadata) -> &'static str {
    if metadata.is_file() {
        "file"
    } else if metadata.is_dir() {
        "directory"
    } else {
        "other"
    }
}

fn modified_timestamp(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs() as i64)
}

fn relative_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    &value[..boundary]
}

fn clip_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let clipped = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{clipped}…")
    } else {
        clipped
    }
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("expectedSha256 must be a 64-character hexadecimal digest.".into());
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|_| "Project file cannot be opened for hashing.".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "Project file cannot be hashed.".to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn mutation_guard() -> Result<MutexGuard<'static, ()>, String> {
    static MUTATIONS: OnceLock<Mutex<()>> = OnceLock::new();
    MUTATIONS
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Project filesystem mutation lock is unavailable.".to_string())
}

fn atomic_write(
    target: &Path,
    bytes: &[u8],
    expected_sha256: Option<&str>,
    gate: Option<&ExecutionLease>,
) -> Result<(), String> {
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Project write target has an invalid filename.".to_string())?;
    let temporary = target.with_file_name(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        if let Some(gate) = gate {
            gate.check()?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "Temporary project file could not be created.".to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Temporary project file could not be written.".to_string())?;
        if let Some(gate) = gate {
            gate.check()?;
        }
        match expected_sha256 {
            None => match fs::symlink_metadata(target) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if let Some(gate) = gate {
                        gate.check()?;
                    }
                    atomic_create(&temporary, target).map_err(|_| {
                        "CAS conflict: project file appeared before creation committed.".to_string()
                    })
                }
                _ => Err("CAS conflict: project file appeared before creation committed.".into()),
            },
            Some(expected) => {
                let metadata = fs::symlink_metadata(target).map_err(|_| {
                    "CAS conflict: project file disappeared before replacement committed."
                        .to_string()
                })?;
                if !metadata.is_file()
                    || is_link_like(&metadata)
                    || metadata.len() > MAX_TEXT_FILE_BYTES
                    || !hash_file(target)?.eq_ignore_ascii_case(expected)
                {
                    return Err(
                        "CAS conflict: project file changed before replacement committed.".into(),
                    );
                }
                if let Some(gate) = gate {
                    gate.check()?;
                }
                atomic_replace(&temporary, target)
                    .map_err(|_| "Project file could not be replaced atomically.".to_string())
            }
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn atomic_move_noreplace(source: &Path, target: &Path) -> std::io::Result<()> {
    windows_move_file(source, target, 0x8)
}

#[cfg(target_os = "linux")]
fn atomic_move_noreplace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;

    const AT_FDCWD: c_int = -100;
    const RENAME_NOREPLACE: c_uint = 1;
    extern "C" {
        fn renameat2(
            old_dir_fd: c_int,
            old_path: *const c_char,
            new_dir_fd: c_int,
            new_path: *const c_char,
            flags: c_uint,
        ) -> c_int;
    }

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let target = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let moved = unsafe {
        renameat2(
            AT_FDCWD,
            source.as_ptr(),
            AT_FDCWD,
            target.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if moved == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
fn atomic_move_noreplace(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no-overwrite project moves are unavailable on this platform",
    ))
}

#[cfg(windows)]
fn atomic_create(source: &Path, target: &Path) -> std::io::Result<()> {
    windows_move_file(source, target, 0x8)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    windows_move_file(source, target, 0x1 | 0x8)
}

#[cfg(windows)]
fn windows_move_file(source: &Path, target: &Path, flags: u32) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let moved = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_create(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::hard_link(source, target)?;
    let _ = fs::remove_file(source);
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

fn is_link_like(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn db_error(error: rusqlite::Error) -> String {
    format!("Local workspace database error: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_workspace(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("luczor-workspace-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temporary workspace");
        root.canonicalize().expect("canonical temporary workspace")
    }

    #[test]
    fn relative_paths_reject_escape_ads_devices_and_secrets() {
        assert!(validate_relative_path("src/main.rs", false).is_ok());
        assert!(validate_relative_path("../escape.txt", false).is_err());
        assert!(validate_relative_path("C:\\escape.txt", false).is_err());
        assert!(validate_relative_path("file.txt:secret", false).is_err());
        assert!(validate_relative_path("NUL.txt", false).is_err());
        assert!(validate_relative_path("COM¹.txt", false).is_err());
        assert!(validate_relative_path(".env", false).is_err());
        assert!(validate_relative_path(".env/token.txt", false).is_err());
        assert!(validate_relative_path("keys/private.pem", false).is_err());
        assert!(validate_relative_path(".env.example", false).is_ok());
        assert!(validate_relative_path("", true).is_ok());
        assert!(validate_relative_path("", false).is_err());
    }

    #[test]
    fn git_detection_never_expands_above_the_selected_workspace() {
        let repository = temporary_workspace("git-boundary");
        fs::create_dir(repository.join(".git")).expect("git marker");
        fs::create_dir(repository.join("selected-subdirectory")).expect("selected subdirectory");
        let selected = repository.join("selected-subdirectory");

        assert_eq!(find_git_root(&repository), Some(repository.clone()));
        assert_eq!(find_git_root(&selected), None);

        fs::remove_dir_all(repository).expect("cleanup repository");
    }

    #[test]
    fn bindings_are_scoped_unique_and_serialize_the_ui_contract() {
        let root_a = temporary_workspace("binding-a");
        let root_b = temporary_workspace("binding-b");
        let mut connection = Connection::open_in_memory().expect("in-memory database");
        initialize_schema(&connection).expect("schema");

        let bound_a =
            bind_workspace(&mut connection, "user:1", "project-a", &root_a).expect("bind a");
        let bound_b =
            bind_workspace(&mut connection, "user:1", "project-b", &root_b).expect("bind b");
        assert_ne!(bound_a.project_id, bound_b.project_id);
        assert!(bind_workspace(&mut connection, "user:1", "project-a", &root_a).is_ok());
        assert_eq!(
            get_workspace(&connection, "user:1", "project-a")
                .expect("get a")
                .expect("bound a")
                .root_path,
            root_a
        );
        assert!(get_workspace(&connection, "user:2", "project-a")
            .expect("other principal query")
            .is_none());
        assert!(bind_workspace(&mut connection, "user:1", "project-c", &root_a).is_err());
        assert!(bind_workspace(&mut connection, "user:2", "project-c", &root_a).is_ok());

        let serialized = serde_json::to_value(WorkspaceBinding::from_bound(&bound_a))
            .expect("serialize workspace binding");
        assert_eq!(serialized["principalId"], "user:1");
        assert_eq!(serialized["projectId"], "project-a");
        assert_eq!(serialized["rootPath"], root_a.to_string_lossy().as_ref());
        assert_eq!(
            serialized["displayName"],
            root_a.file_name().unwrap().to_string_lossy().as_ref()
        );
        assert_eq!(serialized["isGitRepository"], false);
        assert_eq!(serialized["status"], "ready");
        assert!(serialized.get("workspaceId").is_none());
        assert!(serialized.get("gitRootPath").is_none());
        assert!(validate_expected_workspace(
            &bound_a,
            root_a.to_string_lossy().as_ref(),
            bound_a.updated_at
        )
        .is_ok());
        assert!(validate_expected_workspace(
            &bound_a,
            root_b.to_string_lossy().as_ref(),
            bound_a.updated_at
        )
        .is_err());
        assert!(validate_expected_workspace(
            &bound_a,
            root_a.to_string_lossy().as_ref(),
            bound_a.updated_at + 1
        )
        .is_err());

        fs::remove_dir_all(&root_a).expect("cleanup a");
        assert_eq!(workspace_status(&root_a), "missing");

        fs::remove_dir_all(root_b).expect("cleanup b");
    }

    #[test]
    fn read_write_cas_move_and_non_recursive_delete_are_bounded() {
        let root = temporary_workspace("operations");
        let created = write_text(&root, "note.txt", "first\nsecond\n", None).expect("create file");
        assert!(created.created);
        assert!(write_text(&root, "note.txt", "stale", None).is_err());
        assert_eq!(
            fs::read_to_string(root.join("note.txt")).expect("unchanged create conflict"),
            "first\nsecond\n"
        );
        assert!(write_text(&root, "note.txt", "stale", Some(&"0".repeat(64))).is_err());

        let read = read_text(&root, "note.txt", Some(2), Some(2), Some(100)).expect("read line");
        assert_eq!(read.content, "second\n");
        assert_eq!(read.start_line, 2);
        let updated =
            write_text(&root, "note.txt", "updated", Some(&read.sha256)).expect("CAS update");
        assert!(!updated.created);

        create_directory(&root, "folder", false).expect("create folder");
        write_text(&root, "folder/child.txt", "child", None).expect("create child");
        assert!(delete_path(&root, "folder", false).is_err());
        assert!(delete_path(&root, "folder", true).is_err());
        move_path(&root, "folder/child.txt", "folder/moved.txt", false).expect("move child");
        delete_path(&root, "folder/moved.txt", false).expect("delete file");
        delete_path(&root, "folder", false).expect("delete empty folder");
        assert!(!root.join("folder").exists());

        assert!(read_text(&root, "missing/sub/file.txt", None, None, None).is_err());
        assert!(
            !root.join("missing").exists(),
            "read must not create directories"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn list_and_search_hide_secret_files_and_bound_results() {
        let root = temporary_workspace("search");
        fs::write(root.join("visible.txt"), "Needle here\n").expect("visible file");
        fs::write(root.join(".env"), "Needle=secret\n").expect("secret file");
        fs::write(root.join(".git-credentials"), "Needle=credential\n").expect("credential file");
        fs::create_dir(root.join("secrets")).expect("secret directory");
        fs::write(root.join("secrets/token.txt"), "Needle=token\n").expect("secret token");
        for index in 0..45 {
            fs::write(root.join(format!(".env.secret-{index}")), "Needle=hidden\n")
                .expect("bulk secret file");
        }

        let list = list_directory(&root, "", 20, 2).expect("list root");
        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].path, "visible.txt");
        let bounded_list = list_directory(&root, "", 5, 1).expect("bounded list root");
        assert!(bounded_list.truncated);
        assert!(bounded_list.entries.len() <= 5);
        let search = search_text(&root, "", "needle", None, false, 20, 20).expect("search");
        assert_eq!(search.matches.len(), 1);
        assert_eq!(search.matches[0].path, "visible.txt");
        assert!(!serde_json::to_string(&search)
            .expect("serialize search")
            .contains(root.to_string_lossy().as_ref()));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(windows)]
    #[test]
    fn symlink_leaf_is_rejected_when_windows_allows_test_creation() {
        use std::os::windows::fs::symlink_file;

        let root = temporary_workspace("symlink");
        let outside = std::env::temp_dir().join(format!("luczor-outside-{}.txt", Uuid::new_v4()));
        fs::write(&outside, "outside").expect("outside file");
        let link = root.join("link.txt");
        if symlink_file(&outside, &link).is_ok() {
            assert!(read_text(&root, "link.txt", None, None, None).is_err());
        }
        let _ = fs::remove_file(link);
        fs::remove_file(outside).expect("cleanup outside");
        fs::remove_dir_all(root).expect("cleanup root");
    }
}
