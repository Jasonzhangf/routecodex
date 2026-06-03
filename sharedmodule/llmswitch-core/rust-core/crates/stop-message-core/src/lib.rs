//! Stop-message decision core — pure Rust, no NAPI dependency.
//!
//! This crate implements the decision logic for `stop_message_auto` servertool handler.
//! The TS shell collects context, calls `decide()`, and acts on the result.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const LEGACY_DEFAULT_TEXT: &str = "继续执行";
const DEFAULT_EXECUTION_PROMPTS: [&str; 3] = [
    "停止前先核对三件事：1) 目标：当前用户目标是什么，是否逐项完成；2) 过程：你实际做过哪些操作/检查/验证，哪些还没做；3) 证据：完成或阻塞的证据在哪里。若任一项缺证据，禁止总结或停下，必须调用可用工具继续执行到有证据。只有目标已完成或确实阻塞时，才输出最终结果并给出证据。",
    "你刚才再次停止。请重新核对：目标是否真的完成？过程是否覆盖用户要求的每一项？证据是否能被日志、文件、命令结果或测试结果验证？如果答案不是全部明确，禁止继续总结，必须调用工具补齐缺口；如果确实完成/阻塞，必须说明目标、过程、证据，并在 stop schema 的 learned 字段写出过去 turns 学到的可复用结论；没有则填空字符串。",
    "最后一次续杯预算。停止必须同时满足：目标逐项完成或明确阻塞；过程已说明关键操作与验证；证据可核验且对应目标。缺任何一项都不允许停，必须立即调用工具继续执行最小下一步。禁止空泛总结、道歉、计划或无证据停止。",
];

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum StageMode {
    On,
    Off,
    Auto,
}

impl StageMode {
    pub fn is_off(&self) -> bool {
        matches!(self, StageMode::Off)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotSource {
    /// Explicitly persisted via `<**stopMessage:on**>` or session state
    Persisted,
    /// Default snapshot from config/env when no explicit state exists
    Default,
    /// Gemini-implicit snapshot (legacy)
    ImplicitGemini,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GoalStatus {
    Idle,
    Active,
    Paused,
    Stopped,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StopMessageFollowupPolicy {
    Disable,
    PreserveEligibility,
}

impl GoalStatus {
    pub fn is_active(&self) -> bool {
        matches!(self, GoalStatus::Active)
    }

    pub fn is_managed(&self) -> bool {
        !matches!(self, GoalStatus::Idle)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    PortDisabled,
    ServertoolFollowupHop,
    ResponsesSubmitToolOutputsResume,
    ExplicitModeOff,
    ExplicitModeWithoutSnapshot,
    GoalDefaultExhausted,
    NoSnapshot,
    ModeOff,
    EmptyText,
    InvalidRepeats,
    NotStopFinishReason,
    ReachedMaxRepeats,
    GoalActive,
    PlanMode,
}

impl SkipReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkipReason::PortDisabled => "skip_port_stopmessage_disabled",
            SkipReason::ServertoolFollowupHop => "skip_servertool_followup_hop",
            SkipReason::ResponsesSubmitToolOutputsResume => {
                "skip_responses_submit_tool_outputs_resume"
            }
            SkipReason::ExplicitModeOff => "skip_stopmessage_mode_off",
            SkipReason::ExplicitModeWithoutSnapshot => "skip_explicit_mode_without_snapshot",
            SkipReason::GoalDefaultExhausted => "skip_goal_default_exhausted",
            SkipReason::NoSnapshot => "skip_no_stopmessage_snapshot",
            SkipReason::ModeOff => "skip_stopmessage_mode_off",
            SkipReason::EmptyText => "skip_stopmessage_empty_text",
            SkipReason::InvalidRepeats => "skip_stopmessage_invalid_repeats",
            SkipReason::NotStopFinishReason => "skip_not_stop_finish_reason",
            SkipReason::ReachedMaxRepeats => "skip_reached_max_repeats",
            SkipReason::GoalActive => "skip_goal_active",
            SkipReason::PlanMode => "skip_plan_mode",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderPin {
    pub provider_key: Option<String>,
    pub model_id: Option<String>,
    pub routecodex_port_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopMessageSnapshot {
    pub text: String,
    pub max_repeats: u32,
    pub used: u32,
    pub source: SnapshotSource,
    pub stage_mode: StageMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopMessageDecisionContext {
    // Port gate
    pub port_stop_message_disabled: bool,

    // Servertool followup context
    pub followup_flow_id: Option<String>,
    pub stop_message_followup_policy: Option<StopMessageFollowupPolicy>,
    pub stop_eligible: bool,
    /// finish_reason sequence from current response choices, in original order.
    /// Decision must only consider the latest non-empty finish_reason.
    pub finish_reasons: Option<Vec<String>>,

    // Submit tool outputs resume
    pub has_responses_submit_tool_outputs_resume: bool,

    // Persisted state
    pub persisted_snapshot: Option<StopMessageSnapshot>,
    pub runtime_snapshot: Option<StopMessageSnapshot>,
    pub persisted_default_exhausted: bool,

    // Explicit mode from runtime/sticky
    pub explicit_mode: Option<StageMode>,

    // Goal state
    pub goal_status: GoalStatus,

    // Collaboration mode gate
    pub plan_mode_active: bool,

    // Default config
    pub default_enabled: bool,
    pub default_max_repeats: u32,
    pub default_text: String,

    // Empty reply continue check
    pub empty_reply_continue_local: bool,

    // Provider pin
    pub provider_pin: Option<ProviderPin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopMessageDecision {
    pub action: Action,
    pub skip_reason: Option<String>,
    pub used: u32,
    pub max_repeats: u32,
    pub followup_text: Option<String>,
    pub provider_pin: Option<ProviderPin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Skip,
    Trigger,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StopSchemaParsed {
    pub stopreason: Option<u8>,
    pub has_evidence: Option<u8>,
    pub reason: Option<String>,
    pub next_step: Option<String>,
    pub evidence: Option<String>,
    pub learned: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StopSchemaGateAction {
    AllowStop,
    Followup,
    FailFast,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StopSchemaGateDecision {
    pub action: StopSchemaGateAction,
    pub reason_code: String,
    pub summary_prefix: Option<String>,
    pub followup_text: Option<String>,
    pub count_budget: bool,
    pub parsed: Option<StopSchemaParsed>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GoalActiveStopLoopInput {
    pub captured_request: Value,
    pub assistant_text: String,
    pub threshold: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GoalActiveStopLoopDecision {
    pub loop_detected: bool,
    pub repeat_count: u32,
    pub threshold: u32,
    pub goal_context_count: u32,
    pub reason_code: String,
}

const DEFAULT_GOAL_ACTIVE_STOP_LOOP_THRESHOLD: u32 = 3;

// ── Core decision function ──────────────────────────────────────────────────

/// Decide whether `stop_message_auto` should trigger a followup.
///
/// Returns a `StopMessageDecision` with the action to take.
/// This is a pure function — no I/O, no side effects.
pub fn decide(ctx: &StopMessageDecisionContext) -> StopMessageDecision {
    if let Some(reason) = decide_stop_message_skip(ctx) {
        return skip(reason);
    }

    let resolved_snapshot = resolve_snapshot(ctx);

    let snapshot = match resolved_snapshot {
        Some(s) => s,
        None => return skip(SkipReason::NoSnapshot),
    };

    // 5. Mode off?
    if snapshot.stage_mode.is_off() {
        return skip(SkipReason::ModeOff);
    }

    // 6. Empty text?
    if snapshot.text.is_empty() {
        return skip(SkipReason::EmptyText);
    }

    let effective_max_repeats = normalize_trigger_max_repeats(&snapshot, ctx.default_max_repeats);
    if effective_max_repeats == 0 {
        return skip(SkipReason::InvalidRepeats);
    }
    if snapshot.used >= effective_max_repeats {
        return skip(SkipReason::ReachedMaxRepeats);
    }

    // ── Trigger ──
    StopMessageDecision {
        action: Action::Trigger,
        skip_reason: None,
        used: snapshot.used,
        max_repeats: effective_max_repeats,
        followup_text: Some(normalize_followup_text(snapshot.text, snapshot.used)),
        provider_pin: ctx.provider_pin.clone(),
    }
}

fn default_execution_prompt(used: u32) -> String {
    DEFAULT_EXECUTION_PROMPTS
        .get(used as usize)
        .or_else(|| DEFAULT_EXECUTION_PROMPTS.last())
        .unwrap_or(&DEFAULT_EXECUTION_PROMPTS[0])
        .to_string()
}

fn normalize_followup_text(text: String, used: u32) -> String {
    if text.trim() == LEGACY_DEFAULT_TEXT {
        default_execution_prompt(used)
    } else {
        text
    }
}

pub fn evaluate_stop_schema_gate(
    assistant_text: &str,
    used: u32,
    max_repeats: u32,
) -> StopSchemaGateDecision {
    let parsed = match parse_stop_schema(assistant_text) {
        Some(parsed) => parsed,
        None => {
            return schema_followup(
                "stop_schema_missing",
                used,
                "你刚才试图停止，但没有提供 stop schema。先核对目标、过程、证据：目标是否逐项完成？过程是否覆盖要求？证据是否可核验？现在必须二选一：1) 若完成或阻塞，立即给出 stop schema：stopreason(数字：0=finished,1=blocked)、reason(具体原因)、has_evidence(数字0/1)、evidence(可核验证据)、next_step(后续动作或空)、learned(过去 turns 学到的可复用事实/踩坑/配置结论；没有则空字符串)；2) 若任一项没有证据，不准总结，必须立刻调用工具继续执行当前目标。",
                None,
                false,
            );
        }
    };

    let stopreason = match parsed.stopreason {
        Some(v) => v,
        None => {
            return schema_invalid_followup(
                "stop_schema_stopreason_missing_or_non_numeric",
                used,
                max_repeats,
                "stop schema 缺少数字 stopreason。不要猜、不要总结。先回答：目标是什么、过程做到哪一步、证据是什么。现在必须补齐数字 stopreason：0=finished、1=blocked、2=continue_needed。若选择 0/1，必须给 reason、evidence、learned；若目标/过程/证据任一项不足，选择 2，给 next_step 并立即执行。learned 是过去 turns 学到的可复用事实/踩坑/配置结论，没有则空字符串。",
                parsed,
            );
        }
    };

    if stopreason == 0 || stopreason == 1 {
        let reason = parsed.reason.as_deref().map(str::trim).unwrap_or("");
        if reason.is_empty() {
            return schema_invalid_followup(
                "stop_schema_reason_missing",
                used,
                max_repeats,
                "你声明 finished/blocked，但没有给 reason。停止不成立。请具体说明：完成/阻塞对应哪个用户目标？过程里做过哪些验证？证据是什么？如果不能逐项回答，禁止再停，必须调用工具继续执行。",
                parsed,
            );
        }
        return StopSchemaGateDecision {
            action: StopSchemaGateAction::AllowStop,
            reason_code: if stopreason == 0 {
                "stop_schema_finished".to_string()
            } else {
                "stop_schema_blocked".to_string()
            },
            summary_prefix: Some(format!("停止原因：{}\n\n", reason)),
            followup_text: None,
            count_budget: false,
            parsed: Some(parsed),
        };
    }

    let next_step = parsed.next_step.as_deref().map(str::trim).unwrap_or("");
    if !next_step.is_empty() {
        return schema_invalid_followup(
            "stop_schema_continue_next_step",
            used,
            max_repeats,
            &format!(
                "你已经提供 next_step，说明目标/过程/证据仍有缺口。本轮不允许停止、不允许改写计划、不允许总结。立即调用工具执行这个下一步，并用结果补齐证据：{}",
                next_step
            ),
            parsed,
        );
    }

    schema_invalid_followup(
        "stop_schema_next_step_missing",
        used,
        max_repeats,
        "你没有证明 finished/blocked，也没有给 next_step。停止不成立。请按目标、过程、证据三项检查：目标是否完成？过程是否验证？证据是否可核验？完成/阻塞就给 stopreason=0/1、reason、has_evidence、evidence、learned；否则必须给 next_step 并调用工具执行。learned 是过去 turns 学到的可复用结论，没有则空字符串。",
        parsed,
    )
}

pub fn evaluate_goal_active_stop_loop(
    input: &GoalActiveStopLoopInput,
) -> GoalActiveStopLoopDecision {
    let threshold = input
        .threshold
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_GOAL_ACTIVE_STOP_LOOP_THRESHOLD);
    let assistant_text = normalize_loop_text(&input.assistant_text);
    if assistant_text.is_empty() {
        return goal_active_loop_decision(false, 0, threshold, 0, "goal_active_stop_empty_text");
    }

    let Some(items) = request_items(&input.captured_request) else {
        return goal_active_loop_decision(
            false,
            0,
            threshold,
            0,
            "goal_active_stop_no_request_items",
        );
    };

    let goal_context_count = current_goal_context_count(items);
    if goal_context_count == 0 {
        return goal_active_loop_decision(
            false,
            0,
            threshold,
            0,
            "goal_active_stop_no_goal_context",
        );
    }

    let mut repeat_count = 1u32;
    for item in items.iter().rev() {
        if item_has_tool_signal(item) {
            break;
        }
        if item_role(item) != Some("assistant") {
            continue;
        }
        let Some(text) = item_text(item).map(|text| normalize_loop_text(&text)) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        if text == assistant_text {
            repeat_count = repeat_count.saturating_add(1);
            continue;
        }
        break;
    }

    goal_active_loop_decision(
        repeat_count >= threshold,
        repeat_count,
        threshold,
        goal_context_count,
        if repeat_count >= threshold {
            "goal_active_repeated_stop"
        } else {
            "goal_active_stop_not_repeated"
        },
    )
}

fn current_goal_context_count(items: &[Value]) -> u32 {
    let mut count = 0u32;
    for item in items.iter().rev() {
        if item_has_tool_signal(item) {
            break;
        }
        if item_role(item) != Some("user") {
            continue;
        }
        let Some(text) = item_text(item) else {
            continue;
        };
        if is_active_goal_text(&text) {
            count = count.saturating_add(1);
            continue;
        }
        break;
    }
    count
}

fn goal_active_loop_decision(
    loop_detected: bool,
    repeat_count: u32,
    threshold: u32,
    goal_context_count: u32,
    reason_code: &str,
) -> GoalActiveStopLoopDecision {
    GoalActiveStopLoopDecision {
        loop_detected,
        repeat_count,
        threshold,
        goal_context_count,
        reason_code: reason_code.to_string(),
    }
}

fn request_items(value: &Value) -> Option<&Vec<Value>> {
    value
        .get("input")
        .and_then(Value::as_array)
        .or_else(|| value.get("messages").and_then(Value::as_array))
}

fn item_role(item: &Value) -> Option<&str> {
    item.get("role").and_then(Value::as_str).map(str::trim)
}

fn item_text(item: &Value) -> Option<String> {
    collect_value_text(item.get("content")?)
}

fn collect_value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|item| match item {
                    Value::String(text) => Some(text.clone()),
                    Value::Object(obj) => obj
                        .get("text")
                        .or_else(|| obj.get("output_text"))
                        .or_else(|| obj.get("content"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    _ => None,
                })
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(obj) => obj
            .get("text")
            .or_else(|| obj.get("output_text"))
            .or_else(|| obj.get("content"))
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn item_has_tool_signal(item: &Value) -> bool {
    item_role(item).is_some_and(|role| {
        matches!(
            role,
            "tool" | "function" | "tool_result" | "function_call_output"
        )
    }) || item
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
        || item.get("function_call").is_some()
        || item.get("tool_call_id").is_some()
        || item.get("call_id").is_some()
        || item
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|text| text.contains("tool") || text.contains("function_call"))
}

fn is_active_goal_text(text: &str) -> bool {
    text.contains("Continue working toward the active thread goal.")
        || text.contains("<codex_internal_context source=\"goal\">")
        || text.contains("<goal_context>")
}

fn normalize_loop_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn schema_invalid_followup(
    reason_code: &str,
    used: u32,
    max_repeats: u32,
    message: &str,
    parsed: StopSchemaParsed,
) -> StopSchemaGateDecision {
    if max_repeats > 0 && used >= max_repeats {
        return StopSchemaGateDecision {
            action: StopSchemaGateAction::FailFast,
            reason_code: "stop_schema_budget_exhausted".to_string(),
            summary_prefix: None,
            followup_text: None,
            count_budget: true,
            parsed: Some(parsed),
        };
    }
    schema_followup(reason_code, used, message, Some(parsed), true)
}

fn schema_followup(
    reason_code: &str,
    used: u32,
    message: &str,
    parsed: Option<StopSchemaParsed>,
    count_budget: bool,
) -> StopSchemaGateDecision {
    let mut text = String::new();
    if reason_code == "stop_schema_continue_next_step" {
        text.push_str(message);
    } else {
        text.push_str(default_execution_prompt(used).as_str());
        text.push_str("\n\nStop schema 校验未通过：");
        text.push_str(message);
    }
    StopSchemaGateDecision {
        action: StopSchemaGateAction::Followup,
        reason_code: reason_code.to_string(),
        summary_prefix: None,
        followup_text: Some(text),
        count_budget,
        parsed,
    }
}

fn parse_stop_schema(text: &str) -> Option<StopSchemaParsed> {
    let value = parse_first_json_object(text)?;
    let row = value.as_object()?;
    Some(StopSchemaParsed {
        stopreason: read_u8(row.get("stopreason")),
        has_evidence: read_u8(row.get("has_evidence")),
        reason: read_string(row.get("reason")),
        next_step: read_string(row.get("next_step")),
        evidence: read_string(row.get("evidence")),
        learned: read_string(row.get("learned")),
    })
}

fn read_u8(value: Option<&Value>) -> Option<u8> {
    value.and_then(|v| v.as_u64()).and_then(|v| {
        if v <= u8::MAX as u64 {
            Some(v as u8)
        } else {
            None
        }
    })
}

fn read_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

fn parse_first_json_object(text: &str) -> Option<Value> {
    if let Some(value) = parse_fenced_json_object(text) {
        return Some(value);
    }
    let bytes = text.as_bytes();
    for start in 0..bytes.len() {
        if bytes[start] != b'{' {
            continue;
        }
        let mut depth = 0i32;
        let mut in_string = false;
        let mut escaped = false;
        for end in start..bytes.len() {
            let ch = bytes[end];
            if in_string {
                if escaped {
                    escaped = false;
                } else if ch == b'\\' {
                    escaped = true;
                } else if ch == b'"' {
                    in_string = false;
                }
                continue;
            }
            if ch == b'"' {
                in_string = true;
            } else if ch == b'{' {
                depth += 1;
            } else if ch == b'}' {
                depth -= 1;
                if depth == 0 {
                    let candidate = &text[start..=end];
                    if let Ok(value) = serde_json::from_str::<Value>(candidate) {
                        if value.is_object() {
                            return Some(value);
                        }
                    }
                    break;
                }
            }
        }
    }
    None
}

fn parse_fenced_json_object(text: &str) -> Option<Value> {
    let marker = "```";
    let mut rest = text;
    while let Some(start) = rest.find(marker) {
        let after = &rest[start + marker.len()..];
        let after = after.strip_prefix("json").unwrap_or(after);
        let after = after.strip_prefix('\n').unwrap_or(after);
        let Some(end) = after.find(marker) else {
            return None;
        };
        let candidate = &after[..end];
        if let Ok(value) = serde_json::from_str::<Value>(candidate.trim()) {
            if value.is_object() {
                return Some(value);
            }
        }
        rest = &after[end + marker.len()..];
    }
    None
}

fn decide_stop_message_skip(ctx: &StopMessageDecisionContext) -> Option<SkipReason> {
    if ctx.port_stop_message_disabled {
        return Some(SkipReason::PortDisabled);
    }
    if ctx.has_responses_submit_tool_outputs_resume {
        return Some(SkipReason::ResponsesSubmitToolOutputsResume);
    }
    if ctx.plan_mode_active {
        return Some(SkipReason::PlanMode);
    }
    if ctx.goal_status.is_active() {
        return Some(SkipReason::GoalActive);
    }
    if ctx
        .followup_flow_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|flow_id| !flow_id.is_empty())
        && !matches!(
            ctx.stop_message_followup_policy,
            Some(StopMessageFollowupPolicy::PreserveEligibility)
        )
    {
        return Some(SkipReason::ServertoolFollowupHop);
    }
    if ctx.persisted_snapshot.is_none() && ctx.runtime_snapshot.is_none() {
        if ctx.persisted_default_exhausted {
            return Some(SkipReason::GoalDefaultExhausted);
        }
        if matches!(ctx.explicit_mode, Some(StageMode::On)) {
            return Some(SkipReason::ExplicitModeWithoutSnapshot);
        }
    }
    if !ctx.stop_eligible {
        return Some(SkipReason::NotStopFinishReason);
    }
    if let Some(latest) = latest_finish_reason(ctx.finish_reasons.as_ref()) {
        if latest != "stop" {
            return Some(SkipReason::NotStopFinishReason);
        }
    }
    None
}

fn normalize_trigger_max_repeats(snapshot: &StopMessageSnapshot, default_max_repeats: u32) -> u32 {
    if snapshot.max_repeats > 0 {
        return snapshot.max_repeats;
    }
    if default_max_repeats > 0 {
        return default_max_repeats;
    }
    snapshot.used.saturating_add(1).max(1)
}

// ── Snapshot resolution ────────────────────────────────────────────────────

fn resolve_snapshot(ctx: &StopMessageDecisionContext) -> Option<StopMessageSnapshot> {
    if ctx.followup_flow_id.as_deref() == Some("stop_message_flow")
        && matches!(
            ctx.stop_message_followup_policy,
            Some(StopMessageFollowupPolicy::PreserveEligibility)
        )
    {
        if let Some(snapshot) = &ctx.runtime_snapshot {
            return Some(snapshot.clone());
        }
    }

    // 1. Try persisted snapshot first
    if let Some(snapshot) = &ctx.persisted_snapshot {
        return Some(snapshot.clone());
    }

    // 2. Try runtime snapshot
    if let Some(snapshot) = &ctx.runtime_snapshot {
        return Some(snapshot.clone());
    }

    // 3. Try default snapshot
    //    Create default when no snapshot exists, goal is not active,
    //    and current request is not an empty-reply-continue scenario.
    let should_use_default = !ctx.goal_status.is_active() && !ctx.empty_reply_continue_local;

    if should_use_default {
        if ctx.persisted_default_exhausted {
            return None;
        }
        if ctx.default_enabled {
            let next_used = 0; // default starts at 0
            return Some(StopMessageSnapshot {
                text: ctx.default_text.clone(),
                max_repeats: ctx.default_max_repeats,
                used: next_used,
                source: SnapshotSource::Default,
                stage_mode: StageMode::On,
            });
        }
    }

    None
}

fn latest_finish_reason(finish_reasons: Option<&Vec<String>>) -> Option<String> {
    let reasons = finish_reasons?;
    reasons.iter().rev().find_map(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_ascii_lowercase())
        }
    })
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn skip(reason: SkipReason) -> StopMessageDecision {
    StopMessageDecision {
        action: Action::Skip,
        skip_reason: Some(reason.as_str().to_string()),
        used: 0,
        max_repeats: 0,
        followup_text: None,
        provider_pin: None,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn base_ctx() -> StopMessageDecisionContext {
        StopMessageDecisionContext {
            port_stop_message_disabled: false,
            followup_flow_id: None,
            stop_message_followup_policy: None,
            stop_eligible: true,
            finish_reasons: Some(vec!["stop".to_string()]),
            has_responses_submit_tool_outputs_resume: false,
            persisted_snapshot: None,
            runtime_snapshot: None,
            persisted_default_exhausted: false,
            explicit_mode: None,
            goal_status: GoalStatus::Idle,
            plan_mode_active: false,
            default_enabled: true,
            default_max_repeats: 3,
            default_text: "继续执行".to_string(),
            empty_reply_continue_local: false,
            provider_pin: None,
        }
    }

    #[test]
    fn triggers_on_clean_stop_without_followup_context() {
        let result = decide(&base_ctx());
        assert_eq!(result.action, Action::Trigger);
        assert!(result.followup_text.is_some());
    }

    #[test]
    fn skips_when_port_disabled() {
        let mut ctx = base_ctx();
        ctx.port_stop_message_disabled = true;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(
            result.skip_reason.unwrap(),
            "skip_port_stopmessage_disabled"
        );
    }

    #[test]
    fn only_latest_finish_reason_is_considered() {
        let mut ctx = base_ctx();
        ctx.stop_eligible = true;
        ctx.finish_reasons = Some(vec!["stop".to_string(), "content_filter".to_string()]);
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_not_stop_finish_reason");
    }

    #[test]
    fn latest_non_empty_finish_reason_is_considered() {
        let mut ctx = base_ctx();
        ctx.stop_eligible = true;
        ctx.finish_reasons = Some(vec!["stop".to_string(), "   ".to_string()]);
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
    }

    #[test]
    fn triggers_when_no_followup_context_and_default_enabled() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = None; // NOT a followup context
        ctx.default_enabled = true; // Default is ON
        let result = decide(&ctx);
        // Default now applies even without followup flow context.
        assert_eq!(result.action, Action::Trigger);
        let text = result.followup_text.expect("followup text");
        assert!(text.contains("当前用户目标"));
        assert!(text.contains("目标"));
        assert!(text.contains("过程"));
        assert!(text.contains("证据"));
    }

    #[test]
    fn upgrades_legacy_default_followup_text_but_preserves_custom_text() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        let text = result.followup_text.expect("followup text");
        assert!(text.contains("当前用户目标"));
        assert!(text.contains("目标"));
        assert!(text.contains("过程"));
        assert!(text.contains("证据"));

        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 1,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        let text = result.followup_text.expect("followup text");
        assert!(text.contains("再次停止"));
        assert!(text.contains("目标"));
        assert!(text.contains("过程"));
        assert!(text.contains("证据"));
        assert!(text.contains("目标"));
        assert!(text.contains("过程"));
        assert!(text.contains("证据"));

        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 2,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        let text = result.followup_text.expect("followup text");
        assert!(text.contains("最后一次续杯预算"));
        assert!(text.contains("目标"));
        assert!(text.contains("过程"));
        assert!(text.contains("证据"));
        assert!(text.contains("目标"));
        assert!(text.contains("过程"));
        assert!(text.contains("证据"));

        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行，不要中断总结".to_string(),
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(
            result.followup_text,
            Some("继续执行，不要中断总结".to_string())
        );
    }

    #[test]
    fn triggers_when_persisted_snapshot_exists_even_without_followup_context() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = None;
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
    }

    #[test]
    fn skips_when_goal_active_with_persisted_snapshot() {
        let mut ctx = base_ctx();
        ctx.goal_status = GoalStatus::Active;
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_goal_active");
    }

    #[test]
    fn skips_when_plan_mode_active() {
        let mut ctx = base_ctx();
        ctx.plan_mode_active = true;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_plan_mode");
    }

    #[test]
    fn non_active_managed_goal_statuses_do_not_skip_stopless() {
        for status in [
            GoalStatus::Paused,
            GoalStatus::Stopped,
            GoalStatus::Completed,
        ] {
            let mut ctx = base_ctx();
            ctx.goal_status = status;
            ctx.persisted_snapshot = Some(StopMessageSnapshot {
                text: "继续执行".to_string(),
                max_repeats: 3,
                used: 0,
                source: SnapshotSource::Persisted,
                stage_mode: StageMode::On,
            });
            let result = decide(&ctx);
            assert_eq!(result.action, Action::Trigger);
        }
    }

    #[test]
    fn skips_when_goal_active_no_persisted_snapshot() {
        let mut ctx = base_ctx();
        ctx.goal_status = GoalStatus::Active;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_goal_active");
    }

    #[test]
    fn skips_when_used_equals_max_repeats() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 3,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_reached_max_repeats");
    }

    #[test]
    fn skips_when_used_exceeds_max_repeats() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 4,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_reached_max_repeats");
    }

    #[test]
    fn skips_when_stage_mode_is_off() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::Off,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_stopmessage_mode_off");
    }

    #[test]
    fn skips_when_text_is_empty() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "".to_string(),
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_stopmessage_empty_text");
    }

    #[test]
    fn skips_when_no_followup_context_and_not_eligible() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = None;
        ctx.stop_eligible = false;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_not_stop_finish_reason");
    }

    #[test]
    fn stop_message_followup_flow_can_retrigger_until_counter_exhausts() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = Some("stop_message_flow".to_string());
        ctx.stop_message_followup_policy = Some(StopMessageFollowupPolicy::PreserveEligibility);
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        assert_eq!(result.skip_reason, None);
    }

    #[test]
    fn skips_non_stop_message_followup_flow_to_prevent_generic_recursion() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = Some("apply_patch_flow".to_string());
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_servertool_followup_hop");
    }

    #[test]
    fn default_snapshot_uses_configured_values() {
        let mut ctx = base_ctx();
        ctx.default_text = "继续".to_string();
        ctx.default_max_repeats = 5;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        assert_eq!(result.followup_text.unwrap(), "继续");
        assert_eq!(result.max_repeats, 5);
    }

    #[test]
    fn explicit_mode_on_without_snapshot_skips() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = None;
        ctx.persisted_snapshot = None;
        ctx.runtime_snapshot = None;
        ctx.explicit_mode = Some(StageMode::On);
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(
            result.skip_reason.unwrap(),
            "skip_explicit_mode_without_snapshot"
        );
    }

    #[test]
    fn default_exhausted_tombstone_skips() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = None;
        ctx.runtime_snapshot = None;
        ctx.persisted_default_exhausted = true;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_goal_default_exhausted");
    }

    #[test]
    fn persists_provider_pin_in_decision() {
        let mut ctx = base_ctx();
        ctx.provider_pin = Some(ProviderPin {
            provider_key: Some("mini27.key1.MiniMax-M2.7".to_string()),
            model_id: Some("MiniMax-M2.7".to_string()),
            routecodex_port_mode: Some("router".to_string()),
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        let pin = result.provider_pin.unwrap();
        assert_eq!(pin.provider_key.unwrap(), "mini27.key1.MiniMax-M2.7");
    }

    #[test]
    fn runtime_snapshot_is_used_when_no_persisted() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = None;
        ctx.runtime_snapshot = Some(StopMessageSnapshot {
            text: "继续".to_string(),
            max_repeats: 2,
            used: 1,
            source: SnapshotSource::Default,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        assert_eq!(result.used, 1);
        assert_eq!(result.max_repeats, 2);
    }

    #[test]
    fn persisted_snapshot_takes_precedence_over_runtime() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "persisted".to_string(),
            max_repeats: 5,
            used: 2,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        ctx.runtime_snapshot = Some(StopMessageSnapshot {
            text: "runtime".to_string(),
            max_repeats: 2,
            used: 0,
            source: SnapshotSource::Default,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        // Persisted wins over runtime
        assert_eq!(result.followup_text.unwrap(), "persisted");
        assert_eq!(result.max_repeats, 5);
        assert_eq!(result.used, 2);
    }

    #[test]
    fn stop_message_followup_runtime_snapshot_overrides_exhausted_persisted_snapshot() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = Some("stop_message_flow".to_string());
        ctx.stop_message_followup_policy = Some(StopMessageFollowupPolicy::PreserveEligibility);
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "persisted".to_string(),
            max_repeats: 1,
            used: 1,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        ctx.runtime_snapshot = Some(StopMessageSnapshot {
            text: "runtime".to_string(),
            max_repeats: 3,
            used: 1,
            source: SnapshotSource::Default,
            stage_mode: StageMode::On,
        });

        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        assert_eq!(result.followup_text.unwrap(), "runtime");
        assert_eq!(result.max_repeats, 3);
        assert_eq!(result.used, 1);
    }

    #[test]
    fn stop_schema_finished_or_blocked_with_reason_allows_stop() {
        let finished = evaluate_stop_schema_gate(
            r#"Done {"stopreason":0,"reason":"已完成并验证","has_evidence":1,"next_step":"","learned":"缺 schema 不计预算"}"#,
            0,
            3,
        );
        assert_eq!(finished.action, StopSchemaGateAction::AllowStop);
        assert!(finished.summary_prefix.unwrap().contains("已完成并验证"));
        assert_eq!(
            finished
                .parsed
                .as_ref()
                .and_then(|row| row.learned.as_deref()),
            Some("缺 schema 不计预算")
        );

        let blocked = evaluate_stop_schema_gate(
            r#"{"stopreason":1,"reason":"缺少上游权限","has_evidence":1,"next_step":"等待授权"}"#,
            0,
            3,
        );
        assert_eq!(blocked.action, StopSchemaGateAction::AllowStop);
        assert!(blocked.summary_prefix.unwrap().contains("缺少上游权限"));
    }

    #[test]
    fn stop_schema_finished_or_blocked_without_reason_follows_up() {
        let decision = evaluate_stop_schema_gate(
            r#"{"stopreason":0,"reason":"","has_evidence":1,"next_step":""}"#,
            0,
            3,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_reason_missing");
        assert!(decision.count_budget);
        assert!(decision.followup_text.unwrap().contains("没有给 reason"));
    }

    #[test]
    fn stop_schema_continue_needed_with_next_step_follows_up_to_execute_next_step() {
        let decision = evaluate_stop_schema_gate(
            r#"```json
{"stopreason":2,"reason":"还没完成","has_evidence":0,"next_step":"运行 targeted tests"}
```"#,
            1,
            3,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_continue_next_step");
        let text = decision.followup_text.unwrap();
        assert!(text.contains("运行 targeted tests"));
        assert!(text.contains("立即调用工具执行这个下一步"));
        assert!(text.contains("目标/过程/证据"));
        assert!(!text.contains("质询"));
        assert!(decision.count_budget);
    }

    #[test]
    fn stop_schema_missing_invalid_or_no_next_step_follows_up() {
        let missing = evaluate_stop_schema_gate("普通停止文本", 0, 3);
        assert_eq!(missing.action, StopSchemaGateAction::Followup);
        assert_eq!(missing.reason_code, "stop_schema_missing");
        assert!(!missing.count_budget);
        assert!(!missing.followup_text.unwrap().contains("质询"));

        let invalid = evaluate_stop_schema_gate(
            r#"{"stopreason":"finished","reason":"done","has_evidence":1,"next_step":""}"#,
            0,
            3,
        );
        assert_eq!(invalid.action, StopSchemaGateAction::Followup);
        assert_eq!(
            invalid.reason_code,
            "stop_schema_stopreason_missing_or_non_numeric"
        );
        assert!(invalid.count_budget);

        let no_next = evaluate_stop_schema_gate(
            r#"{"stopreason":2,"reason":"继续","has_evidence":0,"next_step":""}"#,
            0,
            3,
        );
        assert_eq!(no_next.action, StopSchemaGateAction::Followup);
        assert_eq!(no_next.reason_code, "stop_schema_next_step_missing");
        assert!(no_next.count_budget);
    }

    #[test]
    fn stop_schema_missing_never_exhausts_budget() {
        let decision = evaluate_stop_schema_gate("普通停止文本", 99, 3);
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_missing");
        assert!(!decision.count_budget);
    }

    #[test]
    fn stop_schema_invalid_exhausts_budget_but_valid_stop_does_not() {
        let invalid = evaluate_stop_schema_gate(
            r#"{"stopreason":2,"reason":"继续","has_evidence":0,"next_step":"运行测试"}"#,
            3,
            3,
        );
        assert_eq!(invalid.action, StopSchemaGateAction::FailFast);
        assert_eq!(invalid.reason_code, "stop_schema_budget_exhausted");
        assert!(invalid.count_budget);
        assert!(invalid.followup_text.is_none());

        let valid = evaluate_stop_schema_gate(
            r#"{"stopreason":0,"reason":"测试通过","has_evidence":1,"evidence":"cargo test green","next_step":""}"#,
            3,
            3,
        );
        assert_eq!(valid.action, StopSchemaGateAction::AllowStop);
        assert_eq!(valid.reason_code, "stop_schema_finished");
        assert!(!valid.count_budget);
    }

    #[test]
    fn detects_goal_active_repeated_stop_text() {
        let input = GoalActiveStopLoopInput {
            assistant_text: "立刻跑全测试 + 远端验证。".to_string(),
            threshold: Some(3),
            captured_request: serde_json::json!({
                "input": [
                    {
                        "role": "user",
                        "content": [{
                            "type": "input_text",
                            "text": "<codex_internal_context source=\"goal\">\nContinue working toward the active thread goal.\n<objective>完成验证</objective>"
                        }]
                    },
                    { "role": "assistant", "content": [{ "type": "output_text", "text": "立刻跑全测试 + 远端验证。" }] },
                    { "role": "user", "content": [{ "type": "input_text", "text": "Continue working toward the active thread goal." }] },
                    { "role": "assistant", "content": [{ "type": "output_text", "text": "立刻跑全测试 + 远端验证。" }] }
                ]
            }),
        };

        let decision = evaluate_goal_active_stop_loop(&input);

        assert!(decision.loop_detected);
        assert_eq!(decision.repeat_count, 3);
        assert_eq!(decision.reason_code, "goal_active_repeated_stop");
    }

    #[test]
    fn goal_active_loop_guard_resets_on_tool_signal() {
        let input = GoalActiveStopLoopInput {
            assistant_text: "立刻跑全测试 + 远端验证。".to_string(),
            threshold: Some(3),
            captured_request: serde_json::json!({
                "input": [
                    { "role": "user", "content": "Continue working toward the active thread goal." },
                    { "role": "assistant", "tool_calls": [{ "id": "call_1" }], "content": "" },
                    { "role": "assistant", "content": "立刻跑全测试 + 远端验证。" }
                ]
            }),
        };

        let decision = evaluate_goal_active_stop_loop(&input);

        assert!(!decision.loop_detected);
        assert_eq!(decision.repeat_count, 0);
        assert_eq!(decision.goal_context_count, 0);
        assert_eq!(decision.reason_code, "goal_active_stop_no_goal_context");
    }

    #[test]
    fn historical_goal_context_does_not_mark_current_request_goal_active() {
        let input = GoalActiveStopLoopInput {
            assistant_text: "当前普通停止。".to_string(),
            threshold: Some(3),
            captured_request: serde_json::json!({
                "input": [
                    { "role": "user", "content": "<goal_context>\nContinue working toward the active thread goal.\n<objective>旧目标</objective>\n</goal_context>" },
                    { "role": "assistant", "content": "历史回复" },
                    { "role": "user", "content": "继续执行" },
                    { "role": "assistant", "content": "当前普通停止。" }
                ]
            }),
        };

        let decision = evaluate_goal_active_stop_loop(&input);

        assert!(!decision.loop_detected);
        assert_eq!(decision.goal_context_count, 0);
        assert_eq!(decision.reason_code, "goal_active_stop_no_goal_context");
    }
}
