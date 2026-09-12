//! Durable, owner-scoped public run checkpoints. A successful CAS is the pre-effect boundary.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const MAX_RESULT_BYTES: usize = 256 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunKind {
    Chat,
    Device,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Queued,
    Running,
    WaitingResource,
    WaitingApproval,
    Interrupted,
    Completed,
    Failed,
    Cancelled,
    Started,
    Acknowledged,
    OutcomeUnknown,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicCheckpoint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_event_sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    master_epoch: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRecord {
    pub kind: RunKind,
    pub principal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_hash: Option<String>,
    pub state: RunState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<PublicCheckpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredRun {
    #[serde(flatten)]
    pub record: RunRecord,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalRead {
    owner_principal_id: String,
    run_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalList {
    owner_principal_id: String,
    kind: Option<RunKind>,
    limit: Option<u32>,
    #[serde(default)]
    states: Vec<RunState>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalTransition {
    pub owner_principal_id: String,
    pub expected_revision: u64,
    pub record: RunRecord,
}
fn id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 300 && !value.chars().any(char::is_control)
}
fn validate(input: &JournalTransition) -> Result<(), String> {
    let record = &input.record;
    if !id(&input.owner_principal_id)
        || input.owner_principal_id != record.principal_id
        || !id(&record.run_id)
        || input.expected_revision >= MAX_REVISION
        || [
            &record.device_id,
            &record.job_id,
            &record.conversation_id,
            &record.project_id,
        ]
        .into_iter()
        .flatten()
        .any(|value| !id(value))
    {
        return Err("journal_identity_invalid".into());
    }
    if record
        .payload_hash
        .as_ref()
        .is_some_and(|hash| hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("journal_payload_hash_invalid".into());
    }
    if let Some(checkpoint) = &record.checkpoint {
        if checkpoint
            .message_id
            .as_ref()
            .is_some_and(|value| !id(value))
            || checkpoint
                .summary
                .as_ref()
                .is_some_and(|value| value.chars().count() > 6000)
            || checkpoint
                .last_event_sequence
                .is_some_and(|value| value > MAX_REVISION)
            || checkpoint
                .attempt_id
                .as_ref()
                .is_some_and(|value| uuid::Uuid::parse_str(value).is_err())
            || checkpoint
                .master_epoch
                .is_some_and(|value| value == 0 || value > MAX_REVISION)
            || (record.kind == RunKind::Chat
                && (checkpoint.attempt_id.is_some() || checkpoint.master_epoch.is_some()))
        {
            return Err("journal_checkpoint_invalid".into());
        }
    }
    if record.kind == RunKind::Chat
        && (record.result.is_some()
            || record.job_id.is_some()
            || matches!(
                record.state,
                RunState::Started | RunState::Acknowledged | RunState::OutcomeUnknown
            ))
    {
        return Err("journal_chat_record_invalid".into());
    }
    if let Some(result) = &record.result {
        if serde_json::to_vec(result)
            .map_err(|_| "journal_result_invalid")?
            .len()
            > MAX_RESULT_BYTES
        {
            return Err("journal_result_too_large".into());
        }
    }
    Ok(())
}
fn state_text(state: &RunState) -> String {
    serde_json::to_value(state)
        .expect("enum serializes")
        .as_str()
        .expect("enum string")
        .into()
}
fn kind_text(kind: &RunKind) -> &'static str {
    if *kind == RunKind::Chat {
        "chat"
    } else {
        "device"
    }
}
fn open(path: &Path) -> Result<Connection, String> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("journal_link_rejected".into());
    }
    let connection = Connection::open(path).map_err(|_| "journal_unavailable")?;
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(|_| "journal_unavailable")?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS run_journal (
          owner TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
          revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, record TEXT NOT NULL,
          PRIMARY KEY(owner, run_id));
        CREATE INDEX IF NOT EXISTS run_journal_owner_time ON run_journal(owner,updated_at DESC);",
        )
        .map_err(|_| "journal_unavailable")?;
    Ok(connection)
}
fn connection(app: &AppHandle) -> Result<Connection, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "journal_unavailable")?;
    fs::create_dir_all(&directory).map_err(|_| "journal_unavailable")?;
    open(&directory.join("device-runs.sqlite3"))
}
fn read(connection: &Connection, owner: &str, run: &str) -> Result<Option<StoredRun>, String> {
    if !id(owner) || !id(run) {
        return Err("journal_identity_invalid".into());
    }
    let value: Option<String> = connection
        .query_row(
            "SELECT record FROM run_journal WHERE owner=?1 AND run_id=?2",
            params![owner, run],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "journal_read_failed")?;
    value
        .map(|value| serde_json::from_str(&value).map_err(|_| "journal_record_invalid".into()))
        .transpose()
}
fn transition(connection: &mut Connection, input: JournalTransition) -> Result<StoredRun, String> {
    validate(&input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "journal_busy")?;
    let previous = read(
        &transaction,
        &input.owner_principal_id,
        &input.record.run_id,
    )?;
    if previous.as_ref().map_or(0, |value| value.revision) != input.expected_revision {
        return Err("journal_revision_conflict".into());
    }
    if let Some(previous) = &previous {
        let mut immutable_before = previous.record.clone();
        immutable_before.state = input.record.state.clone();
        immutable_before.checkpoint = input.record.checkpoint.clone();
        immutable_before.result = input.record.result.clone();
        if immutable_before != input.record {
            return Err("journal_identity_changed".into());
        }
        if matches!(
            previous.record.state,
            RunState::Completed | RunState::Acknowledged | RunState::Failed | RunState::Cancelled
        ) && previous.record.state != input.record.state
            && !(previous.record.kind == RunKind::Device
                && previous.record.state == RunState::Completed
                && input.record.state == RunState::Acknowledged)
        {
            return Err("journal_terminal_state".into());
        }
        if previous.record.state == RunState::OutcomeUnknown
            && !matches!(
                input.record.state,
                RunState::OutcomeUnknown | RunState::Cancelled
            )
        {
            return Err("journal_outcome_unknown".into());
        }
        if matches!(
            previous.record.state,
            RunState::Completed | RunState::Acknowledged
        ) && previous.record.result != input.record.result
        {
            return Err("journal_result_immutable".into());
        }
        let before_sequence = previous
            .record
            .checkpoint
            .as_ref()
            .and_then(|c| c.last_event_sequence);
        let after_sequence = input
            .record
            .checkpoint
            .as_ref()
            .and_then(|c| c.last_event_sequence);
        if before_sequence.is_some() && after_sequence < before_sequence {
            return Err("journal_sequence_stale".into());
        }
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "journal_clock_invalid")?
        .as_millis() as u64;
    let stored = StoredRun {
        record: input.record,
        revision: input.expected_revision + 1,
        created_at: previous.map_or(now, |record| record.created_at),
        updated_at: now,
    };
    let json = serde_json::to_string(&stored).map_err(|_| "journal_record_invalid")?;
    transaction.execute("INSERT INTO run_journal(owner,run_id,kind,state,revision,updated_at,record) VALUES(?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT(owner,run_id) DO UPDATE SET state=excluded.state,revision=excluded.revision,updated_at=excluded.updated_at,record=excluded.record",
        params![stored.record.principal_id, stored.record.run_id, kind_text(&stored.record.kind), state_text(&stored.record.state), stored.revision as i64, now as i64, json])
        .map_err(|_| "journal_write_failed")?;
    transaction.commit().map_err(|_| "journal_commit_failed")?;
    Ok(stored)
}

#[tauri::command]
pub async fn device_run_journal_read(
    app: AppHandle,
    window: super::CallerWebview,
    payload: JournalRead,
) -> Result<Option<StoredRun>, String> {
    super::ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        read(
            &connection(&app)?,
            &payload.owner_principal_id,
            &payload.run_id,
        )
    })
    .await
    .map_err(|_| "journal_worker_failed")?
}
#[tauri::command]
pub async fn device_run_journal_transition(
    app: AppHandle,
    window: super::CallerWebview,
    payload: JournalTransition,
) -> Result<StoredRun, String> {
    super::ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || transition(&mut connection(&app)?, payload))
        .await
        .map_err(|_| "journal_worker_failed")?
}
#[tauri::command]
pub async fn device_run_journal_list(
    app: AppHandle,
    window: super::CallerWebview,
    payload: JournalList,
) -> Result<Vec<StoredRun>, String> {
    super::ensure_main_webview(&window)?;
    if !id(&payload.owner_principal_id)
        || payload.states.len() > 11
        || payload.limit.is_some_and(|limit| limit == 0 || limit > 200)
    {
        return Err("journal_query_invalid".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let connection = connection(&app)?;
        let mut statement = connection.prepare("SELECT record FROM run_journal WHERE owner=?1 AND (?2 IS NULL OR kind=?2)
            AND (?3='[]' OR state IN (SELECT value FROM json_each(?3))) ORDER BY updated_at DESC,run_id LIMIT ?4")
            .map_err(|_| "journal_read_failed")?;
        let states = serde_json::to_string(&payload.states).map_err(|_| "journal_query_invalid")?;
        let rows = statement.query_map(params![payload.owner_principal_id, payload.kind.as_ref().map(kind_text), states, payload.limit.unwrap_or(100)],
            |row| row.get::<_, String>(0)).map_err(|_| "journal_read_failed")?;
        rows.map(|value| serde_json::from_str(&value.map_err(|_| "journal_read_failed")?).map_err(|_| "journal_record_invalid".into())).collect()
    }).await.map_err(|_| "journal_worker_failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(owner: &str) -> RunRecord {
        RunRecord {
            kind: RunKind::Chat,
            principal_id: owner.into(),
            device_id: Some("device".into()),
            job_id: None,
            run_id: "run".into(),
            conversation_id: Some("conversation".into()),
            project_id: Some("project".into()),
            payload_hash: Some("a".repeat(64)),
            state: RunState::Queued,
            checkpoint: None,
            result: None,
        }
    }
    fn put(
        connection: &mut Connection,
        record: RunRecord,
        expected_revision: u64,
    ) -> Result<StoredRun, String> {
        transition(
            connection,
            JournalTransition {
                owner_principal_id: record.principal_id.clone(),
                expected_revision,
                record,
            },
        )
    }
    #[test]
    fn owner_isolation_cas_and_restart_preserve_exact_checkpoint() {
        let directory =
            std::env::temp_dir().join(format!("luczor-journal-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("journal.sqlite3");
        let mut first = open(&path).unwrap();
        let mut current = put(&mut first, record("alice"), 0).unwrap();
        assert_eq!(
            put(&mut first, record("alice"), 0).unwrap_err(),
            "journal_revision_conflict"
        );
        assert!(read(&first, "bob", "run").unwrap().is_none());
        current.record.state = RunState::Running;
        current.record.checkpoint = Some(PublicCheckpoint {
            message_id: Some("m1".into()),
            summary: Some("Public progress".into()),
            last_event_sequence: Some(2),
            attempt_id: None,
            master_epoch: None,
        });
        let saved = put(&mut first, current.record, 1).unwrap();
        drop(first);
        let second = open(&path).unwrap();
        assert_eq!(read(&second, "alice", "run").unwrap(), Some(saved));
        drop(second);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn identity_and_terminal_results_cannot_be_rewritten() {
        let mut connection = open(Path::new(":memory:")).unwrap();
        let current = put(&mut connection, record("alice"), 0).unwrap();
        let mut changed = current.record.clone();
        changed.project_id = Some("other".into());
        assert_eq!(
            put(&mut connection, changed, 1).unwrap_err(),
            "journal_identity_changed"
        );
        let mut done = current.record;
        done.state = RunState::Completed;
        put(&mut connection, done.clone(), 1).unwrap();
        done.state = RunState::Running;
        assert_eq!(
            put(&mut connection, done, 2).unwrap_err(),
            "journal_terminal_state"
        );
    }
    #[test]
    fn private_chat_fields_and_cross_owner_writes_are_rejected() {
        let mut value = record("alice");
        value.result = Some(serde_json::json!({"prompt":"must not persist"}));
        assert_eq!(
            validate(&JournalTransition {
                owner_principal_id: "alice".into(),
                expected_revision: 0,
                record: value
            })
            .unwrap_err(),
            "journal_chat_record_invalid"
        );
        assert!(validate(&JournalTransition {
            owner_principal_id: "bob".into(),
            expected_revision: 0,
            record: record("alice")
        })
        .is_err());
        assert!(
            serde_json::from_value::<PublicCheckpoint>(serde_json::json!({"rawPrompt":"no"}))
                .is_err()
        );
    }
}
