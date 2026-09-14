//! Generation safeguards, shared by every desktop platform. Never interpret
//! answer text as an executable tool call, or change a signed context allowance.
use serde_json::{json, Value};

pub(super) const REPETITION: &str = "Local generation interrupted after repeated output.";
pub(super) const TOOL_CONTRACT: &str = "Local generation returned an invalid tool completion.";

/// b10809's Qwen2.5 auto-parser can accept plain JSON as public content and
/// wander before the first required XML tool marker. For this verified 3B
/// artifact only, start a REQUIRED call at the template's tool boundary. The
/// runtime still produces/validates structured tool_calls; no reply is parsed
/// or executed here. Auto/none, other artifacts and other runtimes stay intact.
pub(super) fn apply_required_tool_prefix(
    body: &mut Value,
    artifact_hash: Option<&str>,
    props: &Value,
) {
    if artifact_hash != Some("d5c108dfbdac44c738e45a84d5624716cfb8522d1410f46a7108167ee4bd0cac")
        || props["build_info"].as_str() != Some("b10809-5266f24da")
        || body["tool_choice"].as_str() != Some("required")
        || !body["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty())
    {
        return;
    }
    let template = props["chat_template"].as_str().unwrap_or_default();
    if !template.contains("<tool_call>")
        || !template.contains("</tool_call>")
        || !template.contains("<|im_start|>")
    {
        return;
    }
    let Some(messages) = body["messages"].as_array_mut() else {
        return;
    };
    if !messages
        .last()
        .is_some_and(|m| matches!(m["role"].as_str(), Some("user" | "tool")))
    {
        return;
    }
    messages.push(json!({"role":"assistant", "content":"<tool_call>\n"}));
    body["continue_final_message"] = json!(true);
    body["add_generation_prompt"] = json!(false);
    body["parallel_tool_calls"] = json!(false);
    // The parser's parallel=false grammar still permits repetitions on this
    // build. End at the first completed call; full JSON/name validation remains
    // mandatory before dispatch. The marker is never shown in the chat.
    body["stop"] = json!(["</tool_call>"]);
}

#[cfg(test)]
mod prefix_tests {
    use super::*;
    const HASH: &str = "d5c108dfbdac44c738e45a84d5624716cfb8522d1410f46a7108167ee4bd0cac";
    fn props() -> Value {
        json!({"build_info":"b10809-5266f24da","chat_template":"<|im_start|> <tool_call> </tool_call>"})
    }
    fn request() -> Value {
        json!({"messages":[{"role":"system","content":"Policy"},{"role":"user","content":"Read project"}],"tools":[{"type":"function","function":{"name":"project_get_state","parameters":{"type":"object"}}}],"tool_choice":"required","max_tokens":2048})
    }
    #[test]
    fn prefix_is_scoped_idempotent_and_preserves_tools_arguments_and_limits() {
        let mut body = request();
        let original = body.clone();
        apply_required_tool_prefix(&mut body, Some(HASH), &props());
        assert_eq!(
            body["messages"][2],
            json!({"role":"assistant","content":"<tool_call>\n"})
        );
        assert_eq!(body["messages"][0], original["messages"][0]);
        assert_eq!(body["messages"][1], original["messages"][1]);
        assert_eq!(body["tools"], original["tools"]);
        assert_eq!(body["max_tokens"], original["max_tokens"]);
        assert_eq!(body["stop"], json!(["</tool_call>"]));
        let first = body.clone();
        apply_required_tool_prefix(&mut body, Some(HASH), &props());
        assert_eq!(body, first);
    }
    #[test]
    fn ordinary_answers_unknown_models_runtimes_and_templates_are_unchanged() {
        for choice in ["auto", "none"] {
            let mut body = request();
            body["tool_choice"] = json!(choice);
            let before = body.clone();
            apply_required_tool_prefix(&mut body, Some(HASH), &props());
            assert_eq!(body, before);
        }
        for (hash, metadata) in [
            (None, props()),
            (Some("other-model"), props()),
            (Some(HASH), Value::Null),
            (
                Some(HASH),
                json!({"build_info":"future","chat_template":"<|im_start|> <tool_call> </tool_call>"}),
            ),
            (
                Some(HASH),
                json!({"build_info":"b10809-5266f24da","chat_template":"different"}),
            ),
        ] {
            let mut body = request();
            let before = body.clone();
            apply_required_tool_prefix(&mut body, hash, &metadata);
            assert_eq!(body, before);
        }
        let mut body = request();
        body["tools"] = json!([]);
        let before = body.clone();
        apply_required_tool_prefix(&mut body, Some(HASH), &props());
        assert_eq!(body, before);
    }
}

/// Profiles bind to verified model bytes, not mutable display names or tier IDs.
/// Mild token penalties and long-sequence DRY leave normal code syntax reusable.
/// These are bounded starting profiles, not a promise of optimal model quality.
pub(super) fn apply_sampling(body: &mut Value, artifact_hash: Option<&str>) {
    let qwen25 = matches!(
        artifact_hash,
        Some(
            "d5c108dfbdac44c738e45a84d5624716cfb8522d1410f46a7108167ee4bd0cac"
                | "b19da8c6aacffdedc7bcd6b7f7d7d4db900f7d5c49f5473de18bb58111b432e5"
                | "75062a7ba3575573cc421a2cbafbf69fb48d0ecb28da2684b577eb609097fbe4"
                | "593e9be6fae0e8c4008bb279f6380154afea89aeed90d9e3f2130d0becc84908"
        )
    );
    let qwen35 =
        artifact_hash == Some("6c8c7658fe13eef22666aa89862f7fb70aa72109838cf19989e59b15875e5e08");
    // Unknown models keep their sampling distribution; the stream guard still applies.
    body["ignore_eos"] = json!(false);
    body["parse_tool_calls"] = json!(true);
    if !qwen25 && !qwen35 {
        return;
    }
    for (key, value) in json!({
        "temperature": if qwen35 { 0.6 } else { 0.7 },
        "top_p": if qwen35 { 0.95 } else { 0.8 },
        "top_k": 20, "min_p": 0.0,
        "repeat_penalty": 1.03, "repeat_last_n": 256,
        "presence_penalty": 0.0, "frequency_penalty": 0.0,
        "dry_multiplier": 0.4, "dry_allowed_length": 8,
        "dry_penalty_last_n": 1024
    })
    .as_object()
    .unwrap()
    {
        body[key] = value.clone();
    }
}

/// Bounded, chunk-independent suffix detection. Ignore fenced/indented code,
/// tables and structured syntax, and require sustained, exact prose repetition.
/// State is request-local and never serialized (also usable for private deltas).
#[derive(Default)]
pub(super) struct RepetitionGuard {
    tail: Vec<char>,
    fence: Option<char>,
    prefix: String,
    blocked_line: bool,
    leading: usize,
    ticks: usize,
    empty_run: usize,
}

impl RepetitionGuard {
    /// Byte offset up to which this chunk may be published before interruption.
    pub(super) fn observe(&mut self, chunk: &str) -> Option<usize> {
        for (offset, ch) in chunk.char_indices() {
            // A model may emit only blank lines/visible return marks while its
            // tool grammar refuses EOS. This is not useful progress either.
            if self.fence.is_none() && (ch.is_whitespace() || ch == '⏎') {
                self.empty_run += 1;
                if self.empty_run >= 512 {
                    return Some(offset);
                }
            } else {
                self.empty_run = 0;
            }
            if ch == '\r' {
                continue;
            }
            if ch == '\n' {
                if self.fence.is_none() && !self.blocked_line {
                    self.push(' ');
                }
                self.prefix.clear();
                self.leading = 0;
                self.blocked_line = false;
                continue;
            }
            if self.prefix.is_empty() && ch.is_whitespace() {
                self.leading += if ch == '\t' { 4 } else { 1 };
                if self.leading >= 4 {
                    self.blocked_line = true;
                    self.tail.clear();
                }
            }
            if !ch.is_whitespace() && self.prefix.chars().count() < 3 {
                self.prefix.push(ch);
                if self.prefix == "```" || self.prefix == "~~~" {
                    let marker = self.prefix.chars().next().unwrap();
                    if self.fence == Some(marker) {
                        self.fence = None;
                    } else if self.fence.is_none() {
                        self.fence = Some(marker);
                    }
                    self.blocked_line = true;
                    self.tail.clear();
                }
            }
            if self.fence.is_some() || self.blocked_line {
                continue;
            }
            if "`~{}[]<>=;|\\\"".contains(ch) {
                self.blocked_line = true;
                self.tail.clear();
                continue;
            }
            self.push(if ch.is_whitespace() { ' ' } else { ch });
            self.ticks += 1;
            if self.ticks >= 32 {
                self.ticks = 0;
                if self.repeated() {
                    return Some(offset);
                }
            }
        }
        None
    }

    fn push(&mut self, ch: char) {
        if ch == ' ' && self.tail.last() == Some(&' ') {
            return;
        }
        self.tail.push(ch);
        if self.tail.len() > 4096 {
            self.tail.drain(..1024);
        }
    }

    fn repeated(&self) -> bool {
        let n = self.tail.len();
        for period in 4..=512.min(n / 6) {
            let copies = 6.max(256_usize.div_ceil(period));
            let length = copies * period;
            if length > n {
                continue;
            }
            let pattern = &self.tail[n - period..];
            if !self.tail[n - length..n - period]
                .iter()
                .enumerate()
                .all(|(i, ch)| *ch == pattern[i % period])
            {
                continue;
            }
            if pattern.iter().filter(|c| c.is_alphabetic()).count() >= 3
                && pattern.iter().any(|c| matches!(c, ' ' | '.' | '!' | '?'))
            {
                return true;
            }
        }
        false
    }
}

pub(super) fn valid_tool_completion(
    choice: &str,
    definitions: &[Value],
    calls: &[super::NativeToolCall],
    finish: &str,
) -> bool {
    if (choice == "required" || finish == "tool_calls") && calls.is_empty() {
        return false;
    }
    if calls.is_empty() {
        return true;
    }
    if choice == "none" || !matches!(finish, "stop" | "tool_calls") {
        return false;
    }
    let mut ids = std::collections::HashSet::new();
    calls.iter().all(|call| {
        ids.insert(&call.id)
            && definitions.iter().any(|tool| {
                tool.pointer("/function/name").and_then(Value::as_str)
                    == Some(call.function.name.as_str())
            })
            && serde_json::from_str::<Value>(&call.function.arguments).is_ok_and(|v| v.is_object())
    })
}

/// Repeated identical calls in one streamed batch are never replayed. Comparison
/// uses parsed argument objects, so whitespace/key formatting cannot evade it.
pub(super) fn repeated_tool_batch(
    tools: &std::collections::BTreeMap<usize, (String, String, String)>,
) -> bool {
    let mut previous: Option<(&str, Value)> = None;
    let mut consecutive = 0;
    for (_, name, arguments) in tools.values() {
        let Ok(args) = serde_json::from_str::<Value>(arguments) else {
            continue;
        };
        if name.is_empty() || !args.is_object() {
            continue;
        }
        if previous
            .as_ref()
            .is_some_and(|(n, a)| *n == name && *a == args)
        {
            consecutive += 1;
        } else {
            consecutive = 1;
        }
        if consecutive >= 4 {
            return true;
        }
        previous = Some((name.as_str(), args));
    }
    false
}
