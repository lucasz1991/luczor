//! Local opaque workflow artifacts; no renderer-selected filesystem destinations.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

pub const MAX_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;
const MAX_RUN_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowArtifactScope {
    pub principal_id: String,
    pub project_id: String,
    pub expected_root_path: String,
    pub expected_workspace_updated_at: i64,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research_id: Option<String>,
}
impl WorkflowArtifactScope {
    pub(super) fn agent_root(
        &self,
        app: &AppHandle,
        principal: &str,
        project: &str,
    ) -> Result<(PathBuf, i64), String> {
        if self.principal_id != principal || self.project_id != project {
            return Err("workflow_agent_owner_mismatch".into());
        }
        self.check(app)?;
        Ok((
            PathBuf::from(&self.expected_root_path),
            self.expected_workspace_updated_at,
        ))
    }
    pub fn check(&self, app: &AppHandle) -> Result<(), String> {
        validate_scope(self)?;
        if self.research_id.is_some() {
            return super::research::check_scope(app, self);
        }
        let (root, revision) = if let Some(workcopy) = super::project_mirror::run_workspace(
            app,
            &self.principal_id,
            &self.project_id,
            &self.run_id,
        )? {
            workcopy
        } else {
            super::project_workspace::agent_workspace_snapshot(
                app,
                &self.principal_id,
                &self.project_id,
            )?
        };
        if root != Path::new(&self.expected_root_path)
            || revision != self.expected_workspace_updated_at
        {
            return Err("workflow_artifact_scope_changed".into());
        }
        Ok(())
    }
}
fn validate_scope(scope: &WorkflowArtifactScope) -> Result<(), String> {
    if scope.principal_id.is_empty()
        || scope.principal_id.len() > 300
        || scope.project_id.is_empty()
        || scope.project_id.len() > 160
        || scope.expected_workspace_updated_at <= 0
        || uuid::Uuid::parse_str(&scope.run_id).is_err()
        || scope
            .research_id
            .as_ref()
            .is_some_and(|id| id != &scope.run_id)
    {
        return Err("workflow_artifact_identity_invalid".into());
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowArtifact {
    pub artifact_id: String,
    pub mime: String,
    pub bytes: u64,
    pub sha256: String,
    pub name: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
#[derive(Deserialize, Serialize)]
struct StoredArtifact {
    scope: WorkflowArtifactScope,
    artifact: WorkflowArtifact,
}

fn storage_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Mutex::default)
}
fn directory(
    app: &AppHandle,
    scope: &WorkflowArtifactScope,
    create: bool,
) -> Result<PathBuf, String> {
    validate_scope(scope)?;
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "workflow_artifact_store_unavailable")?
        .join("workflow-artifacts");
    let owner = format!(
        "{:x}",
        Sha256::digest(format!("{}\0{}", scope.principal_id, scope.project_id))
    );
    let run = uuid::Uuid::parse_str(&scope.run_id)
        .map_err(|_| "workflow_artifact_run_invalid")?
        .to_string();
    let target = base.join(owner).join(run);
    // Reject existing links/reparse points at every owned component.
    for path in [
        base.clone(),
        target
            .parent()
            .ok_or("workflow_artifact_path_invalid")?
            .to_path_buf(),
        target.clone(),
    ] {
        if create
            && !path
                .try_exists()
                .map_err(|_| "workflow_artifact_store_unavailable")?
        {
            fs::create_dir(&path).map_err(|_| "workflow_artifact_store_unavailable")?;
        }
        let metadata =
            fs::symlink_metadata(path).map_err(|_| "workflow_artifact_store_unavailable")?;
        if metadata.file_type().is_symlink() {
            return Err("workflow_artifact_link_rejected".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("workflow_artifact_link_rejected".into());
            }
        }
    }
    Ok(target)
}
fn dimensions(bytes: &[u8], mime: &str) -> Result<(Option<u32>, Option<u32>), String> {
    if mime != "image/png" {
        return Ok((None, None));
    }
    let reader =
        image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "workflow_image_invalid")?;
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || u64::from(width) * u64::from(height) > 40_000_000
    {
        return Err("workflow_image_dimensions_exceeded".into());
    }
    Ok((Some(width), Some(height)))
}
pub(crate) fn store(
    app: &AppHandle,
    scope: &WorkflowArtifactScope,
    bytes: &[u8],
    mime: &str,
    name: &str,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<WorkflowArtifact, String> {
    if bytes.is_empty() || bytes.len() > MAX_ARTIFACT_BYTES {
        return Err("workflow_artifact_size_exceeded".into());
    }
    if mime.len() > 100
        || !mime
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'.' | b'+'))
    {
        return Err("workflow_artifact_mime_invalid".into());
    }
    let (width, height) = dimensions(bytes, mime)?;
    check()?;
    let _lock = storage_lock()
        .lock()
        .map_err(|_| "workflow_artifact_store_busy")?;
    let target = directory(app, scope, true)?;
    let mut count = 0;
    let mut total = 0u64;
    for entry in fs::read_dir(&target)
        .map_err(|_| "workflow_artifact_store_unavailable")?
        .take(70)
    {
        let entry = entry.map_err(|_| "workflow_artifact_store_unavailable")?;
        if entry
            .path()
            .extension()
            .is_some_and(|extension| extension == "bin")
        {
            count += 1;
            total = total.saturating_add(
                entry
                    .metadata()
                    .map_err(|_| "workflow_artifact_store_unavailable")?
                    .len(),
            );
        }
    }
    if count >= 32 || total.saturating_add(bytes.len() as u64) > MAX_RUN_BYTES {
        return Err("workflow_artifact_run_budget_exceeded".into());
    }
    let artifact_id = uuid::Uuid::new_v4().to_string();
    let artifact = WorkflowArtifact {
        artifact_id: artifact_id.clone(),
        mime: mime.into(),
        bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        name: name
            .chars()
            .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':'))
            .take(100)
            .collect(),
        width,
        height,
    };
    let bin = target.join(format!("{artifact_id}.bin"));
    let meta = target.join(format!("{artifact_id}.json"));
    let result = (|| {
        check()?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&bin)
            .map_err(|_| "workflow_artifact_write_failed")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "workflow_artifact_write_failed")?;
        let stored = serde_json::to_vec(&StoredArtifact {
            scope: scope.clone(),
            artifact: artifact.clone(),
        })
        .map_err(|_| "workflow_artifact_metadata_invalid")?;
        let mut metadata = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&meta)
            .map_err(|_| "workflow_artifact_write_failed")?;
        metadata
            .write_all(&stored)
            .and_then(|_| metadata.sync_all())
            .map_err(|_| "workflow_artifact_write_failed")?;
        check()?;
        Ok(artifact)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&bin);
        let _ = fs::remove_file(&meta);
    }
    result
}
pub(crate) fn load(
    app: &AppHandle,
    scope: &WorkflowArtifactScope,
    id: &str,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(WorkflowArtifact, Vec<u8>), String> {
    let id = uuid::Uuid::parse_str(id)
        .map_err(|_| "workflow_artifact_id_invalid")?
        .to_string();
    check()?;
    let _lock = storage_lock()
        .lock()
        .map_err(|_| "workflow_artifact_store_busy")?;
    let target = directory(app, scope, false)?;
    let meta = target.join(format!("{id}.json"));
    let bin = target.join(format!("{id}.bin"));
    for (path, max) in [(&meta, 16384), (&bin, MAX_ARTIFACT_BYTES as u64)] {
        let metadata = fs::symlink_metadata(path).map_err(|_| "workflow_artifact_unavailable")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max {
            return Err("workflow_artifact_invalid".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("workflow_artifact_link_rejected".into());
            }
        }
    }
    let stored: StoredArtifact =
        serde_json::from_slice(&fs::read(meta).map_err(|_| "workflow_artifact_unavailable")?)
            .map_err(|_| "workflow_artifact_metadata_invalid")?;
    if stored.scope != *scope || stored.artifact.artifact_id != id {
        return Err("workflow_artifact_scope_changed".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(bin)
        .map_err(|_| "workflow_artifact_unavailable")?
        .take(MAX_ARTIFACT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "workflow_artifact_unavailable")?;
    if bytes.len() != stored.artifact.bytes as usize
        || format!("{:x}", Sha256::digest(&bytes)) != stored.artifact.sha256
    {
        return Err("workflow_artifact_integrity_failed".into());
    }
    check()?;
    Ok((stored.artifact, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dimensions_reject_invalid_png_and_non_images_are_not_claimed_as_images() {
        assert!(dimensions(b"not png", "image/png").is_err());
        assert_eq!(dimensions(b"plain", "text/plain").unwrap(), (None, None));
    }
    #[test]
    fn scope_requires_a_real_run_id() {
        let mut scope = WorkflowArtifactScope {
            research_id: None,
            principal_id: "user".into(),
            project_id: "project".into(),
            expected_root_path: "root".into(),
            expected_workspace_updated_at: 1,
            run_id: uuid::Uuid::new_v4().to_string(),
        };
        assert!(validate_scope(&scope).is_ok());
        scope.run_id = "../../foreign".into();
        assert!(validate_scope(&scope).is_err());
    }
}
