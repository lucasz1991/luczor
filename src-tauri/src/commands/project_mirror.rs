//! Full workspace mirroring. This is deliberately separate from filtered AI context reads.
//! Chunks and manifests are owner scoped; symlinks are recorded, never traversed.
use super::{
    codex::acquire_workspace_lease,
    execution::{admit, Guarded},
    project_workspace::agent_workspace_snapshot,
};
use base64::Engine;
use notify::Watcher;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Emitter, Manager};

const CHUNK_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MirrorScope {
    principal_id: String,
    project_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Chunk {
    sha256: String,
    size: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryType {
    File,
    Directory,
    Symlink,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    path: String,
    #[serde(rename = "type")]
    kind: EntryType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(default)]
    chunks: Vec<Chunk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mtime_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    metadata: Option<serde_json::Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    manifest_hash: String,
    snapshot_id: String,
    total_entries: usize,
    entries: Vec<Entry>,
    workspace_updated_at: i64,
    chunk_bytes: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanPage {
    principal_id: String,
    project_id: String,
    snapshot_id: String,
    offset: usize,
    limit: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    snapshot_id: String,
    entries: Vec<Entry>,
    total_entries: usize,
    offset: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChunkRequest {
    principal_id: String,
    project_id: String,
    sha256: String,
    #[serde(default)]
    data_base64: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkReply {
    sha256: String,
    size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_base64: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Materialize {
    principal_id: String,
    project_id: String,
    expected_local_manifest_hash: String,
    entries: Vec<Entry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageBegin {
    principal_id: String,
    project_id: String,
    expected_local_manifest_hash: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagePage {
    principal_id: String,
    project_id: String,
    stage_id: String,
    offset: usize,
    entries: Vec<Entry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageCommit {
    principal_id: String,
    project_id: String,
    stage_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestWorkspace {
    principal_id: String,
    project_id: String,
    run_id: String,
    snapshot_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StageMetadata {
    principal_id: String,
    project_id: String,
    root: PathBuf,
    workspace_revision: i64,
    expected_local_manifest_hash: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workcopy {
    root_path: String,
    workspace_updated_at: i64,
    run_id: String,
    snapshot_id: String,
    manifest_hash: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    manifest_hash: String,
    source_manifest_hash: String,
    backup_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryRecord {
    schema_version: u8,
    root: PathBuf,
    stage: PathBuf,
    backup: PathBuf,
    manifest_hash: String,
    #[serde(default)]
    previous_manifest_hash: Option<String>,
    #[serde(default)]
    snapshot_id: Option<String>,
}

fn applied_metadata(cache: &Path) -> Result<Option<rusqlite::Connection>, String> {
    let marker = cache.join("applied-metadata.json");
    if !marker.exists() {
        return Ok(None);
    }
    let id: String = read_private_json(&marker)?;
    Ok(Some(snapshot_database(cache, &id, false)?))
}
fn persist_applied_metadata(cache: &Path, id: &str) -> Result<(), String> {
    snapshot_database(cache, id, false)?;
    let path = cache.join("applied-metadata.json");
    if fs::symlink_metadata(&path).is_ok_and(|m| is_link(&m)) {
        return Err("mirror_metadata_link_rejected".into());
    }
    let temp = cache.join(format!("metadata-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|_| "mirror_metadata_persist_failed")?;
    file.write_all(&serde_json::to_vec(id).map_err(|_| "mirror_metadata_invalid")?)
        .and_then(|_| file.sync_all())
        .map_err(|_| "mirror_metadata_persist_failed")?;
    drop(file);
    fs::rename(temp, path).map_err(|_| "mirror_metadata_persist_failed".into())
}
fn retain_foreign_metadata(
    entry: &mut Entry,
    db: Option<&rusqlite::Connection>,
) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let Some(db) = db else { return Ok(()) };
    let previous: Option<String> = db
        .query_row(
            "SELECT body FROM entries WHERE path=?1",
            [&entry.path],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "mirror_metadata_read_failed")?;
    let Some(previous) = previous else {
        return Ok(());
    };
    let previous: Entry = serde_json::from_str(&previous).map_err(|_| "mirror_metadata_invalid")?;
    if entry.kind == previous.kind {
        // A platform incapable of representing a field must not erase it on
        // the next upload. Content/mtime/size always come from the actual file.
        if entry.mode.is_none() {
            entry.mode = previous.mode;
        }
        if entry.metadata.is_none() && entry.target == previous.target {
            entry.metadata = previous.metadata;
        }
    }
    Ok(())
}

fn recover_transaction(
    cache: &Path,
    id: &str,
    root: &Path,
    check: &impl Fn() -> Result<(), String>,
) -> Result<serde_json::Value, String> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("mirror_recovery_identity_invalid".into());
    }
    let marker = cache.join(format!("transaction-{id}.json"));
    let record: RecoveryRecord = read_private_json(&marker)?;
    let parent = root
        .parent()
        .filter(|_| root.file_name().is_some())
        .ok_or("mirror_recovery_root_invalid")?;
    if record.schema_version != 1
        || record.root != root
        || record.stage != parent.join(format!(".luczor-stage-{id}"))
        || record.backup != parent.join(format!(".luczor-backup-{id}"))
        || !valid_hash(&record.manifest_hash)
        || record
            .previous_manifest_hash
            .as_ref()
            .is_some_and(|h| !valid_hash(h))
    {
        return Err("mirror_recovery_identity_invalid".into());
    }
    safe_directory(parent)?;
    let is_directory = |path: &Path| -> Result<bool, String> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => Ok(true),
            Ok(_) => Err("mirror_recovery_link_or_type_changed".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err("mirror_recovery_unavailable".into()),
        }
    };
    let state = (
        is_directory(root)?,
        is_directory(&record.stage)?,
        is_directory(&record.backup)?,
    );
    check()?;
    let outcome = match state {
        // A crash between renames must restore the known original, never replay
        // the incoming write or destroy either the original or staged data.
        (false, true, true) => {
            fs::rename(&record.backup, root).map_err(|_| "mirror_recovery_restore_failed")?;
            "original_restored"
        }
        (true, false, true)
            if fingerprint_root_with_metadata(
                root,
                cache,
                record
                    .snapshot_id
                    .as_ref()
                    .map(|id| snapshot_database(cache, id, false))
                    .transpose()?
                    .as_ref(),
                check,
            )? == record.manifest_hash =>
        {
            if let Some(id) = &record.snapshot_id {
                persist_applied_metadata(cache, id)?;
            }
            "commit_recovered"
        }
        (true, true, false)
            if record
                .previous_manifest_hash
                .as_ref()
                .is_some_and(|expected| {
                    fingerprint_root(root, cache, check).is_ok_and(|actual| actual == *expected)
                }) =>
        {
            "original_retained"
        }
        _ => return Err("mirror_recovery_manual_review_required".into()),
    };
    fs::remove_file(marker).map_err(|_| "mirror_recovery_marker_retained")?;
    Ok(serde_json::json!({"transactionId":id,"state":outcome}))
}

#[tauri::command]
pub async fn project_mirror_recover(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<MirrorScope>,
) -> Result<serde_json::Value, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let scope = payload.request;
        let cache = cache(&app, &scope)?;
        let (root, revision) = super::project_workspace::recovery_workspace_identity(
            &app,
            &scope.principal_id,
            &scope.project_id,
        )?;
        let _workspace = acquire_workspace_lease(&root, true)?;
        let mut outcomes = Vec::new();
        for entry in fs::read_dir(&cache).map_err(|_| "mirror_recovery_unavailable")? {
            let name = entry
                .map_err(|_| "mirror_recovery_unavailable")?
                .file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(id) = name
                .strip_prefix("transaction-")
                .and_then(|n| n.strip_suffix(".json"))
            else {
                continue;
            };
            let check = || {
                lease.check()?;
                if super::project_workspace::recovery_workspace_identity(
                    &app,
                    &scope.principal_id,
                    &scope.project_id,
                )? != (root.clone(), revision)
                {
                    return Err("mirror_workspace_changed".into());
                }
                Ok(())
            };
            outcomes.push(recover_transaction(&cache, id, &root, &check)?);
        }
        if !outcomes.is_empty() {
            super::execution::revoke_project_scopes(&scope.project_id)?;
        }
        Ok(serde_json::json!({"recovered":outcomes}))
    })
    .await
    .map_err(|_| "mirror_worker_failed")?
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
fn scope_key(scope: &MirrorScope) -> Result<String, String> {
    if [&scope.principal_id, &scope.project_id]
        .iter()
        .any(|v| v.trim().is_empty() || v.len() > 300 || v.chars().any(char::is_control))
    {
        return Err("mirror_scope_invalid".into());
    }
    Ok(hash(
        &serde_json::to_vec(&(&scope.principal_id, &scope.project_id))
            .map_err(|_| "mirror_scope_invalid")?,
    ))
}
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn safe_directory(path: &Path) -> Result<(), String> {
    // Check every ancestor, including an existing directory replaced with a reparse point.
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor).is_ok_and(|m| is_link(&m)) {
            return Err("mirror_cache_link_rejected".into());
        }
    }
    fs::create_dir_all(path).map_err(|_| "mirror_directory_unavailable".to_string())
}
fn cache(app: &AppHandle, scope: &MirrorScope) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "mirror_cache_unavailable")?
        .join("project-mirrors")
        .join(scope_key(scope)?);
    safe_directory(&path.join("chunks"))?;
    Ok(path)
}
fn chunk_path(cache: &Path, digest: &str) -> Result<PathBuf, String> {
    if !valid_hash(digest) {
        return Err("mirror_hash_invalid".into());
    }
    let path = cache.join("chunks").join(digest);
    if fs::symlink_metadata(&path).is_ok_and(|m| is_link(&m) || !m.is_file()) {
        return Err("mirror_chunk_link_rejected".into());
    }
    Ok(path)
}
fn write_chunk(cache: &Path, digest: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > CHUNK_BYTES || hash(bytes) != digest {
        return Err("mirror_chunk_integrity_failed".into());
    }
    let path = chunk_path(cache, digest)?;
    if path.exists() {
        let existing = read_chunk(cache, digest)?;
        if existing == bytes {
            return Ok(());
        }
        return Err("mirror_chunk_integrity_failed".into());
    }
    let temp = cache
        .join("chunks")
        .join(format!(".{}", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|_| "mirror_chunk_write_failed")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "mirror_chunk_write_failed")?;
    drop(file);
    fs::rename(&temp, &path).map_err(|_| "mirror_chunk_commit_failed".to_string())
}
fn read_chunk(cache: &Path, digest: &str) -> Result<Vec<u8>, String> {
    let path = chunk_path(cache, digest)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "mirror_chunk_missing")?
        .take((CHUNK_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "mirror_chunk_read_failed")?;
    if bytes.len() > CHUNK_BYTES || hash(&bytes) != digest {
        return Err("mirror_chunk_integrity_failed".into());
    }
    Ok(bytes)
}
fn relative(path: &Path, root: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|_| "mirror_path_outside_workspace")?
        .to_str()
        .map(|v| v.replace('\\', "/"))
        .ok_or("mirror_path_encoding_unsupported".into())
}
fn open_regular_no_follow(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(|_| "mirror_file_unreadable")?;
    let metadata = file.metadata().map_err(|_| "mirror_file_unreadable")?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err("mirror_file_type_changed".into());
    }
    Ok(file)
}

fn read_private_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let mut bytes = Vec::new();
    open_regular_no_follow(path)?
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| "mirror_metadata_unavailable")?;
    if bytes.len() > 16384 {
        return Err("mirror_metadata_invalid".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "mirror_metadata_invalid".into())
}
fn walk_root(
    root: &Path,
    cache: Option<&Path>,
    check: &impl Fn() -> Result<(), String>,
    mut accept: impl FnMut(Entry) -> Result<(), String>,
) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        check()?;
        let metadata = fs::symlink_metadata(&directory).map_err(|_| "mirror_scan_changed")?;
        if is_link(&metadata) || !metadata.is_dir() {
            return Err("mirror_scan_changed".into());
        }
        for item in fs::read_dir(directory).map_err(|_| "mirror_scan_read_failed")? {
            check()?;
            let path = item.map_err(|_| "mirror_scan_read_failed")?.path();
            let before = fs::symlink_metadata(&path).map_err(|_| "mirror_scan_changed")?;
            let mut entry = Entry {
                path: relative(&path, root)?,
                kind: EntryType::File,
                size: None,
                sha256: None,
                chunks: vec![],
                target: None,
                mode: None,
                mtime_ms: before
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64),
                metadata: None,
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                entry.mode = Some(before.permissions().mode() & 0o7777);
            }
            if is_link(&before) {
                entry.kind = EntryType::Symlink;
                entry.target = Some(
                    fs::read_link(&path)
                        .map_err(|_| "mirror_link_type_unsupported")?
                        .to_str()
                        .ok_or("mirror_link_encoding_unsupported")?
                        .to_string(),
                );
                #[cfg(windows)]
                {
                    use std::os::windows::fs::FileTypeExt;
                    entry.metadata = Some(
                        serde_json::json!({"directoryLink":before.file_type().is_symlink_dir()}),
                    );
                }
            } else if before.is_dir() {
                entry.kind = EntryType::Directory;
                pending.push(path);
            } else if before.is_file() {
                let mut file = open_regular_no_follow(&path)?;
                let mut file_hash = Sha256::new();
                let mut size = 0_u64;
                loop {
                    check()?;
                    let mut buffer = vec![0; CHUNK_BYTES];
                    let mut filled = 0;
                    while filled < buffer.len() {
                        let read = file
                            .read(&mut buffer[filled..])
                            .map_err(|_| "mirror_file_read_failed")?;
                        if read == 0 {
                            break;
                        }
                        filled += read;
                    }
                    if filled == 0 {
                        break;
                    }
                    buffer.truncate(filled);
                    size += filled as u64;
                    file_hash.update(&buffer);
                    let digest = hash(&buffer);
                    if let Some(cache) = cache {
                        write_chunk(cache, &digest, &buffer)?;
                    }
                    entry.chunks.push(Chunk {
                        sha256: digest,
                        size: filled as u64,
                    });
                }
                let after = fs::symlink_metadata(&path).map_err(|_| "mirror_scan_changed")?;
                if is_link(&after)
                    || !after.is_file()
                    || before.len() != size
                    || after.len() != size
                    || before.modified().ok() != after.modified().ok()
                {
                    return Err("mirror_scan_changed".into());
                }
                entry.size = Some(size);
                entry.sha256 = Some(format!("{:x}", file_hash.finalize()));
            } else {
                return Err("mirror_special_file_unsupported".into());
            }
            accept(entry)?;
        }
    }
    Ok(())
}
fn scan_root(
    root: &Path,
    cache: Option<&Path>,
    check: &impl Fn() -> Result<(), String>,
) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    walk_root(root, cache, check, |entry| {
        entries.push(entry);
        Ok(())
    })?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}
fn manifest_hash(entries: &[Entry]) -> Result<String, String> {
    let json = serde_json::to_vec(entries).map_err(|_| "mirror_manifest_invalid")?;
    Ok(hash(&json))
}
fn snapshot_database(cache: &Path, id: &str, create: bool) -> Result<rusqlite::Connection, String> {
    if uuid::Uuid::parse_str(id)
        .map(|id2| id2.to_string() != id)
        .unwrap_or(true)
    {
        return Err("mirror_snapshot_invalid".into());
    }
    let path = cache.join(format!("snapshot-{id}.sqlite3"));
    if fs::symlink_metadata(&path).is_ok_and(|m| is_link(&m)) {
        return Err("mirror_snapshot_link_rejected".into());
    }
    let flags = if create {
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
    } else {
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = rusqlite::Connection::open_with_flags(path, flags)
        .map_err(|_| "mirror_snapshot_unavailable")?;
    if create {
        db.execute_batch("PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS entries(path TEXT PRIMARY KEY,body TEXT NOT NULL)").map_err(|_|"mirror_snapshot_write_failed")?;
    }
    Ok(db)
}
fn snapshot_digest(db: &rusqlite::Connection) -> Result<(String, usize), String> {
    let mut digest = Sha256::new();
    digest.update(b"[");
    let mut count = 0_usize;
    let mut statement = db
        .prepare("SELECT body FROM entries ORDER BY path")
        .map_err(|_| "mirror_snapshot_read_failed")?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "mirror_snapshot_read_failed")?;
    for row in rows {
        let body = row.map_err(|_| "mirror_snapshot_read_failed")?;
        if count > 0 {
            digest.update(b",");
        }
        digest.update(body.as_bytes());
        count += 1;
    }
    digest.update(b"]");
    Ok((format!("{:x}", digest.finalize()), count))
}
fn snapshot_page(
    db: &rusqlite::Connection,
    offset: usize,
    limit: usize,
) -> Result<Vec<Entry>, String> {
    let mut statement = db
        .prepare("SELECT body FROM entries ORDER BY path LIMIT ?1 OFFSET ?2")
        .map_err(|_| "mirror_snapshot_read_failed")?;
    let rows = statement
        .query_map(rusqlite::params![limit as i64, offset as i64], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|_| "mirror_snapshot_read_failed")?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|_| "mirror_snapshot_read_failed")?)
            .map_err(|_| "mirror_manifest_invalid".into())
    })
    .collect()
}
fn validate_entries(entries: &[Entry]) -> Result<(), String> {
    manifest_hash(entries)?;
    let mut paths = BTreeMap::new();
    let mut platform_paths = HashSet::new();
    for entry in entries {
        let path = Path::new(&entry.path);
        if entry.path.is_empty()
            || entry.path.len() > 4096
            || entry.path.contains(['\\', '\0'])
            || path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            || entry
                .path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("mirror_path_invalid".into());
        }
        #[cfg(windows)]
        {
            for part in entry.path.split('/') {
                let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
                if part.ends_with(['.', ' '])
                    || part.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c))
                    || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                        && stem.len() == 4
                        && stem.as_bytes()[3].is_ascii_digit())
                {
                    return Err("mirror_path_not_supported_on_device".into());
                }
            }
            if !platform_paths.insert(entry.path.to_lowercase()) {
                return Err("mirror_case_collision".into());
            }
        }
        #[cfg(not(windows))]
        {
            if !platform_paths.insert(entry.path.clone()) {
                return Err("mirror_duplicate_path".into());
            }
        }
        if paths.insert(entry.path.as_str(), &entry.kind).is_some() {
            return Err("mirror_duplicate_path".into());
        }
        match entry.kind {
            EntryType::File => {
                if !entry.sha256.as_deref().is_some_and(valid_hash)
                    || entry.size.is_none()
                    || entry.target.is_some()
                    || entry.chunks.iter().any(|c| {
                        !valid_hash(&c.sha256) || c.size == 0 || c.size > CHUNK_BYTES as u64
                    })
                    || entry
                        .chunks
                        .iter()
                        .try_fold(0_u64, |sum, c| sum.checked_add(c.size))
                        != entry.size
                {
                    return Err("mirror_file_manifest_invalid".into());
                }
            }
            EntryType::Directory => {
                if entry.target.is_some() || !entry.chunks.is_empty() {
                    return Err("mirror_directory_manifest_invalid".into());
                }
            }
            EntryType::Symlink => {
                if !entry
                    .target
                    .as_ref()
                    .is_some_and(|t| !t.is_empty() && !t.contains('\0') && t.len() <= 4096)
                    || !entry.chunks.is_empty()
                {
                    return Err("mirror_link_manifest_invalid".into());
                }
            }
        }
    }
    for entry in entries {
        let mut parent = Path::new(&entry.path).parent();
        while let Some(path) = parent.filter(|p| !p.as_os_str().is_empty()) {
            if paths.get(path.to_str().ok_or("mirror_path_invalid")?)
                != Some(&&EntryType::Directory)
            {
                return Err("mirror_parent_not_directory".into());
            }
            parent = path.parent();
        }
    }
    Ok(())
}
#[cfg(any(windows, test))]
fn link_target_parts(target: &str) -> Result<Vec<String>, String> {
    // Manifest paths use `/` on every platform. Do not resolve targets through
    // the filesystem: they may escape the workspace or not exist yet.
    if target.is_empty()
        || target.starts_with('/')
        || target.chars().any(|ch| matches!(ch, '\\' | ':' | '\0'))
    {
        return Err("mirror_link_type_unrepresentable".into());
    }
    let mut parts = target
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    // A trailing slash requires a directory, including when a link expands
    // to that target. A final `.` retains that check in the manifest walk.
    if target.ends_with('/') {
        parts.push(".".into());
    }
    Ok(parts)
}

#[cfg(any(windows, test))]
fn windows_link_directory(
    entry: &Entry,
    mut lookup: impl FnMut(&str) -> Result<Option<Entry>, String>,
) -> Result<bool, String> {
    let hint = |entry: &Entry| {
        entry
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("directoryLink"))
            .and_then(|value| value.as_bool())
    };
    if let Some(directory) = hint(entry) {
        return Ok(directory);
    }
    let parent = entry
        .path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let mut resolved = parent
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut pending = std::collections::VecDeque::from(link_target_parts(
        entry
            .target
            .as_deref()
            .ok_or("mirror_link_manifest_invalid")?,
    )?);
    let mut expansions = 0;
    // Only immutable manifest records are followed. Resolve intermediate
    // symlinks before `..`; lexical collapse alone changes POSIX semantics.
    while let Some(part) = pending.pop_front() {
        match part.as_str() {
            "." => continue,
            ".." => {
                resolved.pop().ok_or("mirror_link_type_unrepresentable")?;
                continue;
            }
            _ => {}
        }
        let path = resolved
            .iter()
            .chain(std::iter::once(&part))
            .cloned()
            .collect::<Vec<_>>()
            .join("/");
        let found = lookup(&path)?.ok_or("mirror_link_type_unrepresentable")?;
        match found.kind {
            EntryType::Directory => resolved.push(part),
            EntryType::File if pending.is_empty() => return Ok(false),
            EntryType::File => return Err("mirror_link_type_unrepresentable".into()),
            EntryType::Symlink => {
                if pending.is_empty() {
                    if let Some(directory) = hint(&found) {
                        return Ok(directory);
                    }
                }
                expansions += 1;
                if expansions > 64 {
                    return Err("mirror_link_type_unrepresentable".into());
                }
                for part in link_target_parts(
                    found
                        .target
                        .as_deref()
                        .ok_or("mirror_link_manifest_invalid")?,
                )?
                .into_iter()
                .rev()
                {
                    pending.push_front(part);
                }
            }
        }
    }
    Ok(true)
}

#[cfg(any(windows, test))]
fn snapshot_link_directory(entry: &Entry, db: &rusqlite::Connection) -> Result<bool, String> {
    use rusqlite::OptionalExtension;
    windows_link_directory(entry, |path| {
        let body: Option<String> = db
            .query_row("SELECT body FROM entries WHERE path=?1", [path], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|_| "mirror_snapshot_read_failed")?;
        body.map(|body| serde_json::from_str(&body).map_err(|_| "mirror_manifest_invalid".into()))
            .transpose()
    })
}

fn materialize_files(
    stage: &Path,
    cache: &Path,
    entries: &[Entry],
    check: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    validate_entries(entries)?;
    #[cfg(windows)]
    let link_types = {
        let by_path = entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect::<BTreeMap<_, _>>();
        entries
            .iter()
            .filter(|entry| entry.kind == EntryType::Symlink)
            .map(|entry| {
                windows_link_directory(entry, |path| {
                    Ok(by_path.get(path).map(|entry| (**entry).clone()))
                })
                .map(|directory| (entry.path.as_str(), directory))
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?
    };
    let mut sorted = entries.iter().collect::<Vec<_>>();
    sorted.sort_by_key(|entry| entry.path.split('/').count());
    for entry in &sorted {
        check()?;
        let path = stage.join(&entry.path);
        match entry.kind {
            EntryType::Directory => {
                fs::create_dir_all(&path).map_err(|_| "mirror_stage_directory_failed")?
            }
            EntryType::File => {
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&path)
                    .map_err(|_| "mirror_stage_file_failed")?;
                let mut digest = Sha256::new();
                for chunk in &entry.chunks {
                    check()?;
                    let bytes = read_chunk(cache, &chunk.sha256)?;
                    if bytes.len() as u64 != chunk.size {
                        return Err("mirror_chunk_integrity_failed".into());
                    }
                    digest.update(&bytes);
                    file.write_all(&bytes)
                        .map_err(|_| "mirror_stage_file_failed")?;
                }
                if Some(format!("{:x}", digest.finalize())) != entry.sha256 {
                    return Err("mirror_file_integrity_failed".into());
                }
                file.sync_all().map_err(|_| "mirror_stage_sync_failed")?;
            }
            EntryType::Symlink => {
                let target = entry
                    .target
                    .as_deref()
                    .ok_or("mirror_link_manifest_invalid")?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(target, &path)
                    .map_err(|_| "mirror_symlink_creation_failed")?;
                #[cfg(windows)]
                {
                    let directory = link_types[entry.path.as_str()];
                    (if directory {
                        std::os::windows::fs::symlink_dir(target, &path)
                    } else {
                        std::os::windows::fs::symlink_file(target, &path)
                    })
                    .map_err(|_| "mirror_symlink_permission_required")?;
                }
            }
        }
    }
    // Apply directory metadata last: creating children changes its modification time.
    for entry in sorted.iter().rev().filter(|e| e.kind != EntryType::Symlink) {
        check()?;
        let path = stage.join(&entry.path);
        if let Some(ms) = entry.mtime_ms {
            let time = UNIX_EPOCH
                .checked_add(std::time::Duration::from_millis(ms))
                .ok_or("mirror_timestamp_invalid")?;
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.access_mode(0x100).custom_flags(0x02000000);
            }
            options
                .open(&path)
                .and_then(|file| file.set_times(fs::FileTimes::new().set_modified(time)))
                .map_err(|_| "mirror_metadata_failed")?;
        }
        #[cfg(unix)]
        if let Some(mode) = entry.mode {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(mode & 0o7777))
                .map_err(|_| "mirror_metadata_failed")?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn project_mirror_scan(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<MirrorScope>,
) -> Result<Scan, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, false)?;
    tauri::async_runtime::spawn_blocking(move || {
        let scope = &payload.request;
        let (root, revision) =
            agent_workspace_snapshot(&app, &scope.principal_id, &scope.project_id)?;
        let _workspace = acquire_workspace_lease(&root, false)?;
        let cache = cache(&app, scope)?;
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let mut db = snapshot_database(&cache, &snapshot_id, true)?;
        let previous_metadata = applied_metadata(&cache)?;
        let transaction = db
            .transaction()
            .map_err(|_| "mirror_snapshot_write_failed")?;
        walk_root(&root, Some(&cache), &|| lease.check(), |mut entry| {
            retain_foreign_metadata(&mut entry, previous_metadata.as_ref())?;
            transaction
                .execute(
                    "INSERT INTO entries(path,body) VALUES(?1,?2)",
                    rusqlite::params![
                        entry.path,
                        serde_json::to_string(&entry).map_err(|_| "mirror_manifest_invalid")?
                    ],
                )
                .map_err(|_| "mirror_snapshot_write_failed")?;
            Ok(())
        })?;
        transaction
            .commit()
            .map_err(|_| "mirror_snapshot_write_failed")?;
        if agent_workspace_snapshot(&app, &scope.principal_id, &scope.project_id)?
            != (root, revision)
        {
            return Err("mirror_workspace_changed".into());
        }
        let (digest, total_entries) = snapshot_digest(&db)?;
        Ok(Scan {
            manifest_hash: digest,
            snapshot_id,
            total_entries,
            entries: snapshot_page(&db, 0, 1000)?,
            workspace_updated_at: revision,
            chunk_bytes: CHUNK_BYTES,
        })
    })
    .await
    .map_err(|_| "mirror_worker_failed")?
}
#[tauri::command]
pub async fn project_mirror_scan_page(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<ScanPage>,
) -> Result<Page, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, false)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request = payload.request;
        if request.limit == 0
            || request.limit > 1000
            || request.offset > 9_007_199_254_740_991_usize
            || uuid::Uuid::parse_str(&request.snapshot_id)
                .map(|id| id.to_string() != request.snapshot_id)
                .unwrap_or(true)
        {
            return Err("mirror_page_invalid".into());
        }
        let cache = cache(
            &app,
            &MirrorScope {
                principal_id: request.principal_id,
                project_id: request.project_id,
            },
        )?;
        let db = snapshot_database(&cache, &request.snapshot_id, false)?;
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
            .map_err(|_| "mirror_snapshot_read_failed")?;
        lease.check()?;
        Ok(Page {
            snapshot_id: request.snapshot_id,
            total_entries: count as usize,
            entries: snapshot_page(&db, request.offset, request.limit)?,
            offset: request.offset,
        })
    })
    .await
    .map_err(|_| "mirror_worker_failed")?
}
#[tauri::command]
pub async fn project_mirror_chunk_read(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<ChunkRequest>,
) -> Result<ChunkReply, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, false)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request = payload.request;
        if request.data_base64.is_some() {
            return Err("mirror_read_payload_invalid".into());
        }
        let cache = cache(
            &app,
            &MirrorScope {
                principal_id: request.principal_id,
                project_id: request.project_id,
            },
        )?;
        let bytes = read_chunk(&cache, &request.sha256)?;
        lease.check()?;
        Ok(ChunkReply {
            sha256: request.sha256,
            size: bytes.len(),
            data_base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        })
    })
    .await
    .map_err(|_| "mirror_worker_failed")?
}
#[tauri::command]
pub async fn project_mirror_chunk_put(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<ChunkRequest>,
) -> Result<ChunkReply, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request = payload.request;
        let encoded = request.data_base64.ok_or("mirror_chunk_missing")?;
        if encoded.len() > (CHUNK_BYTES + 2) / 3 * 4 {
            return Err("mirror_chunk_too_large".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "mirror_chunk_encoding_invalid")?;
        let cache = cache(
            &app,
            &MirrorScope {
                principal_id: request.principal_id,
                project_id: request.project_id,
            },
        )?;
        lease.check()?;
        write_chunk(&cache, &request.sha256, &bytes)?;
        Ok(ChunkReply {
            sha256: request.sha256,
            size: bytes.len(),
            data_base64: None,
        })
    })
    .await
    .map_err(|_| "mirror_worker_failed")?
}
#[tauri::command]
pub async fn project_mirror_materialize(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<Materialize>,
) -> Result<Applied, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, true)?;
    tauri::async_runtime::spawn_blocking(move||{
        let request=payload.request;validate_entries(&request.entries)?;
        if !valid_hash(&request.expected_local_manifest_hash){return Err("mirror_hash_invalid".into());}
        let scope=MirrorScope{principal_id:request.principal_id,project_id:request.project_id};let (root,revision)=agent_workspace_snapshot(&app,&scope.principal_id,&scope.project_id)?;
        let _workspace=acquire_workspace_lease(&root,true)?;let cache=cache(&app,&scope)?;
        if fingerprint_root(&root,&cache,&||lease.check())?!=request.expected_local_manifest_hash{return Err("mirror_local_revision_conflict".into());}
        let parent=root.parent().filter(|_|root.file_name().is_some()).ok_or("mirror_root_swap_unsupported")?;
        let transaction_id=uuid::Uuid::new_v4().to_string();let stage=parent.join(format!(".luczor-stage-{transaction_id}"));let backup=parent.join(format!(".luczor-backup-{transaction_id}"));
        fs::create_dir(&stage).map_err(|_|"mirror_stage_unavailable")?;
        materialize_files(&stage,&cache,&request.entries,&||lease.check())?;
        lease.check()?;
        if agent_workspace_snapshot(&app,&scope.principal_id,&scope.project_id)?!=(root.clone(),revision)||fingerprint_root(&root,&cache,&||lease.check())?!=request.expected_local_manifest_hash{return Err("mirror_local_revision_conflict".into());}
        let metadata=snapshot_database(&cache,&transaction_id,true)?;
        for entry in &request.entries {metadata.execute("INSERT INTO entries(path,body)VALUES(?1,?2)",rusqlite::params![entry.path,serde_json::to_string(entry).map_err(|_|"mirror_manifest_invalid")?]).map_err(|_|"mirror_metadata_persist_failed")?;}
        let digest=fingerprint_root_with_metadata(&stage,&cache,Some(&metadata),&||lease.check())?;
        let recovery=serde_json::json!({"schemaVersion":1,"root":root,"stage":stage,"backup":backup,"manifestHash":digest,"previousManifestHash":request.expected_local_manifest_hash,"snapshotId":transaction_id});
        let recovery_path=cache.join(format!("transaction-{transaction_id}.json"));
        let mut marker=OpenOptions::new().create_new(true).write(true).open(&recovery_path).map_err(|_|"mirror_recovery_journal_failed")?;
        marker.write_all(serde_json::to_string(&recovery).map_err(|_|"mirror_manifest_invalid")?.as_bytes()).and_then(|_|marker.sync_all()).map_err(|_|"mirror_recovery_journal_failed")?;drop(marker);
        fs::rename(&root,&backup).map_err(|_|"mirror_workspace_in_use")?;
        if fs::rename(&stage,&root).is_err() {
            if fs::rename(&backup,&root).is_err(){return Err("mirror_recovery_required".into());}
            return Err("mirror_commit_failed_original_restored".into());
        }
        // Backups are retained, never recursively deleted by a sync operation.
        persist_applied_metadata(&cache,&transaction_id)?;
        super::execution::revoke_project_scopes(&scope.project_id)?;
        fs::remove_file(recovery_path).map_err(|_|"mirror_committed_recovery_marker_retained")?;
        Ok(Applied{manifest_hash:digest,source_manifest_hash:manifest_hash(&request.entries)?,backup_path:backup.to_string_lossy().into_owned()})
    }).await.map_err(|_|"mirror_worker_failed")?
}

fn entry_with_parents(entry: &Entry) -> Vec<Entry> {
    let mut result = vec![entry.clone()];
    let mut parent = Path::new(&entry.path).parent();
    while let Some(path) = parent.filter(|path| !path.as_os_str().is_empty()) {
        result.push(Entry {
            path: path.to_string_lossy().replace('\\', "/"),
            kind: EntryType::Directory,
            size: None,
            sha256: None,
            chunks: vec![],
            target: None,
            mode: None,
            mtime_ms: None,
            metadata: None,
        });
        parent = path.parent();
    }
    result
}
fn build_snapshot_tree(
    stage: &Path,
    cache: &Path,
    db: &rusqlite::Connection,
    check: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    #[cfg(windows)]
    db.execute_batch("CREATE TEMP TABLE IF NOT EXISTS mirror_case_keys(path TEXT PRIMARY KEY); DELETE FROM mirror_case_keys;")
        .map_err(|_| "mirror_snapshot_read_failed")?;
    // Validate parent types across every page before any file materialization.
    let mut statement = db
        .prepare("SELECT body FROM entries ORDER BY path")
        .map_err(|_| "mirror_snapshot_read_failed")?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "mirror_snapshot_read_failed")?;
    for row in rows {
        check()?;
        let entry: Entry = serde_json::from_str(&row.map_err(|_| "mirror_snapshot_read_failed")?)
            .map_err(|_| "mirror_manifest_invalid")?;
        let with_parents = entry_with_parents(&entry);
        validate_entries(&with_parents)?;
        for parent in with_parents.iter().skip(1) {
            let kind: String = db
                .query_row(
                    "SELECT json_extract(body,'$.type') FROM entries WHERE path=?1",
                    [&parent.path],
                    |row| row.get(0),
                )
                .map_err(|_| "mirror_parent_not_directory")?;
            if kind != "directory" {
                return Err("mirror_parent_not_directory".into());
            }
        }
        #[cfg(windows)]
        {
            if entry.kind == EntryType::Symlink {
                snapshot_link_directory(&entry, db)?;
            }
            db.execute(
                "INSERT INTO mirror_case_keys(path) VALUES(?1)",
                [entry.path.to_lowercase()],
            )
            .map_err(|_| "mirror_case_collision")?;
        }
    }
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "mirror_snapshot_read_failed")?;
    for row in rows {
        check()?;
        let mut entry: Entry =
            serde_json::from_str(&row.map_err(|_| "mirror_snapshot_read_failed")?)
                .map_err(|_| "mirror_manifest_invalid")?;
        #[cfg(windows)]
        if entry.kind == EntryType::Symlink {
            let directory = snapshot_link_directory(&entry, db)?;
            entry
                .metadata
                .get_or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or("mirror_metadata_invalid")?
                .insert("directoryLink".into(), serde_json::Value::Bool(directory));
        }
        if entry.kind == EntryType::Directory {
            entry.mode = None;
            entry.mtime_ms = None;
        }
        materialize_files(stage, cache, &entry_with_parents(&entry), check)?;
    }
    // Creating later siblings changes directory times; restore directory metadata last.
    let mut statement=db.prepare("SELECT body FROM entries WHERE json_extract(body,'$.type')='directory' ORDER BY path DESC").map_err(|_|"mirror_snapshot_read_failed")?;
    for row in statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "mirror_snapshot_read_failed")?
    {
        let entry: Entry = serde_json::from_str(&row.map_err(|_| "mirror_snapshot_read_failed")?)
            .map_err(|_| "mirror_manifest_invalid")?;
        materialize_files(stage, cache, &entry_with_parents(&entry), check)?;
    }
    Ok(())
}
fn fingerprint_root(
    root: &Path,
    cache: &Path,
    check: &impl Fn() -> Result<(), String>,
) -> Result<String, String> {
    let metadata = applied_metadata(cache)?;
    fingerprint_root_with_metadata(root, cache, metadata.as_ref(), check)
}
fn fingerprint_root_with_metadata(
    root: &Path,
    cache: &Path,
    metadata: Option<&rusqlite::Connection>,
    check: &impl Fn() -> Result<(), String>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut db = snapshot_database(cache, &id, true)?;
    let transaction = db
        .transaction()
        .map_err(|_| "mirror_snapshot_write_failed")?;
    walk_root(root, None, check, |mut entry| {
        retain_foreign_metadata(&mut entry, metadata)?;
        transaction
            .execute(
                "INSERT INTO entries(path,body)VALUES(?1,?2)",
                rusqlite::params![
                    entry.path,
                    serde_json::to_string(&entry).map_err(|_| "mirror_manifest_invalid")?
                ],
            )
            .map_err(|_| "mirror_snapshot_write_failed")?;
        Ok(())
    })?;
    transaction
        .commit()
        .map_err(|_| "mirror_snapshot_write_failed")?;
    let digest = snapshot_digest(&db)?.0;
    drop(db);
    fs::remove_file(cache.join(format!("snapshot-{id}.sqlite3")))
        .map_err(|_| "mirror_snapshot_cleanup_failed")?;
    Ok(digest)
}
fn stage_metadata(cache: &Path, id: &str) -> Result<StageMetadata, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "mirror_stage_invalid")?;
    let path = cache.join(format!("stage-{id}.json"));
    if fs::symlink_metadata(&path).is_ok_and(|m| is_link(&m)) {
        return Err("mirror_stage_link_rejected".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "mirror_stage_missing")?
        .take(16384)
        .read_to_end(&mut bytes)
        .map_err(|_| "mirror_stage_unavailable")?;
    serde_json::from_slice(&bytes).map_err(|_| "mirror_stage_invalid".into())
}
#[tauri::command]
pub async fn project_mirror_stage_begin(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<StageBegin>,
) -> Result<serde_json::Value, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request = payload.request;
        if !valid_hash(&request.expected_local_manifest_hash) {
            return Err("mirror_hash_invalid".into());
        }
        let scope = MirrorScope {
            principal_id: request.principal_id,
            project_id: request.project_id,
        };
        let (root, revision) =
            agent_workspace_snapshot(&app, &scope.principal_id, &scope.project_id)?;
        let cache = cache(&app, &scope)?;
        let id = uuid::Uuid::new_v4().to_string();
        snapshot_database(&cache, &id, true)?;
        let metadata = StageMetadata {
            principal_id: scope.principal_id,
            project_id: scope.project_id,
            root,
            workspace_revision: revision,
            expected_local_manifest_hash: request.expected_local_manifest_hash,
        };
        lease.check()?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(cache.join(format!("stage-{id}.json")))
            .map_err(|_| "mirror_stage_write_failed")?;
        file.write_all(&serde_json::to_vec(&metadata).map_err(|_| "mirror_stage_invalid")?)
            .and_then(|_| file.sync_all())
            .map_err(|_| "mirror_stage_write_failed")?;
        Ok(serde_json::json!({"stageId":id,"offset":0}))
    })
    .await
    .map_err(|_| "mirror_worker_failed")?
}
#[tauri::command]
pub async fn project_mirror_stage_page(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<StagePage>,
) -> Result<serde_json::Value, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, true)?;
    tauri::async_runtime::spawn_blocking(move||{let request=payload.request;if request.entries.len()>1000||request.offset>i64::MAX as usize{return Err("mirror_page_invalid".into());}let scope=MirrorScope{principal_id:request.principal_id,project_id:request.project_id};let cache=cache(&app,&scope)?;let metadata=stage_metadata(&cache,&request.stage_id)?;if metadata.principal_id!=scope.principal_id||metadata.project_id!=scope.project_id{return Err("mirror_scope_invalid".into());}let mut db=snapshot_database(&cache,&request.stage_id,true)?;let transaction=db.transaction().map_err(|_|"mirror_stage_write_failed")?;let count:i64=transaction.query_row("SELECT COUNT(*) FROM entries",[],|row|row.get(0)).map_err(|_|"mirror_stage_read_failed")?;if count as usize!=request.offset{return Err("mirror_stage_offset_conflict".into());}for entry in &request.entries{lease.check()?;validate_entries(&entry_with_parents(entry))?;transaction.execute("INSERT INTO entries(path,body)VALUES(?1,?2)",rusqlite::params![entry.path,serde_json::to_string(entry).map_err(|_|"mirror_manifest_invalid")?]).map_err(|_|"mirror_stage_duplicate_path")?;}transaction.commit().map_err(|_|"mirror_stage_write_failed")?;Ok(serde_json::json!({"stageId":request.stage_id,"offset":request.offset+request.entries.len()}))}).await.map_err(|_|"mirror_worker_failed")?
}
#[tauri::command]
pub async fn project_mirror_stage_commit(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<StageCommit>,
) -> Result<Applied, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, true)?;
    tauri::async_runtime::spawn_blocking(move||{
    let request=payload.request;let scope=MirrorScope{principal_id:request.principal_id,project_id:request.project_id};let cache=cache(&app,&scope)?;let metadata=stage_metadata(&cache,&request.stage_id)?;let(root,revision)=agent_workspace_snapshot(&app,&scope.principal_id,&scope.project_id)?;
    if metadata.principal_id!=scope.principal_id||metadata.project_id!=scope.project_id||metadata.root!=root||metadata.workspace_revision!=revision{return Err("mirror_workspace_changed".into());}
    let _workspace=acquire_workspace_lease(&root,true)?;let db=snapshot_database(&cache,&request.stage_id,false)?;let _source_hash=snapshot_digest(&db)?.0;
    if fingerprint_root(&root,&cache,&||lease.check())?!=metadata.expected_local_manifest_hash{return Err("mirror_local_revision_conflict".into());}
    let parent=root.parent().filter(|_|root.file_name().is_some()).ok_or("mirror_root_swap_unsupported")?;let stage=parent.join(format!(".luczor-stage-{}",request.stage_id));let backup=parent.join(format!(".luczor-backup-{}",request.stage_id));
    fs::create_dir(&stage).map_err(|_|"mirror_stage_exists_or_unavailable")?;build_snapshot_tree(&stage,&cache,&db,&||lease.check())?;
    // The local cursor fingerprints the materialized platform metadata, not the foreign OS manifest.
    let hash=fingerprint_root_with_metadata(&stage,&cache,Some(&db),&||lease.check())?;
    if agent_workspace_snapshot(&app,&scope.principal_id,&scope.project_id)?!=(root.clone(),revision)||fingerprint_root(&root,&cache,&||lease.check())?!=metadata.expected_local_manifest_hash{return Err("mirror_local_revision_conflict".into());}lease.check()?;
    let marker=cache.join(format!("transaction-{}.json",request.stage_id));let mut file=OpenOptions::new().create_new(true).write(true).open(&marker).map_err(|_|"mirror_recovery_journal_failed")?;file.write_all(&serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"root":root,"stage":stage,"backup":backup,"manifestHash":hash,"previousManifestHash":metadata.expected_local_manifest_hash,"snapshotId":request.stage_id})).map_err(|_|"mirror_manifest_invalid")?).and_then(|_|file.sync_all()).map_err(|_|"mirror_recovery_journal_failed")?;drop(file);
    fs::rename(&root,&backup).map_err(|_|"mirror_workspace_in_use")?;if fs::rename(&stage,&root).is_err(){if fs::rename(&backup,&root).is_err(){return Err("mirror_recovery_required".into());}return Err("mirror_commit_failed_original_restored".into());}
    persist_applied_metadata(&cache,&request.stage_id)?;
    super::execution::revoke_project_scopes(&scope.project_id)?;
    fs::remove_file(marker).map_err(|_|"mirror_committed_recovery_marker_retained")?;Ok(Applied{manifest_hash:hash,source_manifest_hash:_source_hash,backup_path:backup.to_string_lossy().into_owned()})
}).await.map_err(|_|"mirror_worker_failed")?
}
#[tauri::command]
pub async fn project_mirror_test_workspace(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<TestWorkspace>,
) -> Result<Workcopy, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let request = payload.request;
        if uuid::Uuid::parse_str(&request.run_id)
            .map(|id| id.to_string() != request.run_id)
            .unwrap_or(true)
        {
            return Err("mirror_run_invalid".into());
        }
        let scope = MirrorScope {
            principal_id: request.principal_id,
            project_id: request.project_id,
        };
        let cache = cache(&app, &scope)?;
        let (_, revision) = agent_workspace_snapshot(&app, &scope.principal_id, &scope.project_id)?;
        let db = snapshot_database(&cache, &request.snapshot_id, false)?;
        let hash = snapshot_digest(&db)?.0;
        let parent = cache.join("test-workspaces");
        safe_directory(&parent)?;
        let root = parent.join(&request.run_id);
        if root.exists() {
            let marker = parent.join(format!("{}.json", request.run_id));
            if fs::symlink_metadata(&marker).is_ok_and(|m| is_link(&m)) {
                return Err("mirror_test_workspace_link_rejected".into());
            }
            let existing: Workcopy = read_private_json(&marker)?;
            if existing.run_id != request.run_id || existing.manifest_hash != hash {
                return Err("mirror_test_workspace_revision_conflict".into());
            }
            run_workspace(
                &app,
                &scope.principal_id,
                &scope.project_id,
                &request.run_id,
            )?
            .ok_or("mirror_test_workspace_invalid")?;
            return Ok(existing);
        }
        fs::create_dir(&root).map_err(|_| "mirror_test_workspace_unavailable")?;
        build_snapshot_tree(&root, &cache, &db, &|| lease.check())?;
        let root = fs::canonicalize(root).map_err(|_| "mirror_test_workspace_unavailable")?;
        let workcopy = Workcopy {
            root_path: root.to_string_lossy().into_owned(),
            workspace_updated_at: revision,
            run_id: request.run_id.clone(),
            snapshot_id: request.snapshot_id,
            manifest_hash: hash,
        };
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(parent.join(format!("{}.json", request.run_id)))
            .map_err(|_| "mirror_test_workspace_unavailable")?;
        file.write_all(&serde_json::to_vec(&workcopy).map_err(|_| "mirror_manifest_invalid")?)
            .and_then(|_| file.sync_all())
            .map_err(|_| "mirror_test_workspace_unavailable")?;
        Ok(workcopy)
    })
    .await
    .map_err(|_| "mirror_worker_failed")?
}
pub(super) fn run_workspace(
    app: &AppHandle,
    principal: &str,
    project: &str,
    run: &str,
) -> Result<Option<(PathBuf, i64)>, String> {
    uuid::Uuid::parse_str(run).map_err(|_| "mirror_run_invalid")?;
    let scope = MirrorScope {
        principal_id: principal.into(),
        project_id: project.into(),
    };
    let cache = cache(app, &scope)?;
    let parent = cache.join("test-workspaces");
    let marker = parent.join(format!("{run}.json"));
    if !marker.exists() {
        return Ok(None);
    }
    if fs::symlink_metadata(&marker).is_ok_and(|m| is_link(&m)) {
        return Err("mirror_test_workspace_link_rejected".into());
    }
    let workcopy: Workcopy = read_private_json(&marker)?;
    let root = parent.join(run);
    let metadata = fs::symlink_metadata(&root).map_err(|_| "mirror_test_workspace_missing")?;
    if is_link(&metadata) || !metadata.is_dir() {
        return Err("mirror_test_workspace_link_rejected".into());
    }
    safe_directory(&parent)?;
    let root = fs::canonicalize(root).map_err(|_| "mirror_test_workspace_unavailable")?;
    if workcopy.run_id != run || Path::new(&workcopy.root_path) != root {
        return Err("mirror_test_workspace_invalid".into());
    }
    Ok(Some((root, workcopy.workspace_updated_at)))
}

struct MirrorWatch {
    stop: Arc<AtomicBool>,
}
impl Drop for MirrorWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
static WATCHES: OnceLock<Mutex<BTreeMap<String, MirrorWatch>>> = OnceLock::new();
#[tauri::command]
pub fn project_mirror_watch_start(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<MirrorScope>,
) -> Result<(), String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, false)?;
    let scope = payload.request;
    let key = scope_key(&scope)?;
    let (root, revision) = agent_workspace_snapshot(&app, &scope.principal_id, &scope.project_id)?;
    let mut watches = WATCHES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "mirror_watch_unavailable")?;
    if watches.contains_key(&key) {
        return Ok(());
    }
    if watches.len() >= 32 {
        return Err("mirror_watch_capacity".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let dirty = Arc::new(AtomicBool::new(false));
    let callback_dirty = dirty.clone();
    let mut watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if !matches!(&event,Ok(event) if matches!(event.kind,notify::EventKind::Access(_))) {
                callback_dirty.store(true, Ordering::Release);
            }
        })
        .map_err(|_| "mirror_watch_unavailable")?;
    watcher
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|_| "mirror_watch_unavailable")?;
    let (operation, _) = super::owned_processes::Operation::begin()?;
    watches.insert(key.clone(), MirrorWatch { stop });
    std::thread::spawn(move || {
        let _operation = operation;
        let _watcher = watcher;
        let mut sequence = 0_u64;
        while !thread_stop.load(Ordering::Acquire) {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if lease.check().is_err()
                || agent_workspace_snapshot(&app, &scope.principal_id, &scope.project_id).ok()
                    != Some((root.clone(), revision))
            {
                break;
            }
            if dirty.swap(false, Ordering::AcqRel) {
                sequence += 1;
                let _=app.emit_to("main","luczor://project-mirror-dirty",serde_json::json!({"principalId":scope.principal_id,"projectId":scope.project_id,"sequence":sequence}));
            }
        }
        if let Some(watches) = WATCHES.get() {
            if let Ok(mut watches) = watches.lock() {
                if watches
                    .get(&key)
                    .is_some_and(|watch| Arc::ptr_eq(&watch.stop, &thread_stop))
                {
                    watches.remove(&key);
                }
            }
        }
    });
    Ok(())
}
#[tauri::command]
pub fn project_mirror_watch_stop(
    window: super::CallerWebview,
    payload: MirrorScope,
) -> Result<(), String> {
    super::ensure_main_webview(&window)?;
    WATCHES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "mirror_watch_unavailable")?
        .remove(&scope_key(&payload)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("luczor-mirror-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn manifest_entry(path: &str, kind: EntryType, target: Option<&str>) -> Entry {
        Entry {
            path: path.into(),
            kind,
            target: target.map(str::to_owned),
            size: None,
            sha256: None,
            chunks: vec![],
            mode: None,
            mtime_ms: None,
            metadata: None,
        }
    }
    #[test]
    fn paged_linux_links_resolve_against_their_parent_and_manifest_link_chain() {
        let temp = temp();
        let db = snapshot_database(&temp, &uuid::Uuid::new_v4().to_string(), true).unwrap();
        let mut entries = [
            "node_modules",
            "node_modules/.bin",
            "node_modules/.pnpm",
            "node_modules/.pnpm/pkg",
            "node_modules/.pnpm/pkg/node_modules",
            "node_modules/.pnpm/pkg/node_modules/pkg",
            "node_modules/.pnpm/pkg/node_modules/pkg/bin",
            "node_modules/.pnpm/pkg/node_modules/sidecar",
        ]
        .into_iter()
        .map(|path| manifest_entry(path, EntryType::Directory, None))
        .collect::<Vec<_>>();
        entries.push(manifest_entry(
            "node_modules/.pnpm/pkg/node_modules/pkg/bin/tool.js",
            EntryType::File,
            None,
        ));
        entries.push(manifest_entry(
            "node_modules/sidecar",
            EntryType::File,
            None,
        ));
        let directory = manifest_entry(
            "node_modules/pkg",
            EntryType::Symlink,
            Some(".pnpm/pkg/node_modules/pkg"),
        );
        let binary = manifest_entry(
            "node_modules/.bin/tool",
            EntryType::Symlink,
            Some("../pkg/bin/tool.js"),
        );
        let alias = manifest_entry("0-alias", EntryType::Symlink, Some("node_modules/pkg"));
        let parent = manifest_entry(
            "node_modules/.bin/parent",
            EntryType::Symlink,
            Some("../pkg/../sidecar"),
        );
        entries.extend([
            directory.clone(),
            binary.clone(),
            alias.clone(),
            parent.clone(),
        ]);
        entries.extend((0..1001).map(|index| {
            manifest_entry(&format!("a-padding-{index:04}"), EntryType::Directory, None)
        }));
        for entry in entries {
            db.execute(
                "INSERT INTO entries(path,body)VALUES(?1,?2)",
                rusqlite::params![entry.path, serde_json::to_string(&entry).unwrap()],
            )
            .unwrap();
        }
        let preceding: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE path<'node_modules'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            preceding > 1000,
            "Target must be outside the first manifest page"
        );
        assert!(snapshot_link_directory(&directory, &db).unwrap());
        assert!(!snapshot_link_directory(&binary, &db).unwrap());
        assert!(snapshot_link_directory(&alias, &db).unwrap());
        // Resolve pkg before '..': collapsing it lexically would find the
        // different file at node_modules/sidecar instead of this directory.
        assert!(snapshot_link_directory(&parent, &db).unwrap());
        drop(db);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn untyped_link_cycles_and_unrepresentable_targets_never_guess_file_links() {
        let entries = [
            manifest_entry("a", EntryType::Symlink, Some("b")),
            manifest_entry("b", EntryType::Symlink, Some("a")),
            manifest_entry("file", EntryType::File, None),
        ];
        for target in [
            "a",
            "missing",
            "../outside",
            "/outside",
            "C:\\outside",
            "file/",
        ] {
            let link = manifest_entry("link", EntryType::Symlink, Some(target));
            assert_eq!(
                windows_link_directory(&link, |path| Ok(entries
                    .iter()
                    .find(|entry| entry.path == path)
                    .cloned()))
                .unwrap_err(),
                "mirror_link_type_unrepresentable",
                "{target}"
            );
        }
        let mut typed = manifest_entry(
            "link",
            EntryType::Symlink,
            Some("C:\\existing-device-target"),
        );
        typed.metadata = Some(serde_json::json!({"directoryLink":true}));
        assert!(
            windows_link_directory(&typed, |_| panic!("Explicit type needs no target lookup"))
                .unwrap()
        );
    }
    #[cfg(windows)]
    #[test]
    fn unknown_windows_link_type_is_rejected_before_any_stage_file_is_written() {
        let temp = temp();
        let db = snapshot_database(&temp, &uuid::Uuid::new_v4().to_string(), true).unwrap();
        let mut file = manifest_entry("a-file", EntryType::File, None);
        file.size = Some(0);
        file.sha256 = Some(hash(b""));
        for entry in [
            file,
            manifest_entry("z-link", EntryType::Symlink, Some("missing")),
        ] {
            db.execute(
                "INSERT INTO entries(path,body)VALUES(?1,?2)",
                rusqlite::params![entry.path, serde_json::to_string(&entry).unwrap()],
            )
            .unwrap();
        }
        let stage = temp.join("stage");
        fs::create_dir(&stage).unwrap();
        assert_eq!(
            build_snapshot_tree(&stage, &temp, &db, &|| Ok(())).unwrap_err(),
            "mirror_link_type_unrepresentable"
        );
        assert_eq!(fs::read_dir(&stage).unwrap().count(), 0);
        drop(db);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn full_scan_keeps_hidden_git_environment_and_binary_with_verified_chunks() {
        let temp = temp();
        let root = temp.join("root");
        let cache = temp.join("cache");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(cache.join("chunks")).unwrap();
        fs::write(root.join(".env"), "secret=test-only").unwrap();
        fs::write(root.join(".git/config"), "git test").unwrap();
        let bytes = vec![0, 255, 128, 10];
        fs::write(root.join("binary"), &bytes).unwrap();
        let entries = scan_root(&root, Some(&cache), &|| Ok(())).unwrap();
        assert!(entries.iter().any(|e| e.path == ".env"));
        assert!(entries.iter().any(|e| e.path == ".git/config"));
        let binary = entries.iter().find(|e| e.path == "binary").unwrap();
        assert_eq!(read_chunk(&cache, &binary.chunks[0].sha256).unwrap(), bytes);
        let stage = temp.join("stage");
        fs::create_dir(&stage).unwrap();
        materialize_files(&stage, &cache, &entries, &|| Ok(())).unwrap();
        assert_eq!(fs::read(stage.join("binary")).unwrap(), bytes);
        assert_eq!(fs::read(stage.join(".env")).unwrap(), b"secret=test-only");
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn manifests_cannot_escape_or_write_through_a_link() {
        let mut e = Entry {
            path: "../escape".into(),
            kind: EntryType::Directory,
            size: None,
            sha256: None,
            chunks: vec![],
            target: None,
            mode: None,
            mtime_ms: None,
            metadata: None,
        };
        assert!(validate_entries(&[e.clone()]).is_err());
        e.path = "link".into();
        e.kind = EntryType::Symlink;
        e.target = Some("/outside".into());
        let mut child = e.clone();
        child.path = "link/child".into();
        child.kind = EntryType::Directory;
        child.target = None;
        assert!(validate_entries(&[e, child]).is_err());
    }
    #[test]
    fn corrupted_chunks_stop_materialization_before_commit() {
        let temp = temp();
        fs::create_dir(temp.join("chunks")).unwrap();
        let sha = hash(b"correct");
        fs::write(temp.join("chunks").join(&sha), b"changed").unwrap();
        assert!(read_chunk(&temp, &sha).is_err());
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn streamed_snapshot_matches_full_manifest_and_materializes_nested_empty_files() {
        let temp = temp();
        let root = temp.join("root");
        let cache = temp.join("cache");
        fs::create_dir_all(root.join("nested/deep")).unwrap();
        fs::create_dir_all(cache.join("chunks")).unwrap();
        fs::write(root.join("nested/deep/empty"), b"").unwrap();
        fs::write(root.join(".env"), b"synthetic=1").unwrap();
        let entries = scan_root(&root, Some(&cache), &|| Ok(())).unwrap();
        let db = snapshot_database(&cache, &uuid::Uuid::new_v4().to_string(), true).unwrap();
        for entry in &entries {
            db.execute(
                "INSERT INTO entries(path,body)VALUES(?1,?2)",
                rusqlite::params![entry.path, serde_json::to_string(entry).unwrap()],
            )
            .unwrap();
        }
        assert_eq!(
            snapshot_digest(&db).unwrap(),
            (manifest_hash(&entries).unwrap(), entries.len())
        );
        let stage = temp.join("stage");
        fs::create_dir(&stage).unwrap();
        build_snapshot_tree(&stage, &cache, &db, &|| Ok(())).unwrap();
        assert_eq!(fs::read(stage.join("nested/deep/empty")).unwrap(), b"");
        assert_eq!(fs::read(stage.join(".env")).unwrap(), b"synthetic=1");
        drop(db);
        fs::remove_dir_all(temp).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_roundtrip_retains_unix_permissions_without_false_dirty_hash() {
        let temp = temp();
        let root = temp.join("root");
        let cache = temp.join("cache");
        fs::create_dir(&root).unwrap();
        fs::create_dir_all(cache.join("chunks")).unwrap();
        fs::write(root.join("script.sh"), b"echo test").unwrap();
        let mut entries = scan_root(&root, Some(&cache), &|| Ok(())).unwrap();
        entries[0].mode = Some(0o755);
        let id = uuid::Uuid::new_v4().to_string();
        let db = snapshot_database(&cache, &id, true).unwrap();
        db.execute(
            "INSERT INTO entries(path,body)VALUES(?1,?2)",
            rusqlite::params![entries[0].path, serde_json::to_string(&entries[0]).unwrap()],
        )
        .unwrap();
        let expected =
            fingerprint_root_with_metadata(&root, &cache, Some(&db), &|| Ok(())).unwrap();
        assert_eq!(expected, manifest_hash(&entries).unwrap());
        persist_applied_metadata(&cache, &id).unwrap();
        assert_eq!(
            fingerprint_root(&root, &cache, &|| Ok(())).unwrap(),
            expected
        );
        fs::write(root.join("script.sh"), b"echo changed").unwrap();
        let mut changed = scan_root(&root, None, &|| Ok(())).unwrap();
        retain_foreign_metadata(&mut changed[0], Some(&db)).unwrap();
        assert_eq!(changed[0].mode, Some(0o755));
        assert_ne!(changed[0].sha256, entries[0].sha256);
        drop(db);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn interrupted_swap_restores_original_without_replaying_incoming_changes() {
        let temp = temp();
        let cache = temp.join("cache");
        fs::create_dir(&cache).unwrap();
        let root = temp.join("root");
        let id = uuid::Uuid::new_v4().to_string();
        let backup = temp.join(format!(".luczor-backup-{id}"));
        let stage = temp.join(format!(".luczor-stage-{id}"));
        fs::create_dir(&backup).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(backup.join("original"), b"old").unwrap();
        fs::write(stage.join("incoming"), b"new").unwrap();
        let marker = cache.join(format!("transaction-{id}.json"));
        fs::write(&marker,serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"root":root,"stage":stage,"backup":backup,"manifestHash":hash(b"fixture")})).unwrap()).unwrap();
        let result = recover_transaction(&cache, &id, &root, &|| Ok(())).unwrap();
        assert_eq!(result["state"], "original_restored");
        assert_eq!(fs::read(root.join("original")).unwrap(), b"old");
        assert!(!root.join("incoming").exists());
        assert!(stage.join("incoming").exists());
        assert!(!marker.exists());
        fs::remove_dir_all(temp).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn streamed_manifest_rejects_unicode_case_collisions_before_creating_files() {
        let temp = temp();
        let db = snapshot_database(&temp, &uuid::Uuid::new_v4().to_string(), true).unwrap();
        for name in ["Ä", "ä"] {
            let entry = Entry {
                path: name.into(),
                kind: EntryType::Directory,
                size: None,
                sha256: None,
                chunks: vec![],
                target: None,
                mode: None,
                mtime_ms: None,
                metadata: None,
            };
            db.execute(
                "INSERT INTO entries(path,body)VALUES(?1,?2)",
                rusqlite::params![entry.path, serde_json::to_string(&entry).unwrap()],
            )
            .unwrap();
        }
        let stage = temp.join("stage");
        fs::create_dir(&stage).unwrap();
        assert_eq!(
            build_snapshot_tree(&stage, &temp, &db, &|| Ok(())).unwrap_err(),
            "mirror_case_collision"
        );
        assert_eq!(fs::read_dir(&stage).unwrap().count(), 0);
        drop(db);
        fs::remove_dir_all(temp).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn scan_does_not_follow_links_outside_workspace() {
        let temp = temp();
        let root = temp.join("root");
        fs::create_dir(&root).unwrap();
        fs::write(temp.join("private"), b"outside").unwrap();
        std::os::unix::fs::symlink(temp.join("private"), root.join("link")).unwrap();
        let entries = scan_root(&root, None, &|| Ok(())).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, EntryType::Symlink);
        assert!(entries[0].chunks.is_empty());
        fs::remove_dir_all(temp).unwrap();
    }
}
