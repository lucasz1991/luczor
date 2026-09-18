//! Fit complete conversation rounds to the actual local tokenizer. The archive,
//! current user request, system instructions and tool schemas are never rewritten.
use serde::Serialize;
use serde_json::{json, Value};

/// Grow only for measured input plus a small public-answer reserve. Thinking
/// presets never determine the allocation. The signed runtime ceiling is final.
pub(super) fn growth_target(current: u32, ceiling: u32, input: u64) -> Option<u32> {
    let needed = input.checked_add(2048 + 64)?;
    if needed <= u64::from(current) || current >= ceiling {
        return None;
    }
    // Even a transcript larger than the ceiling can benefit from growth:
    // fitting can then retain more complete rounds within the real limit.
    let needed = needed.min(u64::from(ceiling));
    // Allocate in small aligned steps instead of doubling an already large KV
    // cache. The signed maximum remains available without reserving it early.
    Some((needed.div_ceil(4096) * 4096).min(u64::from(ceiling)) as u32)
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ContextUsage {
    pub input_tokens: u64,
    pub context_tokens: u64,
    pub output_tokens: u64,
    pub omitted_messages: usize,
    pub shortened_tool_results: usize,
}

/// Remove an entire old user round, including its assistant/tool pairs. Keep
/// every system message even when it occurs between ordinary conversation turns.
fn remove_oldest_round(messages: &mut Vec<Value>) -> usize {
    let user_positions: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message["role"] == "user")
        .map(|(index, _)| index)
        .collect();
    if user_positions.len() < 2 {
        return 0;
    }
    let start = user_positions[0];
    let end = user_positions[1];
    let before = messages.len();
    let mut index = 0;
    messages.retain(|message| {
        let keep = index < start || index >= end || message["role"] == "system";
        index += 1;
        keep
    });
    before - messages.len()
}

#[cfg(test)]
pub(super) fn fit_context<E>(
    body: &mut Value,
    context_tokens: u64,
    count: impl FnMut(&mut Value) -> Result<u64, E>,
    cannot_fit: impl Fn() -> E,
) -> Result<ContextUsage, E> {
    fit(body, context_tokens, count, cannot_fit, false, None)
}

/// Optional future thinking headroom must never evict usable history. First
/// shrink output to the available context, keeping the existing answer minimum.
pub(super) fn fit_adaptive_context<E>(
    body: &mut Value,
    context_tokens: u64,
    count: impl FnMut(&mut Value) -> Result<u64, E>,
    cannot_fit: impl Fn() -> E,
) -> Result<ContextUsage, E> {
    fit_adaptive_context_with_ingress(body, context_tokens, count, cannot_fit, None)
}

pub(super) fn fit_adaptive_context_with_ingress<E>(
    body: &mut Value,
    context_tokens: u64,
    count: impl FnMut(&mut Value) -> Result<u64, E>,
    cannot_fit: impl Fn() -> E,
    input_target: Option<u64>,
) -> Result<ContextUsage, E> {
    fit(body, context_tokens, count, cannot_fit, true, input_target)
}

/// Compact models receive a deliberately smaller ingress package. It keeps the
/// complete current request and policy intact, but sheds older rounds before
/// they consume the working context needed for an answer or tool result.
#[cfg(test)]
pub(super) fn fit_compact_context<E>(
    body: &mut Value,
    context_tokens: u64,
    count: impl FnMut(&mut Value) -> Result<u64, E>,
    cannot_fit: impl Fn() -> E,
) -> Result<ContextUsage, E> {
    // Half the window is a ceiling for injected history, memories and prior
    // tool results. The remainder remains available for a useful public reply.
    fit_adaptive_context_with_ingress(
        body,
        context_tokens,
        count,
        cannot_fit,
        Some((context_tokens / 2).max(1024)),
    )
}

fn fit<E>(
    body: &mut Value,
    context_tokens: u64,
    mut count: impl FnMut(&mut Value) -> Result<u64, E>,
    cannot_fit: impl Fn() -> E,
    prefer_history: bool,
    input_target: Option<u64>,
) -> Result<ContextUsage, E> {
    let mut requested_output = body["max_tokens"].as_u64().ok_or_else(&cannot_fit)?;
    let mut usage = ContextUsage {
        context_tokens,
        ..Default::default()
    };
    // At most 256 messages are admitted natively. Each continued pass removes a
    // complete old round or reduces the output reservation;
    // the separate bound also caps tokenizer work.
    for _ in 0..272 {
        let input_tokens = count(body)?;
        if input_target.is_some_and(|target| input_tokens > target) {
            let messages = body["messages"].as_array_mut().ok_or_else(&cannot_fit)?;
            let removed = remove_oldest_round(messages);
            if removed > 0 {
                usage.omitted_messages += removed;
                continue;
            }
        }
        let available = context_tokens.saturating_sub(input_tokens.saturating_add(64));
        if available >= requested_output {
            usage.input_tokens = input_tokens;
            usage.output_tokens = requested_output;
            return Ok(usage);
        }
        if prefer_history && available >= requested_output.min(256) {
            requested_output = available;
            body["max_tokens"] = json!(requested_output);
            continue;
        }
        let messages = body["messages"].as_array_mut().ok_or_else(&cannot_fit)?;
        let removed = remove_oldest_round(messages);
        if removed > 0 {
            usage.omitted_messages += removed;
            continue;
        }
        // Never splice tool JSON/text to force a fit. Paths, escapes, evidence
        // and restrictions remain intact; an unfit current round is explicit.
        // Keep the complete current request. When it fits, use the remaining
        // answer space rather than rejecting because of a fixed output default.
        if available >= requested_output.min(256) {
            requested_output = available.min(requested_output);
            body["max_tokens"] = json!(requested_output);
            // Recount the final body: output-dependent template controls may
            // change when the remaining answer budget disables reasoning.
            continue;
        }
        return Err(cannot_fit());
    }
    Err(cannot_fit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn growth_is_demand_driven_bounded_and_not_an_output_target() {
        assert_eq!(growth_target(32768, 262144, 14000), None);
        assert_eq!(growth_target(32768, 262144, 31000), Some(36864));
        assert_eq!(growth_target(65536, 262144, 70000), Some(73728));
        assert_eq!(growth_target(16384, 32768, 17000), Some(20480));
        assert_eq!(growth_target(32768, 32768, 32000), None);
        assert_eq!(growth_target(32768, 262144, 262144), Some(262144));
        assert_eq!(growth_target(32768, 262144, u64::MAX), None);
    }

    #[test]
    fn five_tiers_fit_reported_20124_input_without_artificial_ingress_limit() {
        for (start, ceiling) in [
            (4096, 32768),
            (4096, 32768),
            (4096, 32768),
            (8192, 262144),
            (4096, 32768),
        ] {
            let target = growth_target(start, ceiling, 20124).unwrap();
            assert_eq!(target, 24576);
            let mut body = json!({"max_tokens":8256,"messages":[
                {"role":"system","content":"policy"},
                {"role":"user","content":"complete current request"}
            ]});
            let original = body["messages"].clone();
            let usage =
                fit_adaptive_context(&mut body, target.into(), |_| Ok::<_, ()>(20124), || ())
                    .unwrap();
            assert_eq!(usage.output_tokens, 4388);
            assert_eq!(usage.omitted_messages, 0);
            assert_eq!(body["messages"], original);
            assert!(usage.input_tokens + usage.output_tokens + 64 <= usage.context_tokens);
        }
    }

    #[test]
    fn adaptive_headroom_preserves_existing_rounds_and_clamps_ultra_to_real_context() {
        let mut body = json!({"max_tokens":81984,"messages":[{"role":"user","content":"old"},
            {"role":"assistant","content":"existing answer"},{"role":"user","content":"current"}],"chat_template_kwargs":{}});
        let history = body["messages"].clone();
        let plan = super::super::reasoning_budget::Plan::new(
            super::super::reasoning_budget::ThinkingTier::Ultra,
            None,
            "auto",
            None,
            true,
        )
        .unwrap();
        let mut counts = 0;
        let usage = fit_adaptive_context(
            &mut body,
            32768,
            |candidate| {
                plan.apply(candidate)?;
                counts += 1;
                Ok::<u64, String>(10000)
            },
            || "does not fit".to_string(),
        )
        .unwrap();
        assert_eq!(usage.output_tokens, 22704);
        assert_eq!(usage.omitted_messages, 0);
        assert_eq!(body["messages"], history);
        assert_eq!(body["reasoning_budget_tokens"], 18112);
        assert_eq!(counts, 2);
        assert!(usage.input_tokens + usage.output_tokens + 64 <= usage.context_tokens);
    }

    #[test]
    fn adaptive_fit_reserves_only_public_answer_when_available_space_is_tiny() {
        let mut body = json!({"max_tokens":81984,"messages":[{"role":"user","content":"current"}],"chat_template_kwargs":{}});
        let plan = super::super::reasoning_budget::Plan::new(
            super::super::reasoning_budget::ThinkingTier::Ultra,
            None,
            "auto",
            None,
            true,
        )
        .unwrap();
        let usage = fit_adaptive_context(
            &mut body,
            32768,
            |candidate| {
                plan.apply(candidate)?;
                Ok::<u64, String>(32448)
            },
            || "does not fit".to_string(),
        )
        .unwrap();
        assert_eq!(usage.output_tokens, 256);
        assert_eq!(body["reasoning_effort"], "none");
        assert_eq!(body["reasoning_budget_tokens"], 0);
    }

    #[test]
    fn ultra_with_22207_input_preserves_thinking_and_answer_without_context_growth() {
        use super::super::reasoning_budget::{Plan, Session, ThinkingTier};
        for live in [false, true] {
            let plan = Plan::new(ThinkingTier::Ultra, None, "auto", None, live).unwrap();
            let mut body = json!({"max_tokens": plan.output_ceiling,
                "messages":[{"role":"user","content":"Current public request"}],
                "model":"same-model", "chat_template_kwargs":{}});
            let original_messages = body["messages"].clone();
            let usage = fit_adaptive_context(
                &mut body,
                32768,
                |candidate| {
                    plan.apply(candidate)?;
                    Ok::<u64, String>(22207)
                },
                || "does not fit".to_string(),
            )
            .unwrap();
            let mut session = Session::new("ultra-fit", &plan, usage.output_tokens as u32, 7);
            let progress = session.snapshot();
            assert_eq!(usage.output_tokens, 10497);
            assert_eq!(body["reasoning_budget_tokens"], 8347);
            assert_eq!(body["chat_template_kwargs"]["enable_thinking"], true);
            assert_eq!(progress.soft_target_tokens, 8192);
            assert_eq!(progress.thinking_limit_tokens, 8347);
            assert_eq!(progress.response_reserve_tokens, 2086);
            assert_eq!(progress.output_limit_tokens, 10497);
            assert_eq!(progress.requested_thinking_limit_tokens, 65536);
            assert_eq!(
                usage.input_tokens + usage.output_tokens + 64,
                usage.context_tokens
            );
            assert_eq!(usage.omitted_messages, 0);
            assert_eq!(body["messages"], original_messages);
            assert_eq!(body["model"], "same-model");
            assert_eq!(growth_target(32768, 262144, usage.input_tokens), None);
            let metadata = serde_json::to_string(&progress).unwrap();
            assert!(!metadata.contains("Current public request"));
            assert!(!metadata.contains("reasoning_content"));
        }
    }

    #[test]
    fn laptop_fast_fit_recounts_the_exact_final_generation_body() {
        use super::super::reasoning_budget::{runtime_limits, Plan, Session, ThinkingTier};
        let props = json!({
            "default_generation_settings": {"n_ctx": 32768},
            "total_slots": 1,
            "build_info": "b10809-5266f24da",
            "chat_template": "<think> ... </think>"
        });
        let (context, live) = runtime_limits(&props, 131072);
        let plan = Plan::new(ThinkingTier::Fast, None, "auto", None, live).unwrap();
        let mut body = json!({
            "model": "laptop-fixture", "max_tokens": plan.output_ceiling,
            "messages": [{"role": "system", "content": "Keep project permissions."},
                {"role": "user", "content": "Read the current project state."}],
            "tools": [{"type": "function", "function": {"name": "project_get_state",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": false}}}],
            "tool_choice": "auto", "stream": true,
            "stream_options": {"include_usage": true}, "cache_prompt": true,
            "chat_template_kwargs": {"parse_tool_calls": true}
        });
        let original_messages = body["messages"].clone();
        let original_tools = body["tools"].clone();
        let mut counted_bodies = Vec::new();
        let usage = fit_adaptive_context_with_ingress(
            &mut body,
            u64::from(context),
            |candidate| {
                plan.apply(candidate)?;
                counted_bodies.push(serde_json::to_vec(candidate).unwrap());
                // A template may change its token count after output controls
                // change. Never authorize the second body using the first count.
                Ok::<u64, String>(if counted_bodies.len() == 1 {
                    19200
                } else {
                    19263
                })
            },
            || "does not fit".to_string(),
            Some(u64::from(context / 2)),
        )
        .unwrap();
        let mut session = Session::new("laptop-fit", &plan, usage.output_tokens as u32, 7);
        let progress = session.snapshot();
        let generation_body = serde_json::to_vec(&body).unwrap();
        assert_eq!(counted_bodies.len(), 3);
        assert_ne!(counted_bodies[0], generation_body);
        assert_ne!(counted_bodies[1], generation_body);
        assert_eq!(counted_bodies.last().unwrap(), &generation_body);
        assert_eq!(usage.input_tokens, 19263);
        assert_eq!(usage.output_tokens, 13441);
        assert_eq!(usage.input_tokens + usage.output_tokens + 64, 32768);
        assert_eq!(body["max_tokens"], 13441);
        assert_eq!(progress.output_limit_tokens, 13441);
        assert_eq!(progress.soft_target_tokens, 512);
        assert_eq!(progress.thinking_limit_tokens, 4096);
        assert_eq!(body["messages"], original_messages);
        assert_eq!(body["tools"], original_tools);
        assert_eq!(usage.omitted_messages, 0);
        assert_eq!(growth_target(context, 131072, usage.input_tokens), None);
    }

    #[test]
    fn compact_fit_removes_old_rounds_before_reducing_answer_headroom() {
        let mut body = json!({"max_tokens": 2048, "messages": [
            {"role":"system","content":"policy"},
            {"role":"user","content":"old request"},
            {"role":"assistant","content":"old answer"},
            {"role":"user","content":"current request"}
        ]});
        let usage = fit_compact_context(
            &mut body,
            8192,
            |candidate| Ok::<_, ()>(candidate["messages"].as_array().unwrap().len() as u64 * 1600),
            || (),
        )
        .unwrap();
        assert_eq!(usage.input_tokens, 3200);
        assert_eq!(usage.output_tokens, 2048);
        assert_eq!(usage.omitted_messages, 2);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "current request");
    }

    #[test]
    fn counts_template_and_tools_and_reserves_answer_space() {
        let mut body = json!({"messages":[{"role":"user","content":"current"}],"tools":[{"name":"unchanged"}],"max_tokens":2048});
        let original = body.clone();
        let usage = fit_context(
            &mut body,
            8192,
            |body| {
                assert_eq!(body, &original);
                Ok::<_, &str>(2000)
            },
            || "too large",
        )
        .unwrap();
        assert_eq!(usage.input_tokens, 2000);
        assert_eq!(usage.output_tokens, 2048);
        assert_eq!(usage.omitted_messages, 0);
        assert_eq!(body, original);
    }

    #[test]
    fn removes_whole_old_tool_round_but_preserves_policy_and_current_round() {
        let mut body = json!({"messages":[
            {"role":"system","content":"policy"},
            {"role":"user","content":"old"},
            {"role":"assistant","content":"","tool_calls":[{"id":"old-call"}]},
            {"role":"system","content":"updated policy"},
            {"role":"tool","tool_call_id":"old-call","content":"result"},
            {"role":"user","content":"current"},
            {"role":"assistant","tool_calls":[{"id":"current-call"}]},
            {"role":"tool","tool_call_id":"current-call","content":"result"}
        ],"tools":[{"name":"unchanged"}],"max_tokens":1000});
        let original = body.clone();
        let usage = fit_context(
            &mut body,
            8192,
            |body| Ok::<_, &str>(body["messages"].as_array().unwrap().len() as u64 * 1000),
            || "too large",
        )
        .unwrap();
        assert_eq!(usage.omitted_messages, 3);
        assert_eq!(
            body["messages"],
            json!([
                original["messages"][0],
                original["messages"][3],
                original["messages"][5],
                original["messages"][6],
                original["messages"][7]
            ])
        );
        assert_eq!(body["tools"], original["tools"]);
    }

    #[test]
    fn reduces_output_reservation_without_cutting_current_user_request() {
        let mut body = json!({"messages":[{"role":"user","content":"complete"}],"max_tokens":2048});
        let usage = fit_context(&mut body, 4096, |_| Ok::<_, &str>(3000), || "too large").unwrap();
        assert_eq!(usage.output_tokens, 1032);
        assert_eq!(body["messages"][0]["content"], "complete");
    }

    #[test]
    fn unfit_current_request_is_explicit_and_tokenizer_errors_are_not_ignored() {
        let mut body = json!({"messages":[{"role":"system","content":"policy"},{"role":"user","content":"complete"}],"max_tokens":2048});
        let original = body.clone();
        assert_eq!(
            fit_context(&mut body, 8192, |_| Ok::<_, &str>(9000), || "too large").unwrap_err(),
            "too large"
        );
        assert_eq!(body, original);
        assert_eq!(
            fit_context(
                &mut body,
                8192,
                |_| Err::<u64, _>("tokenizer failed"),
                || "too large"
            )
            .unwrap_err(),
            "tokenizer failed"
        );
    }

    #[test]
    fn unfit_current_tool_result_is_rejected_without_cutting_any_evidence() {
        let mut body = json!({"messages":[{"role":"user","content":"current"},{"role":"assistant","tool_calls":[{"id":"call"}]},{"role":"tool","tool_call_id":"call","content":"🙂ä".repeat(8000)}],"max_tokens":1000});
        let original = body.clone();
        let result = fit_context(
            &mut body,
            8192,
            |body| {
                Ok::<_, &str>(
                    body["messages"][2]["content"]
                        .as_str()
                        .unwrap()
                        .chars()
                        .count() as u64,
                )
            },
            || "too large",
        );
        assert_eq!(result.unwrap_err(), "too large");
        assert_eq!(body, original);
    }

    #[test]
    fn complete_tool_json_survives_soft_ingress_limits_and_transport() {
        let output = json!({"path":"/projekte/luczor","windows":r"E:\projekte\luczor","unicode":"src/e\u{301}📁.rs","text":"line\r\n".repeat(2500)}).to_string();
        let mut body = json!({"messages":[{"role":"user","content":"current"},{"role":"assistant","tool_calls":[{"id":"call","function":{"name":"fs_read","arguments":"{\"path\":\"src/é📁.rs\"}"}}]},{"role":"tool","tool_call_id":"call","content":output}],"max_tokens":1000});
        let original = body["messages"].clone();
        let usage = fit_adaptive_context_with_ingress(
            &mut body,
            8192,
            |_| Ok::<_, &str>(6000),
            || "too large",
            Some(2048),
        )
        .unwrap();
        assert_eq!(body["messages"], original);
        assert_eq!(usage.shortened_tool_results, 0);
        let transported: Value = serde_json::from_str(&body.to_string()).unwrap();
        let receipt: Value =
            serde_json::from_str(transported["messages"][2]["content"].as_str().unwrap()).unwrap();
        assert_eq!(receipt["path"], "/projekte/luczor");
        assert_eq!(receipt["windows"], r"E:\projekte\luczor");
        assert_eq!(receipt["unicode"], "src/e\u{301}📁.rs");
    }
}
