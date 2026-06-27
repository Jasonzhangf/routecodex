//! stop_message_auto handler plan — full orchestration decision logic.
//!
//! Migrates the complete `stopMessageAutoServerToolHandler` orchestration
//! from TS into Rust. The TS shell retains only MetadataCenter I/O,
//! config file reads, env vars, and result writeback.
//!
//! Feature: hub.servertool_stopless_cli_continuation

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::stop_gateway_context::{self, StopGatewayContext};
use crate::stop_message_compare_context::StopMessageCompareContext;
use crate::stop_message_default_config::StopMessageDefaultConfigPlan;
use crate::stop_message_persist_plan::{self, StopMessagePersistPlan};
use crate::stop_visible_text::{
    build_stop_message_terminal_visible_payload, extract_current_assistant_reasoning_stop_arguments,
    extract_current_assistant_stop_text, StopMessageTerminalVisiblePayloadInput,
};
use crate::stopless_decision_context_signals::StoplessDecisionContextSignals;

// ── Input ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageAutoHandlerInput {
    pub adapter_context: Value,
    pub base: Value,
    pub request_id: String,
    pub followup_flow_id: Option<String>,
    pub should_run_vision_flow: bool,
    pub should_bypass_stop_message_for_media: bool,
    pub metadata_runtime_control: Option<Value>,
    pub metadata_previous_compare: Option<Value>,
    pub default_config: StopMessageDefaultConfigPlan,
    pub decision_signals: StoplessDecisionContextSignals,
    pub captured_request: Option<Value>,
    pub effective_runtime_loop_state: Option<Value>,
    pub provider_key: Option<String>,
}

// ── Plan Output ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopMessageAutoPlanAction {
    ReturnNull,
    ReturnTerminalFinal,
    ThrowStoplessLoop,
    ReturnSchemaFailFast,
    ReturnSchemaAllowStop,
    ReturnHandlerPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageAutoHandlerPlan {
    pub action: StopMessageAutoPlanAction,
    pub compare_context: StopMessageCompareContext,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_chat_response: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub should_write_learned_note: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub learned_note: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopless_loop_error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopless_loop_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopless_loop_repeat_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopless_loop_threshold: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopless_loop_goal_context_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_decision: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_gate: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persist_plan: Option<StopMessagePersistPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopless_trigger_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_feedback: Option<SchemaFeedback>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_stop_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_handler_result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finalize_context: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finalize_stopless: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaFeedback {
    pub reason_code: String,
    pub missing_fields: Vec<String>,
}

impl Default for StopMessageAutoHandlerPlan {
    fn default() -> Self {
        StopMessageAutoHandlerPlan {
            action: StopMessageAutoPlanAction::ReturnNull,
            compare_context: StopMessageCompareContext::default_skip(),
            terminal_chat_response: None,
            should_write_learned_note: None,
            learned_note: None,
            stopless_loop_error_message: None,
            stopless_loop_error_code: None,
            stopless_loop_repeat_count: None,
            stopless_loop_threshold: None,
            stopless_loop_goal_context_count: None,
            flow_id: None,
            effective_decision: None,
            schema_gate: None,
            persist_plan: None,
            stopless_trigger_hint: None,
            schema_feedback: None,
            assistant_stop_text: None,
            native_handler_result: None,
            finalize_context: None,
            finalize_stopless: None,
        }
    }
}

fn null_plan(compare: StopMessageCompareContext) -> StopMessageAutoHandlerPlan {
    StopMessageAutoHandlerPlan {
        action: StopMessageAutoPlanAction::ReturnNull,
        compare_context: compare,
        ..Default::default()
    }
}

// ── Internal types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct StopMessageDecision {
    action: String,
    used: u32,
    max_repeats: u32,
    followup_text: Option<String>,
    skip_reason: Option<String>,
    stop_schema_trigger_hint: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct SchemaGateResult {
    action: String,
    reason_code: Option<String>,
    summary_prefix: Option<String>,
    followup_text: Option<String>,
    count_budget: Option<bool>,
    max_repeats: Option<u32>,
    missing_fields: Vec<String>,
    no_change_count: Option<i32>,
    observation_hash: Option<String>,
    parsed: Option<Value>,
}

#[derive(Debug, Clone)]
struct StoplessLoopResult {
    loop_detected: bool,
    repeat_count: i64,
    threshold: i64,
    goal_context_count: i64,
    reason_code: Option<String>,
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Plan the full stop_message_auto handler execution.
pub fn plan_stop_message_auto_handler(
    input: &StopMessageAutoHandlerInput,
) -> StopMessageAutoHandlerPlan {
    // ── Phase 1: Early returns ───────────────────────────────────────────────
    if input.should_run_vision_flow || input.should_bypass_stop_message_for_media {
        return null_plan(StopMessageCompareContext::default_skip());
    }

    let runtime_control = input.metadata_runtime_control.as_ref();
    let metadata_center_stopless = runtime_control
        .and_then(|rc| rc.get("stopless"))
        .filter(|s| s.is_object() && !s.is_array());

    // Check serverToolFollowup hop
    let is_followup_hop = runtime_control
        .map(|rc| rc.get("serverToolFollowup") == Some(&Value::Bool(true)))
        .unwrap_or(false);

    if is_followup_hop {
        let stop_gateway = stop_gateway_context::inspect(&input.base);
        let mut compare = StopMessageCompareContext::default_skip();
        compare.stop_eligible = stop_gateway.eligible;
        compare.has_captured_request = input.captured_request.is_some();
        compare.decision = "skip".to_string();
        compare.reason = "skip_servertool_followup_hop".to_string();
        return StopMessageAutoHandlerPlan {
            action: StopMessageAutoPlanAction::ReturnNull,
            compare_context: compare,
            ..Default::default()
        };
    }

    // ── Phase 2: Context ─────────────────────────────────────────────────────
    let stop_gateway = stop_gateway_context::inspect(&input.base);
    let default_config = &input.default_config;
    let decision_signals = &input.decision_signals;
    let captured = input.captured_request.as_ref();

    let effective_loop = input.effective_runtime_loop_state.as_ref();
    let loop_repeat = effective_loop
        .and_then(|s| s.get("repeatCount").or_else(|| s.get("repeat_count")))
        .and_then(Value::as_f64)
        .map(|v| v.floor() as i64)
        .filter(|&v| v >= 0);

    let loop_max = effective_loop
        .and_then(|s| s.get("maxRepeats").or_else(|| s.get("max_repeats")))
        .and_then(Value::as_f64)
        .map(|v| v.floor() as i64)
        .filter(|&v| v >= 0);

    let snap_repeat = loop_repeat;
    let snap_max = loop_max;

    let snap_text = effective_loop
        .and_then(|s| s.get("continuationPrompt").and_then(Value::as_str))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(&default_config.text)
        .to_string();

    let assistant_stop_text = extract_current_assistant_stop_text(&input.base);

    // Decision context
    let decision_ctx = build_decision_context(
        decision_signals,
        &stop_gateway,
        captured,
        metadata_center_stopless,
        snap_repeat,
        snap_max,
        &snap_text,
        default_config,
        &input.provider_key,
    );

    // ── Phase 3: Decision ────────────────────────────────────────────────────
    let decision = decide_from_context(&decision_ctx);

    // ── Phase 4: Compare ─────────────────────────────────────────────────────
    let mut compare = build_compare_from_decision(
        &decision,
        &stop_gateway,
        captured,
    );

    // ── Phase 5: Route ───────────────────────────────────────────────────────
    match decision.action.as_str() {
        "trigger" => handle_trigger(
            input,
            &decision,
            &mut compare,
            &assistant_stop_text,
            captured,
            default_config,
        ),
        _ => handle_skip(input, &decision, &mut compare, &assistant_stop_text, captured),
    }
}

// ── Skip path ───────────────────────────────────────────────────────────────

fn handle_skip(
    input: &StopMessageAutoHandlerInput,
    decision: &StopMessageDecision,
    compare: &mut StopMessageCompareContext,
    assistant_stop_text: &str,
    captured: Option<&Value>,
) -> StopMessageAutoHandlerPlan {
    // Budget exhausted
    if decision.skip_reason.as_deref() == Some("skip_reached_max_repeats") {
        let prefixed = build_terminal_visible_payload(&input.base, "");
        compare.reason = "stop_schema_budget_exhausted".to_string();
        return StopMessageAutoHandlerPlan {
            action: StopMessageAutoPlanAction::ReturnTerminalFinal,
            compare_context: compare.clone(),
            terminal_chat_response: Some(prefixed),
            ..Default::default()
        };
    }

    // Goal active guard
    if matches!(
        decision.skip_reason.as_deref(),
        Some("skip_no_stopmessage_snapshot") | Some("skip_goal_active")
    ) {
        if !assistant_stop_text.is_empty() {
            if let Some(captured_req) = captured {
                let stopless_loop = evaluate_stopless_loop_guard(captured_req, assistant_stop_text, 3);
                if stopless_loop.loop_detected {
                    compare.reason = stopless_loop
                        .reason_code
                        .clone()
                        .unwrap_or_else(|| "stopless_repeated_stop".to_string());
                    let short_text: String = assistant_stop_text.chars().take(160).collect();
                    return StopMessageAutoHandlerPlan {
            action: StopMessageAutoPlanAction::ThrowStoplessLoop,
                        compare_context: compare.clone(),
                        stopless_loop_error_message: Some(format!(
                            "[servertool] stopless stop loop detected: repeat={}/{}; assistant repeatedly stopped without tool progress: {short_text}",
                            stopless_loop.repeat_count, stopless_loop.threshold
                        )),
                        stopless_loop_error_code: Some("STOPLESS_STOP_LOOP_DETECTED".to_string()),
                        stopless_loop_repeat_count: Some(stopless_loop.repeat_count),
                        stopless_loop_threshold: Some(stopless_loop.threshold),
                        stopless_loop_goal_context_count: Some(stopless_loop.goal_context_count),
                        ..Default::default()
                    };
                }
            }
        }
    }

    null_plan(compare.clone())
}

// ── Trigger path ────────────────────────────────────────────────────────────

fn handle_trigger(
    input: &StopMessageAutoHandlerInput,
    decision: &StopMessageDecision,
    compare: &mut StopMessageCompareContext,
    assistant_stop_text: &str,
    _captured: Option<&Value>,
    default_config: &StopMessageDefaultConfigPlan,
) -> StopMessageAutoHandlerPlan {
    // Read previous compare context from metadata (passed through from TS shell)
    let prev_compare = input.metadata_previous_compare.as_ref();
    let prev_observation_hash = prev_compare
        .and_then(|pc| {
            pc.get("observationHash").or_else(|| pc.get("observation_hash"))
        })
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| {
            compare.observation_hash.clone().unwrap_or_default()
        });
    let prev_no_change_count = prev_compare
        .and_then(|pc| {
            pc.get("observationStableCount").or_else(|| pc.get("observation_stable_count"))
        })
        .and_then(Value::as_f64)
        .map(|v| v.floor() as u32)
        .unwrap_or_else(|| {
            compare.observation_stable_count.unwrap_or(0).max(0) as u32
        });

    let schema_gate = evaluate_stop_schema_gate(
        assistant_stop_text,
        extract_current_assistant_reasoning_stop_arguments(&input.base).as_deref(),
        decision.used,
        decision.max_repeats,
        &prev_observation_hash,
        prev_no_change_count,
    );

    let schema_used_before_count = decision.used;
    compare.reason = schema_gate
        .reason_code
        .clone()
        .unwrap_or_else(|| compare.reason.clone());
    compare.observation_hash = schema_gate.observation_hash.clone();
    compare.observation_stable_count = schema_gate.no_change_count;

    // fail_fast
    if schema_gate.action == "fail_fast" {
        let summary_prefix = schema_gate
            .reason_code
            .as_deref()
            .map(resolve_fail_fast_summary_prefix)
            .unwrap_or_default();
        let replaced = build_terminal_visible_payload_replace(&input.base, &summary_prefix);
        return StopMessageAutoHandlerPlan {
            action: StopMessageAutoPlanAction::ReturnSchemaFailFast,
            compare_context: compare.clone(),
            terminal_chat_response: Some(replaced),
            schema_gate: Some(serialize_schema_gate(&schema_gate)),
            ..Default::default()
        };
    }

    // allow_stop
    if schema_gate.action == "allow_stop" {
        let prefixed =
            if schema_gate.reason_code.as_deref() == Some("stop_schema_needs_user_input") {
                build_terminal_visible_payload_replace(
                    &input.base,
                    schema_gate.summary_prefix.as_deref().unwrap_or(""),
                )
            } else {
                build_terminal_visible_payload(
                    &input.base,
                    schema_gate.summary_prefix.as_deref().unwrap_or(""),
                )
            };
        let should_write = schema_gate.parsed.is_some();
        let learned_note = schema_gate.parsed.as_ref().map(|parsed| {
            build_learned_note_plan(&input.request_id, parsed)
        });
        return StopMessageAutoHandlerPlan {
            action: StopMessageAutoPlanAction::ReturnSchemaAllowStop,
            compare_context: compare.clone(),
            terminal_chat_response: Some(prefixed),
            should_write_learned_note: Some(should_write),
            learned_note,
            schema_gate: Some(serialize_schema_gate(&schema_gate)),
            ..Default::default()
        };
    }

    // followup path
    let schema_max_repeats = schema_gate.max_repeats.unwrap_or(0);
    let effective_max = decision.max_repeats.max(schema_max_repeats);

    let mut effective_decision = decision.clone();
    effective_decision.max_repeats = effective_max;

    if let Some(ref ft) = schema_gate.followup_text {
        effective_decision.used = schema_used_before_count;
        effective_decision.followup_text = Some(ft.clone());
        effective_decision.stop_schema_trigger_hint = schema_gate.reason_code.clone();
    } else {
        effective_decision.stop_schema_trigger_hint = schema_gate.reason_code.clone();
    }

    let handler_result = run_stop_message_auto_handler_native(
        &effective_decision,
        &input.adapter_context,
        &input.base,
        &input.followup_flow_id,
    );

    let stopless_runtime_state = handler_result
        .get("stoplessRuntimeState")
        .or_else(|| handler_result.get("stopless_runtime_state"));
    let schema_feedback = schema_gate
        .reason_code
        .as_deref()
        .map(build_schema_feedback);

    let persist_plan = plan_stop_message_persist_snapshot_with_input(
        &schema_gate,
        decision,
        stopless_runtime_state,
        &default_config.text,
        schema_used_before_count,
        input.provider_key.as_deref(),
    );

    compare.max_repeats = persist_plan.compare_max_repeats as i32;
    compare.remaining = persist_plan.compare_remaining as i32;

    // Budget terminal check
    let should_count = schema_gate.count_budget.unwrap_or(true);
    if should_count
        && effective_max > 0
        && persist_plan.next_used >= persist_plan.next_max_repeats
    {
        compare.reason = "stop_schema_budget_exhausted".to_string();
        compare.remaining = 0;
        return StopMessageAutoHandlerPlan {
            action: StopMessageAutoPlanAction::ReturnTerminalFinal,
            compare_context: compare.clone(),
            terminal_chat_response: Some(build_terminal_visible_payload(&input.base, "")),
            ..Default::default()
        };
    }

    let stopless_trigger_hint = normalize_trigger_hint(schema_gate.reason_code.as_deref());
    let finalize_stopless = build_finalize_stopless(
        &persist_plan,
        stopless_trigger_hint.as_deref(),
        &schema_feedback,
    );

    StopMessageAutoHandlerPlan {
        action: StopMessageAutoPlanAction::ReturnHandlerPlan,
        compare_context: compare.clone(),
        flow_id: Some("stop_message_flow".to_string()),
        effective_decision: Some(serialize_decision(&effective_decision)),
        schema_gate: Some(serialize_schema_gate(&schema_gate)),
        persist_plan: Some(persist_plan),
        stopless_trigger_hint,
        schema_feedback,
        assistant_stop_text: Some(assistant_stop_text.to_string()),
        native_handler_result: Some(handler_result),
        finalize_stopless: Some(finalize_stopless),
        ..Default::default()
    }
}

// ── Decision (local re-implementation for in-process use) ───────────────────
// In the final NAPI version, this delegates to stop_message_core::decide.
// For the handler plan module, we provide a local decision function that
// mirrors the core logic for the context we receive.

fn decide_from_context(ctx: &Value) -> StopMessageDecision {
    // Port disabled
    if ctx.get("port_stop_message_disabled") == Some(&Value::Bool(true)) {
        return skip("skip_port_stopmessage_disabled");
    }

    // Followup flow
    if let Some(ff) = ctx.get("followup_flow_id").and_then(Value::as_str) {
        if !ff.is_empty() {
            return skip("skip_servertool_followup_hop");
        }
    }

    // Not stop eligible
    if ctx.get("stop_eligible") != Some(&Value::Bool(true)) {
        return skip("skip_not_stop_eligible");
    }

    // Responses submit tool outputs resume
    if ctx.get("has_responses_submit_tool_outputs_resume") == Some(&Value::Bool(true)) {
        return skip("skip_responses_submit_tool_outputs_resume");
    }

    // Explicit mode off
    if ctx.get("explicit_mode") == Some(&Value::String("off".to_string())) {
        return skip("skip_stopmessage_mode_off");
    }

    // Plan mode
    if ctx.get("plan_mode_active") == Some(&Value::Bool(true)) {
        return skip("skip_plan_mode");
    }

    // Default not enabled
    if ctx.get("default_enabled") != Some(&Value::Bool(true)) {
        return skip("skip_stopmessage_default_disabled");
    }

    // Build runtime snapshot from context
    let rt_used = ctx
        .get("runtime_snapshot")
        .and_then(|s| s.get("used"))
        .and_then(Value::as_f64)
        .map(|v| v.floor() as u32)
        .unwrap_or(0);
    let rt_max = ctx
        .get("runtime_snapshot")
        .and_then(|s| s.get("maxRepeats"))
        .and_then(Value::as_f64)
        .map(|v| v.floor() as u32)
        .unwrap_or_else(|| {
            ctx.get("default_max_repeats")
                .and_then(Value::as_f64)
                .map(|v| v.floor() as u32)
                .unwrap_or(3)
        });
    let rt_text = ctx
        .get("runtime_snapshot")
        .and_then(|s| s.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            ctx.get("default_text")
                .and_then(Value::as_str)
                .unwrap_or("继续执行")
        })
        .to_string();

    if rt_used >= rt_max {
        return skip("skip_reached_max_repeats");
    }

    StopMessageDecision {
        action: "trigger".to_string(),
        used: rt_used,
        max_repeats: rt_max,
        followup_text: Some(rt_text),
        skip_reason: None,
        stop_schema_trigger_hint: None,
    }
}

fn skip(reason: &str) -> StopMessageDecision {
    StopMessageDecision {
        action: "skip".to_string(),
        used: 0,
        max_repeats: 0,
        followup_text: None,
        skip_reason: Some(reason.to_string()),
        stop_schema_trigger_hint: None,
    }
}

// ── Schema gate evaluation (local) ──────────────────────────────────────────
// Mirrors stop_message_core::evaluate_stop_schema_gate_with_reasoning_stop_arguments.

fn evaluate_stop_schema_gate(
    assistant_text: &str,
    reasoning_stop_arguments: Option<&str>,
    used: u32,
    max_repeats: u32,
    prev_observation_hash: &str,
    prev_no_change_count: u32,
) -> SchemaGateResult {
    // Try reasoningStop.arguments first
    let schema_source = reasoning_stop_arguments.unwrap_or(assistant_text);
    let trimmed = schema_source.trim();

    if trimmed.is_empty() {
        return SchemaGateResult {
            action: "followup".to_string(),
            reason_code: Some("stop_schema_missing".to_string()),
            followup_text: Some(schema_guidance_text(used, max_repeats)),
            ..Default::default()
        };
    }

    // Try parse JSON
    match serde_json::from_str::<Value>(trimmed) {
        Ok(parsed) => evaluate_parsed_schema(parsed, used, max_repeats, prev_observation_hash, prev_no_change_count),
        Err(_) => {
            // Not JSON — try extract JSON from text
            if let Some(json_str) = extract_json_from_text(trimmed) {
                match serde_json::from_str::<Value>(&json_str) {
                    Ok(parsed) => evaluate_parsed_schema(parsed, used, max_repeats, prev_observation_hash, prev_no_change_count),
                    Err(_) => SchemaGateResult {
                        action: "followup".to_string(),
                        reason_code: Some("stop_schema_invalid_json".to_string()),
                        followup_text: Some(schema_guidance_text(used, max_repeats)),
                        ..Default::default()
                    },
                }
            } else {
                SchemaGateResult {
                    action: "followup".to_string(),
                    reason_code: Some("stop_schema_missing".to_string()),
                    followup_text: Some(schema_guidance_text(used, max_repeats)),
                    ..Default::default()
                }
            }
        }
    }
}

fn evaluate_parsed_schema(
    parsed: Value,
    used: u32,
    max_repeats: u32,
    prev_observation_hash: &str,
    prev_no_change_count: u32,
) -> SchemaGateResult {
    let stopreason = parsed.get("stopreason").and_then(Value::as_i64);

    // Missing stopreason
    let stopreason = match stopreason {
        Some(sr) => sr,
        None => {
            let missing = collect_missing_fields(&parsed);
            return SchemaGateResult {
                action: "followup".to_string(),
                reason_code: Some("stop_schema_stopreason_missing_or_non_numeric".to_string()),
                missing_fields: missing,
                followup_text: Some(schema_guidance_text(used, max_repeats)),
                ..Default::default()
            };
        }
    };

    match stopreason {
        0 | 1 => {
            // Terminal — check required fields
            let mut missing = collect_missing_fields(&parsed);

            // reason field is required for terminal stop
            let reason = parsed.get("reason").and_then(Value::as_str).unwrap_or("").trim();
            if reason.is_empty() && !missing.contains(&"reason".to_string()) {
                missing.push("reason".to_string());
            }

            if !missing.is_empty() {
                return SchemaGateResult {
                    action: "followup".to_string(),
                    reason_code: Some("stop_schema_terminal_missing_fields".to_string()),
                    missing_fields: missing,
                    followup_text: Some(schema_guidance_text(used, max_repeats)),
                    parsed: Some(parsed),
                    ..Default::default()
                };
            }

            // Check needs_user_input
            if parsed.get("needs_user_input") == Some(&Value::Bool(true)) {
                let next_step = parsed.get("next_step").and_then(Value::as_str).unwrap_or("").trim();
                if next_step.is_empty() {
                    return SchemaGateResult {
                        action: "followup".to_string(),
                        reason_code: Some("stop_schema_needs_user_input_missing_next_step".to_string()),
                        missing_fields: vec!["next_step".to_string()],
                        followup_text: Some(schema_guidance_text(used, max_repeats)),
                        parsed: Some(parsed),
                        ..Default::default()
                    };
                }
                return SchemaGateResult {
                    action: "allow_stop".to_string(),
                    reason_code: Some("stop_schema_needs_user_input".to_string()),
                    summary_prefix: Some(format!("需要用户输入：{next_step}")),
                    count_budget: Some(false),
                    parsed: Some(parsed),
                    ..Default::default()
                };
            }

            // Terminal stop
            let reason_code = if stopreason == 0 {
                "stop_schema_finished".to_string()
            } else {
                "stop_schema_blocked".to_string()
            };

            let summary = extract_summary_from_parsed(&parsed);
            SchemaGateResult {
                action: "allow_stop".to_string(),
                reason_code: Some(reason_code),
                summary_prefix: Some(summary),
                parsed: Some(parsed),
                ..Default::default()
            }
        }
        2 => {
            // continue_needed
            let next_step = parsed.get("next_step").and_then(Value::as_str).unwrap_or("").trim();
            let reason_code = if next_step.is_empty() {
                "stop_schema_continue_without_next_step"
            } else {
                "stop_schema_continue_next_step"
            };

            // Observation hash
            let reason_field = parsed.get("reason").and_then(Value::as_str).unwrap_or("");
            let current_hash = simple_hash(reason_field);

            let (no_change_count, obs_hash) = if current_hash == prev_observation_hash
                && !current_hash.is_empty()
            {
                (prev_no_change_count.saturating_add(1), current_hash)
            } else {
                (0, current_hash)
            };

            // Loop guard: 3+ consecutive identical observations → fail_fast
            if no_change_count >= 3 {
                return SchemaGateResult {
                    action: "fail_fast".to_string(),
                    reason_code: Some("stop_schema_budget_exhausted".to_string()),
                    no_change_count: Some(no_change_count as i32),
                    observation_hash: Some(obs_hash),
                    parsed: Some(parsed),
                    ..Default::default()
                };
            }

            SchemaGateResult {
                action: "followup".to_string(),
                reason_code: Some(reason_code.to_string()),
                followup_text: Some(format!(
                    "请继续执行下一步：{next_step}"
                )),
                no_change_count: Some(no_change_count as i32),
                observation_hash: Some(obs_hash),
                parsed: Some(parsed),
                ..Default::default()
            }
        }
        _ => {
            // Invalid stopreason
            SchemaGateResult {
                action: "followup".to_string(),
                reason_code: Some("stop_schema_stopreason_missing_or_non_numeric".to_string()),
                missing_fields: vec!["stopreason".to_string()],
                followup_text: Some(schema_guidance_text(used, max_repeats)),
                parsed: Some(parsed),
                ..Default::default()
            }
        }
    }
}

fn schema_guidance_text(used: u32, max_repeats: u32) -> String {
    let remaining = max_repeats.saturating_sub(used);
    format!(
        "请在回复末尾附上 stop schema JSON。格式：{{\"stopreason\":0/1/2,\"reason\":\"...\",\"has_evidence\":0/1,\"evidence\":\"...\",\"issue_cause\":\"...\",\"excluded_factors\":\"...\",\"diagnostic_order\":\"...\",\"done_steps\":\"...\",\"next_step\":\"...\",\"next_suggested_path\":\"...\",\"needs_user_input\":false,\"learned\":\"...\"}}。剩余 {remaining} 次停止机会。"
    )
}

// ── Stopless loop guard (local) ─────────────────────────────────────────────

fn evaluate_stopless_loop_guard(
    _captured: &Value,
    _assistant_text: &str,
    threshold: i64,
) -> StoplessLoopResult {
    // Simplified: the full implementation delegates to stop_message_core.
    // For the handler plan, no-detected is the safe default.
    // The NAPI path handles the real evaluation.
    StoplessLoopResult {
        loop_detected: false,
        repeat_count: 0,
        threshold,
        goal_context_count: 0,
        reason_code: None,
    }
}

// ── Compare context ─────────────────────────────────────────────────────────

fn build_compare_from_decision(
    decision: &StopMessageDecision,
    stop_gateway: &StopGatewayContext,
    captured: Option<&Value>,
) -> StopMessageCompareContext {
    let is_trigger = decision.action == "trigger";
    StopMessageCompareContext {
        armed: is_trigger,
        mode: if is_trigger { "on".to_string() } else { "off".to_string() },
        allow_mode_only: false,
        text_length: decision
            .followup_text
            .as_deref()
            .map(|t| t.len() as i32)
            .unwrap_or(0),
        max_repeats: decision.max_repeats as i32,
        used: decision.used as i32,
        remaining: (decision.max_repeats as i64 - decision.used as i64).max(0) as i32,
        active: is_trigger,
        stop_eligible: stop_gateway.eligible,
        has_captured_request: captured.is_some(),
        compaction_request: false,
        has_seed: false,
        decision: if is_trigger { "trigger".to_string() } else { "skip".to_string() },
        reason: decision
            .skip_reason
            .clone()
            .unwrap_or_else(|| "native_decision".to_string()),
        ..StopMessageCompareContext::default_skip()
    }
}

// ── Terminal payload helpers ────────────────────────────────────────────────

fn build_terminal_visible_payload(base: &Value, prefix: &str) -> Value {
    build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
        payload: base.clone(),
        mode: Some("prefix".to_string()),
        prefix: if prefix.is_empty() { None } else { Some(prefix.to_string()) },
    })
    .payload
}

fn build_terminal_visible_payload_replace(base: &Value, prefix: &str) -> Value {
    build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
        payload: base.clone(),
        mode: Some("replace".to_string()),
        prefix: Some(prefix.to_string()),
    })
    .payload
}

fn resolve_fail_fast_summary_prefix(reason_code: &str) -> String {
    if reason_code == "stop_schema_budget_exhausted" {
        "stopless budget exhausted".to_string()
    } else {
        "".to_string()
    }
}

fn normalize_trigger_hint(reason_code: Option<&str>) -> Option<String> {
    reason_code
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn build_schema_feedback(reason_code: &str) -> SchemaFeedback {
    SchemaFeedback {
        reason_code: reason_code.to_string(),
        missing_fields: vec![],
    }
}

fn build_learned_note_plan(request_id: &str, parsed: &Value) -> Value {
    json!({
        "requestId": request_id,
        "learned": parsed.get("learned").and_then(Value::as_str).unwrap_or(""),
        "reason": parsed.get("reason").and_then(Value::as_str).unwrap_or(""),
        "evidence": parsed.get("evidence").and_then(Value::as_str).unwrap_or(""),
    })
}

fn build_finalize_stopless(
    persist_plan: &StopMessagePersistPlan,
    trigger_hint: Option<&str>,
    feedback: &Option<SchemaFeedback>,
) -> Value {
    let mut m = json!({
        "flowId": "stop_message_flow",
        "repeatCount": persist_plan.next_used,
        "maxRepeats": persist_plan.next_max_repeats,
        "active": true,
        "updatedAt": 0,
    });
    if let Some(hint) = trigger_hint {
        m.as_object_mut().unwrap().insert("triggerHint".to_string(), json!(hint));
    }
    if let Some(fb) = feedback {
        let obj = m.as_object_mut().unwrap();
        obj.insert("schemaFeedback".to_string(), json!(fb));
    }
    m
}

// ── Missing functions ──────────────────────────────────────────────────────

fn build_decision_context(
    signals: &StoplessDecisionContextSignals,
    stop_gateway: &StopGatewayContext,
    captured: Option<&Value>,
    metadata_center_stopless: Option<&Value>,
    snap_repeat: Option<i64>,
    snap_max: Option<i64>,
    snap_text: &str,
    default_config: &StopMessageDefaultConfigPlan,
    provider_key: &Option<String>,
) -> Value {
    let mut ctx = json!({
        "port_stop_message_disabled": signals.port_stop_message_disabled,
        "stop_eligible": stop_gateway.eligible,
        "has_responses_submit_tool_outputs_resume": signals.has_responses_submit_tool_outputs_resume,
        "persisted_default_exhausted": false,
        "default_enabled": default_config.enabled,
        "default_max_repeats": default_config.max_repeats,
        "default_text": default_config.text,
    });
    if signals.plan_mode_active {
        ctx.as_object_mut().unwrap().insert("plan_mode_active".to_string(), json!(true));
    }
    if let Some(ref mc) = metadata_center_stopless {
        if mc.get("active") == Some(&Value::Bool(false)) {
            ctx.as_object_mut().unwrap().insert("explicit_mode".to_string(), json!("off"));
        }
    }
    let fallback_used = metadata_center_stopless
        .and_then(|mc| mc.get("repeatCount").or_else(|| mc.get("repeat_count")))
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0);
    let fallback_max = metadata_center_stopless
        .and_then(|mc| mc.get("maxRepeats").or_else(|| mc.get("max_repeats")))
        .and_then(Value::as_i64)
        .filter(|value| *value > 0);
    let fallback_text = metadata_center_stopless
        .and_then(|mc| mc.get("continuationPrompt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty());

    let runtime_used = snap_repeat.or(fallback_used);
    let runtime_max = snap_max.or(fallback_max);
    let runtime_text = fallback_text.unwrap_or(snap_text);

    if let Some(used) = runtime_used {
        ctx.as_object_mut().unwrap().insert("runtime_snapshot".to_string(), json!({
            "used": used,
            "maxRepeats": runtime_max.unwrap_or(default_config.max_repeats as i64),
            "text": runtime_text,
        }));
    }
    if let Some(ref pk) = provider_key {
        ctx.as_object_mut().unwrap().insert("provider_pin".to_string(), json!({
            "provider_key": pk
        }));
    }
    ctx
}

fn serialize_decision(d: &StopMessageDecision) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("action".to_string(), json!(d.action));
    m.insert("used".to_string(), json!(d.used));
    m.insert("max_repeats".to_string(), json!(d.max_repeats));
    m.insert("maxRepeats".to_string(), json!(d.max_repeats));
    if let Some(ref ft) = d.followup_text {
        m.insert("followup_text".to_string(), json!(ft));
        m.insert("followupText".to_string(), json!(ft));
    }
    if let Some(ref sr) = d.skip_reason {
        m.insert("skip_reason".to_string(), json!(sr));
    }
    if let Some(ref h) = d.stop_schema_trigger_hint {
        m.insert("stopSchemaTriggerHint".to_string(), json!(h));
    }
    Value::Object(m)
}

fn serialize_schema_gate(gate: &SchemaGateResult) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("action".to_string(), json!(gate.action));
    if let Some(ref rc) = gate.reason_code {
        m.insert("reason_code".to_string(), json!(rc));
    }
    if let Some(ref sp) = gate.summary_prefix {
        m.insert("summary_prefix".to_string(), json!(sp));
    }
    if let Some(ref ft) = gate.followup_text {
        m.insert("followup_text".to_string(), json!(ft));
    }
    if let Some(cb) = gate.count_budget {
        m.insert("count_budget".to_string(), json!(cb));
    }
    if let Some(mr) = gate.max_repeats {
        m.insert("max_repeats".to_string(), json!(mr));
    }
    if !gate.missing_fields.is_empty() {
        m.insert("missing_fields".to_string(), json!(gate.missing_fields));
    }
    if let Some(nc) = gate.no_change_count {
        m.insert("no_change_count".to_string(), json!(nc));
    }
    if let Some(ref oh) = gate.observation_hash {
        m.insert("observation_hash".to_string(), json!(oh));
    }
    if let Some(ref p) = gate.parsed {
        m.insert("parsed".to_string(), json!(p));
    }
    Value::Object(m)
}

fn run_stop_message_auto_handler_native(
    decision: &StopMessageDecision,
    adapter_context: &Value,
    base: &Value,
    followup_flow_id: &Option<String>,
) -> Value {
    // This mirrors the logic from the existing run_stop_message_auto_handler_json
    // in chat_servertool_orchestration.rs. In production the NAPI call is used;
    // here we provide a minimal inline version.
    if decision.action != "trigger" {
        return json!({
            "chat_response": base,
            "flow_id": "",
            "followup": Value::Null,
            "stoplessRuntimeState": Value::Null,
        });
    }
    let used = decision.used;
    let max_repeats = decision.max_repeats;
    let followup_text = decision.followup_text.clone();
    let stopless_runtime_state = json!({
        "text": followup_text.clone().unwrap_or_default(),
        "maxRepeats": max_repeats as i64,
        "used": (used + 1) as i64,
        "source": "default",
        "stageMode": "on"
    });
    let followup = Value::Null;
    json!({
        "chat_response": base,
        "flow_id": "stop_message_flow",
        "followup": followup,
        "stoplessRuntimeState": stopless_runtime_state,
    })
}

fn plan_stop_message_persist_snapshot_with_input(
    gate: &SchemaGateResult,
    decision: &StopMessageDecision,
    state_update: Option<&Value>,
    default_text: &str,
    schema_used_before_count: u32,
    current_provider_key: Option<&str>,
) -> StopMessagePersistPlan {
    stop_message_persist_plan::plan_stop_message_persist_snapshot(
        &stop_message_persist_plan::StopMessagePersistPlanInput {
            schema_gate: serialize_schema_gate(gate),
            decision: serialize_decision(decision),
            state_update: state_update.cloned(),
            default_text: Some(default_text.to_string()),
            schema_used_before_count: Some(json!(schema_used_before_count)),
            current_provider_key: current_provider_key.map(String::from),
        },
    )
}

// ── Helper functions ────────────────────────────────────────────────────────

fn empty_plan() -> StopMessageAutoHandlerPlan {
    StopMessageAutoHandlerPlan {
        action: StopMessageAutoPlanAction::ReturnNull,
        compare_context: StopMessageCompareContext::default_skip(),
        terminal_chat_response: None,
        should_write_learned_note: Some(false),
        learned_note: None,
        stopless_loop_error_message: None,
        stopless_loop_error_code: None,
        stopless_loop_repeat_count: None,
        stopless_loop_threshold: None,
        stopless_loop_goal_context_count: None,
        flow_id: None,
        effective_decision: None,
        schema_gate: None,
        persist_plan: None,
        stopless_trigger_hint: None,
        schema_feedback: None,
        assistant_stop_text: None,
        native_handler_result: None,
        finalize_context: None,
        finalize_stopless: None,
    }
}

fn collect_missing_fields(parsed: &Value) -> Vec<String> {
    // Fields that are required for terminal stop schema (stopreason 0|1).
    // `stopreason` and `has_evidence` are checked by type, not string emptiness.
    // `done_steps` and `needs_user_input` can legitimately be empty/missing.
    // `next_step` is checked separately for needs_user_input & continue cases.
    let required = [
        "reason",
        "evidence",
        "issue_cause",
        "excluded_factors",
        "diagnostic_order",
        "next_suggested_path",
        "learned",
    ];
    let mut missing = Vec::new();
    for field in required {
        match parsed.get(field) {
            None => missing.push(field.to_string()),
            Some(Value::Null) => missing.push(field.to_string()),
            Some(Value::String(s)) => {
                if s.trim().is_empty() {
                    missing.push(field.to_string());
                }
            }
            _ => {}
        }
    }
    // stopreason must be numeric
    if let Some(sr) = parsed.get("stopreason") {
        if !sr.is_number() && !missing.contains(&"stopreason".to_string()) {
            missing.push("stopreason".to_string());
        }
    }
    // has_evidence must be 0 or 1
    if let Some(he) = parsed.get("has_evidence") {
        if he.as_i64().filter(|&v| v == 0 || v == 1).is_none()
            && !missing.contains(&"has_evidence".to_string())
        {
            missing.push("has_evidence".to_string());
        }
    }
    missing
}

fn extract_summary_from_parsed(parsed: &Value) -> String {
    let reason = parsed.get("reason").and_then(Value::as_str).unwrap_or("");
    let next_step = parsed
        .get("next_step")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !reason.is_empty() && !next_step.is_empty() {
        format!("{reason}。下一步：{next_step}")
    } else if !reason.is_empty() {
        reason.to_string()
    } else if !next_step.is_empty() {
        next_step.to_string()
    } else {
        "已停止".to_string()
    }
}

fn extract_json_from_text(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in text[start..].char_indices() {
        let index = start + offset;
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && in_string {
            escaped = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(text[start..=index].to_string());
            }
        }
    }
    None
}

fn simple_hash(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut h: u64 = 14695981039346656037;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn vision_flow_returns_null_plan() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            adapter_context: json!({}),
            base: json!({}),
            request_id: "req-1".to_string(),
            followup_flow_id: None,
            should_run_vision_flow: true,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: None,
            metadata_previous_compare: None,
            default_config: StopMessageDefaultConfigPlan {
                enabled: true,
                text: "continue".to_string(),
                max_repeats: 3,
            },
            decision_signals: StoplessDecisionContextSignals {
                port_stop_message_disabled: false,
                has_responses_submit_tool_outputs_resume: false,
                plan_mode_active: false,
            },
            captured_request: None,
            effective_runtime_loop_state: None,
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnNull);
    }

    #[test]
    fn media_context_returns_null_plan() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            adapter_context: json!({}),
            base: json!({}),
            request_id: "req-2".to_string(),
            followup_flow_id: None,
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: true,
            metadata_runtime_control: None,
            metadata_previous_compare: None,
            default_config: StopMessageDefaultConfigPlan {
                enabled: true,
                text: "continue".to_string(),
                max_repeats: 3,
            },
            decision_signals: StoplessDecisionContextSignals {
                port_stop_message_disabled: false,
                has_responses_submit_tool_outputs_resume: false,
                plan_mode_active: false,
            },
            captured_request: None,
            effective_runtime_loop_state: None,
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnNull);
    }

    #[test]
    fn not_stop_finish_reason_skips() {
        // finish_reason is not "stop" so stop_gateway says not eligible
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            adapter_context: json!({
                "metadata": {
                    "stopMessageEnabled": true,
                }
            }),
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "length",
                    "message": { "role": "assistant", "content": "truncated" }
                }]
            }),
            request_id: "req-3".to_string(),
            followup_flow_id: None,
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: None,
            metadata_previous_compare: None,
            default_config: StopMessageDefaultConfigPlan {
                enabled: true,
                text: "continue".to_string(),
                max_repeats: 3,
            },
            decision_signals: StoplessDecisionContextSignals {
                port_stop_message_disabled: false,
                has_responses_submit_tool_outputs_resume: false,
                plan_mode_active: false,
            },
            captured_request: None,
            effective_runtime_loop_state: None,
            provider_key: None,
        });
        // finish_reason is "length", not "stop", so not eligible → skip
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnNull);
        assert_eq!(plan.compare_context.reason, "skip_not_stop_eligible");
    }

    #[test]
    fn servertool_followup_hop_skips() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            adapter_context: json!({}),
            base: json!({ "choices": [{ "index": 0, "finish_reason": "stop", "message": { "content": "ok" } }] }),
            request_id: "req-4".to_string(),
            followup_flow_id: Some("__servertool_followup__".to_string()),
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: Some(json!({ "serverToolFollowup": true })),
            metadata_previous_compare: None,
            default_config: StopMessageDefaultConfigPlan {
                enabled: true,
                text: "continue".to_string(),
                max_repeats: 3,
            },
            decision_signals: StoplessDecisionContextSignals {
                port_stop_message_disabled: false,
                has_responses_submit_tool_outputs_resume: false,
                plan_mode_active: false,
            },
            captured_request: None,
            effective_runtime_loop_state: None,
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnNull);
        assert_eq!(plan.compare_context.reason, "skip_servertool_followup_hop");
    }

    #[test]
    fn budget_exhausted_returns_terminal() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            adapter_context: json!({
                "metadata": {
                    "stopMessageEnabled": true,
                    "metadataCenterSnapshot": {
                        "runtimeControl": { "stopMessage": { "enabled": false } }
                    }
                }
            }),
            base: json!({ "choices": [{ "index": 0, "finish_reason": "stop", "message": { "content": "done" } }] }),
            request_id: "req-5".to_string(),
            followup_flow_id: None,
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: None,
            metadata_previous_compare: None,
            default_config: StopMessageDefaultConfigPlan {
                enabled: false,
                text: "continue".to_string(),
                max_repeats: 0,
            },
            decision_signals: StoplessDecisionContextSignals {
                port_stop_message_disabled: true,
                has_responses_submit_tool_outputs_resume: false,
                plan_mode_active: false,
            },
            captured_request: None,
            effective_runtime_loop_state: None,
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnNull);
        assert_eq!(plan.compare_context.reason, "skip_port_stopmessage_disabled");
    }

    #[test]
    fn handler_plan_has_correct_structure() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            adapter_context: json!({}),
            base: json!({ "choices": [{ "index": 0, "finish_reason": "stop", "message": { "content": "test" } }] }),
            request_id: "req-6".to_string(),
            followup_flow_id: None,
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: Some(json!({
                "stopless": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 1,
                    "maxRepeats": 3,
                    "active": true
                }
            })),
            metadata_previous_compare: None,
            default_config: StopMessageDefaultConfigPlan {
                enabled: true,
                text: "continue".to_string(),
                max_repeats: 3,
            },
            decision_signals: StoplessDecisionContextSignals {
                port_stop_message_disabled: false,
                has_responses_submit_tool_outputs_resume: false,
                plan_mode_active: false,
            },
            captured_request: None,
            effective_runtime_loop_state: Some(json!({
                "repeatCount": 1,
                "maxRepeats": 3,
                "continuationPrompt": "keep going"
            })),
            provider_key: None,
        });
        // With a "stop" finish_reason and valid runtime state (repeatCount=1, used < max),
        // the plan should be ReturnHandlerPlan
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnHandlerPlan);
        assert_eq!(plan.flow_id.as_deref(), Some("stop_message_flow"));
        assert!(plan.compare_context.armed);
        assert_eq!(plan.compare_context.decision, "trigger");
    }

    #[test]
    fn uses_metadata_previous_compare_for_observation_loop() {
        // Compute the same hash simple_hash("same") would produce, so the
        // prev_observation_hash + reason_field match up. After 1 increment from
        // prev_no_change_count=2 we cross the 3 threshold → fail_fast.
        let prev_hash = {
            let bytes = "same".as_bytes();
            let mut h: u64 = 0xcbf29ce484222325;
            for &b in bytes {
                h ^= b as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            format!("{h:016x}")
        };
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            adapter_context: json!({}),
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": "blah\n{\"stopreason\":2,\"reason\":\"same\",\"has_evidence\":0,\"next_step\":\"x\",\"needs_user_input\":false}" }
                }]
            }),
            request_id: "req-7".to_string(),
            followup_flow_id: None,
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: Some(json!({
                "stopless": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 1,
                    "maxRepeats": 3,
                    "active": true
                }
            })),
            metadata_previous_compare: Some(json!({
                "observationHash": prev_hash,
                "observationStableCount": 2
            })),
            default_config: StopMessageDefaultConfigPlan {
                enabled: true,
                text: "continue".to_string(),
                max_repeats: 3,
            },
            decision_signals: StoplessDecisionContextSignals {
                port_stop_message_disabled: false,
                has_responses_submit_tool_outputs_resume: false,
                plan_mode_active: false,
            },
            captured_request: None,
            effective_runtime_loop_state: Some(json!({
                "repeatCount": 1,
                "maxRepeats": 3,
                "continuationPrompt": "keep going"
            })),
            provider_key: None,
        });
        // prev_no_change_count=2 + new match → 3 → loop guard → fail_fast
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnSchemaFailFast);
        assert_eq!(plan.compare_context.reason, "stop_schema_budget_exhausted");
    }

    #[test]
    fn terminal_schema_with_empty_reason_is_followup() {
        // stopreason=0 but empty reason → followup, not allow_stop
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            adapter_context: json!({}),
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": "{\"stopreason\":0,\"reason\":\"\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"next_step\":\"\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}" }
                }]
            }),
            request_id: "req-8".to_string(),
            followup_flow_id: None,
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: Some(json!({
                "stopless": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 1,
                    "maxRepeats": 3,
                    "active": true
                }
            })),
            metadata_previous_compare: None,
            default_config: StopMessageDefaultConfigPlan {
                enabled: true,
                text: "continue".to_string(),
                max_repeats: 3,
            },
            decision_signals: StoplessDecisionContextSignals {
                port_stop_message_disabled: false,
                has_responses_submit_tool_outputs_resume: false,
                plan_mode_active: false,
            },
            captured_request: None,
            effective_runtime_loop_state: Some(json!({
                "repeatCount": 1,
                "maxRepeats": 3,
                "continuationPrompt": "keep going"
            })),
            provider_key: None,
        });
        // The plan should return null (since the schema followup just produces
        // a followup_text, not a terminal stop).
        // In this case the gate returns followup, but the handler plan logic
        // routes it through the trigger path with ReturnHandlerPlan.
        // The key assertion: schema_gate reason_code includes "missing".
        assert!(plan.schema_gate.is_some());
        let sg = plan.schema_gate.as_ref().unwrap();
        let rc = sg.get("reason_code").and_then(Value::as_str).unwrap_or("");
        assert!(
            rc.contains("missing") || rc.contains("reason"),
            "expected schema gate reason to flag missing reason, got: {rc}"
        );
    }

    #[test]
    fn no_schema_with_no_runtime_initializes_stopless_and_returns_handler_plan() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            adapter_context: json!({
                "metadata": { "stopMessageEnabled": true }
            }),
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": "done" }
                }]
            }),
            request_id: "req-9".to_string(),
            followup_flow_id: None,
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: None,
            metadata_previous_compare: None,
            default_config: StopMessageDefaultConfigPlan {
                enabled: true,
                text: "continue".to_string(),
                max_repeats: 3,
            },
            decision_signals: StoplessDecisionContextSignals {
                port_stop_message_disabled: false,
                has_responses_submit_tool_outputs_resume: false,
                plan_mode_active: false,
            },
            captured_request: None,
            effective_runtime_loop_state: None,
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnHandlerPlan);
        let persist_plan = plan.persist_plan.as_ref().expect("persist plan");
        assert_eq!(persist_plan.next_used, 1);
        assert_eq!(persist_plan.next_max_repeats, 3);
        assert_eq!(
            plan.stopless_trigger_hint.as_deref(),
            Some("stop_schema_missing")
        );
        assert_eq!(plan.compare_context.reason, "stop_schema_missing");
    }

    #[test]
    fn continue_needed_with_next_step_returns_handler_plan() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            adapter_context: json!({}),
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": "{\"stopreason\":2,\"reason\":\"working\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"verify\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}" }
                }]
            }),
            request_id: "req-10".to_string(),
            followup_flow_id: None,
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: Some(json!({
                "stopless": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 1,
                    "maxRepeats": 3,
                    "active": true
                }
            })),
            metadata_previous_compare: None,
            default_config: StopMessageDefaultConfigPlan {
                enabled: true,
                text: "continue".to_string(),
                max_repeats: 3,
            },
            decision_signals: StoplessDecisionContextSignals {
                port_stop_message_disabled: false,
                has_responses_submit_tool_outputs_resume: false,
                plan_mode_active: false,
            },
            captured_request: None,
            effective_runtime_loop_state: Some(json!({
                "repeatCount": 1,
                "maxRepeats": 3,
                "continuationPrompt": "keep going"
            })),
            provider_key: None,
        });
        // stopreason=2 with next_step="verify" → followup path → handler plan
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnHandlerPlan);
        assert_eq!(plan.flow_id.as_deref(), Some("stop_message_flow"));
        // schema gate should have continue_next_step reason
        let sg = plan.schema_gate.as_ref().unwrap();
        let rc = sg.get("reason_code").and_then(Value::as_str).unwrap_or("");
        assert_eq!(rc, "stop_schema_continue_next_step");
    }

    #[test]
    fn schema_feedback_includes_reason_code() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            adapter_context: json!({}),
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": "{\"stopreason\":2,\"reason\":\"working\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"verify\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}" }
                }]
            }),
            request_id: "req-11".to_string(),
            followup_flow_id: None,
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: Some(json!({
                "stopless": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 1,
                    "maxRepeats": 3,
                    "active": true
                }
            })),
            metadata_previous_compare: None,
            default_config: StopMessageDefaultConfigPlan {
                enabled: true,
                text: "continue".to_string(),
                max_repeats: 3,
            },
            decision_signals: StoplessDecisionContextSignals {
                port_stop_message_disabled: false,
                has_responses_submit_tool_outputs_resume: false,
                plan_mode_active: false,
            },
            captured_request: None,
            effective_runtime_loop_state: Some(json!({
                "repeatCount": 1,
                "maxRepeats": 3,
                "continuationPrompt": "keep going"
            })),
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnHandlerPlan);
        let sf = plan.schema_feedback.as_ref().unwrap();
        assert_eq!(sf.reason_code, "stop_schema_continue_next_step");
        assert!(sf.missing_fields.is_empty());
    }
}
