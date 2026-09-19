//! Public failure metadata is a projection of fixed labels and measured counts.
//! Provider error bodies, prompts, identifiers and arbitrary field names never
//! cross this boundary, even when a server echoes them in an error response.
use super::{classify_llama_http_error, LlamaHttpFailureKind, LocalInferenceFailure};
use serde::Serialize;
use serde_json::Value;
use std::cell::Cell;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Preparation,
    Tokenization,
    Generation,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    ContextLimit,
    MessageOrder,
    MessageShape,
    ToolContract,
    Template,
    ParameterType,
    ParameterValue,
    UnsupportedParameter,
    Capacity,
    Authentication,
    ModelUnavailable,
    Server,
    Connection,
    ResponseBody,
    TransportTimeout,
    InvalidStream,
    IncompleteStream,
    EventChannel,
    Unclassified,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    schema_version: u8,
    pub stage: Stage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameter: Option<&'static str>,
    reason: Reason,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_tokens: Option<u64>,
}

impl Diagnostic {
    pub(super) fn stream(message: &str) -> Self {
        let reason = match message {
            "Local HTTP connection failed." => Reason::Connection,
            "Local HTTP response body failed." | "Local HTTP stream failed." => {
                Reason::ResponseBody
            }
            "Local HTTP transport timed out." => Reason::TransportTimeout,
            "Local llama.cpp emitted invalid SSE JSON."
            | "Local llama.cpp emitted invalid UTF-8." => Reason::InvalidStream,
            "Local llama.cpp stream ended without a terminal marker." => Reason::IncompleteStream,
            "Local inference event channel closed." => Reason::EventChannel,
            _ => Reason::Unclassified,
        };
        Self {
            reason,
            ..Self::new("runtime_stream_failed", Stage::Unknown)
        }
    }
    pub(super) fn new(code: &'static str, stage: Stage) -> Self {
        Self {
            schema_version: 1,
            stage,
            http_status: None,
            code,
            parameter: None,
            reason: Reason::Unclassified,
            input_tokens: None,
            context_tokens: None,
            output_tokens: None,
        }
    }
    pub(super) fn http(status: u16, kind: LlamaHttpFailureKind) -> Self {
        Self {
            http_status: Some(status),
            reason: reason_for(kind),
            ..Self::new(kind.code(), Stage::Unknown)
        }
    }
    pub(super) fn capacity() -> Self {
        Self {
            reason: Reason::Capacity,
            ..Self::new("runtime_capacity_exhausted", Stage::Preparation)
        }
    }
}

fn reason_for(kind: LlamaHttpFailureKind) -> Reason {
    match kind {
        LlamaHttpFailureKind::ContextWindowExceeded => Reason::ContextLimit,
        LlamaHttpFailureKind::ChatHistoryRejected => Reason::MessageOrder,
        LlamaHttpFailureKind::ChatTemplateFailed => Reason::Template,
        LlamaHttpFailureKind::ToolContractRejected => Reason::ToolContract,
        LlamaHttpFailureKind::CapacityExhausted => Reason::Capacity,
        LlamaHttpFailureKind::AuthenticationFailed => Reason::Authentication,
        LlamaHttpFailureKind::ModelUnavailable => Reason::ModelUnavailable,
        LlamaHttpFailureKind::ServerFailed => Reason::Server,
        _ => Reason::Unclassified,
    }
}

const PARAMETERS: &[&str] = &[
    "model",
    "messages",
    "messages.role",
    "messages.content",
    "tools",
    "tool_choice",
    "max_tokens",
    "n_predict",
    "reasoning_budget_tokens",
    "thinking_budget_tokens",
    "reasoning_control",
    "reasoning_effort",
    "chat_template_kwargs",
    "enable_thinking",
    "parse_tool_calls",
    "stream",
    "stream_options",
    "cache_prompt",
    "timings_per_token",
    "temperature",
    "top_p",
    "response_format",
    "grammar",
    "seed",
];

fn known_parameter(value: &str) -> Option<&'static str> {
    if let Some(name) = PARAMETERS.iter().copied().find(|name| *name == value) {
        return Some(name);
    }
    // Collapse an indexed message path to a fixed public field, never expose
    // the index or an arbitrary nested provider-supplied property.
    let indexed = value
        .strip_prefix("messages[")
        .and_then(|rest| rest.split_once(']'));
    if let Some((index, suffix)) = indexed {
        if !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()) {
            return match suffix {
                ".role" => Some("messages.role"),
                ".content" => Some("messages.content"),
                _ => None,
            };
        }
    }
    None
}

fn parameter(error: &Value, value: &Value, message: &str) -> Option<&'static str> {
    // An explicit but unknown field must not fall back to unrelated text that
    // a provider may have echoed from the prompt.
    if let Some(param) = error
        .get("param")
        .or_else(|| value.get("param"))
        .and_then(Value::as_str)
    {
        return known_parameter(param);
    }
    // Exact quoted field names only: no substring matching of paths, values,
    // tool names or secrets, and never return the provider-owned string itself.
    for quote in ['"', '\'', '`'] {
        for field in message.split(quote).skip(1).step_by(2) {
            if let Some(parameter) = known_parameter(field) {
                return Some(parameter);
            }
        }
    }
    None
}

fn generation_grammar_failure(message: &str) -> bool {
    // b10809 validates these only after /input_tokens, in the completion
    // schema or sampler initialization. Match upstream messages, not arbitrary
    // occurrences of "grammar" in a provider's echoed input.
    if message == "failed to initialize samplers: failed to parse grammar" {
        return true;
    }
    let Some(detail) = message.strip_prefix("field 'grammar_triggers': ") else {
        return false;
    };
    detail == "error: no triggers set for lazy grammar!"
        || detail.starts_with("grammar trigger word should be marked as preserved token: ")
}

pub(super) fn classify(status: u16, body: &[u8]) -> LocalInferenceFailure {
    let mut kind = if matches!(status, 401 | 403) {
        LlamaHttpFailureKind::AuthenticationFailed
    } else {
        classify_llama_http_error(status, body)
    };
    let mut diagnostic = Diagnostic::http(status, kind);
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        let error = value.get("error").unwrap_or(&value);
        let message = error
            .get("message")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
            .unwrap_or_default();
        let error_type = error
            .get("type")
            .or_else(|| value.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let lower = message.to_ascii_lowercase();
        // An allocation failure mentioning the template is still a capacity
        // problem, never a harmless malformed-template rejection.
        if !matches!(status, 401 | 403)
            && (matches!(
                error_type.as_str(),
                "insufficient_capacity" | "out_of_memory" | "server_busy"
            ) || lower.contains("out of memory")
                || lower.contains("not enough memory")
                || lower.contains("failed to allocate")
                || lower.contains("no available slot")
                || lower.contains("server is busy"))
        {
            kind = LlamaHttpFailureKind::CapacityExhausted;
            diagnostic = Diagnostic::http(status, kind);
        }
        diagnostic.parameter = parameter(error, &value, message);
        let shape = lower.contains("must be")
            || lower.contains("invalid type")
            || lower.contains("expected")
            || lower.contains("type_error")
            || lower.contains("missing")
            || lower.contains("invalid value");
        let input_status = matches!(status, 400 | 413 | 422);
        if input_status
            && matches!(
                kind,
                LlamaHttpFailureKind::RequestRejected | LlamaHttpFailureKind::ChatTemplateFailed
            )
        {
            let grammar_failed = generation_grammar_failure(&lower);
            if grammar_failed && error.get("param").or_else(|| value.get("param")).is_none() {
                // Only a fixed public alias; never relay the generated trigger word.
                diagnostic.parameter = Some("grammar");
            }
            let reason = if grammar_failed {
                Some(Reason::ToolContract)
            } else if error_type == "message_format_error"
                || (matches!(
                    diagnostic.parameter,
                    Some("messages" | "messages.role" | "messages.content")
                ) && shape)
                || lower.contains("messages must be")
                || lower.contains("message content must be")
            {
                Some(Reason::MessageShape)
            } else if (matches!(
                diagnostic.parameter,
                Some("tools" | "tool_choice" | "parse_tool_calls" | "grammar")
            ) && shape)
                || error_type == "tool_schema_error"
            {
                Some(Reason::ToolContract)
            } else if error_type == "not_supported_error"
                || lower.contains("unsupported parameter")
                || lower.contains("unsupported param:")
                || lower.contains("unknown parameter")
                || lower.contains("unrecognized parameter")
                || (diagnostic.parameter.is_some() && lower.contains("not supported"))
            {
                Some(Reason::UnsupportedParameter)
            } else if lower.contains("invalid type")
                || lower.contains("type_error")
                || lower.contains("type must be")
                || (diagnostic.parameter.is_some()
                    && (lower.contains("must be a ")
                        || lower.contains("must be an ")
                        || lower.contains("expected boolean")
                        || lower.contains("expected integer")
                        || lower.contains("expected number")
                        || lower.contains("expected string")))
            {
                Some(Reason::ParameterType)
            } else if lower.contains("invalid value")
                || lower.contains("out of range")
                || lower.contains("must be between")
                || lower.contains("must be one of")
                || lower.contains("must be greater")
                || lower.contains("must be positive")
                || lower.contains("must be non-negative")
                || lower.contains("must be >=")
                || lower.contains("must be <=")
            {
                Some(Reason::ParameterValue)
            } else {
                None
            };
            if let Some(reason) = reason {
                diagnostic.reason = reason;
                kind = if reason == Reason::ToolContract {
                    LlamaHttpFailureKind::ToolContractRejected
                } else {
                    LlamaHttpFailureKind::RequestRejected
                };
                diagnostic.code = kind.code();
            }
        }
    }
    let mut failure = LocalInferenceFailure::http(status, kind);
    failure.diagnostic = diagnostic;
    failure
}

/// A failed tokenizer attempt clears the preceding count; generation receives
/// only the final successful tokenizer measurement, never a UI token estimate.
pub(super) struct Context {
    pub stage: Cell<Stage>,
    pub input: Cell<Option<u64>>,
    pub context: Cell<Option<u64>>,
    pub output: Cell<Option<u64>>,
}
impl Context {
    pub fn new() -> Self {
        Self {
            stage: Cell::new(Stage::Preparation),
            input: Cell::new(None),
            context: Cell::new(None),
            output: Cell::new(None),
        }
    }
    pub fn annotate(&self, mut failure: LocalInferenceFailure) -> LocalInferenceFailure {
        if failure.diagnostic.stage == Stage::Unknown {
            failure.diagnostic.stage = self.stage.get();
            let exact =
                |value: Option<u64>| value.filter(|number| *number <= 9_007_199_254_740_991);
            failure.diagnostic.input_tokens = exact(self.input.get());
            failure.diagnostic.context_tokens = exact(self.context.get());
            failure.diagnostic.output_tokens = exact(self.output.get());
        }
        failure
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn diagnostic(body: Value) -> Value {
        serde_json::to_value(classify(400, &serde_json::to_vec(&body).unwrap()).diagnostic).unwrap()
    }

    #[test]
    fn projects_parameter_reason_and_never_raw_provider_data() {
        let value = diagnostic(
            json!({"error":{"param":"reasoning_budget_tokens", "type":"invalid_request_error",
            "message":"invalid value for `reasoning_budget_tokens`; prompt=SECRET path=/home/private.gguf"},
            "inputTokens":9876,"contextTokens":5555,"private":"NEVER"}),
        );
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["httpStatus"], 400);
        assert_eq!(value["reason"], "parameter_value");
        assert_eq!(value["parameter"], "reasoning_budget_tokens");
        assert_eq!(value["code"], "runtime_request_rejected");
        assert!(value.get("inputTokens").is_none());
        let encoded = value.to_string();
        for secret in [
            "SECRET", "private", "NEVER", "9876", "5555", "message", "body",
        ] {
            assert!(!encoded.contains(secret));
        }
    }

    #[test]
    fn recognizes_message_tool_parameter_type_and_unsupported_shapes() {
        for (message, parameter, reason, code) in [
            (
                "'messages' must be an array",
                "messages",
                "message_shape",
                "runtime_request_rejected",
            ),
            (
                "'tools' must be an array of objects",
                "tools",
                "tool_contract",
                "runtime_tool_contract_rejected",
            ),
            (
                "invalid type for \"enable_thinking\" (expected boolean, got string)",
                "enable_thinking",
                "parameter_type",
                "runtime_request_rejected",
            ),
            (
                "Unsupported param: `response_format`",
                "response_format",
                "unsupported_parameter",
                "runtime_request_rejected",
            ),
            (
                "'max_tokens' must be >= 1",
                "max_tokens",
                "parameter_value",
                "runtime_request_rejected",
            ),
        ] {
            let value =
                diagnostic(json!({"error":{"message":message,"type":"invalid_request_error"}}));
            assert_eq!(value["parameter"], parameter);
            assert_eq!(value["reason"], reason);
            assert_eq!(value["code"], code);
        }
    }

    #[test]
    fn classifies_b10809_generation_only_grammar_failures_without_private_suffixes() {
        // /input_tokens does not run eval_llama_cmpl_schema or initialize samplers.
        // These exact upstream failures can therefore follow successful tokenization.
        for message in [
            "Failed to initialize samplers: failed to parse grammar",
            "Field 'grammar_triggers': Error: no triggers set for lazy grammar!",
            "Field 'grammar_triggers': Grammar trigger word should be marked as preserved token: PRIVATE_TRIGGER",
        ] {
            let context = Context::new();
            context.stage.set(Stage::Generation);
            context.input.set(Some(19263));
            context.context.set(Some(32768));
            context.output.set(Some(13441));
            let failure = context.annotate(classify(
                400,
                &serde_json::to_vec(&json!({"error":{"message":message,"type":"invalid_request_error"}})).unwrap(),
            ));
            let value = serde_json::to_value(&failure.diagnostic).unwrap();
            assert_eq!(failure.code, "runtime_tool_contract_rejected", "{message}");
            assert_eq!(value["reason"], "tool_contract");
            assert_eq!(value["parameter"], "grammar");
            assert_eq!(value["stage"], "generation");
            assert_eq!(value["inputTokens"], 19263);
            assert_eq!(value["contextTokens"], 32768);
            assert_eq!(value["outputTokens"], 13441);
            assert!(!value.to_string().contains("PRIVATE_TRIGGER"));
            assert!(!failure.retryable);
            assert!(failure.preserves_resident_runtime());
        }
    }

    #[test]
    fn grammar_failure_classification_does_not_override_auth_capacity_or_unrelated_text() {
        for (status, message, expected) in [
            (
                401,
                "Failed to initialize samplers: failed to parse grammar",
                "runtime_auth_failed",
            ),
            (
                500,
                "Failed to initialize samplers: failed to parse grammar",
                "runtime_server_failed",
            ),
            (
                400,
                "Failed to initialize samplers: out of memory",
                "runtime_capacity_exhausted",
            ),
            (
                400,
                "A user mentioned: Failed to initialize samplers: failed to parse grammar",
                "runtime_request_rejected",
            ),
            (
                400,
                "Grammar is present in the private input",
                "runtime_request_rejected",
            ),
        ] {
            let failure = classify(
                status,
                &serde_json::to_vec(&json!({"error":{"message":message}})).unwrap(),
            );
            assert_eq!(failure.code, expected, "{status}: {message}");
            assert_ne!(failure.diagnostic.reason, Reason::ToolContract);
        }
        let value = diagnostic(
            json!({"error":{"param":"private-field","message":"Failed to initialize samplers: failed to parse grammar"}}),
        );
        assert!(value.get("parameter").is_none());
    }

    #[test]
    fn unknown_fields_and_quoted_private_names_are_not_relayed() {
        for body in [
            json!({"error":{"param":"/secret/path","message":"invalid type for 'max_tokens'"}}),
            json!({"error":{"message":"invalid value for 'private-account-key'"}}),
        ] {
            let value = diagnostic(body);
            assert!(value.get("parameter").is_none());
            assert!(!value.to_string().contains("secret"));
        }
        assert_eq!(
            classify(400, b"not json SECRET").diagnostic.reason,
            Reason::Unclassified
        );
    }

    #[test]
    fn failed_tokenizer_omits_stale_count_and_generation_retains_final_measurement() {
        let context = Context::new();
        context.stage.set(Stage::Tokenization);
        context.context.set(Some(32768));
        context.output.set(Some(8192));
        context.input.set(Some(16642));
        context.input.set(None);
        let failure = context.annotate(classify(
            400,
            br#"{"error":{"message":"unsupported parameter"}}"#,
        ));
        let value = serde_json::to_value(&failure.diagnostic).unwrap();
        assert_eq!(value["stage"], "tokenization");
        assert!(value.get("inputTokens").is_none());
        assert_eq!(value["contextTokens"], 32768);
        context.stage.set(Stage::Generation);
        context.input.set(Some(14000));
        let generated = context.annotate(LocalInferenceFailure::http(
            400,
            LlamaHttpFailureKind::RequestRejected,
        ));
        assert_eq!(generated.diagnostic.input_tokens, Some(14000));
        assert_eq!(generated.diagnostic.stage, Stage::Generation);
        // An outer wrapper must not relabel a failure from nested context growth.
        assert_eq!(
            context.annotate(failure).diagnostic.stage,
            Stage::Tokenization
        );
    }

    #[test]
    fn generic_bad_request_preserves_residency_but_auth_capacity_and_server_do_not() {
        let request = classify(400, br#"{"error":{"message":"unknown input error"}}"#);
        assert!(request.preserves_resident_runtime());
        assert!(!request.retryable);
        for (status, message) in [
            (401, "chat template inaccessible"),
            (400, "out of memory"),
            (500, "chat template out of memory"),
            (503, "server is busy"),
            (500, "internal error"),
            (501, "unsupported parameter"),
        ] {
            let failure = classify(
                status,
                &serde_json::to_vec(&json!({"error":{"message":message}})).unwrap(),
            );
            assert!(!failure.preserves_resident_runtime(), "{status}/{message}");
        }
        assert!(classify(
            500,
            br#"{"error":{"type":"chat_template_error","message":"Jinja invalid content"}}"#
        )
        .preserves_resident_runtime());
    }

    #[test]
    fn error_event_keeps_compatibility_fields_and_only_safe_diagnostic_keys() {
        let failure = classify(
            400,
            br#"{"error":{"param":"messages[12].content","message":"expected string SECRET"}}"#,
        );
        let context = Context::new();
        context.stage.set(Stage::Generation);
        context.input.set(Some(1234));
        context.context.set(Some(32768));
        context.output.set(Some(8192));
        let failure = context.annotate(failure);
        let event = super::super::LocalInferenceEvent::Error {
            request_id: "request-id".into(),
            code: failure.code.into(),
            retryable: failure.retryable,
            diagnostic: Some(failure.diagnostic),
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "error");
        assert_eq!(value["requestId"], "request-id");
        assert_eq!(value["code"], value["diagnostic"]["code"]);
        assert_eq!(value["diagnostic"]["parameter"], "messages.content");
        assert_eq!(value["diagnostic"]["reason"], "message_shape");
        assert_eq!(value["diagnostic"]["inputTokens"], 1234);
        let encoded = value["diagnostic"].to_string();
        assert!(
            !encoded.contains("SECRET")
                && !encoded.contains("request-id")
                && !encoded.contains("[12]")
        );
        let cancelled = super::super::LocalInferenceEvent::Error {
            request_id: "request-id".into(),
            code: "cancelled".into(),
            retryable: false,
            diagnostic: None,
        };
        assert!(serde_json::to_value(cancelled)
            .unwrap()
            .get("diagnostic")
            .is_none());
    }
}
