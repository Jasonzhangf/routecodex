//! Stop-message decision core — pure Rust, no NAPI dependency.
//!
//! This crate implements the decision logic for `stop_message_auto` servertool handler.
//! The TS shell collects context, calls `decide()`, and acts on the result.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const STOP_SCHEMA_LOOP_GUARD_MAX_REPEATS: u32 = 3;
const STOP_SCHEMA_JSON_EXAMPLE: &str = r#"必须在回复末尾附一个 JSON 对象，字段名和类型必须一致：
{"stopreason":2,"simple_question":false,"reason":"当前状态原因","current_goal":"当前要完成的目标","has_evidence":0,"evidence":"","issue_cause":"","excluded_factors":"","diagnostic_order":"","done_steps":"","next_step":"如果仍需继续，写立刻执行的下一步；否则空字符串","next_suggested_path":"","needs_user_input":false,"learned":""}
字段规则：simple_question=true 表示当前用户输入只是非常简单的问题，可以直接自然停止，不需要 stopreason/证据/下一步字段；否则 stopreason 是唯一无条件必填字段，只能是数字 0=finished，1=blocked，2=continue_needed；stopreason=0 需要 has_evidence=1 且 evidence 非空，evidence 内容不做真假校验；stopreason=1 需要 reason 非空；needs_user_input=true 时 next_step 必须写给用户的决策问题；stopreason=2 需要 current_goal 和 next_step 非空，下一轮提示直接使用 next_step，current_goal 只记录当前目标；issue_cause/excluded_factors/diagnostic_order/done_steps/next_suggested_path/learned 有内容就写，没有可留空。"#;

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
pub enum SkipReason {
    PortDisabled,
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
    PlanMode,
}

impl SkipReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkipReason::PortDisabled => "skip_port_stopmessage_disabled",
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
    pub simple_question: Option<bool>,
    pub has_evidence: Option<u8>,
    pub forcestop: Option<u8>,
    pub reason: Option<String>,
    pub current_goal: Option<String>,
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

/// Record of a single schema validation failure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaErrorFeedback {
    /// 0-based turn number for this error
    pub turn: u32,
    /// reason_code for the failure
    pub reason_code: String,
    /// Preview of what the model actually output (first 200 chars)
    pub assistant_text_preview: String,
    /// Which fields were missing
    pub missing_fields: Vec<String>,
    /// Which fields had invalid values
    pub invalid_fields: Vec<(String, String)>,
    /// The schema the model actually attempted (flattened)
    pub attempted_fields: std::collections::BTreeMap<String, serde_json::Value>,
    /// A complete valid sample the model can copy-paste
    pub fix_example: String,
}

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
    pub feedback_history: Vec<SchemaErrorFeedback>,
}

fn should_passthrough_after_consecutive_stop_budget(
    count_budget: bool,
    used: u32,
    effective_max: u32,
    no_change_count: u32,
) -> bool {
    count_budget
        && effective_max > 0
        && (used.saturating_add(1) >= effective_max || no_change_count >= effective_max)
}

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
        followup_text: Some(build_stop_message_followup_text(
            &snapshot,
            effective_max_repeats,
        )),
        provider_pin: ctx.provider_pin.clone(),
    }
}

fn evaluate_stop_schema_gate_from_parse_result(
    parse_result: StopSchemaParseResult,
    assistant_text: &str,
    used: u32,
    max_repeats: u32,
    prev_observation_hash: &str,
    prev_no_change_count: u32,
    feedback_history: Vec<SchemaErrorFeedback>,
) -> StopSchemaGateDecision {
    let provided_cap = stop_schema_provided_max_repeats(max_repeats);
    let loop_guard_cap = STOP_SCHEMA_LOOP_GUARD_MAX_REPEATS;
    let parsed = match parse_result {
        StopSchemaParseResult::Parsed(parsed) => parsed,
        StopSchemaParseResult::InvalidJson => {
            let missing = base_missing_schema_fields();
            let observation_hash = compute_schema_observation_hash(
                "stop_schema_invalid_json",
                None,
                None,
                None,
                &missing,
            );
            let no_change_count = resolve_no_change_count(
                "stop_schema_invalid_json",
                None,
                None,
                None,
                &missing,
                prev_observation_hash,
                prev_no_change_count,
            );
            return schema_missing_followup(
                assistant_text,
                "stop_schema_invalid_json",
                used,
                loop_guard_cap,
                &format!(
                    "本轮提供了 stop schema 外壳，但里面不是合法 JSON。请直接修正为合法 JSON，并保留 <rcc_stop_schema>...</rcc_stop_schema> 包裹。{}",
                    STOP_SCHEMA_JSON_EXAMPLE
                ),
                missing,
                no_change_count,
                observation_hash,
                feedback_history,
            );
        }
        StopSchemaParseResult::Missing => {
            let missing = base_missing_schema_fields();
            let observation_hash =
                compute_schema_observation_hash("stop_schema_missing", None, None, None, &missing);
            let no_change_count = resolve_no_change_count(
                "stop_schema_missing",
                None,
                None,
                None,
                &missing,
                prev_observation_hash,
                prev_no_change_count,
            );
            return schema_missing_followup(
                assistant_text,
                "stop_schema_missing",
                used,
                loop_guard_cap,
                &format!("本轮缺少 stop schema。请补齐缺失字段后再判断；若缺文件、日志、命令输出或测试证据，优先调用 exec_command 继续验证。{}", STOP_SCHEMA_JSON_EXAMPLE),
                missing,
                no_change_count,
                observation_hash,
                feedback_history,
            );
        }
    };
    evaluate_stop_schema_gate_from_parsed(
        parsed,
        assistant_text,
        used,
        provided_cap,
        prev_observation_hash,
        prev_no_change_count,
        feedback_history,
    )
}

fn evaluate_stop_schema_gate_from_parsed(
    parsed: StopSchemaParsed,
    assistant_text: &str,
    used: u32,
    provided_cap: u32,
    prev_observation_hash: &str,
    prev_no_change_count: u32,
    feedback_history: Vec<SchemaErrorFeedback>,
) -> StopSchemaGateDecision {
    if parsed.simple_question == Some(true) {
        return StopSchemaGateDecision {
            max_repeats: provided_cap,
            action: StopSchemaGateAction::AllowStop,
            reason_code: "stop_schema_simple_question".to_string(),
            summary_prefix: None,
            followup_text: None,
            count_budget: false,
            missing_fields: vec![],
            no_change_count: 0,
            observation_hash: String::new(),
            parsed: Some(parsed),
            feedback_history,
        };
    }

    if parsed.forcestop == Some(1) {
        let reason = parsed.reason.as_deref().map(str::trim).unwrap_or("");
        if reason.is_empty() {
            let missing = vec!["reason".to_string()];
            let observation_hash = compute_schema_observation_hash(
                "stop_schema_forcestop_reason_missing",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing,
            );
            let no_change_count = resolve_no_change_count(
                "stop_schema_forcestop_reason_missing",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing,
                prev_observation_hash,
                prev_no_change_count,
            );
            return schema_invalid_followup(
                assistant_text,
                "stop_schema_forcestop_reason_missing",
                used,
                provided_cap,
                "forcestop=1 只能在不得已强制结束时使用，而且必须填写非空 reason 说明为什么需要强制结束；reason 不校验格式，但不能为空。",
                parsed,
                missing,
                no_change_count,
                observation_hash,
                feedback_history,
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
            feedback_history,
        };
    }

    let stopreason = match parsed.stopreason {
        Some(v) => v,
        None => {
            let missing = vec!["stopreason".to_string()];
            let observation_hash = compute_schema_observation_hash(
                "stop_schema_stopreason_missing_or_non_numeric",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing,
            );
            let no_change_count = resolve_no_change_count(
                "stop_schema_stopreason_missing_or_non_numeric",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing,
                prev_observation_hash,
                prev_no_change_count,
            );
            return schema_invalid_followup(
                assistant_text,
                "stop_schema_stopreason_missing_or_non_numeric",
                used,
                provided_cap,
                &format!("stop schema 的 stopreason 必须是数字 0/1/2。当前缺少 stopreason 或 stopreason 不是 0/1/2；请先补这个字段，再按对应条件填写：完成要 has_evidence=1+evidence，阻塞要 reason，继续要 next_step。{}", STOP_SCHEMA_JSON_EXAMPLE),
                parsed,
                missing,
                no_change_count,
                observation_hash,
                feedback_history,
            );
        }
    };

    if parsed.needs_user_input.unwrap_or(false) {
        let next_step_raw = parsed.next_step.as_deref().map(str::trim).unwrap_or("");
        if next_step_raw.is_empty() {
            let missing = vec!["next_step".to_string()];
            let observation_hash = compute_schema_observation_hash(
                "stop_schema_needs_user_input_missing_next_step",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing,
            );
            let no_change_count = resolve_no_change_count(
                "stop_schema_needs_user_input_missing_next_step",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing,
                prev_observation_hash,
                prev_no_change_count,
            );
            return schema_invalid_followup(
                assistant_text,
                "stop_schema_needs_user_input_missing_next_step",
                used,
                provided_cap,
                "你声明需要向用户提问（needs_user_input=true），但没有给出问题内容。请只补 next_step 中的问题。",
                parsed,
                missing,
                no_change_count,
                observation_hash,
                feedback_history,
            );
        }
        return StopSchemaGateDecision {
            max_repeats: provided_cap,
            action: StopSchemaGateAction::AllowStop,
            reason_code: "stop_schema_needs_user_input".to_string(),
            summary_prefix: Some(build_needs_user_input_summary_prefix(
                &parsed,
                stopreason,
                next_step_raw,
            )),
            followup_text: None,
            count_budget: false,
            missing_fields: vec![],
            no_change_count: 0,
            observation_hash: String::new(),
            parsed: Some(parsed),
            feedback_history,
        };
    }

    if stopreason > 2 {
        let missing = vec!["stopreason".to_string()];
        let observation_hash = compute_schema_observation_hash(
            "stop_schema_stopreason_missing_or_non_numeric",
            parsed.stopreason,
            parsed.reason.as_deref(),
            parsed.next_step.as_deref(),
            &missing,
        );
        let no_change_count = resolve_no_change_count(
            "stop_schema_stopreason_missing_or_non_numeric",
            parsed.stopreason,
            parsed.reason.as_deref(),
            parsed.next_step.as_deref(),
            &missing,
            prev_observation_hash,
            prev_no_change_count,
        );
        return schema_invalid_followup(
            assistant_text,
            "stop_schema_stopreason_missing_or_non_numeric",
            used,
            provided_cap,
            &format!(
                "stop schema 的 stopreason 必须是数字 0/1/2，当前不是允许值。{}",
                STOP_SCHEMA_JSON_EXAMPLE
            ),
            parsed,
            missing,
            no_change_count,
            observation_hash,
            feedback_history,
        );
    }

    if stopreason == 0 || stopreason == 1 {
        let reason = parsed.reason.as_deref().map(str::trim).unwrap_or("");
        if stopreason == 1 && reason.is_empty() {
            let missing = vec!["reason".to_string()];
            let observation_hash = compute_schema_observation_hash(
                "stop_schema_reason_missing",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing,
            );
            let no_change_count = resolve_no_change_count(
                "stop_schema_reason_missing",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing,
                prev_observation_hash,
                prev_no_change_count,
            );
            return schema_invalid_followup(
                assistant_text,
                "stop_schema_reason_missing",
                used,
                provided_cap,
                "你声明 blocked，但没有给 reason。blocked 停止只要求说明为什么现在停下来；请只补非空 reason。",
                parsed,
                missing,
                no_change_count,
                observation_hash,
                feedback_history,
            );
        }
        let missing = terminal_missing_fields(&parsed, stopreason);
        if !missing.is_empty() {
            let observation_hash = compute_schema_observation_hash(
                "stop_schema_terminal_missing_fields",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing,
            );
            let no_change_count = resolve_no_change_count(
                "stop_schema_terminal_missing_fields",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing,
                prev_observation_hash,
                prev_no_change_count,
            );
            return schema_invalid_followup(
                assistant_text,
                "stop_schema_terminal_missing_fields",
                used,
                provided_cap,
                &format!("你声明 finished/blocked，但还缺这些字段：{}。请只补缺失字段，不要重写其它已通过字段。", missing.join(", ")),
                parsed,
                missing,
                no_change_count,
                observation_hash,
                feedback_history,
            );
        }
        let visible_stop_text = build_terminal_visible_stop_text(assistant_text);
        let summary_prefix = if visible_stop_text.is_empty() {
            Some(build_allow_stop_summary_prefix_from_parsed(
                &parsed, stopreason, reason,
            ))
        } else {
            None
        };
        return StopSchemaGateDecision {
            max_repeats: provided_cap,
            action: StopSchemaGateAction::AllowStop,
            reason_code: if stopreason == 0 {
                "stop_schema_finished".to_string()
            } else {
                "stop_schema_blocked".to_string()
            },
            summary_prefix,
            followup_text: None,
            count_budget: false,
            missing_fields: vec![],
            no_change_count: 0,
            observation_hash: String::new(),
            parsed: Some(parsed),
            feedback_history,
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
        let current_goal = parsed.current_goal.as_deref().map(str::trim).unwrap_or("");
        if current_goal.is_empty() {
            let missing_fields = vec!["current_goal".to_string()];
            let observation_hash = compute_schema_observation_hash(
                "stop_schema_current_goal_missing",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing_fields,
            );
            let no_change_count = resolve_no_change_count(
                "stop_schema_current_goal_missing",
                parsed.stopreason,
                parsed.reason.as_deref(),
                parsed.next_step.as_deref(),
                &missing_fields,
                prev_observation_hash,
                prev_no_change_count,
            );
            return schema_followup(
                assistant_text,
                "stop_schema_current_goal_missing",
                used,
                provided_cap,
                "你还没有写 current_goal。先明确你现在的任务目标是什么，再基于这个目标判断下一步要做什么，然后继续执行。",
                Some(parsed),
                true,
                missing_fields,
                no_change_count,
                observation_hash,
                feedback_history,
            );
        }
        let missing_fields = remaining_missing_fields(&parsed);
        let observation_hash = compute_schema_observation_hash(
            "stop_schema_continue_next_step",
            parsed.stopreason,
            parsed.reason.as_deref(),
            parsed.next_step.as_deref(),
            &missing_fields,
        );
        let no_change_count = resolve_no_change_count(
            "stop_schema_continue_next_step",
            parsed.stopreason,
            parsed.reason.as_deref(),
            parsed.next_step.as_deref(),
            &missing_fields,
            prev_observation_hash,
            prev_no_change_count,
        );
        return schema_followup(
            assistant_text,
            "stop_schema_continue_next_step",
            used,
            provided_cap,
            &build_continue_next_step_prompt(next_step.as_str()),
            Some(parsed),
            false,
            missing_fields,
            no_change_count,
            observation_hash,
            feedback_history,
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
            let visible_stop_text = build_terminal_visible_stop_text(assistant_text);
            let summary_prefix = if visible_stop_text.is_empty() {
                Some(build_allow_stop_summary_prefix_from_parsed(
                    &parsed,
                    stopreason,
                    fallback_reason,
                ))
            } else {
                None
            };
            return StopSchemaGateDecision {
                max_repeats: provided_cap,
                action: StopSchemaGateAction::AllowStop,
                reason_code: "stop_schema_continue_without_next_step".to_string(),
                summary_prefix,
                followup_text: None,
                count_budget: false,
                missing_fields: vec![],
                no_change_count: 0,
                observation_hash: String::new(),
                parsed: Some(parsed),
                feedback_history,
            };
        }
        let missing_fields = remaining_missing_fields(&parsed);
        let observation_hash = compute_schema_observation_hash(
            "stop_schema_next_step_missing",
            parsed.stopreason,
            parsed.reason.as_deref(),
            parsed.next_step.as_deref(),
            &missing_fields,
        );
        let no_change_count = resolve_no_change_count(
            "stop_schema_next_step_missing",
            parsed.stopreason,
            parsed.reason.as_deref(),
            parsed.next_step.as_deref(),
            &missing_fields,
            prev_observation_hash,
            prev_no_change_count,
        );
        return schema_followup(
            assistant_text,
            "stop_schema_next_step_missing",
            used,
            provided_cap,
            &format!("任务还没完成，但你没有给出明确下一步。请只补缺失字段：{}。若仍无法给出明确下一步，下一轮允许直接停止。{}", missing_fields.join(", "), STOP_SCHEMA_JSON_EXAMPLE),
            Some(parsed),
            true,
            missing_fields,
            no_change_count,
            observation_hash,
            feedback_history,
        );
    }

    let missing_fields = remaining_missing_fields(&parsed);
    let observation_hash = compute_schema_observation_hash(
        "stop_schema_next_step_missing",
        parsed.stopreason,
        parsed.reason.as_deref(),
        parsed.next_step.as_deref(),
        &missing_fields,
    );
    let no_change_count = resolve_no_change_count(
        "stop_schema_next_step_missing",
        parsed.stopreason,
        parsed.reason.as_deref(),
        parsed.next_step.as_deref(),
        &missing_fields,
        prev_observation_hash,
        prev_no_change_count,
    );
    schema_invalid_followup(
        assistant_text,
        "stop_schema_next_step_missing",
        used,
        provided_cap,
        "你没有提供 next_step，但仍给出了建议推进路径。若要继续，必须把当前最小下一步写入 next_step 并立即执行；否则直接停止并输出收尾总结。",
        parsed,
        missing_fields,
        no_change_count,
        observation_hash,
        feedback_history,
    )
}

pub fn evaluate_stop_schema_gate(
    assistant_text: &str,
    used: u32,
    max_repeats: u32,
    prev_observation_hash: &str,
    prev_no_change_count: u32,
) -> StopSchemaGateDecision {
    evaluate_stop_schema_gate_from_parse_result(
        parse_stop_schema_from_assistant_text(assistant_text),
        assistant_text,
        used,
        max_repeats,
        prev_observation_hash,
        prev_no_change_count,
        Vec::new(),
    )
}

pub fn evaluate_stop_schema_gate_with_reasoning_stop_arguments(
    assistant_text: &str,
    reasoning_stop_arguments: Option<&str>,
    used: u32,
    max_repeats: u32,
    prev_observation_hash: &str,
    prev_no_change_count: u32,
) -> StopSchemaGateDecision {
    match parse_stop_schema_from_reasoning_stop_arguments(reasoning_stop_arguments, assistant_text)
    {
        StopSchemaParseResult::Parsed(parsed) => evaluate_stop_schema_gate_from_parsed(
            parsed,
            assistant_text,
            used,
            stop_schema_provided_max_repeats(max_repeats),
            prev_observation_hash,
            prev_no_change_count,
            Vec::new(),
        ),
        StopSchemaParseResult::InvalidJson => {
            let missing = base_missing_schema_fields();
            let observation_hash = compute_schema_observation_hash(
                "stop_schema_invalid_json",
                None,
                None,
                None,
                &missing,
            );
            let no_change_count = resolve_no_change_count(
                "stop_schema_invalid_json",
                None,
                None,
                None,
                &missing,
                prev_observation_hash,
                prev_no_change_count,
            );
            schema_missing_followup(
                assistant_text,
                "stop_schema_invalid_json",
                used,
                stop_schema_provided_max_repeats(max_repeats),
                &format!(
                    "这次的 stop schema 不是合法 JSON。若走 reasoningStop，arguments 必须是合法 JSON；若直接 stop，正文末尾必须附合法 <rcc_stop_schema>...</rcc_stop_schema>。{}",
                    STOP_SCHEMA_JSON_EXAMPLE
                ),
                missing,
                no_change_count,
                observation_hash,
                Vec::new(),
            )
        }
        StopSchemaParseResult::Missing => evaluate_stop_schema_gate_from_parse_result(
            parse_stop_schema_from_assistant_text(assistant_text),
            assistant_text,
            used,
            max_repeats,
            prev_observation_hash,
            prev_no_change_count,
            Vec::new(),
        ),
    }
}
fn schema_invalid_followup(
    _assistant_text: &str,
    reason_code: &str,
    used: u32,
    effective_max: u32,
    message: &str,
    parsed: StopSchemaParsed,
    missing_fields: Vec<String>,
    no_change_count: u32,
    observation_hash: String,
    feedback_history: Vec<SchemaErrorFeedback>,
) -> StopSchemaGateDecision {
    schema_followup(
        _assistant_text,
        reason_code,
        used,
        effective_max,
        message,
        Some(parsed),
        true,
        missing_fields,
        no_change_count,
        observation_hash,
        feedback_history,
    )
}

fn schema_missing_followup(
    _assistant_text: &str,
    reason_code: &str,
    used: u32,
    effective_max: u32,
    message: &str,
    missing_fields: Vec<String>,
    no_change_count: u32,
    observation_hash: String,
    feedback_history: Vec<SchemaErrorFeedback>,
) -> StopSchemaGateDecision {
    schema_followup(
        _assistant_text,
        reason_code,
        used,
        effective_max,
        message,
        None,
        true,
        missing_fields,
        no_change_count,
        observation_hash,
        feedback_history,
    )
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

fn build_needs_user_input_summary_prefix(
    parsed: &StopSchemaParsed,
    stopreason: u8,
    question: &str,
) -> String {
    let mut out = build_allow_stop_summary_prefix_from_parsed(
        parsed,
        stopreason,
        parsed.reason.as_deref().unwrap_or("需要用户决策"),
    );
    out.push_str("## 需要你决定\n\n");
    out.push_str(question.trim());
    out.push('\n');
    out
}

fn build_terminal_visible_stop_text(text: &str) -> String {
    let mut visible = text.to_string();
    for (start_tag, end_tag) in [
        ("<rcc_stop_schema>", "</rcc_stop_schema>"),
        ("<stop_schema>", "</stop_schema>"),
    ] {
        while let Some(start) = visible.find(start_tag) {
            let content_start = start + start_tag.len();
            let Some(relative_end) = visible[content_start..].find(end_tag) else {
                visible.truncate(start);
                break;
            };
            let end = content_start + relative_end + end_tag.len();
            visible.replace_range(start..end, "");
        }
    }
    while let Some(start) = visible.find("```json") {
        let content_start = start + "```json".len();
        let Some(relative_end) = visible[content_start..].find("```") else {
            visible.truncate(start);
            break;
        };
        let end = content_start + relative_end + "```".len();
        visible.replace_range(start..end, "");
    }
    visible.trim().to_string()
}

fn schema_followup(
    _assistant_text: &str,
    reason_code: &str,
    used: u32,
    effective_max: u32,
    message: &str,
    parsed: Option<StopSchemaParsed>,
    count_budget: bool,
    missing_fields: Vec<String>,
    no_change_count: u32,
    observation_hash: String,
    feedback_history: Vec<SchemaErrorFeedback>,
) -> StopSchemaGateDecision {
    if should_passthrough_after_consecutive_stop_budget(
        count_budget,
        used,
        effective_max,
        no_change_count,
    ) {
        return StopSchemaGateDecision {
            max_repeats: effective_max,
            action: StopSchemaGateAction::AllowStop,
            reason_code: "stop_schema_loop_guard_passthrough".to_string(),
            summary_prefix: None,
            followup_text: None,
            count_budget: false,
            missing_fields: vec![],
            no_change_count,
            observation_hash,
            parsed,
            feedback_history,
        };
    }
    let mut text = String::new();
    if reason_code == "stop_schema_continue_next_step" {
        text.push_str(message);
    } else if used.saturating_add(1) >= effective_max {
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
        feedback_history,
    }
}

fn build_continue_next_step_prompt(next_step: &str) -> String {
    next_step.trim().to_string()
}

fn build_stop_message_followup_text(
    snapshot: &StopMessageSnapshot,
    effective_max_repeats: u32,
) -> String {
    if !should_upgrade_stop_message_text(snapshot) {
        return snapshot.text.clone();
    }

    let mut text = String::new();
    text.push_str("继续当前用户目标；不要停在总结。\n");
    if snapshot.used.saturating_add(1) >= effective_max_repeats {
        text.push_str(
            "\n\n最终收尾 schema 缺失：不要复述 stopless/校验过程；直接给用户可读 summary，包含已完成事项、未完成事项、阻塞点/问题原因、已排除因素、建议下一步，并在末尾附 stop schema。\n",
        );
    } else {
        text.push_str("继续做下一步；先把手头能确认的结果拿回来。\n");
        text.push_str(
            "\n\nStop schema 校验未通过：缺少 stop schema；如果准备停止，必须在回复末尾附合法 stop schema；若证据不足，优先调用 exec_command 继续验证。\n",
        );
    }
    text.push_str(STOP_SCHEMA_JSON_EXAMPLE);
    text
}

fn should_upgrade_stop_message_text(snapshot: &StopMessageSnapshot) -> bool {
    if matches!(snapshot.source, SnapshotSource::Default) {
        return true;
    }
    matches!(snapshot.text.trim(), "继续执行" | "继续")
}

fn terminal_missing_fields(parsed: &StopSchemaParsed, stopreason: u8) -> Vec<String> {
    let mut missing = Vec::new();
    if stopreason == 1 {
        if parsed
            .reason
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            missing.push("reason".to_string());
        }
        return missing;
    }
    if parsed.has_evidence != Some(1) {
        missing.push("has_evidence".to_string());
    }
    if parsed
        .evidence
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        missing.push("evidence".to_string());
    }
    missing
}

fn base_missing_schema_fields() -> Vec<String> {
    vec!["stopreason".to_string()]
}

fn remaining_missing_fields(parsed: &StopSchemaParsed) -> Vec<String> {
    let mut missing = Vec::new();
    let Some(stopreason) = parsed.stopreason else {
        missing.push("stopreason".to_string());
        return missing;
    };
    match stopreason {
        0 => {
            if parsed.has_evidence != Some(1) {
                missing.push("has_evidence".to_string());
            }
            if parsed
                .evidence
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                missing.push("evidence".to_string());
            }
        }
        1 => {
            if parsed
                .reason
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                missing.push("reason".to_string());
            }
            if parsed.needs_user_input.unwrap_or(false)
                && parsed
                    .next_step
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
            {
                missing.push("next_step".to_string());
            }
        }
        2 => {
            if parsed
                .current_goal
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                missing.push("current_goal".to_string());
            }
            if parsed
                .next_step
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                missing.push("next_step".to_string());
            }
        }
        _ => missing.push("stopreason".to_string()),
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
    let current_hash =
        compute_schema_observation_hash(reason_code, stopreason, reason, next_step, missing_fields);
    if current_hash == prev_hash {
        prev_count.saturating_add(1)
    } else {
        1
    }
}

enum StopSchemaParseResult {
    Missing,
    InvalidJson,
    Parsed(StopSchemaParsed),
}

fn parse_stop_schema_value(value: Value) -> Option<StopSchemaParsed> {
    let row = value.as_object()?;
    Some(StopSchemaParsed {
        stopreason: read_u8(row.get("stopreason")),
        simple_question: row.get("simple_question").and_then(|v| v.as_bool()),
        has_evidence: read_u8(row.get("has_evidence")),
        forcestop: read_u8(row.get("forcestop")),
        reason: read_string(row.get("reason")),
        current_goal: read_string(row.get("current_goal")),
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

fn parse_stop_schema_from_assistant_text(text: &str) -> StopSchemaParseResult {
    if let Some(result) = parse_tagged_stop_schema_json_object(text) {
        return match result.and_then(parse_stop_schema_value) {
            Some(parsed) => StopSchemaParseResult::Parsed(parsed),
            None => StopSchemaParseResult::InvalidJson,
        };
    }
    if let Some(result) = parse_fenced_stop_schema_json_object(text) {
        return match result.and_then(parse_stop_schema_value) {
            Some(parsed) => StopSchemaParseResult::Parsed(parsed),
            None => StopSchemaParseResult::InvalidJson,
        };
    }
    if let Some(result) = parse_bare_stop_schema_json_object(text) {
        return match result.and_then(parse_stop_schema_value) {
            Some(parsed) => StopSchemaParseResult::Parsed(parsed),
            None => StopSchemaParseResult::InvalidJson,
        };
    }
    StopSchemaParseResult::Missing
}

fn parse_stop_schema_from_reasoning_stop_arguments(
    reasoning_stop_arguments: Option<&str>,
    assistant_text: &str,
) -> StopSchemaParseResult {
    let Some(arguments) = reasoning_stop_arguments
        .map(str::trim)
        .filter(|text| !text.is_empty())
    else {
        return parse_stop_schema_from_assistant_text(assistant_text);
    };
    match serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(parse_stop_schema_value)
    {
        Some(parsed) => StopSchemaParseResult::Parsed(parsed),
        None => StopSchemaParseResult::InvalidJson,
    }
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
            "0" => Some(0),
            "1" => Some(1),
            "2" => Some(2),
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

fn parse_tagged_stop_schema_json_object(text: &str) -> Option<Option<Value>> {
    for (start_marker, end_marker) in [
        ("<rcc_stop_schema>", "</rcc_stop_schema>"),
        ("<stop_schema>", "</stop_schema>"),
    ] {
        let Some(start) = text.find(start_marker) else {
            continue;
        };
        let after_start = &text[start + start_marker.len()..];
        let Some(end) = after_start.find(end_marker) else {
            return Some(None);
        };
        let candidate = after_start[..end].trim();
        return Some(
            serde_json::from_str::<Value>(candidate)
                .ok()
                .filter(|value| value.is_object()),
        );
    }
    None
}

fn parse_fenced_stop_schema_json_object(text: &str) -> Option<Option<Value>> {
    let marker = "```";
    let mut rest = text;
    while let Some(start) = rest.find(marker) {
        let after = &rest[start + marker.len()..];
        let Some(after) = after
            .strip_prefix("json")
            .or_else(|| after.strip_prefix("JSON"))
        else {
            rest = after;
            continue;
        };
        let after = after.strip_prefix('\n').unwrap_or(after);
        let Some(end) = after.find(marker) else {
            return Some(None);
        };
        let candidate = &after[..end];
        let parsed_value = serde_json::from_str::<Value>(candidate.trim())
            .ok()
            .filter(|value| value.is_object());
        if let Some(value) = parsed_value {
            if looks_like_stop_schema_value(&value) {
                return Some(Some(value));
            }
        } else {
            return Some(None);
        }
        rest = &after[end + marker.len()..];
    }
    None
}

fn parse_bare_stop_schema_json_object(text: &str) -> Option<Option<Value>> {
    let candidate = text.trim();
    if candidate.is_empty() || !candidate.starts_with('{') || !candidate.ends_with('}') {
        return None;
    }
    match serde_json::from_str::<Value>(candidate) {
        Ok(value) if value.is_object() && looks_like_stop_schema_value(&value) => Some(Some(value)),
        Ok(_) => None,
        Err(_) => Some(None),
    }
}

fn looks_like_stop_schema_value(value: &Value) -> bool {
    let Some(row) = value.as_object() else {
        return false;
    };
    [
        "stopreason",
        "simple_question",
        "forcestop",
        "reason",
        "current_goal",
        "has_evidence",
        "next_step",
        "needs_user_input",
    ]
    .iter()
    .any(|key| row.contains_key(*key))
}

fn decide_stop_message_skip(ctx: &StopMessageDecisionContext) -> Option<SkipReason> {
    if ctx.port_stop_message_disabled {
        return Some(SkipReason::PortDisabled);
    }
    if matches!(ctx.explicit_mode, Some(StageMode::Off)) {
        return Some(SkipReason::ExplicitModeOff);
    }
    if ctx.plan_mode_active {
        return Some(SkipReason::PlanMode);
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

    // 1. Try persisted snapshot first
    if let Some(snapshot) = &ctx.persisted_snapshot {
        return Some(bind_snapshot_to_current_provider(
            snapshot,
            current_provider_key,
        ));
    }

    // 2. Try runtime snapshot
    if let Some(snapshot) = &ctx.runtime_snapshot {
        return Some(bind_snapshot_to_current_provider(
            snapshot,
            current_provider_key,
        ));
    }

    // 3. Try default snapshot when no usable snapshot exists.
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

    None
}

fn bind_snapshot_to_current_provider(
    snapshot: &StopMessageSnapshot,
    current_provider_key: Option<&str>,
) -> StopMessageSnapshot {
    let mut next = snapshot.clone();
    next.provider_key = current_provider_key.map(str::to_string);
    next
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

    fn tagged_stop_schema(json: &str) -> String {
        format!("<rcc_stop_schema>\n{}\n</rcc_stop_schema>", json.trim())
    }

    fn base_ctx() -> StopMessageDecisionContext {
        StopMessageDecisionContext {
            port_stop_message_disabled: false,
            stop_eligible: true,
            finish_reasons: Some(vec!["stop".to_string()]),
            has_responses_submit_tool_outputs_resume: false,
            persisted_snapshot: None,
            runtime_snapshot: None,
            persisted_default_exhausted: false,
            explicit_mode: None,
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
    fn triggers_when_default_enabled() {
        let mut ctx = base_ctx();
        ctx.default_enabled = true;
        let result = decide(&ctx);
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
        let text = tagged_stop_schema(
            r#"{"stopreason":0,"reason":"任务已完成","has_evidence":1,"evidence":"tests passed","issue_cause":"需求已满足","excluded_factors":"无关路径已排除","diagnostic_order":"代码->测试->结果","done_steps":"完成修改并验证","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":""}"#,
        );
        let result = evaluate_stop_schema_gate(text.as_str(), 0, 3, "", 0);
        assert_eq!(result.action, StopSchemaGateAction::AllowStop);
        assert_eq!(result.reason_code, "stop_schema_finished");
        assert_eq!(result.count_budget, false);
        assert!(result.missing_fields.is_empty());
    }

    #[test]
    fn finished_without_reason_allows_when_evidence_present() {
        let text = tagged_stop_schema(
            r#"{"stopreason":0,"has_evidence":1,"evidence":"tests passed","issue_cause":"需求已满足","excluded_factors":"无关路径已排除","diagnostic_order":"代码->测试->结果","done_steps":"完成修改并验证","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":""}"#,
        );
        let result = evaluate_stop_schema_gate(text.as_str(), 0, 3, "", 0);
        assert_eq!(result.action, StopSchemaGateAction::AllowStop);
        assert_eq!(result.reason_code, "stop_schema_finished");
        assert!(result.missing_fields.is_empty());
    }

    #[test]
    fn missing_evidence_requests_evidence_only() {
        let text = tagged_stop_schema(
            r#"{"stopreason":0,"reason":"任务已完成","has_evidence":1,"issue_cause":"需求已满足","excluded_factors":"无关路径已排除","diagnostic_order":"代码->测试->结果","done_steps":"完成修改并验证","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":""}"#,
        );
        let result = evaluate_stop_schema_gate(text.as_str(), 0, 3, "", 0);
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
    fn triggers_when_persisted_snapshot_exists() {
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
    fn skips_when_not_stop_eligible() {
        let mut ctx = base_ctx();
        ctx.stop_eligible = false;
        let result = decide(&ctx);
        assert_eq!(result.action, Action::Skip);
        assert_eq!(result.skip_reason.unwrap(), "skip_not_stop_finish_reason");
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
    fn stop_message_runtime_snapshot_uses_budgeted_snapshot() {
        let mut ctx = base_ctx();
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
    fn provider_change_preserves_persisted_snapshot_budget_inside_same_term() {
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
        assert_eq!(result.used, 2);
        assert!(result
            .followup_text
            .expect("followup text")
            .contains("stop schema"));
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
        assert!(result
            .followup_text
            .expect("followup text")
            .contains("stop schema"));
    }

    #[test]
    fn stop_schema_finished_or_blocked_with_reason_allows_stop() {
        let finished = evaluate_stop_schema_gate(
            format!(
                "已完成在线验证。\n{}",
                tagged_stop_schema(r#"{"stopreason":0,"reason":"已完成并验证","has_evidence":1,"evidence":"cargo test green","issue_cause":"目标功能已验证","excluded_factors":"非相关配置未改动","diagnostic_order":"代码审计 -> 单测 -> 类型检查","done_steps":"补齐 Rust gate 并跑测试","next_step":"","learned":"缺 schema 计入连续 stop 预算"}"#)
            )
            .as_str(),
            0,
            3,
        "", 0,
        );
        assert_eq!(finished.action, StopSchemaGateAction::AllowStop);
        assert!(finished.summary_prefix.is_none());
        assert_eq!(
            finished
                .parsed
                .as_ref()
                .and_then(|row| row.learned.as_deref()),
            Some("缺 schema 计入连续 stop 预算")
        );

        let blocked = evaluate_stop_schema_gate(
            format!(
                "当前卡住。\n{}",
                tagged_stop_schema(r#"{"stopreason":1,"reason":"缺少上游权限","has_evidence":1,"evidence":"HTTP 401 from upstream","issue_cause":"credential expired","excluded_factors":"本地网络正常","diagnostic_order":"请求日志 -> provider 响应 -> auth 检查","done_steps":"确认上游拒绝","next_step":"等待授权"}"#)
            )
            .as_str(),
            0,
            3,
        "", 0,
        );
        assert_eq!(blocked.action, StopSchemaGateAction::AllowStop);
        assert!(blocked.summary_prefix.is_none());
    }

    #[test]
    fn stop_schema_terminal_without_visible_text_uses_summary_prefix() {
        let finished = evaluate_stop_schema_gate_with_reasoning_stop_arguments(
            "",
            Some(
                r#"{"stopreason":0,"reason":"已完成并验证","has_evidence":1,"evidence":"cargo test green","issue_cause":"目标功能已验证","excluded_factors":"非相关配置未改动","diagnostic_order":"代码审计 -> 单测 -> 类型检查","done_steps":"补齐 Rust gate 并跑测试","next_step":"","learned":"缺 schema 计入连续 stop 预算"}"#,
            ),
            0,
            3,
            "",
            0,
        );
        assert_eq!(finished.action, StopSchemaGateAction::AllowStop);
        assert!(finished
            .summary_prefix
            .as_deref()
            .unwrap_or("")
            .contains("已完成并验证"));
    }

    #[test]
    fn stop_schema_blocked_without_reason_follows_up() {
        let decision = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"stopreason":1,"reason":"","has_evidence":0,"next_step":""}"#)
                .as_str(),
            0,
            3,
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_reason_missing");
        assert!(decision.count_budget);
        assert!(decision.followup_text.unwrap().contains("blocked"));
    }

    #[test]
    fn stop_schema_terminal_requires_evidence_and_diagnostics() {
        let missing_evidence_flag = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"stopreason":0,"reason":"完成","has_evidence":0,"evidence":"cargo test green","issue_cause":"已验证","excluded_factors":"无关配置","diagnostic_order":"测试","done_steps":"修改代码","next_step":""}"#).as_str(),
            0,
            3,
        "", 0,
        );
        assert_eq!(
            missing_evidence_flag.reason_code,
            "stop_schema_terminal_missing_fields"
        );
        assert!(missing_evidence_flag
            .missing_fields
            .contains(&"has_evidence".to_string()));
        assert_eq!(missing_evidence_flag.action, StopSchemaGateAction::Followup);
        assert!(missing_evidence_flag.count_budget);

        for (payload, missing_field) in [(
            r#"{"stopreason":0,"reason":"完成","has_evidence":1,"evidence":"","issue_cause":"已验证","excluded_factors":"无关配置","diagnostic_order":"测试","done_steps":"修改代码","next_step":""}"#,
            "evidence",
        )] {
            let wrapped = tagged_stop_schema(payload);
            let decision = evaluate_stop_schema_gate(wrapped.as_str(), 0, 3, "", 0);
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
{"stopreason":2,"reason":"还没完成","current_goal":"完成 stop schema gate 验证","has_evidence":0,"next_step":"运行 targeted tests"}
```"#,
            1,
            3,
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_continue_next_step");
        let text = decision.followup_text.unwrap();
        assert_eq!(text, "运行 targeted tests");
        assert!(
            !decision.count_budget,
            "valid stopreason=2 + next_step is progress control and must not consume loop budget"
        );
        assert!(decision.missing_fields.is_empty());
    }

    #[test]
    fn bare_stop_schema_json_is_valid_schema_input() {
        let decision = evaluate_stop_schema_gate(
            r#"{"stopreason":2,"reason":"还没完成","current_goal":"完成 stop schema gate 验证","has_evidence":0,"next_step":"运行 targeted tests"}"#,
            1,
            3,
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_continue_next_step");
        assert!(!decision.count_budget);
    }

    #[test]
    fn bare_stop_schema_json_missing_current_goal_is_corrective_followup() {
        let decision = evaluate_stop_schema_gate(
            r#"{"stopreason":2,"reason":"第一轮还没做完","next_step":"等待 stop_message_auto 工具结果后继续第二轮验证"}"#,
            1,
            3,
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_current_goal_missing");
        assert_eq!(decision.missing_fields, vec!["current_goal"]);
        assert!(decision.count_budget);
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
            tagged_stop_schema(
                r#"{"stopreason":"unknown","reason":"done","has_evidence":1,"next_step":""}"#,
            )
            .as_str(),
            0,
            3,
            "",
            0,
        );
        assert_eq!(invalid.action, StopSchemaGateAction::Followup);
        assert_eq!(
            invalid.reason_code,
            "stop_schema_stopreason_missing_or_non_numeric"
        );
        assert!(invalid.count_budget);

        let no_next = evaluate_stop_schema_gate(
            tagged_stop_schema(
                r#"{"stopreason":2,"reason":"继续","has_evidence":0,"next_step":""}"#,
            )
            .as_str(),
            0,
            3,
            "",
            0,
        );
        assert_eq!(no_next.action, StopSchemaGateAction::Followup);
        assert_eq!(no_next.reason_code, "stop_schema_next_step_missing");
        assert!(no_next.count_budget);
        assert!(no_next.followup_text.unwrap().contains("只补缺失字段"));

        let no_next_exhausted = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"stopreason":2,"reason":"继续","has_evidence":0,"next_step":"","next_suggested_path":""}"#).as_str(),
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
        assert!(first
            .followup_text
            .as_deref()
            .unwrap_or("")
            .contains("stop schema"));
        assert!(first.missing_fields.contains(&"stopreason".to_string()));
        assert_eq!(first.no_change_count, 1);

        let second = evaluate_stop_schema_gate("普通停止文本", 1, 3, "", 0);
        assert_eq!(second.reason_code, "stop_schema_missing");
        assert_eq!(second.no_change_count, 1);

        let third = evaluate_stop_schema_gate("普通停止文本", 2, 3, "", 0);
        assert_eq!(third.reason_code, "stop_schema_loop_guard_passthrough");
        assert_eq!(third.action, StopSchemaGateAction::AllowStop);
        assert!(!third.count_budget);
    }

    #[test]
    fn stop_schema_allow_stop_summary_is_user_markdown_not_stopreason_report() {
        let decision = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"stopreason":0,"reason":"SSE stop 响应已进入 stopless gate","has_evidence":1,"evidence":"executor 红测和 SSE 回归通过","issue_cause":"prebuilt SSE wrapper 提前直出","excluded_factors":"普通 tool_call SSE 顺序已验证正常","diagnostic_order":"日志样本 -> 红测 -> Rust RespInbound bodyText materialization -> 回归","done_steps":"修复 RespInbound SSE materialization，补红测","next_step":"","learned":"prebuilt SSE stopless 必须由 Rust RespInbound materialize bodyText"}"#).as_str(),
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
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
        assert_eq!(decision.reason_code, "stop_schema_blocked");
        assert!(!decision.count_budget);
    }

    #[test]
    fn stop_schema_missing_exhausts_after_three_consecutive_stops() {
        let third = evaluate_stop_schema_gate("普通停止文本", 2, 3, "", 0);
        assert_eq!(third.action, StopSchemaGateAction::AllowStop);
        assert_eq!(third.reason_code, "stop_schema_loop_guard_passthrough");
        assert!(!third.count_budget);

        let exhausted = evaluate_stop_schema_gate("普通停止文本", 3, 3, "", 0);
        assert_eq!(exhausted.action, StopSchemaGateAction::AllowStop);
        assert_eq!(exhausted.reason_code, "stop_schema_loop_guard_passthrough");
        assert!(!exhausted.count_budget);
    }

    #[test]
    fn stop_schema_provided_exhausts_after_three_consecutive_stops() {
        // 只有 no_change_count 达到 3 才封顶；正常推进不应因 used=2/3 直接终止。
        let still_followup = evaluate_stop_schema_gate(
            tagged_stop_schema(
                r#"{"stopreason":2,"reason":"继续","current_goal":"完成 stop schema gate 验证","has_evidence":0,"next_step":"运行测试"}"#,
            )
            .as_str(),
            2,
            3,
            "",
            0,
        );
        assert_eq!(still_followup.action, StopSchemaGateAction::Followup);
        assert!(!still_followup.count_budget);

        let still_followup_again = evaluate_stop_schema_gate(
            tagged_stop_schema(
                r#"{"stopreason":2,"reason":"继续","current_goal":"完成 stop schema gate 验证","has_evidence":0,"next_step":"运行测试"}"#,
            )
            .as_str(),
            3,
            3,
            "",
            0,
        );
        assert_eq!(still_followup_again.action, StopSchemaGateAction::Followup);
        assert_eq!(
            still_followup_again.reason_code,
            "stop_schema_continue_next_step"
        );
    }

    #[test]
    fn stop_schema_continue_next_step_does_not_exhaust_budget_and_valid_stop_does_not() {
        let continue_next_step = evaluate_stop_schema_gate(
            tagged_stop_schema(
                r#"{"stopreason":2,"reason":"继续","current_goal":"完成 stop schema gate 验证","has_evidence":0,"next_step":"运行测试"}"#,
            )
            .as_str(),
            3,
            3,
            "",
            0,
        );
        assert_eq!(continue_next_step.action, StopSchemaGateAction::Followup);
        assert_eq!(
            continue_next_step.reason_code,
            "stop_schema_continue_next_step"
        );
        assert!(!continue_next_step.count_budget);
        assert!(continue_next_step.followup_text.is_some());

        let valid = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"stopreason":0,"reason":"测试通过","has_evidence":1,"evidence":"cargo test green","issue_cause":"实现已满足 contract","excluded_factors":"无关配置未参与","diagnostic_order":"单测 -> gate","done_steps":"补测试并运行","next_step":""}"#).as_str(),
            3,
            3,
        "", 0,
        );
        assert_eq!(valid.action, StopSchemaGateAction::AllowStop);
        assert_eq!(valid.reason_code, "stop_schema_finished");
        assert!(!valid.count_budget);
    }

    #[test]
    fn needs_user_input_with_next_step_allows_stop_without_budget() {
        let decision = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"stopreason":2,"reason":"需要确认","has_evidence":0,"next_step":"请确认：你希望使用哪个版本的 API？v1 还是 v2？","needs_user_input":true}"#).as_str(),
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
            tagged_stop_schema(r#"{"stopreason":2,"reason":"需要确认","has_evidence":0,"next_step":"","needs_user_input":true}"#).as_str(),
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
            tagged_stop_schema(r#"{"stopreason":2,"reason":"确认","has_evidence":0,"next_step":"问题内容","needs_user_input":true}"#).as_str(),
            0,
            3,
        "", 0,
        );
        assert_eq!(d1.action, StopSchemaGateAction::AllowStop);
        assert!(!d1.count_budget);

        // Second round: normal stopreason=0 → should still be at used=0
        let d2 = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"stopreason":0,"reason":"已完成","has_evidence":1,"evidence":"测试通过","issue_cause":"目标已验证","excluded_factors":"无需用户输入","diagnostic_order":"确认问题 -> 跑测试","done_steps":"完成实现","next_step":""}"#).as_str(),
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
        assert!(STOP_SCHEMA_JSON_EXAMPLE.contains("simple_question"));
        assert!(!STOP_SCHEMA_JSON_EXAMPLE.contains(r#"stopreason":3"#));
        assert!(!STOP_SCHEMA_JSON_EXAMPLE.contains("forcestop"));
    }

    #[test]
    fn simple_question_allows_natural_stop_without_stopreason() {
        let decision = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"simple_question":true}"#).as_str(),
            0,
            3,
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
        assert_eq!(decision.reason_code, "stop_schema_simple_question");
        assert!(!decision.count_budget);
        assert!(decision.missing_fields.is_empty());
        assert_eq!(
            decision
                .parsed
                .as_ref()
                .and_then(|parsed| parsed.simple_question),
            Some(true)
        );
    }

    #[test]
    fn simple_question_true_overrides_other_stop_schema_fields() {
        let decision = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"simple_question":true,"stopreason":"unknown"}"#).as_str(),
            0,
            3,
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
        assert_eq!(decision.reason_code, "stop_schema_simple_question");
        assert!(decision.missing_fields.is_empty());
    }

    #[test]
    fn simple_question_false_still_requires_stopreason() {
        let decision = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"simple_question":false}"#).as_str(),
            0,
            3,
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(
            decision.reason_code,
            "stop_schema_stopreason_missing_or_non_numeric"
        );
        assert!(decision.missing_fields.contains(&"stopreason".to_string()));
    }

    #[test]
    fn continue_with_goal_and_next_step_uses_next_step_prompt() {
        let decision = evaluate_stop_schema_gate(
            tagged_stop_schema(
                r#"{"stopreason":2,"reason":"还没完成","current_goal":"完成 stopless schema 目标回填","next_step":"运行 stopless 黑盒验证","needs_user_input":false}"#,
            )
            .as_str(),
            0,
            3,
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_continue_next_step");
        assert!(!decision.count_budget);
        assert!(decision.missing_fields.is_empty());
        let followup = decision.followup_text.as_ref().expect("followup");
        assert_eq!(followup, "运行 stopless 黑盒验证");
    }

    #[test]
    fn continue_next_step_without_goal_requires_current_goal() {
        let decision = evaluate_stop_schema_gate(
            tagged_stop_schema(
                r#"{"stopreason":2,"reason":"还没完成","next_step":"运行 stopless 黑盒验证","needs_user_input":false}"#,
            )
            .as_str(),
            0,
            3,
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_current_goal_missing");
        assert!(decision.count_budget);
        assert_eq!(decision.missing_fields, vec!["current_goal".to_string()]);
        let followup = decision.followup_text.as_ref().expect("followup");
        assert!(followup.contains("你还没有写 current_goal"));
        assert!(followup.contains("你现在的任务目标是什么"));
        assert!(!followup.contains("运行 stopless 黑盒验证"));
    }

    #[test]
    fn forcestop_with_reason_allows_stop_without_other_fields() {
        let decision = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"forcestop":1,"reason":"已用尽所有排查手段，循环无法突破"}"#)
                .as_str(),
            0,
            3,
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
        assert_eq!(decision.reason_code, "stop_schema_forcestop");
        assert!(!decision.count_budget);
        assert!(decision
            .summary_prefix
            .as_ref()
            .unwrap()
            .contains("强制停止"));
        assert!(decision
            .summary_prefix
            .as_ref()
            .unwrap()
            .contains("已用尽所有排查手段"));
    }

    #[test]
    fn forcestop_without_reason_follows_up_with_guidance() {
        let decision = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"forcestop":1,"reason":""}"#).as_str(),
            0,
            3,
            "",
            0,
        );
        assert_eq!(decision.action, StopSchemaGateAction::Followup);
        assert_eq!(decision.reason_code, "stop_schema_forcestop_reason_missing");
        assert!(decision
            .followup_text
            .as_ref()
            .unwrap()
            .contains("forcestop=1"));
        assert!(decision
            .followup_text
            .as_ref()
            .unwrap()
            .contains("非空 reason"));
        assert!(decision.missing_fields.contains(&"reason".to_string()));
    }

    #[test]
    fn forcestop_takes_priority_over_stopreason_zero_missing_fields() {
        // forcestop=1 should allow stop even when normal stop schema is incomplete
        let decision = evaluate_stop_schema_gate(
            tagged_stop_schema(r#"{"forcestop":1,"reason":"必须立刻停止","stopreason":0,"has_evidence":0,"reason":"必须立刻停止"}"#).as_str(),
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
        let second = evaluate_stop_schema_gate(
            "普通停止文本",
            0,
            3,
            &first.observation_hash,
            first.no_change_count,
        );
        assert_eq!(second.no_change_count, 2);
        assert_eq!(second.action, StopSchemaGateAction::Followup);

        // Third consecutive stop passes through without projecting a fourth CLI.
        let third = evaluate_stop_schema_gate(
            "普通停止文本",
            0,
            3,
            &second.observation_hash,
            second.no_change_count,
        );
        assert_eq!(third.no_change_count, 3);
        assert_eq!(third.action, StopSchemaGateAction::AllowStop);
        assert_eq!(third.reason_code, "stop_schema_loop_guard_passthrough");
    }

    /// Different schema texts get different hashes -> no_change_count resets
    #[test]
    fn no_change_count_resets_on_different_schema_failure() {
        let first = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
        assert_eq!(first.no_change_count, 1);

        // Different text but no schema -> still same hash (reason_code same, missing_fields same)
        let second = evaluate_stop_schema_gate(
            "另外的停止文本",
            0,
            3,
            &first.observation_hash,
            first.no_change_count,
        );
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
            tagged_stop_schema(r#"{"stopreason":"invalid"}"#).as_str(),
            0,
            3,
            "",
            0,
        );
        assert_eq!(
            invalid.reason_code,
            "stop_schema_stopreason_missing_or_non_numeric"
        );

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
            tagged_stop_schema(r#"{"stopreason":0,"reason":"已完成","has_evidence":1,"evidence":"通过","issue_cause":"无","excluded_factors":"无","diagnostic_order":"直测","done_steps":"完成","next_step":""}"#).as_str(),
            0, 3, "", 0
        );
        assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
        assert_eq!(decision.no_change_count, 0);
        assert_eq!(decision.observation_hash, "");
    }

    /// Loop-guard passthrough still returns the final observation hash.
    #[test]
    fn loop_guard_passthrough_returns_observation_hash() {
        let first = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
        let second = evaluate_stop_schema_gate(
            "普通停止文本",
            0,
            3,
            &first.observation_hash,
            first.no_change_count,
        );
        let third = evaluate_stop_schema_gate(
            "普通停止文本",
            0,
            3,
            &second.observation_hash,
            second.no_change_count,
        );
        assert_eq!(third.action, StopSchemaGateAction::AllowStop);
        assert_eq!(third.reason_code, "stop_schema_loop_guard_passthrough");
        assert!(third.observation_hash.len() > 0);
    }

    /// no_change_count from schema_invalid_followup paths
    #[test]
    fn invalid_schema_no_change_count_accumulates() {
        let invalid_stopreason = r#"{"stopreason":"xyz"}"#;
        let first = evaluate_stop_schema_gate(invalid_stopreason, 0, 3, "", 0);
        assert_eq!(first.no_change_count, 1);

        let second = evaluate_stop_schema_gate(
            invalid_stopreason,
            0,
            3,
            &first.observation_hash,
            first.no_change_count,
        );
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
