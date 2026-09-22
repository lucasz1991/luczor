use super::ensure_main_webview;
use base64::Engine;
use ignore::{DirEntry, WalkBuilder};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};
use tree_sitter::{Language, Node, Parser};
use uuid::Uuid;

#[path = "repository_graph_lsp.rs"]
mod lsp;

const MAX_FILES: usize = 100_000;
type IndexCancellationKey = (String, String, String);
static INDEX_CANCELLATIONS: OnceLock<Mutex<HashMap<IndexCancellationKey, Arc<AtomicBool>>>> =
    OnceLock::new();

fn index_cancellation(
    principal: &str,
    project: &str,
    request: &str,
) -> Result<Arc<AtomicBool>, String> {
    validate_principal_id(principal)?;
    validate_project_id(project)?;
    Uuid::parse_str(request).map_err(|_| "Invalid index request ID.".to_string())?;
    let mut entries = INDEX_CANCELLATIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Index cancellation unavailable.".to_string())?;
    let key = (
        principal.to_string(),
        project.to_string(),
        request.to_string(),
    );
    if entries.len() >= 128 && !entries.contains_key(&key) {
        return Err("Too many pending index requests.".into());
    }
    Ok(entries
        .entry(key)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone())
}

#[tauri::command]
pub fn local_graph_cancel_index(
    window: crate::commands::CallerWebview,
    principal_id: String,
    project_id: String,
    request_id: String,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    index_cancellation(&principal_id, &project_id, &request_id)?.store(true, Ordering::Release);
    Ok(())
}
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RUN_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RUN_TIME: Duration = Duration::from_secs(15 * 60);
const MAX_QUERY_CHARS: usize = 4_096;
const MAX_SEARCH_HITS: usize = 30;
const MAX_SNIPPET_BYTES: usize = 12 * 1024;
const MAX_SNIPPET_TOTAL_BYTES: usize = 64 * 1024;
const MAX_FTS_CONTENT_BYTES: usize = 256 * 1024;

#[derive(Debug, Serialize)]
pub struct RepositoryBinding {
    repository_id: String,
    project_id: String,
    display_name: String,
    branch: Option<String>,
    commit_sha: Option<String>,
    status: String,
}

#[derive(Debug, Serialize)]
pub struct GraphIndexResult {
    run_id: String,
    status: String,
    files: usize,
    symbols: usize,
    edges: usize,
    skipped: usize,
    unchanged: usize,
    deleted: usize,
    branch: Option<String>,
    commit_sha: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GraphStatus {
    lsp: Option<lsp::State>,
    status: String,
    repository_id: Option<String>,
    display_name: Option<String>,
    files: usize,
    symbols: usize,
    edges: usize,
    skipped: usize,
    branch: Option<String>,
    commit_sha: Option<String>,
    last_indexed_at: Option<i64>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct GraphSymbolRef {
    name: String,
    kind: String,
    start_line: usize,
    end_line: usize,
}

#[derive(Debug, Serialize)]
pub struct GraphSearchHit {
    relations: Vec<String>,
    evidence_id: String,
    relative_path: String,
    language: String,
    symbols: Vec<GraphSymbolRef>,
    reasons: Vec<String>,
    score: f64,
    content_hash: String,
    stale: bool,
}

#[derive(Debug, Serialize)]
pub struct GraphSearchResult {
    repository_id: String,
    branch: Option<String>,
    commit_sha: Option<String>,
    hits: Vec<GraphSearchHit>,
}

#[derive(Debug, Serialize)]
pub struct GraphSnippet {
    evidence_id: String,
    relative_path: String,
    start_line: usize,
    end_line: usize,
    content: String,
    content_hash: String,
    redactions: usize,
}

#[derive(Debug, Serialize)]
pub struct OmittedSnippet {
    evidence_id: String,
    reason: String,
}

#[derive(Debug, Serialize)]
pub struct GraphSnippetResult {
    snippets: Vec<GraphSnippet>,
    omitted: Vec<OmittedSnippet>,
}

#[derive(Debug, Clone)]
struct ParsedSymbol {
    name: String,
    kind: String,
    start_line: usize,
    end_line: usize,
}

#[derive(Debug)]
struct ParsedFile {
    symbols: Vec<ParsedSymbol>,
    imports: Vec<String>,
}

#[derive(Debug)]
struct BoundRepository {
    principal_id: String,
    repository_id: String,
    root_path: PathBuf,
}

#[derive(Debug)]
struct GitState {
    branch: Option<String>,
    commit_sha: Option<String>,
}

#[tauri::command]
pub async fn local_graph_bind(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    principal_id: String,
    project_id: String,
    root_path: String,
) -> Result<RepositoryBinding, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        bind_repository(&app, &principal_id, &project_id, &root_path)
    })
    .await
    .map_err(|error| format!("Repository binding task failed: {error}"))?
}

#[tauri::command]
pub async fn local_graph_index(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    principal_id: String,
    project_id: String,
    request_id: Option<String>,
) -> Result<GraphIndexResult, String> {
    ensure_main_webview(&window)?;
    let (operation, token) = super::owned_processes::Operation::begin()?;
    let request_id = Some(request_id.unwrap_or_else(|| Uuid::new_v4().to_string()));
    let cancellation = request_id
        .as_ref()
        .map(|id| index_cancellation(&principal_id, &project_id, id))
        .transpose()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let result = token.check().and_then(|_| {
            index_repository_cancellable(&app, &principal_id, &project_id, cancellation.as_deref())
        });
        if let Some(id) = request_id {
            if let Ok(mut entries) = INDEX_CANCELLATIONS.get_or_init(Default::default).lock() {
                entries.remove(&(principal_id, project_id, id));
            }
        }
        result
    })
    .await
    .map_err(|error| format!("Repository indexing task failed: {error}"))?
}

pub(crate) fn stop_all() -> Result<(), String> {
    let entries = INDEX_CANCELLATIONS
        .get_or_init(Default::default)
        .try_lock()
        .map_err(|_| "repository_index_stop_pending")?;
    for cancel in entries.values() {
        cancel.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn local_graph_status(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    principal_id: String,
    project_id: String,
) -> Result<GraphStatus, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || graph_status(&app, &principal_id, &project_id))
        .await
        .map_err(|error| format!("Repository status task failed: {error}"))?
}

#[tauri::command]
pub async fn local_graph_search(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    principal_id: String,
    project_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<GraphSearchResult, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        search_repository(&app, &principal_id, &project_id, &query, limit)
    })
    .await
    .map_err(|error| format!("Repository search task failed: {error}"))?
}

#[derive(Debug, Serialize)]
pub struct GraphInspection {
    total: usize,
    offset: usize,
    files: Vec<GraphInspectionFile>,
}
#[derive(Debug, Serialize)]
struct GraphInspectionFile {
    id: String,
    path: String,
    language: String,
    symbols: Vec<GraphSymbolRef>,
    relations: Vec<GraphInspectionRelation>,
    truncated: bool,
}
#[derive(Debug, Serialize)]
struct GraphInspectionRelation {
    kind: String,
    target: String,
}

/// Metadata only; no source-code reads, model calls or re-indexing from the inspector.
#[tauri::command]
pub async fn local_graph_inspect(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    principal_id: String,
    project_id: String,
    query: String,
    offset: usize,
) -> Result<GraphInspection, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        inspect_graph(&app, &principal_id, &project_id, &query, offset)
    })
    .await
    .map_err(|_| "Graph inspection task failed.".to_string())?
}

fn inspect_graph<D: GraphDatabaseProvider>(
    app: &D,
    principal: &str,
    project: &str,
    query: &str,
    offset: usize,
) -> Result<GraphInspection, String> {
    validate_principal_id(principal)?;
    validate_project_id(project)?;
    if query.chars().count() > 256 || offset > MAX_FILES {
        return Err("Invalid graph page.".into());
    }
    let connection = open_database(app)?;
    let bound = load_binding(&connection, principal, project)?;
    let total: i64 = connection.query_row("SELECT COUNT(*) FROM repository_files WHERE principal_id=?1 AND repository_id=?2 AND instr(lower(relative_path), lower(?3))>0", params![principal, bound.repository_id, query], |r| r.get(0)).map_err(db_error)?;
    let mut statement = connection.prepare("SELECT id, evidence_id, relative_path, language FROM repository_files WHERE principal_id=?1 AND repository_id=?2 AND instr(lower(relative_path), lower(?3))>0 ORDER BY relative_path LIMIT 40 OFFSET ?4").map_err(db_error)?;
    let rows = statement
        .query_map(
            params![principal, bound.repository_id, query, offset as i64],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(db_error)?;
    let mut files = Vec::new();
    for row in rows {
        let (file_id, id, path, language) = row.map_err(db_error)?;
        let mut symbols_query = connection.prepare("SELECT name,kind,start_line,end_line FROM repository_symbols WHERE file_id=?1 ORDER BY id LIMIT 13").map_err(db_error)?;
        let mut symbols = symbols_query
            .query_map([file_id], |r| {
                Ok(GraphSymbolRef {
                    name: r.get(0)?,
                    kind: r.get(1)?,
                    start_line: r.get::<_, i64>(2)? as usize,
                    end_line: r.get::<_, i64>(3)? as usize,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let mut edges_query = connection.prepare("SELECT edge_kind,substr(target,1,2048) FROM repository_edges WHERE file_id=?1 ORDER BY id LIMIT 13").map_err(db_error)?;
        let mut relations = edges_query
            .query_map([file_id], |r| {
                Ok(GraphInspectionRelation {
                    kind: r.get(0)?,
                    target: r.get(1)?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let truncated = symbols.len() > 12 || relations.len() > 12;
        symbols.truncate(12);
        relations.truncate(12);
        files.push(GraphInspectionFile {
            id,
            path,
            language,
            symbols,
            relations,
            truncated,
        });
    }
    Ok(GraphInspection {
        total: total as usize,
        offset,
        files,
    })
}

#[tauri::command]
pub async fn local_graph_read_snippets(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    principal_id: String,
    project_id: String,
    evidence_ids: Vec<String>,
    max_total_bytes: Option<usize>,
    query: Option<String>,
) -> Result<GraphSnippetResult, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        read_snippets(
            &app,
            &principal_id,
            &project_id,
            evidence_ids,
            max_total_bytes,
            query.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("Repository snippet task failed: {error}"))?
}

#[tauri::command]
pub async fn local_graph_unbind(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    principal_id: String,
    project_id: String,
    delete_index: bool,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        unbind_repository(&app, &principal_id, &project_id, delete_index)
    })
    .await
    .map_err(|error| format!("Repository unbind task failed: {error}"))?
}

fn bind_repository<D: GraphDatabaseProvider>(
    app: &D,
    principal_id: &str,
    project_id: &str,
    root_path: &str,
) -> Result<RepositoryBinding, String> {
    validate_principal_id(principal_id)?;
    validate_project_id(project_id)?;
    let root = validate_repository_root(Path::new(root_path))?;
    let display_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Repository")
        .to_string();
    let git = read_git_state(&root);
    let mut connection = open_database(app)?;
    let tx = connection.transaction().map_err(db_error)?;
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT repository_id, root_path FROM repository_bindings
             WHERE principal_id = ?1 AND project_id = ?2",
            params![principal_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    let repository_id = existing
        .as_ref()
        .map(|value| value.0.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let root_string = root.to_string_lossy().to_string();

    if existing
        .as_ref()
        .is_some_and(|value| value.1 != root_string)
    {
        clear_repository_index(&tx, principal_id, &repository_id)?;
    }

    tx.execute(
        "INSERT INTO repository_bindings
            (principal_id, project_id, repository_id, root_path, display_name, status, branch, commit_sha, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'unindexed', ?6, ?7, ?8, ?8)
         ON CONFLICT(principal_id, project_id) DO UPDATE SET
            root_path = excluded.root_path,
            display_name = excluded.display_name,
            status = CASE WHEN repository_bindings.root_path = excluded.root_path THEN repository_bindings.status ELSE 'unindexed' END,
            branch = excluded.branch,
            commit_sha = excluded.commit_sha,
            error = NULL,
            updated_at = excluded.updated_at",
        params![
            principal_id,
            project_id,
            repository_id,
            root_string,
            display_name,
            git.branch,
            git.commit_sha,
            unix_timestamp(),
        ],
    )
    .map_err(db_error)?;
    tx.commit().map_err(db_error)?;

    Ok(RepositoryBinding {
        repository_id,
        project_id: project_id.to_string(),
        display_name,
        branch: git.branch,
        commit_sha: git.commit_sha,
        status: "unindexed".into(),
    })
}

#[cfg(test)]
fn index_repository<D: GraphDatabaseProvider>(
    app: &D,
    principal_id: &str,
    project_id: &str,
) -> Result<GraphIndexResult, String> {
    index_repository_cancellable(app, principal_id, project_id, None)
}

fn index_repository_cancellable<D: GraphDatabaseProvider>(
    app: &D,
    principal_id: &str,
    project_id: &str,
    cancellation: Option<&AtomicBool>,
) -> Result<GraphIndexResult, String> {
    validate_principal_id(principal_id)?;
    validate_project_id(project_id)?;
    let connection = open_database(app)?;
    let bound = load_binding(&connection, principal_id, project_id)?;
    validate_repository_root(&bound.root_path)?;
    connection
        .execute(
            "UPDATE repository_bindings SET status = 'indexing', error = NULL, updated_at = ?3
             WHERE principal_id = ?1 AND project_id = ?2",
            params![principal_id, project_id, unix_timestamp()],
        )
        .map_err(db_error)?;

    let run_id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO repository_index_runs
                (principal_id, run_id, repository_id, status, started_at)
             VALUES (?1, ?2, ?3, 'running', ?4)",
            params![principal_id, run_id, bound.repository_id, unix_timestamp()],
        )
        .map_err(db_error)?;

    match perform_index(app, &bound, &run_id, cancellation) {
        Ok(result) => Ok(result),
        Err(error) => {
            if let Ok(connection) = open_database(app) {
                let _ = connection.execute(
                    "UPDATE repository_bindings SET status = 'error', error = ?3, updated_at = ?4
                     WHERE principal_id = ?1 AND project_id = ?2",
                    params![
                        principal_id,
                        project_id,
                        truncate_chars(&error, 1_000),
                        unix_timestamp()
                    ],
                );
                let _ = connection.execute(
                    "UPDATE repository_index_runs SET status = 'error', error = ?3, finished_at = ?4
                     WHERE principal_id = ?1 AND run_id = ?2",
                    params![principal_id, run_id, truncate_chars(&error, 1_000), unix_timestamp()],
                );
            }
            Err(error)
        }
    }
}

fn perform_index<D: GraphDatabaseProvider>(
    app: &D,
    bound: &BoundRepository,
    run_id: &str,
    cancellation: Option<&AtomicBool>,
) -> Result<GraphIndexResult, String> {
    let started = Instant::now();
    let git = read_git_state(&bound.root_path);
    let mut connection = open_database(app)?;
    let existing = existing_hashes(&connection, &bound.principal_id, &bound.repository_id)?;
    let mut unseen: HashSet<String> = existing.keys().cloned().collect();
    let tx = connection.transaction().map_err(db_error)?;
    let mut files = 0usize;
    let mut skipped = 0usize;
    let mut unchanged = 0usize;
    let mut total_bytes = 0u64;
    let mut lsp_sources = Vec::new();
    let mut lsp_bytes = 0usize;
    let mut lsp_limited = false;

    let mut builder = WalkBuilder::new(&bound.root_path);
    builder
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .add_custom_ignore_filename(".luczorignore")
        .follow_links(false)
        .max_filesize(Some(MAX_FILE_BYTES))
        .filter_entry(|entry| !is_hard_excluded(entry));

    for entry in builder.build() {
        if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err("Repository indexing paused for foreground work.".into());
        }
        if started.elapsed() > MAX_RUN_TIME {
            return Err("Repository indexing exceeded the 15 minute safety limit.".into());
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Some(file_type) if file_type.is_file() && !file_type.is_symlink() => file_type,
            _ => continue,
        };
        let _ = file_type;
        let path = entry.path();
        let Some(language) = language_name(path) else {
            skipped += 1;
            continue;
        };
        if is_secret_file(path) {
            skipped += 1;
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.len() <= MAX_FILE_BYTES => metadata,
            _ => {
                skipped += 1;
                continue;
            }
        };
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > MAX_RUN_BYTES {
            return Err("Repository indexing exceeded the 512 MiB read limit.".into());
        }
        files += 1;
        if files > MAX_FILES {
            return Err("Repository indexing exceeded the 100000 file limit.".into());
        }
        let relative = safe_relative_path(&bound.root_path, path)?;
        let bytes = match fs::read(path) {
            Ok(bytes) if !bytes.contains(&0) => bytes,
            _ => {
                skipped += 1;
                continue;
            }
        };
        let content = match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        unseen.remove(&relative);
        let content_hash = sha256(content.as_bytes());
        if lsp::supports(path) {
            if lsp_sources.len() < 2048 && lsp_bytes + content.len() <= 32 * 1024 * 1024 {
                lsp_bytes += content.len();
                lsp_sources.push(lsp::Source {
                    path: relative.clone(),
                    content: content.clone(),
                    hash: content_hash.clone(),
                });
            } else {
                lsp_limited = true;
            }
        }
        if existing
            .get(&relative)
            .is_some_and(|value| value == &content_hash)
        {
            unchanged += 1;
            continue;
        }

        let parsed = parse_file(path, &content)?;
        replace_file(
            &tx,
            &bound.principal_id,
            &bound.repository_id,
            &relative,
            language,
            &content_hash,
            metadata.len(),
            metadata.modified().ok().and_then(system_time_secs),
            &content,
            &parsed,
        )?;
    }

    let deleted = unseen.len();
    if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("Repository indexing paused for foreground work.".into());
    }
    for relative in unseen {
        if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err("Repository indexing paused for foreground work.".into());
        }
        delete_file(&tx, &bound.principal_id, &bound.repository_id, &relative)?;
    }

    lsp_sources.sort_by(|a, b| a.path.cmp(&b.path));
    lsp::enrich(app, &tx, bound, &lsp_sources, lsp_limited, cancellation)?;
    let (file_count, symbol_count, edge_count) =
        repository_counts(&tx, &bound.principal_id, &bound.repository_id)?;
    tx.execute(
        "UPDATE repository_bindings SET
            status = 'ready', branch = ?3, commit_sha = ?4, file_count = ?5,
            symbol_count = ?6, edge_count = ?7, skipped_count = ?8,
            last_indexed_at = ?9, error = NULL, updated_at = ?9
         WHERE principal_id = ?1 AND repository_id = ?2",
        params![
            bound.principal_id,
            bound.repository_id,
            git.branch,
            git.commit_sha,
            file_count,
            symbol_count,
            edge_count,
            skipped as i64,
            unix_timestamp(),
        ],
    )
    .map_err(db_error)?;
    tx.execute(
        "UPDATE repository_index_runs SET status = 'ready', files = ?3, symbols = ?4, edges = ?5,
            skipped = ?6, unchanged = ?7, deleted = ?8, finished_at = ?9
         WHERE principal_id = ?1 AND run_id = ?2",
        params![
            bound.principal_id,
            run_id,
            file_count,
            symbol_count,
            edge_count,
            skipped as i64,
            unchanged as i64,
            deleted as i64,
            unix_timestamp()
        ],
    )
    .map_err(db_error)?;
    if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("Repository indexing paused for foreground work.".into());
    }
    tx.commit().map_err(db_error)?;

    Ok(GraphIndexResult {
        run_id: run_id.to_string(),
        status: "ready".into(),
        files: file_count as usize,
        symbols: symbol_count as usize,
        edges: edge_count as usize,
        skipped,
        unchanged,
        deleted,
        branch: git.branch,
        commit_sha: git.commit_sha,
    })
}

fn graph_status<D: GraphDatabaseProvider>(
    app: &D,
    principal_id: &str,
    project_id: &str,
) -> Result<GraphStatus, String> {
    validate_principal_id(principal_id)?;
    validate_project_id(project_id)?;
    let connection = open_database(app)?;
    let mut status = connection
        .query_row(
            "SELECT repository_id, display_name, status, file_count, symbol_count, edge_count,
                    skipped_count, branch, commit_sha, last_indexed_at, error
             FROM repository_bindings WHERE principal_id = ?1 AND project_id = ?2",
            params![principal_id, project_id],
            |row| {
                Ok(GraphStatus {
                    lsp: None,
                    repository_id: row.get(0)?,
                    display_name: row.get(1)?,
                    status: row.get(2)?,
                    files: row.get::<_, i64>(3)? as usize,
                    symbols: row.get::<_, i64>(4)? as usize,
                    edges: row.get::<_, i64>(5)? as usize,
                    skipped: row.get::<_, i64>(6)? as usize,
                    branch: row.get(7)?,
                    commit_sha: row.get(8)?,
                    last_indexed_at: row.get(9)?,
                    error: row.get(10)?,
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .unwrap_or(GraphStatus {
            lsp: None,
            status: "unbound".into(),
            repository_id: None,
            display_name: None,
            files: 0,
            symbols: 0,
            edges: 0,
            skipped: 0,
            branch: None,
            commit_sha: None,
            last_indexed_at: None,
            error: None,
        });
    if let Some(repo) = status.repository_id.as_deref() {
        status.lsp = lsp::state(&connection, principal_id, repo);
    }
    if status.status == "ready" {
        let bound = load_binding(&connection, principal_id, project_id)?;
        let current = read_git_state(&bound.root_path);
        if current.branch != status.branch || current.commit_sha != status.commit_sha {
            status.status = "stale".into();
        }
    }
    Ok(status)
}

fn search_repository<D: GraphDatabaseProvider>(
    app: &D,
    principal_id: &str,
    project_id: &str,
    query: &str,
    limit: Option<usize>,
) -> Result<GraphSearchResult, String> {
    validate_principal_id(principal_id)?;
    validate_project_id(project_id)?;
    if query.trim().is_empty() || query.chars().count() > MAX_QUERY_CHARS {
        return Err("Repository search query must contain 1 to 4096 characters.".into());
    }
    let connection = open_database(app)?;
    let bound = load_binding(&connection, principal_id, project_id)?;
    let status = graph_status(app, principal_id, project_id)?;
    if status.status != "ready" {
        return Err("The local repository graph is not ready.".into());
    }
    let terms = query_terms(query);
    if terms.is_empty() {
        return Err("Repository search query contains no searchable terms.".into());
    }
    let fts_query = terms
        .iter()
        .take(20)
        .map(|term| format!("\"{}\"", term.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" OR ");
    let hit_limit = limit.unwrap_or(8).clamp(1, MAX_SEARCH_HITS);
    let mut statement = connection
        .prepare(
            "SELECT evidence_id, relative_path, bm25(repository_search, 0.0, 0.0, 0.0, 1.6, 1.2, 0.8, 0.5) AS rank
             FROM repository_search
             WHERE repository_search MATCH ?1 AND principal_id = ?2 AND repository_id = ?3
             ORDER BY rank LIMIT ?4",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(
            params![
                fts_query,
                principal_id,
                bound.repository_id,
                hit_limit as i64
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )
        .map_err(db_error)?;
    let query_lower = query.to_lowercase();
    let mut hits = Vec::new();
    for row in rows {
        let (evidence_id, relative_path, rank) = row.map_err(db_error)?;
        let (language, content_hash): (String, String) = connection
            .query_row(
                "SELECT language, content_hash FROM repository_files
                 WHERE principal_id = ?1 AND repository_id = ?2 AND relative_path = ?3",
                params![principal_id, bound.repository_id, relative_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_error)?;
        let symbols = load_symbols(
            &connection,
            principal_id,
            &bound.repository_id,
            &relative_path,
        )?;
        let mut reasons = vec!["full_text".to_string()];
        if relative_path.to_lowercase().contains(&query_lower) {
            reasons.insert(0, "path_match".into());
        }
        if symbols
            .iter()
            .any(|symbol| symbol.name.eq_ignore_ascii_case(query.trim()))
        {
            reasons.insert(0, "symbol_exact".into());
        }
        hits.push(GraphSearchHit {
            relations: lsp::relations(&connection, &bound, &relative_path)?,
            evidence_id,
            relative_path,
            language,
            symbols,
            reasons,
            score: (1.0 / (1.0 + rank.abs())).clamp(0.0, 1.0),
            content_hash,
            stale: false,
        });
    }

    Ok(GraphSearchResult {
        repository_id: bound.repository_id,
        branch: status.branch,
        commit_sha: status.commit_sha,
        hits,
    })
}

fn read_snippets<D: GraphDatabaseProvider>(
    app: &D,
    principal_id: &str,
    project_id: &str,
    evidence_ids: Vec<String>,
    max_total_bytes: Option<usize>,
    query: Option<&str>,
) -> Result<GraphSnippetResult, String> {
    validate_principal_id(principal_id)?;
    validate_project_id(project_id)?;
    if query.is_some_and(|value| value.chars().count() > MAX_QUERY_CHARS) {
        return Err("Repository snippet query exceeds 4096 characters.".into());
    }
    if evidence_ids.len() > MAX_SEARCH_HITS {
        return Err("At most 30 repository evidence IDs can be materialized.".into());
    }
    let connection = open_database(app)?;
    let bound = load_binding(&connection, principal_id, project_id)?;
    let canonical_root = validate_repository_root(&bound.root_path)?;
    let total_limit = max_total_bytes
        .unwrap_or(MAX_SNIPPET_TOTAL_BYTES)
        .clamp(1, MAX_SNIPPET_TOTAL_BYTES);
    let mut used = 0usize;
    let mut snippets = Vec::new();
    let mut omitted = Vec::new();

    for evidence_id in evidence_ids {
        let record: Option<(String, String)> = connection
            .query_row(
                "SELECT relative_path, content_hash FROM repository_files
                 WHERE principal_id = ?1 AND repository_id = ?2 AND evidence_id = ?3",
                params![principal_id, bound.repository_id, evidence_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        let Some((relative_path, indexed_hash)) = record else {
            omitted.push(OmittedSnippet {
                evidence_id,
                reason: "not_found".into(),
            });
            continue;
        };
        let path = canonical_root.join(&relative_path);
        let canonical_path = match path.canonicalize() {
            Ok(path) if path.starts_with(&canonical_root) => path,
            _ => {
                omitted.push(OmittedSnippet {
                    evidence_id,
                    reason: "path_escape".into(),
                });
                continue;
            }
        };
        if is_secret_file(&canonical_path) {
            omitted.push(OmittedSnippet {
                evidence_id,
                reason: "sensitive_file".into(),
            });
            continue;
        }
        let bytes = match fs::read(&canonical_path) {
            Ok(bytes) if bytes.len() as u64 <= MAX_FILE_BYTES && !bytes.contains(&0) => bytes,
            _ => {
                omitted.push(OmittedSnippet {
                    evidence_id,
                    reason: "unreadable".into(),
                });
                continue;
            }
        };
        if sha256(&bytes) != indexed_hash {
            omitted.push(OmittedSnippet {
                evidence_id,
                reason: "stale_hash".into(),
            });
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => {
                omitted.push(OmittedSnippet {
                    evidence_id,
                    reason: "non_utf8".into(),
                });
                continue;
            }
        };
        let remaining = total_limit.saturating_sub(used);
        if remaining == 0 {
            omitted.push(OmittedSnippet {
                evidence_id,
                reason: "budget_exhausted".into(),
            });
            continue;
        }
        let (redacted, redactions) = redact_sensitive_lines(&content);
        let (snippet, start_line, end_line) =
            focused_snippet(&redacted, query, MAX_SNIPPET_BYTES.min(remaining));
        used += snippet.len();
        snippets.push(GraphSnippet {
            evidence_id,
            relative_path,
            start_line,
            end_line,
            content: snippet,
            content_hash: indexed_hash,
            redactions,
        });
    }

    Ok(GraphSnippetResult { snippets, omitted })
}

/// Deliver evidence near the requested symbol/topic instead of always losing
/// matches below the file header. Redaction and full-file hash checks happen first.
fn focused_snippet(content: &str, query: Option<&str>, max_bytes: usize) -> (String, usize, usize) {
    let terms: Vec<String> = query
        .map(query_terms)
        .unwrap_or_default()
        .into_iter()
        .filter(|term| term.len() >= 3)
        .take(20)
        .collect();
    let lines: Vec<&str> = content.lines().collect();
    let mut best_line = 0;
    let mut best_score = 0;
    for (index, line) in lines.iter().enumerate() {
        let lower = line.to_lowercase();
        let matched = terms
            .iter()
            .filter(|term| lower.contains(term.as_str()))
            .count();
        let declaration = [
            "function ",
            "fn ",
            "class ",
            "struct ",
            "const ",
            "def ",
            "interface ",
            "type ",
        ]
        .iter()
        .any(|marker| lower.contains(marker));
        let score = matched * 4 + usize::from(matched > 0 && declaration) * 2;
        if score > best_score {
            best_line = index;
            best_score = score;
        }
    }
    let mut first_line = best_line.saturating_sub(4);
    // Long preceding lines must not consume the entire budget before the hit.
    while first_line < best_line
        && lines[first_line..best_line]
            .iter()
            .map(|line| line.len() + 1)
            .sum::<usize>()
            > max_bytes / 3
    {
        first_line += 1;
    }
    let remainder = lines[first_line..].join("\n");
    let snippet = truncate_utf8_bytes(&remainder, max_bytes);
    let last_line = first_line + snippet.lines().count().max(1);
    (snippet, first_line + 1, last_line)
}

fn unbind_repository<D: GraphDatabaseProvider>(
    app: &D,
    principal_id: &str,
    project_id: &str,
    delete_index: bool,
) -> Result<(), String> {
    validate_principal_id(principal_id)?;
    validate_project_id(project_id)?;
    let mut connection = open_database(app)?;
    let tx = connection.transaction().map_err(db_error)?;
    let repository_id: Option<String> = tx
        .query_row(
            "SELECT repository_id FROM repository_bindings
             WHERE principal_id = ?1 AND project_id = ?2",
            params![principal_id, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    if let Some(repository_id) = repository_id {
        if delete_index {
            clear_repository_index(&tx, principal_id, &repository_id)?;
            tx.execute(
                "DELETE FROM repository_bindings WHERE principal_id = ?1 AND project_id = ?2",
                params![principal_id, project_id],
            )
            .map_err(db_error)?;
        } else {
            tx.execute(
                "UPDATE repository_bindings SET root_path = '', status = 'unbound', error = NULL, updated_at = ?3
                 WHERE principal_id = ?1 AND project_id = ?2",
                params![principal_id, project_id, unix_timestamp()],
            )
            .map_err(db_error)?;
        }
    }
    tx.commit().map_err(db_error)
}

trait GraphDatabaseProvider {
    fn graph_database_path(&self) -> Result<PathBuf, String>;
    fn lsp_runtime_root(&self) -> Option<PathBuf> {
        None
    }
}

impl<R: Runtime> GraphDatabaseProvider for AppHandle<R> {
    fn lsp_runtime_root(&self) -> Option<PathBuf> {
        let packaged = self.path().resource_dir().ok()?.join("repository-lsp");
        if packaged.join("runtime.json").is_file() {
            return Some(packaged);
        }
        #[cfg(debug_assertions)]
        {
            let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../.lmzdev/artifacts/runtime/repository-lsp");
            if development.join("runtime.json").is_file() {
                return Some(development);
            }
        }
        None
    }
    fn graph_database_path(&self) -> Result<PathBuf, String> {
        Ok(self
            .path()
            .app_data_dir()
            .map_err(|error| format!("Cannot resolve app data directory: {error}"))?
            .join("local-context")
            .join("v1")
            .join("local-context.sqlite3"))
    }
}

#[cfg(test)]
struct TestGraphDatabase {
    path: PathBuf,
}

#[cfg(test)]
impl GraphDatabaseProvider for TestGraphDatabase {
    fn graph_database_path(&self) -> Result<PathBuf, String> {
        Ok(self.path.clone())
    }
}

fn open_database<D: GraphDatabaseProvider>(database: &D) -> Result<Connection, String> {
    let path = database.graph_database_path()?;
    let directory = path
        .parent()
        .ok_or_else(|| "Local repository database path has no parent directory.".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Cannot create local context directory: {error}"))?;
    let connection = Connection::open(path).map_err(db_error)?;
    initialize_schema(&connection)?;
    Ok(connection)
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(db_error)?;

    quarantine_legacy_bindings(connection)?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS repository_bindings (
                principal_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                repository_id TEXT NOT NULL,
                root_path TEXT NOT NULL,
                display_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'unindexed',
                branch TEXT,
                commit_sha TEXT,
                file_count INTEGER NOT NULL DEFAULT 0,
                symbol_count INTEGER NOT NULL DEFAULT 0,
                edge_count INTEGER NOT NULL DEFAULT 0,
                skipped_count INTEGER NOT NULL DEFAULT 0,
                last_indexed_at INTEGER,
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(principal_id, project_id),
                UNIQUE(principal_id, repository_id)
             );",
        )
        .map_err(db_error)?;

    if !derived_schema_is_principal_scoped(connection)? {
        rebuild_derived_schema(connection)?;
    }
    create_derived_schema(connection)?;
    lsp::initialize(connection)
}

fn quarantine_legacy_bindings(connection: &Connection) -> Result<(), String> {
    if !table_exists(connection, "repository_bindings")? {
        return Ok(());
    }
    let columns = table_columns(connection, "repository_bindings")?;
    let principal_pk = columns
        .iter()
        .find(|(name, _)| name == "principal_id")
        .map(|(_, pk)| *pk);
    let project_pk = columns
        .iter()
        .find(|(name, _)| name == "project_id")
        .map(|(_, pk)| *pk);
    if principal_pk == Some(1) && project_pk == Some(2) {
        return Ok(());
    }

    connection
        .execute_batch(
            "BEGIN IMMEDIATE;
             DROP TABLE IF EXISTS repository_search;
             DROP TABLE IF EXISTS repository_symbols;
             DROP TABLE IF EXISTS repository_edges;
             DROP TABLE IF EXISTS repository_index_runs;
             DROP TABLE IF EXISTS repository_files;
             DROP TABLE IF EXISTS repository_bindings_legacy_quarantine_v1;
             ALTER TABLE repository_bindings RENAME TO repository_bindings_legacy_quarantine_v1;
             COMMIT;",
        )
        .map_err(db_error)
}

fn create_derived_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS repository_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                principal_id TEXT NOT NULL,
                repository_id TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                evidence_id TEXT NOT NULL,
                language TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                modified_at INTEGER,
                UNIQUE(principal_id, repository_id, relative_path),
                UNIQUE(principal_id, evidence_id),
                FOREIGN KEY(principal_id, repository_id)
                    REFERENCES repository_bindings(principal_id, repository_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS repository_symbols (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                FOREIGN KEY(file_id) REFERENCES repository_files(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS repository_symbols_name_idx ON repository_symbols(name);
             CREATE TABLE IF NOT EXISTS repository_edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL,
                edge_kind TEXT NOT NULL,
                target TEXT NOT NULL,
                FOREIGN KEY(file_id) REFERENCES repository_files(id) ON DELETE CASCADE
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS repository_search USING fts5(
                principal_id UNINDEXED,
                repository_id UNINDEXED,
                evidence_id UNINDEXED,
                relative_path,
                symbols,
                imports,
                content,
                tokenize = 'unicode61'
             );
             CREATE TABLE IF NOT EXISTS repository_index_runs (
                principal_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                repository_id TEXT NOT NULL,
                status TEXT NOT NULL,
                files INTEGER NOT NULL DEFAULT 0,
                symbols INTEGER NOT NULL DEFAULT 0,
                edges INTEGER NOT NULL DEFAULT 0,
                skipped INTEGER NOT NULL DEFAULT 0,
                unchanged INTEGER NOT NULL DEFAULT 0,
                deleted INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                PRIMARY KEY(principal_id, run_id),
                FOREIGN KEY(principal_id, repository_id)
                    REFERENCES repository_bindings(principal_id, repository_id) ON DELETE CASCADE
             );",
        )
        .map_err(db_error)
}

fn derived_schema_is_principal_scoped(connection: &Connection) -> Result<bool, String> {
    for table in [
        "repository_files",
        "repository_symbols",
        "repository_edges",
        "repository_search",
        "repository_index_runs",
    ] {
        if !table_exists(connection, table)? {
            return Ok(false);
        }
    }
    let file_columns = table_columns(connection, "repository_files")?;
    let run_columns = table_columns(connection, "repository_index_runs")?;
    let search_columns = table_columns(connection, "repository_search")?;
    let expected_search = [
        "principal_id",
        "repository_id",
        "evidence_id",
        "relative_path",
        "symbols",
        "imports",
        "content",
    ];
    Ok(file_columns.iter().any(|(name, _)| name == "principal_id")
        && run_columns.iter().any(|(name, _)| name == "principal_id")
        && search_columns
            .iter()
            .map(|(name, _)| name.as_str())
            .eq(expected_search))
}

fn rebuild_derived_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "BEGIN IMMEDIATE;
             DROP TABLE IF EXISTS repository_search;
             DROP TABLE IF EXISTS repository_symbols;
             DROP TABLE IF EXISTS repository_edges;
             DROP TABLE IF EXISTS repository_index_runs;
             DROP TABLE IF EXISTS repository_files;
             UPDATE repository_bindings SET
                status = 'unindexed', file_count = 0, symbol_count = 0, edge_count = 0,
                skipped_count = 0, last_indexed_at = NULL, error = NULL, updated_at = unixepoch();
             COMMIT;",
        )
        .map_err(db_error)
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?1)",
            [table],
            |row| row.get(0),
        )
        .map_err(db_error)
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<(String, i64)>, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&sql).map_err(db_error)?;
    let columns = statement
        .query_map([], |row| Ok((row.get(1)?, row.get(5)?)))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(columns)
}

fn load_binding(
    connection: &Connection,
    principal_id: &str,
    project_id: &str,
) -> Result<BoundRepository, String> {
    connection
        .query_row(
            "SELECT repository_id, root_path FROM repository_bindings
             WHERE principal_id = ?1 AND project_id = ?2",
            params![principal_id, project_id],
            |row| {
                Ok(BoundRepository {
                    principal_id: principal_id.to_string(),
                    repository_id: row.get(0)?,
                    root_path: PathBuf::from(row.get::<_, String>(1)?),
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "No local repository is bound to this project.".into())
}

fn existing_hashes(
    connection: &Connection,
    principal_id: &str,
    repository_id: &str,
) -> Result<HashMap<String, String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT relative_path, content_hash FROM repository_files
             WHERE principal_id = ?1 AND repository_id = ?2",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![principal_id, repository_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(db_error)?;
    let mut hashes = HashMap::new();
    for row in rows {
        let (path, hash): (String, String) = row.map_err(db_error)?;
        hashes.insert(path, hash);
    }
    Ok(hashes)
}

#[allow(clippy::too_many_arguments)]
fn replace_file(
    tx: &Transaction<'_>,
    principal_id: &str,
    repository_id: &str,
    relative_path: &str,
    language: &str,
    content_hash: &str,
    size_bytes: u64,
    modified_at: Option<i64>,
    content: &str,
    parsed: &ParsedFile,
) -> Result<(), String> {
    delete_file(tx, principal_id, repository_id, relative_path)?;
    let evidence_id =
        sha256(format!("{principal_id}|{repository_id}|{relative_path}|{content_hash}").as_bytes());
    tx.execute(
        "INSERT INTO repository_files
            (principal_id, repository_id, relative_path, evidence_id, language, content_hash, size_bytes, modified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![principal_id, repository_id, relative_path, evidence_id, language, content_hash, size_bytes as i64, modified_at],
    )
    .map_err(db_error)?;
    let file_id = tx.last_insert_rowid();
    for symbol in &parsed.symbols {
        tx.execute(
            "INSERT INTO repository_symbols (file_id, name, kind, start_line, end_line) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![file_id, symbol.name, symbol.kind, symbol.start_line as i64, symbol.end_line as i64],
        )
        .map_err(db_error)?;
    }
    for target in &parsed.imports {
        tx.execute(
            "INSERT INTO repository_edges (file_id, edge_kind, target) VALUES (?1, 'import', ?2)",
            params![file_id, target],
        )
        .map_err(db_error)?;
    }
    tx.execute(
        "INSERT INTO repository_search
            (principal_id, repository_id, evidence_id, relative_path, symbols, imports, content)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            principal_id,
            repository_id,
            evidence_id,
            relative_path,
            parsed
                .symbols
                .iter()
                .map(|symbol| symbol.name.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            parsed.imports.join(" "),
            truncate_utf8_bytes(content, MAX_FTS_CONTENT_BYTES),
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn delete_file(
    tx: &Transaction<'_>,
    principal_id: &str,
    repository_id: &str,
    relative_path: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM repository_search
         WHERE principal_id = ?1 AND repository_id = ?2 AND relative_path = ?3",
        params![principal_id, repository_id, relative_path],
    )
    .map_err(db_error)?;
    tx.execute(
        "DELETE FROM repository_files
         WHERE principal_id = ?1 AND repository_id = ?2 AND relative_path = ?3",
        params![principal_id, repository_id, relative_path],
    )
    .map_err(db_error)?;
    Ok(())
}

fn clear_repository_index(
    tx: &Transaction<'_>,
    principal_id: &str,
    repository_id: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM repository_search WHERE principal_id = ?1 AND repository_id = ?2",
        params![principal_id, repository_id],
    )
    .map_err(db_error)?;
    tx.execute(
        "DELETE FROM repository_files WHERE principal_id = ?1 AND repository_id = ?2",
        params![principal_id, repository_id],
    )
    .map_err(db_error)?;
    tx.execute(
        "DELETE FROM repository_index_runs WHERE principal_id = ?1 AND repository_id = ?2",
        params![principal_id, repository_id],
    )
    .map_err(db_error)?;
    Ok(())
}

fn repository_counts(
    connection: &Connection,
    principal_id: &str,
    repository_id: &str,
) -> Result<(i64, i64, i64), String> {
    connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM repository_files WHERE principal_id = ?1 AND repository_id = ?2),
                (SELECT COUNT(*) FROM repository_symbols s JOIN repository_files f ON f.id = s.file_id
                    WHERE f.principal_id = ?1 AND f.repository_id = ?2),
                (SELECT COUNT(*) FROM repository_edges e JOIN repository_files f ON f.id = e.file_id
                    WHERE f.principal_id = ?1 AND f.repository_id = ?2)",
            params![principal_id, repository_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(db_error)
}

fn load_symbols(
    connection: &Connection,
    principal_id: &str,
    repository_id: &str,
    relative_path: &str,
) -> Result<Vec<GraphSymbolRef>, String> {
    let mut statement = connection
        .prepare(
            "SELECT s.name, s.kind, s.start_line, s.end_line
             FROM repository_symbols s JOIN repository_files f ON f.id = s.file_id
             WHERE f.principal_id = ?1 AND f.repository_id = ?2 AND f.relative_path = ?3
             ORDER BY s.start_line LIMIT 20",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![principal_id, repository_id, relative_path], |row| {
            Ok(GraphSymbolRef {
                name: row.get(0)?,
                kind: row.get(1)?,
                start_line: row.get::<_, i64>(2)? as usize,
                end_line: row.get::<_, i64>(3)? as usize,
            })
        })
        .map_err(db_error)?;
    let mut symbols = Vec::new();
    for row in rows {
        symbols.push(row.map_err(db_error)?);
    }
    Ok(symbols)
}

fn parse_file(path: &Path, content: &str) -> Result<ParsedFile, String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if file_name.ends_with(".blade.php") {
        return Ok(ParsedFile {
            symbols: Vec::new(),
            imports: Vec::new(),
        });
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "vue" {
        return parse_vue(content);
    }
    let language = match extension.as_str() {
        "php" => Some(tree_sitter_php::LANGUAGE_PHP.into()),
        "ts" | "tsx" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "js" | "jsx" | "mjs" | "cjs" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "rs" => Some(tree_sitter_rust::LANGUAGE.into()),
        "py" => Some(tree_sitter_python::LANGUAGE.into()),
        _ => None,
    };
    language.map_or_else(
        || {
            Ok(ParsedFile {
                symbols: Vec::new(),
                imports: Vec::new(),
            })
        },
        |language| parse_tree(content, language, 0),
    )
}

fn parse_vue(content: &str) -> Result<ParsedFile, String> {
    let Some(script_open) = content.find("<script") else {
        return Ok(ParsedFile {
            symbols: Vec::new(),
            imports: Vec::new(),
        });
    };
    let Some(open_end_relative) = content[script_open..].find('>') else {
        return Ok(ParsedFile {
            symbols: Vec::new(),
            imports: Vec::new(),
        });
    };
    let script_start = script_open + open_end_relative + 1;
    let Some(script_end_relative) = content[script_start..].find("</script>") else {
        return Ok(ParsedFile {
            symbols: Vec::new(),
            imports: Vec::new(),
        });
    };
    let open_tag = &content[script_open..script_start];
    let language: Language = if open_tag.contains("lang=\"ts\"") || open_tag.contains("lang='ts'") {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    } else {
        tree_sitter_javascript::LANGUAGE.into()
    };
    let line_offset = content[..script_start].lines().count().saturating_sub(1);
    parse_tree(
        &content[script_start..script_start + script_end_relative],
        language,
        line_offset,
    )
}

fn parse_tree(content: &str, language: Language, line_offset: usize) -> Result<ParsedFile, String> {
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|error| format!("Cannot initialize repository parser: {error}"))?;
    let tree = parser
        .parse(content, None)
        .ok_or_else(|| "Repository parser returned no syntax tree.".to_string())?;
    let mut symbols = Vec::new();
    let mut imports = Vec::new();
    collect_nodes(
        tree.root_node(),
        content.as_bytes(),
        line_offset,
        &mut symbols,
        &mut imports,
    );
    symbols.sort_by_key(|symbol| symbol.start_line);
    symbols.dedup_by(|a, b| a.name == b.name && a.kind == b.kind && a.start_line == b.start_line);
    imports.sort();
    imports.dedup();
    Ok(ParsedFile { symbols, imports })
}

fn collect_nodes(
    node: Node<'_>,
    source: &[u8],
    line_offset: usize,
    symbols: &mut Vec<ParsedSymbol>,
    imports: &mut Vec<String>,
) {
    let kind = node.kind();
    if let Some(symbol_kind) = symbol_kind(kind) {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(source) {
                let name = name.trim();
                if !name.is_empty() && name.len() <= 240 {
                    symbols.push(ParsedSymbol {
                        name: name.to_string(),
                        kind: symbol_kind.to_string(),
                        start_line: node.start_position().row + line_offset + 1,
                        end_line: node.end_position().row + line_offset + 1,
                    });
                }
            }
        }
    }
    if is_import_kind(kind) {
        if let Ok(value) = node.utf8_text(source) {
            let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
            if !value.is_empty() {
                imports.push(truncate_chars(&value, 500));
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_nodes(child, source, line_offset, symbols, imports);
    }
}

fn symbol_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "function_definition" | "function_declaration" | "function_item" => Some("function"),
        "method_declaration" | "method_definition" => Some("method"),
        "class_declaration" | "class_definition" => Some("class"),
        "interface_declaration" => Some("interface"),
        "trait_declaration" | "trait_item" => Some("trait"),
        "struct_item" => Some("struct"),
        "enum_item" => Some("enum"),
        "type_alias_declaration" | "type_item" => Some("type"),
        "mod_item" | "module" => Some("module"),
        _ => None,
    }
}

fn is_import_kind(kind: &str) -> bool {
    matches!(
        kind,
        "namespace_use_declaration"
            | "use_declaration"
            | "import_statement"
            | "import_from_statement"
            | "extern_crate_declaration"
    )
}

fn language_name(path: &Path) -> Option<&'static str> {
    let file_name = path.file_name()?.to_str()?.to_ascii_lowercase();
    if file_name.ends_with(".blade.php") {
        return Some("blade");
    }
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "php" => Some("php"),
        "ts" | "tsx" => Some("typescript"),
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "vue" => Some("vue"),
        "rs" => Some("rust"),
        "py" => Some("python"),
        "json" => Some("json"),
        "md" | "mdx" => Some("markdown"),
        "css" | "scss" | "sass" | "less" => Some("css"),
        "sql" => Some("sql"),
        "toml" | "yaml" | "yml" => Some("config"),
        _ => None,
    }
}

fn validate_repository_root(path: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| "Repository path does not exist or cannot be read.".to_string())?;
    if !canonical.is_dir() || canonical.parent().is_none() {
        return Err("Repository path must be a directory below a filesystem root.".into());
    }
    if !canonical.join(".git").exists() {
        return Err("Repository path must contain a Git checkout.".into());
    }
    Ok(canonical)
}

fn validate_project_id(project_id: &str) -> Result<(), String> {
    if project_id.trim().is_empty() || project_id.chars().count() > 120 {
        return Err("Project ID must contain 1 to 120 characters.".into());
    }
    Ok(())
}

fn validate_principal_id(principal_id: &str) -> Result<(), String> {
    if principal_id.trim() != principal_id
        || principal_id.is_empty()
        || principal_id.len() > 200
        || !principal_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
    {
        return Err("Principal ID must be a stable 1 to 200 character account identifier.".into());
    }
    Ok(())
}

fn safe_relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Repository file escaped its bound root.".to_string())?;
    if relative
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Repository file contained a parent traversal.".into());
    }
    let value = relative.to_string_lossy().replace('\\', "/");
    if value.is_empty() || value.starts_with('/') {
        return Err("Repository file path is invalid.".into());
    }
    Ok(value)
}

fn is_hard_excluded(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
    matches!(
        name.as_str(),
        ".git"
            | "node_modules"
            | "vendor"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".nuxt"
            | "coverage"
            | ".cache"
            | "storage"
    ) || is_secret_file(entry.path())
}

fn is_secret_file(path: &Path) -> bool {
    if path.components().any(|component| {
        matches!(
            component
                .as_os_str()
                .to_string_lossy()
                .to_ascii_lowercase()
                .as_str(),
            ".ssh" | ".gnupg" | ".aws" | ".azure" | ".kube" | ".docker" | ".secrets"
        )
    }) {
        return true;
    }

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name == ".env"
        || name.starts_with(".env.")
        || matches!(
            name.as_str(),
            "id_rsa"
                | "id_ed25519"
                | "id_dsa"
                | "id_ecdsa"
                | ".npmrc"
                | ".pypirc"
                | ".netrc"
                | ".envrc"
                | ".htpasswd"
                | ".pgpass"
                | ".my.cnf"
                | "auth.json"
                | "kubeconfig"
                | "wp-config.php"
                | "credentials.json"
                | "credentials.yaml"
                | "credentials.yml"
                | "credentials.toml"
                | "secrets.json"
                | "secrets.yaml"
                | "secrets.yml"
                | "secrets.toml"
                | "service-account.json"
                | "service_account.json"
                | "terraform.tfstate"
                | "terraform.tfstate.backup"
                | "application-default-credentials.json"
        )
        || ((name.starts_with("id_rsa.")
            || name.starts_with("id_ed25519.")
            || name.starts_with("id_dsa.")
            || name.starts_with("id_ecdsa."))
            && !name.ends_with(".pub"))
        || (name.ends_with(".json")
            && (name.starts_with("client_secret_")
                || name.contains("service-account")
                || name.contains("service_account")
                || name.ends_with("-credentials.json")
                || name.ends_with("_credentials.json")))
        || name.ends_with(".auto.tfvars")
        || name.ends_with(".tfstate.backup")
    {
        return true;
    }
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "pem"
            | "key"
            | "p8"
            | "ppk"
            | "p12"
            | "pfx"
            | "pkcs12"
            | "jks"
            | "keystore"
            | "kdbx"
            | "ovpn"
            | "tfvars"
            | "tfstate"
    )
}

fn read_git_state(root: &Path) -> GitState {
    let Some(git_dir) = resolve_git_dir(root) else {
        return GitState {
            branch: None,
            commit_sha: None,
        };
    };
    let Ok(head) = fs::read_to_string(git_dir.join("HEAD")) else {
        return GitState {
            branch: None,
            commit_sha: None,
        };
    };
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref: ") {
        let branch = reference
            .strip_prefix("refs/heads/")
            .unwrap_or(reference)
            .to_string();
        let commit_sha = fs::read_to_string(git_dir.join(reference))
            .ok()
            .map(|value| value.trim().to_string())
            .or_else(|| packed_ref(&git_dir, reference));
        GitState {
            branch: Some(branch),
            commit_sha,
        }
    } else {
        GitState {
            branch: None,
            commit_sha: (!head.is_empty()).then(|| head.to_string()),
        }
    }
}

fn resolve_git_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let value = fs::read_to_string(dot_git).ok()?;
    let path = value.trim().strip_prefix("gitdir:")?.trim();
    let candidate = PathBuf::from(path);
    Some(if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    })
}

fn packed_ref(git_dir: &Path, reference: &str) -> Option<String> {
    fs::read_to_string(git_dir.join("packed-refs"))
        .ok()?
        .lines()
        .filter(|line| !line.starts_with('#') && !line.starts_with('^'))
        .find_map(|line| {
            let (hash, name) = line.split_once(' ')?;
            (name.trim() == reference).then(|| hash.trim().to_string())
        })
}

fn query_terms(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    query
        .split(|character: char| {
            !(character.is_alphanumeric() || matches!(character, '_' | '.' | '-'))
        })
        .map(str::trim)
        .filter(|term| term.chars().count() >= 2)
        .map(|term| term.to_lowercase())
        .filter(|term| seen.insert(term.clone()))
        .collect()
}

fn redact_sensitive_lines(content: &str) -> (String, usize) {
    let mut count = 0usize;
    let mut in_private_key = false;
    let mut indented_secret: Option<usize> = None;
    let mut delimited_secret: Option<&'static str> = None;
    let mut lines = Vec::new();

    for line in content.lines() {
        if let Some(delimiter) = delimited_secret {
            count += 1;
            lines.push("[REDACTED]".to_string());
            if has_unescaped_delimiter(line, delimiter) {
                delimited_secret = None;
            }
            continue;
        }

        if let Some(base_indent) = indented_secret {
            if line.trim().is_empty() || leading_whitespace_width(line) > base_indent {
                count += 1;
                lines.push("[REDACTED]".to_string());
                continue;
            }
            indented_secret = None;
        }

        let private_key_begin = is_private_key_boundary(line, "BEGIN");
        let private_key_end = is_private_key_boundary(line, "END");
        let continuation = sensitive_assignment_continuation(line);
        let sensitive = in_private_key
            || private_key_begin
            || contains_known_secret_pattern(line)
            || contains_jwt(line)
            || contains_credential_dsn(line)
            || contains_authorization_credential(line)
            || contains_sensitive_assignment(line)
            || continuation.is_some()
            || contains_high_entropy_literal(line)
            || contains_standalone_high_entropy(line);

        if private_key_begin {
            in_private_key = !private_key_end;
        } else if in_private_key && private_key_end {
            in_private_key = false;
        }

        if sensitive {
            count += 1;
            lines.push("[REDACTED]".to_string());
            match continuation {
                Some(SensitiveContinuation::Indented(indent)) => indented_secret = Some(indent),
                Some(SensitiveContinuation::Delimited(delimiter)) => {
                    delimited_secret = Some(delimiter)
                }
                None => {}
            }
        } else {
            lines.push(line.to_string());
        }
    }

    (lines.join("\n"), count)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SensitiveContinuation {
    Indented(usize),
    Delimited(&'static str),
}

fn sensitive_assignment_continuation(line: &str) -> Option<SensitiveContinuation> {
    let (left, value) = assignment_parts(line)?;
    if !left_contains_sensitive_key(left) {
        return None;
    }

    let value = value.trim();
    if value.is_empty()
        || value.strip_prefix(['|', '>']).is_some_and(|suffix| {
            suffix.is_empty()
                || suffix
                    .chars()
                    .all(|value| matches!(value, '+' | '-' | '0'..='9'))
        })
    {
        return Some(SensitiveContinuation::Indented(leading_whitespace_width(
            line,
        )));
    }

    for delimiter in ["\"\"\"", "'''", "`", "\"", "'"] {
        let Some(remainder) = value.strip_prefix(delimiter) else {
            continue;
        };
        if !has_unescaped_delimiter(remainder, delimiter) {
            return Some(SensitiveContinuation::Delimited(delimiter));
        }
    }

    None
}

fn has_unescaped_delimiter(value: &str, delimiter: &str) -> bool {
    let mut offset = 0usize;
    while let Some(found) = value[offset..].find(delimiter) {
        let index = offset + found;
        let preceding_slashes = value[..index]
            .bytes()
            .rev()
            .take_while(|byte| *byte == b'\\')
            .count();
        if preceding_slashes % 2 == 0 {
            return true;
        }
        offset = index + delimiter.len();
    }
    false
}

fn leading_whitespace_width(line: &str) -> usize {
    line.chars()
        .take_while(|character| character.is_whitespace())
        .map(|character| if character == '\t' { 4 } else { 1 })
        .sum()
}

fn is_private_key_boundary(line: &str, boundary: &str) -> bool {
    let upper = line.to_ascii_uppercase();
    upper.contains(&format!("-----{boundary} "))
        && (upper.contains("PRIVATE KEY") || upper.contains("PRIVATE KEY BLOCK"))
}

fn contains_known_secret_pattern(line: &str) -> bool {
    const PREFIXED_TOKENS: &[(&str, usize)] = &[
        ("ghp_", 30),
        ("gho_", 30),
        ("ghu_", 30),
        ("ghs_", 30),
        ("ghr_", 30),
        ("github_pat_", 20),
        ("glpat-", 20),
        ("xoxb-", 20),
        ("xoxp-", 20),
        ("xoxa-", 20),
        ("xoxr-", 20),
        ("sk_live_", 16),
        ("rk_live_", 16),
        ("whsec_", 16),
        ("sk-ant-", 20),
        ("sk-proj-", 20),
        ("gsk_", 20),
        ("hf_", 20),
        ("npm_", 20),
        ("pypi-", 30),
        ("AIza", 30),
        ("SG.", 30),
    ];

    PREFIXED_TOKENS
        .iter()
        .any(|(prefix, minimum_tail)| has_prefixed_token(line, prefix, *minimum_tail))
        || ["AKIA", "ASIA"]
            .iter()
            .any(|prefix| has_fixed_access_key(line, prefix))
        || contains_signed_query_parameter(line)
}

fn has_prefixed_token(line: &str, prefix: &str, minimum_tail: usize) -> bool {
    let mut offset = 0usize;
    while let Some(found) = line[offset..].find(prefix) {
        let start = offset + found;
        let before_is_token = start > 0 && line.as_bytes()[start - 1].is_ascii_alphanumeric();
        let tail = &line[start + prefix.len()..];
        let tail_len = tail
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
            .count();
        if !before_is_token && tail_len >= minimum_tail {
            return true;
        }
        offset = start + prefix.len();
    }
    false
}

fn has_fixed_access_key(line: &str, prefix: &str) -> bool {
    let mut offset = 0usize;
    while let Some(found) = line[offset..].find(prefix) {
        let start = offset + found;
        let end = start + prefix.len() + 16;
        let before_is_token = start > 0 && line.as_bytes()[start - 1].is_ascii_alphanumeric();
        if end <= line.len()
            && !before_is_token
            && line.as_bytes()[start + prefix.len()..end]
                .iter()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
            && line
                .as_bytes()
                .get(end)
                .is_none_or(|byte| !byte.is_ascii_alphanumeric())
        {
            return true;
        }
        offset = start + prefix.len();
    }
    false
}

fn contains_signed_query_parameter(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    [
        "x-amz-signature=",
        "x-goog-signature=",
        "sig=",
        "signature=",
    ]
    .iter()
    .any(|needle| {
        lower.find(needle).is_some_and(|start| {
            let value = &line[start + needle.len()..];
            value
                .bytes()
                .take_while(|byte| {
                    byte.is_ascii_alphanumeric()
                        || matches!(byte, b'_' | b'-' | b'+' | b'/' | b'=' | b'%')
                })
                .count()
                >= 20
        })
    })
}

fn contains_jwt(line: &str) -> bool {
    line.split(|character: char| {
        !(character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
    })
    .any(is_jwt)
}

fn is_jwt(candidate: &str) -> bool {
    if candidate.len() < 40 || candidate.len() > 8_192 {
        return false;
    }
    let mut parts = candidate.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if header.len() < 8 || payload.len() < 8 || signature.len() < 8 {
        return false;
    }
    if ![header, payload, signature].iter().all(|part| {
        part.bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    }) {
        return false;
    }
    let Ok(decoded_header) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(header) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&decoded_header)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .is_some_and(|header| header.contains_key("alg") || header.contains_key("typ"))
}

fn contains_credential_dsn(line: &str) -> bool {
    let mut offset = 0usize;
    while let Some(found) = line[offset..].find("://") {
        let authority_start = offset + found + 3;
        let authority = line[authority_start..]
            .split(|character: char| {
                character.is_whitespace() || matches!(character, '/' | '?' | '#' | '"' | '\'')
            })
            .next()
            .unwrap_or_default();
        if let Some((userinfo, _host)) = authority.rsplit_once('@') {
            if let Some((_username, password)) = userinfo.split_once(':') {
                if !password.is_empty() && !is_placeholder(password) {
                    return true;
                }
            }
        }
        offset = authority_start;
    }
    false
}

fn contains_authorization_credential(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    ["bearer ", "basic "].iter().any(|needle| {
        lower.find(needle).is_some_and(|start| {
            let value = line[start + needle.len()..]
                .trim_start()
                .trim_matches(|character: char| matches!(character, '"' | '\'' | '`'));
            let candidate: String = value
                .chars()
                .take_while(|character| {
                    character.is_ascii_alphanumeric()
                        || matches!(character, '_' | '-' | '.' | '+' | '/' | '=')
                })
                .collect();
            if candidate.contains("${") || is_placeholder(&candidate) {
                return false;
            }
            if *needle == "basic " {
                return base64::engine::general_purpose::STANDARD
                    .decode(candidate)
                    .ok()
                    .is_some_and(|decoded| {
                        decoded
                            .iter()
                            .position(|byte| *byte == b':')
                            .is_some_and(|separator| separator + 1 < decoded.len())
                    });
            }
            candidate.len() >= 20
        })
    })
}

fn contains_sensitive_assignment(line: &str) -> bool {
    let Some((left, value)) = assignment_parts(line) else {
        return false;
    };
    if !left_contains_sensitive_key(left) || is_safe_assignment_value(value) {
        return false;
    }
    true
}

fn assignment_parts(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'=' {
            continue;
        }
        let previous = index
            .checked_sub(1)
            .and_then(|position| bytes.get(position));
        let next = bytes.get(index + 1);
        if matches!(previous, Some(b'=' | b'!' | b'<' | b'>')) || next == Some(&b'=') {
            continue;
        }
        let value_start = index + usize::from(next == Some(&b'>')) + 1;
        return Some((&line[..index], &line[value_start..]));
    }

    for (index, character) in line.char_indices() {
        if character != ':' {
            continue;
        }
        let previous = index
            .checked_sub(1)
            .and_then(|position| bytes.get(position));
        let next = bytes.get(index + 1);
        if previous == Some(&b':') || next == Some(&b':') || next == Some(&b'/') {
            continue;
        }
        return Some((&line[..index], &line[index + 1..]));
    }
    None
}

fn left_contains_sensitive_key(left: &str) -> bool {
    left.split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .filter(|identifier| !identifier.is_empty())
        .rev()
        .take(8)
        .any(is_sensitive_key)
}

fn is_sensitive_key(identifier: &str) -> bool {
    let lower = identifier.to_ascii_lowercase();
    let compact: String = lower
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect();
    matches!(
        lower.as_str(),
        "key"
            | "token"
            | "secret"
            | "password"
            | "passwd"
            | "passphrase"
            | "pwd"
            | "credential"
            | "credentials"
            | "dsn"
            | "api_key"
            | "access_key"
            | "private_key"
            | "signing_key"
            | "encryption_key"
            | "auth_token"
            | "access_token"
            | "refresh_token"
            | "client_secret"
            | "database_url"
            | "connection_string"
    ) || compact.ends_with("token")
        || compact.ends_with("secret")
        || compact.ends_with("password")
        || compact.ends_with("passwd")
        || [
            "apikey",
            "accesskey",
            "privatekey",
            "signingkey",
            "encryptionkey",
            "authkey",
        ]
        .iter()
        .any(|suffix| compact.ends_with(suffix))
}

fn is_safe_assignment_value(value: &str) -> bool {
    let value = value.trim().trim_end_matches([',', ';']);
    if value.is_empty() || value == "[REDACTED]" {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "null"
            | "none"
            | "nil"
            | "undefined"
            | "true"
            | "false"
            | "string"
            | "str"
            | "bool"
            | "boolean"
            | "number"
            | "usize"
            | "u64"
            | "i64"
            | "{}"
            | "[]"
    ) || lower.starts_with("option<")
        || lower.starts_with("optional<")
    {
        return true;
    }

    let reference = lower.contains("process.env.")
        || lower.contains("import.meta.env.")
        || lower.contains("std::env::var(")
        || lower.contains("getenv(")
        || (lower.contains("env(") && !lower.contains(','))
        || (value.starts_with("${") && value.ends_with('}'))
        || (value.starts_with('$') && !value.contains(['\'', '"', '`']))
        || (!value.contains(['\'', '"', '`'])
            && (value.contains("->") || value.contains('.') || value.ends_with(')')));
    reference && !contains_known_secret_pattern(value) && !contains_high_entropy_literal(value)
}

fn is_placeholder(value: &str) -> bool {
    let lower = value
        .trim_matches(|character: char| {
            matches!(character, '"' | '\'' | '`' | '<' | '>' | '[' | ']')
        })
        .to_ascii_lowercase();
    lower.is_empty()
        || lower.contains("placeholder")
        || lower.contains("your-api-key")
        || lower.contains("your_api_key")
        || lower.contains("example")
        || lower == "changeme"
        || lower == "redacted"
        || lower
            .chars()
            .all(|character| matches!(character, '*' | 'x'))
}

fn contains_high_entropy_literal(line: &str) -> bool {
    let bytes = line.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        let quote = bytes[index];
        if !matches!(quote, b'\'' | b'"' | b'`') {
            index += 1;
            continue;
        }
        let start = index + 1;
        index = start;
        while index < bytes.len() {
            if bytes[index] == quote && (index == start || bytes[index - 1] != b'\\') {
                if looks_high_entropy(&line[start..index]) {
                    return true;
                }
                index += 1;
                break;
            }
            index += 1;
        }
    }
    false
}

fn contains_standalone_high_entropy(line: &str) -> bool {
    let mut candidate = line.trim();
    if let Some(item) = candidate.strip_prefix("- ") {
        candidate = item.trim();
    }
    candidate = candidate.trim_end_matches([',', ';']);

    !candidate.chars().any(char::is_whitespace) && looks_high_entropy(candidate)
}

fn looks_high_entropy(candidate: &str) -> bool {
    let candidate = candidate.trim();
    if candidate.len() < 40
        || candidate.len() > 512
        || candidate.contains("://")
        || candidate.contains("${")
        || is_placeholder(candidate)
        || !candidate.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'+' | b'/' | b'=' | b'.')
        })
    {
        return false;
    }
    let compact: Vec<u8> = candidate
        .bytes()
        .filter(|byte| !matches!(byte, b'-' | b'.'))
        .collect();
    if compact.iter().all(|byte| byte.is_ascii_hexdigit()) {
        return false;
    }
    let has_lower = candidate.bytes().any(|byte| byte.is_ascii_lowercase());
    let has_upper = candidate.bytes().any(|byte| byte.is_ascii_uppercase());
    let has_digit = candidate.bytes().any(|byte| byte.is_ascii_digit());
    if !(has_lower && has_upper && has_digit) {
        return false;
    }

    let mut frequencies = [0usize; 128];
    for byte in candidate.bytes() {
        frequencies[byte as usize] += 1;
    }
    let distinct = frequencies.iter().filter(|count| **count > 0).count();
    if distinct < 16 {
        return false;
    }
    let length = candidate.len() as f64;
    let entropy = frequencies
        .iter()
        .filter(|count| **count > 0)
        .map(|count| {
            let probability = *count as f64 / length;
            -probability * probability.log2()
        })
        .sum::<f64>();
    entropy >= 4.3
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn system_time_secs(value: SystemTime) -> Option<i64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs() as i64)
}

fn db_error(error: rusqlite::Error) -> String {
    format!("Local repository database error: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTRACT_COMMIT_A: &str = "1111111111111111111111111111111111111111";
    const CONTRACT_COMMIT_B: &str = "2222222222222222222222222222222222222222";

    #[test]
    #[ignore = "Requires the managed LSP runtime; run build-lsp-runtime.mjs first"]
    fn real_lsp_enrichment_is_hash_checked_cached_and_cancellable() {
        struct LspDatabase(PathBuf);
        impl GraphDatabaseProvider for LspDatabase {
            fn graph_database_path(&self) -> Result<PathBuf, String> {
                Ok(self.0.clone())
            }
            fn lsp_runtime_root(&self) -> Option<PathBuf> {
                Some(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../.lmzdev/artifacts/runtime/repository-lsp"),
                )
            }
        }
        let harness = GraphContractHarness::new();
        harness.seed_repository();
        fs::write(
            harness.repository.join("math.ts"),
            "export function add(a: number, b: number) { return a + b }\n",
        )
        .unwrap();
        fs::write(
            harness.repository.join("main.ts"),
            "import { add } from './math';\nexport const result = add(1, 2);\n",
        )
        .unwrap();
        let db = LspDatabase(harness.database.path.clone());
        let principal = "account:lsp-contract";
        let project = "lsp-contract";
        bind_repository(
            &db,
            principal,
            project,
            &harness.repository.to_string_lossy(),
        )
        .unwrap();
        index_repository(&db, principal, project).unwrap();
        let status = graph_status(&db, principal, project).unwrap();
        let lsp = status.lsp.unwrap();
        assert_eq!(lsp.status, "ready");
        assert!(lsp.edges >= 1);
        let connection = open_database(&db).unwrap();
        let bound = load_binding(&connection, principal, project).unwrap();
        let relations = lsp::relations(&connection, &bound, "main.ts").unwrap();
        assert!(
            relations.iter().any(|r| r.contains("math.ts:1 (add)")),
            "{relations:?}"
        );
        index_repository(&db, principal, project).unwrap();
        assert_eq!(
            graph_status(&db, principal, project)
                .unwrap()
                .lsp
                .unwrap()
                .edges,
            lsp.edges
        );
        fs::write(
            harness.repository.join("math.ts"),
            "export const unrelated = 1;\n",
        )
        .unwrap();
        assert!(lsp::relations(&connection, &bound, "main.ts")
            .unwrap()
            .is_empty());
        let cancelled = AtomicBool::new(true);
        assert!(index_repository_cancellable(&db, principal, project, Some(&cancelled)).is_err());
        let interrupt = Arc::new(AtomicBool::new(false));
        let trigger = interrupt.clone();
        let interrupter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            trigger.store(true, Ordering::Release);
        });
        let interrupted_at = Instant::now();
        assert!(index_repository_cancellable(&db, principal, project, Some(&interrupt)).is_err());
        interrupter.join().unwrap();
        assert!(interrupted_at.elapsed() < Duration::from_secs(6));
        assert_eq!(
            lsp::state(&connection, principal, &bound.repository_id)
                .unwrap()
                .edges,
            lsp.edges
        );
        index_repository(&db, principal, project).unwrap();
        assert!(lsp::relations(&connection, &bound, "main.ts")
            .unwrap()
            .is_empty());
        let snapshots = harness.base.join("lsp-snapshots");
        assert_eq!(fs::read_dir(snapshots).unwrap().count(), 0);
    }

    struct GraphContractHarness {
        database: TestGraphDatabase,
        base: PathBuf,
        repository: PathBuf,
        outside: PathBuf,
    }

    #[test]
    fn graph_inspector_is_bounded_scoped_and_metadata_only() {
        let harness = GraphContractHarness::new();
        harness.seed_repository();
        bind_repository(
            harness.database(),
            "account:inspector",
            "project",
            &harness.repository.to_string_lossy(),
        )
        .unwrap();
        index_repository(harness.database(), "account:inspector", "project").unwrap();
        let page =
            inspect_graph(harness.database(), "account:inspector", "project", "", 0).unwrap();
        assert!(page.total >= 2);
        assert!(page.files.len() <= 40);
        assert!(page
            .files
            .iter()
            .all(|file| file.symbols.len() <= 12 && file.relations.len() <= 12));
        let serialized = serde_json::to_string(&page).unwrap();
        assert!(!serialized.contains("contract-secret-never-egress"));
        assert!(!serialized.contains("content_hash"));
        assert!(inspect_graph(harness.database(), "account:other", "project", "", 0).is_err());
        let filtered = inspect_graph(
            harness.database(),
            "account:inspector",
            "project",
            "helper.ts",
            0,
        )
        .unwrap();
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.files[0].path, "src/helper.ts");
        assert!(
            inspect_graph(harness.database(), "account:inspector", "project", "", 100)
                .unwrap()
                .files
                .is_empty()
        );
        assert!(inspect_graph(
            harness.database(),
            "account:inspector",
            "project",
            &"x".repeat(257),
            0
        )
        .is_err());
    }

    impl GraphContractHarness {
        fn new() -> Self {
            let nonce = Uuid::new_v4().simple().to_string();
            let base = std::env::temp_dir().join(format!("luczor-graph-contract-{nonce}"));
            let repository = base.join("repository");
            let outside = base.join("outside");
            fs::create_dir_all(&repository).expect("create contract repository");
            fs::create_dir_all(&outside).expect("create outside fixture");

            Self {
                database: TestGraphDatabase {
                    path: base.join("local-context.sqlite3"),
                },
                base,
                repository,
                outside,
            }
        }

        fn database(&self) -> &TestGraphDatabase {
            &self.database
        }

        fn seed_repository(&self) -> (String, bool) {
            let git = self.repository.join(".git");
            fs::create_dir_all(git.join("refs/heads")).expect("create git refs");
            fs::write(git.join("HEAD"), "ref: refs/heads/main\n").expect("write git HEAD");
            fs::write(
                git.join("refs/heads/main"),
                format!("{CONTRACT_COMMIT_A}\n"),
            )
            .expect("write git branch");
            fs::write(self.repository.join(".gitignore"), "ignored/\n").expect("write gitignore");
            fs::write(self.repository.join(".luczorignore"), "private-note.md\n")
                .expect("write luczorignore");

            fs::create_dir_all(self.repository.join("src")).expect("create source directory");
            let memory_source = concat!(
                "pub struct MemoryOrchestrator;\n",
                "impl MemoryOrchestrator {\n",
                "    pub fn recall(&self) -> &'static str { \"local-only\" }\n",
                "}\n",
                "// API_KEY=contract-secret-never-egress\n"
            )
            .to_string();
            fs::write(self.repository.join("src/memory.rs"), &memory_source)
                .expect("write indexed Rust source");
            fs::write(
                self.repository.join("src/helper.ts"),
                "import { recall } from './memory';\nexport function helper() { return recall(); }\n",
            )
            .expect("write indexed TypeScript source");

            fs::create_dir_all(self.repository.join("ignored")).expect("create ignored directory");
            fs::write(
                self.repository.join("ignored/ignored.rs"),
                "pub struct IgnoredNeedle;\n",
            )
            .expect("write ignored source");
            fs::write(
                self.repository.join("private-note.md"),
                "LuczorIgnoreNeedle must never be indexed.\n",
            )
            .expect("write custom ignored source");
            fs::write(
                self.repository.join("credentials.json"),
                "{\"SecretFileNeedle\":\"must-never-be-indexed\"}\n",
            )
            .expect("write sensitive fixture");
            fs::write(
                self.outside.join("outside.rs"),
                "pub struct OutsideSymlinkNeedle;\n",
            )
            .expect("write outside fixture");
            let symlink_created = create_contract_symlink(
                &self.outside.join("outside.rs"),
                &self.repository.join("src/outside-link.rs"),
            )
            .is_ok();

            (memory_source, symlink_created)
        }
    }

    impl Drop for GraphContractHarness {
        fn drop(&mut self) {
            let base_name = self
                .base
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if base_name.starts_with("luczor-graph-contract-") {
                let _ = fs::remove_dir_all(&self.base);
            }
        }
    }

    #[cfg(unix)]
    fn create_contract_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_contract_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[test]
    fn schema_supports_fts_and_foreign_keys() {
        let connection = Connection::open_in_memory().expect("sqlite");
        initialize_schema(&connection).expect("schema");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'repository_search'",
                [],
                |row| row.get(0),
            )
            .expect("fts table");
        assert_eq!(count, 1);
        let content_column: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('repository_search') WHERE name = 'content'",
                [],
                |row| row.get(0),
            )
            .expect("content column");
        assert_eq!(content_column, 1);
        let principal_column: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('repository_search') WHERE name = 'principal_id'",
                [],
                |row| row.get(0),
            )
            .expect("principal column");
        assert_eq!(principal_column, 1);
        let binding_primary_key: Vec<(String, i64)> =
            table_columns(&connection, "repository_bindings")
                .expect("binding columns")
                .into_iter()
                .filter(|(_, primary_key)| *primary_key > 0)
                .collect();
        assert_eq!(
            binding_primary_key,
            vec![("principal_id".into(), 1), ("project_id".into(), 2)]
        );
    }

    #[test]
    fn old_local_fts_schema_is_rebuilt_as_a_disposable_index() {
        let connection = Connection::open_in_memory().expect("sqlite");
        connection
            .execute_batch(
                "CREATE VIRTUAL TABLE repository_search USING fts5(
                    repository_id UNINDEXED,
                    evidence_id UNINDEXED,
                    relative_path,
                    symbols,
                    imports
                 );",
            )
            .expect("legacy schema");

        initialize_schema(&connection).expect("schema migration");

        let content_column: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('repository_search') WHERE name = 'content'",
                [],
                |row| row.get(0),
            )
            .expect("content column");
        assert_eq!(content_column, 1);
        assert!(table_columns(&connection, "repository_search")
            .expect("search columns")
            .iter()
            .any(|(name, _)| name == "principal_id"));
    }

    #[test]
    fn legacy_unscoped_bindings_are_quarantined_and_never_adopted() {
        let connection = Connection::open_in_memory().expect("sqlite");
        connection
            .execute_batch(
                "CREATE TABLE repository_bindings (
                    project_id TEXT PRIMARY KEY,
                    repository_id TEXT NOT NULL UNIQUE,
                    root_path TEXT NOT NULL
                 );
                 CREATE TABLE repository_files (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    repository_id TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    evidence_id TEXT NOT NULL UNIQUE,
                    language TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    FOREIGN KEY(repository_id) REFERENCES repository_bindings(repository_id) ON DELETE CASCADE
                 );
                 CREATE TABLE repository_symbols (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    FOREIGN KEY(file_id) REFERENCES repository_files(id) ON DELETE CASCADE
                 );
                 CREATE TABLE repository_edges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_id INTEGER NOT NULL,
                    edge_kind TEXT NOT NULL,
                    target TEXT NOT NULL,
                    FOREIGN KEY(file_id) REFERENCES repository_files(id) ON DELETE CASCADE
                 );
                 CREATE TABLE repository_index_runs (
                    run_id TEXT PRIMARY KEY,
                    repository_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    started_at INTEGER NOT NULL
                 );
                 CREATE VIRTUAL TABLE repository_search USING fts5(
                    repository_id UNINDEXED,
                    evidence_id UNINDEXED,
                    relative_path,
                    symbols,
                    imports,
                    content
                 );
                 INSERT INTO repository_bindings (project_id, repository_id, root_path)
                 VALUES ('shared-project', 'legacy-repository', 'E:/private/legacy');
                 INSERT INTO repository_files
                    (repository_id, relative_path, evidence_id, language, content_hash, size_bytes)
                 VALUES ('legacy-repository', 'src/private.rs', 'legacy-evidence', 'rust', 'hash', 12);
                 INSERT INTO repository_search
                    (repository_id, evidence_id, relative_path, symbols, imports, content)
                 VALUES ('legacy-repository', 'legacy-evidence', 'src/private.rs', '', '', 'private content');",
            )
            .expect("legacy binding");

        initialize_schema(&connection).expect("principal migration");

        let active: i64 = connection
            .query_row("SELECT COUNT(*) FROM repository_bindings", [], |row| {
                row.get(0)
            })
            .expect("active bindings");
        let quarantined: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM repository_bindings_legacy_quarantine_v1",
                [],
                |row| row.get(0),
            )
            .expect("quarantined bindings");
        assert_eq!(active, 0);
        assert_eq!(quarantined, 1);
        assert!(load_binding(&connection, "account:new", "shared-project").is_err());
    }

    #[test]
    fn bindings_and_evidence_are_strictly_principal_scoped() {
        let mut connection = Connection::open_in_memory().expect("sqlite");
        initialize_schema(&connection).expect("schema");
        insert_test_binding(&connection, "account:alpha", "project-1", "repo-alpha");
        insert_test_binding(&connection, "account:beta", "project-1", "repo-beta");

        assert_eq!(
            load_binding(&connection, "account:alpha", "project-1")
                .expect("alpha binding")
                .repository_id,
            "repo-alpha"
        );
        assert_eq!(
            load_binding(&connection, "account:beta", "project-1")
                .expect("beta binding")
                .repository_id,
            "repo-beta"
        );

        let tx = connection.transaction().expect("transaction");
        replace_file(
            &tx,
            "account:alpha",
            "repo-alpha",
            "src/memory.rs",
            "rust",
            "content-hash",
            12,
            None,
            "memory controller",
            &ParsedFile {
                symbols: vec![],
                imports: vec![],
            },
        )
        .expect("indexed file");
        tx.commit().expect("commit");
        let evidence_id: String = connection
            .query_row(
                "SELECT evidence_id FROM repository_files
                 WHERE principal_id = 'account:alpha' AND repository_id = 'repo-alpha'",
                [],
                |row| row.get(0),
            )
            .expect("alpha evidence");
        let cross_principal_files: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM repository_files
                 WHERE principal_id = ?1 AND evidence_id = ?2",
                params!["account:beta", evidence_id],
                |row| row.get(0),
            )
            .expect("cross principal evidence lookup");
        let cross_principal_search: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM repository_search
                 WHERE repository_search MATCH 'memory' AND principal_id = 'account:beta'",
                [],
                |row| row.get(0),
            )
            .expect("cross principal full text lookup");
        assert_eq!(cross_principal_files, 0);
        assert_eq!(cross_principal_search, 0);
    }

    #[test]
    fn principal_ids_are_bounded_and_storage_safe() {
        assert!(validate_principal_id("account:0123abcd").is_ok());
        assert!(validate_principal_id("").is_err());
        assert!(validate_principal_id(" account:alpha").is_err());
        assert!(validate_principal_id("account:alpha/beta").is_err());
        assert!(validate_principal_id(&"a".repeat(201)).is_err());
    }

    #[test]
    fn php_and_typescript_symbols_are_parsed_deterministically() {
        let php = parse_tree(
            "<?php class MemoryController { public function remember() {} }",
            tree_sitter_php::LANGUAGE_PHP.into(),
            0,
        )
        .expect("php parse");
        assert!(php
            .symbols
            .iter()
            .any(|symbol| symbol.name == "MemoryController"));
        assert!(php.symbols.iter().any(|symbol| symbol.name == "remember"));

        let typescript = parse_tree(
            "export function recall() {} class MemoryRouter {}",
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            0,
        )
        .expect("typescript parse");
        assert!(typescript
            .symbols
            .iter()
            .any(|symbol| symbol.name == "recall"));
        assert!(typescript
            .symbols
            .iter()
            .any(|symbol| symbol.name == "MemoryRouter"));
    }

    #[test]
    fn secret_lines_are_redacted_before_snippet_delivery() {
        let (value, redactions) =
            redact_sensitive_lines("name=luczor\nAPI_KEY=secret\npassword: test");
        assert_eq!(redactions, 2);
        assert!(value.contains("name=luczor"));
        assert!(!value.contains("API_KEY=secret"));
    }

    #[test]
    fn query_snippet_reaches_late_symbol_and_preserves_line_numbers() {
        let content = format!(
            "{}\nexport function resumeAgent() {{\n  return 'bereit';\n}}\n",
            (1..=500)
                .map(|line| format!("// unrelated header {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        let (snippet, first, last) = focused_snippet(&content, Some("resumeAgent"), 400);
        assert_eq!(first, 497);
        assert!(snippet.contains("function resumeAgent()"));
        assert_eq!(last, first + snippet.lines().count() - 1);
        assert!(snippet.len() <= 400);
        assert_eq!(content.lines().nth(first - 1), snippet.lines().next());
    }

    #[test]
    fn query_snippet_keeps_redaction_and_utf8_budget_with_long_prefix_lines() {
        let content = format!(
            "{}\nfunction resumeAgent() {{\nAPI_KEY=secret\nreturn 'Grüße';\n}}",
            "界".repeat(800)
        );
        let (redacted, _) = redact_sensitive_lines(&content);
        let (snippet, first, _) = focused_snippet(&redacted, Some("resumeAgent"), 75);
        assert_eq!(first, 2);
        assert!(snippet.contains("resumeAgent"));
        assert!(snippet.contains("[REDACTED]"));
        assert!(!snippet.contains("secret"));
        assert!(snippet.len() <= 75);
    }

    #[test]
    fn query_snippet_without_query_retains_legacy_head_behavior() {
        let (snippet, first, last) = focused_snippet("first\nsecond\nthird", None, 12);
        assert_eq!(first, 1);
        assert_eq!(last, 2);
        assert_eq!(snippet, "first\nsecond");
    }

    #[test]
    fn provider_tokens_jwts_and_credential_dsns_are_redacted() {
        let content = concat!(
            "provider_value = \"ghp_1234567890abcdefghijklmnopqrstuvwxyz\"\n",
            "payload = \"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
            "eyJzdWIiOiIxMjM0NTY3ODkwIn0.AbcDefGhiJklMnoPqrStuVwxYz123456\"\n",
            "connection = \"postgres://luczor:s3cr3t@localhost/luczor\"\n",
            "aws_id = \"AKIA1234567890ABCDEF\"\n",
            "ordinary = \"https://example.test/repository\""
        );

        let (value, redactions) = redact_sensitive_lines(content);

        assert_eq!(redactions, 4);
        assert_eq!(
            value.lines().filter(|line| *line == "[REDACTED]").count(),
            4
        );
        assert!(value.contains("ordinary = \"https://example.test/repository\""));
        assert!(!value.contains("ghp_"));
        assert!(!value.contains("postgres://"));
    }

    #[test]
    fn private_key_blocks_are_redacted_without_hiding_surrounding_code() {
        let content = concat!(
            "before = true\n",
            "-----BEGIN OPENSSH PRIVATE KEY-----\n",
            "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n",
            "-----END OPENSSH PRIVATE KEY-----\n",
            "after = true"
        );

        let (value, redactions) = redact_sensitive_lines(content);

        assert_eq!(redactions, 3);
        assert!(value.starts_with("before = true\n"));
        assert!(value.ends_with("\nafter = true"));
        assert!(!value.contains("b3BlbnNzaC1rZXkt"));
    }

    #[test]
    fn generic_secret_assignments_are_redacted_but_references_and_types_remain() {
        let content = concat!(
            "const API_KEY = \"short-but-private\";\n",
            "\"refreshToken\": \"short-session-value\",\n",
            "password: string;\n",
            "const token = process.env.ACCESS_TOKEN;\n",
            "const keyboard = \"compact\";"
        );

        let (value, redactions) = redact_sensitive_lines(content);

        assert_eq!(redactions, 2);
        assert!(value.contains("password: string;"));
        assert!(value.contains("const token = process.env.ACCESS_TOKEN;"));
        assert!(value.contains("const keyboard = \"compact\";"));
        assert!(!value.contains("short-but-private"));
        assert!(!value.contains("short-session-value"));
    }

    #[test]
    fn authorization_headers_and_high_entropy_literals_are_redacted_cautiously() {
        let content = concat!(
            "Authorization: Basic dXNlcjpzM2NyM3Q=\n",
            "const opaque = \"aZ9bY8cX7dW6eV5fU4gT3hS2iR1jQ0kP9lO8mN7nM6oL5pK4qJ3rI2sH1tG0\";\n",
            "const checksum = \"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\";\n",
            "const requestId = \"123e4567-e89b-12d3-a456-426614174000\";"
        );

        let (value, redactions) = redact_sensitive_lines(content);

        assert_eq!(redactions, 2);
        assert!(value.contains("const checksum ="));
        assert!(value.contains("const requestId ="));
        assert!(!value.contains("dXNlcjpzM2NyM3Q="));
        assert!(!value.contains("aZ9bY8cX7dW6"));
    }

    #[test]
    fn multiline_and_standalone_secrets_are_redacted_until_their_boundary() {
        let token = "aZ9bY8cX7dW6eV5fU4gT3hS2iR1jQ0kP9lO8mN7nM6oL5pK4qJ3rI2sH1tG0";
        let content = format!(
            "api_key: |\n  {token}\n  secondSecretLine42ABCdefGHIjklMNOpqrSTUvwxYZ0123456789\nnext: safe\nconst token = `{token}\ncontinuedSecretABCdef1234567890`;\nafter = true\n{token}\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        );

        let (value, redactions) = redact_sensitive_lines(&content);

        assert_eq!(redactions, 6);
        assert!(value.contains("next: safe"));
        assert!(value.contains("after = true"));
        assert!(value.contains("0123456789abcdef0123456789abcdef"));
        assert!(!value.contains(token));
        assert!(!value.contains("secondSecretLine"));
        assert!(!value.contains("continuedSecret"));
    }

    #[test]
    fn sensitive_repository_files_and_key_directories_are_excluded() {
        assert!(is_secret_file(Path::new("repo/.aws/credentials")));
        assert!(is_secret_file(Path::new("repo/keys/id_ecdsa.bak")));
        assert!(is_secret_file(Path::new(
            "repo/config/client_secret_desktop.json"
        )));
        assert!(is_secret_file(Path::new(
            "repo/infra/production.auto.tfvars"
        )));
        assert!(is_secret_file(Path::new("repo/vpn/developer.ovpn")));
        assert!(!is_secret_file(Path::new("repo/src/client.rs")));
        assert!(!is_secret_file(Path::new("repo/keys/id_ed25519.pub")));
    }

    #[test]
    fn search_terms_are_bounded_and_syntax_free() {
        assert_eq!(
            query_terms("MemoryController::remember() OR token"),
            vec!["memorycontroller", "remember", "or", "token"]
        );
    }

    #[test]
    fn real_local_repository_contract_is_isolated_hash_checked_and_egress_free() {
        let harness = GraphContractHarness::new();
        let (memory_source, symlink_created) = harness.seed_repository();
        let app = harness.database();
        let root = harness
            .repository
            .canonicalize()
            .expect("canonical contract root");
        let root_text = root.to_string_lossy().to_string();
        let principal_alpha = "account:graph-alpha";
        let principal_beta = "account:graph-beta";
        let project = "project-contract";

        let alpha_binding = bind_repository(app, principal_alpha, project, &root_text)
            .expect("bind alpha repository");
        assert_eq!(alpha_binding.project_id, project);
        assert_eq!(alpha_binding.status, "unindexed");
        assert_eq!(alpha_binding.branch.as_deref(), Some("main"));
        assert_eq!(alpha_binding.commit_sha.as_deref(), Some(CONTRACT_COMMIT_A));
        assert_eq!(
            graph_status(app, principal_alpha, project)
                .expect("alpha pre-index status")
                .status,
            "unindexed"
        );
        assert_eq!(
            graph_status(app, principal_beta, project)
                .expect("cross-principal status")
                .status,
            "unbound"
        );
        assert_eq!(
            graph_status(app, principal_alpha, "other-project")
                .expect("cross-project status")
                .status,
            "unbound"
        );

        let alpha_index =
            index_repository(app, principal_alpha, project).expect("index alpha repository");
        assert_eq!(alpha_index.status, "ready");
        assert_eq!(alpha_index.files, 2);
        assert!(alpha_index.symbols >= 3);
        assert_eq!(alpha_index.branch.as_deref(), Some("main"));
        assert_eq!(alpha_index.commit_sha.as_deref(), Some(CONTRACT_COMMIT_A));

        let cancelled = AtomicBool::new(true);
        let result = index_repository_cancellable(app, principal_alpha, project, Some(&cancelled));
        assert!(result.unwrap_err().contains("paused for foreground"));
        let connection = open_database(app).expect("read cancelled index");
        let counts = repository_counts(&connection, principal_alpha, &alpha_binding.repository_id)
            .expect("existing index survived");
        assert_eq!(counts.0 as usize, alpha_index.files);
        index_repository(app, principal_alpha, project)
            .expect("resume indexing after cancellation");

        let alpha_status = graph_status(app, principal_alpha, project).expect("alpha ready status");
        assert_eq!(alpha_status.status, "ready");
        assert_eq!(alpha_status.files, 2);
        assert_eq!(alpha_status.commit_sha.as_deref(), Some(CONTRACT_COMMIT_A));

        let connection = open_database(app).expect("open contract graph database");
        let mut statement = connection
            .prepare(
                "SELECT relative_path FROM repository_files
                 WHERE principal_id = ?1 AND repository_id = ?2 ORDER BY relative_path",
            )
            .expect("prepare indexed-path query");
        let indexed_paths = statement
            .query_map(
                params![principal_alpha, alpha_binding.repository_id],
                |row| row.get::<_, String>(0),
            )
            .expect("query indexed paths")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect indexed paths");
        assert_eq!(indexed_paths, vec!["src/helper.ts", "src/memory.rs"]);
        assert!(!indexed_paths
            .iter()
            .any(|path| path.contains("outside-link")));
        drop(statement);
        drop(connection);

        let alpha_search =
            search_repository(app, principal_alpha, project, "MemoryOrchestrator", Some(8))
                .expect("search alpha graph");
        assert_eq!(alpha_search.hits.len(), 1);
        let alpha_hit = &alpha_search.hits[0];
        assert_eq!(alpha_hit.relative_path, "src/memory.rs");
        assert_eq!(alpha_hit.content_hash, sha256(memory_source.as_bytes()));
        assert!(alpha_hit
            .symbols
            .iter()
            .any(|symbol| symbol.name == "MemoryOrchestrator"));
        assert!(alpha_hit
            .reasons
            .iter()
            .any(|reason| reason == "symbol_exact"));

        for excluded_query in ["IgnoredNeedle", "LuczorIgnoreNeedle", "SecretFileNeedle"] {
            assert!(
                search_repository(app, principal_alpha, project, excluded_query, Some(8))
                    .expect("search excluded fixture")
                    .hits
                    .is_empty()
            );
        }
        if symlink_created {
            assert!(search_repository(
                app,
                principal_alpha,
                project,
                "OutsideSymlinkNeedle",
                Some(8)
            )
            .expect("search outside symlink fixture")
            .hits
            .is_empty());
        }

        let alpha_snippets = read_snippets(
            app,
            principal_alpha,
            project,
            vec![alpha_hit.evidence_id.clone()],
            Some(32 * 1024),
            None,
        )
        .expect("materialize alpha snippet");
        assert_eq!(alpha_snippets.snippets.len(), 1);
        assert!(alpha_snippets.omitted.is_empty());
        assert_eq!(
            alpha_snippets.snippets[0].content_hash,
            alpha_hit.content_hash
        );
        assert!(alpha_snippets.snippets[0].redactions >= 1);
        assert!(!alpha_snippets.snippets[0]
            .content
            .contains("contract-secret-never-egress"));

        let beta_binding = bind_repository(app, principal_beta, project, &root_text)
            .expect("bind beta repository");
        index_repository(app, principal_beta, project).expect("index beta repository");
        let beta_search =
            search_repository(app, principal_beta, project, "MemoryOrchestrator", Some(8))
                .expect("search beta graph");
        assert_eq!(beta_search.hits.len(), 1);
        assert_ne!(alpha_binding.repository_id, beta_binding.repository_id);
        assert_ne!(alpha_hit.evidence_id, beta_search.hits[0].evidence_id);
        assert!(search_repository(
            app,
            principal_alpha,
            "other-project",
            "MemoryOrchestrator",
            Some(8)
        )
        .is_err());

        fs::write(
            harness.repository.join("src/memory.rs"),
            format!("{memory_source}// changed after indexing\n"),
        )
        .expect("mutate indexed source");
        let stale_snippet = read_snippets(
            app,
            principal_alpha,
            project,
            vec![alpha_hit.evidence_id.clone()],
            Some(32 * 1024),
            Some("MemoryStore"),
        )
        .expect("check stale snippet hash");
        assert!(stale_snippet.snippets.is_empty());
        assert_eq!(stale_snippet.omitted.len(), 1);
        assert_eq!(stale_snippet.omitted[0].reason, "stale_hash");

        fs::write(
            harness.repository.join(".git/refs/heads/main"),
            format!("{CONTRACT_COMMIT_B}\n"),
        )
        .expect("advance contract Git ref");
        assert_eq!(
            graph_status(app, principal_alpha, project)
                .expect("alpha stale status")
                .status,
            "stale"
        );
        assert_eq!(
            graph_status(app, principal_beta, project)
                .expect("beta stale status")
                .status,
            "stale"
        );

        let provider_visible = serde_json::to_string(&(
            &alpha_binding,
            &alpha_index,
            &alpha_status,
            &alpha_search,
            &alpha_snippets,
        ))
        .expect("serialize graph contract responses");
        assert!(!provider_visible.contains(&root_text));
        assert!(!provider_visible.contains("contract-secret-never-egress"));
        assert!(!provider_visible.contains("OutsideSymlinkNeedle"));

        unbind_repository(app, principal_alpha, project, true).expect("unbind alpha graph");
        assert_eq!(
            graph_status(app, principal_alpha, project)
                .expect("alpha unbound status")
                .status,
            "unbound"
        );
        assert_eq!(
            graph_status(app, principal_beta, project)
                .expect("beta remains isolated")
                .status,
            "stale"
        );
        assert!(
            search_repository(app, principal_alpha, project, "MemoryOrchestrator", Some(8))
                .is_err()
        );

        let connection = open_database(app).expect("verify contract cleanup");
        let alpha_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM repository_files WHERE principal_id = ?1",
                [principal_alpha],
                |row| row.get(0),
            )
            .expect("count alpha files after unbind");
        let beta_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM repository_files WHERE principal_id = ?1",
                [principal_beta],
                |row| row.get(0),
            )
            .expect("count beta files after alpha unbind");
        assert_eq!(alpha_rows, 0);
        assert_eq!(beta_rows, 2);
    }

    fn insert_test_binding(
        connection: &Connection,
        principal_id: &str,
        project_id: &str,
        repository_id: &str,
    ) {
        connection
            .execute(
                "INSERT INTO repository_bindings
                    (principal_id, project_id, repository_id, root_path, display_name, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'E:/test', 'Test', 'ready', 1, 1)",
                params![principal_id, project_id, repository_id],
            )
            .expect("test binding");
    }
}
