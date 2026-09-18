use super::*;
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Serialize)]
pub(super) struct Source {
    pub path: String,
    pub content: String,
    pub hash: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub(super) struct State {
    #[serde(default)]
    pub complete: bool,
    #[serde(default)]
    pub next_file: usize,
    #[serde(default)]
    pub next_symbol: usize,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default)]
    pub failed_files: usize,
    pub scanned: usize,
    pub files: usize,
    pub edges: usize,
}

#[derive(Deserialize, Serialize)]
struct Edge {
    source: String,
    target: String,
    symbol: String,
    source_line: usize,
    target_line: usize,
}

#[derive(Deserialize)]
struct ResultSet {
    next_file: usize,
    next_symbol: usize,
    status: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    phase: Option<String>,
    #[serde(default)]
    failed_files: usize,
    scanned: usize,
    edges: Vec<Edge>,
}

pub(super) fn initialize(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS repository_lsp_state (
        principal_id TEXT NOT NULL, repository_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
        PRIMARY KEY(principal_id, repository_id),
        FOREIGN KEY(principal_id, repository_id) REFERENCES repository_bindings(principal_id, repository_id) ON DELETE CASCADE
    );").map_err(db_error)
}

pub(super) fn state(db: &Connection, principal: &str, repo: &str) -> Option<State> {
    let value: String = db
        .query_row(
            "SELECT state FROM repository_lsp_state WHERE principal_id=?1 AND repository_id=?2",
            params![principal, repo],
            |r| r.get(0),
        )
        .ok()?;
    serde_json::from_str(&value).ok()
}

pub(super) fn supports(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|s| s.to_str()),
        Some("ts" | "tsx" | "js" | "jsx" | "mts" | "mjs" | "cts" | "cjs")
    )
}

// Owned snapshots are outside the repository. Drop only this UUID directory,
// including cancellation/error paths; never remove a user-selected root.
struct Snapshot(PathBuf);
impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn enrich<D: GraphDatabaseProvider>(
    app: &D,
    tx: &Transaction<'_>,
    bound: &BoundRepository,
    sources: &[Source],
    limited: bool,
    cancellation: Option<&AtomicBool>,
) -> Result<(), String> {
    let fingerprint = sha256(
        format!(
            "lsp-v2-5.3.0|{}|{}",
            limited,
            sources
                .iter()
                .map(|s| format!("{}:{}", s.path, s.hash))
                .collect::<Vec<_>>()
                .join("|")
        )
        .as_bytes(),
    );
    let previous: Option<String> = tx.query_row("SELECT fingerprint FROM repository_lsp_state WHERE principal_id=?1 AND repository_id=?2", params![bound.principal_id, bound.repository_id], |r| r.get(0)).optional().map_err(db_error)?;
    let same_snapshot = previous.as_deref() == Some(&fingerprint);
    let mut resume = state(tx, &bound.principal_id, &bound.repository_id)
        .filter(|_| same_snapshot)
        .unwrap_or_default();
    if same_snapshot && resume.complete {
        return Ok(());
    }
    // A later explicit/index-maintenance pass retries incomplete file analysis;
    // an exhausted cursor must never silently turn prior failures into ready.
    if resume.next_file >= sources.len() && resume.failed_files > 0 {
        resume.next_file = 0;
        resume.next_symbol = 0;
        resume.scanned = 0;
        resume.failed_files = 0;
    }
    let mut current = State {
        status: "unavailable".into(),
        reason: Some("lsp_runtime_missing".into()),
        phase: Some("runtime".into()),
        failed_files: resume.failed_files,
        files: sources.len(),
        next_file: resume.next_file,
        next_symbol: resume.next_symbol,
        scanned: resume.scanned,
        edges: resume.edges,
        ..Default::default()
    };
    let mut edges = Vec::new();
    if sources.is_empty() {
        current.status = "not_applicable".into();
        current.reason = None;
        current.phase = None;
    } else if let Some(root) = app.lsp_runtime_root() {
        let run = || -> Result<ResultSet, String> {
            let bytes = fs::read(root.join("runtime.json")).map_err(|_| "lsp_runtime_missing")?;
            if bytes.len() > 256 * 1024 {
                return Err("lsp_runtime_invalid".into());
            }
            let manifest: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| "lsp_runtime_invalid")?;
            if manifest["version"] != 1
                || manifest["provider"] != "typescript-language-server@5.3.0"
            {
                return Err("lsp_runtime_invalid".into());
            }
            let hashes = manifest["hashes"]
                .as_object()
                .ok_or("lsp_runtime_invalid")?;
            let node = if cfg!(windows) { "node.exe" } else { "node" };
            for required in [
                node,
                "worker.mjs",
                "typescript/lib/tsserver.js",
                "typescript-language-server/lib/cli.mjs",
            ] {
                if !hashes.contains_key(required) {
                    return Err("lsp_runtime_missing".into());
                }
            }
            for (path, expected) in hashes {
                if Path::new(path).is_absolute() || path.split(['/', '\\']).any(|p| p == "..") {
                    return Err("lsp_runtime_invalid".into());
                }
                if sha256(&fs::read(root.join(path)).map_err(|_| "lsp_runtime_missing")?)
                    != expected.as_str().unwrap_or("")
                {
                    return Err("lsp_integrity_failed".into());
                }
            }
            let parent = app
                .graph_database_path()?
                .parent()
                .ok_or("lsp_snapshot_failed")?
                .join("lsp-snapshots");
            fs::create_dir_all(&parent).map_err(|_| "lsp_snapshot_failed")?;
            let snapshot = Snapshot(parent.join(Uuid::new_v4().to_string()));
            fs::create_dir(&snapshot.0).map_err(|_| "lsp_snapshot_failed")?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&snapshot.0, fs::Permissions::from_mode(0o700))
                    .map_err(|_| "lsp_snapshot_failed")?;
            }
            let mut command = Command::new(root.join(node));
            command
                .args(["--max-old-space-size=384"])
                .arg(root.join("worker.mjs"))
                .arg(&snapshot.0)
                .current_dir(&snapshot.0)
                .env_remove("NODE_OPTIONS")
                .env_remove("NODE_PATH");
            let check = || {
                if cancellation.is_some_and(|c| c.load(Ordering::Acquire)) {
                    Err("LSP paused for foreground work".into())
                } else {
                    Ok(())
                }
            };
            let output = super::super::process::run_bounded_command_scoped(
                command,
                Some(
                    serde_json::to_vec(&serde_json::json!({ "files": sources, "next_file": resume.next_file, "next_symbol": resume.next_symbol, "scanned": resume.scanned, "failed_files": resume.failed_files }))
                        .map_err(|_| "lsp_input_invalid")?,
                ),
                Duration::from_secs(70),
                4 * 1024 * 1024,
                None,
                Some(&check),
            ).map_err(|_| "lsp_worker_start_failed")?;
            if output.timed_out {
                return Err("lsp_worker_timeout".into());
            }
            if output.stdout_truncated {
                return Err("lsp_response_limit".into());
            }
            if !output.success {
                return Err("lsp_worker_failed".into());
            }
            serde_json::from_str(&output.stdout).map_err(|_| "lsp_protocol_error".into())
        };
        match run() {
            Ok(result) => {
                current.complete = result.status == "ready";
                current.reason = result.reason.as_deref().map(safe_reason).map(str::to_owned);
                current.phase = result
                    .phase
                    .as_deref()
                    .and_then(safe_phase)
                    .map(str::to_owned);
                current.failed_files = result.failed_files.min(sources.len());
                current.next_file = result.next_file.min(sources.len());
                current.next_symbol = result.next_symbol;
                current.status = if result.status == "error" {
                    "error"
                } else if result.status == "ready" && !limited {
                    "ready"
                } else {
                    "partial"
                }
                .into();
                current.scanned = result.scanned.min(sources.len());
                if limited && current.reason.is_none() {
                    current.reason = Some("lsp_source_limit".into());
                }
                edges = result.edges;
            }
            Err(error) => {
                current.status = "error".into();
                current.reason = Some(safe_reason(&error).into());
            }
        }
    }
    if cancellation.is_some_and(|c| c.load(Ordering::Acquire)) {
        return Err("Repository indexing paused for foreground work.".into());
    }
    if !same_snapshot {
        tx.execute("DELETE FROM repository_edges WHERE edge_kind='lsp_reference' AND file_id IN (SELECT id FROM repository_files WHERE principal_id=?1 AND repository_id=?2)", params![bound.principal_id, bound.repository_id]).map_err(db_error)?;
    }
    let allowed: HashMap<_, _> = sources.iter().map(|s| (s.path.as_str(), s)).collect();
    for edge in edges.into_iter().take(10000) {
        let (Some(source), Some(target)) = (
            allowed.get(edge.source.as_str()),
            allowed.get(edge.target.as_str()),
        ) else {
            continue;
        };
        if edge.source_line == 0
            || edge.target_line == 0
            || edge.source_line > source.content.lines().count()
            || edge.target_line > target.content.lines().count()
            || edge.symbol.len() > 256
        {
            continue;
        }
        let value = serde_json::json!({"relation": edge, "source_hash":source.hash, "target_hash":target.hash}).to_string();
        current.edges += tx.execute("INSERT INTO repository_edges(file_id,edge_kind,target) SELECT id,'lsp_reference',?4 FROM repository_files f WHERE principal_id=?1 AND repository_id=?2 AND relative_path=?3 AND NOT EXISTS(SELECT 1 FROM repository_edges e WHERE e.file_id=f.id AND e.edge_kind='lsp_reference' AND e.target=?4)", params![bound.principal_id, bound.repository_id, source.path, value]).map_err(db_error)?;
    }
    tx.execute("INSERT INTO repository_lsp_state(principal_id,repository_id,fingerprint,state) VALUES(?1,?2,?3,?4) ON CONFLICT(principal_id,repository_id) DO UPDATE SET fingerprint=excluded.fingerprint,state=excluded.state", params![bound.principal_id, bound.repository_id, fingerprint, serde_json::to_string(&current).map_err(|_| "Invalid LSP state")?]).map_err(db_error)?;
    Ok(())
}

// Never publish worker stderr, paths, repository text or arbitrary error messages.
fn safe_reason(value: &str) -> &str {
    match value {
        "lsp_runtime_missing"
        | "lsp_runtime_invalid"
        | "lsp_integrity_failed"
        | "lsp_snapshot_failed"
        | "lsp_input_invalid"
        | "lsp_worker_start_failed"
        | "lsp_worker_timeout"
        | "lsp_worker_failed"
        | "lsp_response_limit"
        | "lsp_protocol_error"
        | "lsp_server_start_failed"
        | "lsp_server_exited"
        | "lsp_request_timeout"
        | "lsp_request_rejected"
        | "lsp_capability_missing"
        | "lsp_batch_limit"
        | "lsp_source_limit"
        | "lsp_file_failures" => value,
        _ => "lsp_analysis_failed",
    }
}

fn safe_phase(value: &str) -> Option<&str> {
    match value {
        "runtime" | "initialize" | "symbols" | "references" | "complete" => Some(value),
        _ => None,
    }
}

#[cfg(test)]
mod diagnostics_tests {
    use super::*;
    #[test]
    fn diagnostics_are_codes_only_and_old_states_remain_readable() {
        assert_eq!(safe_reason("lsp_request_timeout"), "lsp_request_timeout");
        assert_eq!(
            safe_reason("lsp_private_path_secret"),
            "lsp_analysis_failed"
        );
        assert_eq!(
            safe_reason("C:/private/file.ts: SECRET"),
            "lsp_analysis_failed"
        );
        assert_eq!(safe_phase("references"), Some("references"));
        assert_eq!(safe_phase("PRIVATE_SOURCE"), None);
        let old: State =
            serde_json::from_str(r#"{"status":"ready","scanned":2,"files":2,"edges":1}"#).unwrap();
        assert_eq!(old.failed_files, 0);
        assert!(old.reason.is_none());
    }
}

pub(super) fn relations(
    db: &Connection,
    bound: &BoundRepository,
    path: &str,
) -> Result<Vec<String>, String> {
    let mut query = db.prepare("SELECT e.target FROM repository_edges e JOIN repository_files f ON f.id=e.file_id WHERE f.principal_id=?1 AND f.repository_id=?2 AND f.relative_path=?3 AND e.edge_kind='lsp_reference' LIMIT 8").map_err(db_error)?;
    let rows = query
        .query_map(
            params![bound.principal_id, bound.repository_id, path],
            |r| r.get::<_, String>(0),
        )
        .map_err(db_error)?;
    let mut result = Vec::new();
    for row in rows {
        let value: serde_json::Value =
            serde_json::from_str(&row.map_err(db_error)?).map_err(|_| "Invalid saved LSP edge")?;
        let edge: Edge = serde_json::from_value(value["relation"].clone())
            .map_err(|_| "Invalid saved LSP relation")?;
        let mut valid = edge.source == path;
        for (file, expected) in [
            (&edge.source, &value["source_hash"]),
            (&edge.target, &value["target_hash"]),
        ] {
            let candidate = bound.root_path.join(file);
            valid &= candidate.canonicalize().ok().is_some_and(|p| {
                p.starts_with(&bound.root_path)
                    && !is_secret_file(&p)
                    && fs::metadata(&p).is_ok_and(|m| m.len() <= MAX_FILE_BYTES)
                    && fs::read(p).is_ok_and(|b| sha256(&b) == expected.as_str().unwrap_or(""))
            });
        }
        if valid {
            result.push(format!(
                "LSP reference: {}:{} -> {}:{} ({})",
                edge.source, edge.source_line, edge.target, edge.target_line, edge.symbol
            ));
        }
    }
    Ok(result)
}
