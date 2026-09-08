//! Scoped metadata-only filesystem observation with durable, acknowledged events.
//! Restart and overflow reconcile the current scope; they never claim a complete offline history.
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ignore::overrides::{Override, OverrideBuilder};
use notify::{EventKind, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewWindow};

use super::ensure_main_webview;
use super::execution::{admit, Guarded};
use super::project_workspace::{agent_workspace_snapshot, is_secret_path};

static WATCHERS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
static WRITE_RECEIPTS: OnceLock<Mutex<HashMap<PathBuf, WriteReceipt>>> = OnceLock::new();
const MAX_PENDING: i64 = 500;

struct WriteReceipt {
    digest: String,
    origin: String,
    length: u64,
    modified: SystemTime,
    expires: Instant,
}

/** Called only after a successful native guarded write; no arbitrary watcher input claims causality. */
pub(crate) fn record_write(root: &Path, relative: &str, digest: &str, origin: &str) {
    if uuid::Uuid::parse_str(origin).is_err() {
        return;
    }
    let path = root.join(relative);
    let Ok(metadata) = path.metadata() else {
        return;
    };
    let Ok(modified) = metadata.modified() else {
        return;
    };
    if let Ok(mut receipts) = WRITE_RECEIPTS.get_or_init(Mutex::default).lock() {
        receipts.retain(|_, receipt| receipt.expires > Instant::now());
        if receipts.len() >= 512 {
            return;
        }
        receipts.insert(
            path,
            WriteReceipt {
                digest: digest.into(),
                origin: origin.into(),
                length: metadata.len(),
                modified,
                expires: Instant::now() + Duration::from_secs(30),
            },
        );
    }
}
fn origin_for(root: &Path, relative: &str) -> Option<String> {
    use std::io::Read;
    let path = root.join(relative);
    let receipts = WRITE_RECEIPTS.get_or_init(Mutex::default).lock().ok()?;
    let receipt = receipts.get(&path)?;
    let metadata = path.metadata().ok()?;
    if receipt.expires <= Instant::now()
        || metadata.len() != receipt.length
        || metadata.len() > 1_048_576
        || metadata.modified().ok()? != receipt.modified
    {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .ok()?
        .take(1_048_577)
        .read_to_end(&mut bytes)
        .ok()?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    (digest == receipt.digest).then(|| receipt.origin.clone())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchStart {
    scope: String,
    watcher_id: String,
    principal_id: String,
    project_id: String,
    expected_root_path: String,
    expected_workspace_updated_at: i64,
    paths: Vec<String>,
    #[serde(default)]
    excludes: Vec<String>,
    debounce_ms: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchScope {
    scope: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchAck {
    scope: String,
    event_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileChange {
    path: String,
    kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    id: String,
    watcher_id: String,
    root_path: String,
    changes: Vec<FileChange>,
    occurred_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin_run_id: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn validate_scope(scope: &str) -> Result<(), String> {
    if scope.len() != 64 || !scope.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid workflow watcher scope.".into());
    }
    Ok(())
}
fn open_outbox(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|_| "Workflow event outbox unavailable.")?;
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(|_| "Workflow event outbox busy.")?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS workflow_events (scope TEXT NOT NULL, id TEXT NOT NULL, watcher_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope,id));").map_err(|_| "Workflow event outbox initialization failed.")?;
    Ok(connection)
}
fn outbox_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "App data unavailable.")?
        .join("workflow-events");
    std::fs::create_dir_all(&directory).map_err(|_| "Workflow event directory unavailable.")?;
    Ok(directory.join("outbox.sqlite3"))
}
fn persist_event(path: &Path, scope: &str, mut event: WatchEvent) -> Result<(), String> {
    let mut connection = open_outbox(path)?;
    let transaction = connection
        .transaction()
        .map_err(|_| "Workflow event transaction failed.")?;
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM workflow_events WHERE scope=?1 AND watcher_id=?2",
            params![scope, event.watcher_id],
            |row| row.get(0),
        )
        .map_err(|_| "Workflow outbox count failed.")?;
    if count >= MAX_PENDING {
        transaction
            .execute(
                "DELETE FROM workflow_events WHERE scope=?1 AND watcher_id=?2",
                params![scope, event.watcher_id],
            )
            .map_err(|_| "Workflow outbox reconciliation failed.")?;
        event.changes = vec![FileChange {
            path: String::new(),
            kind: "rescan".into(),
        }];
        event.origin_run_id = None;
    }
    let payload = serde_json::to_string(&event).map_err(|_| "Workflow event encoding failed.")?;
    transaction
        .execute(
            "INSERT INTO workflow_events(scope,id,watcher_id,payload) VALUES (?1,?2,?3,?4)",
            params![scope, event.id, event.watcher_id, payload],
        )
        .map_err(|_| "Workflow event persistence failed.")?;
    transaction
        .commit()
        .map_err(|_| "Workflow event commit failed.".into())
}
fn compile_paths(root: &Path, paths: &[String]) -> Result<Override, String> {
    if paths.is_empty() || paths.len() > 32 {
        return Err("Watch one to 32 relative path patterns.".into());
    }
    let mut builder = OverrideBuilder::new(root);
    for pattern in paths {
        if pattern.is_empty()
            || pattern.len() > 300
            || pattern.starts_with(['/', '\\', '!'])
            || pattern.contains(':')
            || pattern.split(['/', '\\']).any(|part| part == "..")
        {
            return Err("Watch paths must stay relative to the workspace.".into());
        }
        builder
            .add(pattern)
            .map_err(|_| "Invalid workflow watch pattern.")?;
    }
    builder
        .build()
        .map_err(|_| "Invalid workflow watch patterns.".into())
}
fn metadata_path(root: &Path, candidate: &Path, filters: &Override) -> Option<String> {
    let relative = candidate.strip_prefix(root).ok()?;
    if relative.as_os_str().is_empty() || is_secret_path(relative) {
        return None;
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return None;
        };
        let lower = name.to_string_lossy().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            ".git"
                | "node_modules"
                | "vendor"
                | "target"
                | "dist"
                | "build"
                | ".cache"
                | ".lmzdev"
                | ".codex"
        ) {
            return None;
        }
        current.push(name);
        if let Ok(metadata) = std::fs::symlink_metadata(&current) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return None;
                }
            }
            #[cfg(not(windows))]
            if metadata.file_type().is_symlink() {
                return None;
            }
        }
    }
    if !filters
        .matched(candidate, candidate.is_dir())
        .is_whitelist()
    {
        return None;
    }
    let value = relative.to_str()?.replace('\\', "/");
    if value.len() > 600 || value.chars().any(char::is_control) {
        return None;
    }
    Some(value)
}
fn event(watcher: &str, root: &Path, changes: Vec<FileChange>) -> WatchEvent {
    WatchEvent {
        id: uuid::Uuid::new_v4().to_string(),
        watcher_id: watcher.into(),
        root_path: root.to_string_lossy().into_owned(),
        changes,
        occurred_at: now_ms(),
        origin_run_id: None,
    }
}

#[tauri::command]
pub fn wf_watch_start(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<WatchStart>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, true)?;
    let input = payload.request;
    validate_scope(&input.scope)?;
    uuid::Uuid::parse_str(&input.watcher_id).map_err(|_| "Invalid workflow watcher id.")?;
    let (root, revision) = agent_workspace_snapshot(&app, &input.principal_id, &input.project_id)?;
    if root != Path::new(&input.expected_root_path)
        || revision != input.expected_workspace_updated_at
    {
        return Err("The workflow watch workspace changed.".into());
    }
    let filters = compile_paths(&root, &input.paths)?;
    let excludes = if input.excludes.is_empty() {
        None
    } else {
        Some(compile_paths(&root, &input.excludes)?)
    };
    let outbox = outbox_path(&app)?;
    let key = format!("{}:{}", input.scope, input.watcher_id);
    let stopped = Arc::new(AtomicBool::new(false));
    let mut handles = WATCHERS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Workflow watchers unavailable.")?;
    if let Some(previous) = handles.remove(&key) {
        previous.store(true, Ordering::Relaxed);
    }
    if handles.len() >= 32 {
        return Err("Too many active workflow watchers.".into());
    }
    let (sender, receiver) = mpsc::sync_channel(1024);
    let overflow = Arc::new(AtomicBool::new(false));
    let callback_overflow = overflow.clone();
    let mut watcher = notify::recommended_watcher(move |result| {
        if sender.try_send(result).is_err() {
            callback_overflow.store(true, Ordering::Relaxed);
        }
    })
    .map_err(|_| "Native filesystem watcher unavailable.")?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|_| "The workspace cannot be watched.")?;
    gate.check()?;
    persist_event(
        &outbox,
        &input.scope,
        event(
            &input.watcher_id,
            &root,
            vec![FileChange {
                path: String::new(),
                kind: "rescan".into(),
            }],
        ),
    )?;
    handles.insert(key.clone(), stopped.clone());
    let debounce = Duration::from_millis(input.debounce_ms.unwrap_or(1000).clamp(250, 30000));
    std::thread::spawn(move || {
        let _watcher = watcher;
        let mut pending = BTreeMap::new();
        let mut last_event = Instant::now();
        while !stopped.load(Ordering::Relaxed) {
            if gate.check().is_err() {
                break;
            }
            let current = agent_workspace_snapshot(&app, &input.principal_id, &input.project_id);
            if !matches!(current, Ok((ref current_root, current_revision)) if current_root == &root && current_revision == revision)
            {
                break;
            }
            if overflow.swap(false, Ordering::Relaxed) {
                pending.clear();
                pending.insert(String::new(), "rescan".into());
            }
            match receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(Ok(change)) => {
                    let kind = match change.kind {
                        EventKind::Create(_) => "created",
                        EventKind::Modify(_) => "modified",
                        EventKind::Remove(_) => "deleted",
                        _ => continue,
                    };
                    for path in change.paths {
                        if excludes.as_ref().is_some_and(|filter| {
                            filter.matched(&path, path.is_dir()).is_whitelist()
                        }) {
                            continue;
                        }
                        if let Some(path) = metadata_path(&root, &path, &filters) {
                            pending.insert(path, kind.to_string());
                        }
                    }
                    last_event = Instant::now();
                }
                Ok(Err(_)) => {
                    pending.clear();
                    pending.insert(String::new(), "rescan".into());
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if pending.len() > 128 {
                pending.clear();
                pending.insert(String::new(), "rescan".into());
            }
            if !pending.is_empty() && last_event.elapsed() >= debounce {
                let mut groups: BTreeMap<Option<String>, Vec<FileChange>> = BTreeMap::new();
                for (path, kind) in &pending {
                    let origin = if kind == "rescan" || kind == "deleted" {
                        None
                    } else {
                        origin_for(&root, path)
                    };
                    groups.entry(origin).or_default().push(FileChange {
                        path: path.clone(),
                        kind: kind.clone(),
                    });
                }
                let mut failed = false;
                for (origin, changes) in groups {
                    let mut entry = event(&input.watcher_id, &root, changes);
                    entry.origin_run_id = origin;
                    if gate.check().is_err() || persist_event(&outbox, &input.scope, entry).is_err()
                    {
                        failed = true;
                        break;
                    }
                }
                if failed {
                    break;
                }
                pending.clear();
            }
        }
        if let Ok(mut handles) = WATCHERS.get_or_init(Mutex::default).lock() {
            if handles
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &stopped))
            {
                handles.remove(&key);
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn wf_watch_stop(window: WebviewWindow, payload: WatchScope) -> Result<(), String> {
    ensure_main_webview(&window)?;
    validate_scope(&payload.scope)?;
    let mut handles = WATCHERS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Workflow watchers unavailable.")?;
    handles.retain(|key, stopped| {
        if key.starts_with(&format!("{}:", payload.scope)) {
            stopped.store(true, Ordering::Relaxed);
            false
        } else {
            true
        }
    });
    Ok(())
}

#[tauri::command]
pub fn wf_watch_drain(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<WatchScope>,
) -> Result<Vec<WatchEvent>, String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, false)?;
    validate_scope(&payload.request.scope)?;
    let connection = open_outbox(&outbox_path(&app)?)?;
    let mut query = connection
        .prepare("SELECT payload FROM workflow_events WHERE scope=?1 ORDER BY rowid LIMIT 50")
        .map_err(|_| "Workflow event query failed.")?;
    let rows = query
        .query_map(params![payload.request.scope], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|_| "Workflow event read failed.")?;
    let mut events = Vec::new();
    for row in rows {
        events.push(
            serde_json::from_str(&row.map_err(|_| "Workflow event read failed.")?)
                .map_err(|_| "Workflow event is corrupt.")?,
        );
    }
    gate.check()?;
    Ok(events)
}

#[tauri::command]
pub fn wf_watch_ack(
    window: WebviewWindow,
    app: AppHandle,
    payload: Guarded<WatchAck>,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let gate = admit(&payload.execution, false)?;
    validate_scope(&payload.request.scope)?;
    if payload.request.event_ids.len() > 50 {
        return Err("Too many workflow event acknowledgments.".into());
    }
    let mut connection = open_outbox(&outbox_path(&app)?)?;
    let transaction = connection
        .transaction()
        .map_err(|_| "Workflow event transaction failed.")?;
    for id in payload.request.event_ids {
        gate.check()?;
        transaction
            .execute(
                "DELETE FROM workflow_events WHERE scope=?1 AND id=?2",
                params![payload.request.scope, id],
            )
            .map_err(|_| "Workflow event acknowledgment failed.")?;
    }
    transaction
        .commit()
        .map_err(|_| "Workflow event acknowledgment failed.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patterns_and_metadata_never_escape_or_include_secrets() {
        let root = std::env::temp_dir().join("luczor-watch-filter");
        let filters = compile_paths(&root, &["**/*".into()]).unwrap();
        assert!(metadata_path(&root, &root.join("src/app.ts"), &filters).is_some());
        for path in [
            ".env",
            "node_modules/lib.js",
            ".git/config",
            "keys/key.pem",
            "../outside",
        ] {
            assert!(
                metadata_path(&root, &root.join(path), &filters).is_none(),
                "{path}"
            );
        }
        assert!(compile_paths(&root, &["../*".into()]).is_err());
        assert!(compile_paths(&root, &["!**/*".into()]).is_err());
    }
    #[test]
    fn outbox_is_durable_and_scoped_without_file_contents() {
        let directory =
            std::env::temp_dir().join(format!("luczor-watch-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("outbox.sqlite3");
        let value = event(
            "watch",
            &directory,
            vec![FileChange {
                path: "src/app.ts".into(),
                kind: "modified".into(),
            }],
        );
        persist_event(&database, "account-a", value).unwrap();
        let connection = open_outbox(&database).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM workflow_events WHERE scope='account-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let other: i64 = connection
            .query_row(
                "SELECT count(*) FROM workflow_events WHERE scope='account-b'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(other, 0);
        drop(connection);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_notify_observes_a_real_temporary_file_write() {
        let root =
            std::env::temp_dir().join(format!("luczor-native-watch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let (sender, receiver) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .unwrap();
        watcher.watch(&root, RecursiveMode::Recursive).unwrap();
        std::fs::write(root.join("observed.txt"), "harmless watcher test").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut observed = false;
        while Instant::now() < deadline {
            if let Ok(Ok(event)) = receiver.recv_timeout(Duration::from_millis(250)) {
                if event
                    .paths
                    .iter()
                    .any(|path| path.file_name().is_some_and(|name| name == "observed.txt"))
                {
                    observed = true;
                    break;
                }
            }
        }
        drop(watcher);
        assert!(observed, "native filesystem notification missing");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn causal_receipts_require_the_exact_successful_write_state() {
        let root =
            std::env::temp_dir().join(format!("luczor-write-receipt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.txt"), "owned output").unwrap();
        let origin = uuid::Uuid::new_v4().to_string();
        record_write(
            &root,
            "note.txt",
            &format!("{:x}", Sha256::digest(b"owned output")),
            &origin,
        );
        assert_eq!(origin_for(&root, "note.txt"), Some(origin));
        std::fs::write(root.join("note.txt"), "unrelated output").unwrap();
        assert_eq!(origin_for(&root, "note.txt"), None);
        std::fs::remove_dir_all(root).unwrap();
    }
}
