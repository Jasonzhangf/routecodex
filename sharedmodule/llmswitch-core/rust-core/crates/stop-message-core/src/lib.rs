//! Stop-message decision core — pure Rust, no NAPI dependency.
//!
//! This crate implements the decision logic for `stop_message_auto` servertool handler.
//! The TS shell collects context, calls `decide()`, and acts on the result.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const STOP_SCHEMA_LOOP_GUARD_MAX_REPEATS: u32 = 3;
const STOP_SCHEMA_JSON_EXAMPLE: &str = r#"必须在回复末尾附一个 JSON 对象，字段名和类型必须一致：
{"stopreason":2,"reason":"当前状态原因","has_evidence":0,"evidence":"","issue_cause":"","excluded_factors":"","diagnostic_order":"","done_steps":"","next_step":"如果仍需继续，写立刻执行的下一步；否则空字符串","next_suggested_path":"","needs_user_input":false,"learned":""}
字段规则：stopreason 只能是数字，0=finished，1=blocked，2=continue_needed；has_evidence 只能是 0 或 1；needs_user_input=true 只用于需要问用户一个简单问题，此时 next_step 必须写问题内容。"#;

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
    pub provider_key: Option<String>,
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
    pub stop_eligible: bool,
    /// Deprecated carrier kept for input compatibility. Finish reason truth is
    /// owned by chat process stop-gateway classification.
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
    pub forcestop: Option<u8>,
    pub reason: Option<String>,
    pub next_step: Option<String>,
    pub next_suggested_path: Option<String>,
    pub evidence: Option<String>,
    pub done_steps: Option<String>,
    pub learned: Option<String>,
    pub issue_cause: Option<String>,
    pub excluded_factors: Option<String>,
    pub diagnostic_order: Option<String>,
    pub needs_user_input: Option<bool>,
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
    pub max_repeats: u32,
    pub missing_fields: Vec<String>,
    pub no_change_count: u32,
    pub observation_hash: String,
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
        followup_text: None,
        provider_pin: ctx.provider_pin.clone(),
    }
}

pub fn evaluate_stop_schema_gate(
    assistant_text: &str,
    used: u32,
    max_repeats: u32,
    prev_observation_hash: &str,
    prev_no_change_count: u32,
) -> StopSchemaGateDecision {
    let provided_cap = stop_schema_provided_max_repeats(max_repeats);
    let loop_guard_cap = STOP_SCHEMA_LOOP_GUARD_MAX_REPEATS;
    let parsed = match parse_stop_schema(assistant_text) {
        Some(parsed) => parsed,
        None => {
            let missing = vec!["stopreason".to_string(), "reason".to_string(), "has_evidence".to_string(), "evidence".to_string(), "issue_cause".to_string(), "excluded_factors".to_string(), "diagnostic_order".to_string(), "done_steps".to_string(), "next_step".to_string(), "next_suggested_path".to_string(), "needs_user_input".to_string(), "learned".to_string()];
            let observation_hash = compute_schema_observation_hash("stop_schema_missing", None, None, None, &missing);
            let no_change_count = resolve_no_change_count("stop_schema_missing", None, None, None, &missing, prev_observation_hash, prev_no_change_count);
            return schema_missing_followup(
                "stop_schema_missing",
                used,
                loop_guard_cap,
                &format!("本轮缺少 stop schema。请补齐缺失字段后再判断；若缺文件、日志、命令输出或测试证据，优先调用 exec_command 继续验证。{}", STOP_SCHEMA_JSON_EXAMPLE),
                missing,
                no_change_count,
                observation_hash,
            );
        }
    };

    if parsed.forcestop == Some(1) {
        let reason = parsed.reason.as_deref().map(str::trim).unwrap_or("");
        if reason.is_empty() {
            let missing = vec!["reason".to_string()];
            let observation_hash = compute_schema_observation_hash("stop_schema_forcestop_reason_missing", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing);
            let no_change_count = resolve_no_change_count("stop_schema_forcestop_reason_missing", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing, prev_observation_hash, prev_no_change_count);
            return schema_invalid_followup(
                "stop_schema_forcestop_reason_missing",
                used,
                provided_cap,
                "forcestop=1 只能在不得已必须强制停止时使用，而且必须填写非空 reason 说明为什么现在必须停；reason 不校验格式，但不能为空。",
                parsed,
                missing,
                no_change_count,
                observation_hash,
            );
        }
        return StopSchemaGateDecision {
            max_repeats: provided_cap,
            action: StopSchemaGateAction::AllowStop,
            reason_code: "stop_schema_forcestop".to_string(),
            summary_prefix: Some(format!("## 强制停止\n\n{}\n", reason)),
            followup_text: None,
            count_budget: false,
            missing_fields: vec![],
            no_change_count: 0,
            observation_hash: String::new(),
            parsed: Some(parsed),
        };
    }

    let stopreason = match parsed.stopreason {
        Some(v) => v,
        None => {
            let missing = vec!["stopreason".to_string()];
            let observation_hash = compute_schema_observation_hash("stop_schema_stopreason_missing_or_non_numeric", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing);
            let no_change_count = resolve_no_change_count("stop_schema_stopreason_missing_or_non_numeric", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing, prev_observation_hash, prev_no_change_count);
            return schema_invalid_followup(
                "stop_schema_stopreason_missing_or_non_numeric",
                used,
                provided_cap,
                &format!("stop schema 的 stopreason 必须是数字 0/1/2。当前缺少 stopreason，请只补这个字段后再判断；若仍需继续，stopreason=2 并给出 next_step 后继续执行。{}", STOP_SCHEMA_JSON_EXAMPLE),
                parsed,
                missing,
                no_change_count,
                observation_hash,
            );
        }
    };

    if parsed.needs_user_input.unwrap_or(false) {
        let next_step_raw = parsed.next_step.as_deref().map(str::trim).unwrap_or("");
        if next_step_raw.is_empty() {
            let missing = vec!["next_step".to_string()];
            let observation_hash = compute_schema_observation_hash("stop_schema_needs_user_input_missing_next_step", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing);
            let no_change_count = resolve_no_change_count("stop_schema_needs_user_input_missing_next_step", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing, prev_observation_hash, prev_no_change_count);
            return schema_invalid_followup(
                "stop_schema_needs_user_input_missing_next_step",
                used,
                provided_cap,
                "你声明需要向用户提问（needs_user_input=true），但没有给出问题内容。请只补 next_step 中的问题，然后允许停止等待用户回答。",
                parsed,
                missing,
                no_change_count,
                observation_hash,
            );
        }
        return StopSchemaGateDecision {
            max_repeats: provided_cap,
            action: StopSchemaGateAction::AllowStop,
            reason_code: "stop_schema_needs_user_input".to_string(),
            summary_prefix: Some(format!("## 需要确认

{}
", next_step_raw)),
            followup_text: None,
            count_budget: false,
            missing_fields: vec![],
            no_change_count: 0,
            observation_hash: String::new(),
            parsed: Some(parsed),
        };
    }

    if stopreason == 0 || stopreason == 1 {
        let reason = parsed.reason.as_deref().map(str::trim).unwrap_or("");
        if reason.is_empty() {
            let missing = vec!["reason".to_string()];
            let observation_hash = compute_schema_observation_hash("stop_schema_reason_missing", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing);
            let no_change_count = resolve_no_change_count("stop_schema_reason_missing", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing, prev_observation_hash, prev_no_change_count);
            return schema_invalid_followup(
                "stop_schema_reason_missing",
                used,
                provided_cap,
                "你声明 finished/blocked，但没有给 reason。请只补 reason：完成/阻塞对应哪个用户目标、做过哪些验证、证据是什么、原因在哪里、已排除哪些因素、排查顺序是什么。",
                parsed,
                missing,
                no_change_count,
                observation_hash,
            );
        }
        let missing = terminal_missing_fields(&parsed);
        if !missing.is_empty() {
            let observation_hash = compute_schema_observation_hash("stop_schema_terminal_missing_fields", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing);
            let no_change_count = resolve_no_change_count("stop_schema_terminal_missing_fields", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing, prev_observation_hash, prev_no_change_count);
            return schema_invalid_followup(
                "stop_schema_terminal_missing_fields",
                used,
                provided_cap,
                &format!("你声明 finished/blocked，但还缺这些字段：{}。请只补缺失字段，不要重写其它已通过字段。", missing.join(", ")),
                parsed,
                missing,
                no_change_count,
                observation_hash,
            );
        }
        let summary_prefix = build_allow_stop_summary_prefix_from_parsed(&parsed, stopreason, reason);
        return StopSchemaGateDecision {
            max_repeats: provided_cap,
            action: StopSchemaGateAction::AllowStop,
            reason_code: if stopreason == 0 {
                "stop_schema_finished".to_string()
            } else {
                "stop_schema_blocked".to_string()
            },
            summary_prefix: Some(summary_prefix),
            followup_text: None,
            count_budget: false,
            missing_fields: vec![],
            no_change_count: 0,
            observation_hash: String::new(),
            parsed: Some(parsed),
        };
    }

    let next_step = parsed
        .next_step
        .clone()
        .unwrap_or_default()
        .trim()
        .to_string();
    let next_suggested_path = parsed
        .next_suggested_path
        .as_deref()
        .map(str::trim)
        .unwrap_or("");
    if !next_step.is_empty() {
        let missing_fields = remaining_missing_fields(&parsed);
        let observation_hash = compute_schema_observation_hash("stop_schema_continue_next_step", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing_fields);
        let no_change_count = resolve_no_change_count("stop_schema_continue_next_step", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing_fields, prev_observation_hash, prev_no_change_count);
        return schema_followup(
            "stop_schema_continue_next_step",
            used,
            provided_cap,
            next_step.as_str(),
            Some(parsed),
            true,
            missing_fields,
            no_change_count,
            observation_hash,
        );
    }

    if next_suggested_path.is_empty() {
        if used >= provided_cap {
            let reason = parsed.reason.as_deref().map(str::trim).unwrap_or("");
            let fallback_reason = if reason.is_empty() {
                "任务尚未完成，但已无法给出明确下一步；请输出当前收尾总结并停止"
            } else {
                reason
            };
            let summary_prefix = build_allow_stop_summary_prefix_from_parsed(&parsed, stopreason, fallback_reason);
            return StopSchemaGateDecision {
                max_repeats: provided_cap,
                action: StopSchemaGateAction::AllowStop,
                reason_code: "stop_schema_continue_without_next_step".to_string(),
                summary_prefix: Some(summary_prefix),
                followup_text: None,
                count_budget: false,
                missing_fields: vec![],
                no_change_count: 0,
                observation_hash: String::new(),
                parsed: Some(parsed),
            };
        }
        let missing_fields = remaining_missing_fields(&parsed);
        let observation_hash = compute_schema_observation_hash("stop_schema_next_step_missing", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing_fields);
        let no_change_count = resolve_no_change_count("stop_schema_next_step_missing", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing_fields, prev_observation_hash, prev_no_change_count);
        return schema_followup(
            "stop_schema_next_step_missing",
            used,
            provided_cap,
            &format!("任务还没完成，但你没有给出明确下一步。请只补缺失字段：{}。若仍无法给出明确下一步，下一轮允许直接停止。{}", missing_fields.join(", "), STOP_SCHEMA_JSON_EXAMPLE),
            Some(parsed),
            true,
            missing_fields,
            no_change_count,
            observation_hash,
        );
    }

    let missing_fields = remaining_missing_fields(&parsed);
    let observation_hash = compute_schema_observation_hash("stop_schema_next_step_missing", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing_fields);
    let no_change_count = resolve_no_change_count("stop_schema_next_step_missing", parsed.stopreason, parsed.reason.as_deref(), parsed.next_step.as_deref(), &missing_fields, prev_observation_hash, prev_no_change_count);
    schema_invalid_followup(
        "stop_schema_next_step_missing",
        used,
        provided_cap,
        "你没有提供 next_step，但仍给出了建议推进路径。若要继续，必须把当前最小下一步写入 next_step 并立即执行；否则直接停止并输出收尾总结。",
        parsed,
        missing_fields,
        no_change_count,
        observation_hash,
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
    effective_max: u32,
    message: &str,
    parsed: StopSchemaParsed,
    missing_fields: Vec<String>,
    no_change_count: u32,
    observation_hash: String,
) -> StopSchemaGateDecision {
    if no_change_count >= STOP_SCHEMA_LOOP_GUARD_MAX_REPEATS {
        return StopSchemaGateDecision {
            max_repeats: effective_max,
            action: StopSchemaGateAction::FailFast,
            reason_code: "stop_schema_budget_exhausted".to_string(),
            summary_prefix: None,
            followup_text: None,
            count_budget: true,
            missing_fields,
            no_change_count,
            observation_hash,
            parsed: Some(parsed),
        };
    }
    schema_followup(
        reason_code,
        used,
        effective_max,
        message,
        Some(parsed),
        true,
        missing_fields,
        no_change_count,
        observation_hash,
    )
}

fn schema_missing_followup(
    reason_code: &str,
    used: u32,
    effective_max: u32,
    message: &str,
    missing_fields: Vec<String>,
    no_change_count: u32,
    observation_hash: String,
) -> StopSchemaGateDecision {
    if no_change_count >= STOP_SCHEMA_LOOP_GUARD_MAX_REPEATS {
        return StopSchemaGateDecision {
            max_repeats: effective_max,
            action: StopSchemaGateAction::FailFast,
            reason_code: "stop_schema_budget_exhausted".to_string(),
            summary_prefix: None,
            followup_text: None,
            count_budget: true,
            missing_fields,
            no_change_count,
            observation_hash,
            parsed: None,
        };
    }
    schema_followup(reason_code, used, effective_max, message, None, true, missing_fields, no_change_count, observation_hash)
}

fn stop_schema_provided_max_repeats(max_repeats: u32) -> u32 {
    if max_repeats > 0 {
        return max_repeats.min(STOP_SCHEMA_LOOP_GUARD_MAX_REPEATS);
    }
    STOP_SCHEMA_LOOP_GUARD_MAX_REPEATS
}

/// Build the final allow-stop summary prefix.
///
pub fn build_allow_stop_summary_prefix_from_history(
    current_reason: &str,
    _history: &[String],
) -> String {
    let mut out = String::new();
    out.push_str("## 完成内容\n\n");
    out.push_str(current_reason.trim());
    out.push('\n');
    out
}

fn push_markdown_field(out: &mut String, label: &str, value: Option<&String>) {
    let text = value.map(|v| v.trim()).unwrap_or("");
    if text.is_empty() {
        return;
    }
    out.push_str("- ");
    out.push_str(label);
    out.push_str(": ");
    out.push_str(text);
    out.push('\n');
}

fn build_allow_stop_summary_prefix_from_parsed(
    parsed: &StopSchemaParsed,
    stopreason: u8,
    fallback_reason: &str,
) -> String {
    let title = if stopreason == 1 {
        "## 当前结果"
    } else {
        "## 完成内容"
    };
    let mut out = String::new();
    out.push_str(title);
    out.push_str("\n\n");
    push_markdown_field(&mut out, "结论", parsed.reason.as_ref());
    if parsed.reason.is_none() && !fallback_reason.trim().is_empty() {
        out.push_str("- 结论: ");
        out.push_str(fallback_reason.trim());
        out.push('\n');
    }
    push_markdown_field(&mut out, "已完成", parsed.done_steps.as_ref());
    push_markdown_field(&mut out, "证据", parsed.evidence.as_ref());
    push_markdown_field(&mut out, "问题原因", parsed.issue_cause.as_ref());
    push_markdown_field(&mut out, "已排除因素", parsed.excluded_factors.as_ref());
    push_markdown_field(&mut out, "排查顺序", parsed.diagnostic_order.as_ref());
    push_markdown_field(&mut out, "建议下一步", parsed.next_suggested_path.as_ref());
    if out.trim() == title && !fallback_reason.trim().is_empty() {
        out.push_str(fallback_reason.trim());
        out.push('\n');
    }
    out.push('\n');
    out
}

fn schema_followup(
    reason_code: &str,
    used: u32,
    effective_max: u32,
    message: &str,
    parsed: Option<StopSchemaParsed>,
    count_budget: bool,
    missing_fields: Vec<String>,
    no_change_count: u32,
    observation_hash: String,
) -> StopSchemaGateDecision {
    let mut text = String::new();
    if reason_code == "stop_schema_continue_next_step" {
        text.push_str(message);
    } else if used.saturating_add(1) >= effective_max
    {
        text.push_str("这次不要再泛泛地说了。把还能验证的文件、日志、命令都直接补完；如果还是收不住，就明确写清楚卡点、已经排除的路、以及还差我拍板的那一步。\n");
        text.push_str("\n\n最终收尾 schema 缺失：不要复述 stopless/校验过程；直接给用户可读 summary，包含已完成事项、未完成事项、阻塞点/问题原因、已排除因素、建议下一步，并在末尾附 stop schema。\n");
        text.push_str(STOP_SCHEMA_JSON_EXAMPLE);
    } else {
        text.push_str("继续做下一步；先把手头能确认的结果拿回来。\n");
        text.push_str("\n\nStop schema 校验未通过：");
        text.push_str(message);
    }
    StopSchemaGateDecision {
        max_repeats: effective_max,
        action: StopSchemaGateAction::Followup,
        reason_code: reason_code.to_string(),
        summary_prefix: None,
        followup_text: Some(text),
        count_budget,
        missing_fields,
        no_change_count,
        observation_hash,
        parsed,
    }
}

fn terminal_missing_fields(parsed: &StopSchemaParsed) -> Vec<String> {
    let mut missing = Vec::new();
    if parsed.reason.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("reason".to_string());
    }
    if parsed.has_evidence != Some(1) {
        missing.push("has_evidence".to_string());
    }
    if parsed.evidence.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("evidence".to_string());
    }
    if parsed.done_steps.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("done_steps".to_string());
    }
    if parsed.issue_cause.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("issue_cause".to_string());
    }
    if parsed.excluded_factors.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("excluded_factors".to_string());
    }
    if parsed.diagnostic_order.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("diagnostic_order".to_string());
    }
    missing
}

fn remaining_missing_fields(parsed: &StopSchemaParsed) -> Vec<String> {
    let mut missing = Vec::new();
    if parsed.stopreason.is_none() {
        missing.push("stopreason".to_string());
    }
    if parsed.reason.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("reason".to_string());
    }
    if parsed.has_evidence.is_none() {
        missing.push("has_evidence".to_string());
    }
    if parsed.evidence.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("evidence".to_string());
    }
    if parsed.done_steps.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("done_steps".to_string());
    }
    if parsed.issue_cause.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("issue_cause".to_string());
    }
    if parsed.excluded_factors.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("excluded_factors".to_string());
    }
    if parsed.diagnostic_order.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("diagnostic_order".to_string());
    }
    if parsed.next_step.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("next_step".to_string());
    }
    if parsed.next_suggested_path.as_deref().map(str::trim).unwrap_or("").is_empty() {
        missing.push("next_suggested_path".to_string());
    }
    missing
}


/// Compute the schema-observation hash (sha256 of schema-relevant fields, no assistantStopText).
/// This makes no_change_count stable across similar schema errors.
fn compute_schema_observation_hash(
    reason_code: &str,
    stopreason: Option<u8>,
    reason: Option<&str>,
    next_step: Option<&str>,
    missing_fields: &[String],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(reason_code.as_bytes());
    hasher.update(b"\x00");
    if let Some(sr) = stopreason {
        hasher.update([sr]);
    }
    hasher.update(b"\x00");
    if let Some(r) = reason {
        hasher.update(r.as_bytes());
    }
    hasher.update(b"\x00");
    if let Some(ns) = next_step {
        hasher.update(ns.as_bytes());
    }
    hasher.update(b"\x00");
    let mut sorted = missing_fields.to_vec();
    sorted.sort();
    for field in sorted {
        hasher.update(field.as_bytes());
        hasher.update(b"\x00");
    }
    let bytes = hasher.finalize();
    let mut hex = String::with_capacity(bytes.len() * 2);
    for &b in bytes.iter() {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

/// Resolve no_change_count given previous hash/count and current schema fields.
fn resolve_no_change_count(
    reason_code: &str,
    stopreason: Option<u8>,
    reason: Option<&str>,
    next_step: Option<&str>,
    missing_fields: &[String],
    prev_hash: &str,
    prev_count: u32,
) -> u32 {
    let current_hash = compute_schema_observation_hash(
        reason_code, stopreason, reason, next_step, missing_fields,
    );
    if current_hash == prev_hash {
        prev_count.saturating_add(1)
    } else {
        1
    }
}

fn parse_stop_schema(text: &str) -> Option<StopSchemaParsed> {
    let value = parse_first_stop_schema_json_object(text)?;
    let row = value.as_object()?;
    Some(StopSchemaParsed {
        stopreason: read_u8(row.get("stopreason")),
        has_evidence: read_u8(row.get("has_evidence")),
        forcestop: read_u8(row.get("forcestop")),
        reason: read_string(row.get("reason")),
        next_step: read_string(row.get("next_step")),
        next_suggested_path: read_string(row.get("next_suggested_path")),
        evidence: read_string(row.get("evidence")),
        done_steps: read_string(row.get("done_steps")),
        learned: read_string(row.get("learned")),
        issue_cause: read_string(row.get("issue_cause")),
        excluded_factors: read_string(row.get("excluded_factors")),
        diagnostic_order: read_string(row.get("diagnostic_order")),
        needs_user_input: row.get("needs_user_input").and_then(|v| v.as_bool()),
    })
}

fn parse_first_stop_schema_json_object(text: &str) -> Option<Value> {
    parse_json_objects(text)
        .into_iter()
        .find(|value| value.get("stopreason").is_some() || value.get("forcestop").is_some())
}

fn read_u8(value: Option<&Value>) -> Option<u8> {
    value.and_then(|v| {
        if let Some(n) = v.as_u64() {
            return if n <= u8::MAX as u64 {
                Some(n as u8)
            } else {
                None
            };
        }
        let text = v.as_str()?.trim().to_lowercase();
        match text.as_str() {
            "0" | "finished" | "finish" | "done" => Some(0),
            "1" | "blocked" | "block" => Some(1),
            "2" | "continue" | "continue_needed" | "next" => Some(2),
            _ => None,
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

fn parse_json_objects(text: &str) -> Vec<Value> {
    let mut values = Vec::new();
    if let Some(value) = parse_fenced_json_object(text) {
        values.push(value);
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
                            values.push(value);
                        }
                    }
                    break;
                }
            }
        }
    }
    values
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
    if let Some(flow_id) = ctx.followup_flow_id.as_deref() {
        if flow_id != "stop_message_flow" {
            return Some(SkipReason::ServertoolFollowupHop);
        }
    }
    if matches!(ctx.explicit_mode, Some(StageMode::Off)) {
        return Some(SkipReason::ExplicitModeOff);
    }
    if ctx.plan_mode_active {
        return Some(SkipReason::PlanMode);
    }
    if ctx.goal_status.is_active() {
        return Some(SkipReason::GoalActive);
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
    let current_provider_key = ctx
        .provider_pin
        .as_ref()
        .and_then(|pin| pin.provider_key.as_ref())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    let mut reset_seed: Option<StopMessageSnapshot> = None;

    // 1. Try persisted snapshot first
    if let Some(snapshot) = &ctx.persisted_snapshot {
        if is_provider_continuous(snapshot.provider_key.as_deref(), current_provider_key) {
            return Some(snapshot.clone());
        }
        reset_seed = Some(reset_snapshot_for_current_provider(
            snapshot,
            current_provider_key,
        ));
    }

    // 2. Try runtime snapshot
    if let Some(snapshot) = &ctx.runtime_snapshot {
        if is_provider_continuous(snapshot.provider_key.as_deref(), current_provider_key) {
            return Some(snapshot.clone());
        }
        if reset_seed.is_none() {
            reset_seed = Some(reset_snapshot_for_current_provider(
                snapshot,
                current_provider_key,
            ));
        }
    }

    if let Some(snapshot) = reset_seed {
        return Some(snapshot);
    }

    // 3. Try default snapshot when no usable snapshot exists and goal is not active.
    // Provider mismatch intentionally resets the consecutive-stop budget.
    let should_use_default = !ctx.goal_status.is_active();

    if should_use_default {
        if ctx.persisted_default_exhausted {
            return None;
        }
        if ctx.default_enabled {
            let next_used = 0; // default starts at 0
            return Some(StopMessageSnapshot {
                text: ctx.default_text.clone(),
                provider_key: current_provider_key.map(str::to_string),
                max_repeats: ctx.default_max_repeats,
                used: next_used,
                source: SnapshotSource::Default,
                stage_mode: StageMode::On,
            });
        }
    }

    None
}

fn reset_snapshot_for_current_provider(
    snapshot: &StopMessageSnapshot,
    current_provider_key: Option<&str>,
) -> StopMessageSnapshot {
    let mut next = snapshot.clone();
    next.provider_key = current_provider_key.map(str::to_string);
    next.used = 0;
    next
}

fn is_provider_continuous(
    snapshot_provider_key: Option<&str>,
    current_provider_key: Option<&str>,
) -> bool {
    match (
        snapshot_provider_key
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        current_provider_key,
    ) {
        (Some(snapshot_provider), Some(current_provider)) => snapshot_provider == current_provider,
        (Some(_), None) => false,
        _ => true,
    }
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
            provider_pin: None,
        }
    }

    #[test]
    fn triggers_on_clean_stop_without_followup_context() {
        let result = decide(&base_ctx());
        assert_eq!(result.action, Action::Trigger);
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
    fn stopless_decision_uses_chatprocess_stop_gateway_not_ts_finish_reason_scan() {
        let mut ctx = base_ctx();
        ctx.stop_eligible = true;
        ctx.finish_reasons = Some(vec!["stop".to_string(), "content_filter".to_string()]);
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
    }

    #[test]
    fn deprecated_finish_reason_carrier_does_not_override_stop_gateway() {
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
        assert!(text.contains("stop schema"));
    }

    #[test]
    fn allow_stop_summary_prefix_does_not_expose_internal_followup_history() {
        let history: Vec<String> = (1..=3)
            .map(|i| format!("续杯 #{}: 你需要继续执行", i))
            .collect();
        let prefix =
            build_allow_stop_summary_prefix_from_history("目标已完成，全部轮次均已恢复", &history);
        assert!(prefix.contains("## 完成内容"));
        assert!(prefix.contains("目标已完成，全部轮次均已恢复"));
        assert!(!prefix.contains("停止原因"));
        for entry in &history {
            assert!(
                !prefix.contains(entry.as_str()),
                "leaked history entry: {}",
                entry
            );
        }
        assert!(!prefix.contains("过去 stop 续杯注入"));
    }

    #[test]
    fn finished_with_evidence_allows_immediate_stop() {
        let text = r#"总结
{"stopreason":0,"reason":"任务已完成","has_evidence":1,"evidence":"tests passed","issue_cause":"需求已满足","excluded_factors":"无关路径已排除","diagnostic_order":"代码->测试->结果","done_steps":"完成修改并验证","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":""}"#;
        let result = evaluate_stop_schema_gate(text, 0, 3, "", 0);
        assert_eq!(result.action, StopSchemaGateAction::AllowStop);
        assert_eq!(result.reason_code, "stop_schema_finished");
        assert_eq!(result.count_budget, false);
        assert!(result.missing_fields.is_empty());
    }

    #[test]
    fn missing_reason_requests_reason_only() {
        let text = r#"总结
{"stopreason":0,"has_evidence":1,"evidence":"tests passed","issue_cause":"需求已满足","excluded_factors":"无关路径已排除","diagnostic_order":"代码->测试->结果","done_steps":"完成修改并验证","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":""}"#;
        let result = evaluate_stop_schema_gate(text, 0, 3, "", 0);
        assert_eq!(result.action, StopSchemaGateAction::Followup);
        assert_eq!(result.reason_code, "stop_schema_reason_missing");
        assert_eq!(result.missing_fields, vec!["reason".to_string()]);
        assert!(result.followup_text.as_deref().unwrap_or("").contains("只补 reason"));
    }

    #[test]
    fn missing_evidence_requests_evidence_only() {
        let text = r#"总结
{"stopreason":0,"reason":"任务已完成","has_evidence":1,"issue_cause":"需求已满足","excluded_factors":"无关路径已排除","diagnostic_order":"代码->测试->结果","done_steps":"完成修改并验证","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":""}"#;
        let result = evaluate_stop_schema_gate(text, 0, 3, "", 0);
        assert_eq!(result.action, StopSchemaGateAction::Followup);
        assert_eq!(result.reason_code, "stop_schema_terminal_missing_fields");
        assert!(result.missing_fields.contains(&"evidence".to_string()));
        assert_eq!(result.no_change_count, 1);
    }

    #[test]
    fn missing_schema_keeps_budget_unadvanced_and_reissues_guidance() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            provider_key: None,
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        let text = result.followup_text.expect("followup text");
        assert!(text.contains("stop schema"));
    }

    #[test]
    fn upgrades_legacy_default_followup_text_but_preserves_custom_text() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            provider_key: None,
            max_repeats: 3,
            used: 0,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        let text = result.followup_text.expect("followup text");
        assert!(text.contains("stop schema"));
        assert!(text.contains("缺少 stop schema"));

        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            provider_key: None,
            max_repeats: 3,
            used: 1,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        let text = result.followup_text.expect("followup text");
        assert!(text.contains("stop schema"));

        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            provider_key: None,
            max_repeats: 3,
            used: 2,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        let text = result.followup_text.expect("followup text");
        assert!(text.contains("stop schema"));

        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行，不要中断总结".to_string(),
            provider_key: None,
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
    fn default_source_uses_round_heuristic_instead_of_fixed_text() {
        let mut ctx = base_ctx();
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续完成当前用户目标。若仍需操作、检查或验证，必须调用可用工具继续执行；不要只总结。".to_string(),
            provider_key: None,
            max_repeats: 3,
            used: 1,
            source: SnapshotSource::Default,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        let text = result.followup_text.expect("followup text");
        assert!(text.contains("stop schema"));
        assert_ne!(
            text,
            "继续完成当前用户目标。若仍需操作、检查或验证，必须调用可用工具继续执行；不要只总结。"
        );
    }

    #[test]
    fn triggers_when_persisted_snapshot_exists_even_without_followup_context() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = None;
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            provider_key: None,
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
            provider_key: None,
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
                provider_key: None,
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
            provider_key: None,
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
            provider_key: None,
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
            provider_key: None,
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
            provider_key: None,
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
    fn stop_message_followup_flow_remains_eligible_for_bounded_continuation() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = Some("stop_message_flow".to_string());
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        assert_eq!(result.used, 0);
        assert_eq!(result.max_repeats, 3);
    }

    #[test]
    fn non_stop_message_followup_flow_short_circuits_stop_message() {
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
        let text = result.followup_text.unwrap();
        assert!(text.contains("继续当前用户目标"));
        assert!(text.contains("stop schema"));
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
            provider_key: None,
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
            provider_key: None,
            max_repeats: 5,
            used: 2,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        ctx.runtime_snapshot = Some(StopMessageSnapshot {
            text: "runtime".to_string(),
            provider_key: None,
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
    fn stop_message_followup_runtime_snapshot_uses_budgeted_snapshot() {
        let mut ctx = base_ctx();
        ctx.followup_flow_id = Some("stop_message_flow".to_string());
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "persisted".to_string(),
            provider_key: None,
            max_repeats: 1,
            used: 1,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        ctx.runtime_snapshot = Some(StopMessageSnapshot {
            text: "runtime".to_string(),
            provider_key: None,
            max_repeats: 3,
            used: 1,
            source: SnapshotSource::Default,
            stage_mode: StageMode::On,
        });

        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_reached_max_repeats");
    }

    #[test]
    fn provider_change_resets_persisted_snapshot_budget() {
        let mut ctx = base_ctx();
        ctx.provider_pin = Some(ProviderPin {
            provider_key: Some("provider.current".to_string()),
            model_id: None,
            routecodex_port_mode: None,
        });
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            provider_key: Some("provider.previous".to_string()),
            max_repeats: 3,
            used: 2,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        assert_eq!(result.used, 0);
        assert!(result.followup_text.expect("followup text").contains("stop schema"));
    }

    #[test]
    fn provider_match_preserves_persisted_snapshot_budget() {
        let mut ctx = base_ctx();
        ctx.provider_pin = Some(ProviderPin {
            provider_key: Some("provider.same".to_string()),
            model_id: None,
            routecodex_port_mode: None,
        });
        ctx.persisted_snapshot = Some(StopMessageSnapshot {
            text: "继续执行".to_string(),
            provider_key: Some("provider.same".to_string()),
            max_repeats: 3,
            used: 2,
            source: SnapshotSource::Persisted,
            stage_mode: StageMode::On,
        });
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Trigger);
        assert_eq!(result.used, 2);
        assert!(result.followup_text.expect("followup text").contains("stop schema"));
    }

    #[test]
    fn stop_schema_finished_or_blocked_with_reason_allows_stop() {
        let finished = evaluate_stop_schema_gate(
            r#"Done {"stopreason":0,"reason":"已完成并验证","has_evidence":1,"evidence":"cargo test green","issue_cause":"目标功能已验证","excluded_factors":"非相关配置未改动","diagnostic_order":"代码审计 -> 单测 -> 类型检查","done_steps":"补齐 Rust gate 并跑测试","next_step":"","learned":"缺 schema 计入连续 stop 预算"}"#,
            0,
            3,
        "", 0,
        );
        assert_eq!(finished.action, StopSchemaGateAction::AllowStop);
        assert!(finished.summary_prefix.unwrap().contains("已完成并验证"));
        assert_eq!(
            finished
                .parsed
                .as_ref()
                .and_then(|row| row.learned.as_deref()),
            Some("缺 schema 计入连续 stop 预算")
        );

        let blocked = evaluate_stop_schema_gate(
            r#"{"stopreason":1,"reason":"缺少上游权限","has_evidence":1,"evidence":"HTTP 401 from upstream","issue_cause":"credential expired","excluded_factors":"本地网络正常","diagnostic_order":"请求日志 -> provider 响应 -> auth 检查","done_steps":"确认上游拒绝","next_step":"等待授权"}"#,
            0,
            3,
        "", 0,
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
        "", 0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_reason_missing");
        assert!(decision.count_budget);
        assert!(decision.followup_text.unwrap().contains("没有给 reason"));
    }

    #[test]
    fn stop_schema_terminal_requires_evidence_and_diagnostics() {
        let missing_evidence_flag = evaluate_stop_schema_gate(
            r#"{"stopreason":0,"reason":"完成","has_evidence":0,"evidence":"cargo test green","issue_cause":"已验证","excluded_factors":"无关配置","diagnostic_order":"测试","done_steps":"修改代码","next_step":""}"#,
            0,
            3,
        "", 0,
        );
        assert_eq!(
            missing_evidence_flag.reason_code,
            "stop_schema_terminal_missing_fields"
        );
        assert!(missing_evidence_flag.missing_fields.contains(&"has_evidence".to_string()));
        assert_eq!(missing_evidence_flag.action, StopSchemaGateAction::Followup);
        assert!(missing_evidence_flag.count_budget);

        for (payload, missing_field) in [
            (
                r#"{"stopreason":0,"reason":"完成","has_evidence":1,"evidence":"","issue_cause":"已验证","excluded_factors":"无关配置","diagnostic_order":"测试","done_steps":"修改代码","next_step":""}"#,
                "evidence",
            ),
            (
                r#"{"stopreason":0,"reason":"完成","has_evidence":1,"evidence":"cargo test green","issue_cause":"已验证","excluded_factors":"无关配置","diagnostic_order":"测试","done_steps":"","next_step":""}"#,
                "done_steps",
            ),
            (
                r#"{"stopreason":0,"reason":"完成","has_evidence":1,"evidence":"cargo test green","issue_cause":"","excluded_factors":"无关配置","diagnostic_order":"测试","done_steps":"修改代码","next_step":""}"#,
                "issue_cause",
            ),
            (
                r#"{"stopreason":0,"reason":"完成","has_evidence":1,"evidence":"cargo test green","issue_cause":"已验证","excluded_factors":"","diagnostic_order":"测试","done_steps":"修改代码","next_step":""}"#,
                "excluded_factors",
            ),
            (
                r#"{"stopreason":0,"reason":"完成","has_evidence":1,"evidence":"cargo test green","issue_cause":"已验证","excluded_factors":"无关配置","diagnostic_order":"","done_steps":"修改代码","next_step":""}"#,
                "diagnostic_order",
            ),
        ] {
            let decision = evaluate_stop_schema_gate(payload, 0, 3, "", 0);
            assert_eq!(decision.action, StopSchemaGateAction::Followup);
            assert_eq!(decision.reason_code, "stop_schema_terminal_missing_fields");
            assert!(decision.missing_fields.contains(&missing_field.to_string()));
            assert!(decision.count_budget);
        }
    }

    #[test]
    fn stop_schema_continue_needed_with_next_step_follows_up_to_execute_next_step() {
        let decision = evaluate_stop_schema_gate(
            r#"```json
{"stopreason":2,"reason":"还没完成","has_evidence":0,"next_step":"运行 targeted tests"}
```"#,
            1,
            3,
        "", 0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_continue_next_step");
        let text = decision.followup_text.unwrap();
        assert_eq!(text, "运行 targeted tests");
        assert!(decision.count_budget);
        assert!(decision.missing_fields.contains(&"evidence".to_string()));
    }

    #[test]
    fn stop_schema_missing_invalid_or_no_next_step_follows_up_or_stops() {
        let missing = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
        assert_eq!(missing.action, StopSchemaGateAction::Followup);
        assert_eq!(missing.reason_code, "stop_schema_missing");
        assert!(missing.count_budget);
        let missing_text = missing.followup_text.unwrap();
        assert!(missing.missing_fields.contains(&"stopreason".to_string()));
        assert!(missing_text.contains("stop schema"));
        assert!(missing_text.contains("缺少 stop schema"));

        let invalid = evaluate_stop_schema_gate(
            r#"{"stopreason":"unknown","reason":"done","has_evidence":1,"next_step":""}"#,
            0,
            3,
        "", 0,
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
        "", 0,
        );
        assert_eq!(no_next.action, StopSchemaGateAction::Followup);
        assert_eq!(no_next.reason_code, "stop_schema_next_step_missing");
        assert!(no_next.count_budget);
        assert!(no_next
            .followup_text
            .unwrap()
            .contains("只补缺失字段"));

        let no_next_exhausted = evaluate_stop_schema_gate(
            r#"{"stopreason":2,"reason":"继续","has_evidence":0,"next_step":"","next_suggested_path":""}"#,
            3,
            3,
        "", 0,
        );
        assert_eq!(no_next_exhausted.action, StopSchemaGateAction::AllowStop);
        assert_eq!(
            no_next_exhausted.reason_code,
            "stop_schema_continue_without_next_step"
        );
        assert!(!no_next_exhausted.count_budget);
    }

    #[test]
    fn stop_schema_followup_prompts_are_layered_by_budget() {
        let first = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
        assert_eq!(first.reason_code, "stop_schema_missing");
        assert!(first.followup_text.as_deref().unwrap_or("").contains("stop schema"));
        assert!(first.missing_fields.contains(&"stopreason".to_string()));
        assert_eq!(first.no_change_count, 1);

        let second = evaluate_stop_schema_gate("普通停止文本", 1, 3, "", 0);
        assert_eq!(second.reason_code, "stop_schema_missing");
        assert_eq!(second.no_change_count, 1);

        let third = evaluate_stop_schema_gate("普通停止文本", 2, 3, "", 0);
        assert_eq!(third.reason_code, "stop_schema_missing");
        assert_eq!(third.action, StopSchemaGateAction::Followup);
        assert!(third.count_budget);
    }

    #[test]
    fn stop_schema_allow_stop_summary_is_user_markdown_not_stopreason_report() {
        let decision = evaluate_stop_schema_gate(
            r#"已完成。
{"stopreason":0,"reason":"SSE stop 响应已进入 stopless gate","has_evidence":1,"evidence":"executor 红测和 SSE 回归通过","issue_cause":"prebuilt SSE wrapper 提前直出","excluded_factors":"普通 tool_call SSE 顺序已验证正常","diagnostic_order":"日志样本 -> 红测 -> Rust RespInbound bodyText materialization -> 回归","done_steps":"修复 RespInbound SSE materialization，补红测","next_step":"","learned":"prebuilt SSE stopless 必须由 Rust RespInbound materialize bodyText"}"#,
            0,
            3,
        "", 0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
        let summary = decision.summary_prefix.expect("summary");
        assert!(summary.contains("## 完成内容"));
        assert!(summary.contains("SSE stop 响应已进入 stopless gate"));
        assert!(summary.contains("executor 红测和 SSE 回归通过"));
        assert!(!summary.contains("停止原因"));
        assert!(!summary.contains("stopreason"));
    }

    #[test]
    fn stop_schema_parser_ignores_non_control_evidence_json_before_schema() {
        let decision = evaluate_stop_schema_gate(
            r#"日志：
```json
{"event":"audit","message":"model mentioned stopreason in evidence text"}
```
<stop_schema>
{"stopreason":1,"reason":"工具被拒","has_evidence":1,"evidence":"上方日志","issue_cause":"客户端拒绝工具调用","excluded_factors":"非 schema 解析问题","diagnostic_order":"证据 JSON -> stop schema","done_steps":"确认工具拒绝","next_step":""}
</stop_schema>"#,
            0,
            3,
        "", 0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
        assert_eq!(decision.reason_code, "stop_schema_blocked");
        assert!(!decision.count_budget);
    }

    #[test]
    fn stop_schema_missing_exhausts_after_three_consecutive_stops() {
        let still_followup = evaluate_stop_schema_gate("普通停止文本", 2, 3, "", 0);
        assert_eq!(still_followup.action, StopSchemaGateAction::Followup);
        assert_eq!(still_followup.reason_code, "stop_schema_missing");
        assert!(still_followup.count_budget);

        let exhausted = evaluate_stop_schema_gate("普通停止文本", 3, 3, "", 0);
        assert_eq!(exhausted.action, StopSchemaGateAction::Followup);
        assert_eq!(exhausted.reason_code, "stop_schema_missing");
        assert!(exhausted.count_budget);
    }

    #[test]
    fn stop_schema_provided_exhausts_after_three_consecutive_stops() {
        // 只有 no_change_count 达到 3 才封顶；正常推进不应因 used=2/3 直接终止。
        let still_followup = evaluate_stop_schema_gate(
            r#"{"stopreason":2,"reason":"继续","has_evidence":0,"next_step":"运行测试"}"#,
            2,
            3,
        "", 0,
        );
        assert_eq!(still_followup.action, StopSchemaGateAction::Followup);
        assert!(still_followup.count_budget);

        let still_followup_again = evaluate_stop_schema_gate(
            r#"{"stopreason":2,"reason":"继续","has_evidence":0,"next_step":"运行测试"}"#,
            3,
            3,
        "", 0,
        );
        assert_eq!(still_followup_again.action, StopSchemaGateAction::Followup);
        assert_eq!(still_followup_again.reason_code, "stop_schema_continue_next_step");
    }

    #[test]
    fn stop_schema_invalid_exhausts_budget_but_valid_stop_does_not() {
        let invalid = evaluate_stop_schema_gate(
            r#"{"stopreason":2,"reason":"继续","has_evidence":0,"next_step":"运行测试"}"#,
            3,
            3,
        "", 0,
        );
        assert_eq!(invalid.action, StopSchemaGateAction::Followup);
        assert_eq!(invalid.reason_code, "stop_schema_continue_next_step");
        assert!(invalid.count_budget);
        assert!(invalid.followup_text.is_some());

        let valid = evaluate_stop_schema_gate(
            r#"{"stopreason":0,"reason":"测试通过","has_evidence":1,"evidence":"cargo test green","issue_cause":"实现已满足 contract","excluded_factors":"无关配置未参与","diagnostic_order":"单测 -> gate","done_steps":"补测试并运行","next_step":""}"#,
            3,
            3,
        "", 0,
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

    #[test]
    fn needs_user_input_with_next_step_allows_stop_without_budget() {
        let decision = evaluate_stop_schema_gate(
            r#"{"stopreason":2,"reason":"需要确认","has_evidence":0,"next_step":"请确认：你希望使用哪个版本的 API？v1 还是 v2？","needs_user_input":true}"#,
            0,
            3,
        "", 0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
        assert_eq!(decision.reason_code, "stop_schema_needs_user_input");
        assert!(!decision.count_budget);
        assert!(decision.summary_prefix.as_ref().unwrap().contains("请确认"));
    }

    #[test]
    fn needs_user_input_without_next_step_fails() {
        let decision = evaluate_stop_schema_gate(
            r#"{"stopreason":2,"reason":"需要确认","has_evidence":0,"next_step":"","needs_user_input":true}"#,
            0,
            3,
        "", 0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(
            decision.reason_code,
            "stop_schema_needs_user_input_missing_next_step"
        );
    }

    #[test]
    fn needs_user_input_does_not_increase_budget() {
        // First round: needs_user_input → AllowStop, no budget
        let d1 = evaluate_stop_schema_gate(
            r#"{"stopreason":2,"reason":"确认","has_evidence":0,"next_step":"问题内容","needs_user_input":true}"#,
            0,
            3,
        "", 0,
        );
        assert_eq!(d1.action, StopSchemaGateAction::AllowStop);
        assert!(!d1.count_budget);

        // Second round: normal stopreason=0 → should still be at used=0
        let d2 = evaluate_stop_schema_gate(
            r#"{"stopreason":0,"reason":"已完成","has_evidence":1,"evidence":"测试通过","issue_cause":"目标已验证","excluded_factors":"无需用户输入","diagnostic_order":"确认问题 -> 跑测试","done_steps":"完成实现","next_step":""}"#,
            0,
            3,
        "", 0,
        );
        assert_eq!(d2.action, StopSchemaGateAction::AllowStop);
        assert_eq!(d2.reason_code, "stop_schema_finished");
    }

    #[test]
    fn needs_user_input_not_exposed_to_model() {
        // The STOP_SCHEMA_JSON_EXAMPLE should contain needs_user_input
        // but stopreason should NOT contain 3 and forcestop stays internal-only.
        assert!(STOP_SCHEMA_JSON_EXAMPLE.contains("needs_user_input"));
        assert!(!STOP_SCHEMA_JSON_EXAMPLE.contains(r#"stopreason":3"#));
        assert!(!STOP_SCHEMA_JSON_EXAMPLE.contains("forcestop"));
    }

    #[test]
    fn forcestop_with_reason_allows_stop_without_other_fields() {
        let decision = evaluate_stop_schema_gate(
            r#"{"forcestop":1,"reason":"已用尽所有排查手段，循环无法突破"}"#,
            0,
            3,
        "", 0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
        assert_eq!(decision.reason_code, "stop_schema_forcestop");
        assert!(!decision.count_budget);
        assert!(decision.summary_prefix.as_ref().unwrap().contains("强制停止"));
        assert!(decision.summary_prefix.as_ref().unwrap().contains("已用尽所有排查手段"));
    }

    #[test]
    fn forcestop_without_reason_follows_up_with_guidance() {
        let decision = evaluate_stop_schema_gate(
            r#"{"forcestop":1,"reason":""}"#,
            0,
            3,
        "", 0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_forcestop_reason_missing");
        assert!(decision.followup_text.as_ref().unwrap().contains("forcestop=1"));
        assert!(decision.followup_text.as_ref().unwrap().contains("非空 reason"));
        assert!(decision.missing_fields.contains(&"reason".to_string()));
    }

    #[test]
    fn forcestop_takes_priority_over_stopreason_zero_missing_fields() {
        // forcestop=1 should allow stop even when normal stop schema is incomplete
        let decision = evaluate_stop_schema_gate(
            r#"{"forcestop":1,"reason":"必须立刻停止","stopreason":0,"has_evidence":0,"reason":"必须立刻停止"}"#,
            0,
            3,
        "", 0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
        assert_eq!(decision.reason_code, "stop_schema_forcestop");
    }
    /// observation_hash/no_change_count tests for B1 fix
    /// no_change_count accumulates when same schema error repeats
    #[test]
    fn no_change_count_increments_on_same_schema_missing_text() {
        // First call with empty prev hash -> no_change_count = 1
        let first = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
        assert_eq!(first.no_change_count, 1);
        assert_eq!(first.action, StopSchemaGateAction::Followup);

        // Second call with same hash from first -> no_change_count = 2
        let second = evaluate_stop_schema_gate("普通停止文本", 0, 3, &first.observation_hash, first.no_change_count);
        assert_eq!(second.no_change_count, 2);
        assert_eq!(second.action, StopSchemaGateAction::Followup);

        // Third call with same hash -> no_change_count = 3 -> fail_fast
        let third = evaluate_stop_schema_gate("普通停止文本", 0, 3, &second.observation_hash, second.no_change_count);
        assert_eq!(third.no_change_count, 3);
        assert_eq!(third.action, StopSchemaGateAction::FailFast);
        assert_eq!(third.reason_code, "stop_schema_budget_exhausted");
    }

    /// Different schema texts get different hashes -> no_change_count resets
    #[test]
    fn no_change_count_resets_on_different_schema_failure() {
        let first = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
        assert_eq!(first.no_change_count, 1);

        // Different text but no schema -> still same hash (reason_code same, missing_fields same)
        let second = evaluate_stop_schema_gate("另外的停止文本", 0, 3, &first.observation_hash, first.no_change_count);
        // Hash same because assistantStopText NOT included in hash!
        assert_eq!(second.no_change_count, 2);
    }

    /// Different schema errors get different hashes
    #[test]
    fn different_schema_reason_codes_get_different_hashes() {
        // Missing schema entirely
        let missing = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
        assert_eq!(missing.reason_code, "stop_schema_missing");

        // Invalid stopreason
        let invalid = evaluate_stop_schema_gate(
            r#"{"stopreason":"invalid"}"#,
            0, 3, "", 0
        );
        assert_eq!(invalid.reason_code, "stop_schema_stopreason_missing_or_non_numeric");

        // Different hashes because different reason_code
        assert_ne!(missing.observation_hash, invalid.observation_hash);

        // no_change_count = 1 for both (prev_hash = "")
        assert_eq!(missing.no_change_count, 1);
        assert_eq!(invalid.no_change_count, 1);
    }

    /// AllowStop returns do not change no_change_count
    #[test]
    fn allow_stop_does_not_count_observation_hash() {
        let decision = evaluate_stop_schema_gate(
            r#"{"stopreason":0,"reason":"已完成","has_evidence":1,"evidence":"通过","issue_cause":"无","excluded_factors":"无","diagnostic_order":"直测","done_steps":"完成","next_step":""}"#,
            0, 3, "", 0
        );
        assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
        assert_eq!(decision.no_change_count, 0);
        assert_eq!(decision.observation_hash, "");
    }

    /// Budget-exhausted fail_fast returns observation_hash
    #[test]
    fn fail_fast_returns_observation_hash() {
        let first = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
        let second = evaluate_stop_schema_gate("普通停止文本", 0, 3, &first.observation_hash, first.no_change_count);
        let third = evaluate_stop_schema_gate("普通停止文本", 0, 3, &second.observation_hash, second.no_change_count);
        assert_eq!(third.action, StopSchemaGateAction::FailFast);
        assert!(third.observation_hash.len() > 0);
    }

    /// no_change_count from schema_invalid_followup paths
    #[test]
    fn invalid_schema_no_change_count_accumulates() {
        let invalid_stopreason = r#"{"stopreason":"xyz"}"#;
        let first = evaluate_stop_schema_gate(invalid_stopreason, 0, 3, "", 0);
        assert_eq!(first.no_change_count, 1);

        let second = evaluate_stop_schema_gate(invalid_stopreason, 0, 3, &first.observation_hash, first.no_change_count);
        assert_eq!(second.no_change_count, 2);
    }

    /// Same missing_fields + same reason_code = same hash, even with different assistant text
    #[test]
    fn hash_stable_across_different_assistant_text() {
        let first = evaluate_stop_schema_gate("文本A 无 schema", 0, 3, "", 0);
        let second = evaluate_stop_schema_gate("文本B 还是无 schema", 0, 3, "", 0);
        // Same hash because assistantStopText NOT in hash
        assert_eq!(first.observation_hash, second.observation_hash);
    }
}
