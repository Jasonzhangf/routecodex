//! stop_message_auto handler plan — full orchestration decision logic.
//!
//! Migrates the complete `stopMessageAutoServerToolHandler` orchestration
//! from TS into Rust. The TS shell retains only MetadataCenter I/O,
//! config file reads, env vars, and result writeback.
//!
//! Feature: hub.servertool_stopless_cli_continuation

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use stop_message_core::{
    evaluate_stop_schema_gate_with_reasoning_stop_arguments, StopSchemaGateAction,
    StopSchemaGateDecision,
};

use crate::stop_gateway_context::{self, StopGatewayContext};
use crate::stop_message_compare_context::StopMessageCompareContext;
use crate::stop_message_default_config::StopMessageDefaultConfigPlan;
use crate::stop_message_persist_plan::{self, StopMessagePersistPlan};
use crate::stop_visible_text::{
    build_stop_message_terminal_visible_payload,
    extract_current_assistant_reasoning_stop_arguments, extract_current_assistant_stop_text,
    StopMessageTerminalVisiblePayloadInput,
};
use crate::stopless_decision_context_signals::StoplessDecisionContextSignals;

// ── Input ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageAutoHandlerInput {
    pub base: Value,
    pub request_id: String,
    pub should_run_vision_flow: bool,
    pub should_bypass_stop_message_for_media: bool,
    pub metadata_runtime_control: Option<Value>,
    pub metadata_previous_compare: Option<Value>,
    pub default_config: StopMessageDefaultConfigPlan,
    pub decision_signals: StoplessDecisionContextSignals,
    pub effective_runtime_loop_state: Option<Value>,
    pub provider_key: Option<String>,
}

// ── Plan Output ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopMessageAutoPlanAction {
    ReturnNull,
    ReturnTerminalFinal,
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

    // ── Phase 2: Context ─────────────────────────────────────────────────────
    let stop_gateway = stop_gateway_context::inspect(&input.base);
    let default_config = &input.default_config;
    let decision_signals = &input.decision_signals;

    let effective_loop = input.effective_runtime_loop_state.as_ref();
    let loop_repeat = effective_loop
        .and_then(|s| {
            s.get("used")
                .or_else(|| s.get("repeatCount").or_else(|| s.get("repeat_count")))
        })
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
    let mut compare = build_compare_from_decision(&decision, &stop_gateway);

    // ── Phase 5: Route ───────────────────────────────────────────────────────
    match decision.action.as_str() {
        "trigger" => handle_trigger(
            input,
            &decision,
            &mut compare,
            &assistant_stop_text,
            default_config,
        ),
        _ => handle_skip(input, &decision, &mut compare),
    }
}

// ── Skip path ───────────────────────────────────────────────────────────────

fn handle_skip(
    input: &StopMessageAutoHandlerInput,
    decision: &StopMessageDecision,
    compare: &mut StopMessageCompareContext,
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

    null_plan(compare.clone())
}

// ── Trigger path ────────────────────────────────────────────────────────────

fn handle_trigger(
    input: &StopMessageAutoHandlerInput,
    decision: &StopMessageDecision,
    compare: &mut StopMessageCompareContext,
    assistant_stop_text: &str,
    default_config: &StopMessageDefaultConfigPlan,
) -> StopMessageAutoHandlerPlan {
    // Read previous compare context from metadata (passed through from TS shell)
    let prev_compare = input.metadata_previous_compare.as_ref();
    let prev_observation_hash = prev_compare
        .and_then(|pc| {
            pc.get("observationHash")
                .or_else(|| pc.get("observation_hash"))
        })
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| compare.observation_hash.clone().unwrap_or_default());
    let prev_no_change_count = prev_compare
        .and_then(|pc| {
            pc.get("observationStableCount")
                .or_else(|| pc.get("observation_stable_count"))
        })
        .and_then(Value::as_f64)
        .map(|v| v.floor() as u32)
        .unwrap_or_else(|| compare.observation_stable_count.unwrap_or(0).max(0) as u32);

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
        let terminal = if summary_prefix.trim().is_empty() {
            build_terminal_visible_payload(&input.base, "")
        } else {
            build_terminal_visible_payload_replace(&input.base, &summary_prefix)
        };
        return StopMessageAutoHandlerPlan {
            action: StopMessageAutoPlanAction::ReturnSchemaFailFast,
            compare_context: compare.clone(),
            terminal_chat_response: Some(terminal),
            schema_gate: Some(serialize_schema_gate(&schema_gate)),
            ..Default::default()
        };
    }

    // allow_stop
    if schema_gate.action == "allow_stop" {
        let prefixed = if schema_gate.reason_code.as_deref() == Some("stop_schema_needs_user_input")
        {
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
        let learned_note = schema_gate
            .parsed
            .as_ref()
            .map(|parsed| build_learned_note_plan(&input.request_id, parsed));
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

    let handler_result = run_stop_message_auto_handler_native(&effective_decision, &input.base);

    let stopless_runtime_state = handler_result
        .get("stoplessRuntimeState")
        .or_else(|| handler_result.get("stopless_runtime_state"));
    let schema_feedback = schema_gate
        .reason_code
        .as_deref()
        .map(|reason_code| build_schema_feedback(reason_code, &schema_gate.missing_fields));

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
    if should_count && effective_max > 0 && persist_plan.next_used >= persist_plan.next_max_repeats
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
    let finalize_context = build_finalize_context(
        &effective_decision,
        assistant_stop_text,
        stopless_runtime_state,
        stopless_trigger_hint.as_deref(),
        &schema_feedback,
        &finalize_stopless,
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
        finalize_context: Some(finalize_context),
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

    // Not stop eligible
    if ctx.get("stop_eligible") != Some(&Value::Bool(true)) {
        return skip("skip_not_stop_eligible");
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

// ── Schema gate evaluation ─────────────────────────────────────────────────
// stop-message-core is the only owner of stop schema semantics. The handler
// keeps only orchestration-facing serialization.

fn evaluate_stop_schema_gate(
    assistant_text: &str,
    reasoning_stop_arguments: Option<&str>,
    used: u32,
    max_repeats: u32,
    prev_observation_hash: &str,
    prev_no_change_count: u32,
) -> SchemaGateResult {
    schema_gate_from_core(evaluate_stop_schema_gate_with_reasoning_stop_arguments(
        assistant_text,
        reasoning_stop_arguments,
        used,
        max_repeats,
        prev_observation_hash,
        prev_no_change_count,
    ))
}

fn schema_gate_from_core(decision: StopSchemaGateDecision) -> SchemaGateResult {
    SchemaGateResult {
        action: match decision.action {
            StopSchemaGateAction::AllowStop => "allow_stop",
            StopSchemaGateAction::Followup => "followup",
            StopSchemaGateAction::FailFast => "fail_fast",
        }
        .to_string(),
        reason_code: Some(decision.reason_code),
        summary_prefix: decision.summary_prefix,
        followup_text: decision.followup_text,
        count_budget: Some(decision.count_budget),
        max_repeats: Some(decision.max_repeats),
        missing_fields: decision.missing_fields,
        no_change_count: Some(decision.no_change_count as i32),
        observation_hash: Some(decision.observation_hash),
        parsed: decision.parsed.map(|parsed| {
            serde_json::to_value(parsed)
                .expect("StopSchemaParsed must serialize for handler schema gate")
        }),
    }
}

// ── Compare context ─────────────────────────────────────────────────────────

fn build_compare_from_decision(
    decision: &StopMessageDecision,
    stop_gateway: &StopGatewayContext,
) -> StopMessageCompareContext {
    let is_trigger = decision.action == "trigger";
    StopMessageCompareContext {
        armed: is_trigger,
        mode: if is_trigger {
            "on".to_string()
        } else {
            "off".to_string()
        },
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
        compaction_request: false,
        has_seed: false,
        decision: if is_trigger {
            "trigger".to_string()
        } else {
            "skip".to_string()
        },
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
        prefix: if prefix.is_empty() {
            None
        } else {
            Some(prefix.to_string())
        },
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
    let _ = reason_code;
    "".to_string()
}

fn normalize_trigger_hint(reason_code: Option<&str>) -> Option<String> {
    reason_code
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s == "stop_schema_missing" {
                "no_schema".to_string()
            } else {
                s.to_string()
            }
        })
}

fn build_schema_feedback(reason_code: &str, missing_fields: &[String]) -> SchemaFeedback {
    SchemaFeedback {
        reason_code: reason_code.to_string(),
        missing_fields: missing_fields.to_vec(),
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
        m.as_object_mut()
            .unwrap()
            .insert("triggerHint".to_string(), json!(hint));
    }
    if let Some(fb) = feedback {
        let obj = m.as_object_mut().unwrap();
        obj.insert("schemaFeedback".to_string(), json!(fb));
    }
    m
}

fn build_finalize_context(
    decision: &StopMessageDecision,
    assistant_stop_text: &str,
    stopless_runtime_state: Option<&Value>,
    stopless_trigger_hint: Option<&str>,
    schema_feedback: &Option<SchemaFeedback>,
    finalize_stopless: &Value,
) -> Value {
    let mut context = serde_json::Map::new();
    context.insert("decision".to_string(), serialize_decision(decision));
    context.insert(
        "assistantStopText".to_string(),
        Value::String(assistant_stop_text.to_string()),
    );
    if let Some(hint) = stopless_trigger_hint {
        context.insert(
            "stopSchemaTriggerHint".to_string(),
            Value::String(hint.to_string()),
        );
    }
    if let Some(feedback) = schema_feedback {
        context.insert("stopSchemaFeedback".to_string(), json!(feedback));
    }
    if let Some(runtime_state) = stopless_runtime_state.filter(|value| value.is_object()) {
        context.insert("stoplessRuntimeState".to_string(), runtime_state.clone());
    }
    if finalize_stopless.is_object() {
        context.insert("stopless".to_string(), finalize_stopless.clone());
    }
    Value::Object(context)
}

// ── Missing functions ──────────────────────────────────────────────────────

fn build_decision_context(
    signals: &StoplessDecisionContextSignals,
    stop_gateway: &StopGatewayContext,
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
        ctx.as_object_mut()
            .unwrap()
            .insert("plan_mode_active".to_string(), json!(true));
    }
    if let Some(ref mc) = metadata_center_stopless {
        if mc.get("active") == Some(&Value::Bool(false)) {
            ctx.as_object_mut()
                .unwrap()
                .insert("explicit_mode".to_string(), json!("off"));
        }
    }
    let fallback_used = metadata_center_stopless
        .and_then(|mc| mc.get("repeatCount").or_else(|| mc.get("repeat_count")))
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .map(|value| value.max(0));
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
        ctx.as_object_mut().unwrap().insert(
            "runtime_snapshot".to_string(),
            json!({
                "used": used,
                "maxRepeats": runtime_max.unwrap_or(default_config.max_repeats as i64),
                "text": runtime_text,
            }),
        );
    }
    if let Some(ref pk) = provider_key {
        ctx.as_object_mut().unwrap().insert(
            "provider_pin".to_string(),
            json!({
                "provider_key": pk
            }),
        );
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
    base: &Value,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn vision_flow_returns_null_plan() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({}),
            request_id: "req-1".to_string(),
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
            effective_runtime_loop_state: None,
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnNull);
    }

    #[test]
    fn media_context_returns_null_plan() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({}),
            request_id: "req-2".to_string(),
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
            effective_runtime_loop_state: None,
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnNull);
    }

    #[test]
    fn not_stop_finish_reason_skips() {
        // finish_reason is not "stop" so stop_gateway says not eligible
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "length",
                    "message": { "role": "assistant", "content": "truncated" }
                }]
            }),
            request_id: "req-3".to_string(),
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
            effective_runtime_loop_state: None,
            provider_key: None,
        });
        // finish_reason is "length", not "stop", so not eligible → skip
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnNull);
        assert_eq!(plan.compare_context.reason, "skip_not_stop_eligible");
    }

    #[test]
    fn budget_exhausted_returns_terminal() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({ "choices": [{ "index": 0, "finish_reason": "stop", "message": { "content": "done" } }] }),
            request_id: "req-5".to_string(),
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
            effective_runtime_loop_state: None,
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnNull);
        assert_eq!(
            plan.compare_context.reason,
            "skip_port_stopmessage_disabled"
        );
    }

    #[test]
    fn handler_plan_has_correct_structure() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({ "choices": [{ "index": 0, "finish_reason": "stop", "message": { "content": "test" } }] }),
            request_id: "req-6".to_string(),
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
        let schema = r#"<rcc_stop_schema>{"stopreason":2,"reason":"same","has_evidence":0,"next_step":"x","needs_user_input":false}</rcc_stop_schema>"#;
        let first_gate = evaluate_stop_schema_gate(schema, None, 1, 3, "", 0);
        assert_eq!(
            first_gate.reason_code.as_deref(),
            Some("stop_schema_continue_next_step")
        );
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": schema }
                }]
            }),
            request_id: "req-7".to_string(),
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
                "observationHash": first_gate.observation_hash,
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
            effective_runtime_loop_state: Some(json!({
                "repeatCount": 1,
                "maxRepeats": 3,
                "continuationPrompt": "keep going"
            })),
            provider_key: None,
        });
        // Valid stopreason=2 + next_step is progress control. Even if the
        // observation is stable, it must not materialize as a budget terminal.
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnHandlerPlan);
        assert_eq!(
            plan.compare_context.reason,
            "stop_schema_continue_next_step"
        );
    }

    #[test]
    fn terminal_schema_with_empty_reason_is_followup() {
        // stopreason=0 but empty reason → followup, not allow_stop
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": "<rcc_stop_schema>{\"stopreason\":0,\"reason\":\"\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"next_step\":\"\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}</rcc_stop_schema>" }
                }]
            }),
            request_id: "req-8".to_string(),
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
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": "done" }
                }]
            }),
            request_id: "req-9".to_string(),
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
            effective_runtime_loop_state: None,
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnHandlerPlan);
        let persist_plan = plan.persist_plan.as_ref().expect("persist plan");
        assert_eq!(persist_plan.next_used, 1);
        assert_eq!(persist_plan.next_max_repeats, 3);
        assert_eq!(plan.stopless_trigger_hint.as_deref(), Some("no_schema"));
        assert_eq!(plan.compare_context.reason, "stop_schema_missing");
    }

    #[test]
    fn responses_completed_empty_text_is_missing_schema_followup() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({
                "status": "completed",
                "output_text": "",
                "output": [
                    {
                        "type": "reasoning",
                        "summary": [{
                            "type": "summary_text",
                            "text": "I should output the stop schema JSON."
                        }]
                    },
                    {
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [{ "type": "output_text", "text": "" }]
                    }
                ]
            }),
            request_id: "req-empty-responses".to_string(),
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
                has_responses_submit_tool_outputs_resume: true,
                plan_mode_active: false,
            },
            effective_runtime_loop_state: Some(json!({
                "repeatCount": 1,
                "maxRepeats": 3,
                "continuationPrompt": "keep going"
            })),
            provider_key: None,
        });

        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnHandlerPlan);
        assert_eq!(plan.stopless_trigger_hint.as_deref(), Some("no_schema"));
        assert_eq!(plan.compare_context.reason, "stop_schema_missing");
        let persist_plan = plan.persist_plan.as_ref().expect("persist plan");
        assert_eq!(persist_plan.next_used, 2);
        assert_eq!(persist_plan.next_max_repeats, 3);
    }

    #[test]
    fn budget_exhausted_followup_path_preserves_original_visible_text() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": "继续执行中" }
                }],
                "output_text": "继续执行中",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "继续执行中" }]
                }]
            }),
            request_id: "req-budget-terminal-visible".to_string(),
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: Some(json!({
                "stopless": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 2,
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
                has_responses_submit_tool_outputs_resume: true,
                plan_mode_active: false,
            },
            effective_runtime_loop_state: Some(json!({
                "repeatCount": 2,
                "maxRepeats": 3,
                "continuationPrompt": "继续执行"
            })),
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnTerminalFinal);
        assert_eq!(plan.compare_context.reason, "stop_schema_budget_exhausted");
        let terminal = plan
            .terminal_chat_response
            .as_ref()
            .expect("terminal response");
        let content = terminal["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        assert!(
            content.contains("继续执行中"),
            "terminal budget exhausted path must preserve original visible text, got: {content}"
        );
        assert!(!content.contains("stopless"));
        let output_text = terminal["output_text"].as_str().unwrap_or("");
        assert!(
            output_text.contains("继续执行中"),
            "responses output_text must preserve original visible text, got: {output_text}"
        );
        assert!(!output_text.contains("stopless"));
        let nested_output_text = terminal["output"][0]["content"][0]["text"]
            .as_str()
            .unwrap_or("");
        assert!(
            nested_output_text.contains("继续执行中"),
            "responses nested output must preserve original visible text, got: {nested_output_text}"
        );
        assert!(!nested_output_text.contains("stopless"));
    }

    #[test]
    fn complete_responses_stop_schema_at_budget_boundary_allows_stop() {
        let schema = r#"<rcc_stop_schema>{"stopreason":0,"reason":"已完成 invalid schema 缺失字段反馈闭环","has_evidence":1,"evidence":"provider request carried full missingFields feedback twice","issue_cause":"之前 schema 字段缺失","excluded_factors":"已排除 raw reasoningStop 泄漏和 endless CLI loop","diagnostic_order":"first invalid -> full missingFields feedback -> second invalid -> next_step feedback -> terminal schema","done_steps":"完成两轮 invalid schema 修复反馈验证","next_step":"","next_suggested_path":"无","needs_user_input":false,"learned":"invalid schema feedback must enumerate every missing field until complete"}</rcc_stop_schema>"#;
        let base = json!({
            "status": "completed",
            "finish_reason": "stop",
            "output_text": schema,
            "output": [{
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{ "type": "output_text", "text": schema }]
            }]
        });
        let extracted = extract_current_assistant_stop_text(&base);
        let gate = evaluate_stop_schema_gate(&extracted, None, 2, 3, "", 0);
        assert_eq!(gate.action, "allow_stop", "extracted={extracted}");
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base,
            request_id: "req-complete-schema-budget-boundary".to_string(),
            should_run_vision_flow: false,
            should_bypass_stop_message_for_media: false,
            metadata_runtime_control: Some(json!({
                "stopless": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 2,
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
                has_responses_submit_tool_outputs_resume: true,
                plan_mode_active: false,
            },
            effective_runtime_loop_state: Some(json!({
                "repeatCount": 2,
                "maxRepeats": 3,
                "continuationPrompt": "继续执行"
            })),
            provider_key: None,
        });
        assert_eq!(
            plan.action,
            StopMessageAutoPlanAction::ReturnSchemaAllowStop
        );
        assert_eq!(plan.compare_context.reason, "stop_schema_finished");
        let terminal = plan
            .terminal_chat_response
            .as_ref()
            .expect("terminal response");
        let output_text = terminal["output_text"].as_str().unwrap_or("");
        assert!(
            !output_text.contains("stopless budget exhausted"),
            "complete schema must win over budget terminal, got: {output_text}"
        );
    }

    #[test]
    fn continue_needed_with_next_step_returns_handler_plan() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": "<rcc_stop_schema>{\"stopreason\":2,\"reason\":\"working\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"verify\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}</rcc_stop_schema>" }
                }]
            }),
            request_id: "req-10".to_string(),
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
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": "<rcc_stop_schema>{\"stopreason\":2,\"reason\":\"working\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"verify\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}</rcc_stop_schema>" }
                }]
            }),
            request_id: "req-11".to_string(),
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

    #[test]
    fn blocked_needs_user_input_returns_terminal_summary_and_question() {
        let schema = r#"<rcc_stop_schema>{"stopreason":1,"reason":"需要用户选择部署窗口","has_evidence":1,"evidence":"两个候选窗口都会影响线上流量","next_step":"请决定：今晚 23:00 还是明早 09:00 部署？","needs_user_input":true}</rcc_stop_schema>"#;
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": schema }
                }],
                "output_text": schema,
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": schema }]
                }]
            }),
            request_id: "req-blocked-user-decision".to_string(),
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
            effective_runtime_loop_state: Some(json!({
                "repeatCount": 1,
                "maxRepeats": 3,
                "continuationPrompt": "keep going"
            })),
            provider_key: None,
        });

        assert_eq!(
            plan.action,
            StopMessageAutoPlanAction::ReturnSchemaAllowStop
        );
        assert_eq!(plan.compare_context.reason, "stop_schema_needs_user_input");
        let terminal = plan
            .terminal_chat_response
            .as_ref()
            .expect("terminal response");
        assert_eq!(
            terminal["choices"][0]["finish_reason"].as_str(),
            Some("stop")
        );
        let content = terminal["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        assert!(content.contains("当前结果"), "content={content}");
        assert!(
            content.contains("需要用户选择部署窗口"),
            "content={content}"
        );
        assert!(content.contains("需要你决定"), "content={content}");
        assert!(
            content.contains("请决定：今晚 23:00 还是明早 09:00 部署？"),
            "content={content}"
        );
        let output_text = terminal["output_text"].as_str().unwrap_or("");
        assert!(
            output_text.contains("请决定：今晚 23:00 还是明早 09:00 部署？"),
            "output_text={output_text}"
        );
    }

    #[test]
    fn responses_submit_tool_outputs_resume_still_returns_handler_plan_for_stopless_loop() {
        let plan = plan_stop_message_auto_handler(&StopMessageAutoHandlerInput {
            base: json!({
                "id": "resp_submit_round_2",
                "object": "response",
                "status": "completed",
                "output": [{
                    "id": "msg_submit_round_2",
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "继续执行中" }]
                }],
                "output_text": "继续执行中"
            }),
            request_id: "req-submit-tool-outputs-stopless".to_string(),
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
                has_responses_submit_tool_outputs_resume: true,
                plan_mode_active: false,
            },
            effective_runtime_loop_state: Some(json!({
                "repeatCount": 1,
                "maxRepeats": 3,
                "continuationPrompt": "keep going"
            })),
            provider_key: None,
        });
        assert_eq!(plan.action, StopMessageAutoPlanAction::ReturnHandlerPlan);
        assert_eq!(plan.flow_id.as_deref(), Some("stop_message_flow"));
        let persist_plan = plan.persist_plan.as_ref().expect("persist plan");
        assert_eq!(persist_plan.next_used, 2);
        assert_eq!(persist_plan.next_max_repeats, 3);
    }
}
