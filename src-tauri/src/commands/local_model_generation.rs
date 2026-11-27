//! Generation safeguards, shared by every desktop platform. Never interpret
//! answer text as an executable tool call, or change a signed context allowance.
use serde_json::{json, Value};
use std::io::Read;

pub(super) const REPETITION: &str = "Local generation interrupted after repeated output.";
pub(super) const TOOL_CONTRACT: &str = "Local generation returned an invalid tool completion.";

/// b10809's chat parser accepts plain prose or JSON as public content and can
/// wander before the first required XML tool marker. Measured on this runtime
/// with long conversations, the stage 2 and 3 models answered every forced call
/// with prose (up to the 4096-character guard or the output limit); started at
/// the template's call boundary they produced a valid call every time. So every
/// template with the ChatML `<tool_call>` format starts a REQUIRED call there.
/// The runtime still produces/validates structured tool_calls; no reply is
/// parsed or executed here. Auto/none, other templates and other runtimes stay
/// intact. Returns whether the request was changed.
pub(super) fn apply_required_tool_prefix(body: &mut Value, props: &Value) -> bool {
    if props["build_info"].as_str() != Some("b10809-5266f24da")
        || body["tool_choice"].as_str() != Some("required")
        || body["tools"]
            .as_array()
            .is_none_or(|tools| tools.is_empty())
    {
        return false;
    }
    let template = props["chat_template"].as_str().unwrap_or_default();
    if !template.contains("<tool_call>")
        || !template.contains("</tool_call>")
        || !template.contains("<|im_start|>")
    {
        return false;
    }
    let Some(messages) = body["messages"].as_array_mut() else {
        return false;
    };
    if !messages
        .iter()
        .rev()
        // Agent repairs append a system instruction after the user/tool turn.
        // Preserve it, but do not let it suppress the required-call boundary.
        .find(|m| m["role"].as_str() != Some("system"))
        .is_some_and(|m| matches!(m["role"].as_str(), Some("user" | "tool")))
    {
        return false;
    }
    messages.push(json!({"role":"assistant", "content":"<tool_call>\n"}));
    body["continue_final_message"] = json!(true);
    body["add_generation_prompt"] = json!(false);
    body["parallel_tool_calls"] = json!(false);
    // JSON layout: the parser's parallel=false grammar still permits repetitions
    // on this build, so end at the first completed call. A raw line feed cannot
    // occur inside a JSON string, so "\n</tool_call>" only matches after the call
    // object closed; the literal text inside an argument (a file that documents
    // tool calls) stays intact. The XML `<function=…>` layout carries raw
    // parameter values and is parsed only with its closing tags, so it gets no
    // stop; the runtime ends that call itself. Full validation before dispatch
    // remains mandatory. The marker is never shown in the chat.
    if !template.contains("<function=") {
        body["stop"] = json!(["\n</tool_call>"]);
    }
    true
}

/// ChatML turns plus the Qwen2.5 tool section (`<tool_call>` / `<tool_response>`).
pub(super) const CHATML_TOOL_TEMPLATE: &str = include_str!("local_model_chatml_tools.jinja");
/// Changes the prompt layout, so it is part of the slot-cache identity.
pub(super) const CHATML_TOOL_TEMPLATE_ID: &str = "chatml-tools-v1";

/// Some ChatML models (Dolphin 3.0) embed a template that renders only message
/// text: tool definitions, calls and results never reach the model and b10809
/// does not fill the gap, so no structured call can ever be produced. Such a
/// model is started with the same ChatML turns plus the tool section above.
/// Templates that already describe tools are never replaced.
pub(super) fn needs_chatml_tool_template(embedded: &str) -> bool {
    embedded.contains("<|im_start|>")
        && embedded.contains("<|im_end|>")
        && !embedded.contains("tools")
        && !embedded.contains("tool_call")
}

/// Bounded read of `tokenizer.chat_template` from the verified GGUF header.
/// Any unexpected structure returns None, which keeps the embedded template.
pub(super) fn gguf_chat_template(reader: &mut impl Read) -> Option<String> {
    const MAX_STRING: u64 = 1 << 20;
    fn number<const N: usize>(r: &mut impl Read) -> Option<[u8; N]> {
        let mut bytes = [0; N];
        r.read_exact(&mut bytes).ok()?;
        Some(bytes)
    }
    fn string(r: &mut impl Read) -> Option<String> {
        let len = u64::from_le_bytes(number(r)?);
        if len > MAX_STRING {
            return None;
        }
        let mut value = vec![0; len as usize];
        r.read_exact(&mut value).ok()?;
        String::from_utf8(value).ok()
    }
    fn discard(r: &mut impl Read, len: u64) -> Option<()> {
        (std::io::copy(&mut r.take(len), &mut std::io::sink()).ok()? == len).then_some(())
    }
    fn fixed(kind: u32) -> Option<u64> {
        match kind {
            0 | 1 | 7 => Some(1),
            2 | 3 => Some(2),
            4..=6 => Some(4),
            10..=12 => Some(8),
            _ => None,
        }
    }
    fn skip(r: &mut impl Read, kind: u32, depth: u8) -> Option<()> {
        if let Some(bytes) = fixed(kind) {
            return discard(r, bytes);
        }
        match kind {
            8 => {
                let len = u64::from_le_bytes(number(r)?);
                if len > MAX_STRING {
                    return None;
                }
                discard(r, len)
            }
            9 if depth < 4 => {
                let item = u32::from_le_bytes(number(r)?);
                let count = u64::from_le_bytes(number(r)?);
                if count > 4_000_000 {
                    return None;
                }
                if let Some(bytes) = fixed(item) {
                    return discard(r, bytes.checked_mul(count)?);
                }
                for _ in 0..count {
                    skip(r, item, depth + 1)?;
                }
                Some(())
            }
            _ => None,
        }
    }
    if number::<4>(reader)? != *b"GGUF" || !matches!(u32::from_le_bytes(number(reader)?), 2 | 3) {
        return None;
    }
    let _tensors = u64::from_le_bytes(number(reader)?);
    let count = u64::from_le_bytes(number(reader)?);
    if count > 100_000 {
        return None;
    }
    for _ in 0..count {
        let key = string(reader)?;
        let kind = u32::from_le_bytes(number(reader)?);
        if key == "tokenizer.chat_template" && kind == 8 {
            return string(reader);
        }
        skip(reader, kind, 0)?;
    }
    None
}

#[cfg(test)]
mod template_tests {
    use super::*;

    fn gguf(entries: &[(&str, u32, Vec<u8>)]) -> Vec<u8> {
        let mut bytes = b"GGUF".to_vec();
        bytes.extend(3u32.to_le_bytes());
        bytes.extend(0u64.to_le_bytes());
        bytes.extend((entries.len() as u64).to_le_bytes());
        for (key, kind, value) in entries {
            bytes.extend((key.len() as u64).to_le_bytes());
            bytes.extend(key.as_bytes());
            bytes.extend(kind.to_le_bytes());
            bytes.extend(value);
        }
        bytes
    }
    fn text(value: &str) -> Vec<u8> {
        let mut bytes = (value.len() as u64).to_le_bytes().to_vec();
        bytes.extend(value.as_bytes());
        bytes
    }
    const DOLPHIN: &str = "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\n' + message['content'] + '<|im_end|>' + '\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\n' }}{% endif %}";

    #[test]
    fn reads_the_template_after_string_and_numeric_arrays() {
        let mut tokens = 8u32.to_le_bytes().to_vec(); // array item type: string
        tokens.extend(3u64.to_le_bytes());
        for token in ["a", "<|im_start|>", "b"] {
            tokens.extend(text(token));
        }
        let mut types = 5u32.to_le_bytes().to_vec(); // array item type: i32
        types.extend(3u64.to_le_bytes());
        types.extend([0u8; 12]);
        let bytes = gguf(&[
            ("general.architecture", 8, text("llama")),
            ("llama.context_length", 4, 131072u32.to_le_bytes().to_vec()),
            ("tokenizer.ggml.tokens", 9, tokens),
            ("tokenizer.ggml.token_type", 9, types),
            ("tokenizer.chat_template", 8, text(DOLPHIN)),
        ]);
        assert_eq!(
            gguf_chat_template(&mut bytes.as_slice()).as_deref(),
            Some(DOLPHIN)
        );
    }

    #[test]
    fn malformed_or_missing_metadata_keeps_the_embedded_template() {
        assert_eq!(gguf_chat_template(&mut b"GGML".as_slice()), None);
        let bytes = gguf(&[("general.architecture", 8, text("llama"))]);
        assert_eq!(gguf_chat_template(&mut bytes.as_slice()), None);
        let truncated = gguf(&[("tokenizer.chat_template", 8, text(DOLPHIN))]);
        assert_eq!(
            gguf_chat_template(&mut &truncated[..truncated.len() - 4]),
            None
        );
        let unknown_kind = gguf(&[
            ("odd", 99, vec![]),
            ("tokenizer.chat_template", 8, text(DOLPHIN)),
        ]);
        assert_eq!(gguf_chat_template(&mut unknown_kind.as_slice()), None);
    }

    /// Manual check against installed model files:
    /// `LUCZOR_GGUF_TEMPLATE_PROBE="<needs override>.gguf;<keeps template>.gguf" cargo test -- --ignored`
    #[test]
    #[ignore]
    fn probe_installed_model_templates() {
        let probe = std::env::var("LUCZOR_GGUF_TEMPLATE_PROBE").expect("probe paths");
        let paths: Vec<&str> = probe.split(';').collect();
        let decision = |path: &str| {
            let file = std::fs::File::open(path).expect("model file");
            let template =
                gguf_chat_template(&mut std::io::BufReader::new(file.take(64 * 1024 * 1024)))
                    .expect("embedded template");
            needs_chatml_tool_template(&template)
        };
        assert!(
            decision(paths[0]),
            "{} should get the tool template",
            paths[0]
        );
        assert!(!decision(paths[1]), "{} should keep its template", paths[1]);
    }

    #[test]
    fn only_chatml_templates_without_any_tool_support_are_replaced() {
        assert!(needs_chatml_tool_template(DOLPHIN));
        // Qwen-style templates already describe tools; Llama/Mistral layouts are not ChatML.
        assert!(!needs_chatml_tool_template(
            "{%- if tools %}<|im_start|>system <tool_call></tool_call><|im_end|>{%- endif %}"
        ));
        assert!(!needs_chatml_tool_template(
            "<|start_header_id|>{{ message['role'] }}<|end_header_id|>"
        ));
        assert!(!needs_chatml_tool_template(""));
        // The bundled replacement itself renders tools and is never replaced again.
        assert!(!needs_chatml_tool_template(CHATML_TOOL_TEMPLATE));
        assert!(
            CHATML_TOOL_TEMPLATE.contains("<tool_call>")
                && CHATML_TOOL_TEMPLATE.contains("<|im_start|>")
        );
    }
}

#[cfg(test)]
mod prefix_tests {
    use super::*;
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
        assert!(apply_required_tool_prefix(&mut body, &props()));
        assert_eq!(
            body["messages"][2],
            json!({"role":"assistant","content":"<tool_call>\n"})
        );
        assert_eq!(body["messages"][0], original["messages"][0]);
        assert_eq!(body["messages"][1], original["messages"][1]);
        assert_eq!(body["tools"], original["tools"]);
        assert_eq!(body["max_tokens"], original["max_tokens"]);
        // Only after the call object closed; an argument may contain "</tool_call>".
        assert_eq!(body["stop"], json!(["\n</tool_call>"]));
        let first = body.clone();
        assert!(!apply_required_tool_prefix(&mut body, &props()));
        assert_eq!(body, first);
    }
    #[test]
    fn every_chatml_tool_template_is_covered_including_thinking_and_replaced_templates() {
        for template in [
            // Qwen3 (stage 3, 5): JSON calls, tool section and thinking block.
            "{%- if tools %}<|im_start|>system <tools></tools> <tool_call></tool_call>{%- endif %}<think></think>",
            // The bundled ChatML tool template a stage 2 model is started with.
            CHATML_TOOL_TEMPLATE,
        ] {
            let mut body = request();
            let metadata = json!({"build_info":"b10809-5266f24da","chat_template":template});
            assert!(apply_required_tool_prefix(&mut body, &metadata));
            assert_eq!(body["messages"][2]["content"], "<tool_call>\n");
            assert_eq!(body["stop"], json!(["\n</tool_call>"]));
        }
    }
    #[test]
    fn xml_function_layout_gets_the_prefix_without_a_stop() {
        // Stage 4 (Qwen3.8 27B): raw parameter values, parsed only with the closing tags.
        let mut body = request();
        let metadata = json!({"build_info":"b10809-5266f24da","chat_template":"<|im_start|> <tool_call>\n<function=name>\n<parameter=a>\n</parameter>\n</function>\n</tool_call> <think></think>"});
        assert!(apply_required_tool_prefix(&mut body, &metadata));
        assert_eq!(body["messages"][2]["content"], "<tool_call>\n");
        assert_eq!(body["parallel_tool_calls"], false);
        assert!(body.get("stop").is_none());
    }
    #[test]
    fn ordinary_answers_unknown_runtimes_and_templates_are_unchanged() {
        for choice in ["auto", "none"] {
            let mut body = request();
            body["tool_choice"] = json!(choice);
            let before = body.clone();
            assert!(!apply_required_tool_prefix(&mut body, &props()));
            assert_eq!(body, before);
        }
        for metadata in [
            Value::Null,
            json!({"build_info":"future","chat_template":"<|im_start|> <tool_call> </tool_call>"}),
            json!({"build_info":"b10809-5266f24da","chat_template":"different"}),
            // Llama 3 / other layouts keep the runtime's own required handling.
            json!({"build_info":"b10809-5266f24da","chat_template":"<|start_header_id|> <tool_call> </tool_call>"}),
        ] {
            let mut body = request();
            let before = body.clone();
            assert!(!apply_required_tool_prefix(&mut body, &metadata));
            assert_eq!(body, before);
        }
        let mut body = request();
        body["tools"] = json!([]);
        let before = body.clone();
        assert!(!apply_required_tool_prefix(&mut body, &props()));
        assert_eq!(body, before);
    }

    #[test]
    fn required_repair_preserves_trailing_system_instructions_and_is_idempotent() {
        for role in ["user", "tool"] {
            let mut body = request();
            body["messages"][1]["role"] = json!(role);
            body["messages"].as_array_mut().unwrap().extend([
                json!({"role":"system","content":"Repair the tool format; never repeat completed writes."}),
                json!({"role":"system","content":"Keep the existing permissions."}),
            ]);
            let original = body["messages"].as_array().unwrap().clone();
            assert!(apply_required_tool_prefix(&mut body, &props()));
            let messages = body["messages"].as_array().unwrap();
            assert_eq!(&messages[..original.len()], original.as_slice());
            assert_eq!(messages.len(), original.len() + 1);
            assert_eq!(body["continue_final_message"], true);
            let once = body.clone();
            assert!(!apply_required_tool_prefix(&mut body, &props()));
            assert_eq!(body, once);
        }
    }

    #[test]
    fn required_repair_does_not_force_optional_tools() {
        for choice in ["required", "auto", "none"] {
            let mut body = request();
            body["tool_choice"] = json!(choice);
            body["messages"].as_array_mut().unwrap().push(
                json!({"role":"system","content":"Repair format without repeating completed actions."}),
            );
            let before = body.clone();
            let changed = apply_required_tool_prefix(&mut body, &props());
            if choice != "required" {
                assert!(!changed);
                assert_eq!(body, before);
                continue;
            }
            assert!(changed);
            assert_eq!(body["messages"][3]["content"], "<tool_call>\n");
            assert_eq!(body["tools"], before["tools"]);
            assert_eq!(body["max_tokens"], before["max_tokens"]);
            assert_eq!(body["tool_choice"], "required");
            assert_eq!(body["stop"], json!(["\n</tool_call>"]));
            let once = body.clone();
            assert!(!apply_required_tool_prefix(&mut body, &props()));
            assert_eq!(body, once);
        }
    }

    #[test]
    fn system_suffix_does_not_force_auto_none_or_continue_existing_assistant() {
        for (choice, role) in [
            ("auto", "user"),
            ("none", "user"),
            ("required", "assistant"),
            ("required", "system"),
        ] {
            let mut body = request();
            body["tool_choice"] = json!(choice);
            body["messages"][1]["role"] = json!(role);
            body["messages"]
                .as_array_mut()
                .unwrap()
                .push(json!({"role":"system","content":"Correction instruction"}));
            let before = body.clone();
            assert!(!apply_required_tool_prefix(&mut body, &props()));
            assert_eq!(body, before);
        }
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
