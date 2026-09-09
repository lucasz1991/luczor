//! Request-level reasoning limits for llama.cpp b10809 / 5266f24da.
//! `reasoning_budget_tokens` bounds each reasoning block, not the total answer.
//! Keep the native reasoning-output filter; `reasoning_format=none` would leak it.

use serde_json::{json, Value};

const MAX_REASONING_TOKENS: u64 = 512;
const PUBLIC_OUTPUT_RESERVE: u64 = 256;
const REASONING_END_RESERVE: u64 = 16;

/// Apply before every tokenizer request. The context fitter may reduce max_tokens
/// and must count that final body again before it is sent for inference.
pub(super) fn apply(body: &mut Value, mode: &str) -> Result<(), String> {
    if !matches!(mode, "auto" | "off") {
        return Err("Local reasoning mode is invalid.".into());
    }
    let payload = body
        .as_object_mut()
        .ok_or("Local inference body is invalid.")?;
    let max_output = payload
        .get("max_tokens")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= 16_384)
        .ok_or("Local output budget is invalid.")?;
    let budget = if mode == "off" {
        0
    } else {
        MAX_REASONING_TOKENS
            .min(max_output / 4)
            .min(max_output.saturating_sub(PUBLIC_OUTPUT_RESERVE + REASONING_END_RESERVE))
    };
    let kwargs = payload
        .get_mut("chat_template_kwargs")
        .and_then(Value::as_object_mut)
        .ok_or("Local chat-template parameters are invalid.")?;
    kwargs.insert("enable_thinking".into(), json!(budget > 0));
    payload.insert("reasoning_budget_tokens".into(), json!(budget));
    if budget == 0 {
        payload.insert("reasoning_effort".into(), json!("none"));
    } else {
        payload.remove("reasoning_effort");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(max_tokens: u64) -> Value {
        json!({
            "model": "local-fixture",
            "messages": [{"role":"user", "content":"Preserve complete current request"}],
            "tools": [{"type":"function", "function":{"name":"fixture_read"}}],
            "tool_choice": "auto",
            "max_tokens": max_tokens,
            "chat_template_kwargs": {"parse_tool_calls": true},
            "cache_prompt": false
        })
    }

    #[test]
    fn auto_leaves_public_output_reserve_with_the_supported_request_parameter() {
        for (max_output, expected) in [
            (256, 0),
            (272, 0),
            (300, 28),
            (768, 192),
            (2048, 512),
            (16_384, 512),
        ] {
            let mut request = body(max_output);
            let original = request.clone();
            apply(&mut request, "auto").unwrap();
            assert_eq!(request["reasoning_budget_tokens"], expected);
            assert_eq!(
                request["chat_template_kwargs"]["enable_thinking"],
                expected > 0
            );
            assert_eq!(request["max_tokens"], original["max_tokens"]);
            assert_eq!(request["messages"], original["messages"]);
            assert_eq!(request["tools"], original["tools"]);
            assert_eq!(request["tool_choice"], original["tool_choice"]);
            assert_eq!(request["chat_template_kwargs"]["parse_tool_calls"], true);
            assert!(request.get("reasoning_budget").is_none());
            assert!(request.get("reasoning_format").is_none());
            if expected > 0 {
                assert!(request.get("reasoning_effort").is_none());
                assert!(max_output - expected >= PUBLIC_OUTPUT_RESERVE + REASONING_END_RESERVE);
            } else {
                assert_eq!(request["reasoning_effort"], "none");
            }
        }
    }

    #[test]
    fn off_closes_reasoning_at_template_and_sampler_layers_without_more_output_tokens() {
        let mut request = body(2048);
        apply(&mut request, "auto").unwrap();
        apply(&mut request, "off").unwrap();
        assert_eq!(request["max_tokens"], 2048);
        assert_eq!(request["reasoning_effort"], "none");
        assert_eq!(request["reasoning_budget_tokens"], 0);
        assert_eq!(request["chat_template_kwargs"]["enable_thinking"], false);
        apply(&mut request, "auto").unwrap();
        assert_eq!(request["reasoning_budget_tokens"], 512);
        assert!(request.get("reasoning_effort").is_none());
    }

    #[test]
    fn final_context_reduction_is_counted_with_the_same_reasoning_contract_as_inference() {
        for remaining in [1032, 272] {
            let mut request = body(2048);
            let original = request.clone();
            let mut counted = Vec::new();
            let usage = super::super::context_budget::fit_context(
                &mut request,
                4096,
                |candidate| {
                    apply(candidate, "auto")?;
                    counted.push(candidate.clone());
                    Ok::<_, String>(4096 - remaining - 64)
                },
                || "Cannot fit".into(),
            )
            .unwrap();
            assert_eq!(usage.output_tokens, remaining);
            assert_eq!(counted.len(), 2);
            assert_eq!(counted.last(), Some(&request));
            assert_eq!(request["messages"], original["messages"]);
            assert_eq!(request["max_tokens"], remaining);
            assert_eq!(
                request["reasoning_budget_tokens"],
                if remaining == 1032 { 258 } else { 0 }
            );
            assert_eq!(
                request["chat_template_kwargs"]["enable_thinking"],
                remaining > 272
            );
        }
    }

    #[test]
    fn rejects_invalid_budget_or_mode_before_mutating_the_request() {
        for (max_tokens, mode) in [(0, "auto"), (16_385, "auto"), (2048, "unlimited")] {
            let mut request = body(max_tokens);
            let original = request.clone();
            assert!(apply(&mut request, mode).is_err());
            assert_eq!(request, original);
        }
    }

    #[test]
    fn changed_template_is_recounted_and_cannot_bypass_context_capacity() {
        let mut request = body(2048);
        let original_messages = request["messages"].clone();
        let mut calls = 0;
        let result = super::super::context_budget::fit_context(
            &mut request,
            4096,
            |candidate| {
                apply(candidate, "auto")?;
                calls += 1;
                Ok::<_, String>(
                    if candidate["chat_template_kwargs"]["enable_thinking"] == true {
                        3760
                    } else {
                        3800
                    },
                )
            },
            || "Cannot fit final template".into(),
        );
        assert_eq!(result.unwrap_err(), "Cannot fit final template");
        assert_eq!(calls, 2);
        assert_eq!(request["messages"], original_messages);
    }

    #[test]
    fn length_only_reasoning_sse_keeps_usage_without_exposing_private_text() {
        use std::sync::{Arc, Mutex};
        let request: super::super::LocalInferenceRequest = serde_json::from_value(json!({
            "requestId":"synthetic-round", "scopeDigest":"a".repeat(64),
            "modelReleaseId":"local-fixture", "useCase":"chat",
            "catalogBinding": {
                "acceptanceSessionId":"00000000-0000-4000-8000-000000000001",
                "acceptanceGeneration":1, "manifestPayloadSha256":"b".repeat(64)
            },
            "messages":[{"role":"user","content":"Public fixture"}], "tools":[],
            "toolChoice":"none", "maxOutputTokens":2048, "reasoningMode":"auto"
        }))
        .unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let channel = tauri::ipc::Channel::<super::super::LocalInferenceEvent>::new(move |event| {
            if let tauri::ipc::InvokeResponseBody::Json(event) = event {
                sink.lock().unwrap().push(event);
            }
            Ok(())
        });
        let stream = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({"choices":[{"delta":{"reasoning_content":"SYNTHETIC_PRIVATE_REASONING"}}]}),
            json!({"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":123,"completion_tokens":2048,"total_tokens":2171}}),
        );
        let result = super::super::parse_sse(
            std::io::Cursor::new(stream.into_bytes()),
            &request,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &channel,
        )
        .unwrap();
        assert_eq!(result.content, "");
        assert_eq!(result.finish_reason, "length");
        assert_eq!(result.usage.as_ref().unwrap().output_tokens, 2048);
        assert!(result.raw_tool_calls.is_empty());
        assert!(events.lock().unwrap().is_empty());
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("SYNTHETIC_PRIVATE_REASONING"));
    }
}
