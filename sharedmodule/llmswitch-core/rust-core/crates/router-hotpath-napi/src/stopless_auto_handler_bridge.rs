//! stopless_auto_handler_bridge — Rust-native entry point for the stopless handler.
//!
//! Replaces the TS `stop-message-auto.ts` shell + native bridge round-trips.
//! All orchestration logic lives in servertool_core::stop_message_auto_handler.
//! This module:
//!   - Exposes `plan_stopless_auto_handler_json` (NAPI) — full plan generation
//!   - Exposes `build_stopless_auto_cli_projection_json` (NAPI) — complete CLI
//!     projection for auto flow (previously in TS `buildServertoolCliProjectionForAutoFlow`)
//!   - Exposes `write_stopless_learned_note_json` (NAPI) — file write for learned notes
//!
//! Feature: hub.servertool_stopless_cli_continuation
//! Canonical builder: build_servertool_cli_projection_01_from_hub_resp_chatprocess_03

use crate::metadata_center::write_plan::{LearnedNoteWrite, StoplessMetadataCenterWritePlan};
use crate::metadata_center::{
    build_metadata_center_from_snapshot, build_stopless_metadata_center_write_plan,
};
use crate::shared_json_utils::read_trimmed_string;
use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use servertool_core::cli_contract;
use servertool_core::persisted_lookup;
use servertool_core::stop_message_auto_handler::{self, StopMessageAutoHandlerInput};
use servertool_core::stop_message_default_config::{self, StopMessageDefaultConfigInput};
use servertool_core::stopless_cli_projection_context_contract;
use servertool_core::stopless_decision_context_signals::{
    self, StoplessDecisionContextSignalsInput,
};
use servertool_core::stopless_learned_note_contract;
use servertool_core::stopless_orchestration_contract::{self, StoplessOrchestrationPlanInput};

fn build_stopless_exec_command(
    repeat_count: u32,
    max_repeats: u32,
    public_trigger_hint: Option<&str>,
    session_id: Option<&str>,
    request_id: Option<&str>,
) -> String {
    let trigger = cli_contract::normalize_stopless_trigger_hint_for_metadata(public_trigger_hint);
    let input_json = serde_json::json!({
        "flowId": "stop_message_flow",
        "repeatCount": repeat_count,
        "maxRepeats": max_repeats,
        "triggerHint": trigger,
    });
    let input_str = input_json.to_string();
    let quoted = input_str.replace('\'', "'\\''");
    let mut cmd = format!(
        "routecodex hook run reasoningStop --input-json '{}'",
        quoted
    );
    if let Some(sid) = session_id {
        cmd.push_str(&format!(" --session-id '{}'", sid.replace('\'', "'\\''")));
    }
    if let Some(rid) = request_id {
        cmd.push_str(&format!(" --request-id '{}'", rid.replace('\'', "'\\''")));
    }
    cmd.push_str(&format!(" --repeat-count '{}'", repeat_count));
    cmd.push_str(&format!(" --max-repeats '{}'", max_repeats));
    cmd
}

// ── NAPI: plan stopless auto handler (plan only) ─────────────────────────────

/// Generate the full handler plan for stop_message_auto.
/// Input: StopMessageAutoHandlerInput JSON.
/// Output: StopMessageAutoHandlerPlan JSON.
#[napi]
pub fn plan_stopless_auto_handler_json(input_json: String) -> NapiResult<String> {
    let input: StopMessageAutoHandlerInput = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!("deserialize StopMessageAutoHandlerInput: {e}"))
    })?;
    let plan = stop_message_auto_handler::plan_stop_message_auto_handler(&input);
    serde_json::to_string(&plan)
        .map_err(|e| napi::Error::from_reason(format!("serialize StopMessageAutoHandlerPlan: {e}")))
}

#[napi]
pub fn build_stopless_auto_handler_input_json(input_json: String) -> NapiResult<String> {
    let input: StoplessAutoHandlerRuntimeInput =
        serde_json::from_str(&input_json).map_err(|e| {
            napi::Error::from_reason(format!("deserialize StoplessAutoHandlerRuntimeInput: {e}"))
        })?;

    let output = build_stopless_auto_handler_input_value(&input);

    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("serialize StopMessageAutoHandlerInput: {e}"))
    })
}

fn build_stopless_auto_handler_input_value(input: &StoplessAutoHandlerRuntimeInput) -> Value {
    let metadata_runtime_control = input
        .runtime_metadata
        .as_ref()
        .and_then(|value| value.get("metadataCenterSnapshot"))
        .and_then(|value| value.get("runtimeControl"))
        .cloned();

    let metadata_previous_compare = metadata_runtime_control
        .as_ref()
        .and_then(|value| value.get("stopMessageCompareContext"))
        .cloned();

    let decision_signals =
        stopless_decision_context_signals::plan_stopless_decision_context_signals(
            &StoplessDecisionContextSignalsInput {
                runtime_metadata: input.runtime_metadata.clone(),
            },
        );
    let default_config = stop_message_default_config::plan_stop_message_default_config(
        &StopMessageDefaultConfigInput {
            tombstone_cleared: Some(false),
            config_enabled: None,
            config_text: None,
            config_max_repeats: None,
            env_text: None,
            env_max_repeats: None,
        },
    );
    let effective_runtime_loop_state =
        persisted_lookup::resolve_runtime_stop_message_state_from_metadata_center(
            &persisted_lookup::RuntimeStopMessageStateFromMetadataCenterInput {
                runtime_metadata: input.runtime_metadata.clone(),
            },
        )
        .and_then(|snapshot| serde_json::to_value(snapshot).ok());

    serde_json::json!({
        "base": input.base,
        "requestId": input.request_id,
        "shouldRunVisionFlow": false,
        "shouldBypassStopMessageForMedia": false,
        "metadataRuntimeControl": metadata_runtime_control,
        "metadataPreviousCompare": metadata_previous_compare,
        "defaultConfig": default_config,
        "decisionSignals": decision_signals,
        "effectiveRuntimeLoopState": effective_runtime_loop_state,
        "providerKey": Value::Null,
    })
}

#[napi]
pub fn plan_stopless_execution_json(input_json: String) -> NapiResult<String> {
    let input: StoplessExecutionPlanInput = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!("deserialize StoplessExecutionPlanInput: {e}"))
    })?;
    let execution = build_stopless_execution_value(&input);
    let orchestration_plan = stopless_orchestration_contract::plan_stopless_orchestration_action(
        StoplessOrchestrationPlanInput {
            flow_id: input.flow_id.clone(),
            execution: execution.clone(),
        },
    );
    serde_json::to_string(&serde_json::json!({
        "execution": execution,
        "orchestrationPlan": orchestration_plan
    }))
    .map_err(|e| napi::Error::from_reason(format!("serialize stopless execution plan: {e}")))
}

fn build_stopless_execution_value(input: &StoplessExecutionPlanInput) -> Value {
    let mut execution = input
        .execution
        .as_object()
        .cloned()
        .unwrap_or_else(Map::new);
    if let Some(flow_id) = input
        .flow_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        execution.insert("flowId".to_string(), Value::String(flow_id.to_string()));
    }

    let mut context = execution
        .get("context")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);
    if let Some(session_id) = input
        .request_truth_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if read_trimmed_string(context.get("sessionId")).is_none() {
            context.insert(
                "sessionId".to_string(),
                Value::String(session_id.to_string()),
            );
        }
        let mut request_truth = context
            .get("requestTruth")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_else(Map::new);
        request_truth.insert(
            "sessionId".to_string(),
            Value::String(session_id.to_string()),
        );
        context.insert("requestTruth".to_string(), Value::Object(request_truth));
    }

    let existing_stopless = context
        .get("stopless")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);
    let mut stopless = existing_stopless;
    let runtime_stopless_control = input
        .runtime_control
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|runtime| runtime.get("stopless"))
        .and_then(Value::as_object);
    if let Some(control) = runtime_stopless_control {
        for (key, value) in control {
            stopless.insert(key.clone(), value.clone());
        }
    }
    if let Some(flow_id) = input
        .flow_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        stopless
            .entry("flowId".to_string())
            .or_insert_with(|| Value::String(flow_id.to_string()));
    }
    if !stopless.is_empty() {
        context.insert("stopless".to_string(), Value::Object(stopless));
    }

    execution.insert("context".to_string(), Value::Object(context));
    Value::Object(execution)
}

#[napi]
pub fn run_stopless_auto_handler_runtime_json(input_json: String) -> NapiResult<String> {
    let input: StoplessAutoHandlerRuntimeInput =
        serde_json::from_str(&input_json).map_err(|e| {
            napi::Error::from_reason(format!("deserialize StoplessAutoHandlerRuntimeInput: {e}"))
        })?;

    let handler_input: StopMessageAutoHandlerInput =
        serde_json::from_value(build_stopless_auto_handler_input_value(&input)).map_err(|e| {
            napi::Error::from_reason(format!(
                "deserialize StopMessageAutoHandlerInput from handler input value: {e}"
            ))
        })?;
    let plan = stop_message_auto_handler::plan_stop_message_auto_handler(&handler_input);

    let center_snapshot = input
        .runtime_metadata
        .as_ref()
        .and_then(|value| value.get("metadataCenterSnapshot"))
        .cloned()
        .unwrap_or(Value::Null);
    let center = build_metadata_center_from_snapshot(&center_snapshot);
    let timestamp_ms = current_timestamp_ms();
    let metadata_write_plan =
        build_stopless_metadata_center_write_plan(&plan, &center, &input.request_id, timestamp_ms);
    let learned_note_write = match metadata_write_plan.learned_note.as_ref() {
        Some(learned_note) => Some(write_stopless_learned_note_from_plan(learned_note)?),
        None => None,
    };

    let runtime_output = build_runtime_output(
        &input.base,
        &input.request_id,
        plan,
        metadata_write_plan,
        learned_note_write,
    )?;

    serde_json::to_string(&runtime_output)
        .map_err(|e| napi::Error::from_reason(format!("serialize stopless runtime output: {e}")))
}

#[napi]
pub fn run_stopless_builtin_handler_for_runtime_json(input_json: String) -> NapiResult<String> {
    let input_value: Value = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!("deserialize StoplessBuiltinHandlerRuntimeInput: {e}"))
    })?;
    let name = read_trimmed_string(input_value.get("name")).ok_or_else(|| {
        napi::Error::from_reason("[servertool] missing builtin handler name")
    })?;
    if name != "stop_message_auto" {
        return Err(napi::Error::from_reason(format!(
            "[servertool] unsupported builtin handler runtime: {name}"
        )));
    }
    let runtime_raw = run_stopless_auto_handler_runtime_json(input_json)?;
    let runtime_output: StoplessAutoHandlerRuntimeOutput =
        serde_json::from_str(&runtime_raw).map_err(|e| {
            napi::Error::from_reason(format!("deserialize stopless runtime output: {e}"))
        })?;
    let materialized = materialize_stopless_builtin_handler_result(runtime_output)?;
    serde_json::to_string(&materialized).map_err(|e| {
        napi::Error::from_reason(format!("serialize stopless builtin handler result: {e}"))
    })
}

// ── NAPI: build complete stopless auto CLI projection ──────────────────────────

/// Build a complete stopless CLI projection for an auto flow request.
///
/// This replaces the TS-side `buildServertoolCliProjectionForAutoFlow()` which
/// called three Native functions in sequence. The Rust side does all three steps
/// inline: plan CLI projection context → build exec output → build shell.
///
/// Input JSON shape:
/// ```json
/// {
///   "metadataWritePlan": { "stopless": { ... } },
///   "runtimeControl": { ... },
///   "chatStopText": "...",
///   "sessionId": "...",
///   "requestId": "..."
/// }
/// ```
///
/// Output JSON shape:
/// ```json
/// {
///   "clientCallId": "call_stopless_...",
///   "toolName": "stop_message_auto",
///   "command": "...",
///   "chatResponse": { ... },
///   "projectionContext": { ... },
///   "executionContext": { ... }
/// }
/// ```
#[napi]
pub fn build_stopless_auto_cli_projection_json(input_json: String) -> NapiResult<String> {
    let input: StoplessAutoCliProjectionInput = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!("deserialize StoplessAutoCliProjectionInput: {e}"))
    })?;

    // Step 1: plan CLI projection context (resolution priority chain)
    let metadata_write_plan = input.metadata_write_plan.and_then(|v| {
        serde_json::from_value::<
            stopless_cli_projection_context_contract::StoplessCliProjectionMetadataWritePlanInput,
        >(v)
        .ok()
    });
    let ctx_input = stopless_cli_projection_context_contract::StoplessCliProjectionContextInput {
        metadata_write_plan,
        stopless_control: input.stopless_control,
        chat_stop_text: input.chat_stop_text.clone(),
        adapter_stop_text: input.chat_stop_text,
        session_id: input.session_id,
        request_id: input.request_id.clone(),
    };
    let ctx =
        stopless_cli_projection_context_contract::plan_stopless_cli_projection_context(ctx_input);

    // Step 2: generate a client call id
    let client_call_id = format!(
        "call_reasoning_stop_{}",
        uuid::Uuid::new_v4().to_string().replace("-", "")
    );

    // Step 3: build exec CLI projection output.
    // The plan_client_exec_cli_projection_output helper does not take sessionId /
    // requestId. We re-stamp the command here so the canonical command includes
    // both (the TS-layer stop_message shell expects them in the projection's
    // execCommand, not just in the output JSON).
    let exec_output_value: Value = {
        let raw = cli_contract::build_client_exec_cli_projection_output(
            "stop_message_auto",
            "stop_message_flow",
            serde_json::json!({
                "flowId": "stop_message_flow",
                "repeatCount": ctx.repeat_count,
                "maxRepeats": ctx.max_repeats,
                "triggerHint": ctx.public_trigger_hint,
                "schemaFeedback": ctx.schema_feedback,
            }),
            ctx.repeat_count,
            ctx.max_repeats,
        )
        .map_err(|e| napi::Error::from_reason(format!("exec projection: {e}")))?;
        let mut stamped = raw;
        if let (Some(sid), Some(obj)) = (ctx.session_id.as_ref(), stamped.as_object_mut()) {
            obj.insert("sessionId".to_string(), Value::String(sid.clone()));
        }
        if let (Some(rid), Some(obj)) = (ctx.request_id.as_ref(), stamped.as_object_mut()) {
            obj.insert("requestId".to_string(), Value::String(rid.clone()));
        }
        let cmd = build_stopless_exec_command(
            ctx.repeat_count,
            ctx.max_repeats,
            ctx.public_trigger_hint.as_deref(),
            ctx.session_id.as_deref(),
            ctx.request_id.as_deref(),
        );
        if let Some(obj) = stamped.as_object_mut() {
            obj.insert("execCommand".to_string(), Value::String(cmd));
        }
        stamped
    };

    // Step 4: build client-visible projection shell
    let shell_input = cli_contract::ServertoolClientVisibleProjectionShellInput {
        request_id: input.request_id.clone().unwrap_or_default(),
        client_call_id: client_call_id.clone(),
        native_projection: exec_output_value.clone(),
        reasoning_text: ctx.reasoning_text.clone(),
        additional_tool_calls: Vec::new(),
    };
    let shell = cli_contract::build_client_visible_projection_shell(shell_input)
        .map_err(|e| napi::Error::from_reason(format!("shell projection: {e}")))?;

    // Step 5: build execution context for the projection
    let exec_ctx_input = cli_contract::ServertoolCliProjectionExecutionContextInput {
        request_id: ctx.request_id.clone().unwrap_or_default(),
        client_call_id,
        tool_name: "stop_message_auto".to_string(),
    };
    let exec_ctx = cli_contract::build_servertool_cli_projection_execution_context(exec_ctx_input)
        .map_err(|e| napi::Error::from_reason(format!("exec context: {e}")))?;

    let output = StoplessAutoCliProjectionOutput {
        client_call_id: shell
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        tool_name: "stop_message_auto".to_string(),
        command: exec_output_value
            .get("execCommand")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        chat_response: shell,
        projection_context: StoplessProjectionContextOutput {
            reasoning_text: ctx.reasoning_text,
            repeat_count: ctx.repeat_count,
            max_repeats: ctx.max_repeats,
            public_trigger_hint: ctx.public_trigger_hint,
            schema_feedback: ctx.schema_feedback,
        },
        execution_context: exec_ctx,
    };

    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(format!("serialize: {e}")))
}

#[napi]
pub fn build_stopless_auto_cli_projection_from_engine_json(
    input_json: String,
) -> NapiResult<String> {
    let input: StoplessAutoCliProjectionFromEngineInput = serde_json::from_str(&input_json)
        .map_err(|e| {
            napi::Error::from_reason(format!(
                "deserialize StoplessAutoCliProjectionFromEngineInput: {e}"
            ))
        })?;
    let context_record = input
        .execution
        .get("context")
        .filter(|value| value.is_object() && !value.is_array())
        .and_then(Value::as_object);
    let metadata_center_snapshot = input
        .metadata_center_snapshot
        .as_ref()
        .and_then(Value::as_object);
    let stopless_control = metadata_center_snapshot
        .and_then(|snapshot| snapshot.get("runtimeControl"))
        .and_then(|runtime| runtime.get("stopless"))
        .filter(|value| value.is_object() && !value.is_array())
        .cloned();
    let chat_stop_text =
        context_record.and_then(|context| read_trimmed_string(context.get("assistantStopText")));
    let session_id = metadata_center_snapshot
        .and_then(|snapshot| snapshot.get("requestTruth"))
        .and_then(Value::as_object)
        .and_then(|truth| read_trimmed_string(truth.get("sessionId")));
    let projection_input = StoplessAutoCliProjectionInput {
        metadata_write_plan: input.metadata_write_plan,
        stopless_control,
        chat_stop_text,
        session_id,
        request_id: input.request_id,
    };
    serde_json::to_string(&projection_input)
        .map_err(|e| napi::Error::from_reason(format!("serialize projection input: {e}")))
        .and_then(build_stopless_auto_cli_projection_json)
}

// ── NAPI: write stopless learned note ─────────────────────────────────────────

/// Write a stopless learned note entry to `note.md` in the working directory.
/// This replaces the TS `writeStoplessLearnedNoteEntry` from `cache-writer.ts`.
#[napi]
pub fn write_stopless_learned_note_json(input_json: String) -> NapiResult<String> {
    let input: stopless_learned_note_contract::StoplessLearnedNotePlanInput =
        serde_json::from_str(&input_json).map_err(|e| {
            napi::Error::from_reason(format!("deserialize learned note input: {e}"))
        })?;
    let plan = stopless_learned_note_contract::plan_stopless_learned_note_write(input);

    write_stopless_learned_note_from_contract_plan(&plan)
}

fn write_stopless_learned_note_from_plan(
    plan: &LearnedNoteWrite,
) -> NapiResult<StoplessLearnedNoteWriteOutput> {
    let contract_plan = stopless_learned_note_contract::StoplessLearnedNoteWritePlan {
        should_write: true,
        working_directory: plan.working_directory.clone(),
        request_id: plan.request_id.clone(),
        session_id: plan.session_id.clone(),
        timestamp_ms: plan.timestamp_ms,
        learned: plan.learned.clone(),
        reason: plan.reason.clone(),
        evidence: plan.evidence.clone(),
    };
    let raw = write_stopless_learned_note_from_contract_plan(&contract_plan)?;
    serde_json::from_str(&raw).map_err(|e| {
        napi::Error::from_reason(format!("deserialize learned note write output: {e}"))
    })
}

fn write_stopless_learned_note_from_contract_plan(
    plan: &stopless_learned_note_contract::StoplessLearnedNoteWritePlan,
) -> NapiResult<String> {
    if !plan.should_write {
        let output = StoplessLearnedNoteWriteOutput {
            ok: false,
            reason: "no_learned_content".to_string(),
            path: None,
        };
        return serde_json::to_string(&output)
            .map_err(|e| napi::Error::from_reason(format!("serialize: {e}")));
    }

    let Some(workdir) = &plan.working_directory else {
        let output = StoplessLearnedNoteWriteOutput {
            ok: false,
            reason: "missing_working_directory".to_string(),
            path: None,
        };
        return serde_json::to_string(&output)
            .map_err(|e| napi::Error::from_reason(format!("serialize: {e}")));
    };

    let note_path = std::path::Path::new(workdir).join("note.md");
    let timestamp_str = {
        let secs = (plan.timestamp_ms / 1000) as i64;
        let millis = (plan.timestamp_ms % 1000) as u32;
        match chrono::TimeZone::timestamp_opt(&chrono::Utc, secs, millis * 1_000_000) {
            chrono::LocalResult::Single(dt) => dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            _ => plan.timestamp_ms.to_string(),
        }
    };

    let mut lines: Vec<String> = vec![
        format!("## {} stopless learned", timestamp_str),
        "".to_string(),
        format!("- requestId: {}", plan.request_id),
    ];
    if let Some(ref sid) = plan.session_id {
        lines.push(format!("- sessionId: {}", sid));
    }
    if let Some(ref reason) = plan.reason {
        lines.push(format!("- stopReason: {}", reason));
    }
    if let Some(ref evidence) = plan.evidence {
        lines.push(format!("- evidence: {}", evidence));
    }
    lines.push("".to_string());
    if let Some(ref learned) = plan.learned {
        lines.push(learned.clone());
    }
    lines.push("".to_string());

    let content = lines.join("\n");
    let existing = std::fs::read_to_string(&note_path).unwrap_or_default();
    let final_content = format!("{}\n\n{}", existing.trim_end(), content)
        .trim_start()
        .to_string();

    if let Some(parent) = note_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&note_path, &final_content) {
        Ok(()) => {
            let output = StoplessLearnedNoteWriteOutput {
                ok: true,
                reason: "written".to_string(),
                path: Some(note_path.to_string_lossy().to_string()),
            };
            serde_json::to_string(&output)
                .map_err(|e| napi::Error::from_reason(format!("serialize: {e}")))
        }
        Err(e) => {
            let output = StoplessLearnedNoteWriteOutput {
                ok: false,
                reason: format!("write_error: {e}"),
                path: None,
            };
            serde_json::to_string(&output)
                .map_err(|e| napi::Error::from_reason(format!("serialize: {e}")))
        }
    }
}

fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn build_runtime_output(
    base: &Value,
    request_id: &str,
    plan: stop_message_auto_handler::StopMessageAutoHandlerPlan,
    metadata_write_plan: StoplessMetadataCenterWritePlan,
    learned_note_write: Option<StoplessLearnedNoteWriteOutput>,
) -> NapiResult<StoplessAutoHandlerRuntimeOutput> {
    let flow_id = plan
        .flow_id
        .clone()
        .unwrap_or_else(|| "stop_message_flow".to_string());
    let internal_action = plan.action.clone();
    let action = match internal_action {
        stop_message_auto_handler::StopMessageAutoPlanAction::ReturnNull => "return_null",
        stop_message_auto_handler::StopMessageAutoPlanAction::ReturnTerminalFinal => {
            "return_handler_result"
        }
        stop_message_auto_handler::StopMessageAutoPlanAction::ReturnSchemaFailFast => {
            "return_handler_result"
        }
        stop_message_auto_handler::StopMessageAutoPlanAction::ReturnSchemaAllowStop => {
            "return_handler_result"
        }
        stop_message_auto_handler::StopMessageAutoPlanAction::ReturnHandlerPlan => {
            "return_handler_result"
        }
    }
    .to_string();

    let output = match internal_action {
        stop_message_auto_handler::StopMessageAutoPlanAction::ReturnNull => {
            StoplessAutoHandlerRuntimeOutput {
                action,
                flow_id: Some(flow_id),
                metadata_write_plan: Some(metadata_write_plan),
                learned_note_write,
                ..Default::default()
            }
        }
        stop_message_auto_handler::StopMessageAutoPlanAction::ReturnTerminalFinal
        | stop_message_auto_handler::StopMessageAutoPlanAction::ReturnSchemaFailFast
        | stop_message_auto_handler::StopMessageAutoPlanAction::ReturnSchemaAllowStop => {
            let chat_response = plan
                .terminal_chat_response
                .clone()
                .unwrap_or_else(|| base.clone());
            StoplessAutoHandlerRuntimeOutput {
                action,
                flow_id: Some(flow_id.clone()),
                chat_response: Some(chat_response.clone()),
                execution: Some(serde_json::json!({
                    "flowId": flow_id,
                    "context": { "stopMessageTerminalFinal": true }
                })),
                handler_result: Some(serde_json::json!({
                    "chatResponse": chat_response,
                    "execution": {
                        "flowId": flow_id,
                        "context": { "stopMessageTerminalFinal": true }
                    }
                })),
                metadata_write_plan: Some(metadata_write_plan),
                learned_note_write,
                ..Default::default()
            }
        }
        stop_message_auto_handler::StopMessageAutoPlanAction::ReturnHandlerPlan => {
            let finalize_context = plan
                .finalize_context
                .clone()
                .filter(|value| value.is_object() && !value.is_array())
                .unwrap_or_else(|| {
                    serde_json::json!({
                        "decision": plan.effective_decision.clone().unwrap_or(Value::Object(Default::default())),
                        "assistantStopText": plan.assistant_stop_text.clone().unwrap_or_default(),
                    })
                });
            StoplessAutoHandlerRuntimeOutput {
                action,
                flow_id: Some(flow_id.clone()),
                chat_response: Some(base.clone()),
                execution: Some(serde_json::json!({
                    "flowId": flow_id,
                    "context": finalize_context
                })),
                handler_result: Some(serde_json::json!({
                    "chatResponse": base.clone(),
                    "execution": {
                        "flowId": flow_id,
                        "context": finalize_context
                    }
                })),
                metadata_write_plan: Some(metadata_write_plan),
                learned_note_write,
                ..Default::default()
            }
        }
    };

    let _ = request_id;
    Ok(output)
}

fn materialize_stopless_builtin_handler_result(
    runtime_output: StoplessAutoHandlerRuntimeOutput,
) -> NapiResult<Value> {
    match runtime_output.action.as_str() {
        "return_null" => Ok(Value::Null),
        "return_handler_result" => {
            let mut handler_result = runtime_output.handler_result.ok_or_else(|| {
                napi::Error::from_reason("[servertool] Rust stopless runtime missing handlerResult")
            })?;
            if let Some(metadata_write_plan) = runtime_output.metadata_write_plan {
                if let Some(obj) = handler_result.as_object_mut() {
                    obj.insert(
                        "metadataWritePlan".to_string(),
                        serde_json::to_value(metadata_write_plan).map_err(|e| {
                            napi::Error::from_reason(format!(
                                "serialize stopless metadata write plan: {e}"
                            ))
                        })?,
                    );
                }
            }
            Ok(handler_result)
        }
        "throw_error" => {
            let message = runtime_output
                .error
                .as_ref()
                .map(|error| error.message.as_str())
                .unwrap_or("[servertool] Rust stopless runtime requested an error");
            Err(napi::Error::from_reason(message.to_string()))
        }
        action => Err(napi::Error::from_reason(format!(
            "[servertool] unsupported Rust stopless runtime action: {action}"
        ))),
    }
}

// ── Input / Output Types ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessExecutionPlanInput {
    pub flow_id: Option<String>,
    pub execution: Value,
    pub request_truth_session_id: Option<String>,
    pub runtime_control: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessAutoCliProjectionInput {
    pub metadata_write_plan: Option<Value>,
    pub stopless_control: Option<Value>,
    pub chat_stop_text: Option<String>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessAutoCliProjectionFromEngineInput {
    pub metadata_center_snapshot: Option<Value>,
    pub execution: Value,
    pub metadata_write_plan: Option<Value>,
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessAutoHandlerRuntimeInput {
    pub base: Value,
    pub request_id: String,
    pub runtime_metadata: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessAutoCliProjectionOutput {
    pub client_call_id: String,
    pub tool_name: String,
    pub command: String,
    pub chat_response: Value,
    pub projection_context: StoplessProjectionContextOutput,
    pub execution_context: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessProjectionContextOutput {
    pub reasoning_text: String,
    pub repeat_count: u32,
    pub max_repeats: u32,
    pub public_trigger_hint: Option<String>,
    pub schema_feedback: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessLearnedNoteWriteOutput {
    pub ok: bool,
    pub reason: String,
    pub path: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessAutoHandlerRuntimeOutput {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_response: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handler_result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_write_plan: Option<StoplessMetadataCenterWritePlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub learned_note_write: Option<StoplessLearnedNoteWriteOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<StoplessRuntimeError>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessRuntimeError {
    pub message: String,
    pub code: String,
    pub status: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal_context_count: Option<i64>,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plan_stopless_auto_handler_roundtrip() {
        let input = json!({
            "base": { "choices": [] },
            "requestId": "req-1",
            "shouldRunVisionFlow": false,
            "shouldBypassStopMessageForMedia": false,
            "defaultConfig": { "enabled": true, "text": "continue", "maxRepeats": 3 },
            "decisionSignals": {
                "portStopMessageDisabled": false,
                "hasResponsesSubmitToolOutputsResume": false,
                "planModeActive": false
            },
            "effectiveRuntimeLoopState": { "repeatCount": 0, "maxRepeats": 3, "active": true }
        });
        let result = plan_stopless_auto_handler_json(input.to_string()).expect("handler plan");
        let plan: Value = serde_json::from_str(&result).expect("json parse");
        assert!(plan.get("action").is_some());
        assert!(plan.get("compareContext").is_some());
    }

    #[test]
    fn build_stopless_auto_cli_projection_missing_request_id_fails() {
        let input = json!({});
        let result = build_stopless_auto_cli_projection_json(input.to_string());
        assert!(result.is_err());
    }

    #[test]
    fn build_stopless_auto_cli_projection_basic_happy_path() {
        let input = json!({
            "metadataWritePlan": {
                "stopless": { "repeatCount": 1, "maxRepeats": 3, "triggerHint": "stop_schema_missing" }
            },
            "chatStopText": "继续推进当前任务",
            "sessionId": "sess-proj",
            "requestId": "req-proj-1"
        });
        let result =
            build_stopless_auto_cli_projection_json(input.to_string()).expect("projection");
        let output: Value = serde_json::from_str(&result).expect("json parse");
        assert_eq!(output["toolName"], "stop_message_auto");
        assert!(!output["clientCallId"].as_str().unwrap_or("").is_empty());
        assert!(output.get("chatResponse").is_some());
        assert!(output.get("projectionContext").is_some());
    }

    #[test]
    fn handler_input_reads_stopless_state_from_runtime_control_only() {
        let input = StoplessAutoHandlerRuntimeInput {
            base: json!({ "choices": [] }),
            request_id: "req-runtime-control".to_string(),
            runtime_metadata: Some(json!({
                "metadataCenterSnapshot": {
                    "requestTruth": { "sessionId": "sess-from-truth" },
                    "runtimeControl": {
                        "stopless": {
                            "flowId": "stop_message_flow",
                            "continuationPrompt": "continue from runtime control",
                            "repeatCount": 1,
                            "maxRepeats": 3,
                            "active": true
                        }
                    }
                }
            })),
        };

        let output = build_stopless_auto_handler_input_value(&input);
        assert_eq!(output["effectiveRuntimeLoopState"]["used"], json!(1));
        assert_eq!(
            output["effectiveRuntimeLoopState"]["text"],
            json!("continue from runtime control")
        );
        assert!(output.get("adapterContext").is_none());
    }

    #[test]
    fn run_stopless_builtin_handler_requires_builtin_name() {
        let result = run_stopless_builtin_handler_for_runtime_json(
            json!({
                "base": { "choices": [] },
                "requestId": "req-missing-builtin-name"
            })
            .to_string(),
        );
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .reason
            .contains("[servertool] missing builtin handler name"));
    }

    #[test]
    fn run_stopless_builtin_handler_rejects_unknown_builtin_name() {
        let result = run_stopless_builtin_handler_for_runtime_json(
            json!({
                "name": "unknown_builtin",
                "base": { "choices": [] },
                "requestId": "req-unknown-builtin-name"
            })
            .to_string(),
        );
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .reason
            .contains("[servertool] unsupported builtin handler runtime: unknown_builtin"));
    }

    #[test]
    fn write_stopless_learned_note_no_content_returns_ok_false() {
        let input = json!({
            "requestId": "req-note-1",
            "parsed": { "reason": "test" }
        });
        let result = write_stopless_learned_note_json(input.to_string()).expect("note write");
        let output: Value = serde_json::from_str(&result).expect("json parse");
        assert_eq!(output["ok"], false);
        assert_eq!(output["reason"], "no_learned_content");
    }

    #[test]
    fn write_stopless_learned_note_missing_workdir_returns_ok_false() {
        let input = json!({
            "requestId": "req-note-2",
            "parsed": { "learned": "fact" }
        });
        let result = write_stopless_learned_note_json(input.to_string()).expect("note write");
        let output: Value = serde_json::from_str(&result).expect("json parse");
        assert_eq!(output["ok"], false);
        assert_eq!(output["reason"], "missing_working_directory");
    }

    #[test]
    fn write_stopless_learned_note_full_path() {
        let dir = std::env::temp_dir().join(format!("stopless_note_test_{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        let input = json!({
            "workingDirectory": dir.to_str().unwrap(),
            "requestId": "req-note-3",
            "sessionId": "sess-note-3",
            "parsed": { "learned": "test fact", "reason": "test reason", "evidence": "log output" }
        });
        let result = write_stopless_learned_note_json(input.to_string()).expect("note write");
        let output: Value = serde_json::from_str(&result).expect("json parse");
        assert_eq!(output["ok"], true);
        let note_path = dir.join("note.md");
        assert!(note_path.exists());
        let content = std::fs::read_to_string(&note_path).expect("read note");
        assert!(content.contains("test fact"));
        assert!(content.contains("req-note-3"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
