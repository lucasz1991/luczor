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
            "lsp-v1-5.3.0|{}|{}",
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
    let resume = state(tx, &bound.principal_id, &bound.repository_id)
        .filter(|_| same_snapshot)
        .unwrap_or_default();
    if same_snapshot && resume.complete {
        return Ok(());
    }
    let mut current = State {
        status: "unavailable".into(),
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
    } else if let Some(root) = app.lsp_runtime_root() {
        let run = || -> Result<ResultSet, String> {
            let bytes = fs::read(root.join("runtime.json")).map_err(|_| "LSP manifest missing")?;
            if bytes.len() > 256 * 1024 {
                return Err("LSP manifest too large".into());
            }
            let manifest: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid LSP manifest")?;
            if manifest["version"] != 1
                || manifest["provider"] != "typescript-language-server@5.3.0"
            {
                return Err("LSP version mismatch".into());
            }
            let hashes = manifest["hashes"].as_object().ok_or("LSP hashes missing")?;
            let node = if cfg!(windows) { "node.exe" } else { "node" };
            for required in [
                node,
                "worker.mjs",
                "typescript/lib/tsserver.js",
                "typescript-language-server/lib/cli.mjs",
            ] {
                if !hashes.contains_key(required) {
                    return Err("LSP runtime incomplete".into());
                }
            }
            for (path, expected) in hashes {
                if Path::new(path).is_absolute() || path.split(['/', '\\']).any(|p| p == "..") {
                    return Err("Invalid LSP runtime path".into());
                }
                if sha256(&fs::read(root.join(path)).map_err(|_| "LSP runtime file missing")?)
                    != expected.as_str().unwrap_or("")
                {
                    return Err("LSP integrity check failed".into());
                }
            }
            let parent = app
                .graph_database_path()?
                .parent()
                .ok_or("LSP snapshot parent missing")?
                .join("lsp-snapshots");
            fs::create_dir_all(&parent).map_err(|_| "Cannot create LSP snapshot parent")?;
            let snapshot = Snapshot(parent.join(Uuid::new_v4().to_string()));
            fs::create_dir(&snapshot.0).map_err(|_| "Cannot create LSP snapshot")?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&snapshot.0, fs::Permissions::from_mode(0o700))
                    .map_err(|_| "Cannot protect LSP snapshot")?;
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
                    serde_json::to_vec(&serde_json::json!({ "files": sources, "next_file": resume.next_file, "next_symbol": resume.next_symbol }))
                        .map_err(|_| "LSP input invalid")?,
                ),
                Duration::from_secs(70),
                4 * 1024 * 1024,
                None,
                Some(&check),
            )?;
            if !output.success || output.stdout_truncated {
                return Err("LSP worker failed or exceeded limits".into());
            }
            serde_json::from_str(&output.stdout).map_err(|_| "Invalid LSP response".into())
        };
        match run() {
            Ok(result) => {
                current.complete = result.status == "ready";
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
                edges = result.edges;
            }
            Err(_) => current.status = "error".into(),
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
