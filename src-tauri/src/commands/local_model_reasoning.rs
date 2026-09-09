//! Adaptive targets for one resident generation. Counters describe generated
//! output tokens, never fabricated private-reasoning token counts.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub(super) const MAX_OUTPUT_TOKENS: u32 = 131_072;
const MAX_THINKING: u32 = 65_536;
const END_RESERVE: u32 = 64;
const MIN_ANSWER: u32 = 256;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingTier {
    Fast,
    #[default]
    Balanced,
    Thorough,
    Max,
    Ultra,
}
impl ThinkingTier {
    pub(super) fn next(self) -> Option<Self> {
        match self {
            Self::Fast => Some(Self::Balanced),
            Self::Balanced => Some(Self::Thorough),
            Self::Thorough => Some(Self::Max),
            Self::Max => Some(Self::Ultra),
            Self::Ultra => None,
        }
    }
    fn profile(self) -> Profile {
        let (initial, limit, answer) = match self {
            Self::Fast => (512, 4096, 4096),
            Self::Balanced => (1024, 8192, 4096),
            Self::Thorough => (2048, 16384, 8192),
            Self::Max => (4096, 32768, 8192),
            Self::Ultra => (8192, 65536, 16384),
        };
        Profile {
            initial,
            limit,
            answer,
        }
    }
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThinkingConfig {
    initial_tokens: Option<u32>,
    max_thinking_tokens: Option<u32>,
    response_reserve_tokens: Option<u32>,
}
#[derive(Debug, Clone, Copy)]
struct Profile {
    initial: u32,
    limit: u32,
    answer: u32,
}
impl Profile {
    fn configured(tier: ThinkingTier, config: Option<&ThinkingConfig>) -> Result<Self, String> {
        let mut p = tier.profile();
        if let Some(c) = config {
            p.initial = c.initial_tokens.unwrap_or(p.initial);
            p.limit = c.max_thinking_tokens.unwrap_or(p.limit);
            p.answer = c.response_reserve_tokens.unwrap_or(p.answer);
        }
        if p.initial == 0
            || p.limit == 0
            || p.initial > p.limit
            || p.limit > MAX_THINKING
            || p.answer < MIN_ANSWER
            || p.limit.saturating_add(p.answer) > MAX_OUTPUT_TOKENS
        {
            return Err("Local thinking configuration is invalid.".into());
        }
        Ok(p)
    }
}

#[derive(Debug, Clone)]
pub(super) struct Plan {
    pub tier: ThinkingTier,
    profile: Profile,
    pub enabled: bool,
    pub live: bool,
    pub output_ceiling: u32,
}
impl Plan {
    pub fn new(
        tier: ThinkingTier,
        config: Option<&ThinkingConfig>,
        mode: &str,
        maximum: Option<u32>,
        live: bool,
    ) -> Result<Self, String> {
        if !matches!(mode, "auto" | "off")
            || maximum.is_some_and(|n| n == 0 || n > MAX_OUTPUT_TOKENS)
        {
            return Err("Local output budget or reasoning mode is invalid.".into());
        }
        let profile = Profile::configured(tier, config)?;
        let enabled = mode == "auto";
        // Headroom uses only already available context. fit_adaptive_context
        // lowers this before considering removal of any conversation round.
        let desired = if !enabled {
            profile.answer
        } else if live {
            MAX_THINKING + profile.answer + END_RESERVE
        } else {
            profile.limit + profile.answer + END_RESERVE
        };
        Ok(Self {
            tier,
            profile,
            enabled,
            live: live && enabled,
            output_ceiling: maximum
                .unwrap_or(desired)
                .min(desired)
                .min(MAX_OUTPUT_TOKENS),
        })
    }
    fn answer(&self, output: u32) -> u32 {
        self.profile.answer.min(output)
    }
    pub fn apply(&self, body: &mut Value) -> Result<(), String> {
        let output = body["max_tokens"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= u64::from(MAX_OUTPUT_TOKENS))
            .ok_or("Local output budget is invalid.")? as u32;
        let available = output
            .saturating_sub(self.answer(output))
            .saturating_sub(END_RESERVE);
        let limit = if self.live {
            MAX_THINKING
        } else {
            self.profile.limit
        };
        let budget = if self.enabled {
            limit.min(available)
        } else {
            0
        };
        let payload = body
            .as_object_mut()
            .ok_or("Local inference body is invalid.")?;
        let kwargs = payload
            .get_mut("chat_template_kwargs")
            .and_then(Value::as_object_mut)
            .ok_or("Local chat-template parameters are invalid.")?;
        kwargs.insert("enable_thinking".into(), json!(budget > 0));
        payload.insert("reasoning_budget_tokens".into(), json!(budget));
        payload.insert("reasoning_control".into(), json!(budget > 0 && self.live));
        payload.insert("timings_per_token".into(), json!(true));
        if budget == 0 {
            payload.insert("reasoning_effort".into(), json!("none"));
        } else {
            payload.remove("reasoning_effort");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Preparing,
    Thinking,
    Answering,
    Unknown,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetProgress {
    pub request_id: String,
    pub tier: ThinkingTier,
    pub phase: Phase,
    pub generated_tokens: Option<u32>,
    pub soft_target_tokens: u32,
    pub requested_thinking_limit_tokens: u32,
    pub thinking_limit_tokens: u32,
    pub output_limit_tokens: u32,
    pub response_reserve_tokens: u32,
    pub warning: bool,
    pub can_extend: bool,
    pub can_answer: bool,
    pub answer_requested: bool,
    pub elapsed_ms: u64,
    pub sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_outcome: Option<&'static str>,
}
#[derive(Debug)]
pub(super) struct Session {
    pub progress: BudgetProgress,
    pub resource_revision: u64,
    pub completion_id: Option<String>,
    pub started: Instant,
    last_emit: Instant,
    live: bool,
    pub finished: bool,
    control_pending: bool,
}
impl Session {
    pub fn new(request_id: &str, plan: &Plan, output: u32, revision: u64) -> Self {
        let output = output.min(plan.output_ceiling);
        let answer = plan.answer(output);
        let limit = if plan.enabled {
            plan.profile
                .limit
                .min(output.saturating_sub(answer).saturating_sub(END_RESERVE))
        } else {
            0
        };
        let now = Instant::now();
        let mut s = Self {
            progress: BudgetProgress {
                request_id: request_id.into(),
                tier: plan.tier,
                phase: Phase::Preparing,
                generated_tokens: None,
                soft_target_tokens: plan.profile.initial.min(limit),
                requested_thinking_limit_tokens: if plan.enabled { plan.profile.limit } else { 0 },
                thinking_limit_tokens: limit,
                output_limit_tokens: output,
                response_reserve_tokens: answer,
                warning: false,
                can_extend: false,
                can_answer: false,
                answer_requested: false,
                elapsed_ms: 0,
                sequence: 0,
                control_outcome: None,
            },
            resource_revision: revision,
            completion_id: None,
            started: now,
            last_emit: now,
            live: plan.live && limit > 0,
            finished: false,
            control_pending: false,
        };
        s.refresh_controls();
        s
    }
    fn refresh_controls(&mut self) {
        self.progress.can_answer = self.live
            && !self.finished
            && !self.progress.answer_requested
            && self.progress.phase == Phase::Thinking
            && self.completion_id.is_some();
        self.progress.can_extend = self.live
            && !self.finished
            && !self.progress.answer_requested
            && self.progress.phase != Phase::Answering
            && self.progress.tier.next().is_some_and(|tier| {
                let p = tier.profile();
                let capacity = self
                    .progress
                    .output_limit_tokens
                    .saturating_sub(self.progress.response_reserve_tokens)
                    .saturating_sub(END_RESERVE);
                p.limit.min(capacity) > self.progress.thinking_limit_tokens
            });
    }
    pub fn snapshot(&mut self) -> BudgetProgress {
        self.progress.sequence = self.progress.sequence.saturating_add(1);
        self.progress.elapsed_ms =
            self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        self.last_emit = Instant::now();
        self.progress.control_outcome = None;
        self.refresh_controls();
        self.progress.clone()
    }
    /// Returns whether a native reasoning_end request should be sent. Only
    /// phase flags and reported numeric counters are retained from private SSE.
    pub fn observe(&mut self, value: &Value) -> Result<(bool, bool), String> {
        if self.finished {
            return Ok((false, false));
        }
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            if id.is_empty()
                || id.len() > 200
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
            {
                return Err("Local completion identity is invalid.".into());
            }
            if self.completion_id.as_ref().is_some_and(|old| old != id) {
                return Err("Local completion identity changed.".into());
            }
            self.completion_id = Some(id.into());
        }
        let previous_phase = self.progress.phase;
        let previous_warning = self.progress.warning;
        let terminal = value
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .is_some();
        let delta = value.pointer("/choices/0/delta");
        if delta.is_some_and(|v| {
            v.get("reasoning_content")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
        }) {
            self.progress.phase = Phase::Thinking;
        }
        if delta.is_some_and(|v| {
            v.get("content")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
                || v.get("tool_calls")
                    .and_then(Value::as_array)
                    .is_some_and(|a| !a.is_empty())
        }) {
            self.progress.phase = Phase::Answering;
        }
        let mut advanced = false;
        if let Some(n) = value
            .pointer("/timings/predicted_n")
            .and_then(Value::as_u64)
            .filter(|n| *n <= u64::from(self.progress.output_limit_tokens))
        {
            let n = n as u32;
            if self.progress.generated_tokens.is_none_or(|old| n >= old) {
                advanced = self.progress.generated_tokens.is_none_or(|old| n > old);
                self.progress.generated_tokens = Some(n);
                if n > 0 && self.progress.phase == Phase::Preparing {
                    self.progress.phase = Phase::Unknown;
                }
            }
        }
        let mut grew = false;
        if self.progress.phase == Phase::Thinking && !self.progress.answer_requested {
            if let Some(n) = self.progress.generated_tokens {
                if advanced
                    && self.live
                    && self.started.elapsed() < Duration::from_secs(29 * 60)
                    && n.saturating_mul(10) >= self.progress.soft_target_tokens.saturating_mul(9)
                    && self.progress.soft_target_tokens < self.progress.thinking_limit_tokens
                {
                    self.progress.soft_target_tokens = self
                        .progress
                        .soft_target_tokens
                        .saturating_add(self.progress.soft_target_tokens.div_ceil(2))
                        .max(n.saturating_add(1))
                        .min(self.progress.thinking_limit_tokens);
                    grew = true;
                }
                self.progress.warning =
                    n.saturating_mul(10) >= self.progress.soft_target_tokens.saturating_mul(8);
                if self.live && n >= self.progress.thinking_limit_tokens {
                    self.control_pending = true;
                }
            }
        }
        if terminal {
            self.finished = true;
        }
        self.refresh_controls();
        let force = self.control_pending && self.progress.can_answer;
        if force {
            self.control_pending = false;
            self.progress.answer_requested = true;
            self.refresh_controls();
        }
        let emit = terminal
            || force
            || grew
            || previous_phase != self.progress.phase
            || previous_warning != self.progress.warning
            || self.last_emit.elapsed() >= Duration::from_millis(250);
        Ok((force, emit))
    }
    pub fn control(
        &mut self,
        action: &str,
        expected: u64,
    ) -> Result<(BudgetProgress, bool), String> {
        if self.finished {
            return Err("Local thinking request has ended.".into());
        }
        if expected != self.progress.sequence {
            let mut current = self.progress.clone();
            current.control_outcome = Some("stale");
            return Ok((current, false));
        }
        if !matches!(action, "more" | "answer") {
            return Err("Local thinking action is invalid.".into());
        }
        self.refresh_controls();
        let outcome;
        let mut send = false;
        if action == "more" && self.progress.can_extend {
            self.progress.tier = self.progress.tier.next().unwrap();
            let p = self.progress.tier.profile();
            self.progress.requested_thinking_limit_tokens = p.limit;
            // Live More raises only the thinking ceiling. The preallocated
            // answer reserve is immutable until a new inference request.
            self.progress.thinking_limit_tokens = p.limit.min(
                self.progress
                    .output_limit_tokens
                    .saturating_sub(self.progress.response_reserve_tokens)
                    .saturating_sub(END_RESERVE),
            );
            outcome = "applied";
        } else if action == "answer" && self.progress.can_answer {
            self.progress.answer_requested = true;
            send = true;
            outcome = "applied";
        } else {
            outcome = if self.live {
                "not_thinking"
            } else {
                "unavailable"
            };
        }
        let mut snapshot = self.snapshot();
        snapshot.control_outcome = Some(outcome);
        Ok((snapshot, send))
    }
    pub fn control_failed(&mut self) {
        self.live = false;
        self.refresh_controls();
    }
}

/// Capability is conservative and pinned: a newer/different backend is not
/// assumed to implement the same control API just because it supports chat.
pub(super) fn runtime_limits(props: &Value, signed_context: u32) -> (u32, bool) {
    let context = props
        .pointer("/default_generation_settings/n_ctx")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= 1_048_576)
        .map_or(signed_context, |n| signed_context.min(n as u32));
    let build = props
        .get("build_info")
        .and_then(Value::as_str)
        .unwrap_or("");
    let template = props
        .get("chat_template_tool_use")
        .or_else(|| props.get("chat_template"))
        .and_then(Value::as_str)
        .unwrap_or("");
    (
        context,
        build.contains("5266f24") && template.contains("<think>") && template.contains("</think>"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session(tier: ThinkingTier, output: u32, live: bool) -> Session {
        let plan = Plan::new(tier, None, "auto", None, live).unwrap();
        Session::new("req-1", &plan, output, 7)
    }
    fn thinking(count: u32) -> Value {
        json!({"id":"chatcmpl-fixed", "choices":[{"delta":{"reasoning_content":"private fixture"}}],
            "timings":{"predicted_n":count}})
    }
    #[test]
    fn five_default_profiles_and_native_validation_ceiling() {
        for (tier, expected) in [
            (ThinkingTier::Fast, (512, 4096, 4096)),
            (ThinkingTier::Balanced, (1024, 8192, 4096)),
            (ThinkingTier::Thorough, (2048, 16384, 8192)),
            (ThinkingTier::Max, (4096, 32768, 8192)),
            (ThinkingTier::Ultra, (8192, 65536, 16384)),
        ] {
            let p = Plan::new(tier, None, "auto", Some(131072), true).unwrap();
            let s = Session::new("x", &p, p.output_ceiling, 1);
            assert_eq!(
                (
                    s.progress.soft_target_tokens,
                    s.progress.thinking_limit_tokens,
                    s.progress.response_reserve_tokens
                ),
                expected
            );
        }
        assert_eq!(ThinkingTier::default(), ThinkingTier::Balanced);
        assert!(Plan::new(ThinkingTier::Fast, None, "auto", Some(131073), true).is_err());
        assert!(Plan::new(ThinkingTier::Fast, None, "auto", Some(0), true).is_err());
    }
    #[test]
    fn off_and_small_explicit_output_never_spend_answer_reserve_on_thinking() {
        for (mode, maximum) in [("off", 768), ("auto", 2048), ("off", 16)] {
            let p = Plan::new(ThinkingTier::Balanced, None, mode, Some(maximum), true).unwrap();
            let mut body = json!({"max_tokens":p.output_ceiling,"chat_template_kwargs":{"parse_tool_calls":true}});
            p.apply(&mut body).unwrap();
            assert_eq!(body["reasoning_budget_tokens"], 0);
            assert_eq!(body["reasoning_effort"], "none");
            assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
            assert_eq!(body["chat_template_kwargs"]["parse_tool_calls"], true);
            assert_eq!(body["reasoning_control"], false);
            assert_eq!(body["max_tokens"], maximum);
        }
    }
    #[test]
    fn invalid_overrides_are_rejected_and_valid_custom_reserve_survives() {
        for config in [
            json!({"initialTokens":0}),
            json!({"initialTokens":65537}),
            json!({"maxThinkingTokens":65537}),
            json!({"responseReserveTokens":255}),
            json!({"maxThinkingTokens":65536,"responseReserveTokens":65537}),
        ] {
            let c: ThinkingConfig = serde_json::from_value(config).unwrap();
            assert!(Plan::new(ThinkingTier::Balanced, Some(&c), "auto", None, true).is_err());
        }
        assert!(serde_json::from_value::<ThinkingConfig>(json!({"initialTokens":1.5})).is_err());
        assert!(serde_json::from_value::<ThinkingConfig>(json!({"unknown":123})).is_err());
        let c = ThinkingConfig {
            initial_tokens: Some(128),
            max_thinking_tokens: Some(1024),
            response_reserve_tokens: Some(60000),
        };
        assert!(Plan::new(ThinkingTier::Balanced, Some(&c), "auto", None, true).is_ok());
    }
    #[test]
    fn output_fit_recalculates_template_without_changing_model_or_context() {
        let p = Plan::new(ThinkingTier::Ultra, None, "auto", None, true).unwrap();
        let mut body = json!({"max_tokens":30000,"model":"same","chat_template_kwargs":{}});
        p.apply(&mut body).unwrap();
        assert_eq!(body["reasoning_budget_tokens"], 30000 - 16384 - 64);
        body["max_tokens"] = json!(1000);
        p.apply(&mut body).unwrap();
        assert_eq!(body["reasoning_budget_tokens"], 0);
        assert_eq!(body["model"], "same");
        assert_eq!(body["max_tokens"], 1000);
    }
    #[test]
    fn warning_at_eighty_and_growth_at_ninety_are_based_on_reported_tokens() {
        let mut s = session(ThinkingTier::Fast, 81984, true);
        s.observe(&thinking(410)).unwrap();
        assert!(s.progress.warning);
        assert_eq!(s.progress.soft_target_tokens, 512);
        s.observe(&thinking(461)).unwrap();
        assert_eq!(s.progress.soft_target_tokens, 768);
        assert!(!s.progress.warning);
        let target = s.progress.soft_target_tokens;
        s.observe(&thinking(461)).unwrap();
        assert_eq!(s.progress.soft_target_tokens, target);
        s.observe(&thinking(460)).unwrap();
        assert_eq!(s.progress.generated_tokens, Some(461));
    }
    #[test]
    fn missing_counters_stay_unknown_and_never_trigger_automatic_growth() {
        let mut s = session(ThinkingTier::Fast, 81984, true);
        s.observe(&json!({"id":"chatcmpl-fixed","choices":[{"delta":{"reasoning_content":"private fixture"}}]})).unwrap();
        assert_eq!(s.progress.generated_tokens, None);
        assert_eq!(s.progress.soft_target_tokens, 512);
        assert!(s.progress.can_answer);
        assert!(!s.progress.answer_requested);
    }
    #[test]
    fn automatic_ceiling_sends_one_answer_request_without_claiming_public_answer() {
        let mut s = session(ThinkingTier::Fast, 81984, true);
        assert!(s.observe(&thinking(4096)).unwrap().0);
        assert!(s.progress.answer_requested);
        assert_eq!(s.progress.phase, Phase::Thinking);
        assert!(!s.observe(&thinking(4097)).unwrap().0);
        assert!(!s.progress.can_answer);
    }
    #[test]
    fn stale_control_changes_nothing_and_current_more_only_moves_one_tier() {
        let mut s = session(ThinkingTier::Fast, 81984, true);
        s.observe(&thinking(100)).unwrap();
        let before = s.snapshot();
        let (stale, send) = s.control("more", before.sequence - 1).unwrap();
        assert!(!send);
        assert_eq!(stale.control_outcome, Some("stale"));
        assert_eq!(s.progress.tier, ThinkingTier::Fast);
        assert_eq!(s.progress.sequence, before.sequence);
        let (updated, send) = s.control("more", before.sequence).unwrap();
        assert!(!send);
        assert_eq!(updated.tier, ThinkingTier::Balanced);
        assert_eq!(updated.thinking_limit_tokens, 8192);
        assert_eq!(updated.output_limit_tokens, before.output_limit_tokens);
        assert!(updated.sequence > before.sequence);
    }
    #[test]
    fn control_disabled_for_unknown_backend_answer_phase_and_finished_request() {
        let mut unknown = session(ThinkingTier::Fast, 81984, false);
        unknown.observe(&thinking(10)).unwrap();
        let (p, send) = unknown.control("answer", 0).unwrap();
        assert!(!send);
        assert_eq!(p.control_outcome, Some("unavailable"));
        let mut s = session(ThinkingTier::Fast, 81984, true);
        s.observe(&thinking(10)).unwrap();
        s.observe(&json!({"id":"chatcmpl-fixed","choices":[{"delta":{"content":"public"}}]}))
            .unwrap();
        assert!(!s.progress.can_extend);
        assert!(!s.progress.can_answer);
        s.observe(&json!({"id":"chatcmpl-fixed","choices":[{"delta":{},"finish_reason":"stop"}]}))
            .unwrap();
        assert!(s.control("more", s.progress.sequence).is_err());
    }
    #[test]
    fn progress_serialization_contains_no_private_text_or_provider_identity() {
        let mut s = session(ThinkingTier::Fast, 81984, true);
        s.observe(&thinking(10)).unwrap();
        let text = serde_json::to_string(&s.snapshot()).unwrap();
        assert!(!text.contains("private fixture"));
        assert!(!text.contains("chatcmpl-fixed"));
        assert!(!text.contains("reasoning_content"));
        let v: Value = serde_json::from_str(&text).unwrap();
        for field in [
            "canAnswer",
            "sequence",
            "elapsedMs",
            "requestedThinkingLimitTokens",
            "generatedTokens",
        ] {
            assert!(v.get(field).is_some());
        }
        assert!(s.observe(&json!({"id":"different"})).is_err());
    }
    #[test]
    fn runtime_context_and_exact_build_template_are_verified_conservatively() {
        let props = json!({"default_generation_settings":{"n_ctx":32768,"params":{"n_predict":-1}},
            "build_info":"b10809-5266f24da","chat_template":"<think> ... </think>"});
        assert_eq!(runtime_limits(&props, 131072), (32768, true));
        assert_eq!(runtime_limits(&props, 4096), (4096, true));
        let mut other = props.clone();
        other["build_info"] = json!("unknown");
        assert_eq!(runtime_limits(&other, 131072), (32768, false));
        other["chat_template"] = json!("ordinary template");
        assert!(!runtime_limits(&other, 131072).1);
        assert_eq!(runtime_limits(&Value::Null, 32768), (32768, false));
    }

    #[test]
    fn changed_template_is_recounted_and_cannot_bypass_real_context_capacity() {
        let plan = Plan::new(ThinkingTier::Balanced, None, "auto", None, true).unwrap();
        let mut body = json!({"max_tokens":plan.output_ceiling,"messages":[{"role":"user","content":"current"}],"chat_template_kwargs":{}});
        let mut counts = 0;
        let result = super::super::context_budget::fit_adaptive_context(
            &mut body,
            4096,
            |candidate| {
                plan.apply(candidate)?;
                counts += 1;
                Ok::<u64, String>(
                    if candidate["chat_template_kwargs"]["enable_thinking"] == true {
                        3760
                    } else {
                        3800
                    },
                )
            },
            || "Final template does not fit".to_string(),
        );
        assert_eq!(result.unwrap_err(), "Final template does not fit");
        assert_eq!(counts, 2);
        assert_eq!(body["messages"][0]["content"], "current");
    }

    #[test]
    fn more_keeps_initial_answer_reserve_and_hard_output_fixed_even_at_ultra() {
        let mut s = session(ThinkingTier::Fast, 69696, true);
        let output = s.progress.output_limit_tokens;
        let reserve = s.progress.response_reserve_tokens;
        for tier in [
            ThinkingTier::Balanced,
            ThinkingTier::Thorough,
            ThinkingTier::Max,
            ThinkingTier::Ultra,
        ] {
            let seq = s.progress.sequence;
            let (progress, send) = s.control("more", seq).unwrap();
            assert!(!send);
            assert_eq!(progress.tier, tier);
            assert_eq!(progress.response_reserve_tokens, reserve);
            assert_eq!(progress.output_limit_tokens, output);
            assert!(progress.thinking_limit_tokens + reserve + 64 <= output);
        }
        assert!(!s.progress.can_extend);
        assert_eq!(s.progress.thinking_limit_tokens, 65536);
    }

    #[test]
    fn length_only_reasoning_sse_keeps_usage_and_numeric_progress_without_private_text() {
        use std::sync::{Arc, Mutex};
        let request: super::super::LocalInferenceRequest=serde_json::from_value(json!({
            "requestId":"synthetic-round","scopeDigest":"a".repeat(64),"modelReleaseId":"local-fixture","useCase":"chat",
            "catalogBinding":{"acceptanceSessionId":"00000000-0000-4000-8000-000000000001","acceptanceGeneration":1,"manifestPayloadSha256":"b".repeat(64)},
            "messages":[{"role":"user","content":"Public fixture"}],"tools":[],"toolChoice":"none","reasoningMode":"auto"
        })).unwrap();
        assert!(super::super::validate_inference_request(&request).is_ok());
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let channel = tauri::ipc::Channel::<super::super::LocalInferenceEvent>::new(move |event| {
            if let tauri::ipc::InvokeResponseBody::Json(event) = event {
                sink.lock().unwrap().push(event);
            }
            Ok(())
        });
        let mut s = session(ThinkingTier::Balanced, 69696, true);
        let stream = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({"id":"fixture-id","choices":[{"delta":{"reasoning_content":"SYNTHETIC_PRIVATE_REASONING"}}],"timings":{"predicted_n":2048}}),
            json!({"id":"fixture-id","choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":123,"completion_tokens":2048,"total_tokens":2171}})
        );
        let result = super::super::parse_sse_observed(
            std::io::Cursor::new(stream.into_bytes()),
            &request,
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            &channel,
            |value| {
                s.observe(value)?;
                channel
                    .send(super::super::LocalInferenceEvent::Budget {
                        progress: s.snapshot(),
                    })
                    .unwrap();
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(result.content, "");
        assert_eq!(result.finish_reason, "length");
        assert_eq!(result.usage.as_ref().unwrap().output_tokens, 2048);
        assert!(result.raw_tool_calls.is_empty());
        let rendered = events.lock().unwrap().join("\n");
        assert!(rendered.contains("generatedTokens\":2048"));
        assert!(rendered.contains("\"type\":\"budget\""));
        assert!(!rendered.contains("SYNTHETIC_PRIVATE_REASONING"));
        assert!(!rendered.contains("fixture-id"));
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("SYNTHETIC_PRIVATE_REASONING"));
        let mut manager = super::super::ManagerState {
            active_reasoning: Some(Arc::new(Mutex::new(s))),
            ..Default::default()
        };
        let old = manager.active_reasoning.as_ref().unwrap().clone();
        super::super::clear_thinking_session(&mut manager);
        assert!(manager.active_reasoning.is_none());
        assert!(old.lock().unwrap().finished);
    }
}
