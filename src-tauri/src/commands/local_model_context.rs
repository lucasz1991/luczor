//! Fit complete conversation rounds to the actual local tokenizer. The archive,
//! current user request, system instructions and tool schemas are never rewritten.
use serde::Serialize;
use serde_json::{json, Value};

/// Grow only for measured input plus a small public-answer reserve. Thinking
/// presets never determine the allocation. The signed runtime ceiling is final.
pub(super) fn growth_target(current: u32, ceiling: u32, input: u64) -> Option<u32> {
    let needed = input.checked_add(2048 + 64)?;
    if needed <= u64::from(current) || current >= ceiling || needed > u64::from(ceiling) {
        return None;
    }
    let mut target = current.max(1);
    while u64::from(target) < needed {
        target = target.saturating_mul(2).min(ceiling);
    }
    Some(target)
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

fn shorten_tool_result(messages: &mut [Value]) -> bool {
    let candidate = messages
        .iter_mut()
        .filter(|message| message["role"] == "tool")
        .filter(|message| {
            message["content"]
                .as_str()
                .is_some_and(|text| text.chars().count() > 2048)
        })
        .max_by_key(|message| message["content"].as_str().map_or(0, str::len));
    let Some(message) = candidate else {
        return false;
    };
    let text = message["content"].as_str().unwrap();
    let chars: Vec<char> = text.chars().collect();
    let keep = (chars.len() / 4).max(512);
    message["content"] = json!(format!("{}\n[Lokale Kontextverwaltung: Werkzeugausgabe gekürzt; fehlende Abschnitte bei Bedarf gezielt erneut lesen.]\n{}",
        chars[..keep].iter().collect::<String>(), chars[chars.len()-keep..].iter().collect::<String>()));
    true
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
    // complete old round, halves a tool result, or reduces the output reservation;
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
            if shorten_tool_result(messages) {
                usage.shortened_tool_results += 1;
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
        if shorten_tool_result(messages) {
            usage.shortened_tool_results += 1;
            continue;
        }
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
        assert_eq!(growth_target(32768, 262144, 31000), Some(65536));
        assert_eq!(growth_target(65536, 262144, 70000), Some(131072));
        assert_eq!(growth_target(16384, 32768, 17000), Some(32768));
        assert_eq!(growth_target(32768, 32768, 32000), None);
        assert_eq!(growth_target(32768, 262144, 262144), None);
        assert_eq!(growth_target(32768, 262144, u64::MAX), None);
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
        assert_eq!(body["reasoning_budget_tokens"], 22704 - 16384 - 64);
        assert_eq!(counts, 2);
        assert!(usage.input_tokens + usage.output_tokens + 64 <= usage.context_tokens);
    }

    #[test]
    fn adaptive_fit_reduces_answer_only_when_thinking_no_longer_fits() {
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
                Ok::<u64, String>(32000)
            },
            || "does not fit".to_string(),
        )
        .unwrap();
        assert_eq!(usage.output_tokens, 704);
        assert_eq!(body["reasoning_effort"], "none");
        assert_eq!(body["reasoning_budget_tokens"], 0);
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
    fn large_unicode_tool_result_keeps_call_identity_and_marks_missing_data() {
        let mut body = json!({"messages":[{"role":"user","content":"current"},{"role":"assistant","tool_calls":[{"id":"call"}]},{"role":"tool","tool_call_id":"call","content":"🙂ä".repeat(8000)}],"max_tokens":1000});
        let usage = fit_context(
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
        )
        .unwrap();
        assert!(usage.shortened_tool_results > 0);
        assert_eq!(body["messages"][2]["tool_call_id"], "call");
        assert!(body["messages"][2]["content"]
            .as_str()
            .unwrap()
            .contains("Werkzeugausgabe gekürzt"));
        assert_eq!(body["messages"][0]["content"], "current");
    }
}
