//! Explicit, chat/run-bound research output. No project mapping is invented for free chats.
//! Only the trusted main webview can grant a root; every operation rechecks its execution lease.
use super::execution::{admit, ExecutionLease, ExecutionPermit, Guarded};
use super::workflow_artifacts::{self, WorkflowArtifactScope};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const MAX_TEXT_BYTES: usize = 1_000_000;
const OWNER_FILE: &str = ".luczor-research-owner.json";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareInput {
    principal_id: String,
    project_id: String,
    chat_id: String,
    run_id: String,
    target: String,
    workspace_project_id: Option<String>,
    central_root: Option<String>,
    slug: String,
    title: String,
    expected_root_path: Option<String>,
    #[serde(default)]
    resume: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchBinding {
    pub principal_id: String,
    pub project_id: String,
    pub chat_id: String,
    pub run_id: String,
    pub root_path: String,
    pub revision: i64,
    pub workflow_scope: WorkflowArtifactScope,
    workspace_project_id: Option<String>,
    workspace_root: Option<String>,
    workspace_revision: Option<i64>,
}

#[derive(Clone)]
struct Grant {
    binding: ResearchBinding,
    lease: ExecutionLease,
}
fn grants() -> &'static Mutex<HashMap<String, Grant>> {
    static GRANTS: OnceLock<Mutex<HashMap<String, Grant>>> = OnceLock::new();
    GRANTS.get_or_init(Mutex::default)
}
fn writes() -> &'static Mutex<()> {
    static WRITES: OnceLock<Mutex<()>> = OnceLock::new();
    WRITES.get_or_init(Mutex::default)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 300 && !value.chars().any(char::is_control)
}
fn identity(input: &PrepareInput, permit: &ExecutionPermit) -> Result<(), String> {
    if !valid_id(&input.principal_id)
        || !valid_id(&input.project_id)
        || !valid_id(&input.chat_id)
        || uuid::Uuid::parse_str(&input.run_id).is_err()
        || input.title.len() > 2000
    {
        return Err("research_identity_invalid".into());
    }
    match &permit.scope {
        Some(scope)
            if scope.project_id == input.project_id
                && scope.conversation_id.as_deref() == Some(input.chat_id.as_str())
                && scope.run_id.as_deref() == Some(input.run_id.as_str()) =>
        {
            Ok(())
        }
        _ => Err("research_execution_scope_mismatch".into()),
    }
}

/// Inspect every existing absolute-path component, including custom-root ancestors.
fn safe_absolute(path: &Path, create: bool) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.parent().is_none() {
        return Err("research_root_must_be_absolute".into());
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir | Component::CurDir) {
            return Err("research_root_invalid".into());
        }
        current.push(part.as_os_str());
        // A Windows drive/UNC prefix alone is not an inspectable absolute path yet.
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.is_dir() && !super::project_workspace::is_link_like(&meta) => {}
            Ok(_) => return Err("research_root_link_or_file_rejected".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if create {
                    fs::create_dir(&current).map_err(|_| "research_directory_create_failed")?;
                    let meta = fs::symlink_metadata(&current)
                        .map_err(|_| "research_directory_unavailable")?;
                    if !meta.is_dir() || super::project_workspace::is_link_like(&meta) {
                        return Err("research_root_link_or_file_rejected".into());
                    }
                }
            }
            Err(_) => return Err("research_root_unavailable".into()),
        }
    }
    Ok(path.to_path_buf())
}
fn file_bytes(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "research_file_unavailable")?;
    if !meta.is_file() || super::project_workspace::is_link_like(&meta) || meta.len() > max as u64 {
        return Err("research_file_invalid_or_too_large".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "research_file_unavailable")?
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "research_file_read_failed")?;
    if bytes.len() > max {
        return Err("research_file_too_large".into());
    }
    Ok(bytes)
}
fn registry_path(
    app: &AppHandle,
    principal: &str,
    run: &str,
    create: bool,
) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "research_store_unavailable")?
        .join("research-bindings");
    safe_absolute(&root, create)?;
    Ok(root.join(format!(
        "{}.json",
        digest(format!("{principal}\0{run}").as_bytes())
    )))
}
fn stored_binding(
    app: &AppHandle,
    input: &PrepareInput,
) -> Result<Option<ResearchBinding>, String> {
    let path = registry_path(app, &input.principal_id, &input.run_id, false)?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("research_binding_unavailable".into()),
        Ok(_) => {
            let value: ResearchBinding = serde_json::from_slice(&file_bytes(&path, 32768)?)
                .map_err(|_| "research_binding_invalid")?;
            if value.principal_id != input.principal_id
                || value.project_id != input.project_id
                || value.chat_id != input.chat_id
                || value.run_id != input.run_id
            {
                return Err("research_binding_owner_mismatch".into());
            }
            Ok(Some(value))
        }
    }
}
fn plan(app: &AppHandle, input: &PrepareInput) -> Result<ResearchBinding, String> {
    if let Some(binding) = stored_binding(app, input)? {
        check_binding(app, &binding)?;
        return Ok(binding);
    }
    let (base, workspace_root, workspace_revision) = match input.target.as_str() {
        "project" => {
            let project = input
                .workspace_project_id
                .as_deref()
                .ok_or("research_real_project_required")?;
            if project != input.project_id {
                return Err("research_project_scope_mismatch".into());
            }
            let (root, revision) = super::project_workspace::agent_workspace_snapshot(
                app,
                &input.principal_id,
                project,
            )?;
            (
                root.join("research"),
                Some(root.to_string_lossy().into_owned()),
                Some(revision),
            )
        }
        "central" => {
            let base = match input.central_root.as_deref() {
                Some(path) if !path.is_empty() => PathBuf::from(path),
                _ => app
                    .path()
                    .document_dir()
                    .map_err(|_| "research_documents_unavailable")?
                    .join("Luczor")
                    .join("Research"),
            };
            (base, None, None)
        }
        _ => return Err("research_target_invalid".into()),
    };
    let slug: String = input
        .slug
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(60)
        .collect();
    let slug = if slug.is_empty() { "research" } else { &slug };
    let root = safe_absolute(&base.join(format!("{slug}-{}", input.run_id)), false)?;
    let root_path = root.to_string_lossy().into_owned();
    let revision = 1;
    let binding = ResearchBinding {
        principal_id: input.principal_id.clone(),
        project_id: input.project_id.clone(),
        chat_id: input.chat_id.clone(),
        run_id: input.run_id.clone(),
        root_path: root_path.clone(),
        revision,
        workflow_scope: WorkflowArtifactScope {
            principal_id: input.principal_id.clone(),
            project_id: input.project_id.clone(),
            expected_root_path: root_path,
            expected_workspace_updated_at: revision,
            run_id: input.run_id.clone(),
            research_id: Some(input.run_id.clone()),
        },
        workspace_project_id: if input.target == "project" {
            input.workspace_project_id.clone()
        } else {
            None
        },
        workspace_root,
        workspace_revision,
    };
    if input.resume {
        // A stop can occur after the output marker was committed but before the
        // private registry record. Recover only the exact originally owned root.
        check_binding(app, &binding).map_err(|_| "research_resume_binding_missing")?;
    }
    Ok(binding)
}
fn check_binding(app: &AppHandle, binding: &ResearchBinding) -> Result<(), String> {
    safe_absolute(Path::new(&binding.root_path), false)?;
    let bytes = file_bytes(&Path::new(&binding.root_path).join(OWNER_FILE), 32768)?;
    let owner: ResearchBinding =
        serde_json::from_slice(&bytes).map_err(|_| "research_owner_invalid")?;
    if &owner != binding {
        return Err("research_owner_changed".into());
    }
    if let Some(project) = &binding.workspace_project_id {
        let (root, revision) = super::project_workspace::agent_workspace_snapshot(
            app,
            &binding.principal_id,
            project,
        )?;
        if binding.workspace_root.as_deref() != root.to_str()
            || binding.workspace_revision != Some(revision)
        {
            return Err("research_workspace_changed".into());
        }
    }
    Ok(())
}
fn admitted(
    app: &AppHandle,
    run: &str,
    permit: &ExecutionPermit,
    mutating: bool,
) -> Result<Grant, String> {
    admit(permit, mutating)?;
    let grant = grants()
        .lock()
        .map_err(|_| "research_registry_busy")?
        .get(run)
        .cloned()
        .ok_or("research_grant_required")?;
    let original = grant.lease.permit();
    if permit.session_id != original.session_id
        || permit.generation != original.generation
        || permit.scope != original.scope
        || permit.scope_generation != original.scope_generation
        || permit
            .workflow_execution_id
            .as_deref()
            .is_some_and(|id| id != run)
    {
        return Err("research_grant_scope_changed".into());
    }
    grant.lease.check()?;
    check_binding(app, &grant.binding)?;
    Ok(grant)
}
pub(super) fn check_scope(app: &AppHandle, scope: &WorkflowArtifactScope) -> Result<(), String> {
    let id = scope
        .research_id
        .as_deref()
        .ok_or("research_scope_required")?;
    let grant = grants()
        .lock()
        .map_err(|_| "research_registry_busy")?
        .get(id)
        .cloned()
        .ok_or("research_grant_required")?;
    if scope != &grant.binding.workflow_scope {
        return Err("research_artifact_scope_changed".into());
    }
    grant.lease.check()?;
    check_binding(app, &grant.binding)
}
pub(super) fn check_scope_execution(
    app: &AppHandle,
    scope: &WorkflowArtifactScope,
    permit: &ExecutionPermit,
) -> Result<(), String> {
    if let Some(id) = &scope.research_id {
        let grant = admitted(app, id, permit, false)?;
        if scope != &grant.binding.workflow_scope {
            return Err("research_artifact_scope_changed".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn research_preview(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<PrepareInput>,
) -> Result<ResearchBinding, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, false)?;
    identity(&payload.request, &payload.execution)?;
    let binding = plan(&app, &payload.request)?;
    lease.check()?;
    Ok(binding)
}
#[tauri::command]
pub async fn research_prepare(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<PrepareInput>,
) -> Result<ResearchBinding, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, true)?;
    identity(&payload.request, &payload.execution)?;
    let _lock = writes().lock().map_err(|_| "research_write_busy")?;
    let binding = plan(&app, &payload.request)?;
    if payload.expected_root_path.as_deref() != Some(binding.root_path.as_str()) {
        return Err("research_output_confirmation_changed".into());
    }
    let root = Path::new(&binding.root_path);
    let record = registry_path(&app, &binding.principal_id, &binding.run_id, false)?;
    if !record.exists() {
        lease.check()?;
        let bytes = serde_json::to_vec_pretty(&binding).map_err(|_| "research_binding_invalid")?;
        if fs::symlink_metadata(root).is_ok() {
            // Recover a stopped preparation only with its exact original owned marker.
            check_binding(&app, &binding).map_err(|_| "research_output_already_exists")?;
        } else {
            safe_absolute(root, true)?;
            super::project_workspace::atomic_write(
                &root.join(OWNER_FILE),
                &bytes,
                None,
                Some(&lease),
            )?;
        }
        for name in ["belege"] {
            lease.check()?;
            safe_absolute(&root.join(name), true)?;
        }
        let record = registry_path(&app, &binding.principal_id, &binding.run_id, true)?;
        super::project_workspace::atomic_write(&record, &bytes, None, Some(&lease))?;
    }
    check_binding(&app, &binding)?;
    lease.check()?;
    grants()
        .lock()
        .map_err(|_| "research_registry_busy")?
        .insert(
            binding.run_id.clone(),
            Grant {
                binding: binding.clone(),
                lease,
            },
        );
    Ok(binding)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileInput {
    run_id: String,
    path: String,
    content: Option<String>,
    expected_sha256: Option<String>,
    max_bytes: Option<usize>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    path: String,
    bytes: usize,
    sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}
fn target(binding: &ResearchBinding, raw: &str, create_parents: bool) -> Result<PathBuf, String> {
    let relative = super::project_workspace::validate_relative_path(raw, false)?;
    if relative.components().any(|part| {
        part.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(OWNER_FILE)
    }) {
        return Err("research_owner_file_protected".into());
    }
    let root = Path::new(&binding.root_path);
    super::project_workspace::inspect_components(root, &relative, create_parents)?;
    if create_parents {
        if let Some(parent) = relative.parent() {
            safe_absolute(&root.join(parent), true)?;
        }
    }
    Ok(root.join(relative))
}
fn result(raw: &str, bytes: &[u8], text: bool) -> Result<FileResult, String> {
    Ok(FileResult {
        path: raw.into(),
        bytes: bytes.len(),
        sha256: digest(bytes),
        content: if text {
            Some(String::from_utf8(bytes.to_vec()).map_err(|_| "research_file_not_utf8")?)
        } else {
            None
        },
    })
}
#[tauri::command]
pub async fn research_read(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<FileInput>,
) -> Result<FileResult, String> {
    super::ensure_main_webview(&window)?;
    let grant = admitted(&app, &payload.run_id, &payload.execution, false)?;
    let path = target(&grant.binding, &payload.path, false)?;
    let bytes = file_bytes(
        &path,
        payload
            .max_bytes
            .unwrap_or(MAX_TEXT_BYTES)
            .min(MAX_TEXT_BYTES),
    )?;
    grant.lease.check()?;
    result(&payload.path, &bytes, true)
}
#[tauri::command]
pub async fn research_write(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<FileInput>,
) -> Result<FileResult, String> {
    super::ensure_main_webview(&window)?;
    let grant = admitted(&app, &payload.run_id, &payload.execution, true)?;
    let text = payload
        .content
        .as_deref()
        .ok_or("research_content_required")?;
    if text.len() > MAX_TEXT_BYTES {
        return Err("research_text_size_exceeded".into());
    }
    let _lock = writes().lock().map_err(|_| "research_write_busy")?;
    grant.lease.check()?;
    let path = target(&grant.binding, &payload.path, true)?;
    super::project_workspace::atomic_write(
        &path,
        text.as_bytes(),
        payload.expected_sha256.as_deref(),
        Some(&grant.lease),
    )?;
    let bytes = file_bytes(&path, MAX_TEXT_BYTES)?;
    if bytes != text.as_bytes() {
        return Err("research_write_verification_failed".into());
    }
    grant.lease.check()?;
    result(&payload.path, &bytes, false)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactInput {
    run_id: String,
    artifact_id: String,
    path: Option<String>,
}
#[tauri::command]
pub async fn research_read_artifact(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<ArtifactInput>,
) -> Result<Value, String> {
    super::ensure_main_webview(&window)?;
    let grant = admitted(&app, &payload.run_id, &payload.execution, false)?;
    let (artifact, bytes) = workflow_artifacts::load(
        &app,
        &grant.binding.workflow_scope,
        &payload.artifact_id,
        &|| grant.lease.check(),
    )?;
    Ok(
        json!({"artifact":artifact,"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
    )
}
#[tauri::command]
pub async fn research_export_artifact(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<ArtifactInput>,
) -> Result<Value, String> {
    super::ensure_main_webview(&window)?;
    let grant = admitted(&app, &payload.run_id, &payload.execution, true)?;
    let raw = payload
        .path
        .as_deref()
        .ok_or("research_export_path_required")?;
    let (artifact, bytes) = workflow_artifacts::load(
        &app,
        &grant.binding.workflow_scope,
        &payload.artifact_id,
        &|| grant.lease.check(),
    )?;
    let _lock = writes().lock().map_err(|_| "research_write_busy")?;
    grant.lease.check()?;
    let path = target(&grant.binding, raw, true)?;
    // Idempotent retry is permitted only for the identical, verified binary.
    if path.exists() {
        if file_bytes(&path, workflow_artifacts::MAX_ARTIFACT_BYTES)? != bytes {
            return Err("research_export_existing_file_conflict".into());
        }
    } else {
        super::project_workspace::atomic_write(&path, &bytes, None, Some(&grant.lease))?;
    }
    if file_bytes(&path, workflow_artifacts::MAX_ARTIFACT_BYTES)? != bytes {
        return Err("research_export_verification_failed".into());
    }
    grant.lease.check()?;
    Ok(json!({"path":raw,"bytes":bytes.len(),"sha256":artifact.sha256,"mime":artifact.mime}))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyFile {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyInput {
    run_id: String,
    files: Vec<VerifyFile>,
}
#[tauri::command]
pub async fn research_verify(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<VerifyInput>,
) -> Result<Value, String> {
    super::ensure_main_webview(&window)?;
    let grant = admitted(&app, &payload.run_id, &payload.execution, false)?;
    if payload.files.is_empty() || payload.files.len() > 1000 {
        return Err("research_verify_files_invalid".into());
    }
    let mut files = Vec::new();
    for file in &payload.files {
        grant.lease.check()?;
        let bytes = file_bytes(
            &target(&grant.binding, &file.path, false)?,
            workflow_artifacts::MAX_ARTIFACT_BYTES,
        )?;
        let actual = digest(&bytes);
        if actual != file.sha256 {
            return Err(format!("research_file_hash_changed: {}", file.path));
        }
        files.push(json!({"path":file.path,"bytes":bytes.len(),"sha256":actual}));
    }
    grant.lease.check()?;
    Ok(json!({"ok":true,"files":files}))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunInput {
    run_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenInput {
    run_id: String,
    principal_id: String,
    path: Option<String>,
}
#[tauri::command]
pub async fn research_open(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<OpenInput>,
) -> Result<bool, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, false)?;
    if !valid_id(&payload.principal_id) || uuid::Uuid::parse_str(&payload.run_id).is_err() {
        return Err("research_identity_invalid".into());
    }
    let registry = registry_path(&app, &payload.principal_id, &payload.run_id, false)?;
    let binding: ResearchBinding = serde_json::from_slice(&file_bytes(&registry, 32768)?)
        .map_err(|_| "research_binding_invalid")?;
    if binding.principal_id != payload.principal_id
        || binding.run_id != payload.run_id
        || payload.execution.scope.as_ref().is_none_or(|scope| {
            scope.project_id != binding.project_id
                || scope.conversation_id.as_deref() != Some(binding.chat_id.as_str())
        })
    {
        return Err("research_open_owner_mismatch".into());
    }
    check_binding(&app, &binding)?;
    let selected = match payload.path.as_deref() {
        Some(path) => target(&binding, path, false)?,
        None => PathBuf::from(&binding.root_path),
    };
    // Reveal the containing folder. Never execute an arbitrary downloaded file.
    let directory = if selected.is_dir() {
        selected
    } else {
        selected
            .parent()
            .ok_or("research_path_invalid")?
            .to_path_buf()
    };
    lease.check()?;
    #[cfg(windows)]
    let mut command = std::process::Command::new("explorer.exe");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .arg(directory)
        .spawn()
        .map_err(|_| "research_folder_open_failed")?;
    Ok(true)
}
#[tauri::command]
pub async fn research_release(
    window: super::CallerWebview,
    payload: Guarded<RunInput>,
) -> Result<bool, String> {
    super::ensure_main_webview(&window)?;
    // Release stays available after stop, but only to the original exact owner permit.
    let mut items = grants().lock().map_err(|_| "research_registry_busy")?;
    if let Some(grant) = items.get(&payload.run_id) {
        if grant.lease.permit() != &payload.execution {
            return Err("research_release_owner_mismatch".into());
        }
        items.remove(&payload.run_id);
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("luczor-research-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        root.canonicalize().unwrap()
    }
    fn binding(root: &Path) -> ResearchBinding {
        let run = uuid::Uuid::new_v4().to_string();
        ResearchBinding {
            principal_id: "owner".into(),
            project_id: "chat-space".into(),
            chat_id: "chat".into(),
            run_id: run.clone(),
            root_path: root.to_string_lossy().into_owned(),
            revision: 1,
            workflow_scope: WorkflowArtifactScope {
                principal_id: "owner".into(),
                project_id: "chat-space".into(),
                expected_root_path: root.to_string_lossy().into_owned(),
                expected_workspace_updated_at: 1,
                run_id: run.clone(),
                research_id: Some(run),
            },
            workspace_project_id: None,
            workspace_root: None,
            workspace_revision: None,
        }
    }
    #[test]
    fn output_paths_reject_escape_owner_and_windows_names() {
        let root = temp();
        let binding = binding(&root);
        for path in [
            "../outside",
            "C:/outside",
            OWNER_FILE,
            ".LUCZOR-RESEARCH-OWNER.JSON",
            "nested/.luczor-research-owner.json",
            "CON.txt",
            "data:stream",
        ] {
            assert!(target(&binding, path, true).is_err(), "{path}");
        }
        assert_eq!(
            target(&binding, "downloads/file.pdf", true).unwrap(),
            root.join("downloads/file.pdf")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn binary_export_and_report_writes_preserve_atomic_cas() {
        let root = temp();
        let path = root.join("report.md");
        super::super::project_workspace::atomic_write(&path, b"one", None, None).unwrap();
        assert!(super::super::project_workspace::atomic_write(&path, b"bad", None, None).is_err());
        assert!(super::super::project_workspace::atomic_write(
            &path,
            b"bad",
            Some(&digest(b"wrong")),
            None
        )
        .is_err());
        assert_eq!(file_bytes(&path, 100).unwrap(), b"one");
        super::super::project_workspace::atomic_write(&path, b"two", Some(&digest(b"one")), None)
            .unwrap();
        assert_eq!(file_bytes(&path, 100).unwrap(), b"two");
        assert!(file_bytes(&path, 2).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn standalone_identity_requires_exact_chat_and_run_without_workspace_mapping() {
        let root = temp();
        let binding = binding(&root);
        let input = PrepareInput {
            principal_id: binding.principal_id.clone(),
            project_id: binding.project_id.clone(),
            chat_id: binding.chat_id.clone(),
            run_id: binding.run_id.clone(),
            target: "central".into(),
            workspace_project_id: None,
            central_root: None,
            slug: "test".into(),
            title: "Test".into(),
            expected_root_path: None,
            resume: false,
        };
        let mut permit = ExecutionPermit {
            session_id: "session".into(),
            generation: 1,
            workflow_execution_id: None,
            scope: Some(super::super::execution::ExecutionScope {
                project_id: binding.project_id,
                conversation_id: Some(binding.chat_id),
                run_id: Some(binding.run_id),
                workspace_binding_id: None,
            }),
            scope_generation: Some(1),
        };
        assert!(identity(&input, &permit).is_ok());
        permit.scope.as_mut().unwrap().conversation_id = Some("other-chat".into());
        assert!(identity(&input, &permit).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn symlink_ancestors_are_rejected() {
        let root = temp();
        let outside = temp();
        let link = root.join("linked");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
            fs::remove_dir_all(root).unwrap();
            fs::remove_dir_all(outside).unwrap();
            return;
        }
        assert!(safe_absolute(&link.join("escape"), true).is_err());
        assert!(target(&binding(&root), "linked/file.txt", true).is_err());
        assert!(!outside.join("escape").exists());
        #[cfg(windows)]
        fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        fs::remove_file(&link).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
