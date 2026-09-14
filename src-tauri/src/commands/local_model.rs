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
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[cfg(target_os = "linux")]
#[path = "local_model_linux.rs"]
mod linux_protection;

use super::{ensure_main_or_system_status_webview, ensure_main_webview};

#[path = "local_model_generation.rs"]
mod generation_safety;
#[path = "local_model_stream.rs"]
mod generation_stream;
#[path = "local_model_idle.rs"]
mod idle_inference;
#[path = "local_model_network.rs"]
mod local_network;
pub(crate) use local_network::LocalNetworkSnapshot;

pub(crate) fn network_snapshot() -> LocalNetworkSnapshot {
    local_network::snapshot()
}

#[path = "local_model_accelerators.rs"]
mod accelerator_inventory;
#[path = "local_model_context.rs"]
mod context_budget;
use context_budget::ContextUsage;
#[path = "local_model_failure.rs"]
mod failure_diagnostics;
#[path = "local_model_gpu.rs"]
mod gpu_runtime;
#[path = "local_model_install.rs"]
mod install;
#[path = "local_model_messages.rs"]
mod local_messages;
#[path = "local_model_reasoning.rs"]
mod reasoning_budget;
#[path = "local_model_acceptance.rs"]
mod resource_acceptance;
#[path = "local_model_resource_config.rs"]
pub mod resource_config;
#[path = "local_model_resources.rs"]
mod resource_runtime;
#[path = "local_model_storage.rs"]
mod storage_probe;
#[path = "local_model_trust.rs"]
mod trust;

const PUBLIC_KEY_B64: Option<&str> = option_env!("LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64");
const EXPECTED_KEY_ID: Option<&str> = option_env!("LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID");
const FLASH_MODEL_ID: &str = "qwen3.8-flash-next";
const FALLBACK_MODEL_ID: &str = "orcarouter-qwen3.8-27b-uncensored-q4-k-m";
// SSE framing/timings can exceed the text size many times. The HTTP queue is
// independently bounded to four 32 KiB chunks; private text is not retained.
const MAX_RESPONSE_BYTES: usize = 128 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_CONTENT_CHARS: usize = 4 * 1024 * 1024;
const MAX_TOOL_CALLS: usize = 128;
const MAX_TOOL_ARGUMENT_CHARS: usize = 1024 * 1024;
const MAX_SIGNED_READ_TIMEOUT_MS: u64 = 120_000;
const MAX_INFERENCE_TOTAL_SECONDS: u64 = 30 * 60;
const MAX_RUNTIME_PATH_CONFIG_BYTES: u64 = 16 * 1024;
const RESIDENT_RENEWAL_UNAVAILABLE: &str =
    "Resident local model is unavailable for readiness renewal.";
const IDLE_CONTEXT_USE_CASE: &str = "context.optimize";
const IDLE_RESIDENT_UNAVAILABLE: &str =
    "Background local optimization requires an already resident model in the same scope.";

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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "gpu_runtime::deserialize_present_option"
    )]
    backend: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "gpu_runtime::deserialize_present_option"
    )]
    files: Option<Vec<RuntimeSupportFile>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RuntimeSupportFile {
    name: String,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CapacityPolicy {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "gpu_runtime::deserialize_present_option"
    )]
    accelerator_memory_scope: Option<String>,
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
    resource_revision: u64,
    benchmark: Option<resource_acceptance::BenchmarkMeasurement>,
    child: Option<Child>,
    model_id: String,
    scope: RuntimeScope,
    prepared_manifest_hash: Option<String>,
    port: u16,
    api_key: String,
    api_key_file: PathBuf,
    acceleration: Arc<Mutex<gpu_runtime::RuntimeAcceleration>>,
    resource_plan: resource_runtime::ResourcePlan,
    model_storage: ModelStorage,
    /// Set only when the runtime binary advertised `--slot-save-path` support and the
    /// directory was passed at startup. `stop()` uses it to persist this scope's KV cache
    /// before the process exits; only the same scope and runtime layout may restore it.
    slot_cache_dir: Option<PathBuf>,
    slot_cache_namespace: String,
    #[cfg(target_os = "linux")]
    _linux_bundle: Arc<linux_protection::Bundle>,
    _runtime_guard: File,
    _support_guards: Vec<File>,
    _model_guard: File,
    _process_lifetime_guard: ProcessLifetimeGuard,
}

/// Preparation contains only a fixed public benchmark. The first real request
/// claims that process; maintenance must never erase an existing private scope.
#[derive(Debug, Default, PartialEq, Eq)]
enum RuntimeScope {
    #[default]
    Prepared,
    Bound(String),
}

impl RuntimeScope {
    fn claim(&mut self, requested: Option<&str>) -> bool {
        match (&*self, requested) {
            (_, None) => true,
            (Self::Prepared, Some(digest)) => {
                *self = Self::Bound(digest.into());
                true
            }
            (Self::Bound(current), Some(digest)) => current == digest,
        }
    }
}

#[derive(Debug)]
struct VerifiedArtifactFiles {
    #[cfg(target_os = "linux")]
    linux_bundle: Arc<linux_protection::Bundle>,
    #[cfg(target_os = "linux")]
    storage_path: PathBuf,
    runtime_path: PathBuf,
    model_path: PathBuf,
    runtime_guard: File,
    support_guards: Vec<File>,
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

#[cfg(target_os = "linux")]
type ProcessLifetimeGuard = linux_protection::LifetimeGuard;

#[cfg(not(any(windows, target_os = "linux")))]
#[derive(Debug)]
struct ProcessLifetimeGuard;

impl ManagedRuntime {
    fn reuse(&mut self, model_id: &str, scope: Option<&str>) -> Result<bool, String> {
        if self.model_id != model_id {
            return Ok(false);
        }
        let Some(child) = self.child.as_mut() else {
            return Ok(false);
        };
        Ok(child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
            && self.scope.claim(scope))
    }

    fn stop(&mut self) {
        // Bank this scope's KV cache to disk while the process can still answer the save
        // request, before anything below makes it unreachable or kills it outright.
        if let (Some(dir), RuntimeScope::Bound(digest)) = (&self.slot_cache_dir, &self.scope) {
            if self
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok())
                .is_some_and(|status| status.is_none())
            {
                save_slot_cache(
                    self.port,
                    &self.api_key,
                    dir,
                    &self.slot_cache_namespace,
                    digest,
                );
            }
        }
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

/// Cache saving and process termination are blocking, including ManagedRuntime::drop.
/// Move ownership into the blocking worker so cancellation of the IPC future cannot
/// drop the runtime (and a reqwest blocking client) on a Tokio worker.
async fn stop_runtime_async(runtime: Option<ManagedRuntime>) -> Result<(), String> {
    if runtime.is_none() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || drop(runtime))
        .await
        .map_err(|_| "Local runtime teardown failed.".to_string())
}

#[derive(Debug, Clone)]
struct ReadinessRecord {
    resource_revision: u64,
    manifest_hash: String,
    artifact_hash: String,
    runtime_hash: String,
    verified_at_ms: i128,
    valid_until_ms: i128,
}

#[derive(Debug, Default)]
struct ManagerState {
    resource_settings: resource_config::ResourceSettings,
    resource_settings_loaded: bool,
    resource_work_leases: HashSet<String>,
    catalog: Option<VerifiedCatalog>,
    runtime: Option<ManagedRuntime>,
    readiness: HashMap<String, ReadinessRecord>,
    active_request_id: Option<String>,
    active_idle_optimization: bool,
    active_reasoning: Option<Arc<Mutex<reasoning_budget::Session>>>,
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
    Rejected,
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
    diagnostic: failure_diagnostics::Diagnostic,
}

impl LocalInferenceFailure {
    fn preserves_resident_runtime(&self) -> bool {
        self.is_input_rejection()
            || matches!(
                self.code,
                "runtime_reasoning_control_unavailable" | "runtime_output_repeated"
            )
    }

    fn is_input_rejection(&self) -> bool {
        matches!(
            self.code,
            "runtime_context_exceeded"
                | "runtime_chat_history_rejected"
                | "runtime_chat_template_failed"
                | "runtime_tool_contract_rejected"
        ) || (self.code == "runtime_request_rejected" && self.diagnostic.http_status == Some(400))
    }

    fn stream(message: impl Into<String>) -> Self {
        let message = message.into();
        if matches!(
            message.as_str(),
            generation_safety::REPETITION | generation_safety::TOOL_CONTRACT
        ) {
            let code = if message == generation_safety::REPETITION {
                "runtime_output_repeated"
            } else {
                "runtime_tool_contract_rejected"
            };
            return Self {
                code,
                public_message: message,
                retryable: false,
                diagnostic: failure_diagnostics::Diagnostic::new(
                    code,
                    failure_diagnostics::Stage::Unknown,
                ),
            };
        }
        if matches!(
            message.as_str(),
            "ram_budget_insufficient"
                | "runtime_gpu_capacity_unavailable"
                | "Available RAM is below the signed model threshold."
                | "Total RAM is below the signed model threshold."
        ) || message == resource_runtime::STARTUP_RAM_PRESSURE
        {
            return Self {
                code: "runtime_capacity_exhausted",
                public_message: message,
                retryable: true,
                diagnostic: failure_diagnostics::Diagnostic::capacity(),
            };
        }
        if message == reasoning_budget::CONTROL_UNAVAILABLE {
            return Self {
                code: "runtime_reasoning_control_unavailable",
                public_message: message,
                retryable: false,
                diagnostic: failure_diagnostics::Diagnostic::new(
                    "runtime_reasoning_control_unavailable",
                    failure_diagnostics::Stage::Unknown,
                ),
            };
        }
        Self {
            code: "runtime_stream_failed",
            public_message: message,
            retryable: true,
            diagnostic: failure_diagnostics::Diagnostic::new(
                "runtime_stream_failed",
                failure_diagnostics::Stage::Unknown,
            ),
        }
    }

    fn http(status: u16, kind: LlamaHttpFailureKind) -> Self {
        Self {
            code: kind.code(),
            public_message: kind.public_message(status),
            retryable: kind.retryable(status),
            diagnostic: failure_diagnostics::Diagnostic::http(status, kind),
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
#[cfg(windows)]
static LAST_MEMORY_TRIM: Mutex<Option<Instant>> = Mutex::new(None);

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
    resource_revision: u64,
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
    resource_config: resource_config::LocalResourceConfigState,
    manifest_available: bool,
    catalog_version: Option<u64>,
    policy_version: Option<u64>,
    active_model_id: Option<String>,
    state: String,
    reason_code: Option<String>,
    acceleration: Option<gpu_runtime::RuntimeAcceleration>,
    resource_plan: Option<resource_runtime::ResourcePlan>,
    model_storage: Option<ModelStorage>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    configured_model_storage_id: Option<Option<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuSnapshot {
    logical_cores: usize,
    available_logical_cores: usize,
    physical_cores: Option<usize>,
    features: Vec<String>,
    load_percent: Option<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    total_bytes: u64,
    available_bytes: u64,
    resident_model: Option<ResidentMemorySnapshot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidentMemorySnapshot {
    model_release_id: String,
    manifest_payload_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceleratorSnapshot {
    id: String,
    backend: String,
    name: String,
    total_bytes: Option<u64>,
    available_bytes: Option<u64>,
    detection_source: String,
    dedicated_system_bytes: Option<u64>,
    shared_system_limit_bytes: Option<u64>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStorage {
    storage_type: String,
    bus_types: Vec<String>,
    fixed: Option<bool>,
    available_bytes: Option<u64>,
    total_bytes: Option<u64>,
    reason_code: Option<String>,
}

impl From<&storage_probe::StorageSnapshot> for ModelStorage {
    fn from(snapshot: &storage_probe::StorageSnapshot) -> Self {
        Self {
            storage_type: snapshot.storage_type.clone(),
            bus_types: snapshot.bus_types.clone(),
            fixed: snapshot.fixed,
            available_bytes: snapshot.available_bytes,
            total_bytes: snapshot.total_bytes,
            reason_code: snapshot.reason_code.clone(),
        }
    }
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
    resource_revision: Option<u64>,
    request_id: String,
    scope_digest: String,
    model_release_id: String,
    catalog_binding: CatalogBindingInput,
    use_case: String,
    messages: Vec<Value>,
    tools: Vec<Value>,
    tool_choice: String,
    max_output_tokens: Option<u32>,
    #[serde(default)]
    thinking_tier: reasoning_budget::ThinkingTier,
    thinking_config: Option<reasoning_budget::ThinkingConfig>,
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
    context_usage: Option<ContextUsage>,
    usage: Option<InferenceTokenUsage>,
    diagnostics: RuntimeDiagnostics,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeDiagnostics {
    cached_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
    prompt_ms: Option<f64>,
    predicted_ms: Option<f64>,
    prompt_tokens_per_second: Option<f64>,
    output_tokens_per_second: Option<f64>,
}

impl RuntimeDiagnostics {
    fn observe(&mut self, value: &Value) {
        let count = |pointer: &str| {
            value
                .pointer(pointer)
                .and_then(Value::as_u64)
                .filter(|n| *n <= 9_007_199_254_740_991)
        };
        let metric = |pointer: &str| {
            value
                .pointer(pointer)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n >= 0.0)
        };
        self.cached_tokens = count("/usage/prompt_tokens_details/cached_tokens")
            .or_else(|| count("/timings/cache_n"))
            .or(self.cached_tokens);
        self.reasoning_tokens =
            count("/usage/completion_tokens_details/reasoning_tokens").or(self.reasoning_tokens);
        self.prompt_ms = metric("/timings/prompt_ms").or(self.prompt_ms);
        self.predicted_ms = metric("/timings/predicted_ms").or(self.predicted_ms);
        self.prompt_tokens_per_second =
            metric("/timings/prompt_per_second").or(self.prompt_tokens_per_second);
        self.output_tokens_per_second =
            metric("/timings/predicted_per_second").or(self.output_tokens_per_second);
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct InferenceTokenUsage {
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
}

fn reported_token_usage(value: &Value) -> Option<InferenceTokenUsage> {
    let input_tokens = value.get("prompt_tokens")?.as_u64()?;
    let output_tokens = value.get("completion_tokens")?.as_u64()?;
    let total_tokens = input_tokens.checked_add(output_tokens)?;
    // All IPC numeric counters must remain exact JavaScript integers.
    if total_tokens > 9_007_199_254_740_991 {
        return None;
    }
    Some(InferenceTokenUsage {
        input_tokens,
        output_tokens,
        total_tokens,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LocalInferenceEvent {
    Budget {
        #[serde(flatten)]
        progress: reasoning_budget::BudgetProgress,
    },
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
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostic: Option<failure_diagnostics::Diagnostic>,
    },
}

#[tauri::command]
pub async fn local_model_register_manifest_session(
    window: crate::commands::CallerWebview,
    session_id: String,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let previous_runtime = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        rotate_manifest_session(&mut guard, &session_id)?
    };
    stop_runtime_async(previous_runtime).await?;
    Ok(())
}

#[tauri::command]
pub async fn local_model_begin_manifest_acceptance(
    window: crate::commands::CallerWebview,
    session_id: String,
    acceptance_generation: u64,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let previous_runtime = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        begin_manifest_acceptance(&mut guard, &session_id, acceptance_generation)?
    };
    stop_runtime_async(previous_runtime).await?;
    Ok(())
}

#[tauri::command]
pub async fn local_model_verify_manifest(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    envelope: Value,
    acceptance: ManifestAcceptanceInput,
) -> Result<ManifestVerificationResult, String> {
    ensure_main_webview(&window)?;
    let wire: SignedEnvelope = serde_json::from_value(envelope)
        .map_err(|_| "Local-model manifest schema is invalid.".to_string())?;
    let (key_id, public_key) = trust::resolve(EXPECTED_KEY_ID, PUBLIC_KEY_B64).await?;
    let result = verify_envelope_with_trust(&wire, &key_id, &public_key, now_ms()?)?;
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

    let previous_runtime = {
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
    stop_runtime_async(previous_runtime).await?;
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
pub async fn local_model_status(
    window: crate::commands::CallerWebview,
    app: AppHandle,
) -> Result<LocalModelStatus, String> {
    ensure_main_or_system_status_webview(&window)?;
    let mut guard = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.".to_string())?;
    resource_config::ensure_loaded(&app, &mut guard)?;
    // A retained process handle is not proof that llama.cpp is still alive.
    // Do not cancel or detach an in-flight operation from this status read;
    // normal preparation/request cleanup still owns the runtime lifetime.
    let unavailable_model = guard.runtime.as_mut().and_then(|runtime| {
        (!managed_child_is_running(runtime.child.as_mut())).then(|| runtime.model_id.clone())
    });
    if let Some(model_id) = &unavailable_model {
        guard.readiness.remove(model_id);
        guard.last_error = Some("runtime_process_unavailable".into());
    }
    let now = now_ms()?;
    let readiness = guard
        .readiness
        .iter()
        .filter(|(_, item)| item.valid_until_ms > now)
        .map(|(model_id, item)| NativeReadiness {
            resource_revision: item.resource_revision,
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
    } else if unavailable_model.is_some() {
        "error"
    } else if guard.active_request_id.is_some() {
        "busy"
    } else if guard.runtime.is_some() {
        "ready"
    } else {
        "stopped"
    };
    Ok(LocalModelStatus {
        resource_config: guard.resource_settings.state.clone(),
        manifest_available: guard.catalog.is_some(),
        catalog_version,
        policy_version,
        active_model_id,
        state: state_name.into(),
        reason_code: guard.last_error.clone(),
        acceleration: guard.runtime.as_ref().and_then(|runtime| {
            runtime
                .acceleration
                .lock()
                .ok()
                .map(|status| status.clone())
        }),
        resource_plan: guard
            .runtime
            .as_ref()
            .map(|runtime| runtime.resource_plan.clone()),
        model_storage: guard
            .runtime
            .as_ref()
            .map(|runtime| runtime.model_storage.clone()),
        readiness,
    })
}

fn managed_child_is_running(child: Option<&mut Child>) -> bool {
    child.is_some_and(|child| child.try_wait().is_ok_and(|status| status.is_none()))
}

/// Read only the child held by the verified runtime manager. A startup or
/// replacement can temporarily own that child outside the manager mutex, so
/// absence during an operation is unknown rather than proof of a stopped model.
/// This does not initialize configuration, start a runtime, or expose its key/path.
pub(crate) fn managed_runtime_process_id() -> Result<Option<u32>, ()> {
    let Some(manager) = STATE.get() else {
        return Ok(None);
    };
    let mut guard = manager.try_lock().map_err(|_| ())?;
    if let Some(runtime) = guard.runtime.as_mut() {
        let Some(child) = runtime.child.as_mut() else {
            return Err(());
        };
        return match child.try_wait() {
            Ok(None) => Ok(Some(child.id())),
            Ok(Some(_)) => Ok(None),
            Err(_) => Err(()),
        };
    }
    if guard.active_request_id.is_some() || guard.pending_catalog_generation.is_some() {
        Err(())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn local_model_hardware_snapshot(
    window: crate::commands::CallerWebview,
    app: AppHandle,
) -> Result<HardwareSnapshot, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || collect_hardware_snapshot(Some(&app)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_model_prepare(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    model_release_id: String,
    catalog_binding: CatalogBindingInput,
    resident_only: Option<bool>,
    resource_revision: Option<u64>,
) -> Result<NativeReadiness, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let result = prepare_release(
            &app,
            &model_release_id,
            &catalog_binding,
            resident_only.unwrap_or(false),
            resource_revision,
        );
        resource_acceptance::record_opt_in(&app, started.elapsed(), &result);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_model_infer(
    window: crate::commands::CallerWebview,
    app: AppHandle,
    request: LocalInferenceRequest,
    on_event: Channel<LocalInferenceEvent>,
) -> Result<LocalInferenceResult, String> {
    ensure_main_webview(&window)?;
    let preparation = (|| {
        validate_inference_request(&request)?;
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.")?;
        resource_config::ensure_loaded(&app, &mut guard)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = preparation {
        send_preparation_failure(&request.request_id, &on_event);
        return Err(error);
    }
    tauri::async_runtime::spawn_blocking(move || infer_blocking(&app, request, on_event))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_model_cancel(
    window: crate::commands::CallerWebview,
    request_id: String,
    catalog_binding: CatalogBindingInput,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    let runtime = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        require_catalog_binding(&guard, &catalog_binding)?;
        cancel_active_operation(&mut guard, &request_id)
    };
    stop_runtime_async(runtime).await
}

#[tauri::command]
pub async fn local_model_reasoning_control(
    window: crate::commands::CallerWebview,
    request_id: String,
    action: String,
    expected_sequence: u64,
    catalog_binding: CatalogBindingInput,
) -> Result<reasoning_budget::BudgetProgress, String> {
    ensure_main_webview(&window)?;
    validate_catalog_binding_input(&catalog_binding)?;
    if !safe_id(&request_id) || !matches!(action.as_str(), "more" | "answer") {
        return Err("Local thinking control is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (session, progress, send) = {
            let guard = state()
                .lock()
                .map_err(|_| "Local model manager is unavailable.")?;
            require_thinking_owner(&guard, &request_id, &catalog_binding)?;
            let session = guard
                .active_reasoning
                .as_ref()
                .ok_or("Local thinking request is unavailable.")?
                .clone();
            let (progress, send) = session
                .lock()
                .map_err(|_| "Local thinking state is unavailable.")?
                .control(&action, expected_sequence)?;
            (session, progress, send)
        };
        if send && send_reasoning_end(&request_id, &catalog_binding, &session).is_err() {
            let mut current = session
                .lock()
                .map_err(|_| "Local thinking state is unavailable.")?;
            current.control_failed();
            let mut snapshot = current.snapshot();
            snapshot.control_outcome = Some("unavailable");
            return Ok(snapshot);
        }
        Ok(progress)
    })
    .await
    .map_err(|_| "Local thinking control task failed.")?
}

fn require_thinking_owner(
    guard: &ManagerState,
    request_id: &str,
    binding: &CatalogBindingInput,
) -> Result<(), String> {
    if !operation_owns_catalog_binding(guard, request_id, binding)
        || guard
            .cancel
            .as_ref()
            .is_none_or(|cancel| cancel.load(Ordering::SeqCst))
    {
        return Err("Local thinking request has ended or changed its binding.".into());
    }
    let session = guard
        .active_reasoning
        .as_ref()
        .ok_or("Local thinking request is unavailable.")?
        .lock()
        .map_err(|_| "Local thinking state is unavailable.")?;
    if session.finished
        || session.progress.request_id != request_id
        || session.resource_revision != guard.resource_settings.state.applied_revision
        || guard
            .runtime
            .as_ref()
            .is_none_or(|runtime| runtime.resource_revision != session.resource_revision)
    {
        return Err("Local thinking resource revision has changed.".into());
    }
    Ok(())
}

fn send_reasoning_end(
    request_id: &str,
    binding: &CatalogBindingInput,
    session: &Arc<Mutex<reasoning_budget::Session>>,
) -> Result<(), String> {
    let (port, key, completion_id) = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.")?;
        require_thinking_owner(&guard, request_id, binding)?;
        if !guard
            .active_reasoning
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, session))
        {
            return Err("Local thinking generation changed.".into());
        }
        let completion_id = session
            .lock()
            .map_err(|_| "Local thinking state is unavailable.")?
            .completion_id
            .clone()
            .ok_or("Local generation identity is unavailable.")?;
        let (port, key) = verified_runtime_endpoint(
            guard
                .runtime
                .as_mut()
                .ok_or("Local runtime is unavailable.")?,
        )?;
        (port, key, completion_id)
    };
    // This immutable server action changes the sampler for exactly one native
    // completion id. It neither restarts a model nor increases max_tokens.
    let response = local_network::send(
        local_http_client(Duration::from_secs(3), Duration::from_secs(3))?
            .post(format!(
                "http://127.0.0.1:{port}/v1/chat/completions/control"
            ))
            .bearer_auth(key)
            .header("Content-Type", "application/json")
            .body(
                serde_json::to_vec(&json!({"id":completion_id,"action":"reasoning_end"}))
                    .map_err(|_| "Local reasoning control encoding failed.")?,
            ),
    )
    .map_err(|_| "Local reasoning control is unavailable.")?;
    if !response.status().is_success() {
        return Err("Local reasoning control was not accepted.".into());
    }
    let bytes = read_bounded_error_body(response)
        .ok_or("Local reasoning control exceeded its response limit.")?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Local reasoning control response is invalid.")?;
    if value.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("Local reasoning control was not confirmed.".into());
    }
    let guard = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.")?;
    require_thinking_owner(&guard, request_id, binding)
}

fn clear_thinking_session(guard: &mut ManagerState) {
    if let Some(session) = guard.active_reasoning.take() {
        if let Ok(mut current) = session.lock() {
            current.finished = true;
        }
    }
}

fn cancel_active_operation(guard: &mut ManagerState, request_id: &str) -> Option<ManagedRuntime> {
    if guard.active_request_id.as_deref() != Some(request_id) {
        return None;
    }
    if let Some(cancel) = guard.cancel.as_ref() {
        cancel.store(true, Ordering::SeqCst);
    }
    if guard.active_idle_optimization {
        None
    } else {
        guard.runtime.take()
    }
}

#[tauri::command]
pub async fn local_model_stop(
    window: crate::commands::CallerWebview,
    model_release_id: String,
    catalog_binding: CatalogBindingInput,
) -> Result<(), String> {
    ensure_main_webview(&window)?;
    if !safe_id(&model_release_id) {
        return Err("Invalid model release id.".into());
    }
    let runtime = {
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
    stop_runtime_async(runtime).await
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
    clear_thinking_session(guard);
    guard.active_request_id = None;
    guard.active_idle_optimization = false;
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
        // A new main-renderer session cannot complete the old renderer's work.
        // First registration preserves leases obtained before initial bootstrap.
        guard.resource_work_leases.clear();
    }
    if let Some(cancel) = guard.cancel.take() {
        cancel.store(true, Ordering::SeqCst);
    }
    clear_thinking_session(guard);
    guard.active_request_id = None;
    guard.active_idle_optimization = false;
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
    if payload.schema_version == 2 {
        return validate_tier_manifest(payload);
    }
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

fn validate_tier_manifest(payload: &ManifestPayload) -> Result<(), String> {
    let ids: HashSet<&str> = payload
        .models
        .iter()
        .map(|model| model.id.as_str())
        .collect();
    let policy = &payload.routing;
    if payload.catalog_version == 0
        || payload.policy_version == 0
        || payload.models.len() != 5
        || ids.len() != 5
    {
        return Err("Local model tier catalog must contain five distinct models.".into());
    }
    for model in &payload.models {
        validate_model(model)?;
        let role = if model.id == policy.preferred_model_id {
            "preferred"
        } else {
            "fallback"
        };
        if !model.promoted || model.release_channel != "stable" || model.routing_role != role {
            return Err("Local model tier promotion or routing role is invalid.".into());
        }
    }
    let fallbacks: HashSet<&str> = policy
        .fallback_model_ids
        .iter()
        .map(String::as_str)
        .collect();
    let required = [
        "model_enabled",
        "artifact_verified",
        "runtime_verified",
        "capacity_qualified",
        "health_eligible",
    ];
    if !ids.contains(policy.preferred_model_id.as_str())
        || policy.default_model_id != policy.preferred_model_id
        || policy.fallback_model_ids.len() != 4
        || fallbacks.len() != 4
        || fallbacks.contains(policy.preferred_model_id.as_str())
        || !fallbacks.is_subset(&ids)
        || !policy.experimental_model_ids.is_empty()
        || policy.strategy != "local_first"
        || !policy.local_first
        || !policy.experimental_opt_in_required
        || policy.external_execution_target != "laravel_proxy"
        || !policy.external_requires_explicit_approval
        || !policy.no_silent_external_fallback
        || required.iter().any(|item| {
            !policy
                .required_local_state
                .iter()
                .any(|value| value == item)
        })
    {
        return Err("Local model tier routing is unsafe or inconsistent.".into());
    }
    Ok(())
}

fn validate_model(model: &ModelRelease) -> Result<(), String> {
    if model
        .capacity_policy
        .accelerator_memory_scope
        .as_deref()
        .is_some_and(|scope| !matches!(scope, "single_device" | "compatible_group"))
    {
        return Err("Signed accelerator memory scope is invalid.".into());
    }
    if let Some(runtime) = &model.runtime {
        gpu_runtime::validate_runtime_metadata(runtime)?;
    }
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
            || model.context_limit.is_some_and(|context| {
                context < runtime.min_context_tokens || context > runtime.max_context_tokens
            })
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

/// Trim only Luczor's own pageable working set, never the resident model or other apps.
#[tauri::command]
pub async fn local_model_recover_memory(
    window: crate::commands::CallerWebview,
    app: AppHandle,
) -> Result<HardwareSnapshot, String> {
    ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::{
                ProcessStatus::K32EmptyWorkingSet, Threading::GetCurrentProcess,
            };
            let mut last = LAST_MEMORY_TRIM
                .lock()
                .map_err(|_| "Memory recovery is unavailable.".to_string())?;
            if last.is_none_or(|at| at.elapsed() >= Duration::from_secs(60)) {
                // The pseudo-handle refers exclusively to this process and must not be closed.
                unsafe {
                    K32EmptyWorkingSet(GetCurrentProcess());
                }
                *last = Some(Instant::now());
            }
        }
        collect_hardware_snapshot(Some(&app))
    })
    .await
    .map_err(|_| "Memory recovery task failed.".to_string())?
}

fn collect_hardware_snapshot(app: Option<&AppHandle>) -> Result<HardwareSnapshot, String> {
    let hardware = resource_runtime::sample_hardware()?;
    let accelerators = gpu_snapshot();
    let disks = Disks::new_with_refreshed_list();
    let storage_started = Instant::now();
    let storage: Vec<_> = disks
        .list()
        .iter()
        .map(|disk| {
            // Bound aggregate hardware inspection as well as each individual driver.
            let evidence = (storage_started.elapsed() < Duration::from_secs(3))
                .then(|| storage_probe::inspect_storage(disk.mount_point()));
            let media = match evidence.as_ref().map(|item| item.storage_type.as_str()) {
                Some("nvme" | "ssd") => "ssd",
                Some("hdd") => "hdd",
                Some("mixed") => "unknown",
                _ => match disk.kind() {
                    DiskKind::SSD => "ssd",
                    DiskKind::HDD => "hdd",
                    _ => "unknown",
                },
            };
            let bus = evidence
                .as_ref()
                .filter(|item| item.bus_types.len() == 1)
                .map(|item| item.bus_types[0].as_str())
                .unwrap_or("unknown");
            StorageSnapshot {
                id: storage_mount_id(disk.mount_point()),
                mount_label: disk.mount_point().to_string_lossy().into_owned(),
                bus_type: bus.into(),
                media_type: media.into(),
                removable: evidence
                    .as_ref()
                    .and_then(|item| item.removable)
                    .unwrap_or(disk.is_removable()),
                available_bytes: evidence
                    .as_ref()
                    .and_then(|item| item.available_bytes)
                    .unwrap_or(disk.available_space()),
            }
        })
        .collect();
    let configured_model_storage_id = match_configured_storage(
        configured_model_directory(app),
        disks
            .list()
            .iter()
            .map(|disk| disk.mount_point().to_path_buf())
            .collect(),
    );
    Ok(HardwareSnapshot {
        schema_version: 1,
        snapshot_id: Uuid::new_v4().to_string(),
        captured_at_ms: now_ms()? as i64,
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        cpu: CpuSnapshot {
            logical_cores: hardware.logical_cores,
            available_logical_cores: hardware.available_logical_cores,
            physical_cores: hardware.physical_cores,
            features: Vec::new(),
            load_percent: hardware.cpu_load,
        },
        memory: MemorySnapshot {
            total_bytes: hardware.total_ram_bytes,
            available_bytes: hardware.available_ram_bytes,
            resident_model: state().lock().ok().and_then(|mut manager| {
                let runtime = manager.runtime.as_mut()?;
                if !managed_child_is_running(runtime.child.as_mut()) {
                    return None;
                }
                Some(ResidentMemorySnapshot {
                    model_release_id: runtime.model_id.clone(),
                    manifest_payload_sha256: runtime.prepared_manifest_hash.clone()?,
                })
            }),
        },
        accelerators,
        storage,
        configured_model_storage_id,
    })
}

fn match_configured_storage(
    configured: Option<Option<PathBuf>>,
    mounts: Vec<PathBuf>,
) -> Option<Option<String>> {
    configured.map(|path| {
        path.and_then(|path| {
            mounts
                .iter()
                .filter_map(|mount| {
                    storage_mount_match_len(&path, mount).map(|length| (mount, length))
                })
                .max_by_key(|(_, length)| *length)
                .map(|(mount, _)| storage_mount_id(mount))
        })
    })
}

fn storage_mount_id(mount: &Path) -> String {
    let normalized = normalize_storage_mount_path(mount).unwrap_or_else(|| mount.to_path_buf());
    format!(
        "disk-{}",
        &sha256_bytes(normalized.to_string_lossy().as_bytes())[..16]
    )
}

/// None means never configured; Some(None) is an explicit but unresolved path.
fn configured_model_directory(app: Option<&AppHandle>) -> Option<Option<PathBuf>> {
    let directory = match (
        std::env::var_os("LUCZOR_LLAMA_CPP_BIN"),
        std::env::var_os("LUCZOR_LOCAL_MODEL_DIR"),
    ) {
        (Some(_), Some(directory)) => Some(PathBuf::from(directory)),
        (None, None) => {
            let app = app?;
            let config_path = app
                .path()
                .app_data_dir()
                .ok()?
                .join("local-model")
                .join("runtime-paths.json");
            if !config_path.exists() {
                return None;
            }
            read_runtime_path_config(&config_path)
                .ok()
                .map(|config| config.model_directory)
        }
        _ => None,
    };
    Some(directory.and_then(|directory| {
        if !directory.is_absolute() || reject_runtime_reparse_points(&directory).is_err() {
            return None;
        }
        fs::canonicalize(directory)
            .ok()
            .filter(|path| path.is_dir())
    }))
}

/// Read-only path discovery for system telemetry. It returns only a verified
/// directory to select its containing volume; the path itself is never sent to the frontend.
pub(crate) fn configured_model_directory_for_metrics(app: &AppHandle) -> Option<PathBuf> {
    configured_model_directory(Some(app)).flatten()
}

fn gpu_snapshot() -> Vec<AcceleratorSnapshot> {
    let mut devices = nvml_gpu_snapshot();
    devices.extend(accelerator_inventory::supplemental_snapshot(
        !devices.is_empty(),
    ));
    devices
}

fn nvml_gpu_snapshot() -> Vec<AcceleratorSnapshot> {
    let Ok(nvml) = Nvml::init() else {
        return Vec::new();
    };
    let Ok(count) = nvml.device_count() else {
        return Vec::new();
    };
    (0..count.min(32))
        .filter_map(|index| {
            let device = nvml.device_by_index(index).ok()?;
            let memory = device.memory_info().ok();
            Some(AcceleratorSnapshot {
                id: format!("cuda-{index}"),
                backend: "cuda".into(),
                name: device.name().unwrap_or_else(|_| "NVIDIA GPU".into()),
                total_bytes: memory.as_ref().map(|item| item.total),
                available_bytes: memory.as_ref().map(|item| item.free),
                detection_source: "nvml".into(),
                dedicated_system_bytes: None,
                shared_system_limit_bytes: None,
            })
        })
        .collect()
}

fn prepare_release(
    app: &AppHandle,
    model_id: &str,
    catalog_binding: &CatalogBindingInput,
    resident_only: bool,
    resource_revision: Option<u64>,
) -> Result<NativeReadiness, String> {
    if !safe_id(model_id) {
        return Err("Invalid model release id.".into());
    }
    let operation_id = format!("prepare-{}", Uuid::new_v4().simple());
    {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.")?;
        resource_config::ensure_loaded(app, &mut guard)?;
    }
    let (catalog, model, cancel) =
        claim_prepare_operation(model_id, &operation_id, catalog_binding, resource_revision)?;
    let result = prepare_release_inner(
        app,
        catalog,
        model,
        &operation_id,
        catalog_binding,
        cancel.clone(),
        resident_only,
    );
    let outcome = if cancel.load(Ordering::SeqCst) {
        RequestOutcome::Cancelled
    } else if result.is_ok() {
        RequestOutcome::Success
    } else if resident_only
        && result
            .as_ref()
            .err()
            .is_some_and(|error| error == RESIDENT_RENEWAL_UNAVAILABLE)
    {
        // A lease request for a missing/different resident is a precondition
        // rejection. In particular, preserve another model's running process.
        RequestOutcome::Rejected
    } else {
        RequestOutcome::Failed
    };
    let failure_code = result.as_ref().err().and_then(|error| {
        if error == resource_runtime::STARTUP_RAM_PRESSURE {
            return Some("runtime_startup_ram_pressure");
        }
        [
            "resource_gpu_selection_changed",
            "resource_gpu_selection_ambiguous",
            "resource_gpu_selection_unavailable",
            "resource_threads_invalid",
            "resource_ram_reserve_invalid",
            "resource_vram_reserve_invalid",
            "resource_thread_controls_unavailable",
            "ram_budget_insufficient",
            "runtime_gpu_measurement_unavailable",
            "runtime_gpu_required_no_offload",
            "cpu_mode_disallowed_by_manifest",
            "runtime_gpu_capacity_unavailable",
            "gpu_full_offload_not_verified",
            "forced_split_unavailable",
            "forced_split_metadata_unavailable",
            "forced_split_not_verified",
        ]
        .into_iter()
        .find(|code| *code == error)
    });
    let mut runtime = release_operation(&operation_id, catalog_binding, outcome, failure_code);
    if let Some(runtime) = runtime.as_mut() {
        runtime.stop();
    }
    result
}

fn claim_prepare_operation(
    model_id: &str,
    operation_id: &str,
    catalog_binding: &CatalogBindingInput,
    resource_revision: Option<u64>,
) -> Result<(VerifiedCatalog, ModelRelease, Arc<AtomicBool>), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut guard = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.".to_string())?;
    resource_config::require_revision(&guard, resource_revision)?;
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
    guard.active_idle_optimization = false;
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
    resident_only: bool,
) -> Result<NativeReadiness, String> {
    let artifact = model
        .artifact
        .as_ref()
        .ok_or("Model artifact metadata is unavailable.")?;
    let runtime = model
        .runtime
        .as_ref()
        .ok_or("Runtime metadata is unavailable.")?;
    // An expiring readiness lease is not a reason to reload 17 GB of weights.
    // This evidence lives on the process that passed the signed benchmark, and
    // its artifact handles remain locked throughout the resident lifetime.
    if !refresh_resident_runtime(&model, operation_id, catalog_binding, &cancel)? {
        require_cold_start_allowed(resident_only)?;
        validate_capacity(&model)?;
        ensure_runtime(app, &model, None, operation_id, catalog_binding, &cancel)?;
        run_signed_benchmark(&model, operation_id, catalog_binding, &cancel)?;
    }
    let verified_at = now_ms()?;
    let valid_until =
        (verified_at + 10 * 60_000).min(parse_rfc3339_millis(&catalog.payload.expires_at)?);
    let readiness = ReadinessRecord {
        resource_revision: state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.")?
            .resource_settings
            .state
            .applied_revision,
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
        let resident = guard
            .runtime
            .as_mut()
            .ok_or("Local runtime stopped during preparation.")?;
        verified_runtime_endpoint(resident)?;
        resident.prepared_manifest_hash = Some(catalog.payload_hash.clone());
        guard.readiness.insert(model.id.clone(), readiness.clone());
    }
    Ok(NativeReadiness {
        resource_revision: readiness.resource_revision,
        model_release_id: model.id,
        manifest_payload_sha256: readiness.manifest_hash,
        artifact_sha256: readiness.artifact_hash,
        runtime_sha256: readiness.runtime_hash,
        ready: true,
        verified_at_ms: verified_at as i64,
        valid_until_ms: valid_until as i64,
    })
}

fn require_cold_start_allowed(resident_only: bool) -> Result<(), String> {
    if resident_only {
        return Err(RESIDENT_RENEWAL_UNAVAILABLE.into());
    }
    Ok(())
}

fn refresh_resident_runtime(
    model: &ModelRelease,
    operation_id: &str,
    catalog_binding: &CatalogBindingInput,
    cancel: &AtomicBool,
) -> Result<bool, String> {
    require_runtime_operation_checkpoint(operation_id, catalog_binding, cancel)?;
    let endpoint = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.".to_string())?;
        if !operation_owns_catalog_binding(&guard, operation_id, catalog_binding) {
            return Err("Local-model preparation lost its catalog binding.".into());
        }
        let resource_revision = guard.resource_settings.state.applied_revision;
        match guard.runtime.as_mut() {
            Some(resident)
                if resident.model_id == model.id
                    && resident.resource_revision == resource_revision
                    && resident.prepared_manifest_hash.as_deref()
                        == Some(catalog_binding.manifest_payload_sha256.as_str()) =>
            {
                Some(verified_runtime_endpoint(resident)?)
            }
            _ => None,
        }
    };
    let Some((port, api_key)) = endpoint else {
        return Ok(false);
    };
    let healthy = local_network::send(
        local_http_client(Duration::from_secs(2), Duration::from_secs(2))?
            .get(format!("http://127.0.0.1:{port}/health"))
            .bearer_auth(api_key),
    )
    .is_ok_and(|response| response.status().is_success());
    require_runtime_operation_checkpoint(operation_id, catalog_binding, cancel)?;
    if !healthy {
        return Err("Resident local runtime health check failed.".into());
    }
    Ok(true)
}

fn verify_configured_artifacts(
    app: &AppHandle,
    model: &ModelRelease,
    catalog_binding: &CatalogBindingInput,
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
    let paths_configured = std::env::var_os("LUCZOR_LLAMA_CPP_BIN").is_some()
        || std::env::var_os("LUCZOR_LOCAL_MODEL_DIR").is_some()
        || app
            .path()
            .app_data_dir()
            .map_err(|_| "Local-model data directory unavailable.")?
            .join("local-model/runtime-paths.json")
            .exists();
    let (runtime_path, model_path) = if cfg!(target_os = "linux") && !paths_configured {
        install::ensure(app, model, cancel)?
    } else {
        configured_paths(app, model, catalog_binding)?
    };
    let (model_guard, model_hash) = verified_artifact_guard(&model_path, cancel)?;
    let (runtime_guard, runtime_hash) = verified_artifact_guard(&runtime_path, cancel)?;
    if model_guard
        .metadata()
        .map_err(|_| "Configured GGUF file is unavailable.")?
        .len()
        != artifact.size_bytes
    {
        return Err("Configured GGUF size does not match the signed manifest.".into());
    }
    if model_hash != artifact.sha256 {
        return Err("Configured GGUF hash does not match the signed manifest.".into());
    }
    if runtime_hash != runtime.sha256 {
        return Err("Configured llama.cpp runtime hash does not match the signed manifest.".into());
    }
    let support_guards = gpu_runtime::verify_support_files(&runtime_path, runtime, cancel)?;
    #[cfg(target_os = "linux")]
    let storage_path = model_path.clone();
    #[cfg(target_os = "linux")]
    let linux_bundle = {
        let mut entries = vec![
            ("llama-server".to_string(), &runtime_guard),
            ("model.gguf".to_string(), &model_guard),
        ];
        for (entry, guard) in runtime
            .files
            .as_deref()
            .unwrap_or_default()
            .iter()
            .zip(&support_guards)
        {
            entries.push((entry.name.clone(), guard));
        }
        Arc::new(linux_protection::Bundle::new(
            runtime_path
                .parent()
                .ok_or("linux_artifact_namespace_failed")?,
            entries,
        )?)
    };
    #[cfg(target_os = "linux")]
    let (runtime_path, model_path) = (
        linux_bundle.path("llama-server"),
        linux_bundle.path("model.gguf"),
    );
    Ok(VerifiedArtifactFiles {
        #[cfg(target_os = "linux")]
        linux_bundle,
        #[cfg(target_os = "linux")]
        storage_path,
        runtime_path,
        model_path,
        runtime_guard,
        support_guards,
        model_guard,
    })
}

fn validate_capacity(model: &ModelRelease) -> Result<(), String> {
    // Capacity admission only needs current RAM here; disk and GPU checks use
    // the actual verified model/runtime paths later in the startup boundary.
    let mut system = System::new();
    system.refresh_memory();
    let policy = &model.capacity_policy;
    let min_total_ram = policy
        .min_total_ram_bytes
        .ok_or("Capacity policy has no total RAM threshold.")?;
    let min_ram = policy
        .min_available_ram_bytes
        .ok_or("Capacity policy has no RAM threshold.")?;
    if system.total_memory() < min_total_ram {
        return Err("Total RAM is below the signed model threshold.".into());
    }
    if system.available_memory() < min_ram {
        return Err("Available RAM is below the signed model threshold.".into());
    }
    // GPU thresholds are checked against the selected, verified runtime device
    // at startup. NVML alone cannot prove or disprove Vulkan/Metal availability.
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
    let response = local_network::send(
        local_http_client(
            read_timeout,
            Duration::from_secs(MAX_INFERENCE_TOTAL_SECONDS),
        )?
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .bearer_auth(&api_key)
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&body).map_err(|error| error.to_string())?),
    )
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
    // A text benchmark cannot establish that the template/parser supports tools.
    // Require a real structured call, never interpret content as executable syntax.
    if cancel.load(Ordering::SeqCst) {
        return Err("Local benchmark was cancelled.".into());
    }
    let nonce = Uuid::new_v4().to_string();
    let probe = generation_safety::tool_probe_body(&model.id, &nonce);
    let response = local_network::send(
        local_http_client(Duration::from_secs(30), Duration::from_secs(60))?
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .bearer_auth(&api_key)
            .header("Content-Type", "application/json")
            .body(serde_json::to_vec(&probe).map_err(|error| error.to_string())?),
    )
    .map_err(|_| {
        "Local tool readiness probe failed: template/parser did not respond.".to_string()
    })?;
    if !response.status().is_success() {
        return Err(
            "Local tool readiness probe failed: template/parser rejected the tool request.".into(),
        );
    }
    let mut bytes = Vec::new();
    response
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "Local tool readiness probe failed: unreadable response.".to_string())?;
    let valid = bytes.len() <= 65536
        && serde_json::from_slice::<Value>(&bytes)
            .is_ok_and(|value| generation_safety::valid_tool_probe(&value, &nonce));
    if cancel.load(Ordering::SeqCst) {
        return Err("Local benchmark was cancelled.".into());
    }
    if !valid {
        return Err("Local tool readiness probe failed: no valid structured tool call. Check model chat template and runtime parser.".into());
    }
    {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.")?;
        if !operation_owns_catalog_binding(&guard, operation_id, catalog_binding) {
            return Err("Local-model benchmark lost its catalog binding.".into());
        }
        if let Some(runtime) = guard.runtime.as_mut() {
            runtime.benchmark = Some(resource_acceptance::BenchmarkMeasurement {
                prompt_tokens_per_second: prompt,
                decode_tokens_per_second: decode,
                first_token_ms: first,
            });
        }
    }
    if !benchmark_qualifies(thresholds, prompt, decode, first) {
        return Err("Local benchmark did not meet the signed capacity thresholds.".into());
    }
    Ok(())
}

fn shared_artifact_ids(model: &ModelRelease, models: &[ModelRelease]) -> Vec<String> {
    let mut ids = vec![model.id.clone()];
    if let Some(artifact) = &model.artifact {
        for candidate in models {
            if candidate.id != model.id
                && candidate.artifact.as_ref().is_some_and(|other| {
                    other.sha256 == artifact.sha256 && other.size_bytes == artifact.size_bytes
                })
            {
                ids.push(candidate.id.clone());
            }
        }
    }
    ids
}

fn configured_paths(
    app: &AppHandle,
    model: &ModelRelease,
    catalog_binding: &CatalogBindingInput,
) -> Result<(PathBuf, PathBuf), String> {
    let ids = {
        let guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.")?;
        let catalog = require_catalog_binding(&guard, catalog_binding)?;
        shared_artifact_ids(model, &catalog.payload.models)
    };
    let config_path = app
        .path()
        .app_data_dir()
        .map_err(|_| "Local-model configuration directory is unavailable.")?
        .join("local-model")
        .join("runtime-paths.json");
    for id in ids {
        let result = configured_paths_from_sources(
            &id,
            std::env::var_os("LUCZOR_LLAMA_CPP_BIN").map(PathBuf::from),
            std::env::var_os("LUCZOR_LOCAL_MODEL_DIR").map(PathBuf::from),
            &config_path,
        );
        match result {
            // Only a missing file may resolve to an identical signed sibling.
            // Invalid paths, symlinks or runtime errors must still fail closed.
            Err(error) if error == "Configured GGUF file is unavailable." => continue,
            other => return other,
        }
    }
    Err("Configured GGUF file is unavailable.".into())
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
) -> Result<ModelStorage, String> {
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
    let evidence = storage_probe::inspect_storage(path);
    let required = signed_min_storage_free_bytes.max(artifact.size_bytes);
    let removable = !evidence.fixed.unwrap_or(!disk.is_removable())
        || evidence.removable.unwrap_or(disk.is_removable());
    let proven_bus = if evidence.bus_types.iter().any(|bus| bus == "usb") {
        "usb"
    } else if evidence.fixed_nvme() {
        "nvme"
    } else {
        "unknown"
    };
    let eligible = storage_class_eligible(&artifact.storage_class, removable, proven_bus);
    if !eligible || evidence.available_bytes.unwrap_or(disk.available_space()) < required {
        return Err(
            "Model storage does not satisfy the signed storage class or free-space threshold."
                .into(),
        );
    }
    Ok(ModelStorage::from(&evidence))
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
        "fixed_storage" => !removable && proven_bus != "usb",
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
        || request
            .max_output_tokens
            .is_some_and(|value| value == 0 || value > reasoning_budget::MAX_OUTPUT_TOKENS)
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
    if request.use_case == IDLE_CONTEXT_USE_CASE
        && (!request.tools.is_empty()
            || request.tool_choice != "none"
            || request.reasoning_mode != "off"
            || request.max_output_tokens.is_none_or(|value| value > 768)
            || encoded.len() > 64 * 1024)
    {
        return Err("Background local optimization exceeds its native read-only bounds.".into());
    }
    reasoning_budget::Plan::new(
        request.thinking_tier,
        request.thinking_config.as_ref(),
        &request.reasoning_mode,
        request.max_output_tokens,
        false,
    )?;
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
    let (model, cancel) = claim_inference_operation(&request).inspect_err(|_| {
        send_preparation_failure(&request.request_id, &on_event);
    })?;
    let prepared = if request.use_case == IDLE_CONTEXT_USE_CASE {
        // claim_inference_operation already checked the resident runtime under
        // the same lock as ownership. Idle work must never enter cold start.
        Ok(())
    } else {
        ensure_runtime(
            app,
            &model,
            Some(&request.scope_digest),
            &request.request_id,
            &request.catalog_binding,
            &cancel,
        )
    };
    if let Err(error) = prepared {
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
            diagnostic: (outcome != RequestOutcome::Cancelled).then(|| {
                failure_diagnostics::Diagnostic::new(
                    "runtime_start_failed",
                    failure_diagnostics::Stage::Preparation,
                )
            }),
        });
        return Err(error);
    }
    let _ = on_event.send(LocalInferenceEvent::Started {
        request_id: request.request_id.clone(),
    });
    let result = stream_completion(app, &model, &request, cancel.clone(), &on_event, true);
    let outcome = if cancel.load(Ordering::SeqCst) {
        RequestOutcome::Cancelled
    } else if result.is_ok() {
        RequestOutcome::Success
    } else if result
        .as_ref()
        .err()
        .is_some_and(LocalInferenceFailure::preserves_resident_runtime)
    {
        RequestOutcome::Rejected
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
            diagnostic: (outcome != RequestOutcome::Cancelled)
                .then(|| failure.map(|error| error.diagnostic.clone()))
                .flatten(),
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

fn send_preparation_failure(request_id: &str, on_event: &Channel<LocalInferenceEvent>) {
    let _ = on_event.send(LocalInferenceEvent::Error {
        request_id: request_id.into(),
        code: "runtime_start_failed".into(),
        retryable: false,
        diagnostic: Some(failure_diagnostics::Diagnostic::new(
            "runtime_start_failed",
            failure_diagnostics::Stage::Preparation,
        )),
    });
}

fn claim_inference_operation(
    request: &LocalInferenceRequest,
) -> Result<(ModelRelease, Arc<AtomicBool>), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut guard = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.".to_string())?;
    let resource_revision = resource_config::require_revision(&guard, request.resource_revision)?;
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
        || readiness.resource_revision != resource_revision
        || readiness.manifest_hash != catalog.payload_hash
        || readiness.artifact_hash != artifact.sha256
        || readiness.runtime_hash != runtime.sha256
    {
        return Err("Local model readiness evidence is stale or mismatched.".into());
    }
    if request.use_case == IDLE_CONTEXT_USE_CASE {
        require_idle_resident(
            &mut guard,
            &model,
            &request.scope_digest,
            resource_revision,
            &catalog.payload_hash,
        )?;
    }
    guard.active_request_id = Some(request.request_id.clone());
    guard.active_idle_optimization = request.use_case == IDLE_CONTEXT_USE_CASE;
    guard.cancel = Some(cancel.clone());
    Ok((model, cancel))
}

fn require_idle_resident(
    guard: &mut ManagerState,
    model: &ModelRelease,
    scope: &str,
    resource_revision: u64,
    manifest_hash: &str,
) -> Result<(), String> {
    let runtime = guard.runtime.as_mut().ok_or(IDLE_RESIDENT_UNAVAILABLE)?;
    if runtime.resource_revision != resource_revision
        || runtime.prepared_manifest_hash.as_deref() != Some(manifest_hash)
        || !runtime.reuse(&model.id, Some(scope))?
    {
        return Err(IDLE_RESIDENT_UNAVAILABLE.into());
    }
    verified_runtime_endpoint(runtime)?;
    Ok(())
}

fn ensure_runtime(
    app: &AppHandle,
    model: &ModelRelease,
    scope_digest: Option<&str>,
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
        let resource_revision = guard.resource_settings.state.applied_revision;
        let reuse = if let Some(runtime) = guard.runtime.as_mut() {
            runtime.resource_revision == resource_revision
                && serde_json::to_value(&runtime.resource_plan)
                    .ok()
                    .and_then(|value| value["contextTokens"].as_u64())
                    .is_some_and(|active| active >= u64::from(model.context_limit.unwrap_or(0)))
                && runtime.reuse(&model.id, scope_digest)?
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
    scope_digest: Option<&str>,
    operation_id: &str,
    catalog_binding: &CatalogBindingInput,
    cancel: &AtomicBool,
) -> Result<ManagedRuntime, String> {
    validate_capacity(model)?;
    // Every process replacement retains the signed hashes and immutable read guards.
    let artifacts = verify_configured_artifacts(app, model, catalog_binding, cancel)?;
    let model_storage = ensure_model_storage(
        {
            #[cfg(target_os = "linux")]
            {
                &artifacts.storage_path
            }
            #[cfg(not(target_os = "linux"))]
            {
                &artifacts.model_path
            }
        },
        model
            .artifact
            .as_ref()
            .ok_or("Model artifact metadata is unavailable.")?,
        model
            .capacity_policy
            .min_storage_free_bytes
            .ok_or("Capacity policy has no storage threshold.")?,
    )?;
    require_runtime_operation_checkpoint(operation_id, catalog_binding, cancel)?;
    let metadata = model
        .runtime
        .as_ref()
        .ok_or("Runtime metadata is unavailable.")?;
    let settings = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.")?
        .resource_settings
        .clone();
    let config = &settings.state.applied;
    let mut plan = gpu_runtime::choose_acceleration(
        &artifacts.runtime_path,
        metadata,
        model.capacity_policy.min_vram_bytes.unwrap_or_default(),
        model
            .capacity_policy
            .accelerator_memory_scope
            .as_deref()
            .unwrap_or("single_device"),
        model
            .artifact
            .as_ref()
            .map_or(0, |artifact| artifact.size_bytes),
        config,
        &settings.applied_bindings,
        settings.state.applied_revision,
        cancel,
    )?;
    plan.status.resource_revision = settings.state.applied_revision;
    plan.status.requested_mode = config.mode.clone();
    if config.mode == "hybrid" {
        gpu_runtime::force_partial_offload(&mut plan, &artifacts.model_guard)?;
    }
    if config.mode == "gpu" && !plan.uses_gpu() && plan.status.fallback_reason_code.is_none() {
        plan.status.fallback_reason_code = Some("gpu_mode_auto_fallback_unavailable".into());
    }
    require_runtime_operation_checkpoint(operation_id, catalog_binding, cancel)?;
    let gpu_required = model
        .capacity_policy
        .min_vram_bytes
        .is_some_and(|bytes| bytes > 0);
    if gpu_required && !plan.uses_gpu() {
        return Err("No compatible GPU runtime satisfies the signed model capacity policy.".into());
    }
    let timeout = Duration::from_secs(
        model
            .capacity_policy
            .max_startup_seconds
            .ok_or("Model startup threshold is unavailable.")?,
    );
    let started = Instant::now();
    let mut result = start_runtime_attempt(
        app,
        model,
        scope_digest,
        operation_id,
        catalog_binding,
        cancel,
        &artifacts,
        &plan,
        &model_storage,
        timeout,
    );
    if plan.require_full_offload
        && result.as_ref().err().is_some_and(|error| {
            matches!(
                error.as_str(),
                "runtime_gpu_capacity_unavailable" | "gpu_full_offload_not_verified"
            )
        })
        && !cancel.load(Ordering::SeqCst)
        && started.elapsed() < timeout
    {
        let automatic =
            gpu_runtime::auto_fallback(&plan, result.as_ref().err().map_or("", String::as_str));
        result = start_runtime_attempt(
            app,
            model,
            scope_digest,
            operation_id,
            catalog_binding,
            cancel,
            &artifacts,
            &automatic,
            &model_storage,
            timeout.saturating_sub(started.elapsed()),
        );
    }
    if result
        .as_ref()
        .err()
        .is_some_and(|error| error == "runtime_gpu_capacity_unavailable")
        && !cancel.load(Ordering::SeqCst)
        && started.elapsed() < timeout
    {
        if let Some(hybrid) = gpu_runtime::hybrid_retry(&plan) {
            require_runtime_operation_checkpoint(operation_id, catalog_binding, cancel)?;
            result = start_runtime_attempt(
                app,
                model,
                scope_digest,
                operation_id,
                catalog_binding,
                cancel,
                &artifacts,
                &hybrid,
                &model_storage,
                timeout.saturating_sub(started.elapsed()),
            );
        }
    }
    match result {
        Err(error)
            if plan.uses_gpu()
                && config.mode != "hybrid"
                && error != resource_runtime::STARTUP_RAM_PRESSURE
                && error == "runtime_gpu_capacity_unavailable"
                && !gpu_required
                && !cancel.load(Ordering::SeqCst)
                && started.elapsed() < timeout =>
        {
            // One owned-process retry only, before any user inference. A CPU fallback
            // must still meet the original signed RAM and benchmark requirements.
            require_runtime_operation_checkpoint(operation_id, catalog_binding, cancel)?;
            validate_capacity(model)?;
            let mut cpu = gpu_runtime::AccelerationPlan::cpu("runtime_gpu_start_failed")
                .with_options(plan.runtime_options.clone());
            cpu.status.resource_revision = settings.state.applied_revision;
            cpu.status.requested_mode = config.mode.clone();
            cpu.status.fallback_reason_code = Some(
                if config.mode == "gpu" {
                    "gpu_mode_auto_fallback_cpu"
                } else {
                    "runtime_gpu_capacity_cpu_fallback"
                }
                .into(),
            );
            start_runtime_attempt(
                app,
                model,
                scope_digest,
                operation_id,
                catalog_binding,
                cancel,
                &artifacts,
                &cpu,
                &model_storage,
                timeout.saturating_sub(started.elapsed()),
            )
        }
        other => other,
    }
}

#[allow(clippy::too_many_arguments)]
fn start_runtime_attempt(
    app: &AppHandle,
    model: &ModelRelease,
    scope_digest: Option<&str>,
    operation_id: &str,
    catalog_binding: &CatalogBindingInput,
    cancel: &AtomicBool,
    artifacts: &VerifiedArtifactFiles,
    plan: &gpu_runtime::AccelerationPlan,
    model_storage: &ModelStorage,
    timeout: Duration,
) -> Result<ManagedRuntime, String> {
    let runtime_guard = artifacts
        .runtime_guard
        .try_clone()
        .map_err(|_| "Runtime guard could not be retained.")?;
    let model_guard = artifacts
        .model_guard
        .try_clone()
        .map_err(|_| "Model guard could not be retained.")?;
    let support_guards = artifacts
        .support_guards
        .iter()
        .map(|file| {
            file.try_clone()
                .map_err(|_| "Runtime support guard could not be retained.")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let context = model
        .context_limit
        .ok_or("Model context limit is unavailable.")?;
    // This is a cold-start snapshot: resident lease refreshes never enter here.
    // Recompute it for a CPU fallback after the failed owned GPU process exited.
    let hardware = resource_runtime::sample_hardware()?;
    let settings = state()
        .lock()
        .map_err(|_| "Local model manager is unavailable.")?
        .resource_settings
        .clone();
    let resource_plan = resource_runtime::plan_resources_configured(
        &hardware,
        context,
        model
            .artifact
            .as_ref()
            .map_or(0, |artifact| artifact.size_bytes),
        &plan.status.backend,
        &plan.runtime_options,
        &settings.state.applied,
        plan.gpu_budget_bytes,
        settings.state.applied_revision,
    )?;
    let port = reserve_loopback_port()?;
    let slot_cache_namespace = sha256_bytes(
        serde_json::to_string(&json!({
            "schema": 2,
            "model": model.artifact.as_ref().map(|artifact| &artifact.sha256),
            "runtime": model.runtime.as_ref().map(|runtime| &runtime.sha256),
            "template": model.chat_template_hash,
            "context": context,
            "acceleration": plan.arguments,
            "resources": resource_plan.arguments(),
        }))
        .map_err(|_| "Slot cache identity could not be encoded.")?
        .as_bytes(),
    );
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
    // Only set up when the runtime binary advertises support: lets a scope's KV cache
    // survive an idle-timeout kill or a scope switch's process replacement, so resuming
    // that scope later restores it instead of repaying the full conversation prefill.
    let slot_cache_dir = if plan.runtime_options.slot_save_path {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("local-model")
            .join("slot-cache");
        create_private_directory(&dir)?;
        Some(dir)
    } else {
        None
    };
    let mut command = Command::new(&artifacts.runtime_path);
    command.args([
        "--model",
        artifacts.model_path.to_string_lossy().as_ref(),
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
    ]);
    if let Some(dir) = &slot_cache_dir {
        command.args(["--slot-save-path", dir.to_string_lossy().as_ref()]);
    }
    command
        .args(&plan.arguments)
        .args(resource_plan.arguments())
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(directory) = artifacts.runtime_path.parent() {
        command.current_dir(directory);
    }
    copy_minimal_environment(&mut command);
    configure_process(&mut command);
    if let Err(error) = require_runtime_operation_checkpoint(operation_id, catalog_binding, cancel)
    {
        let _ = fs::remove_file(&api_key_file);
        return Err(error);
    }
    let (mut child, process_lifetime_guard) = match spawn_owned_runtime(command) {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_file(&api_key_file);
            return Err(error);
        }
    };
    let acceleration = Arc::new(Mutex::new(plan.status.clone()));
    if let Some(stderr) = child.stderr.take() {
        gpu_runtime::monitor_startup(stderr, acceleration.clone());
    }
    let mut runtime = ManagedRuntime {
        resource_revision: settings.state.applied_revision,
        benchmark: None,
        child: Some(child),
        model_id: model.id.clone(),
        scope: scope_digest.map_or(RuntimeScope::Prepared, |digest| {
            RuntimeScope::Bound(digest.into())
        }),
        prepared_manifest_hash: None,
        port,
        api_key,
        api_key_file,
        acceleration,
        resource_plan,
        model_storage: model_storage.clone(),
        slot_cache_dir: slot_cache_dir.clone(),
        slot_cache_namespace,
        #[cfg(target_os = "linux")]
        _linux_bundle: artifacts.linux_bundle.clone(),
        _runtime_guard: runtime_guard,
        _support_guards: support_guards,
        _model_guard: model_guard,
        _process_lifetime_guard: process_lifetime_guard,
    };
    let health_started = Instant::now();
    if let Err(error) = await_health(&mut runtime, timeout, cancel) {
        let capacity_failure = gpu_runtime::capacity_failure(&runtime.acceleration);
        runtime.stop();
        return Err(
            if capacity_failure && error != resource_runtime::STARTUP_RAM_PRESSURE {
                "runtime_gpu_capacity_unavailable".into()
            } else {
                error
            },
        );
    }
    if let Err(error) = gpu_runtime::finish_measurement(
        &runtime.acceleration,
        plan,
        timeout.saturating_sub(health_started.elapsed()),
        cancel,
    ) {
        runtime.stop();
        return Err(error);
    }
    if model
        .capacity_policy
        .min_vram_bytes
        .is_some_and(|bytes| bytes > 0)
        && runtime
            .acceleration
            .lock()
            .is_ok_and(|status| status.offloaded_layers == Some(0))
    {
        runtime.stop();
        return Err("runtime_gpu_required_no_offload".into());
    }
    runtime.resource_plan.confirm_started();
    if let (Some(dir), Some(digest)) = (&slot_cache_dir, scope_digest) {
        restore_slot_cache(&runtime, dir, digest);
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
    let mut ram_guard =
        resource_runtime::StartupMemoryGuard::new(runtime.resource_plan.total_ram_bytes());
    let mut ram_snapshot = System::new();
    while started.elapsed() < timeout {
        if cancel.load(Ordering::SeqCst) {
            return Err("Local runtime startup was cancelled.".into());
        }
        ram_snapshot.refresh_memory();
        ram_guard.observe(
            ram_snapshot.total_memory(),
            ram_snapshot.available_memory(),
            Instant::now(),
        )?;
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
        if local_network::send(
            client
                .get(format!("http://127.0.0.1:{}/health", runtime.port))
                .bearer_auth(&runtime.api_key),
        )
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

/// Bounds the on-disk cache to five scope/layout entries. Scope and runtime layout
/// are both part of each key; incompatible and legacy entries are never restored.
const MAX_CACHED_SLOT_SCOPES: usize = 5;

fn slot_cache_path(dir: &Path, namespace: &str, scope_digest: &str) -> PathBuf {
    // Never restore old scope-only files into a different model or KV layout.
    let key = sha256_bytes(format!("v2:{namespace}:{scope_digest}").as_bytes());
    dir.join(format!("v2-{key}.slot"))
}

fn prune_slot_cache_dir(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, SystemTime)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "slot"))
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((entry.path(), modified))
        })
        .collect();
    if files.len() <= MAX_CACHED_SLOT_SCOPES {
        return;
    }
    files.sort_by_key(|(_, modified)| *modified);
    for (path, _) in files.iter().take(files.len() - MAX_CACHED_SLOT_SCOPES) {
        let _ = fs::remove_file(path);
    }
}

/// Best-effort: asks the still-running llama.cpp process to persist its single slot's KV
/// cache to disk under this scope/layout key, so a compatible cold start (see
/// `restore_slot_cache`) can skip reprocessing the conversation transcript from scratch.
/// Never surfaces an error: a failed save only costs the next cold start its speedup, it
/// never affects correctness, and it must never block or fail the teardown it runs inside.
fn save_slot_cache(port: u16, api_key: &str, dir: &Path, namespace: &str, scope_digest: &str) {
    let Ok(client) = local_http_client(Duration::from_secs(2), Duration::from_secs(10)) else {
        return;
    };
    let filename = slot_cache_path(dir, namespace, scope_digest)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    let Some(filename) = filename else {
        return;
    };
    let Ok(encoded) = serde_json::to_vec(&json!({ "filename": filename })) else {
        return;
    };
    let _ = local_network::send(
        client
            .post(format!("http://127.0.0.1:{port}/slots/0?action=save"))
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .body(encoded),
    );
    prune_slot_cache_dir(dir);
}

/// Best-effort restore of a scope's previously saved slot cache into a freshly started
/// process's slot, so the first turn in a resumed scope does not repay the full prefill
/// cost that `save_slot_cache` already banked. A missing or unusable save file is the
/// normal case for a scope's first ever turn. Only an exact model/runtime/layout
/// namespace may be restored; matching prompt tokens do not prove KV compatibility.
fn restore_slot_cache(runtime: &ManagedRuntime, dir: &Path, scope_digest: &str) {
    let path = slot_cache_path(dir, &runtime.slot_cache_namespace, scope_digest);
    if !path.is_file() {
        return;
    }
    let Some(filename) = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
    else {
        return;
    };
    let Ok(client) = local_http_client(Duration::from_secs(2), Duration::from_secs(10)) else {
        return;
    };
    let Ok(encoded) = serde_json::to_vec(&json!({ "filename": filename })) else {
        return;
    };
    let _ = local_network::send(
        client
            .post(format!(
                "http://127.0.0.1:{}/slots/0?action=restore",
                runtime.port
            ))
            .bearer_auth(&runtime.api_key)
            .header("Content-Type", "application/json")
            .body(encoded),
    );
}

fn llama_http_failure(status: u16, response: impl Read) -> LocalInferenceFailure {
    read_bounded_error_body(response)
        .as_deref()
        .map(|body| failure_diagnostics::classify(status, body))
        .unwrap_or_else(|| LocalInferenceFailure::http(status, classify_llama_http_status(status)))
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
    app: &AppHandle,
    model: &ModelRelease,
    request: &LocalInferenceRequest,
    cancel: Arc<AtomicBool>,
    on_event: &Channel<LocalInferenceEvent>,
    may_grow: bool,
) -> Result<LocalInferenceResult, LocalInferenceFailure> {
    let diagnostic = failure_diagnostics::Context::new();
    stream_completion_with_diagnostics(app, model, request, cancel, on_event, may_grow, &diagnostic)
        .map_err(|failure| diagnostic.annotate(failure))
}

fn stream_completion_with_diagnostics(
    app: &AppHandle,
    model: &ModelRelease,
    request: &LocalInferenceRequest,
    cancel: Arc<AtomicBool>,
    on_event: &Channel<LocalInferenceEvent>,
    may_grow: bool,
    diagnostic: &failure_diagnostics::Context,
) -> Result<LocalInferenceResult, LocalInferenceFailure> {
    if !local_messages::valid_tool_arguments(&request.messages) {
        return Err(LocalInferenceFailure::http(
            400,
            LlamaHttpFailureKind::ToolContractRejected,
        ));
    }
    let (port, api_key, runtime_context, resource_revision) = {
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
        let (port, key) = verified_runtime_endpoint(runtime)?;
        let actual_context = serde_json::to_value(&runtime.resource_plan)
            .ok()
            .and_then(|value| value["contextTokens"].as_u64())
            .filter(|n| *n > 0 && *n <= 1_048_576)
            .ok_or("Resident model context limit is unavailable.")?
            as u32;
        (port, key, actual_context, runtime.resource_revision)
    };
    let thresholds = model
        .capacity_policy
        .benchmark_thresholds
        .as_ref()
        .ok_or("Capacity policy has no read-time threshold.")?;
    // context_limit is the initial window; the signed runtime contract bounds
    // automatic growth. The renderer cannot request a different model/window.
    let signed_context = model
        .runtime
        .as_ref()
        .ok_or("Runtime context limit is unavailable.")?
        .max_context_tokens;
    let mut props = Value::Null;
    if request.use_case != IDLE_CONTEXT_USE_CASE {
        let client = local_http_client(Duration::from_secs(3), Duration::from_secs(3))?;
        if let Ok(response) = local_network::send(
            client
                .get(format!("http://127.0.0.1:{port}/props"))
                .bearer_auth(&api_key),
        ) {
            if response.status().is_success() {
                let mut bytes = Vec::new();
                if response
                    .take(256 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .is_ok()
                    && bytes.len() <= 256 * 1024
                {
                    props = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                }
            }
        }
    }
    let (context_limit, live_control) =
        reasoning_budget::runtime_limits(&props, signed_context.min(runtime_context));
    let plan = reasoning_budget::Plan::new(
        request.thinking_tier,
        request.thinking_config.as_ref(),
        &request.reasoning_mode,
        request.max_output_tokens,
        live_control,
    )?;
    let mut body = json!({
        "model": request.model_release_id,
        "messages": local_messages::normalize_system_messages(&request.messages)
            .map_err(|()| LocalInferenceFailure::http(400, LlamaHttpFailureKind::ChatHistoryRejected))?,
        "tools": request.tools,
        "tool_choice": request.tool_choice,
        "stream": true,
        "stream_options": { "include_usage": true },
        "max_tokens": plan.output_ceiling,
        // Each request supplies its entire conversation transcript, so an in-scope
        // follow-up turn is normally an exact-prefix superset of the previous one: letting
        // llama.cpp reuse that slot's existing KV cache for the shared prefix (instead of
        // forcing a full reprocess every turn) is what makes the multi-second-per-turn
        // prefill cost scale with only the new tail, not the whole transcript again. This
        // is a pure performance path: cache reuse is keyed on an exact token-prefix match,
        // so a shorter or different prefix (an edited turn, a resized context) can only
        // fall back to recomputing more, never change the completion itself. Scope binding
        // (see `RuntimeScope`) already guarantees this slot only ever serves one scope at a
        // time, so there is no cross-conversation leakage risk in reusing it.
        "cache_prompt": true,
        "chat_template_kwargs": {}
    });
    generation_safety::apply_sampling(
        &mut body,
        model.artifact.as_ref().map(|a| a.sha256.as_str()),
    );
    let tokenizer_client = local_http_client(Duration::from_secs(15), Duration::from_secs(15))?;
    let started = Instant::now();
    let mut measured_input = 0;
    diagnostic
        .stage
        .set(failure_diagnostics::Stage::Tokenization);
    diagnostic.context.set(Some(u64::from(context_limit)));
    // Use the complete available window for every tier. Model size alone
    // must not discard history at an arbitrary half-window boundary.
    let usage = context_budget::fit_adaptive_context(
        &mut body,
        u64::from(context_limit),
        |candidate| {
            // Clear a previous fitting pass before any new tokenizer operation.
            // If this count fails its input length is unknown, never estimated.
            diagnostic.input.set(None);
            diagnostic.output.set(candidate["max_tokens"].as_u64());
            plan.apply(candidate)?;
            require_runtime_operation_checkpoint(
                &request.request_id,
                &request.catalog_binding,
                &cancel,
            )?;
            if started.elapsed() > Duration::from_secs(60) {
                return Err("Local context preparation timed out.".into());
            }
            let encoded =
                serde_json::to_vec(candidate).map_err(|_| "Local context encoding failed.")?;
            let bytes = if request.use_case == IDLE_CONTEXT_USE_CASE {
                let (status, bytes) = idle_inference::post(
                    port,
                    &api_key,
                    idle_inference::Endpoint::InputTokens,
                    encoded,
                    &cancel,
                    Duration::from_secs(15),
                    MAX_ERROR_RESPONSE_BYTES,
                )?;
                if !(200..300).contains(&status) {
                    return Err(llama_http_failure(status, std::io::Cursor::new(bytes)));
                }
                bytes
            } else {
                let response = local_network::send(
                    tokenizer_client
                        .post(format!(
                            "http://127.0.0.1:{port}/v1/chat/completions/input_tokens"
                        ))
                        .bearer_auth(&api_key)
                        .header("Content-Type", "application/json")
                        .body(encoded),
                )
                .map_err(|_| "Local tokenizer request failed.")?;
                if !response.status().is_success() {
                    return Err(llama_http_failure(response.status().as_u16(), response));
                }
                read_bounded_error_body(response)
                    .ok_or("Local tokenizer response exceeded its size limit.")?
            };
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| "Local tokenizer response is invalid.")?;
            let tokens = value["input_tokens"].as_u64().ok_or_else(|| {
                LocalInferenceFailure::from("Local tokenizer token count is unavailable.")
            })?;
            if measured_input == 0 {
                measured_input = tokens;
            }
            diagnostic.input.set(Some(tokens));
            Ok(tokens)
        },
        || LocalInferenceFailure::http(400, LlamaHttpFailureKind::ContextWindowExceeded),
    );
    // This point is strictly before any completion request or public/tool delta.
    // Only a locally measured context shortage can restart; never replay a
    // completion that may already have produced output or requested a tool.
    let context_shortage = usage
        .as_ref()
        .err()
        .is_none_or(|failure| failure.code == "runtime_context_exceeded");
    if may_grow
        && request.use_case != IDLE_CONTEXT_USE_CASE
        && measured_input > 0
        && context_shortage
    {
        if let Some(target) =
            context_budget::growth_target(context_limit, signed_context, measured_input)
        {
            diagnostic
                .stage
                .set(failure_diagnostics::Stage::Preparation);
            diagnostic.input.set(None);
            diagnostic.context.set(None);
            diagnostic.output.set(None);
            require_runtime_operation_checkpoint(
                &request.request_id,
                &request.catalog_binding,
                &cancel,
            )?;
            let mut expanded = model.clone();
            expanded.context_limit = Some(target);
            ensure_runtime(
                app,
                &expanded,
                Some(&request.scope_digest),
                &request.request_id,
                &request.catalog_binding,
                &cancel,
            )?;
            run_signed_benchmark(
                &expanded,
                &request.request_id,
                &request.catalog_binding,
                &cancel,
            )?;
            {
                let mut guard = state()
                    .lock()
                    .map_err(|_| "Local model manager is unavailable.")?;
                if !operation_owns_catalog_binding(
                    &guard,
                    &request.request_id,
                    &request.catalog_binding,
                ) {
                    return Err("Context growth lost runtime ownership.".into());
                }
                if let Some(runtime) = guard.runtime.as_mut() {
                    runtime.prepared_manifest_hash =
                        Some(request.catalog_binding.manifest_payload_sha256.clone());
                }
            }
            return stream_completion(app, model, request, cancel, on_event, false);
        }
    }
    let usage = usage?;
    diagnostic.stage.set(failure_diagnostics::Stage::Generation);
    diagnostic.input.set(Some(usage.input_tokens));
    diagnostic.context.set(Some(usage.context_tokens));
    diagnostic.output.set(Some(usage.output_tokens));
    require_runtime_operation_checkpoint(&request.request_id, &request.catalog_binding, &cancel)?;
    if request.use_case == IDLE_CONTEXT_USE_CASE {
        let (status, bytes) = idle_inference::post(
            port,
            &api_key,
            idle_inference::Endpoint::Completion,
            serde_json::to_vec(&body).map_err(|_| "Local context encoding failed.")?,
            &cancel,
            signed_read_timeout(thresholds.max_first_token_ms)?,
            128 * 1024,
        )?;
        if !(200..300).contains(&status) {
            return Err(llama_http_failure(status, std::io::Cursor::new(bytes)));
        }
        let mut result = parse_sse(std::io::Cursor::new(bytes), request, cancel, on_event)?;
        result.context_usage = Some(usage);
        return Ok(result);
    }
    let session = Arc::new(Mutex::new(reasoning_budget::Session::new(
        &request.request_id,
        &plan,
        usage.output_tokens as u32,
        resource_revision,
    )));
    let reasoning_interruption = session
        .lock()
        .map_err(|_| "Local thinking state is unavailable.")?
        .interruption
        .clone();
    {
        let mut guard = state()
            .lock()
            .map_err(|_| "Local model manager is unavailable.")?;
        if !operation_owns_catalog_binding(&guard, &request.request_id, &request.catalog_binding)
            || guard.resource_settings.state.applied_revision != resource_revision
        {
            return Err("Local thinking configuration changed during preparation.".into());
        }
        guard.active_reasoning = Some(session.clone());
    }
    on_event
        .send(LocalInferenceEvent::Budget {
            progress: session
                .lock()
                .map_err(|_| "Local thinking state is unavailable.")?
                .snapshot(),
        })
        .map_err(|_| "Local inference event channel closed.")?;
    let (status, response) = generation_stream::Stream::open(
        port,
        &api_key,
        serde_json::to_vec(&body).map_err(|_| "Local generation encoding failed.")?,
        cancel.clone(),
        reasoning_interruption,
        generation_stream::Deadlines {
            first: signed_read_timeout(thresholds.max_first_token_ms)?,
            idle: Duration::from_secs(60),
            total: Duration::from_secs(MAX_INFERENCE_TOTAL_SECONDS),
        },
        MAX_RESPONSE_BYTES,
    )?;
    if !(200..300).contains(&status) {
        return Err(llama_http_failure(status, response));
    }
    let clock = response.progress.clone();
    let mut result = parse_sse_observed(response, request, cancel, on_event, |value| {
        clock
            .lock()
            .map_err(|_| "Local progress is unavailable.")?
            .observe(value);
        let (force, snapshot) = {
            let mut current = session
                .lock()
                .map_err(|_| "Local thinking state is unavailable.")?;
            let (force, emit) = current.observe(value)?;
            (force, emit.then(|| current.snapshot()))
        };
        if let Some(progress) = snapshot {
            on_event
                .send(LocalInferenceEvent::Budget { progress })
                .map_err(|_| "Local inference event channel closed.")?;
        }
        if force
            && send_reasoning_end(&request.request_id, &request.catalog_binding, &session).is_err()
        {
            let mut current = session
                .lock()
                .map_err(|_| "Local thinking state is unavailable.")?;
            current.control_failed();
            let mut progress = current.snapshot();
            progress.control_outcome = Some("unavailable");
            on_event
                .send(LocalInferenceEvent::Budget { progress })
                .map_err(|_| "Local inference event channel closed.")?;
            return Err(reasoning_budget::CONTROL_UNAVAILABLE.into());
        }
        Ok(())
    })?;
    result.context_usage = Some(usage);
    Ok(result)
}

fn parse_sse(
    response: impl Read,
    request: &LocalInferenceRequest,
    cancel: Arc<AtomicBool>,
    on_event: &Channel<LocalInferenceEvent>,
) -> Result<LocalInferenceResult, LocalInferenceFailure> {
    parse_sse_observed(response, request, cancel, on_event, |_| Ok(()))
}

fn parse_sse_observed(
    response: impl Read,
    request: &LocalInferenceRequest,
    cancel: Arc<AtomicBool>,
    on_event: &Channel<LocalInferenceEvent>,
    mut observe: impl FnMut(&Value) -> Result<(), LocalInferenceFailure>,
) -> Result<LocalInferenceResult, LocalInferenceFailure> {
    let mut reader = BufReader::new(response);
    let mut line = Vec::new();
    let mut bytes = 0usize;
    let mut content = String::new();
    let mut finish_reason = "stop".to_string();
    let mut tools: BTreeMap<usize, (String, String, String)> = BTreeMap::new();
    let mut completed = false;
    let mut usage = None;
    let mut diagnostics = RuntimeDiagnostics::default();
    let mut repetition = generation_safety::RepetitionGuard::default();
    let mut private_repetition = generation_safety::RepetitionGuard::default();
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
        diagnostics.observe(&value);
        observe(&value)?;
        // The terminal usage frame may contain an empty choices array.
        if let Some(reported) = value.get("usage").and_then(reported_token_usage) {
            usage = Some(reported);
        }
        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
        else {
            continue;
        };
        // A usage-only trailer is allowed after finish, but never more answer
        // bytes or tool arguments. A terminal frame's own final delta is valid.
        if completed {
            continue;
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            finish_reason = reason.chars().take(64).collect();
            completed = true;
        }
        let Some(delta) = choice.get("delta").and_then(Value::as_object) else {
            continue;
        };
        // Private text is inspected only in bounded request-local state; never exported.
        if delta
            .get("reasoning_content")
            .and_then(Value::as_str)
            .is_some_and(|chunk| private_repetition.observe(chunk).is_some())
        {
            return Err(generation_safety::REPETITION.into());
        }
        if let Some(chunk) = delta.get("content").and_then(Value::as_str) {
            let interrupted_at = repetition.observe(chunk);
            let chunk = &chunk[..interrupted_at.unwrap_or(chunk.len())];
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
            if interrupted_at.is_some() {
                return Err(generation_safety::REPETITION.into());
            }
            // A required call must not spend an entire large answer budget on
            // prose/fenced pseudo-calls. Private reasoning is budgeted separately.
            if request.tool_choice == "required" && tools.is_empty() && content.len() > 4096 {
                return Err(generation_safety::TOOL_CONTRACT.into());
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if index >= MAX_TOOL_CALLS {
                    return Err(generation_safety::TOOL_CONTRACT.into());
                }
                let entry = tools.entry(index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    if entry.0.len().saturating_add(id.len()) > 160 {
                        return Err(generation_safety::TOOL_CONTRACT.into());
                    }
                    entry.0.push_str(id);
                }
                if let Some(function) = call.get("function").and_then(Value::as_object) {
                    if let Some(name) = function.get("name").and_then(Value::as_str) {
                        if entry.1.len().saturating_add(name.len()) > 160 {
                            return Err(generation_safety::TOOL_CONTRACT.into());
                        }
                        entry.1.push_str(name);
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
            if generation_safety::repeated_tool_batch(&tools) {
                return Err(generation_safety::REPETITION.into());
            }
        }
    }
    if !completed {
        return Err("Local llama.cpp stream ended without a terminal marker.".into());
    }
    let expected_tool_count = tools.len();
    let raw_tool_calls: Vec<NativeToolCall> = tools
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
    if raw_tool_calls.len() != expected_tool_count
        || !generation_safety::valid_tool_completion(
            &request.tool_choice,
            &request.tools,
            &raw_tool_calls,
            &finish_reason,
        )
    {
        return Err(generation_safety::TOOL_CONTRACT.into());
    }
    Ok(LocalInferenceResult {
        content,
        raw_tool_calls,
        finish_reason,
        request_id: request.request_id.clone(),
        context_usage: None,
        usage,
        diagnostics,
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
        clear_thinking_session(&mut guard);
        guard.active_request_id = None;
        guard.active_idle_optimization = false;
        guard.cancel = None;
        match outcome {
            RequestOutcome::Success => {
                // A scope change may have started a new, artifact-verified
                // process under still-valid readiness. Its successful reply
                // confirms residency for later lightweight lease renewal.
                if let Some(runtime) = guard.runtime.as_mut() {
                    if runtime.model_id == model.id {
                        runtime.prepared_manifest_hash =
                            Some(catalog_binding.manifest_payload_sha256.clone());
                    }
                }
                guard.failures.remove(&model.id);
                guard.cooldown_until_ms.remove(&model.id);
                guard.last_error = None;
            }
            RequestOutcome::Cancelled | RequestOutcome::Rejected => {
                // Cancellation and rejected input are not model-health evidence and must not
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
    failure_code: Option<&str>,
) -> Option<ManagedRuntime> {
    let mut guard = state().lock().ok()?;
    if !operation_owns_catalog_binding(&guard, operation_id, catalog_binding) {
        return None;
    }
    clear_thinking_session(&mut guard);
    guard.active_request_id = None;
    guard.active_idle_optimization = false;
    guard.cancel = None;
    match outcome {
        RequestOutcome::Success | RequestOutcome::Cancelled | RequestOutcome::Rejected => {
            guard.last_error = None;
            None
        }
        RequestOutcome::Failed => {
            guard.last_error = Some(failure_code.unwrap_or("local_prepare_failed").into());
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
            let available = reader.fill_buf().map_err(|error| {
                match error.to_string().as_str() {
                    "Local generation exceeded its total deadline." => {
                        "Local generation exceeded its total deadline."
                    }
                    "Local generation produced no first progress before its deadline." => {
                        "Local generation produced no first progress before its deadline."
                    }
                    "Local generation stopped making progress before its idle deadline." => {
                        "Local generation stopped making progress before its idle deadline."
                    }
                    "Local inference was cancelled." => "Local inference was cancelled.",
                    reasoning_budget::CONTROL_UNAVAILABLE => reasoning_budget::CONTROL_UNAVAILABLE,
                    _ => "Local llama.cpp stream failed.",
                }
                .to_string()
            })?;
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

#[cfg(not(any(windows, target_os = "linux")))]
fn open_artifact_guard(_path: &Path) -> Result<File, String> {
    Err(
        "Local-model execution is disabled on this platform until immutable artifact guards are available."
            .into(),
    )
}

#[cfg(target_os = "linux")]
fn open_artifact_guard(path: &Path) -> Result<File, String> {
    linux_protection::snapshot(path, &AtomicBool::new(false))
}

fn open_artifact_guard_cancellable(path: &Path, cancel: &AtomicBool) -> Result<File, String> {
    #[cfg(target_os = "linux")]
    {
        linux_protection::snapshot(path, cancel)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cancel;
        open_artifact_guard(path)
    }
}

// `std::fs::MetadataExt::{volume_serial_number, file_index}` on Windows remains gated
// behind the unstable `windows_by_handle` feature, so identity is read directly off the
// open handle via the already-vendored `windows_sys` crate instead.
#[cfg(windows)]
fn platform_identity(file: &File) -> (u64, u64) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let handle = file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    let ok = unsafe { GetFileInformationByHandle(handle, &mut info) };
    if ok == 0 {
        return (0, 0);
    }
    (
        u64::from(info.dwVolumeSerialNumber),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    )
}

#[cfg(unix)]
fn platform_identity(file: &File) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    file.metadata()
        .map(|metadata| (metadata.dev(), metadata.ino()))
        .unwrap_or((0, 0))
}

/// A verified artifact's sha256 plus a permanently-retained clone of the guard handle
/// that proved it. As long as that sentinel clone stays open, the artifact cannot have
/// changed underneath it: on Windows the guard denies write/delete access to every other
/// handle for as long as any clone of it remains open, and on Linux the guard is an
/// immutable sealed memfd snapshot whose content can never change after creation. A cache
/// hit therefore needs no re-read of the (potentially tens-of-GiB) artifact bytes, only a
/// cheap metadata comparison against the fingerprint recorded when the hash was computed.
struct CachedArtifact {
    guard: File,
    len: u64,
    modified: SystemTime,
    identity: (u64, u64),
    sha256: String,
}

impl CachedArtifact {
    fn matches(&self, file: &File) -> bool {
        let Ok(metadata) = file.metadata() else {
            return false;
        };
        let Ok(modified) = metadata.modified() else {
            return false;
        };
        self.len == metadata.len()
            && self.modified == modified
            && self.identity == platform_identity(file)
    }
}

fn artifact_verification_cache() -> &'static Mutex<HashMap<PathBuf, CachedArtifact>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedArtifact>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Returns an open, already-verified guard for `path` plus its sha256, skipping the full
/// artifact read whenever a live process-cache entry for this exact path is still backed
/// by an open sentinel handle with unchanged metadata (see [`CachedArtifact`]). This turns
/// every cold start after the first, within one running process, from a full read of a
/// multi-gigabyte artifact into a metadata comparison. Any failure along the cache path
/// (lock, clone, or metadata) is treated as a cache miss and falls back to the original
/// full verification, so correctness never depends on the cache succeeding.
fn verified_artifact_guard(path: &Path, cancel: &AtomicBool) -> Result<(File, String), String> {
    if let Ok(cache) = artifact_verification_cache().lock() {
        if let Some(cached) = cache.get(path) {
            if let Ok(clone) = cached.guard.try_clone() {
                if cached.matches(&clone) {
                    return Ok((clone, cached.sha256.clone()));
                }
            }
        }
    }
    let mut guard = open_artifact_guard_cancellable(path, cancel)?;
    let metadata = guard.metadata().map_err(|error| error.to_string())?;
    let modified = metadata.modified().map_err(|error| error.to_string())?;
    let identity = platform_identity(&guard);
    let hash = sha256_open_file_cancellable(&mut guard, cancel)?;
    if let Ok(sentinel) = guard.try_clone() {
        if let Ok(mut cache) = artifact_verification_cache().lock() {
            cache.insert(
                path.to_path_buf(),
                CachedArtifact {
                    guard: sentinel,
                    len: metadata.len(),
                    modified,
                    identity,
                    sha256: hash.clone(),
                },
            );
        }
    }
    Ok((guard, hash))
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
    #[cfg(target_os = "linux")]
    if let Some(directory) = Path::new(command.get_program())
        .parent()
        .map(Path::to_path_buf)
    {
        // Only the per-preparation sealed bundle is passed by this runtime path.
        command.env("LD_LIBRARY_PATH", &directory);
        command.current_dir(directory);
    }
    for key in ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

fn spawn_owned_runtime(command: Command) -> Result<(Child, ProcessLifetimeGuard), String> {
    #[cfg(target_os = "linux")]
    {
        linux_protection::spawn(command)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let mut command = command;
        configure_process(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("llama.cpp start failed: {error}"))?;
        match attach_process_lifetime_guard(&child) {
            Ok(guard) => Ok((child, guard)),
            Err(error) => {
                terminate_process(&mut child);
                Err(error)
            }
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

#[cfg(all(unix, not(target_os = "linux")))]
fn configure_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(any(windows, target_os = "linux")))]
fn attach_process_lifetime_guard(_child: &Child) -> Result<ProcessLifetimeGuard, String> {
    Err(
        "Local-model execution is disabled on this platform until parent-death process protection is available."
            .into(),
    )
}

#[cfg(target_os = "linux")]
fn configure_process(command: &mut Command) {
    linux_protection::configure(command);
}

#[cfg(target_os = "linux")]
fn attach_process_lifetime_guard(child: &Child) -> Result<ProcessLifetimeGuard, String> {
    linux_protection::LifetimeGuard::attach(child)
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
    fn generation_fixture(
        frames: Vec<serde_json::Value>,
        tool_choice: &str,
    ) -> (
        Result<super::LocalInferenceResult, super::LocalInferenceFailure>,
        String,
    ) {
        use super::*;
        let request: LocalInferenceRequest = serde_json::from_value(json!({
            "requestId":"synthetic-round","scopeDigest":"a".repeat(64),"modelReleaseId":"synthetic-model","useCase":"chat",
            "catalogBinding":{"acceptanceSessionId":"00000000-0000-4000-8000-000000000001","acceptanceGeneration":1,"manifestPayloadSha256":"b".repeat(64)},
            "messages":[{"role":"user","content":"Synthetic probe"}],"tools":[{"type":"function","function":{"name":"read_probe","parameters":{"type":"object"}}}],"toolChoice":tool_choice,"reasoningMode":"auto"
        })).unwrap();
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = events.clone();
        let channel = Channel::new(move |event| {
            if let tauri::ipc::InvokeResponseBody::Json(event) = event {
                sink.lock().unwrap().push(event);
            }
            Ok(())
        });
        let mut stream: String = frames
            .iter()
            .map(|frame| format!("data: {frame}\n\n"))
            .collect();
        stream.push_str("data: [DONE]\n\n");
        let result = parse_sse(
            std::io::Cursor::new(stream.into_bytes()),
            &request,
            Arc::new(AtomicBool::new(false)),
            &channel,
        );
        let emitted = events.lock().unwrap().join("\n");
        (result, emitted)
    }

    #[test]
    fn generation_repetition_stops_preserves_partial_and_never_exports_private_deltas() {
        use serde_json::json;
        let text = format!(
            "Geprüfter öffentlicher Befund. {}",
            "Fertig. Warte auf deine Anweisung. ".repeat(50)
        );
        let (result, events) = generation_fixture(
            vec![json!({"choices":[{"delta":{"content":text}}]})],
            "auto",
        );
        let failure = result.err().unwrap();
        assert_eq!(failure.code, "runtime_output_repeated");
        assert!(!failure.retryable);
        assert!(failure.preserves_resident_runtime());
        assert!(events.contains("öffentlicher Befund"));
        assert!(events.len() < text.len());
        let (result, events) = generation_fixture(
            vec![
                json!({"choices":[{"delta":{"reasoning_content":"SYNTHETIC PRIVATE PHRASE. ".repeat(100)}}]}),
            ],
            "auto",
        );
        assert_eq!(result.err().unwrap().code, "runtime_output_repeated");
        assert!(!events.contains("PRIVATE"));
    }

    #[test]
    fn generation_tools_require_complete_allowed_json_and_ignore_post_finish_deltas() {
        use serde_json::json;
        let call = json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_probe","arguments":"{\"key\":\"sample\"}"}}]}}]});
        for finish in ["stop", "tool_calls"] {
            let (result, _) = generation_fixture(
                vec![
                    call.clone(),
                    json!({"choices":[{"delta":{},"finish_reason":finish}]}),
                    json!({"choices":[{"delta":{"content":"LATE_DUPLICATE"}}]}),
                    json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}),
                ],
                "required",
            );
            let result = result.unwrap();
            assert_eq!(result.raw_tool_calls.len(), 1);
            assert!(result.content.is_empty());
            assert_eq!(result.usage.unwrap().output_tokens, 4);
        }
        for frames in [
            vec![
                json!({"choices":[{"delta":{"content":"{\"name\":\"read_probe\",\"arguments\":{}}"},"finish_reason":"stop"}]}),
            ],
            vec![
                call.clone(),
                json!({"choices":[{"delta":{},"finish_reason":"length"}]}),
            ],
            vec![
                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"unknown","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}),
            ],
            vec![
                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_probe","arguments":"{"}}]},"finish_reason":"tool_calls"}]}),
            ],
        ] {
            let (result, _) = generation_fixture(frames, "required");
            let failure = result.err().unwrap();
            assert_eq!(failure.code, "runtime_tool_contract_rejected");
            assert!(failure.preserves_resident_runtime());
            assert!(!failure.retryable);
        }
        assert!(generation_fixture(vec![call], "none").0.is_err());
    }

    #[test]
    fn generation_assembles_tool_fragments_and_stops_identical_tool_batches() {
        use serde_json::json;
        let (result, _) = generation_fixture(
            vec![
                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-","function":{"name":"read_","arguments":"{\"key\":"}}]}}]}),
                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"probe","arguments":"\"sample\"}"}}]},"finish_reason":"tool_calls"}]}),
            ],
            "required",
        );
        let result = result.unwrap();
        assert_eq!(result.raw_tool_calls[0].id, "call-1");
        assert_eq!(result.raw_tool_calls[0].function.name, "read_probe");
        assert_eq!(
            result.raw_tool_calls[0].function.arguments,
            "{\"key\":\"sample\"}"
        );
        let repeated = (0..4).map(|index|json!({"choices":[{"delta":{"tool_calls":[{"index":index,"id":format!("call-{index}"),"function":{"name":"read_probe","arguments":"{\"key\":\"sample\"}"}}]}}]})).collect();
        let (result, _) = generation_fixture(repeated, "required");
        assert_eq!(result.err().unwrap().code, "runtime_output_repeated");
    }

    #[test]
    fn generation_sampling_is_hash_bound_and_keeps_context_and_output_limits() {
        use serde_json::json;
        let hashes = [
            "d5c108dfbdac44c738e45a84d5624716cfb8522d1410f46a7108167ee4bd0cac",
            "b19da8c6aacffdedc7bcd6b7f7d7d4db900f7d5c49f5473de18bb58111b432e5",
            "75062a7ba3575573cc421a2cbafbf69fb48d0ecb28da2684b577eb609097fbe4",
            "6c8c7658fe13eef22666aa89862f7fb70aa72109838cf19989e59b15875e5e08",
            "593e9be6fae0e8c4008bb279f6380154afea89aeed90d9e3f2130d0becc84908",
        ];
        for (index, hash) in hashes.iter().enumerate() {
            let mut body = json!({"max_tokens":8192,"messages":[],"tools":[]});
            super::generation_safety::apply_sampling(&mut body, Some(hash));
            assert_eq!(body["max_tokens"], 8192);
            assert_eq!(body["ignore_eos"], false);
            assert_eq!(body["parse_tool_calls"], true);
            assert_eq!(body["dry_allowed_length"], 8);
            assert_eq!(body["top_p"], if index == 3 { 0.95 } else { 0.8 });
        }
        let mut body = json!({"temperature":0.4});
        super::generation_safety::apply_sampling(&mut body, Some("unknown"));
        assert_eq!(body["temperature"], 0.4);
        assert!(body.get("repeat_penalty").is_none());
    }

    #[test]
    fn slot_cache_identity_separates_scope_and_runtime_layout_without_legacy_reuse() {
        let dir = std::path::Path::new("cache");
        let first = super::slot_cache_path(dir, "model-a-context-4096", "scope-a");
        assert_eq!(
            first,
            super::slot_cache_path(dir, "model-a-context-4096", "scope-a")
        );
        assert_ne!(
            first,
            super::slot_cache_path(dir, "model-b-context-4096", "scope-a")
        );
        assert_ne!(
            first,
            super::slot_cache_path(dir, "model-a-context-32768", "scope-a")
        );
        assert_ne!(
            first,
            super::slot_cache_path(dir, "model-a-context-4096", "scope-b")
        );
        assert_ne!(first, dir.join("scope-a.slot"));
    }

    #[test]
    fn context_growth_capacity_failure_is_not_reported_as_a_transport_interruption() {
        for message in [
            "ram_budget_insufficient",
            "runtime_gpu_capacity_unavailable",
            super::resource_runtime::STARTUP_RAM_PRESSURE,
        ] {
            let failure = super::LocalInferenceFailure::from(message);
            assert_eq!(failure.code, "runtime_capacity_exhausted");
            let diagnostic = serde_json::to_value(failure.diagnostic).unwrap();
            assert_eq!(diagnostic["reason"], "capacity");
            assert_eq!(diagnostic["stage"], "preparation");
            assert!(diagnostic.get("httpStatus").is_none());
        }
        assert_eq!(
            super::LocalInferenceFailure::from("Local tokenizer request failed.").code,
            "runtime_stream_failed"
        );
    }
    #[test]
    fn resource_work_leases_survive_catalog_refresh_but_not_renderer_replacement() {
        let first = "7ae16b61-de39-4ed8-96f3-dd132abeb149";
        let second = "ed69ed15-e99b-4128-8fd0-70ed08419b85";
        let mut manager = super::ManagerState::default();
        manager.resource_work_leases.insert("initial-work".into());
        super::rotate_manifest_session(&mut manager, first).unwrap();
        assert_eq!(manager.resource_work_leases.len(), 1);
        super::begin_manifest_acceptance(&mut manager, first, 1).unwrap();
        assert_eq!(manager.resource_work_leases.len(), 1);
        super::rotate_manifest_session(&mut manager, second).unwrap();
        assert!(manager.resource_work_leases.is_empty());
    }
    #[test]
    fn signed_accelerator_scope_is_optional_and_rejects_null_or_unknown_values() {
        let envelope: super::SignedEnvelope = serde_json::from_str(GOLDEN_ENVELOPE).unwrap();
        let mut payload = envelope.payload;
        let legacy = super::parse_manifest_payload(&payload).unwrap();
        assert!(legacy.models[0]
            .capacity_policy
            .accelerator_memory_scope
            .is_none());
        for scope in [
            serde_json::json!(null),
            serde_json::json!("sum_everything"),
            serde_json::json!(12),
        ] {
            payload["models"][0]["capacity_policy"]["accelerator_memory_scope"] = scope;
            assert!(super::parse_manifest_payload(&payload)
                .and_then(|p| super::validate_manifest(&p))
                .is_err());
        }
        payload["models"][0]["capacity_policy"]["accelerator_memory_scope"] =
            serde_json::json!("compatible_group");
        assert!(super::parse_manifest_payload(&payload)
            .and_then(|p| super::validate_manifest(&p))
            .is_ok());
    }
    #[test]
    fn retained_exited_child_is_not_a_ready_runtime() {
        assert!(!super::managed_child_is_running(None));
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/D", "/C", "exit", "0"]);
            command.creation_flags(0x08000000);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "exit 0"]);
            command
        };
        let mut child = command.spawn().unwrap();
        child.wait().unwrap();
        assert!(!super::managed_child_is_running(Some(&mut child)));
    }

    #[test]
    fn diagnostics_merge_only_reported_numeric_fields() {
        let mut data = super::RuntimeDiagnostics::default();
        data.observe(&serde_json::json!({"timings": {"cache_n": 8, "prompt_ms": 12.5, "predicted_per_second": -1}, "reasoning_content": "private"}));
        data.observe(&serde_json::json!({"usage": {"prompt_tokens_details": {"cached_tokens": 0}, "completion_tokens_details": {"reasoning_tokens": 3}}}));
        assert_eq!(data.cached_tokens, Some(0));
        assert_eq!(data.prompt_ms, Some(12.5));
        assert_eq!(data.output_tokens_per_second, None);
        assert_eq!(data.reasoning_tokens, Some(3));
        assert!(!serde_json::to_string(&data).unwrap().contains("private"));
    }

    #[test]
    fn token_usage_requires_real_counts_and_ignores_untrusted_totals() {
        let actual = super::reported_token_usage(&serde_json::json!({
            "prompt_tokens": 123, "completion_tokens": 7, "total_tokens": 999
        }))
        .unwrap();
        assert_eq!(actual.input_tokens, 123);
        assert_eq!(actual.output_tokens, 7);
        assert_eq!(actual.total_tokens, 130);
        for invalid in [
            serde_json::json!({"prompt_tokens": 10}),
            serde_json::json!({"prompt_tokens": -1, "completion_tokens": 2}),
            serde_json::json!({"prompt_tokens": 2, "completion_tokens": 1.5}),
            serde_json::json!({"prompt_tokens": 9_007_199_254_740_991_u64, "completion_tokens": 1}),
        ] {
            assert!(super::reported_token_usage(&invalid).is_none());
        }
    }

    use super::{
        acceptance_generation_is_current, begin_manifest_acceptance, benchmark_qualifies,
        canonical_contract_hash, canonical_json, classify_llama_http_status,
        contract_versions_acceptable, decode_manifest_public_key, llama_http_failure,
        loopback_listener_owned_by, operation_owns_catalog_binding, parse_manifest_payload,
        parse_rfc3339_millis, persist_versions_in_connection, read_bounded_error_body,
        require_catalog_binding, rotate_manifest_session, safe_id, signed_read_timeout,
        storage_class_eligible, valid_hash, valid_manifest_session_id, valid_manifest_trust_domain,
        validate_discovery_binding, validate_manifest, verify_envelope_with_trust,
        versions_are_monotone, BenchmarkThresholds, CatalogBindingInput, LlamaHttpFailureKind,
        ManagerState, ManifestPayload, SignedEnvelope, VerifiedCatalog, MAX_ERROR_RESPONSE_BYTES,
    };
    #[cfg(windows)]
    use super::{
        artifact_verification_cache, attach_process_lifetime_guard, configured_paths_from_sources,
        open_artifact_guard, read_runtime_path_config, sha256_bytes, sha256_open_file_cancellable,
        storage_mount_match_len, verified_artifact_guard, ManagedRuntime, RuntimeScope,
        MAX_RUNTIME_PATH_CONFIG_BYTES,
    };
    use base64::Engine;
    use serde_json::json;
    #[cfg(windows)]
    use std::fs::{self, File, OpenOptions};
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
    fn prepared_process_is_reused_for_first_and_following_requests_and_keeps_scope() {
        let fixture = RuntimePathFixture::new();
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ]);
        super::configure_process(&mut command);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        let lifetime = match attach_process_lifetime_guard(&child) {
            Ok(lifetime) => lifetime,
            Err(error) => {
                super::terminate_process(&mut child);
                panic!("{error}");
            }
        };
        let mut resident = ManagedRuntime {
            resource_revision: 0,
            benchmark: None,
            child: Some(child),
            model_id: "model-a".into(),
            scope: RuntimeScope::Prepared,
            prepared_manifest_hash: Some("a".repeat(64)),
            port: 0,
            api_key: String::new(),
            api_key_file: fixture.root.join("unused.key"),
            acceleration: std::sync::Arc::new(std::sync::Mutex::new(
                super::gpu_runtime::AccelerationPlan::cpu("fixture").status,
            )),
            resource_plan: super::resource_runtime::plan_resources(
                &super::resource_runtime::ResourceSnapshot {
                    logical_cores: 1,
                    physical_cores: Some(1),
                    available_logical_cores: 1,
                    cpu_load: None,
                    total_ram_bytes: 8 * 1024 * 1024 * 1024,
                    available_ram_bytes: 4 * 1024 * 1024 * 1024,
                },
                1024,
                1,
                "cpu",
                &super::resource_runtime::RuntimeOptions::default(),
            ),
            model_storage: super::ModelStorage {
                storage_type: "unknown".into(),
                bus_types: Vec::new(),
                fixed: None,
                available_bytes: None,
                total_bytes: None,
                reason_code: None,
            },
            slot_cache_dir: None,
            slot_cache_namespace: "test-layout".into(),
            _support_guards: Vec::new(),
            _runtime_guard: open_artifact_guard(&fixture.runtime).unwrap(),
            _model_guard: open_artifact_guard(&fixture.model_directory.join("model-a.gguf"))
                .unwrap(),
            _process_lifetime_guard: lifetime,
        };
        assert!(resident.reuse("model-a", None).unwrap());
        assert!(resident.reuse("model-a", Some("project-a")).unwrap());
        assert!(resident.reuse("model-a", Some("project-a")).unwrap());
        // A readiness refresh cannot reset scope and expose a private slot to B.
        assert!(resident.reuse("model-a", None).unwrap());
        assert!(!resident.reuse("model-a", Some("project-b")).unwrap());
        assert!(!resident.reuse("model-b", Some("project-a")).unwrap());
        assert_eq!(resident.scope, RuntimeScope::Bound("project-a".into()));
        assert_eq!(resident.child.as_ref().unwrap().id(), pid);
        assert!(resident
            .child
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none());
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut manager = ManagerState {
            runtime: Some(resident),
            active_request_id: Some("idle-request".into()),
            active_idle_optimization: true,
            cancel: Some(cancel.clone()),
            ..Default::default()
        };
        assert!(super::cancel_active_operation(&mut manager, "old-request").is_none());
        assert!(!cancel.load(std::sync::atomic::Ordering::SeqCst));
        assert!(super::cancel_active_operation(&mut manager, "idle-request").is_none());
        assert!(cancel.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(manager.active_request_id.as_deref(), Some("idle-request"));
        assert_eq!(
            manager
                .runtime
                .as_ref()
                .unwrap()
                .child
                .as_ref()
                .unwrap()
                .id(),
            pid
        );
        assert!(manager
            .runtime
            .as_mut()
            .unwrap()
            .reuse("model-a", Some("project-a"))
            .unwrap());
        // Normal request cancellation still hands the owned child to hard stop.
        manager.active_idle_optimization = false;
        let mut resident = super::cancel_active_operation(&mut manager, "idle-request").unwrap();
        assert!(manager.runtime.is_none());
        // Reproduce the real post-chat path: a bound scope saves its cache while
        // an async IPC command owns teardown. A direct stop here panics in reqwest.
        resident.slot_cache_dir = Some(fixture.root.clone());
        tauri::async_runtime::block_on(async move {
            tauri::async_runtime::spawn(
                async move { super::stop_runtime_async(Some(resident)).await },
            )
            .await
            .unwrap()
            .unwrap();
        });
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

    #[test]
    fn resident_only_renewal_cannot_enter_cold_start_or_benchmark_work() {
        let mut cold_work = 0;
        let result = super::require_cold_start_allowed(true).map(|()| {
            cold_work += 1;
        });
        assert_eq!(result.unwrap_err(), super::RESIDENT_RENEWAL_UNAVAILABLE);
        assert_eq!(cold_work, 0);
        super::require_cold_start_allowed(false)
            .map(|()| {
                cold_work += 1;
            })
            .unwrap();
        assert_eq!(cold_work, 1);
    }

    #[test]
    fn idle_context_request_is_bounded_and_cannot_cold_start_missing_residency() {
        let value = json!({
            "resourceRevision": 0,
            "requestId": "idle-request",
            "scopeDigest": "a".repeat(64),
            "modelReleaseId": "model-a",
            "catalogBinding": {
                "acceptanceSessionId": "00000000-0000-4000-8000-000000000001",
                "acceptanceGeneration": 1,
                "manifestPayloadSha256": "a".repeat(64)
            },
            "useCase": "context.optimize",
            "messages": [{"role": "user", "content": "Public fixture"}],
            "tools": [], "toolChoice": "none", "maxOutputTokens": 768,
            "reasoningMode": "off"
        });
        let request: super::LocalInferenceRequest = serde_json::from_value(value).unwrap();
        assert!(super::validate_inference_request(&request).is_ok());
        for changed in [
            json!({"tools": [{"type": "function"}]}),
            json!({"toolChoice": "auto"}),
            json!({"reasoningMode": "auto"}),
            json!({"maxOutputTokens": 769}),
            json!({"messages": [{"role": "user", "content": "x".repeat(65536)}]}),
        ] {
            let mut invalid = request.clone();
            if let Some(tools) = changed.get("tools") {
                invalid.tools = tools.as_array().unwrap().clone();
            }
            if let Some(choice) = changed.get("toolChoice") {
                invalid.tool_choice = choice.as_str().unwrap().into();
            }
            if let Some(mode) = changed.get("reasoningMode") {
                invalid.reasoning_mode = mode.as_str().unwrap().into();
            }
            if let Some(max) = changed.get("maxOutputTokens") {
                invalid.max_output_tokens = Some(max.as_u64().unwrap() as u32);
            }
            if let Some(messages) = changed.get("messages") {
                invalid.messages = messages.as_array().unwrap().clone();
            }
            assert!(super::validate_inference_request(&invalid).is_err());
        }
        let envelope: SignedEnvelope = serde_json::from_str(GOLDEN_ENVELOPE).unwrap();
        let payload = parse_manifest_payload(&envelope.payload).unwrap();
        let mut manager = ManagerState::default();
        assert_eq!(
            super::require_idle_resident(&mut manager, &payload.models[0], "scope", 0, "hash")
                .unwrap_err(),
            super::IDLE_RESIDENT_UNAVAILABLE
        );
        assert!(manager.runtime.is_none());
        assert!(manager.active_request_id.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn configured_storage_never_substitutes_an_unrelated_faster_drive() {
        let mounts = vec![
            Path::new(r"C:\").to_path_buf(),
            Path::new(r"D:\").to_path_buf(),
        ];
        assert_eq!(super::match_configured_storage(None, mounts.clone()), None);
        assert_eq!(
            super::match_configured_storage(Some(None), mounts.clone()),
            Some(None)
        );
        assert_eq!(
            super::match_configured_storage(
                Some(Some(Path::new(r"E:\models").to_path_buf())),
                mounts.clone()
            ),
            Some(None)
        );
        assert_eq!(
            super::match_configured_storage(
                Some(Some(Path::new(r"\\?\D:\models").to_path_buf())),
                mounts
            ),
            Some(Some(super::storage_mount_id(Path::new(r"D:\"))))
        );
        assert_eq!(
            super::storage_mount_id(Path::new(r"\\?\d:\")),
            super::storage_mount_id(Path::new(r"D:\"))
        );
        assert_ne!(
            super::storage_mount_id(Path::new(r"C:\")),
            super::storage_mount_id(Path::new(r"D:\"))
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
        assert!(failure.is_input_rejection());
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
        assert!(history_failure.is_input_rejection());
        assert!(
            !super::LocalInferenceFailure::http(500, LlamaHttpFailureKind::ServerFailed)
                .is_input_rejection()
        );
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
    fn five_tier_catalog_preserves_signed_routing_boundaries() {
        let mut payload: ManifestPayload = serde_json::from_str(include_str!(
            "../../../tests/fixtures/local-model-tiers-v2.json"
        ))
        .unwrap();
        assert!(validate_manifest(&payload).is_ok());
        payload.models[0].context_limit = Some(
            payload.models[0]
                .runtime
                .as_ref()
                .unwrap()
                .max_context_tokens
                + 1,
        );
        assert!(validate_manifest(&payload).is_err());
        payload.models[0].context_limit = Some(
            payload.models[0]
                .runtime
                .as_ref()
                .unwrap()
                .min_context_tokens,
        );
        assert!(validate_manifest(&payload).is_ok());
        payload.routing.external_requires_explicit_approval = false;
        assert!(validate_manifest(&payload).is_err());
        payload.routing.external_requires_explicit_approval = true;
        payload.routing.fallback_model_ids[0] = payload.routing.default_model_id.clone();
        assert!(validate_manifest(&payload).is_err());
        payload.schema_version = 1;
        assert!(validate_manifest(&payload).is_err());
    }

    #[test]
    fn starter_tiers_share_only_identical_signed_artifact_files() {
        let mut payload: ManifestPayload = serde_json::from_str(include_str!(
            "../../../tests/fixtures/local-model-tiers-v2.json"
        ))
        .unwrap();
        let model = payload.models[0].clone();
        let same = super::shared_artifact_ids(&model, &payload.models);
        assert_eq!(same.len(), 5);
        assert_eq!(same[0], model.id);
        payload.models[1].artifact.as_mut().unwrap().sha256 = "f".repeat(64);
        payload.models[2].artifact.as_mut().unwrap().size_bytes += 1;
        payload.models[3].artifact = None;
        let remaining = super::shared_artifact_ids(&model, &payload.models);
        assert_eq!(remaining, vec![model.id, payload.models[4].id.clone()]);
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

    #[cfg(windows)]
    #[test]
    fn verified_artifact_guard_returns_the_true_sha256_of_the_file_content() {
        let path =
            std::env::temp_dir().join(format!("luczor-cache-hash-{}.bin", uuid::Uuid::new_v4()));
        let content = b"the quick brown fox jumps over the lazy dog";
        fs::write(&path, content).unwrap();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let (_guard, hash) = verified_artifact_guard(&path, &cancel).unwrap();
        assert_eq!(hash, sha256_bytes(content));
    }

    #[cfg(windows)]
    #[test]
    fn verified_artifact_guard_populates_and_reuses_the_process_cache() {
        let path =
            std::env::temp_dir().join(format!("luczor-cache-pop-{}.bin", uuid::Uuid::new_v4()));
        fs::write(&path, b"cache me across cold starts").unwrap();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        assert!(!artifact_verification_cache()
            .lock()
            .unwrap()
            .contains_key(&path));
        let (_first, hash) = verified_artifact_guard(&path, &cancel).unwrap();
        assert!(artifact_verification_cache()
            .lock()
            .unwrap()
            .contains_key(&path));
        // A second call for the same still-unchanged path must be served from the cache
        // and report the identical hash without needing to touch the artifact bytes again.
        let (_second, hash_again) = verified_artifact_guard(&path, &cancel).unwrap();
        assert_eq!(hash, hash_again);
        assert_eq!(
            artifact_verification_cache()
                .lock()
                .unwrap()
                .get(&path)
                .unwrap()
                .sha256,
            hash
        );
    }

    #[cfg(windows)]
    #[test]
    fn verified_artifact_guard_keeps_the_file_write_protected_across_repeated_cold_starts() {
        let path =
            std::env::temp_dir().join(format!("luczor-cache-guard-{}.bin", uuid::Uuid::new_v4()));
        fs::write(&path, b"protected across cold starts").unwrap();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let (guard1, _) = verified_artifact_guard(&path, &cancel).unwrap();
        let (guard2, _) = verified_artifact_guard(&path, &cancel).unwrap();
        // The cache's own sentinel clone is what actually keeps this guarantee alive, so
        // dropping every call-site guard must not lift the protection.
        drop(guard1);
        drop(guard2);
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::remove_file(&path).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn cached_artifact_fingerprint_rejects_a_different_files_metadata() {
        let path_a =
            std::env::temp_dir().join(format!("luczor-cache-fp-a-{}.bin", uuid::Uuid::new_v4()));
        let path_b =
            std::env::temp_dir().join(format!("luczor-cache-fp-b-{}.bin", uuid::Uuid::new_v4()));
        fs::write(&path_a, b"aaaa").unwrap();
        fs::write(&path_b, b"bbbbbbbb").unwrap();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        verified_artifact_guard(&path_a, &cancel).unwrap();
        let cache = artifact_verification_cache().lock().unwrap();
        let cached_a = cache.get(&path_a).unwrap();
        let file_b = File::open(&path_b).unwrap();
        assert!(!cached_a.matches(&file_b));
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
        // Windows USB SSDs may report DRIVE_FIXED and non-removable media.
        assert!(!storage_class_eligible("fixed_storage", false, "usb"));
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
