//! Project-bound, prompt-free metadata only. Raw configuration never leaves native memory.
use super::{valid_claude_model, valid_model};
use crate::commands::{codex, project_workspace::agent_workspace_snapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};
use tauri::{AppHandle};

const MAX_FRAME: usize = 1_000_000;
const MAX_FRAMES: usize = 128;
const MAX_BYTES: usize = 2_000_000;
const TIMEOUT: Duration = Duration::from_secs(15);
const UNAVAILABLE: &str = "agent_default_model_unavailable";
const CHANGED: &str = "agent_default_model_changed";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefaultModelRequest {
    pub adapter_id: String,
    pub principal_id: String,
    pub project_id: String,
    pub expected_root_path: String,
    pub expected_workspace_updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultModelResolution {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    revision: String,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

fn check_binding(app: &AppHandle, request: &DefaultModelRequest) -> Result<PathBuf, String> {
    if !matches!(request.adapter_id.as_str(), "codex" | "claude") {
        return Err("Invalid agent adapter.".into());
    }
    let (root, revision) =
        agent_workspace_snapshot(app, &request.principal_id, &request.project_id)?;
    if root != Path::new(&request.expected_root_path)
        || revision != request.expected_workspace_updated_at
    {
        return Err("Agent project binding changed.".into());
    }
    Ok(root)
}

fn unconfirmed(adapter: &str) -> DefaultModelResolution {
    DefaultModelResolution {
        status: "unconfirmed",
        model: None,
        revision: "unavailable".into(),
        source: source(adapter),
        reason: Some(UNAVAILABLE),
    }
}

fn source(adapter: &str) -> &'static str {
    if adapter == "codex" {
        "codex-effective-config"
    } else {
        "claude-context-summary"
    }
}

pub async fn resolve_for_window(
    app: AppHandle,
    window: crate::commands::CallerWebview,
    payload: DefaultModelRequest,
) -> Result<DefaultModelResolution, String> {
    crate::commands::ensure_main_webview(&window)?;
    check_binding(&app, &payload)?;
    tauri::async_runtime::spawn_blocking(move || {
        let check = || check_binding(&app, &payload).map(|_| ());
        let result = resolve(&app, &payload, None, &check);
        check()?;
        // Never forward CLI stderr, settings, token fields, file paths or protocol errors.
        Ok(result.unwrap_or_else(|_| unconfirmed(&payload.adapter_id)))
    })
    .await
    .map_err(|_| UNAVAILABLE.to_string())?
}

/// Only default-derived pins have a revision; explicit caller pins are not rewritten.
pub fn validate_default_binding(
    app: &AppHandle,
    request: &DefaultModelRequest,
    model: Option<&str>,
    revision: Option<&str>,
    executable: &Path,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let Some(model) = model.filter(|model| !matches!(*model, "default" | "auto" | "inherit"))
    else {
        return Err(UNAVAILABLE.into());
    };
    let Some(revision) = revision else {
        return Ok(());
    };
    if revision.len() != 64 || !revision.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(CHANGED.into());
    }
    let resolved = resolve(app, request, Some(executable), check)?;
    compare_binding(&resolved, model, revision)
}

fn compare_binding(
    resolved: &DefaultModelResolution,
    model: &str,
    revision: &str,
) -> Result<(), String> {
    if resolved.status != "confirmed"
        || resolved.model.as_deref() != Some(model)
        || resolved.revision != revision
    {
        return Err(CHANGED.into());
    }
    Ok(())
}

fn resolve(
    app: &AppHandle,
    request: &DefaultModelRequest,
    bound_executable: Option<&Path>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<DefaultModelResolution, String> {
    let root = check_binding(app, request)?;
    let executable = if let Some(executable) = bound_executable {
        executable.to_owned()
    } else if request.adapter_id == "codex" {
        codex::find_codex().ok_or(UNAVAILABLE)?
    } else {
        crate::commands::claude::metadata_executable(app)?
    };
    let mut command = metadata_command(&request.adapter_id, &executable, &root);
    let environment = environment_revision(&request.adapter_id);
    let executable_id = executable_identity(&executable)?;
    let metadata = query_metadata(&mut command, &request.adapter_id, &root, check)?;
    check()?;
    check_binding(app, request)?;
    if environment_revision(&request.adapter_id) != environment
        || executable_identity(&executable)? != executable_id
    {
        return Err(CHANGED.into());
    }
    let mut normalized_request = request.clone();
    normalized_request.expected_root_path = root.to_string_lossy().into_owned();
    resolution(&normalized_request, &metadata, &executable_id, &environment)
}

fn executable_identity(path: &Path) -> Result<Value, String> {
    let meta = path.metadata().map_err(|_| UNAVAILABLE)?;
    Ok(
        json!({"path":path, "bytes":meta.len(), "modified":meta.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t|t.as_nanos().to_string())}),
    )
}

fn environment_revision(adapter: &str) -> String {
    let mut values: Vec<_> = std::env::vars_os()
        .filter(|(key, _)| {
            let key = key.to_string_lossy().to_ascii_uppercase();
            if adapter == "codex" {
                matches!(
                    key.as_str(),
                    "CODEX_HOME" | "HOME" | "USERPROFILE" | "OPENAI_BASE_URL" | "OPENAI_API_BASE"
                )
            } else {
                (key.starts_with("ANTHROPIC_")
                    || key.starts_with("CLAUDE_CODE_")
                    || key.starts_with("AWS_")
                    || key.starts_with("AZURE_")
                    || key.starts_with("GOOGLE_"))
                    && !matches!(
                        key.as_str(),
                        "CLAUDE_CODE_EFFORT_LEVEL"
                            | "CLAUDE_CODE_SUBAGENT_MODEL"
                            | "CLAUDE_CODE_EXTRA_BODY"
                            | "CLAUDE_CODE_DISABLE_AUTO_MEMORY"
                    )
                    || matches!(key.as_str(), "CLAUDE_CONFIG_DIR" | "HOME" | "USERPROFILE")
            }
        })
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    values.sort();
    // This digest is folded into an opaque revision; no environment value is returned or logged.
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&values).unwrap_or_default())
    )
}

fn metadata_command(adapter: &str, executable: &Path, root: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if adapter == "codex" {
        command.args(["app-server", "--listen", "stdio://"]);
    } else {
        // Same model/setting/plugin sources as claude-worker.ts. Metadata never needs a tool or hook.
        command.args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--setting-sources",
            "",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
            "--no-session-persistence",
            "--settings",
            "{\"disableAllHooks\":true,\"autoMemoryEnabled\":false}",
        ]);
        for key in [
            "CLAUDE_CODE_EFFORT_LEVEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
            "CLAUDE_CODE_EXTRA_BODY",
            "NODE_OPTIONS",
            "NODE_PATH",
        ] {
            command.env_remove(key);
        }
        command.env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1");
        for path in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            if Path::new(path).is_file() {
                command.env("CLAUDE_CODE_GIT_BASH_PATH", path);
                break;
            }
        }
    }
    codex::configure_process(&mut command);
    command
}

struct MetadataProcess {
    child: Child,
    lifetime: Option<codex::LifetimeGuard>,
    receiver: Option<Receiver<Result<Value, ()>>>,
    reader: Option<std::thread::JoinHandle<()>>,
}

impl Drop for MetadataProcess {
    fn drop(&mut self) {
        // Drop the receiver first, unblocking a bounded reader send before joining it.
        self.receiver.take();
        self.lifetime.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = crate::commands::process::finish_thread(
                reader,
                Instant::now() + Duration::from_secs(2),
                "metadata",
            );
        }
    }
}

fn read_frames(reader: impl Read, sender: mpsc::SyncSender<Result<Value, ()>>) {
    let mut reader = BufReader::new(reader);
    let mut bytes_read = 0;
    for _ in 0..MAX_FRAMES {
        let mut line = Vec::new();
        let read = reader
            .by_ref()
            .take((MAX_FRAME + 1) as u64)
            .read_until(b'\n', &mut line);
        match read {
            Ok(0) => return,
            Ok(len) if len <= MAX_FRAME && bytes_read + len <= MAX_BYTES => bytes_read += len,
            _ => {
                let _ = sender.send(Err(()));
                return;
            }
        }
        let parsed = serde_json::from_slice(&line).map_err(|_| ());
        let failed = parsed.is_err();
        if sender.send(parsed).is_err() || failed {
            return;
        }
    }
    let _ = sender.send(Err(()));
}

fn rpc(
    process: &mut MetadataProcess,
    adapter: &str,
    id: &str,
    request: Value,
    deadline: Instant,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    check()?;
    let stdin = process.child.stdin.as_mut().ok_or(UNAVAILABLE)?;
    let mut bytes = serde_json::to_vec(&request).map_err(|_| UNAVAILABLE)?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .and_then(|_| stdin.flush())
        .map_err(|_| UNAVAILABLE)?;
    loop {
        check()?;
        if Instant::now() >= deadline {
            return Err(UNAVAILABLE.into());
        }
        match process
            .receiver
            .as_ref()
            .ok_or(UNAVAILABLE)?
            .recv_timeout(Duration::from_millis(40))
        {
            Ok(Ok(frame)) => {
                if let Some(result) = response(&frame, adapter, id)? {
                    return Ok(result);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            _ => return Err(UNAVAILABLE.into()),
        }
    }
}

fn response(frame: &Value, adapter: &str, id: &str) -> Result<Option<Value>, String> {
    if adapter == "codex" && frame.get("id").and_then(Value::as_str) == Some(id) {
        return frame
            .get("result")
            .cloned()
            .map(Some)
            .ok_or_else(|| UNAVAILABLE.into());
    }
    if adapter == "claude"
        && frame["type"] == "control_response"
        && frame["response"]["request_id"] == id
    {
        if frame["response"]["subtype"] != "success" {
            return Err(UNAVAILABLE.into());
        }
        return frame["response"]
            .get("response")
            .cloned()
            .map(Some)
            .ok_or_else(|| UNAVAILABLE.into());
    }
    // No user messages, turn/start, prompts or tool responses are ever sent by this protocol.
    Ok(None)
}

fn query_metadata(
    command: &mut Command,
    adapter: &str,
    root: &Path,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    check()?;
    let deadline = Instant::now() + TIMEOUT;
    let child = command.spawn().map_err(|_| UNAVAILABLE)?;
    let mut process = MetadataProcess {
        child,
        lifetime: None,
        receiver: None,
        reader: None,
    };
    check()?;
    process.lifetime = Some(codex::LifetimeGuard::attach(&process.child)?);
    check()?;
    let stdout = process.child.stdout.take().ok_or(UNAVAILABLE)?;
    let (sender, receiver) = mpsc::sync_channel(8);
    process.receiver = Some(receiver);
    process.reader = Some(std::thread::spawn(move || read_frames(stdout, sender)));
    if adapter == "codex" {
        rpc(
            &mut process,
            adapter,
            "init",
            json!({"id":"init","method":"initialize","params":{"clientInfo":{"name":"luczor_default_model","version":"1"},"capabilities":{"experimentalApi":true}}}),
            deadline,
            check,
        )?;
        let stdin = process.child.stdin.as_mut().ok_or(UNAVAILABLE)?;
        stdin
            .write_all(b"{\"method\":\"initialized\",\"params\":{}}\n")
            .map_err(|_| UNAVAILABLE)?;
        rpc(
            &mut process,
            adapter,
            "config",
            json!({"id":"config","method":"config/read","params":{"includeLayers":false,"cwd":root}}),
            deadline,
            check,
        )
    } else {
        rpc(
            &mut process,
            adapter,
            "init",
            json!({"type":"control_request","request_id":"init","request":{"subtype":"initialize"}}),
            deadline,
            check,
        )?;
        let summary = rpc(
            &mut process,
            adapter,
            "model",
            json!({"type":"control_request","request_id":"model","request":{"subtype":"get_context_usage","detail":"summary"}}),
            deadline,
            check,
        )?;
        let settings = rpc(
            &mut process,
            adapter,
            "settings",
            json!({"type":"control_request","request_id":"settings","request":{"subtype":"get_settings"}}),
            deadline,
            check,
        )?;
        Ok(json!({"model":summary.get("model"),"settings":settings}))
    }
}

fn resolution(
    request: &DefaultModelRequest,
    metadata: &Value,
    executable_id: &Value,
    environment: &str,
) -> Result<DefaultModelResolution, String> {
    let configured = if request.adapter_id == "codex" {
        &metadata["config"]["model"]
    } else {
        &metadata["model"]
    };
    let model = configured
        .as_str()
        .filter(|model| {
            !matches!(
                *model,
                "default" | "auto" | "inherit" | "opus" | "sonnet" | "haiku" | "fable"
            ) && if request.adapter_id == "claude" {
                valid_claude_model(model)
            } else {
                valid_model(model)
            }
        })
        .ok_or(UNAVAILABLE)?;
    // Bind all configuration changes, CWD, principal, adapter and executable identity; expose only the digest.
    let normalized = json!({"contract":1,"request":request,"model":model,"metadata":metadata,"executable":executable_id,"environment":environment});
    let revision = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&normalized).map_err(|_| UNAVAILABLE)?)
    );
    Ok(DefaultModelResolution {
        status: "confirmed",
        model: Some(model.into()),
        revision,
        source: source(&request.adapter_id),
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(adapter: &str) -> DefaultModelRequest {
        DefaultModelRequest {
            adapter_id: adapter.into(),
            principal_id: "account:a".into(),
            project_id: "p".into(),
            expected_root_path: "C:/project".into(),
            expected_workspace_updated_at: 7,
        }
    }
    #[test]
    fn recommended_catalog_default_is_not_effective_user_config() {
        assert!(resolution(
            &request("codex"),
            &json!({"data":[{"model":"recommended","isDefault":true}],"config":{"model":null}}),
            &json!({}),
            "env"
        )
        .is_err());
        let value = resolution(
            &request("codex"),
            &json!({"config":{"model":"configured"}}),
            &json!({}),
            "env",
        )
        .unwrap();
        assert_eq!(value.model.as_deref(), Some("configured"));
    }
    #[test]
    fn claude_preserves_documented_context_modifier_and_rejects_unresolved_alias() {
        let value = resolution(
            &request("claude"),
            &json!({"model":"claude-opus-5[1m]","settings":{}}),
            &json!({}),
            "env",
        )
        .unwrap();
        assert_eq!(value.model.as_deref(), Some("claude-opus-5[1m]"));
        for model in [
            "default",
            "opus",
            "claude-opus-5[evil]",
            "claude-opus-5[1m][1m]",
        ] {
            assert!(resolution(
                &request("claude"),
                &json!({"model":model}),
                &json!({}),
                "env"
            )
            .is_err());
        }
    }
    #[test]
    fn revision_binds_project_principal_provider_configuration_and_executable() {
        let metadata = json!({"config":{"model":"model-a","model_provider":"provider-a","secret":"never-return"}});
        let a = resolution(&request("codex"), &metadata, &json!({"modified":1}), "env").unwrap();
        let mut changed = request("codex");
        changed.expected_workspace_updated_at += 1;
        assert_ne!(
            a.revision,
            resolution(&changed, &metadata, &json!({"modified":1}), "env")
                .unwrap()
                .revision
        );
        changed = request("codex");
        changed.principal_id = "account:b".into();
        assert_ne!(
            a.revision,
            resolution(&changed, &metadata, &json!({"modified":1}), "env")
                .unwrap()
                .revision
        );
        assert_ne!(
            a.revision,
            resolution(&request("codex"), &metadata, &json!({"modified":2}), "env")
                .unwrap()
                .revision
        );
        assert_ne!(
            a.revision,
            resolution(
                &request("codex"),
                &metadata,
                &json!({"modified":1}),
                "new-env"
            )
            .unwrap()
            .revision
        );
        assert!(!serde_json::to_string(&a).unwrap().contains("never-return"));
        assert!(compare_binding(&a, "model-a", &a.revision).is_ok());
        assert!(compare_binding(&a, "model-b", &a.revision).is_err());
        assert!(compare_binding(&a, "model-a", "stale").is_err());
    }
    #[test]
    fn replies_are_correlated_and_protocol_errors_are_not_exposed() {
        assert!(response(
            &json!({"id":"other","result":{"model":"wrong"}}),
            "codex",
            "config"
        )
        .unwrap()
        .is_none());
        assert_eq!(
            response(
                &json!({"id":"config","error":{"message":"secret"}}),
                "codex",
                "config"
            )
            .unwrap_err(),
            UNAVAILABLE
        );
        assert!(response(&json!({"type":"control_response","response":{"request_id":"model","subtype":"error","error":"secret"}}),"claude","model").is_err());
    }
    #[test]
    fn metadata_reader_bounds_single_frame_and_total_output() {
        let (sender, receiver) = mpsc::sync_channel(8);
        read_frames(std::io::Cursor::new(vec![b'x'; MAX_FRAME + 1]), sender);
        assert!(receiver.recv().unwrap().is_err());
        let (sender, receiver) = mpsc::sync_channel(8);
        read_frames(std::io::Cursor::new(b"{\"id\":\"ok\"}\n"), sender);
        assert_eq!(receiver.recv().unwrap().unwrap()["id"], "ok");
    }
    #[test]
    fn claude_probe_has_no_prompt_tools_persistence_or_user_project_setting_sources() {
        let command = metadata_command("claude", Path::new("claude.exe"), Path::new("project"));
        let args: Vec<_> = command
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--setting-sources", ""]));
        assert!(args.windows(2).any(|pair| pair == ["--tools", ""]));
        assert!(args.contains(&"--no-session-persistence".into()));
        assert_eq!(command.get_current_dir(), Some(Path::new("project")));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "explicit prompt-free installed CLI metadata acceptance only"]
    fn installed_metadata_probe_is_stable_before_any_prompt() {
        let executable =
            PathBuf::from(std::env::var_os("LUCZOR_METADATA_EXE").expect("explicit executable"));
        let adapter = std::env::var("LUCZOR_METADATA_ADAPTER").expect("explicit adapter");
        let root = PathBuf::from(std::env::var_os("LUCZOR_METADATA_CWD").expect("explicit cwd"));
        let mut identity = request(&adapter);
        identity.expected_root_path = root.to_string_lossy().into_owned();
        let first = query_metadata(
            &mut metadata_command(&adapter, &executable, &root),
            &adapter,
            &root,
            &|| Ok(()),
        )
        .unwrap();
        let second = query_metadata(
            &mut metadata_command(&adapter, &executable, &root),
            &adapter,
            &root,
            &|| Ok(()),
        )
        .unwrap();
        let a = resolution(
            &identity,
            &first,
            &executable_identity(&executable).unwrap(),
            &environment_revision(&adapter),
        )
        .unwrap();
        let b = resolution(
            &identity,
            &second,
            &executable_identity(&executable).unwrap(),
            &environment_revision(&adapter),
        )
        .unwrap();
        assert_eq!(a.model, b.model);
        assert_eq!(
            a.revision, b.revision,
            "metadata must not include transient session identity"
        );
    }
}
