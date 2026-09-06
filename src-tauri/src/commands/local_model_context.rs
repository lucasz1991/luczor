//! Fit complete conversation rounds to the actual local tokenizer. The archive,
//! current user request, system instructions and tool schemas are never rewritten.
use serde::Serialize;
use serde_json::{json, Value};

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

pub(super) fn fit_context<E>(
    body: &mut Value,
    context_tokens: u64,
    mut count: impl FnMut(&Value) -> Result<u64, E>,
    cannot_fit: impl Fn() -> E,
) -> Result<ContextUsage, E> {
    let requested_output = body["max_tokens"].as_u64().ok_or_else(&cannot_fit)?;
    let mut usage = ContextUsage {
        context_tokens,
        ..Default::default()
    };
    // At most 256 messages are admitted natively. Every pass removes a complete
    // old round or halves a tool result; the separate bound also caps tokenizer work.
    for _ in 0..272 {
        let input_tokens = count(body)?;
        let available = context_tokens.saturating_sub(input_tokens.saturating_add(64));
        if available >= requested_output {
            usage.input_tokens = input_tokens;
            usage.output_tokens = requested_output;
            return Ok(usage);
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
            body["max_tokens"] = json!(available.min(requested_output));
            usage.input_tokens = input_tokens;
            usage.output_tokens = available.min(requested_output);
            return Ok(usage);
        }
        return Err(cannot_fit());
    }
    Err(cannot_fit())
}

#[cfg(test)]
mod tests {
    use super::*;

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
