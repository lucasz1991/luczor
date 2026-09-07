//! Adapt Luczor's layered instructions to templates with one leading system turn.
//! Only native local inference uses this copy; archives and approved egress stay intact.
use serde_json::{json, Value};

/// Defense for callers outside the agent loop: bad historical arguments must
/// not reach the llama.cpp template parser or be silently repaired for execution.
pub(super) fn valid_tool_arguments(messages: &[Value]) -> bool {
    messages.iter().all(|message| {
        if message["role"] != "assistant" {
            return true;
        }
        let Some(calls) = message.get("tool_calls") else {
            return true;
        };
        calls.as_array().is_some_and(|calls| {
            calls.iter().all(|call| {
                call["function"]["arguments"]
                    .as_str()
                    .and_then(|args| serde_json::from_str::<Value>(args).ok())
                    .is_some_and(|args| args.is_object())
            })
        })
    })
}

pub(super) fn normalize_system_messages(messages: &[Value]) -> Result<Vec<Value>, ()> {
    let mut instructions = Vec::new();
    let mut conversation = Vec::with_capacity(messages.len());
    for message in messages {
        if message["role"] == "system" {
            // The desktop wire contract is text. Never stringify unsupported
            // content or promote user/assistant/tool text into system authority.
            instructions.push(message["content"].as_str().ok_or(())?);
        } else {
            conversation.push(message.clone());
        }
    }
    if !instructions.is_empty() {
        conversation.insert(
            0,
            json!({"role": "system", "content": instructions.join("\n\n")}),
        );
    }
    Ok(conversation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_tool_arguments_are_rejected_before_template_rendering() {
        for args in ["{\"title\":", "{}{}", "null", "[]", "42", "\"text\"", ""] {
            let messages =
                vec![json!({"role":"assistant","tool_calls":[{"function":{"arguments":args}}]})];
            assert!(!valid_tool_arguments(&messages));
        }
        assert!(valid_tool_arguments(&[
            json!({"role":"user","content":"Request"}),
            json!({"role":"assistant","tool_calls":[{"function":{"arguments":"{\"status\":\"open\",\"title\":\"Valid\"}"}}]}),
            json!({"role":"tool","content":"untrusted {}{}"}),
        ]));
    }

    #[test]
    fn local_template_cases_preserve_content_and_tool_rounds() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/local-system-messages.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let input = case["messages"].as_array().unwrap();
            let original = input.clone();
            let normalized = normalize_system_messages(input).unwrap();
            assert_eq!(json!(normalized), case["expected"], "{}", case["name"]);
            assert_eq!(*input, original);
            assert_eq!(normalize_system_messages(&normalized).unwrap(), normalized);
            assert_eq!(
                normalized
                    .iter()
                    .filter(|m| m["role"] != "system")
                    .collect::<Vec<_>>(),
                input
                    .iter()
                    .filter(|m| m["role"] != "system")
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn unsupported_system_content_is_rejected_without_coercion() {
        for content in [Value::Null, json!({"text": "policy"}), json!(["policy"])] {
            assert!(
                normalize_system_messages(&[json!({"role":"system","content":content})]).is_err()
            );
        }
    }

    #[test]
    fn context_fitting_keeps_one_system_turn_and_the_current_tool_round() {
        let messages = vec![
            json!({"role":"system","content":"Policy"}),
            json!({"role":"user","content":"Old request"}),
            json!({"role":"assistant","content":"Old answer"}),
            json!({"role":"user","content":"Current request"}),
            json!({"role":"assistant","tool_calls":[{"id":"current-call"}],"content":""}),
            json!({"role":"system","content":"Retry instruction"}),
            json!({"role":"tool","tool_call_id":"current-call","content":"Current result"}),
        ];
        let normalized = normalize_system_messages(&messages).unwrap();
        let mut body =
            json!({"messages":normalized,"tools":[{"name":"read_file"}],"max_tokens":2048});
        let mut counts = 0;
        let usage = super::super::context_budget::fit_context(
            &mut body,
            32768,
            |candidate| {
                let turns = candidate["messages"].as_array().unwrap();
                assert_eq!(turns[0]["role"], "system");
                assert!(turns[1..].iter().all(|m| m["role"] != "system"));
                counts += 1;
                Ok::<_, ()>(if counts == 1 { 40000 } else { 1000 })
            },
            || (),
        )
        .unwrap();
        assert_eq!(usage.omitted_messages, 2);
        assert_eq!(
            body["messages"][0]["content"],
            "Policy\n\nRetry instruction"
        );
        assert_eq!(body["messages"][1], messages[3]);
        assert_eq!(body["messages"][2], messages[4]);
        assert_eq!(body["messages"][3], messages[6]);
        assert_eq!(body["tools"], json!([{"name":"read_file"}]));
    }
}
