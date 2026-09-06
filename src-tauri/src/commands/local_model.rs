use base64::Engine;
use netstat2::{get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState};
use nvml_wrapper::Nvml;
use reqwest::blocking::Client;
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::pkcs8::DecodePublicKey;
use rsa::signature::Verifier;
use rsa::traits::PublicKeyParts;
use rsa::RsaPublicKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{DiskKind, Disks, System};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, WebviewWindow};
use uuid::Uuid;

use super::ensure_main_webview;

const PUBLIC_KEY_B64: Option<&str> = option_env!("LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64");
const EXPECTED_KEY_ID: Option<&str> = option_env!("LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID");
const FLASH_MODEL_ID: &str = "qwen3.8-flash-next";
const FALLBACK_MODEL_ID: &str = "orcarouter-qwen3.8-27b-uncensored-q4-k-m";
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_CONTENT_CHARS: usize = 4 * 1024 * 1024;
const MAX_TOOL_CALLS: usize = 128;
const MAX_TOOL_ARGUMENT_CHARS: usize = 1024 * 1024;
const MAX_SIGNED_READ_TIMEOUT_MS: u64 = 120_000;
const MAX_INFERENCE_TOTAL_SECONDS: u64 = 30 * 60;
const MAX_RUNTIME_PATH_CONFIG_BYTES: u64 = 16 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimePathConfig {
    version: u32,
    runtime_path: PathBuf,
    model_directory: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedEnvelope {
    key_id: String,
    algorithm: String,
    payload_sha256: String,
    payload: Value,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestAcceptanceInput {
    expected_schema_version: u32,
    expected_catalog_version: u64,
    expected_policy_version: u64,
    expected_key_id: String,
    expected_trust_domain: String,
    expected_acceptance_session_id: String,
    expected_acceptance_generation: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ManifestPayload {
    schema_version: u32,
    catalog_version: u64,
    policy_version: u64,
    generated_at: String,
    expires_at: String,
    models: Vec<ModelRelease>,
    routing: RoutingPolicy,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ModelRelease {
    id: String,
    display_name: String,
    execution_target: String,
    release_channel: String,
    routing_role: String,
    promoted: bool,
    enabled: bool,
    capabilities: Vec<String>,
    context_limit: Option<u32>,
    artifact: Option<ModelArtifact>,
    runtime: Option<RuntimeArtifact>,
    capacity_policy: CapacityPolicy,
    health_policy: HealthPolicy,
    chat_template_hash: Option<String>,
    evaluation_report_hash: Option<String>,
    license: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ModelArtifact {
    url: String,
    sha256: String,
    size_bytes: u64,
    format: String,
    quantization: String,
    storage_class: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RuntimeArtifact {
    id: String,
    version: String,
    sha256: String,
    min_context_tokens: u32,
    max_context_tokens: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CapacityPolicy {
    min_total_ram_bytes: Option<u64>,
    min_available_ram_bytes: Option<u64>,
    min_vram_bytes: Option<u64>,
    min_storage_free_bytes: Option<u64>,
    max_startup_seconds: Option<u64>,
    benchmark_thresholds: Option<BenchmarkThresholds>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BenchmarkThresholds {
    min_prefill_tokens_per_second: f64,
    min_decode_tokens_per_second: f64,
    max_first_token_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HealthPolicy {
    cooldown_ms: u64,
    max_consecutive_failures: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RoutingPolicy {
    strategy: String,
    local_first: bool,
    preferred_model_id: String,
    default_model_id: String,
    fallback_model_ids: Vec<String>,
    experimental_model_ids: Vec<String>,
    experimental_opt_in_required: bool,
    external_execution_target: String,
    external_allowed: bool,
    external_requires_explicit_approval: bool,
    no_silent_external_fallback: bool,
    required_local_state: Vec<String>,
    decision_reasons: Vec<String>,
    egress_policy_version: String,
}

#[derive(Debug, Clone)]
struct VerifiedCatalog {
    payload_hash: String,
    payload: ManifestPayload,
}

#[derive(Debug)]
struct ManagedRuntime {
    child: Option<Child>,
    model_id: String,
    scope_digest: String,
    port: u16,
    api_key: String,
    api_key_file: PathBuf,
    _runtime_guard: File,
    _model_guard: File,
    _process_lifetime_guard: ProcessLifetimeGuard,
}

#[derive(Debug)]
struct VerifiedArtifactFiles {
    runtime_path: PathBuf,
    model_path: PathBuf,
    runtime_guard: File,
    model_guard: File,
}

#[cfg(windows)]
#[derive(Debug)]
struct ProcessLifetimeGuard {
    handle: isize,
}

#[cfg(windows)]
impl Drop for ProcessLifetimeGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        unsafe {
            let _ = CloseHandle(self.handle as HANDLE);
        }
    }
}

#[cfg(not(windows))]
#[derive(Debug)]
struct ProcessLifetimeGuard;

impl ManagedRuntime {
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            terminate_process(&mut child);
        }
        let _ = fs::remove_file(&self.api_key_file);
    }
}

impl Drop for ManagedRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Debug, Clone)]
struct ReadinessRecord {
    manifest_hash: String,
    artifact_hash: String,
    runtime_hash: String,
    verified_at_ms: i128,
    valid_until_ms: i128,
}

#[derive(Debug, Default)]
struct ManagerState {
    catalog: Option<VerifiedCatalog>,
    runtime: Option<ManagedRuntime>,
    readiness: HashMap<String, ReadinessRecord>,
    active_request_id: Option<String>,
    cancel: Option<Arc<AtomicBool>>,
    failures: HashMap<String, u32>,
    cooldown_until_ms: HashMap<String, i128>,
    last_error: Option<String>,
    manifest_session_id: Option<String>,
    retired_manifest_sessions: HashSet<String>,
    catalog_generation: u64,
    pending_catalog_generation: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestOutcome {
    Success,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LlamaHttpFailureKind {
    ContextWindowExceeded,
    ChatHistoryRejected,
    ChatTemplateFailed,
    ToolContractRejected,
    CapacityExhausted,
    AuthenticationFailed,
    ModelUnavailable,
    RequestRejected,
    ServerFailed,
    HttpFailed,
}

impl LlamaHttpFailureKind {
    fn code(self) -> &'static str {
        match self {
            Self::ContextWindowExceeded => "runtime_context_exceeded",
            Self::ChatHistoryRejected => "runtime_chat_history_rejected",
            Self::ChatTemplateFailed => "runtime_chat_template_failed",
            Self::ToolContractRejected => "runtime_tool_contract_rejected",
            Self::CapacityExhausted => "runtime_capacity_exhausted",
            Self::AuthenticationFailed => "runtime_auth_failed",
            Self::ModelUnavailable => "runtime_model_unavailable",
            Self::RequestRejected => "runtime_request_rejected",
            Self::ServerFailed => "runtime_server_failed",
            Self::HttpFailed => "runtime_http_failed",
        }
    }

    fn retryable(self, status: u16) -> bool {
        matches!(self, Self::CapacityExhausted | Self::ServerFailed)
            || (matches!(self, Self::HttpFailed)
                && (status == 408 || status == 429 || status >= 500))
    }

    fn public_message(self, status: u16) -> String {
        let reason = match self {
            Self::ContextWindowExceeded => {
                "rejected the request because the context window was exceeded"
            }
            Self::ChatHistoryRejected => {
                "rejected the conversation role order in its chat template"
            }
            Self::ChatTemplateFailed => "could not apply the chat template",
            Self::ToolContractRejected => "rejected the tool contract",
            Self::CapacityExhausted => "has insufficient runtime capacity",
            Self::AuthenticationFailed => "rejected native authentication",
            Self::ModelUnavailable => "could not resolve the requested model",
            Self::RequestRejected => "rejected the request",
            Self::ServerFailed => "reported an internal server error",
            Self::HttpFailed => return format!("Local llama.cpp returned HTTP {status}."),
        };
        format!("Local llama.cpp {reason} (HTTP {status}).")
    }
}

#[derive(Debug)]
struct LocalInferenceFailure {
    code: &'static str,
    public_message: String,
    retryable: bool,
}

impl LocalInferenceFailure {
    fn stream(message: impl Into<String>) -> Self {
        Self {
            code: "runtime_stream_failed",
            public_message: message.into(),
            retryable: true,
        }
    }

    fn http(status: u16, kind: LlamaHttpFailureKind) -> Self {
        Self {
            code: kind.code(),
            public_message: kind.public_message(status),
            retryable: kind.retryable(status),
        }
    }
}

impl From<String> for LocalInferenceFailure {
    fn from(message: String) -> Self {
        Self::stream(message)
    }
}

impl From<&str> for LocalInferenceFailure {
    fn from(message: &str) -> Self {
        Self::stream(message)
    }
}

static STATE: OnceLock<Mutex<ManagerState>> = OnceLock::new();
static RUNTIME_KEY_CLEANUP: OnceLock<Result<(), String>> = OnceLock::new();

fn state() -> &'static Mutex<ManagerState> {
    STATE.get_or_init(|| Mutex::new(ManagerState::default()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestVerificationResult {
    valid: bool,
    canonical_payload_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeReadiness {
    model_release_id: String,
    manifest_payload_sha256: String,
    artifact_sha256: String,
    runtime_sha256: String,
    ready: bool,
    verified_at_ms: i64,
    valid_until_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelStatus {
    manifest_available: bool,
    catalog_version: Option<u64>,
    policy_version: Option<u64>,
    active_model_id: Option<String>,
    state: String,
    reason_code: Option<String>,
    readiness: Vec<NativeReadiness>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSnapshot {
    schema_version: u8,
    snapshot_id: String,
    captured_at_ms: i64,
    platform: String,
    arch: String,
    cpu: CpuSnapshot,
    memory: MemorySnapshot,
    accelerators: Vec<AcceleratorSnapshot>,
    storage: Vec<StorageSnapshot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuSnapshot {
    logical_cores: usize,
    physical_cores: Option<usize>,
    features: Vec<String>,
    load_percent: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    total_bytes: u64,
    available_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceleratorSnapshot {
    id: String,
    backend: String,
    name: String,
    total_bytes: Option<u64>,
    available_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSnapshot {
    id: String,
    mount_label: String,
    bus_type: String,
    media_type: String,
    removable: bool,
    available_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogBindingInput {
    acceptance_session_id: String,
    acceptance_generation: u64,
    manifest_payload_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalInferenceRequest {
    request_id: String,
    scope_digest: String,
    model_release_id: String,
    catalog_binding: CatalogBindingInput,
    use_case: String,
    messages: Vec<Value>,
    tools: Vec<Value>,
    tool_choice: String,
    max_output_tokens: u32,
    context_limit: Option<u32>,
    reasoning_mode: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeToolFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeToolCall {
    id: String,
    r#type: String,
    function: NativeToolFunction,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInferenceResult {
    content: String,
    raw_tool_calls: Vec<NativeToolCall>,
    finish_reason: String,
    request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LocalInferenceEvent {
    Started {
        request_id: String,
    },
    Delta {
        request_id: String,
        content: String,
    },
    Error {
        request_id: String,
        code: String,
        retryable: bool,
    },
}

#[tauri::command]
pub async fn local_model_register_manifest_session(
    window: WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let mut previous_runtime = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        rotate_manifest_session(&mut guard, &session_id)?
    };
    if let Some(runtime) = previous_runtime.as_mut() {
        runtime.stop();
    }
    Ok(())
}

#[tauri::command]
pub async fn local_model_begin_manifest_acceptance(
    window: WebviewWindow,
    session_id: String,
    acceptance_generation: u64,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let mut previous_runtime = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        begin_manifest_acceptance(&mut guard, &session_id, acceptance_generation)?
    };
    if let Some(runtime) = previous_runtime.as_mut() {
        runtime.stop();
    }
    Ok(())
}

#[tauri::command]
pub async fn local_model_verify_manifest(
    window: WebviewWindow,
    app: AppHandle,
    envelope: Value,
    acceptance: ManifestAcceptanceInput,
) -> Result<ManifestVerificationResult, String> {
    ensure_main_webview(&window)?;
    let wire: SignedEnvelope = serde_json::from_value(envelope)
        .map_err(|_| "Local-model manifest schema is invalid.".to_string())?;
    let result = verify_envelope(&wire)?;
    let payload = parse_manifest_payload(&wire.payload)?;
    validate_discovery_binding(
        &wire,
        &payload,
        acceptance.expected_schema_version,
        acceptance.expected_catalog_version,
        acceptance.expected_policy_version,
        &acceptance.expected_key_id,
    )?;
    if !valid_manifest_trust_domain(&acceptance.expected_trust_domain) {
        return Err("Local-model manifest trust domain is invalid.".into());
    }
    if !valid_manifest_session_id(&acceptance.expected_acceptance_session_id) {
        return Err("Local-model manifest acceptance session is invalid.".into());
    }
    if acceptance.expected_acceptance_generation == 0 {
        return Err("Local-model manifest acceptance generation is invalid.".into());
    }

    let mut previous_runtime = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        if guard.manifest_session_id.as_deref()
            != Some(acceptance.expected_acceptance_session_id.as_str())
        {
            return Err(
                "Stale local-model manifest acceptance session was rejected natively.".into(),
            );
        }
        if guard.pending_catalog_generation != Some(acceptance.expected_acceptance_generation) {
            return Err(
                "Unregistered local-model manifest acceptance generation was rejected natively."
                    .into(),
            );
        }
        if guard.active_request_id.is_some() {
            return Err("Local-model manifest cannot change during an active operation.".into());
        }
        if !acceptance_generation_is_current(
            guard.catalog_generation,
            acceptance.expected_acceptance_generation,
        ) {
            return Err("Stale local-model manifest acceptance was rejected natively.".into());
        }
        // Persist downgrade state before publishing the catalog while the
        // manager lock prevents a concurrent operation from starting.
        let contract_hash = canonical_contract_hash(&wire.payload)?;
        persist_versions(
            &app,
            &acceptance.expected_trust_domain,
            &payload,
            &result.canonical_payload_sha256,
            &contract_hash,
        )?;
        let previous_runtime = guard.runtime.take();
        guard.readiness.clear();
        guard.catalog = Some(VerifiedCatalog {
            payload_hash: result.canonical_payload_sha256.clone(),
            payload,
        });
        guard.catalog_generation = acceptance.expected_acceptance_generation;
        guard.pending_catalog_generation = None;
        guard.last_error = None;
        previous_runtime
    };
    if let Some(runtime) = previous_runtime.as_mut() {
        runtime.stop();
    }
    Ok(result)
}

fn validate_discovery_binding(
    envelope: &SignedEnvelope,
    payload: &ManifestPayload,
    expected_schema_version: u32,
    expected_catalog_version: u64,
    expected_policy_version: u64,
    expected_key_id: &str,
) -> Result<(), String> {
    if envelope.key_id != expected_key_id
        || payload.schema_version != expected_schema_version
        || payload.catalog_version != expected_catalog_version
        || payload.policy_version != expected_policy_version
    {
        return Err("Bootstrap discovery and signed manifest versions differ.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn local_model_status(window: WebviewWindow) -> Result<LocalModelStatus, String> {
    ensure_main_webview(&window)?;
    let guard = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.".to_string())?;
    let now = now_ms()?;
    let readiness = guard
        .readiness
        .iter()
        .filter(|(_, item)| item.valid_until_ms > now)
        .map(|(model_id, item)| NativeReadiness {
            model_release_id: model_id.clone(),
            manifest_payload_sha256: item.manifest_hash.clone(),
            artifact_sha256: item.artifact_hash.clone(),
            runtime_sha256: item.runtime_hash.clone(),
            ready: true,
            verified_at_ms: item.verified_at_ms as i64,
            valid_until_ms: item.valid_until_ms as i64,
        })
        .collect();
    let (catalog_version, policy_version) = guard
        .catalog
        .as_ref()
        .map(|catalog| {
            (
                Some(catalog.payload.catalog_version),
                Some(catalog.payload.policy_version),
            )
        })
        .unwrap_or((None, None));
    let active_model_id = guard
        .runtime
        .as_ref()
        .map(|runtime| runtime.model_id.clone());
    let state_name = if guard.catalog.is_none() {
        "unavailable"
    } else if guard.active_request_id.is_some() {
        "busy"
    } else if guard.runtime.is_some() {
        "ready"
    } else {
        "stopped"
    };
    Ok(LocalModelStatus {
        manifest_available: guard.catalog.is_some(),
        catalog_version,
        policy_version,
        active_model_id,
        state: state_name.into(),
        reason_code: guard.last_error.clone(),
        readiness,
    })
}

#[tauri::command]
pub async fn local_model_hardware_snapshot(
    window: WebviewWindow,
) -> Result<HardwareSnapshot, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(collect_hardware_snapshot)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_model_prepare(
    window: WebviewWindow,
    app: AppHandle,
    model_release_id: String,
    catalog_binding: CatalogBindingInput,
) -> Result<NativeReadiness, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        prepare_release(&app, &model_release_id, &catalog_binding)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_model_infer(
    window: WebviewWindow,
    app: AppHandle,
    request: LocalInferenceRequest,
    on_event: Channel<LocalInferenceEvent>,
) -> Result<LocalInferenceResult, String> {
    ensure_main_webview(&window)?;
    validate_inference_request(&request)?;
    tauri::async_runtime::spawn_blocking(move || infer_blocking(&app, request, on_event))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_model_cancel(
    window: WebviewWindow,
    request_id: String,
    catalog_binding: CatalogBindingInput,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let mut runtime = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        require_catalog_binding(&guard, &catalog_binding)?;
        if guard.active_request_id.as_deref() != Some(request_id.as_str()) {
            return Ok(());
        }
        if let Some(cancel) = guard.cancel.as_ref() {
            cancel.store(true, Ordering::SeqCst);
        }
        guard.runtime.take()
    };
    if let Some(runtime) = runtime.as_mut() {
        runtime.stop();
    }
    Ok(())
}

#[tauri::command]
pub async fn local_model_stop(
    window: WebviewWindow,
    model_release_id: String,
    catalog_binding: CatalogBindingInput,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    if !safe_id(&model_release_id) {
        return Err("Invalid model release id.".into());
    }
    let mut runtime = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        require_catalog_binding(&guard, &catalog_binding)?;
        if guard.active_request_id.is_some() {
            return Err("Local runtime cannot be stopped during an active operation.".into());
        }
        if guard
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.model_id == model_release_id)
        {
            guard.runtime.take()
        } else {
            None
        }
    };
    if let Some(runtime) = runtime.as_mut() {
        runtime.stop();
    }
    Ok(())
}

pub fn shutdown_all() {
    let mut runtime = if let Ok(mut guard) = state().lock() {
        if let Some(cancel) = guard.cancel.as_ref() {
            cancel.store(true, Ordering::SeqCst);
        }
        guard.runtime.take()
    } else {
        None
    };
    if let Some(runtime) = runtime.as_mut() {
        runtime.stop();
    }
}

fn verify_envelope(envelope: &SignedEnvelope) -> Result<ManifestVerificationResult, String> {
    let expected_key =
        EXPECTED_KEY_ID.ok_or("This app build has no local-model manifest key id.")?;
    let key_b64 = PUBLIC_KEY_B64.ok_or("This app build has no local-model manifest public key.")?;
    verify_envelope_with_trust(envelope, expected_key, key_b64, now_ms()?)
}

fn verify_envelope_with_trust(
    envelope: &SignedEnvelope,
    expected_key: &str,
    key_b64: &str,
    now: i128,
) -> Result<ManifestVerificationResult, String> {
    if envelope.algorithm != "RSA-SHA256" || !safe_id(&envelope.key_id) {
        return Err("Local-model manifest algorithm/key id is invalid.".into());
    }
    if envelope.key_id != expected_key {
        return Err("Local-model manifest key id is not trusted by this build.".into());
    }
    let payload = parse_manifest_payload(&envelope.payload)?;
    validate_manifest(&payload)?;
    // Signature verification is deliberately performed over the untouched
    // JSON value. Converting through typed f64 fields would serialize `10` as
    // `10.0` and diverge from PHP's canonical bytes.
    let canonical = canonical_json(&envelope.payload)?;
    let computed_hash = sha256_bytes(&canonical);
    if !computed_hash.eq_ignore_ascii_case(&envelope.payload_sha256) {
        return Err("Local-model manifest payload hash does not match.".into());
    }
    let key = decode_manifest_public_key(key_b64)?;
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(&envelope.signature)
        .map_err(|_| "Local-model signature is invalid.".to_string())?;
    let signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| "Local-model signature is invalid.".to_string())?;
    VerifyingKey::<Sha256>::new(key)
        .verify(&canonical, &signature)
        .map_err(|_| "Local-model manifest signature is invalid.".to_string())?;

    let generated = parse_rfc3339_millis(&payload.generated_at)?;
    let expires = parse_rfc3339_millis(&payload.expires_at)?;
    if generated > now + 300_000 || expires <= now || expires <= generated {
        return Err("Local-model manifest validity window is invalid.".into());
    }
    Ok(ManifestVerificationResult {
        valid: true,
        canonical_payload_sha256: computed_hash,
    })
}

fn decode_manifest_public_key(key_b64: &str) -> Result<RsaPublicKey, String> {
    let pem = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(key_b64)
            .map_err(|_| "Local-model public key is invalid.".to_string())?,
    )
    .map_err(|_| "Local-model public key is invalid.".to_string())?;
    let key = RsaPublicKey::from_public_key_pem(&pem)
        .map_err(|_| "Local-model public key is invalid.".to_string())?;
    if key.n().bits() < 2048 {
        return Err("Local-model public key is weaker than RSA-2048.".into());
    }
    Ok(key)
}

fn parse_manifest_payload(value: &Value) -> Result<ManifestPayload, String> {
    serde_json::from_value(value.clone())
        .map_err(|_| "Local-model manifest payload schema is invalid.".to_string())
}

fn versions_are_monotone(previous: (u64, u64), next: (u64, u64)) -> bool {
    next.0 >= previous.0 && next.1 >= previous.1
}

fn acceptance_generation_is_current(current: u64, candidate: u64) -> bool {
    candidate > 0 && candidate >= current
}

fn valid_manifest_session_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| {
        parsed.get_version_num() == 4 && parsed.hyphenated().to_string() == value
    })
}

fn validate_catalog_binding_input(binding: &CatalogBindingInput) -> Result<(), String> {
    if !valid_manifest_session_id(&binding.acceptance_session_id)
        || binding.acceptance_generation == 0
        || !valid_hash(&binding.manifest_payload_sha256)
    {
        return Err("Local-model catalog binding is invalid.".into());
    }
    Ok(())
}

fn require_catalog_binding<'a>(
    guard: &'a ManagerState,
    binding: &CatalogBindingInput,
) -> Result<&'a VerifiedCatalog, String> {
    validate_catalog_binding_input(binding)?;
    if guard.manifest_session_id.as_deref() != Some(binding.acceptance_session_id.as_str())
        || guard.catalog_generation != binding.acceptance_generation
    {
        return Err("Stale local-model catalog binding was rejected natively.".into());
    }
    let catalog = guard
        .catalog
        .as_ref()
        .ok_or("Verified local-model manifest is unavailable.")?;
    if catalog.payload_hash != binding.manifest_payload_sha256 {
        return Err("Local-model catalog hash binding differs from the active manifest.".into());
    }
    Ok(catalog)
}

fn operation_owns_catalog_binding(
    guard: &ManagerState,
    operation_id: &str,
    binding: &CatalogBindingInput,
) -> bool {
    guard.active_request_id.as_deref() == Some(operation_id)
        && require_catalog_binding(guard, binding).is_ok()
}

fn require_runtime_operation_checkpoint(
    operation_id: &str,
    binding: &CatalogBindingInput,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Local operation was cancelled.".into());
    }
    let guard = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.".to_string())?;
    if cancel.load(Ordering::SeqCst)
        || !operation_owns_catalog_binding(&guard, operation_id, binding)
    {
        return Err("Local operation lost its catalog binding.".into());
    }
    Ok(())
}

fn begin_manifest_acceptance(
    guard: &mut ManagerState,
    session_id: &str,
    acceptance_generation: u64,
) -> Result<Option<ManagedRuntime>, String> {
    if !valid_manifest_session_id(session_id) || acceptance_generation == 0 {
        return Err("Local-model manifest acceptance boundary is invalid.".into());
    }
    if guard.manifest_session_id.as_deref() != Some(session_id) {
        return Err("Stale local-model manifest acceptance session was rejected natively.".into());
    }
    if (guard.catalog.is_some() && acceptance_generation <= guard.catalog_generation)
        || guard
            .pending_catalog_generation
            .is_some_and(|pending| acceptance_generation < pending)
    {
        return Err(
            "Stale local-model manifest acceptance generation was rejected natively.".into(),
        );
    }
    if let Some(cancel) = guard.cancel.take() {
        cancel.store(true, Ordering::SeqCst);
    }
    guard.active_request_id = None;
    guard.catalog = None;
    guard.readiness.clear();
    guard.failures.clear();
    guard.cooldown_until_ms.clear();
    guard.last_error = None;
    guard.catalog_generation = 0;
    guard.pending_catalog_generation = Some(acceptance_generation);
    Ok(guard.runtime.take())
}

fn rotate_manifest_session(
    guard: &mut ManagerState,
    session_id: &str,
) -> Result<Option<ManagedRuntime>, String> {
    if !valid_manifest_session_id(session_id) {
        return Err("Local-model manifest acceptance session is invalid.".into());
    }
    if guard.manifest_session_id.as_deref() == Some(session_id) {
        return Ok(None);
    }
    if guard
        .retired_manifest_sessions
        .iter()
        .any(|retired| retired == session_id)
    {
        return Err(
            "Retired local-model manifest acceptance session was rejected natively.".into(),
        );
    }
    if let Some(previous) = guard.manifest_session_id.replace(session_id.to_string()) {
        guard.retired_manifest_sessions.insert(previous);
    }
    if let Some(cancel) = guard.cancel.take() {
        cancel.store(true, Ordering::SeqCst);
    }
    guard.active_request_id = None;
    guard.catalog = None;
    guard.readiness.clear();
    guard.failures.clear();
    guard.cooldown_until_ms.clear();
    guard.last_error = None;
    guard.catalog_generation = 0;
    guard.pending_catalog_generation = None;
    Ok(guard.runtime.take())
}

fn validate_manifest(payload: &ManifestPayload) -> Result<(), String> {
    if payload.schema_version != 1 || payload.catalog_version == 0 || payload.policy_version == 0 {
        return Err("Local-model manifest version is invalid.".into());
    }
    if payload.models.len() != 2 {
        return Err("Local-model catalog must contain exactly the supported releases.".into());
    }
    let mut ids = payload
        .models
        .iter()
        .map(|model| model.id.as_str())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    if ids != [FALLBACK_MODEL_ID, FLASH_MODEL_ID] {
        return Err("Local-model catalog contains unsupported releases.".into());
    }
    for model in &payload.models {
        validate_model(model)?;
    }
    let flash = payload
        .models
        .iter()
        .find(|model| model.id == FLASH_MODEL_ID)
        .ok_or("Flash model is missing.")?;
    let fallback = payload
        .models
        .iter()
        .find(|model| model.id == FALLBACK_MODEL_ID)
        .ok_or("Fallback model is missing.")?;
    if flash.routing_role != "preferred"
        || fallback.routing_role != "fallback"
        || (flash.promoted && flash.release_channel != "stable")
        || (!flash.promoted && flash.release_channel != "experimental")
        || !fallback.promoted
        || fallback.release_channel != "stable"
    {
        return Err("Local-model promotion metadata is inconsistent.".into());
    }
    validate_routing(&payload.routing, &payload.models)
}

fn validate_model(model: &ModelRelease) -> Result<(), String> {
    if !safe_id(&model.id)
        || model.execution_target != "local_llama_cpp"
        || !matches!(model.release_channel.as_str(), "experimental" | "stable")
        || !matches!(model.routing_role.as_str(), "preferred" | "fallback")
        || model.health_policy.cooldown_ms < 1_000
        || model.health_policy.max_consecutive_failures == 0
    {
        return Err("Local-model release metadata is invalid.".into());
    }
    if model.enabled {
        let artifact = model
            .artifact
            .as_ref()
            .ok_or("Enabled local model has no artifact metadata.")?;
        let runtime = model
            .runtime
            .as_ref()
            .ok_or("Enabled local model has no runtime metadata.")?;
        if !artifact.url.starts_with("https://")
            || !valid_hash(&artifact.sha256)
            || artifact.size_bytes == 0
            || artifact.format != "gguf"
            || !safe_quantization(&artifact.quantization)
            || !matches!(
                artifact.storage_class.as_str(),
                "fixed_nvme_required" | "fixed_storage"
            )
            || runtime.id != "llama.cpp"
            || !valid_hash(&runtime.sha256)
            || runtime.min_context_tokens == 0
            || runtime.max_context_tokens < runtime.min_context_tokens
            || model.context_limit.is_none()
            || model.capacity_policy.min_total_ram_bytes.is_none()
            || model.capacity_policy.min_available_ram_bytes.is_none()
            || model.capacity_policy.min_vram_bytes.is_none()
            || model.capacity_policy.min_storage_free_bytes.is_none()
            || model.capacity_policy.max_startup_seconds.is_none()
            || model.capacity_policy.benchmark_thresholds.is_none()
            || model
                .chat_template_hash
                .as_deref()
                .is_none_or(|v| !valid_hash(v))
            || model
                .evaluation_report_hash
                .as_deref()
                .is_none_or(|v| !valid_hash(v))
            || model.license.as_deref().is_none_or(str::is_empty)
        {
            return Err("Enabled local model has incomplete or unsafe metadata.".into());
        }
    }
    Ok(())
}

fn validate_routing(policy: &RoutingPolicy, models: &[ModelRelease]) -> Result<(), String> {
    let flash = models
        .iter()
        .find(|model| model.id == FLASH_MODEL_ID)
        .ok_or("Flash model is missing.")?;
    let required = [
        "model_enabled",
        "artifact_verified",
        "runtime_verified",
        "capacity_qualified",
        "health_eligible",
    ];
    if policy.strategy != "local_first"
        || !policy.local_first
        || policy.preferred_model_id != FLASH_MODEL_ID
        || policy.fallback_model_ids != [FALLBACK_MODEL_ID]
        || policy.external_execution_target != "laravel_proxy"
        || !policy.external_requires_explicit_approval
        || !policy.no_silent_external_fallback
        || !policy.experimental_opt_in_required
        || required.iter().any(|item| {
            !policy
                .required_local_state
                .iter()
                .any(|candidate| candidate == item)
        })
        || (flash.promoted && policy.default_model_id != FLASH_MODEL_ID)
        || (!flash.promoted && policy.default_model_id != FALLBACK_MODEL_ID)
        || (flash.promoted
            && policy
                .experimental_model_ids
                .iter()
                .any(|id| id == FLASH_MODEL_ID))
        || (!flash.promoted && policy.experimental_model_ids != [FLASH_MODEL_ID])
    {
        return Err("Local-model routing policy is unsafe or inconsistent.".into());
    }
    Ok(())
}

fn persist_versions(
    app: &AppHandle,
    trust_domain: &str,
    payload: &ManifestPayload,
    payload_hash: &str,
    contract_hash: &str,
) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("local-model");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let mut db =
        rusqlite::Connection::open(dir.join("catalog-state.sqlite3")).map_err(|e| e.to_string())?;
    persist_versions_in_connection(&mut db, trust_domain, payload, payload_hash, contract_hash)
}

fn persist_versions_in_connection(
    db: &mut rusqlite::Connection,
    trust_domain: &str,
    payload: &ManifestPayload,
    payload_hash: &str,
    contract_hash: &str,
) -> Result<(), String> {
    if !valid_manifest_trust_domain(trust_domain) {
        return Err("Local-model manifest trust domain is invalid.".into());
    }
    if !valid_hash(payload_hash) || !valid_hash(contract_hash) {
        return Err("Local-model manifest persistence hash is invalid.".into());
    }
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS catalog_state_v2 (trust_domain TEXT PRIMARY KEY, catalog_version INTEGER NOT NULL CHECK(catalog_version > 0), policy_version INTEGER NOT NULL CHECK(policy_version > 0), payload_hash TEXT NOT NULL, contract_hash TEXT NOT NULL) WITHOUT ROWID;",
    )
    .map_err(|e| e.to_string())?;
    let transaction = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let previous = transaction.query_row(
        "SELECT catalog_version, policy_version, payload_hash, contract_hash FROM catalog_state_v2 WHERE trust_domain=?1",
        [trust_domain],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    );
    match previous {
        Ok((catalog, policy, previous_payload_hash, previous_contract_hash)) => {
            let catalog = u64::try_from(catalog)
                .map_err(|_| "Persisted local-model catalog version is invalid.".to_string())?;
            let policy = u64::try_from(policy)
                .map_err(|_| "Persisted local-model policy version is invalid.".to_string())?;
            if catalog == 0
                || policy == 0
                || !valid_hash(&previous_payload_hash)
                || !valid_hash(&previous_contract_hash)
            {
                return Err("Persisted local-model manifest state is invalid.".into());
            }
            if !contract_versions_acceptable(
                (catalog, policy),
                (payload.catalog_version, payload.policy_version),
                &previous_contract_hash,
                contract_hash,
            ) {
                return Err("Local-model manifest downgrade or same-version equivocation was rejected natively.".into());
            }
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(error) => return Err(error.to_string()),
    }
    transaction.execute(
        "INSERT INTO catalog_state_v2(trust_domain,catalog_version,policy_version,payload_hash,contract_hash) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(trust_domain) DO UPDATE SET catalog_version=excluded.catalog_version, policy_version=excluded.policy_version, payload_hash=excluded.payload_hash, contract_hash=excluded.contract_hash",
        rusqlite::params![trust_domain, payload.catalog_version as i64, payload.policy_version as i64, payload_hash, contract_hash],
    )
    .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn collect_hardware_snapshot() -> Result<HardwareSnapshot, String> {
    let mut system = System::new_all();
    system.refresh_memory();
    system.refresh_cpu_usage();
    let accelerators = gpu_snapshot();
    let disks = Disks::new_with_refreshed_list();
    let storage = disks
        .list()
        .iter()
        .enumerate()
        .map(|(index, disk)| {
            let media = match disk.kind() {
                DiskKind::SSD => "ssd",
                DiskKind::HDD => "hdd",
                _ => "unknown",
            };
            // sysinfo exposes media kind, not the physical bus. Never promote
            // SSD to NVMe: a USB SSD would otherwise satisfy Flash policy.
            let bus = if disk.is_removable() {
                "usb"
            } else {
                "unknown"
            };
            StorageSnapshot {
                id: format!("disk-{index}"),
                mount_label: disk.mount_point().to_string_lossy().into_owned(),
                bus_type: bus.into(),
                media_type: media.into(),
                removable: disk.is_removable(),
                available_bytes: disk.available_space(),
            }
        })
        .collect();
    Ok(HardwareSnapshot {
        schema_version: 1,
        snapshot_id: Uuid::new_v4().to_string(),
        captured_at_ms: now_ms()? as i64,
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        cpu: CpuSnapshot {
            logical_cores: system.cpus().len(),
            physical_cores: system.physical_core_count(),
            features: Vec::new(),
            load_percent: system.global_cpu_usage().clamp(0.0, 100.0),
        },
        memory: MemorySnapshot {
            total_bytes: system.total_memory(),
            available_bytes: system.available_memory(),
        },
        accelerators,
        storage,
    })
}

fn gpu_snapshot() -> Vec<AcceleratorSnapshot> {
    let Ok(nvml) = Nvml::init() else {
        return Vec::new();
    };
    let Ok(count) = nvml.device_count() else {
        return Vec::new();
    };
    (0..count)
        .filter_map(|index| {
            let device = nvml.device_by_index(index).ok()?;
            let memory = device.memory_info().ok();
            Some(AcceleratorSnapshot {
                id: format!("cuda-{index}"),
                backend: "cuda".into(),
                name: device.name().unwrap_or_else(|_| "NVIDIA GPU".into()),
                total_bytes: memory.as_ref().map(|item| item.total),
                available_bytes: memory.as_ref().map(|item| item.free),
            })
        })
        .collect()
}

fn prepare_release(
    app: &AppHandle,
    model_id: &str,
    catalog_binding: &CatalogBindingInput,
) -> Result<NativeReadiness, String> {
    if !safe_id(model_id) {
        return Err("Invalid model release id.".into());
    }
    let operation_id = format!("prepare-{}", Uuid::new_v4().simple());
    let (catalog, model, cancel) =
        claim_prepare_operation(model_id, &operation_id, catalog_binding)?;
    let result = prepare_release_inner(
        app,
        catalog,
        model,
        &operation_id,
        catalog_binding,
        cancel.clone(),
    );
    let outcome = if cancel.load(Ordering::SeqCst) {
        RequestOutcome::Cancelled
    } else if result.is_ok() {
        RequestOutcome::Success
    } else {
        RequestOutcome::Failed
    };
    let mut runtime = release_operation(&operation_id, catalog_binding, outcome);
    if let Some(runtime) = runtime.as_mut() {
        runtime.stop();
    }
    result
}

fn claim_prepare_operation(
    model_id: &str,
    operation_id: &str,
    catalog_binding: &CatalogBindingInput,
) -> Result<(VerifiedCatalog, ModelRelease, Arc<AtomicBool>), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut guard = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.".to_string())?;
    let catalog = require_catalog_binding(&guard, catalog_binding)?.clone();
    if parse_rfc3339_millis(&catalog.payload.expires_at)? <= now_ms()? {
        return Err("Verified local-model manifest has expired.".into());
    }
    if guard.active_request_id.is_some() {
        return Err("Local runtime is already busy.".into());
    }
    let model = catalog
        .payload
        .models
        .iter()
        .find(|model| model.id == model_id && model.enabled)
        .cloned()
        .ok_or("Requested local model is unavailable.")?;
    guard.active_request_id = Some(operation_id.to_string());
    guard.cancel = Some(cancel.clone());
    Ok((catalog, model, cancel))
}

fn prepare_release_inner(
    app: &AppHandle,
    catalog: VerifiedCatalog,
    model: ModelRelease,
    operation_id: &str,
    catalog_binding: &CatalogBindingInput,
    cancel: Arc<AtomicBool>,
) -> Result<NativeReadiness, String> {
    validate_capacity(&model)?;
    let verified_artifacts = verify_configured_artifacts(app, &model, &cancel)?;
    let model_path = verified_artifacts.model_path.clone();
    let artifact = model
        .artifact
        .as_ref()
        .ok_or("Model artifact metadata is unavailable.")?;
    let runtime = model
        .runtime
        .as_ref()
        .ok_or("Runtime metadata is unavailable.")?;
    ensure_model_storage(
        &model_path,
        artifact,
        model
            .capacity_policy
            .min_storage_free_bytes
            .ok_or("Capacity policy has no storage threshold.")?,
    )?;
    let benchmark_scope =
        sha256_bytes(format!("luczor:local-benchmark:v1\0{}", model.id).as_bytes());
    ensure_runtime(
        app,
        &model,
        &benchmark_scope,
        operation_id,
        catalog_binding,
        &cancel,
    )?;
    run_signed_benchmark(&model, operation_id, catalog_binding, &cancel)?;
    let verified_at = now_ms()?;
    let valid_until =
        (verified_at + 10 * 60_000).min(parse_rfc3339_millis(&catalog.payload.expires_at)?);
    let readiness = ReadinessRecord {
        manifest_hash: catalog.payload_hash.clone(),
        artifact_hash: artifact.sha256.clone(),
        runtime_hash: runtime.sha256.clone(),
        verified_at_ms: verified_at,
        valid_until_ms: valid_until,
    };
    {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        if !operation_owns_catalog_binding(&guard, operation_id, catalog_binding) {
            return Err("Local-model prepare operation lost its catalog binding.".into());
        }
        guard.readiness.insert(model.id.clone(), readiness.clone());
    }
    Ok(NativeReadiness {
        model_release_id: model.id,
        manifest_payload_sha256: readiness.manifest_hash,
        artifact_sha256: readiness.artifact_hash,
        runtime_sha256: readiness.runtime_hash,
        ready: true,
        verified_at_ms: verified_at as i64,
        valid_until_ms: valid_until as i64,
    })
}

fn verify_configured_artifacts(
    app: &AppHandle,
    model: &ModelRelease,
    cancel: &AtomicBool,
) -> Result<VerifiedArtifactFiles, String> {
    let artifact = model
        .artifact
        .as_ref()
        .ok_or("Model artifact metadata is unavailable.")?;
    let runtime = model
        .runtime
        .as_ref()
        .ok_or("Runtime metadata is unavailable.")?;
    let (runtime_path, model_path) = configured_paths(app, &model.id)?;
    let mut model_guard = open_artifact_guard(&model_path)?;
    let mut runtime_guard = open_artifact_guard(&runtime_path)?;
    if model_guard
        .metadata()
        .map_err(|_| "Configured GGUF file is unavailable.")?
        .len()
        != artifact.size_bytes
    {
        return Err("Configured GGUF size does not match the signed manifest.".into());
    }
    if sha256_open_file_cancellable(&mut model_guard, cancel)? != artifact.sha256 {
        return Err("Configured GGUF hash does not match the signed manifest.".into());
    }
    if sha256_open_file_cancellable(&mut runtime_guard, cancel)? != runtime.sha256 {
        return Err("Configured llama.cpp runtime hash does not match the signed manifest.".into());
    }
    Ok(VerifiedArtifactFiles {
        runtime_path,
        model_path,
        runtime_guard,
        model_guard,
    })
}

fn validate_capacity(model: &ModelRelease) -> Result<(), String> {
    let snapshot = collect_hardware_snapshot()?;
    let policy = &model.capacity_policy;
    let min_total_ram = policy
        .min_total_ram_bytes
        .ok_or("Capacity policy has no total RAM threshold.")?;
    let min_ram = policy
        .min_available_ram_bytes
        .ok_or("Capacity policy has no RAM threshold.")?;
    if snapshot.memory.total_bytes < min_total_ram {
        return Err("Total RAM is below the signed model threshold.".into());
    }
    if snapshot.memory.available_bytes < min_ram {
        return Err("Available RAM is below the signed model threshold.".into());
    }
    if let Some(min_vram) = policy.min_vram_bytes {
        if !snapshot
            .accelerators
            .iter()
            .any(|gpu| gpu.total_bytes.is_some_and(|value| value >= min_vram))
        {
            return Err("GPU VRAM is below the signed model threshold.".into());
        }
    }
    Ok(())
}

fn run_signed_benchmark(
    model: &ModelRelease,
    operation_id: &str,
    catalog_binding: &CatalogBindingInput,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let thresholds = model
        .capacity_policy
        .benchmark_thresholds
        .as_ref()
        .ok_or("Capacity policy has no benchmark thresholds.")?;
    let (port, api_key) = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        if !operation_owns_catalog_binding(&guard, operation_id, catalog_binding) {
            return Err("Local-model benchmark lost its catalog binding.".into());
        }
        let runtime = guard
            .runtime
            .as_mut()
            .ok_or("Local runtime is unavailable for benchmark.")?;
        verified_runtime_endpoint(runtime)?
    };
    let prompt = "Antworte ausschließlich mit: LUCZOR_BENCHMARK_OK. ".repeat(64);
    let body = json!({
        "model": model.id,
        "messages": [
            {"role":"system","content":"Deterministischer lokaler Kapazitätstest. Keine Tools."},
            {"role":"user","content":prompt}
        ],
        "stream": true,
        "max_tokens": 16,
        "cache_prompt": false,
        "chat_template_kwargs": {"enable_thinking": false, "parse_tool_calls": false}
    });
    let read_timeout = signed_read_timeout(thresholds.max_first_token_ms)?;
    let started = Instant::now();
    let response = local_http_client(
        read_timeout,
        Duration::from_secs(MAX_INFERENCE_TOTAL_SECONDS),
    )?
    .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
    .bearer_auth(api_key)
    .header("Content-Type", "application/json")
    .body(serde_json::to_vec(&body).map_err(|error| error.to_string())?)
    .send()
    .map_err(|_| "Local benchmark request failed.".to_string())?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(llama_http_failure(status, response).public_message);
    }

    let mut first_token_ms = None;
    let mut prompt_tps = None;
    let mut decode_tps = None;
    let mut reader = BufReader::new(response);
    let mut line = Vec::new();
    let mut bytes = 0usize;
    let mut completed = false;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Local benchmark was cancelled.".into());
        }
        let read = read_bounded_line(&mut reader, &mut line, 256 * 1024)?;
        if read == 0 {
            break;
        }
        bytes = bytes.saturating_add(read);
        if bytes > 2 * 1024 * 1024 {
            return Err("Local benchmark response exceeded the native limit.".into());
        }
        let text = std::str::from_utf8(&line)
            .map_err(|_| "Local benchmark emitted invalid UTF-8.".to_string())?;
        let Some(data) = text.trim().strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if data == "[DONE]" {
            completed = true;
            break;
        }
        if data.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|_| "Local benchmark emitted invalid SSE JSON.".to_string())?;
        if first_token_ms.is_none()
            && value
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
                .is_some_and(|content| !content.is_empty())
        {
            first_token_ms = Some(started.elapsed().as_millis() as u64);
        }
        if let Some(timings) = value.get("timings").and_then(Value::as_object) {
            prompt_tps = timings.get("prompt_per_second").and_then(Value::as_f64);
            decode_tps = timings.get("predicted_per_second").and_then(Value::as_f64);
        }
    }
    if !completed {
        return Err("Local benchmark stream ended without a terminal marker.".into());
    }
    let first = first_token_ms.ok_or("Local benchmark produced no visible token.")?;
    let prompt = prompt_tps
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or("Local benchmark did not report a valid prompt throughput.")?;
    let decode = decode_tps
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or("Local benchmark did not report a valid decode throughput.")?;
    if !benchmark_qualifies(thresholds, prompt, decode, first) {
        return Err("Local benchmark did not meet the signed capacity thresholds.".into());
    }
    Ok(())
}

fn configured_paths(app: &AppHandle, model_id: &str) -> Result<(PathBuf, PathBuf), String> {
    let config_path = app
        .path()
        .app_data_dir()
        .map_err(|_| "Local-model configuration directory is unavailable.")?
        .join("local-model")
        .join("runtime-paths.json");
    configured_paths_from_sources(
        model_id,
        std::env::var_os("LUCZOR_LLAMA_CPP_BIN").map(PathBuf::from),
        std::env::var_os("LUCZOR_LOCAL_MODEL_DIR").map(PathBuf::from),
        &config_path,
    )
}

fn configured_paths_from_sources(
    model_id: &str,
    runtime_environment: Option<PathBuf>,
    model_directory_environment: Option<PathBuf>,
    config_path: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    if !safe_id(model_id) {
        return Err("Invalid model release id.".into());
    }
    // Explicit test-launcher overrides remain a pair and never mix with saved production paths.
    let (runtime, model_dir) = match (runtime_environment, model_directory_environment) {
        (Some(runtime), Some(model_dir)) => (runtime, model_dir),
        (None, None) => {
            let config = read_runtime_path_config(config_path)?;
            (config.runtime_path, config.model_directory)
        }
        _ => {
            return Err(
                "Both local-model runtime environment paths must be configured together.".into(),
            )
        }
    };
    if !runtime.is_absolute() || !model_dir.is_absolute() {
        return Err("Local-model runtime and model directory must be absolute local paths.".into());
    }
    reject_runtime_reparse_points(&runtime)?;
    reject_runtime_reparse_points(&model_dir)?;
    reject_runtime_reparse_points(&model_dir.join(format!("{model_id}.gguf")))?;
    let runtime =
        fs::canonicalize(runtime).map_err(|_| "Configured llama.cpp runtime is unavailable.")?;
    let model_dir = fs::canonicalize(model_dir)
        .map_err(|_| "Configured local-model directory is unavailable.")?;
    let model = fs::canonicalize(model_dir.join(format!("{model_id}.gguf")))
        .map_err(|_| "Configured GGUF file is unavailable.")?;
    if !model.starts_with(&model_dir) || !runtime.is_file() || !model.is_file() {
        return Err("Configured local-model files are invalid.".into());
    }
    Ok((runtime, model))
}

fn read_runtime_path_config(path: &Path) -> Result<RuntimePathConfig, String> {
    reject_runtime_reparse_points(path)?;
    let file = File::open(path).map_err(|_| {
        "Local-model runtime paths are not configured. Configure local-model/runtime-paths.json or both runtime environment paths."
    })?;
    let metadata = file
        .metadata()
        .map_err(|_| "Local-model runtime path configuration cannot be read.")?;
    if !metadata.is_file() || metadata.len() > MAX_RUNTIME_PATH_CONFIG_BYTES {
        return Err(
            "Local-model runtime path configuration exceeds its size limit or is not a file."
                .into(),
        );
    }
    let mut bytes = Vec::new();
    file.take(MAX_RUNTIME_PATH_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Local-model runtime path configuration cannot be read.")?;
    if bytes.len() as u64 > MAX_RUNTIME_PATH_CONFIG_BYTES {
        return Err("Local-model runtime path configuration exceeds its size limit.".into());
    }
    let config: RuntimePathConfig = serde_json::from_slice(&bytes)
        .map_err(|_| "Local-model runtime path configuration has an invalid schema.")?;
    if config.version != 1 {
        return Err("Local-model runtime path configuration version is unsupported.".into());
    }
    Ok(config)
}

fn reject_runtime_reparse_points(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let metadata = match fs::symlink_metadata(ancestor) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Local-model runtime path cannot be inspected.".into()),
        };
        #[cfg(windows)]
        let is_reparse_point = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x0000_0400 != 0
        };
        #[cfg(not(windows))]
        let is_reparse_point = false;
        if metadata.file_type().is_symlink() || is_reparse_point {
            return Err(
                "Local-model runtime paths must not contain symbolic links or reparse points."
                    .into(),
            );
        }
    }
    Ok(())
}

fn ensure_model_storage(
    path: &Path,
    artifact: &ModelArtifact,
    signed_min_storage_free_bytes: u64,
) -> Result<(), String> {
    let disks = Disks::new_with_refreshed_list();
    let disk = disks
        .list()
        .iter()
        .filter_map(|disk| {
            storage_mount_match_len(path, disk.mount_point()).map(|length| (disk, length))
        })
        .max_by_key(|(_, length)| *length)
        .map(|(disk, _)| disk)
        .ok_or("Model storage could not be classified.")?;
    let required = signed_min_storage_free_bytes.max(artifact.size_bytes);
    let proven_bus = if disk.is_removable() {
        "usb"
    } else {
        "unknown"
    };
    if !storage_class_eligible(&artifact.storage_class, disk.is_removable(), proven_bus)
        || disk.available_space() < required
    {
        return Err("Model storage is removable or has insufficient free space.".into());
    }
    Ok(())
}

fn storage_mount_match_len(path: &Path, mount_point: &Path) -> Option<usize> {
    let path = normalize_storage_mount_path(path)?;
    let mount_point = normalize_storage_mount_path(mount_point)?;
    path.starts_with(&mount_point)
        .then_some(mount_point.as_os_str().len())
}

#[cfg(windows)]
fn normalize_storage_mount_path(path: &Path) -> Option<PathBuf> {
    use std::path::{Component, Prefix};

    if !path.is_absolute() {
        return None;
    }

    let mut components = path.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return None,
        },
        _ => return None,
    };
    let mut normalized = PathBuf::from(format!("{}:\\", char::from(drive).to_ascii_uppercase()));
    for component in components {
        if !matches!(component, Component::RootDir) {
            normalized.push(component.as_os_str());
        }
    }
    Some(normalized)
}

#[cfg(not(windows))]
fn normalize_storage_mount_path(path: &Path) -> Option<PathBuf> {
    Some(path.to_path_buf())
}

fn storage_class_eligible(storage_class: &str, removable: bool, proven_bus: &str) -> bool {
    match storage_class {
        "fixed_storage" => !removable,
        "fixed_nvme_required" => !removable && proven_bus == "nvme",
        _ => false,
    }
}

fn benchmark_qualifies(
    thresholds: &BenchmarkThresholds,
    prompt_tokens_per_second: f64,
    decode_tokens_per_second: f64,
    first_token_ms: u64,
) -> bool {
    prompt_tokens_per_second.is_finite()
        && decode_tokens_per_second.is_finite()
        && prompt_tokens_per_second >= thresholds.min_prefill_tokens_per_second
        && decode_tokens_per_second >= thresholds.min_decode_tokens_per_second
        && first_token_ms <= thresholds.max_first_token_ms
}

fn validate_inference_request(request: &LocalInferenceRequest) -> Result<(), String> {
    validate_catalog_binding_input(&request.catalog_binding)?;
    if !safe_id(&request.request_id)
        || !valid_hash(&request.scope_digest)
        || !safe_id(&request.model_release_id)
        || !safe_id(&request.use_case)
        || request.messages.is_empty()
        || request.messages.len() > 256
        || request.tools.len() > MAX_TOOL_CALLS
        || request.max_output_tokens == 0
        || request.max_output_tokens > 16_384
        || request
            .context_limit
            .is_some_and(|value| value == 0 || value > 1_048_576)
        || !matches!(request.tool_choice.as_str(), "auto" | "required" | "none")
        || !matches!(request.reasoning_mode.as_str(), "auto" | "off")
    {
        return Err("Local inference request is invalid.".into());
    }
    let encoded =
        serde_json::to_vec(&json!({"messages": request.messages, "tools": request.tools}))
            .map_err(|error| error.to_string())?;
    if encoded.len() > 8 * 1024 * 1024 {
        return Err("Local inference request exceeds the native size limit.".into());
    }
    Ok(())
}

fn infer_blocking(
    app: &AppHandle,
    request: LocalInferenceRequest,
    on_event: Channel<LocalInferenceEvent>,
) -> Result<LocalInferenceResult, String> {
    // Catalog/session/hash validation, model/readiness lookup and ownership
    // claim are one native critical section. A pre-reload request therefore
    // cannot carry an old model snapshot across a session rotation.
    let (model, cancel) = claim_inference_operation(&request)?;
    if let Err(error) = ensure_runtime(
        app,
        &model,
        &request.scope_digest,
        &request.request_id,
        &request.catalog_binding,
        &cancel,
    ) {
        let outcome = if cancel.load(Ordering::SeqCst) {
            RequestOutcome::Cancelled
        } else {
            RequestOutcome::Failed
        };
        finish_request(
            &model,
            &request.request_id,
            &request.catalog_binding,
            outcome,
            None,
        );
        let _ = on_event.send(LocalInferenceEvent::Error {
            request_id: request.request_id.clone(),
            code: if outcome == RequestOutcome::Cancelled {
                "cancelled".into()
            } else {
                "runtime_start_failed".into()
            },
            retryable: outcome != RequestOutcome::Cancelled,
        });
        return Err(error);
    }
    let _ = on_event.send(LocalInferenceEvent::Started {
        request_id: request.request_id.clone(),
    });
    let result = stream_completion(&model, &request, cancel.clone(), &on_event);
    let outcome = if cancel.load(Ordering::SeqCst) {
        RequestOutcome::Cancelled
    } else if result.is_ok() {
        RequestOutcome::Success
    } else {
        RequestOutcome::Failed
    };
    if result.is_err() {
        let failure = result.as_ref().err();
        let _ = on_event.send(LocalInferenceEvent::Error {
            request_id: request.request_id.clone(),
            code: if outcome == RequestOutcome::Cancelled {
                "cancelled".into()
            } else {
                failure
                    .map(|error| error.code)
                    .unwrap_or("runtime_stream_failed")
                    .into()
            },
            retryable: outcome != RequestOutcome::Cancelled
                && failure.is_none_or(|error| error.retryable),
        });
    }
    let failure_code = if outcome == RequestOutcome::Failed {
        result.as_ref().err().map(|error| error.code)
    } else {
        None
    };
    finish_request(
        &model,
        &request.request_id,
        &request.catalog_binding,
        outcome,
        failure_code,
    );
    result.map_err(|error| error.public_message)
}

fn claim_inference_operation(
    request: &LocalInferenceRequest,
) -> Result<(ModelRelease, Arc<AtomicBool>), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut guard = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.".to_string())?;
    let catalog = require_catalog_binding(&guard, &request.catalog_binding)?.clone();
    let now = now_ms()?;
    if parse_rfc3339_millis(&catalog.payload.expires_at)? <= now {
        return Err("Verified local-model manifest has expired.".into());
    }
    if guard.active_request_id.is_some() {
        return Err("Local runtime is already busy.".into());
    }
    let model = catalog
        .payload
        .models
        .iter()
        .find(|model| model.id == request.model_release_id && model.enabled)
        .cloned()
        .ok_or("Requested local model is unavailable.")?;
    if request
        .context_limit
        .is_some_and(|requested| Some(requested) != model.context_limit)
    {
        return Err("Requested context limit differs from the signed model release.".into());
    }
    if guard
        .cooldown_until_ms
        .get(&model.id)
        .is_some_and(|until| *until > now)
    {
        return Err("Requested local model is in cooldown.".into());
    }
    let artifact = model
        .artifact
        .as_ref()
        .ok_or("Model artifact is unavailable.")?;
    let runtime = model
        .runtime
        .as_ref()
        .ok_or("Runtime artifact is unavailable.")?;
    let readiness = guard
        .readiness
        .get(&model.id)
        .ok_or("Local model has no verified readiness evidence.")?;
    if readiness.valid_until_ms <= now
        || readiness.manifest_hash != catalog.payload_hash
        || readiness.artifact_hash != artifact.sha256
        || readiness.runtime_hash != runtime.sha256
    {
        return Err("Local model readiness evidence is stale or mismatched.".into());
    }
    guard.active_request_id = Some(request.request_id.clone());
    guard.cancel = Some(cancel.clone());
    Ok((model, cancel))
}

fn ensure_runtime(
    app: &AppHandle,
    model: &ModelRelease,
    scope_digest: &str,
    operation_id: &str,
    catalog_binding: &CatalogBindingInput,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut previous_runtime = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        if !operation_owns_catalog_binding(&guard, operation_id, catalog_binding) {
            return Err("Local operation no longer owns the runtime.".into());
        }
        let reuse = if let Some(runtime) = guard.runtime.as_mut() {
            runtime.model_id == model.id
                && runtime.scope_digest == scope_digest
                && runtime
                    .child
                    .as_mut()
                    .ok_or("Local model runtime has already stopped.")?
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none()
        } else {
            false
        };
        if reuse {
            return Ok(());
        }
        guard.runtime.take()
    };
    if let Some(runtime) = previous_runtime.as_mut() {
        runtime.stop();
    }
    if cancel.load(Ordering::SeqCst) {
        return Err("Local operation was cancelled.".into());
    }

    // Process start and health waiting happen outside the manager mutex so
    // status and cancellation remain responsive.
    let mut pending_runtime = Some(start_runtime(
        app,
        model,
        scope_digest,
        operation_id,
        catalog_binding,
        cancel,
    )?);
    let should_install = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        if operation_owns_catalog_binding(&guard, operation_id, catalog_binding)
            && !cancel.load(Ordering::SeqCst)
            && guard.runtime.is_none()
        {
            guard.runtime = pending_runtime.take();
            true
        } else {
            false
        }
    };
    if !should_install {
        if let Some(runtime) = pending_runtime.as_mut() {
            runtime.stop();
        }
        return Err("Local operation lost runtime ownership.".into());
    }
    Ok(())
}

fn start_runtime(
    app: &AppHandle,
    model: &ModelRelease,
    scope_digest: &str,
    operation_id: &str,
    catalog_binding: &CatalogBindingInput,
    cancel: &AtomicBool,
) -> Result<ManagedRuntime, String> {
    // A readiness record proves a prior check, but every new process start
    // re-hashes both configured files. Windows also keeps read-only share
    // handles open for the complete runtime lifetime so the verified paths
    // cannot be replaced or opened for write/delete before use.
    let verified_artifacts = verify_configured_artifacts(app, model, cancel)?;
    let port = reserve_loopback_port()?;
    let api_key = Uuid::new_v4().simple().to_string();
    let key_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("local-model")
        .join("runtime");
    create_private_directory(&key_dir)?;
    require_runtime_operation_checkpoint(operation_id, catalog_binding, cancel)?;
    cleanup_stale_runtime_keys_once(&key_dir)?;
    require_runtime_operation_checkpoint(operation_id, catalog_binding, cancel)?;
    let api_key_file = key_dir.join(format!("{}.key", Uuid::new_v4()));
    write_private_file(&api_key_file, api_key.as_bytes())?;
    let context = model
        .context_limit
        .ok_or("Model context limit is unavailable.")?;
    let mut command = Command::new(&verified_artifacts.runtime_path);
    command
        .args([
            "--model",
            verified_artifacts.model_path.to_string_lossy().as_ref(),
            "--alias",
            &model.id,
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--api-key-file",
            api_key_file.to_string_lossy().as_ref(),
            "--no-webui",
            "--jinja",
            "--parallel",
            "1",
            "--ctx-size",
            &context.to_string(),
            "--no-cache-prompt",
        ])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    copy_minimal_environment(&mut command);
    configure_process(&mut command);
    if let Err(error) = require_runtime_operation_checkpoint(operation_id, catalog_binding, cancel)
    {
        let _ = fs::remove_file(&api_key_file);
        return Err(error);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_file(&api_key_file);
            return Err(format!("llama.cpp start failed: {error}"));
        }
    };
    let process_lifetime_guard = match attach_process_lifetime_guard(&child) {
        Ok(guard) => guard,
        Err(error) => {
            terminate_process(&mut child);
            let _ = fs::remove_file(&api_key_file);
            return Err(error);
        }
    };
    let mut runtime = ManagedRuntime {
        child: Some(child),
        model_id: model.id.clone(),
        scope_digest: scope_digest.into(),
        port,
        api_key,
        api_key_file,
        _runtime_guard: verified_artifacts.runtime_guard,
        _model_guard: verified_artifacts.model_guard,
        _process_lifetime_guard: process_lifetime_guard,
    };
    let timeout = Duration::from_secs(
        model
            .capacity_policy
            .max_startup_seconds
            .ok_or("Model startup threshold is unavailable.")?,
    );
    if let Err(error) = await_health(&mut runtime, timeout, cancel) {
        runtime.stop();
        return Err(error);
    }
    Ok(runtime)
}

fn await_health(
    runtime: &mut ManagedRuntime,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let client = local_http_client(Duration::from_secs(2), Duration::from_secs(2))?;
    let started = Instant::now();
    while started.elapsed() < timeout {
        if cancel.load(Ordering::SeqCst) {
            return Err("Local runtime startup was cancelled.".into());
        }
        let child = runtime
            .child
            .as_mut()
            .ok_or("Local model runtime has already stopped.")?;
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err("llama.cpp exited before becoming healthy.".into());
        }
        let child_id = child.id();
        if !loopback_listener_owned_by(runtime.port, child_id)? {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }
        if client
            .get(format!("http://127.0.0.1:{}/health", runtime.port))
            .bearer_auth(&runtime.api_key)
            .send()
            .is_ok_and(|response| response.status().is_success())
        {
            if loopback_listener_owned_by(runtime.port, child_id)? {
                return Ok(());
            }
            return Err("Local runtime lost ownership of its loopback listener.".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("llama.cpp health check timed out.".into())
}

fn llama_http_failure(status: u16, response: impl Read) -> LocalInferenceFailure {
    let kind = read_bounded_error_body(response)
        .as_deref()
        .map(|body| classify_llama_http_error(status, body))
        .unwrap_or_else(|| classify_llama_http_status(status));
    LocalInferenceFailure::http(status, kind)
}

fn read_bounded_error_body(response: impl Read) -> Option<Vec<u8>> {
    let mut reader = response.take((MAX_ERROR_RESPONSE_BYTES + 1) as u64);
    let mut body = Vec::with_capacity(MAX_ERROR_RESPONSE_BYTES.min(4 * 1024));
    reader.read_to_end(&mut body).ok()?;
    (body.len() <= MAX_ERROR_RESPONSE_BYTES).then_some(body)
}

fn classify_llama_http_error(status: u16, body: &[u8]) -> LlamaHttpFailureKind {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return classify_llama_http_status(status);
    };
    let error = value.get("error").unwrap_or(&value);
    let error_type = error
        .get("type")
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let error_code = error
        .get("code")
        .or_else(|| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = error
        .get("message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .unwrap_or_default();
    let diagnostic = format!("{error_type}\n{error_code}\n{message}").to_ascii_lowercase();

    if matches!(
        error_type.as_str(),
        "exceed_context_size"
            | "exceed_context_size_error"
            | "context_length_exceeded"
            | "context_window_exceeded"
    ) || diagnostic.contains("exceeds the available context size")
        || diagnostic.contains("context length exceeded")
        || diagnostic.contains("context window exceeded")
        || diagnostic.contains("context size has been exceeded")
        || diagnostic.contains("prompt is too long")
        || diagnostic.contains("prompt too long")
    {
        return LlamaHttpFailureKind::ContextWindowExceeded;
    }
    if diagnostic.contains("roles must alternate")
        || diagnostic.contains("role must alternate")
        || diagnostic.contains("system message must be at the beginning")
        || diagnostic.contains("system message must be first")
        || diagnostic.contains("system role is only allowed at the beginning")
        || diagnostic.contains("only user and assistant roles are supported")
    {
        return LlamaHttpFailureKind::ChatHistoryRejected;
    }
    if matches!(
        error_type.as_str(),
        "chat_template_error" | "template_error"
    ) || diagnostic.contains("chat template")
        || diagnostic.contains("chat_template")
        || diagnostic.contains("jinja")
    {
        return LlamaHttpFailureKind::ChatTemplateFailed;
    }
    if matches!(
        error_type.as_str(),
        "tool_schema_error" | "tool_call_error" | "tool_contract_error" | "grammar_error"
    ) || diagnostic.contains("tool schema")
        || diagnostic.contains("tool_choice")
        || diagnostic.contains("parse_tool_calls")
        || diagnostic.contains("cannot use tools")
        || diagnostic.contains("tool calling is not supported")
        || diagnostic.contains("tools are not supported")
        || diagnostic.contains("failed to parse tool call")
    {
        return LlamaHttpFailureKind::ToolContractRejected;
    }
    if matches!(
        error_type.as_str(),
        "insufficient_capacity" | "out_of_memory" | "server_busy"
    ) || diagnostic.contains("out of memory")
        || diagnostic.contains("not enough memory")
        || diagnostic.contains("failed to allocate")
        || diagnostic.contains("no available slot")
        || diagnostic.contains("server is busy")
    {
        return LlamaHttpFailureKind::CapacityExhausted;
    }
    if diagnostic.contains("model not found")
        || diagnostic.contains("model is unavailable")
        || diagnostic.contains("unknown model")
    {
        return LlamaHttpFailureKind::ModelUnavailable;
    }
    match error_type.as_str() {
        "authentication_error" | "permission_error" => LlamaHttpFailureKind::AuthenticationFailed,
        "not_found_error" => LlamaHttpFailureKind::ModelUnavailable,
        "unavailable_error" => LlamaHttpFailureKind::CapacityExhausted,
        "invalid_request_error" | "not_supported_error" => LlamaHttpFailureKind::RequestRejected,
        _ => classify_llama_http_status(status),
    }
}

fn classify_llama_http_status(status: u16) -> LlamaHttpFailureKind {
    match status {
        400 | 413 | 422 => LlamaHttpFailureKind::RequestRejected,
        401 | 403 => LlamaHttpFailureKind::AuthenticationFailed,
        404 => LlamaHttpFailureKind::ModelUnavailable,
        429 | 503 => LlamaHttpFailureKind::CapacityExhausted,
        500..=599 => LlamaHttpFailureKind::ServerFailed,
        _ => LlamaHttpFailureKind::HttpFailed,
    }
}

fn stream_completion(
    model: &ModelRelease,
    request: &LocalInferenceRequest,
    cancel: Arc<AtomicBool>,
    on_event: &Channel<LocalInferenceEvent>,
) -> Result<LocalInferenceResult, LocalInferenceFailure> {
    let (port, api_key) = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        if !operation_owns_catalog_binding(&guard, &request.request_id, &request.catalog_binding) {
            return Err("Local-model inference lost its catalog binding.".into());
        }
        let runtime = guard
            .runtime
            .as_mut()
            .ok_or("Local runtime is unavailable.")?;
        verified_runtime_endpoint(runtime)?
    };
    let thresholds = model
        .capacity_policy
        .benchmark_thresholds
        .as_ref()
        .ok_or("Capacity policy has no read-time threshold.")?;
    let body = json!({
        "model": request.model_release_id,
        "messages": request.messages,
        "tools": request.tools,
        "tool_choice": request.tool_choice,
        "stream": true,
        "max_tokens": request.max_output_tokens,
        "chat_template_kwargs": {
            "enable_thinking": request.reasoning_mode != "off",
            "parse_tool_calls": true
        }
    });
    let response = local_http_client(
        signed_read_timeout(thresholds.max_first_token_ms)?,
        Duration::from_secs(MAX_INFERENCE_TOTAL_SECONDS),
    )?
    .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
    .bearer_auth(api_key)
    .header("Content-Type", "application/json")
    .body(serde_json::to_vec(&body).map_err(|error| error.to_string())?)
    .send()
    .map_err(|_| "Local llama.cpp request failed.".to_string())?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(llama_http_failure(status, response));
    }
    parse_sse(response, request, cancel, on_event)
}

fn parse_sse(
    response: impl Read,
    request: &LocalInferenceRequest,
    cancel: Arc<AtomicBool>,
    on_event: &Channel<LocalInferenceEvent>,
) -> Result<LocalInferenceResult, LocalInferenceFailure> {
    let mut reader = BufReader::new(response);
    let mut line = Vec::new();
    let mut bytes = 0usize;
    let mut content = String::new();
    let mut finish_reason = "stop".to_string();
    let mut tools: BTreeMap<usize, (String, String, String)> = BTreeMap::new();
    let mut completed = false;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Local inference was cancelled.".into());
        }
        let read = read_bounded_line(&mut reader, &mut line, 1024 * 1024)?;
        if read == 0 {
            break;
        }
        bytes = bytes.saturating_add(read);
        if bytes > MAX_RESPONSE_BYTES {
            return Err("Local llama.cpp response exceeded the native size limit.".into());
        }
        let text = std::str::from_utf8(&line)
            .map_err(|_| "Local llama.cpp emitted invalid UTF-8.".to_string())?;
        let Some(raw) = text.trim().strip_prefix("data:") else {
            continue;
        };
        let data = raw.trim();
        if data == "[DONE]" {
            completed = true;
            break;
        }
        if data.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|_| "Local llama.cpp emitted invalid SSE JSON.".to_string())?;
        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
        else {
            continue;
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            finish_reason = reason.chars().take(64).collect();
            completed = true;
        }
        let Some(delta) = choice.get("delta").and_then(Value::as_object) else {
            continue;
        };
        // reasoning_content is deliberately ignored and never leaves native code.
        if let Some(chunk) = delta.get("content").and_then(Value::as_str) {
            content.push_str(chunk);
            if content.len() > MAX_CONTENT_CHARS {
                return Err("Local llama.cpp content exceeded the native size limit.".into());
            }
            on_event
                .send(LocalInferenceEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: chunk.to_string(),
                })
                .map_err(|_| "Local inference event channel closed.".to_string())?;
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if index >= MAX_TOOL_CALLS {
                    continue;
                }
                let entry = tools.entry(index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    entry.0 = id.chars().take(160).collect();
                }
                if let Some(function) = call.get("function").and_then(Value::as_object) {
                    if let Some(name) = function.get("name").and_then(Value::as_str) {
                        entry.1 = name.chars().take(160).collect();
                    }
                    if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                        if entry.2.len().saturating_add(arguments.len()) > MAX_TOOL_ARGUMENT_CHARS {
                            return Err(
                                "Local tool arguments exceeded the native size limit.".into()
                            );
                        }
                        entry.2.push_str(arguments);
                    }
                }
            }
        }
    }
    if !completed {
        return Err("Local llama.cpp stream ended without a terminal marker.".into());
    }
    let raw_tool_calls = tools
        .into_values()
        .filter(|(_, name, _)| !name.is_empty())
        .map(|(id, name, arguments)| NativeToolCall {
            id: if id.is_empty() {
                format!("call_{}", Uuid::new_v4().simple())
            } else {
                id
            },
            r#type: "function".into(),
            function: NativeToolFunction {
                name,
                arguments: if arguments.is_empty() {
                    "{}".into()
                } else {
                    arguments
                },
            },
        })
        .collect();
    Ok(LocalInferenceResult {
        content,
        raw_tool_calls,
        finish_reason,
        request_id: request.request_id.clone(),
    })
}

fn finish_request(
    model: &ModelRelease,
    request_id: &str,
    catalog_binding: &CatalogBindingInput,
    outcome: RequestOutcome,
    failure_code: Option<&str>,
) {
    let mut runtime_to_stop = None;
    if let Ok(mut guard) = state().lock() {
        if !operation_owns_catalog_binding(&guard, request_id, catalog_binding) {
            return;
        }
        guard.active_request_id = None;
        guard.cancel = None;
        match outcome {
            RequestOutcome::Success => {
                guard.failures.remove(&model.id);
                guard.cooldown_until_ms.remove(&model.id);
                guard.last_error = None;
            }
            RequestOutcome::Cancelled => {
                // User cancellation is not model-health evidence and must not
                // increase failures or trigger cooldown.
                guard.last_error = None;
            }
            RequestOutcome::Failed => {
                let failures = guard.failures.entry(model.id.clone()).or_default();
                *failures += 1;
                if *failures >= model.health_policy.max_consecutive_failures {
                    guard.cooldown_until_ms.insert(
                        model.id.clone(),
                        now_ms().unwrap_or(i128::MAX) + model.health_policy.cooldown_ms as i128,
                    );
                }
                guard.last_error = Some(failure_code.unwrap_or("local_runtime_failed").into());
                runtime_to_stop = guard.runtime.take();
            }
        }
    }
    if let Some(runtime) = runtime_to_stop.as_mut() {
        runtime.stop();
    }
}

fn release_operation(
    operation_id: &str,
    catalog_binding: &CatalogBindingInput,
    outcome: RequestOutcome,
) -> Option<ManagedRuntime> {
    let mut guard = state().lock().ok()?;
    if !operation_owns_catalog_binding(&guard, operation_id, catalog_binding) {
        return None;
    }
    guard.active_request_id = None;
    guard.cancel = None;
    match outcome {
        RequestOutcome::Success | RequestOutcome::Cancelled => {
            guard.last_error = None;
            None
        }
        RequestOutcome::Failed => {
            guard.last_error = Some("local_prepare_failed".into());
            guard.runtime.take()
        }
    }
}

fn signed_read_timeout(max_first_token_ms: u64) -> Result<Duration, String> {
    if max_first_token_ms == 0 {
        return Err("Signed first-token threshold is invalid.".into());
    }
    // The signed TTFT threshold is the trust-policy input. Ten TTFT windows
    // allow a streamed completion to finish while the native hard cap prevents
    // unbounded hangs even if a signed value is accidentally excessive.
    Ok(Duration::from_millis(
        max_first_token_ms
            .min(MAX_SIGNED_READ_TIMEOUT_MS)
            .saturating_mul(10),
    ))
}

fn local_http_client(read_timeout: Duration, total_timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(read_timeout.min(total_timeout))
        .build()
        .map_err(|error| error.to_string())
}

fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    output: &mut Vec<u8>,
    max: usize,
) -> Result<usize, String> {
    output.clear();
    loop {
        let (chunk, consumed, terminal) = {
            let available = reader
                .fill_buf()
                .map_err(|_| "Local llama.cpp stream failed.".to_string())?;
            if available.is_empty() {
                return Ok(output.len());
            }
            let consumed = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            if output.len().saturating_add(consumed) > max {
                return Err("Local llama.cpp SSE line exceeded the native limit.".into());
            }
            (
                available[..consumed].to_vec(),
                consumed,
                available.get(consumed.saturating_sub(1)) == Some(&b'\n'),
            )
        };
        output.extend_from_slice(&chunk);
        reader.consume(consumed);
        if terminal {
            return Ok(output.len());
        }
    }
}

fn create_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn cleanup_stale_runtime_keys(path: &Path) -> Result<(), String> {
    let entries = fs::read_dir(path).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        let Some(stem) = file_name.strip_suffix(".key") else {
            continue;
        };
        if Uuid::parse_str(stem).is_ok() {
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn cleanup_stale_runtime_keys_once(path: &Path) -> Result<(), String> {
    RUNTIME_KEY_CLEANUP
        .get_or_init(|| cleanup_stale_runtime_keys(path))
        .clone()
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(())
}

fn canonical_json(value: &Value) -> Result<Vec<u8>, String> {
    fn ordered(value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(ordered).collect()),
            Value::Object(items) => {
                let sorted = items
                    .iter()
                    .map(|(key, value)| (key.clone(), ordered(value)))
                    .collect::<BTreeMap<_, _>>();
                Value::Object(sorted.into_iter().collect())
            }
            _ => value.clone(),
        }
    }
    serde_json::to_vec(&ordered(value)).map_err(|error| error.to_string())
}

fn canonical_contract_hash(payload: &Value) -> Result<String, String> {
    let mut contract = payload.clone();
    let object = contract
        .as_object_mut()
        .ok_or("Local-model manifest payload is not an object.")?;
    object.remove("generated_at");
    object.remove("expires_at");
    Ok(sha256_bytes(&canonical_json(&contract)?))
}

fn contract_versions_acceptable(
    previous: (u64, u64),
    next: (u64, u64),
    previous_contract_hash: &str,
    next_contract_hash: &str,
) -> bool {
    versions_are_monotone(previous, next)
        && (previous != next
            || (!previous_contract_hash.is_empty() && previous_contract_hash == next_contract_hash))
}

fn sha256_open_file_cancellable(file: &mut File, cancel: &AtomicBool) -> Result<String, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Local artifact verification was cancelled.".into());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Local artifact verification was cancelled.".into());
        }
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        if cancel.load(Ordering::SeqCst) {
            return Err("Local artifact verification was cancelled.".into());
        }
        digest.update(&buffer[..read]);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(windows)]
fn open_artifact_guard(path: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(|_| "Configured local-model artifact cannot be locked for read-only use.".into())
}

#[cfg(not(windows))]
fn open_artifact_guard(_path: &Path) -> Result<File, String> {
    Err(
        "Local-model execution is disabled on this platform until immutable artifact guards are available."
            .into(),
    )
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_manifest_trust_domain(value: &str) -> bool {
    value.strip_prefix("server:v1:").is_some_and(valid_hash)
}

fn safe_quantization(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|e| e.to_string())
}

fn verified_runtime_endpoint(runtime: &mut ManagedRuntime) -> Result<(u16, String), String> {
    let child = runtime
        .child
        .as_mut()
        .ok_or("Local model runtime has already stopped.")?;
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("Local model runtime is no longer running.".into());
    }
    if !loopback_listener_owned_by(runtime.port, child.id())? {
        return Err("Local model runtime is not listening on its assigned loopback port.".into());
    }
    Ok((runtime.port, runtime.api_key.clone()))
}

fn loopback_listener_owned_by(port: u16, process_id: u32) -> Result<bool, String> {
    let sockets = get_sockets_info(AddressFamilyFlags::IPV4, ProtocolFlags::TCP)
        .map_err(|_| "Local runtime listener ownership could not be verified.".to_string())?;
    let listeners = sockets.into_iter().filter(|socket| {
        matches!(
            &socket.protocol_socket_info,
            ProtocolSocketInfo::Tcp(tcp)
                if tcp.local_addr == IpAddr::V4(Ipv4Addr::LOCALHOST)
                    && tcp.local_port == port
                    && tcp.state == TcpState::Listen
        )
    });
    let mut found = false;
    for listener in listeners {
        found = true;
        if !listener.associated_pids.contains(&process_id) {
            return Err("Loopback port is owned by a different local process.".into());
        }
    }
    Ok(found)
}

fn copy_minimal_environment(command: &mut Command) {
    for key in ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

#[cfg(windows)]
fn configure_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0000_0200 | 0x0800_0000);
}

#[cfg(windows)]
fn attach_process_lifetime_guard(child: &Child) -> Result<ProcessLifetimeGuard, String> {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err("Windows runtime job object could not be created.".into());
        }
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        let assigned = configured != 0
            && AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) != 0;
        if !assigned {
            let _ = CloseHandle(handle);
            return Err(
                "Windows runtime process could not be bound to its kill-on-close job.".into(),
            );
        }
        Ok(ProcessLifetimeGuard {
            handle: handle as isize,
        })
    }
}

#[cfg(unix)]
fn configure_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(windows))]
fn attach_process_lifetime_guard(_child: &Child) -> Result<ProcessLifetimeGuard, String> {
    Err(
        "Local-model execution is disabled on this platform until parent-death process protection is available."
            .into(),
    )
}

#[cfg(not(any(windows, unix)))]
fn configure_process(_command: &mut Command) {}

#[cfg(windows)]
fn terminate_process(child: &mut Child) {
    if child.try_wait().is_ok_and(|status| status.is_some()) {
        return;
    }
    let mut command = Command::new("taskkill.exe");
    command
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_process(&mut command);
    let _ = command.status();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn terminate_process(child: &mut Child) {
    if child.try_wait().is_ok_and(|status| status.is_some()) {
        return;
    }
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{}", child.id())])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(any(windows, unix)))]
fn terminate_process(child: &mut Child) {
    if child.try_wait().is_ok_and(|status| status.is_some()) {
        return;
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn now_ms() -> Result<i128, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is before the Unix epoch.".to_string())?
        .as_millis() as i128)
}

fn parse_rfc3339_millis(raw: &str) -> Result<i128, String> {
    let value = raw.trim();
    let (date, time_and_zone) = value.split_once('T').ok_or("Timestamp must be RFC3339.")?;
    if date.len() != 10 || date.as_bytes()[4] != b'-' || date.as_bytes()[7] != b'-' {
        return Err("Timestamp must be RFC3339.".into());
    }
    let year = digits(&date[0..4])? as i64;
    let month = digits(&date[5..7])?;
    let day = digits(&date[8..10])?;
    let (time, offset) = if let Some(time) = time_and_zone.strip_suffix('Z') {
        (time, 0_i64)
    } else {
        if time_and_zone.len() < 6 {
            return Err("Timestamp timezone is invalid.".into());
        }
        let split = time_and_zone.len() - 6;
        let (time, zone) = time_and_zone.split_at(split);
        let sign = match zone.as_bytes().first() {
            Some(b'+') => 1_i64,
            Some(b'-') => -1_i64,
            _ => return Err("Timestamp timezone is invalid.".into()),
        };
        if zone.as_bytes().get(3) != Some(&b':') {
            return Err("Timestamp timezone is invalid.".into());
        }
        (
            time,
            sign * (digits(&zone[1..3])? as i64 * 3_600 + digits(&zone[4..6])? as i64 * 60),
        )
    };
    let (clock, fraction) = time
        .split_once('.')
        .map_or((time, None), |(a, b)| (a, Some(b)));
    if clock.len() != 8 || clock.as_bytes()[2] != b':' || clock.as_bytes()[5] != b':' {
        return Err("Timestamp time is invalid.".into());
    }
    let hour = digits(&clock[0..2])? as i64;
    let minute = digits(&clock[3..5])? as i64;
    let second = digits(&clock[6..8])? as i64;
    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err("Timestamp values are invalid.".into());
    }
    let millis = fraction.map_or(Ok(0_i64), |value| {
        if value.is_empty() || value.len() > 9 || !value.bytes().all(|b| b.is_ascii_digit()) {
            return Err("Timestamp fraction is invalid.".to_string());
        }
        let mut digits = value.as_bytes().iter().copied().take(3).collect::<Vec<_>>();
        while digits.len() < 3 {
            digits.push(b'0');
        }
        std::str::from_utf8(&digits)
            .map_err(|_| "Timestamp fraction is invalid.".to_string())?
            .parse::<i64>()
            .map_err(|_| "Timestamp fraction is invalid.".to_string())
    })?;
    let days = days_from_civil(year, month, day);
    Ok(
        ((days * 86_400 + hour * 3_600 + minute * 60 + second - offset) as i128) * 1_000
            + millis as i128,
    )
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.rem_euclid(400) == 0
            || (year.rem_euclid(4) == 0 && year.rem_euclid(100) != 0) =>
        {
            29
        }
        2 => 28,
        _ => 0,
    }
}

fn digits(value: &str) -> Result<u32, String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Timestamp number is invalid.".into());
    }
    value
        .parse()
        .map_err(|_| "Timestamp number is invalid.".into())
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let adjusted = year - i64::from(month <= 2);
    let era = adjusted.div_euclid(400);
    let year_of_era = adjusted - era * 400;
    let shifted_month = month as i64 + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::{
        acceptance_generation_is_current, begin_manifest_acceptance, benchmark_qualifies,
        canonical_contract_hash, canonical_json, classify_llama_http_status,
        contract_versions_acceptable, decode_manifest_public_key, llama_http_failure,
        loopback_listener_owned_by, operation_owns_catalog_binding, parse_manifest_payload,
        parse_rfc3339_millis, persist_versions_in_connection, read_bounded_error_body,
        require_catalog_binding, rotate_manifest_session, safe_id, signed_read_timeout,
        storage_class_eligible, valid_hash, valid_manifest_session_id, valid_manifest_trust_domain,
        validate_discovery_binding, verify_envelope_with_trust, versions_are_monotone,
        BenchmarkThresholds, CatalogBindingInput, LlamaHttpFailureKind, ManagerState,
        SignedEnvelope, VerifiedCatalog, MAX_ERROR_RESPONSE_BYTES,
    };
    #[cfg(windows)]
    use super::{
        attach_process_lifetime_guard, configured_paths_from_sources, open_artifact_guard,
        read_runtime_path_config, sha256_open_file_cancellable, storage_mount_match_len,
        MAX_RUNTIME_PATH_CONFIG_BYTES,
    };
    use base64::Engine;
    use serde_json::json;
    #[cfg(windows)]
    use std::fs::{self, OpenOptions};
    use std::io::Cursor;
    use std::net::TcpListener;
    #[cfg(windows)]
    use std::path::Path;
    #[cfg(windows)]
    use std::process::Command;
    use std::time::Duration;
    #[cfg(windows)]
    use std::time::Instant;

    const GOLDEN_ENVELOPE: &str =
        include_str!("../../../tests/fixtures/local-model-manifest-golden-envelope.json");
    const GOLDEN_CANONICAL: &str =
        include_str!("../../../tests/fixtures/local-model-manifest-golden-canonical.json");
    const TEST_PUBLIC_KEY: &str =
        include_str!("../../../tests/fixtures/local-model-manifest-test-public.pem");
    const TEST_KEY_ID: &str = "luczor-local-model-test-2026-01";
    const WEAK_RSA_1024_PUBLIC_KEY_B64: &str = "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlHZk1BMEdDU3FHU0liM0RRRUJBUVVBQTRHTkFEQ0JpUUtCZ1FEd1pjMEJLMzZqMGEvYTZ6RGovaFpqekkyawpMaUR6VGpuVGZVSTVvUUkzazJtdkVBSi92Z042YTRqeUI5aGtDL3ptMXdLeUxjRTFMTFI4Qzd4Vk5nOG5nQUtQCndHbThITTU2VjRsUG9LYzRFWWlJM05Rc3liUGY2VzYrQU1EMFVXdlZveXVEQUEwekZvRlhtYTFURUU4c29HVGkKTFdOWTBMNkk0N08rWjZ3OFdRSURBUUFCCi0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=";

    #[cfg(windows)]
    struct RuntimePathFixture {
        root: std::path::PathBuf,
        runtime: std::path::PathBuf,
        model_directory: std::path::PathBuf,
        config: std::path::PathBuf,
    }

    #[cfg(windows)]
    impl RuntimePathFixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("luczor-runtime-paths-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let runtime = root.join("llama-server.exe");
            let model_directory = root.join("models");
            let config = root.join("runtime-paths.json");
            fs::create_dir_all(&model_directory).unwrap();
            fs::write(&runtime, b"fixture runtime, never executed").unwrap();
            fs::write(model_directory.join("model-a.gguf"), b"fixture model").unwrap();
            fs::write(
                &config,
                serde_json::to_vec(&json!({
                    "version": 1,
                    "runtime_path": runtime,
                    "model_directory": model_directory,
                }))
                .unwrap(),
            )
            .unwrap();
            Self {
                root,
                runtime,
                model_directory,
                config,
            }
        }
    }

    #[cfg(windows)]
    impl Drop for RuntimePathFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(windows)]
    #[test]
    fn runtime_paths_load_saved_config_without_launch_environment() {
        let fixture = RuntimePathFixture::new();
        let (runtime, model) =
            configured_paths_from_sources("model-a", None, None, &fixture.config).unwrap();
        assert_eq!(runtime, fs::canonicalize(&fixture.runtime).unwrap());
        assert_eq!(
            model,
            fs::canonicalize(fixture.model_directory.join("model-a.gguf")).unwrap()
        );
        assert!(configured_paths_from_sources("../outside", None, None, &fixture.config).is_err());
        assert_eq!(
            configured_paths_from_sources("model-b", None, None, &fixture.config).unwrap_err(),
            "Configured GGUF file is unavailable."
        );
    }

    #[cfg(windows)]
    #[test]
    fn runtime_paths_explicit_environment_pair_wins_without_mixing_sources() {
        let fixture = RuntimePathFixture::new();
        fs::write(
            &fixture.config,
            b"invalid saved config must be ignored by explicit test launch",
        )
        .unwrap();
        assert!(configured_paths_from_sources(
            "model-a",
            Some(fixture.runtime.clone()),
            Some(fixture.model_directory.clone()),
            &fixture.config
        )
        .is_ok());
        assert_eq!(
            configured_paths_from_sources(
                "model-a",
                Some(fixture.runtime.clone()),
                None,
                &fixture.config
            )
            .unwrap_err(),
            "Both local-model runtime environment paths must be configured together."
        );
        assert_eq!(
            configured_paths_from_sources(
                "model-a",
                None,
                Some(fixture.model_directory.clone()),
                &fixture.config
            )
            .unwrap_err(),
            "Both local-model runtime environment paths must be configured together."
        );
        assert!(configured_paths_from_sources(
            "model-a",
            Some(std::path::PathBuf::from("relative.exe")),
            Some(fixture.model_directory.clone()),
            &fixture.config
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn runtime_paths_reject_invalid_schema_version_relative_paths_and_oversized_files() {
        let fixture = RuntimePathFixture::new();
        for config in [
            json!({"version":2,"runtime_path":fixture.runtime,"model_directory":fixture.model_directory}),
            json!({"version":1,"runtime_path":fixture.runtime,"model_directory":fixture.model_directory,"extra":"not permitted"}),
            json!({"version":1,"runtime_path":"relative.exe","model_directory":fixture.model_directory}),
            json!({"version":1,"runtime_path":fixture.runtime}),
        ] {
            fs::write(&fixture.config, serde_json::to_vec(&config).unwrap()).unwrap();
            assert!(configured_paths_from_sources("model-a", None, None, &fixture.config).is_err());
        }
        fs::write(
            &fixture.config,
            vec![b' '; (MAX_RUNTIME_PATH_CONFIG_BYTES + 1) as usize],
        )
        .unwrap();
        assert!(read_runtime_path_config(&fixture.config)
            .unwrap_err()
            .contains("size limit"));
        fs::remove_file(&fixture.config).unwrap();
        assert!(read_runtime_path_config(&fixture.config)
            .unwrap_err()
            .contains("not configured"));
    }

    #[test]
    fn canonical_json_sorts_nested_object_keys_but_preserves_lists() {
        let value = json!({"z":1,"a":{"z":2,"a":3},"list":[{"b":1,"a":2}]});
        assert_eq!(
            String::from_utf8(canonical_json(&value).unwrap()).unwrap(),
            r#"{"a":{"a":3,"z":2},"list":[{"a":2,"b":1}],"z":1}"#
        );
    }

    #[test]
    fn ids_hashes_and_manifest_times_fail_closed() {
        assert!(safe_id("qwen3.8-flash-next"));
        assert!(!safe_id("../../model"));
        assert!(valid_hash(&"a".repeat(64)));
        assert!(!valid_hash(&"A".repeat(64)));
        assert_eq!(parse_rfc3339_millis("1970-01-01T00:00:00Z").unwrap(), 0);
        assert!(parse_rfc3339_millis("not-a-time").is_err());
        assert!(parse_rfc3339_millis("2026-02-29T00:00:00Z").is_err());
        assert!(parse_rfc3339_millis("2024-02-29T00:00:00Z").is_ok());
    }

    #[test]
    fn llama_http_context_error_is_classified_without_leaking_response_data() {
        let body = br#"{"error":{"code":400,"message":"request (30380 tokens) exceeds the available context size (8192 tokens); D:\\private\\prompt.txt","type":"exceed_context_size"}}"#;
        let failure = llama_http_failure(400, Cursor::new(body));

        assert_eq!(failure.code, "runtime_context_exceeded");
        assert!(!failure.retryable);
        assert_eq!(
            failure.public_message,
            "Local llama.cpp rejected the request because the context window was exceeded (HTTP 400)."
        );
        assert!(!failure.public_message.contains("30380"));
        assert!(!failure.public_message.contains("private"));
    }

    #[test]
    fn llama_http_500_chat_errors_have_only_fixed_safe_diagnostics() {
        let history_body = br#"{"error":{"code":500,"message":"Jinja Exception: Conversation roles must alternate user/assistant; prompt=TOP_SECRET","type":"server_error"}}"#;
        let history_failure = llama_http_failure(500, Cursor::new(history_body));
        assert_eq!(history_failure.code, "runtime_chat_history_rejected");
        assert!(!history_failure.retryable);
        assert_eq!(
            history_failure.public_message,
            "Local llama.cpp rejected the conversation role order in its chat template (HTTP 500)."
        );
        assert!(!history_failure.public_message.contains("TOP_SECRET"));

        let template_body = br#"{"error":{"code":500,"message":"Failed to apply chat template for D:\\private\\secret.gguf; prompt=TOP_SECRET","type":"server_error"}}"#;
        let failure = llama_http_failure(500, Cursor::new(template_body));

        assert_eq!(failure.code, "runtime_chat_template_failed");
        assert!(!failure.retryable);
        assert_eq!(
            failure.public_message,
            "Local llama.cpp could not apply the chat template (HTTP 500)."
        );
        assert!(!failure.public_message.contains("secret"));
        assert!(!failure.public_message.contains("TOP_SECRET"));
    }

    #[test]
    fn llama_http_tool_contract_and_capacity_errors_have_stable_codes() {
        let tool_failure = llama_http_failure(
            400,
            Cursor::new(
                br#"{"error":{"message":"tools are not supported by this configuration","type":"invalid_request_error"}}"#,
            ),
        );
        assert_eq!(tool_failure.code, "runtime_tool_contract_rejected");
        assert!(!tool_failure.retryable);

        let capacity_failure = llama_http_failure(
            503,
            Cursor::new(br#"{"error":{"message":"server is busy","type":"server_error"}}"#),
        );
        assert_eq!(capacity_failure.code, "runtime_capacity_exhausted");
        assert!(capacity_failure.retryable);

        let unsupported = llama_http_failure(
            501,
            Cursor::new(
                br#"{"error":{"message":"unsupported parameter","type":"not_supported_error"}}"#,
            ),
        );
        assert_eq!(unsupported.code, "runtime_request_rejected");
        assert!(!unsupported.retryable);
    }

    #[test]
    fn unknown_or_oversized_llama_http_errors_remain_generic_and_bounded() {
        let unknown = llama_http_failure(
            500,
            Cursor::new(
                br#"{"error":{"message":"D:\\private\\secret.gguf prompt=TOP_SECRET","type":"server_error"}}"#,
            ),
        );
        assert_eq!(unknown.code, "runtime_server_failed");
        assert_eq!(
            unknown.public_message,
            "Local llama.cpp reported an internal server error (HTTP 500)."
        );
        assert!(!unknown.public_message.contains("secret"));
        assert!(!unknown.public_message.contains("TOP_SECRET"));

        let oversized = vec![b'x'; MAX_ERROR_RESPONSE_BYTES + 1];
        assert!(read_bounded_error_body(Cursor::new(&oversized)).is_none());
        let oversized_failure = llama_http_failure(418, Cursor::new(oversized));
        assert_eq!(oversized_failure.code, "runtime_http_failed");
        assert_eq!(
            oversized_failure.public_message,
            "Local llama.cpp returned HTTP 418."
        );
        assert_eq!(
            classify_llama_http_status(401),
            LlamaHttpFailureKind::AuthenticationFailed
        );
    }

    #[test]
    fn php_golden_envelope_verifies_with_exact_canonical_bytes_and_rsa_key() {
        let envelope: SignedEnvelope = serde_json::from_str(GOLDEN_ENVELOPE).unwrap();
        let key_b64 = base64::engine::general_purpose::STANDARD.encode(TEST_PUBLIC_KEY.as_bytes());
        let now = parse_rfc3339_millis("2026-08-30T12:30:00Z").unwrap();

        let result = verify_envelope_with_trust(&envelope, TEST_KEY_ID, &key_b64, now).unwrap();
        assert_eq!(
            result.canonical_payload_sha256,
            "1ca6b2f8aedc633ec7f1685d8cc0c89485ffaa2d9e79224e32627d962eba1e0c"
        );
        let canonical = canonical_json(&envelope.payload).unwrap();
        assert_eq!(canonical, GOLDEN_CANONICAL.trim_end().as_bytes());
    }

    #[test]
    fn native_trust_anchor_rejects_rsa_keys_below_2048_bits() {
        assert!(decode_manifest_public_key(WEAK_RSA_1024_PUBLIC_KEY_B64)
            .unwrap_err()
            .contains("RSA-2048"));
    }

    #[test]
    fn native_discovery_binding_precedes_catalog_persistence() {
        let envelope: SignedEnvelope = serde_json::from_str(GOLDEN_ENVELOPE).unwrap();
        let payload = parse_manifest_payload(&envelope.payload).unwrap();
        assert!(validate_discovery_binding(
            &envelope,
            &payload,
            payload.schema_version,
            payload.catalog_version,
            payload.policy_version,
            TEST_KEY_ID
        )
        .is_ok());
        assert!(validate_discovery_binding(
            &envelope,
            &payload,
            payload.schema_version,
            payload.catalog_version + 1,
            payload.policy_version,
            TEST_KEY_ID
        )
        .is_err());
    }

    #[test]
    fn stale_native_manifest_generation_cannot_replace_a_newer_catalog() {
        assert!(acceptance_generation_is_current(0, 1));
        assert!(acceptance_generation_is_current(4, 4));
        assert!(acceptance_generation_is_current(4, 5));
        assert!(!acceptance_generation_is_current(4, 3));
        assert!(!acceptance_generation_is_current(0, 0));
    }

    #[test]
    fn renderer_manifest_sessions_reset_generation_and_cannot_be_reclaimed() {
        let first = "00000000-0000-4000-8000-000000000001";
        let second = "00000000-0000-4000-8000-000000000002";
        assert!(valid_manifest_session_id(first));
        assert!(!valid_manifest_session_id(
            "00000000-0000-1000-8000-000000000001"
        ));
        assert!(!valid_manifest_session_id(
            "00000000-0000-4000-8000-000000000001 "
        ));

        let mut manager = ManagerState::default();
        rotate_manifest_session(&mut manager, first).unwrap();
        begin_manifest_acceptance(&mut manager, first, 7).unwrap();
        assert_eq!(manager.pending_catalog_generation, Some(7));
        assert!(begin_manifest_acceptance(&mut manager, first, 6).is_err());
        manager.catalog_generation = 7;
        manager.pending_catalog_generation = None;
        let envelope: SignedEnvelope = serde_json::from_str(GOLDEN_ENVELOPE).unwrap();
        manager.catalog = Some(VerifiedCatalog {
            payload_hash: envelope.payload_sha256.clone(),
            payload: parse_manifest_payload(&envelope.payload).unwrap(),
        });
        let old_binding = CatalogBindingInput {
            acceptance_session_id: first.into(),
            acceptance_generation: 7,
            manifest_payload_sha256: envelope.payload_sha256,
        };
        manager.failures.insert("model".into(), 2);
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        manager.active_request_id = Some("request".into());
        manager.cancel = Some(cancel.clone());
        assert!(require_catalog_binding(&manager, &old_binding).is_ok());
        assert!(operation_owns_catalog_binding(
            &manager,
            "request",
            &old_binding
        ));

        rotate_manifest_session(&mut manager, first).unwrap();
        assert_eq!(manager.catalog_generation, 7);
        assert!(!cancel.load(std::sync::atomic::Ordering::SeqCst));
        assert!(begin_manifest_acceptance(&mut manager, first, 7).is_err());

        begin_manifest_acceptance(&mut manager, first, 8).unwrap();
        assert_eq!(manager.pending_catalog_generation, Some(8));
        assert_eq!(manager.catalog_generation, 0);
        assert!(cancel.load(std::sync::atomic::Ordering::SeqCst));
        assert!(require_catalog_binding(&manager, &old_binding).is_err());
        assert!(!operation_owns_catalog_binding(
            &manager,
            "request",
            &old_binding
        ));

        rotate_manifest_session(&mut manager, second).unwrap();
        assert_eq!(manager.manifest_session_id.as_deref(), Some(second));
        assert_eq!(manager.catalog_generation, 0);
        assert_eq!(manager.pending_catalog_generation, None);
        assert!(manager.failures.is_empty());
        assert!(manager.active_request_id.is_none());
        assert!(cancel.load(std::sync::atomic::Ordering::SeqCst));
        assert!(manager
            .retired_manifest_sessions
            .iter()
            .any(|session| session == first));

        assert!(rotate_manifest_session(&mut manager, first).is_err());
        assert_eq!(manager.manifest_session_id.as_deref(), Some(second));
    }

    #[test]
    fn anti_downgrade_state_isolated_by_verified_server_domain() {
        let envelope: SignedEnvelope = serde_json::from_str(GOLDEN_ENVELOPE).unwrap();
        let payload = parse_manifest_payload(&envelope.payload).unwrap();
        let contract_hash = canonical_contract_hash(&envelope.payload).unwrap();
        let domain_a = format!("server:v1:{}", "a".repeat(64));
        let domain_b = format!("server:v1:{}", "b".repeat(64));
        assert!(valid_manifest_trust_domain(&domain_a));
        assert!(!valid_manifest_trust_domain("server:v1:device-key"));

        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        persist_versions_in_connection(
            &mut db,
            &domain_a,
            &payload,
            &envelope.payload_sha256,
            &contract_hash,
        )
        .unwrap();

        let mut lower = payload.clone();
        lower.catalog_version -= 1;
        lower.policy_version -= 1;
        let lower_value = serde_json::to_value(&lower).unwrap();
        let lower_contract_hash = canonical_contract_hash(&lower_value).unwrap();
        assert!(persist_versions_in_connection(
            &mut db,
            &domain_a,
            &lower,
            &envelope.payload_sha256,
            &lower_contract_hash,
        )
        .is_err());
        persist_versions_in_connection(
            &mut db,
            &domain_b,
            &lower,
            &envelope.payload_sha256,
            &lower_contract_hash,
        )
        .unwrap();

        db.execute(
            "UPDATE catalog_state_v2 SET catalog_version='corrupt' WHERE trust_domain=?1",
            [&domain_b],
        )
        .unwrap();
        assert!(persist_versions_in_connection(
            &mut db,
            &domain_b,
            &payload,
            &envelope.payload_sha256,
            &contract_hash,
        )
        .is_err());
    }

    #[test]
    fn loopback_listener_is_bound_to_the_expected_process() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(loopback_listener_owned_by(port, std::process::id()).unwrap());
        assert!(loopback_listener_owned_by(port, u32::MAX).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_guard_kills_the_runtime_tree_when_closed() {
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/S", "/C", "ping 127.0.0.1 -n 30 >NUL"])
            .spawn()
            .unwrap();
        let guard = attach_process_lifetime_guard(&child).unwrap();
        drop(guard);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = child.kill();
        let _ = child.wait();
        panic!("Windows kill-on-close job did not terminate the runtime tree.");
    }

    #[cfg(windows)]
    #[test]
    fn windows_artifact_guard_denies_write_and_replacement_until_drop() {
        let path =
            std::env::temp_dir().join(format!("luczor-artifact-{}.bin", uuid::Uuid::new_v4()));
        fs::write(&path, b"verified").unwrap();
        let mut guard = open_artifact_guard(&path).unwrap();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        assert!(sha256_open_file_cancellable(&mut guard, &cancel).is_ok());
        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(sha256_open_file_cancellable(&mut guard, &cancel)
            .unwrap_err()
            .contains("cancelled"));
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::remove_file(&path).is_err());
        drop(guard);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn golden_envelope_rejects_payload_signature_key_algorithm_and_time_tampering() {
        let envelope: SignedEnvelope = serde_json::from_str(GOLDEN_ENVELOPE).unwrap();
        let key_b64 = base64::engine::general_purpose::STANDARD.encode(TEST_PUBLIC_KEY.as_bytes());
        let now = parse_rfc3339_millis("2026-08-30T12:30:00Z").unwrap();

        let mut payload_tamper = envelope.clone();
        *payload_tamper
            .payload
            .pointer_mut("/models/0/display_name")
            .unwrap() = json!("tampered");
        assert!(verify_envelope_with_trust(&payload_tamper, TEST_KEY_ID, &key_b64, now).is_err());

        let mut signature_tamper = envelope.clone();
        signature_tamper.signature.replace_range(0..1, "A");
        assert!(verify_envelope_with_trust(&signature_tamper, TEST_KEY_ID, &key_b64, now).is_err());

        assert!(verify_envelope_with_trust(&envelope, "unknown-key", &key_b64, now).is_err());
        let mut algorithm_tamper = envelope.clone();
        algorithm_tamper.algorithm = "none".into();
        assert!(verify_envelope_with_trust(&algorithm_tamper, TEST_KEY_ID, &key_b64, now).is_err());

        let expired = parse_rfc3339_millis("2026-08-30T13:00:01Z").unwrap();
        assert!(verify_envelope_with_trust(&envelope, TEST_KEY_ID, &key_b64, expired).is_err());
    }

    #[test]
    fn versions_storage_benchmark_and_timeout_policies_fail_closed() {
        assert!(versions_are_monotone((7, 9), (7, 10)));
        assert!(!versions_are_monotone((7, 9), (6, 10)));
        assert!(!versions_are_monotone((7, 9), (8, 8)));

        assert!(storage_class_eligible("fixed_storage", false, "unknown"));
        assert!(!storage_class_eligible("fixed_storage", true, "usb"));
        assert!(!storage_class_eligible(
            "fixed_nvme_required",
            false,
            "unknown"
        ));
        assert!(storage_class_eligible("fixed_nvme_required", false, "nvme"));

        let thresholds = BenchmarkThresholds {
            min_prefill_tokens_per_second: 10.0,
            min_decode_tokens_per_second: 5.0,
            max_first_token_ms: 2_000,
        };
        assert!(benchmark_qualifies(&thresholds, 10.0, 5.0, 2_000));
        assert!(!benchmark_qualifies(&thresholds, 9.9, 5.0, 2_000));
        assert!(!benchmark_qualifies(&thresholds, 10.0, 4.9, 2_000));
        assert!(!benchmark_qualifies(&thresholds, 10.0, 5.0, 2_001));
        assert!(!benchmark_qualifies(&thresholds, f64::NAN, 5.0, 2_000));

        assert_eq!(signed_read_timeout(2_000).unwrap(), Duration::from_secs(20));
        assert_eq!(
            signed_read_timeout(u64::MAX).unwrap(),
            Duration::from_millis(1_200_000)
        );
        assert!(signed_read_timeout(0).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_storage_mount_matches_extended_length_drive_path() {
        assert!(
            storage_mount_match_len(Path::new(r"\\?\D:\models\orca.gguf"), Path::new(r"D:\"))
                .is_some()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_storage_mount_matches_normal_drive_path() {
        assert!(
            storage_mount_match_len(Path::new(r"D:\models\orca.gguf"), Path::new(r"D:\")).is_some()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_storage_mount_does_not_match_partial_component_prefix() {
        assert!(storage_mount_match_len(
            Path::new(r"\\?\D:\models-other\orca.gguf"),
            Path::new(r"D:\models")
        )
        .is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_storage_mount_rejects_network_paths() {
        assert!(storage_mount_match_len(
            Path::new(r"\\?\UNC\server\share\models\orca.gguf"),
            Path::new(r"\\?\UNC\server\share")
        )
        .is_none());
        assert!(storage_mount_match_len(
            Path::new(r"\\server\share\models\orca.gguf"),
            Path::new(r"\\server\share")
        )
        .is_none());
    }

    #[test]
    fn same_version_allows_time_renewal_but_rejects_contract_equivocation() {
        let envelope: SignedEnvelope = serde_json::from_str(GOLDEN_ENVELOPE).unwrap();
        let original = canonical_contract_hash(&envelope.payload).unwrap();
        let mut renewed = envelope.payload.clone();
        *renewed.get_mut("generated_at").unwrap() = json!("2026-08-30T12:15:00Z");
        *renewed.get_mut("expires_at").unwrap() = json!("2026-08-30T13:15:00Z");
        assert_eq!(canonical_contract_hash(&renewed).unwrap(), original);
        assert!(contract_versions_acceptable(
            (7, 9),
            (7, 9),
            &original,
            &original
        ));
        assert!(!contract_versions_acceptable((7, 9), (7, 9), "", &original));

        let mut changed = envelope.payload.clone();
        *changed.pointer_mut("/models/0/artifact/sha256").unwrap() = json!("f".repeat(64));
        let changed_hash = canonical_contract_hash(&changed).unwrap();
        assert_ne!(changed_hash, original);
        assert!(!contract_versions_acceptable(
            (7, 9),
            (7, 9),
            &original,
            &changed_hash
        ));
        assert!(contract_versions_acceptable(
            (7, 9),
            (8, 10),
            &original,
            &changed_hash
        ));
    }
}
