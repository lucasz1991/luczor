//! Encrypted run objects. The renderer encrypts before IPC; a transaction commits
//! immutable segments and the CAS manifest together. No prompts enter public journals.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveScope {
    pub principal_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub run_id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveSegment {
    pub id: String,
    pub ciphertext: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveHead {
    #[serde(flatten)]
    pub scope: ArchiveScope,
    pub revision: u64,
    pub updated_at: u64,
    pub manifest: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveWrite {
    pub scope: ArchiveScope,
    pub expected_revision: u64,
    pub manifest: String,
    pub segments: Vec<ArchiveSegment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveRead {
    pub scope: ArchiveScope,
    #[serde(default)]
    pub segment_ids: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReadResult {
    pub head: Option<ArchiveHead>,
    pub segments: Vec<ArchiveSegment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveList {
    pub principal_id: String,
    pub after_run_id: Option<String>,
}

fn valid_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 1000 && !id.chars().any(char::is_control)
}
fn valid_scope(scope: &ArchiveScope) -> bool {
    [
        &scope.principal_id,
        &scope.project_id,
        &scope.conversation_id,
        &scope.run_id,
    ]
    .iter()
    .all(|id| valid_id(id))
}
fn valid_hash(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn encrypted(value: &str, maximum: usize) -> bool {
    if value.len() > maximum {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(value).is_ok_and(|v| {
        v["version"] == 1
            && v["iv"].as_str().is_some_and(|s| s.len() == 16)
            && v["data"].as_str().is_some_and(|s| !s.is_empty())
    })
}
fn open(path: &Path) -> Result<Connection, String> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("archive_link_rejected".into());
    }
    let connection = Connection::open(path).map_err(|_| "archive_unavailable")?;
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(|_| "archive_unavailable")?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS heads(owner TEXT, run_id TEXT, project_id TEXT, conversation_id TEXT, revision INTEGER, updated_at INTEGER, manifest TEXT, PRIMARY KEY(owner,run_id));
      CREATE TABLE IF NOT EXISTS segments(owner TEXT, run_id TEXT, id TEXT, ciphertext TEXT, PRIMARY KEY(owner,run_id,id));").map_err(|_| "archive_unavailable")?;
    Ok(connection)
}
fn connection(app: &AppHandle) -> Result<Connection, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "archive_unavailable")?;
    fs::create_dir_all(&directory).map_err(|_| "archive_unavailable")?;
    open(&directory.join("device-runs.sqlite3"))
}
fn head(connection: &Connection, scope: &ArchiveScope) -> Result<Option<ArchiveHead>, String> {
    if !valid_scope(scope) {
        return Err("archive_scope_invalid".into());
    }
    let value = connection.query_row("SELECT project_id,conversation_id,revision,updated_at,manifest FROM heads WHERE owner=?1 AND run_id=?2", params![scope.principal_id,scope.run_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)? as u64,row.get::<_,i64>(3)? as u64,row.get::<_,String>(4)?))).optional().map_err(|_| "archive_read_failed")?;
    value
        .map(|(project, conversation, revision, updated_at, manifest)| {
            if project != scope.project_id || conversation != scope.conversation_id {
                return Err("archive_scope_mismatch".into());
            }
            Ok(ArchiveHead {
                scope: scope.clone(),
                revision,
                updated_at,
                manifest,
            })
        })
        .transpose()
}
fn write(connection: &mut Connection, input: ArchiveWrite) -> Result<ArchiveHead, String> {
    if !valid_scope(&input.scope)
        || input.expected_revision >= 9_007_199_254_740_991
        || !encrypted(&input.manifest, 2_000_000)
        || input.segments.len() > 8192
        || input
            .segments
            .iter()
            .any(|s| !valid_hash(&s.id) || !encrypted(&s.ciphertext, 400_000))
        || input
            .segments
            .iter()
            .map(|s| s.ciphertext.len())
            .sum::<usize>()
            > 100_000_000
    {
        return Err("archive_payload_invalid".into());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "archive_write_failed")?;
    let previous = head(&transaction, &input.scope)?;
    if previous.as_ref().map_or(0, |head| head.revision) != input.expected_revision {
        return Err("archive_revision_conflict".into());
    }
    for segment in input.segments {
        transaction
            .execute(
                "INSERT OR IGNORE INTO segments(owner,run_id,id,ciphertext) VALUES(?1,?2,?3,?4)",
                params![
                    input.scope.principal_id,
                    input.scope.run_id,
                    segment.id,
                    segment.ciphertext
                ],
            )
            .map_err(|_| "archive_write_failed")?;
    }
    let value = ArchiveHead {
        scope: input.scope,
        revision: input.expected_revision + 1,
        updated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "archive_clock_invalid")?
            .as_millis() as u64,
        manifest: input.manifest,
    };
    transaction.execute("INSERT INTO heads(owner,run_id,project_id,conversation_id,revision,updated_at,manifest) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(owner,run_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,manifest=excluded.manifest", params![value.scope.principal_id,value.scope.run_id,value.scope.project_id,value.scope.conversation_id,value.revision as i64,value.updated_at as i64,value.manifest]).map_err(|_| "archive_write_failed")?;
    transaction.commit().map_err(|_| "archive_commit_failed")?;
    Ok(value)
}
#[tauri::command]
pub async fn run_archive_write(
    app: AppHandle,
    window: super::CallerWebview,
    payload: ArchiveWrite,
) -> Result<ArchiveHead, String> {
    super::ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || write(&mut connection(&app)?, payload))
        .await
        .map_err(|_| "archive_worker_failed")?
}
#[tauri::command]
pub async fn run_archive_read(
    app: AppHandle,
    window: super::CallerWebview,
    payload: ArchiveRead,
) -> Result<ArchiveReadResult, String> {
    super::ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if payload.segment_ids.len() > 8192 || payload.segment_ids.iter().any(|id| !valid_hash(id))
        {
            return Err("archive_query_invalid".into());
        }
        let connection = connection(&app)?;
        let head = head(&connection, &payload.scope)?;
        let mut segments = Vec::new();
        if head.is_some() {
            for id in payload.segment_ids {
                let ciphertext = connection
                    .query_row(
                        "SELECT ciphertext FROM segments WHERE owner=?1 AND run_id=?2 AND id=?3",
                        params![payload.scope.principal_id, payload.scope.run_id, id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|_| "archive_segment_missing")?;
                segments.push(ArchiveSegment { id, ciphertext });
            }
        }
        Ok(ArchiveReadResult { head, segments })
    })
    .await
    .map_err(|_| "archive_worker_failed")?
}
#[tauri::command]
pub async fn run_archive_list(
    app: AppHandle,
    window: super::CallerWebview,
    payload: ArchiveList,
) -> Result<Vec<ArchiveHead>, String> {
    super::ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_id(&payload.principal_id) || payload.after_run_id.as_ref().is_some_and(|id| !valid_id(id)) { return Err("archive_query_invalid".into()); }
        let connection = connection(&app)?;
        let mut statement = connection.prepare("SELECT run_id,project_id,conversation_id,revision,updated_at,manifest FROM heads WHERE owner=?1 AND (?2 IS NULL OR run_id>?2) ORDER BY run_id LIMIT 200").map_err(|_| "archive_read_failed")?;
        let rows = statement.query_map(params![payload.principal_id,payload.after_run_id], |row| Ok(ArchiveHead { scope: ArchiveScope { principal_id: payload.principal_id.clone(),run_id: row.get(0)?,project_id:row.get(1)?,conversation_id:row.get(2)? },revision:row.get::<_,i64>(3)? as u64,updated_at:row.get::<_,i64>(4)? as u64,manifest:row.get(5)? })).map_err(|_| "archive_read_failed")?;
        rows.map(|row| row.map_err(|_| "archive_record_invalid".into())).collect()
    }).await.map_err(|_| "archive_worker_failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renderer_wire_fixtures_match_strict_native_contracts() {
        let scope: ArchiveScope = serde_json::from_str(include_str!(
            "../../../tests/fixtures/run-archive-scope-v1.json"
        ))
        .unwrap();
        assert!(valid_scope(&scope));
        assert!(encrypted(
            include_str!("../../../tests/fixtures/run-archive-envelope-v1.json"),
            400_000
        ));
    }
    fn scope() -> ArchiveScope {
        ArchiveScope {
            principal_id: "account".into(),
            project_id: "project".into(),
            conversation_id: "chat".into(),
            run_id: "run".into(),
        }
    }
    fn envelope() -> String {
        include_str!("../../../tests/fixtures/run-archive-envelope-v1.json")
            .trim()
            .into()
    }
    #[test]
    fn atomic_owner_scoped_cas_and_immutable_segments() {
        let mut database = open(Path::new(":memory:")).unwrap();
        let input = || ArchiveWrite {
            scope: scope(),
            expected_revision: 0,
            manifest: envelope(),
            segments: vec![ArchiveSegment {
                id: "a".repeat(64),
                ciphertext: envelope(),
            }],
        };
        assert_eq!(write(&mut database, input()).unwrap().revision, 1);
        assert_eq!(
            write(&mut database, input()).err().unwrap(),
            "archive_revision_conflict"
        );
        let mut another = scope();
        another.principal_id = "other".into();
        assert!(head(&database, &another).unwrap().is_none());
        another = scope();
        another.conversation_id = "wrong-chat".into();
        assert_eq!(
            head(&database, &another).err().unwrap(),
            "archive_scope_mismatch"
        );
        let mut invalid = input();
        invalid.expected_revision = 1;
        invalid.manifest = "secret plaintext".into();
        assert_eq!(
            write(&mut database, invalid).err().unwrap(),
            "archive_payload_invalid"
        );
        assert_eq!(head(&database, &scope()).unwrap().unwrap().revision, 1);
    }
}
