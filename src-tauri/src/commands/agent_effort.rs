//! Allowlisted model metadata only. Never reads credentials, prompts or sessions.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Duration;
use tauri::WebviewWindow;

#[path = "agent_default_model.rs"]
mod default_model;
pub use default_model::{validate_default_binding, DefaultModelRequest, DefaultModelResolution};

#[tauri::command]
pub async fn agent_default_model_resolve(
    app: tauri::AppHandle,
    window: WebviewWindow,
    payload: DefaultModelRequest,
) -> Result<DefaultModelResolution, String> {
    default_model::resolve_for_window(app, window, payload).await
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl AgentEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapability {
    pub model: String,
    pub supported_efforts: Vec<AgentEffort>,
    pub default_effort: Option<AgentEffort>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityCatalog {
    pub revision: String,
    pub source: &'static str,
    pub valid_for_seconds: u64,
    pub models: Vec<ModelCapability>,
}

pub fn codex_catalog() -> CapabilityCatalog {
    let empty = || CapabilityCatalog {
        revision: "unavailable".into(),
        source: "codex-cache",
        valid_for_seconds: 0,
        models: vec![],
    };
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|path| PathBuf::from(path).join(".codex"))
        });
    let Some(path) = root.map(|root| root.join("models_cache.json")) else {
        return empty();
    };
    let Ok(metadata) = std::fs::metadata(&path) else {
        return empty();
    };
    let Some(age) = metadata
        .modified()
        .ok()
        .and_then(|time| time.elapsed().ok())
        .filter(|age| *age < Duration::from_secs(86400))
    else {
        return empty();
    };
    if metadata.len() > 2_000_000 {
        return empty();
    }
    let Ok(bytes) = std::fs::read(path) else {
        return empty();
    };
    let mut catalog = parse_codex_catalog(&bytes).unwrap_or_else(empty);
    catalog.valid_for_seconds = 86400 - age.as_secs();
    catalog
}

fn parse_codex_catalog(bytes: &[u8]) -> Option<CapabilityCatalog> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let entries = value.get("models")?.as_array()?;
    let mut models = Vec::new();
    for entry in entries.iter().take(300) {
        let Some(model) = entry.get("slug").and_then(|v| v.as_str()) else {
            continue;
        };
        if !valid_model(model) {
            continue;
        }
        let supported_efforts = entry
            .get("supported_reasoning_levels")
            .and_then(|v| v.as_array())
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(|v| serde_json::from_value(v.get("effort")?.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        models.push(ModelCapability {
            model: model.into(),
            supported_efforts,
            default_effort: entry
                .get("default_reasoning_level")
                .and_then(|v| serde_json::from_value(v.clone()).ok()),
        });
    }
    let normalized = serde_json::to_vec(&models).ok()?;
    Some(CapabilityCatalog {
        revision: format!("{:x}", Sha256::digest(normalized)),
        source: "codex-cache",
        valid_for_seconds: 0,
        models,
    })
}

pub fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 160
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/' | b':'))
}

/// Claude documents [1m] as an explicit context modifier, not another model alias.
pub fn valid_claude_model(model: &str) -> bool {
    model.len() <= 160 && valid_model(model.strip_suffix("[1m]").unwrap_or(model))
}

pub fn validate_codex_effort(
    model: Option<&str>,
    effort: Option<AgentEffort>,
    revision: Option<&str>,
) -> Result<(), String> {
    let Some(effort) = effort else {
        return Ok(());
    };
    let catalog = codex_catalog();
    validate_effort_catalog(&catalog, model, effort, revision)
}

fn validate_effort_catalog(
    catalog: &CapabilityCatalog,
    model: Option<&str>,
    effort: AgentEffort,
    revision: Option<&str>,
) -> Result<(), String> {
    if revision != Some(catalog.revision.as_str())
        || !catalog.models.iter().any(|item| {
            Some(item.model.as_str()) == model && item.supported_efforts.contains(&effort)
        })
    {
        return Err(
            "Codex model/effort capabilities changed or are unavailable; prepare the job again."
                .into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn codex_model_capabilities(window: WebviewWindow) -> Result<CapabilityCatalog, String> {
    super::ensure_main_webview(&window)?;
    Ok(codex_catalog())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_exposes_only_known_efforts_and_model_ids() {
        let catalog = parse_codex_catalog(br#"{"models":[{"slug":"model-a","description":"private unused","supported_reasoning_levels":[{"effort":"high"},{"effort":"invented"}]},{"slug":"--flag evil"}]}"#).unwrap();
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.models[0].supported_efforts, vec![AgentEffort::High]);
        assert!(!serde_json::to_string(&catalog).unwrap().contains("private"));
    }
    #[test]
    fn metadata_timestamp_does_not_change_capability_revision() {
        let a = parse_codex_catalog(br#"{"fetched_at":"old","models":[]}"#).unwrap();
        let b = parse_codex_catalog(br#"{"fetched_at":"new","models":[]}"#).unwrap();
        assert_eq!(a.revision, b.revision);
    }
    #[test]
    fn effort_requires_pinned_model_current_revision_and_supported_level() {
        let catalog = parse_codex_catalog(
            br#"{"models":[{"slug":"model-a","supported_reasoning_levels":[{"effort":"high"}]}]}"#,
        )
        .unwrap();
        let revision = Some(catalog.revision.as_str());
        assert!(
            validate_effort_catalog(&catalog, Some("model-a"), AgentEffort::High, revision).is_ok()
        );
        assert!(validate_effort_catalog(&catalog, None, AgentEffort::High, revision).is_err());
        assert!(
            validate_effort_catalog(&catalog, Some("model-b"), AgentEffort::High, revision)
                .is_err()
        );
        assert!(
            validate_effort_catalog(&catalog, Some("model-a"), AgentEffort::Ultra, revision)
                .is_err()
        );
        assert!(validate_effort_catalog(
            &catalog,
            Some("model-a"),
            AgentEffort::High,
            Some("stale")
        )
        .is_err());
    }
}
