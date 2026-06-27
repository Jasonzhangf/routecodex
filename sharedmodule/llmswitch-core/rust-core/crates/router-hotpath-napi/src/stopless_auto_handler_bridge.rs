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

use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use servertool_core::cli_contract::{self, ClientExecCliProjectionInput};
use servertool_core::cli_result_guard;
use servertool_core::persisted_lookup;
use servertool_core::stop_message_default_config::{self, StopMessageDefaultConfigInput};
use servertool_core::stop_message_auto_handler::{self, StopMessageAutoHandlerInput};
use servertool_core::stopless_decision_context_signals::{self, StoplessDecisionContextSignalsInput};
use servertool_core::stopless_cli_projection_context_contract;
use servertool_core::stopless_learned_note_contract;

fn build_stopless_exec_command(
    repeat_count: u32,
    max_repeats: u32,
    trigger_hint: Option<&str>,
    session_id: Option<&str>,
    request_id: Option<&str>,
) -> String {
    let trigger = trigger_hint.unwrap_or("no_schema");
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
            napi::Error::from_reason(format!(
                "deserialize StoplessAutoHandlerRuntimeInput: {e}"
            ))
        })?;

    let metadata_runtime_control = input
        .runtime_metadata
        .as_ref()
        .and_then(|value| value.get("metadataCenterSnapshot"))
        .and_then(|value| value.get("runtimeControl"))
        .cloned()
        .or_else(|| {
            input
                .adapter_context
                .get("metadataCenterSnapshot")
                .and_then(|value| value.get("runtimeControl"))
                .cloned()
        });

    let metadata_previous_compare = metadata_runtime_control
        .as_ref()
        .and_then(|value| value.get("stopMessageCompareContext"))
        .cloned();

    let captured_request = persisted_lookup::get_captured_request(&input.adapter_context);
    let decision_signals =
        stopless_decision_context_signals::plan_stopless_decision_context_signals(
            &StoplessDecisionContextSignalsInput {
                adapter_context: input.adapter_context.clone(),
                runtime_metadata: input.runtime_metadata.clone(),
                captured_request: captured_request.clone(),
            },
        );
    let default_config =
        stop_message_default_config::plan_stop_message_default_config(&StopMessageDefaultConfigInput {
            tombstone_cleared: Some(false),
            config_enabled: None,
            config_text: None,
            config_max_repeats: None,
            env_text: None,
            env_max_repeats: None,
        });
    let current_tool_output_snapshot =
        cli_result_guard::extract_stop_message_auto_cli_result_snapshot_from_request(
            &serde_json::json!({
                "adapterContext": input.adapter_context,
                "runtimeMetadata": input.runtime_metadata,
            }),
        );
    let effective_runtime_loop_state = current_tool_output_snapshot.or_else(|| {
        persisted_lookup::resolve_runtime_stop_message_state_from_adapter_context(
            &persisted_lookup::RuntimeStopMessageStateFromAdapterContextInput {
                adapter_context: input.adapter_context.clone(),
                runtime_metadata: input.runtime_metadata.clone(),
            },
        )
        .and_then(|snapshot| serde_json::to_value(snapshot).ok())
    });

    let output = serde_json::json!({
        "adapterContext": input.adapter_context,
        "base": input.base,
        "requestId": input.request_id,
        "followupFlowId": Value::Null,
        "shouldRunVisionFlow": false,
        "shouldBypassStopMessageForMedia": false,
        "metadataRuntimeControl": metadata_runtime_control,
        "metadataPreviousCompare": metadata_previous_compare,
        "defaultConfig": default_config,
        "decisionSignals": decision_signals,
        "capturedRequest": captured_request,
        "effectiveRuntimeLoopState": effective_runtime_loop_state,
        "providerKey": Value::Null,
    });

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("serialize StopMessageAutoHandlerInput: {e}")))
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
///   "adapterContext": { ... },
///   "executionContext": { "stopless": { ... } },
///   "stoplessControl": { ... },
///   "runtimeSnapshot": { ... },
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
    let runtime_snapshot = input
        .runtime_snapshot
        .and_then(|v| {
            serde_json::from_value::<stopless_cli_projection_context_contract::StoplessCliProjectionRuntimeSnapshotInput>(v)
                .ok()
        });
    let ctx_input = stopless_cli_projection_context_contract::StoplessCliProjectionContextInput {
        execution_context: input.execution_context,
        stopless_control: input.stopless_control,
        runtime_snapshot,
        chat_stop_text: input.chat_stop_text.clone(),
        adapter_stop_text: input.chat_stop_text,
        session_id: input.session_id,
        request_id: input.request_id.clone(),
    };
    let ctx = stopless_cli_projection_context_contract::plan_stopless_cli_projection_context(ctx_input);

    // Step 2: generate a client call id
    let client_call_id = format!(
        "call_stopless_{}",
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
                "triggerHint": ctx.trigger_hint,
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
            ctx.trigger_hint.as_deref(),
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
        client_call_id: shell.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
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
            trigger_hint: ctx.trigger_hint,
            schema_feedback: ctx.schema_feedback,
        },
        execution_context: exec_ctx,
    };

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("serialize: {e}")))
}

// ── NAPI: write stopless learned note ─────────────────────────────────────────

/// Write a stopless learned note entry to `note.md` in the working directory.
/// This replaces the TS `writeStoplessLearnedNoteEntry` from `cache-writer.ts`.
#[napi]
pub fn write_stopless_learned_note_json(input_json: String) -> NapiResult<String> {
    let input: stopless_learned_note_contract::StoplessLearnedNotePlanInput = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!("deserialize learned note input: {e}"))
    })?;
    let plan = stopless_learned_note_contract::plan_stopless_learned_note_write(input);

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

// ── Input / Output Types ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessAutoCliProjectionInput {
    pub adapter_context: Option<Value>,
    pub execution_context: Option<Value>,
    pub stopless_control: Option<Value>,
    pub runtime_snapshot: Option<Value>,
    pub chat_stop_text: Option<String>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessAutoHandlerRuntimeInput {
    pub adapter_context: Value,
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
    pub trigger_hint: Option<String>,
    pub schema_feedback: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoplessLearnedNoteWriteOutput {
    pub ok: bool,
    pub reason: String,
    pub path: Option<String>,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plan_stopless_auto_handler_roundtrip() {
        let input = json!({
            "adapterContext": { "sessionId": "sess-1" },
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
            "adapterContext": { "sessionId": "sess-proj" },
            "executionContext": {
                "stopless": { "repeatCount": 1, "maxRepeats": 3 }
            },
            "chatStopText": "继续推进当前任务",
            "requestId": "req-proj-1"
        });
        let result = build_stopless_auto_cli_projection_json(input.to_string()).expect("projection");
        let output: Value = serde_json::from_str(&result).expect("json parse");
        assert_eq!(output["toolName"], "stop_message_auto");
        assert!(!output["clientCallId"].as_str().unwrap_or("").is_empty());
        assert!(output.get("chatResponse").is_some());
        assert!(output.get("projectionContext").is_some());
    }

    #[test]
    fn write_stopless_learned_note_no_content_returns_ok_false() {
        let input = json!({
            "adapterContext": {},
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
            "adapterContext": {},
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
        let dir = std::env::temp_dir().join(format!(
            "stopless_note_test_{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let input = json!({
            "adapterContext": { "workdir": dir.to_str().unwrap() },
            "requestId": "req-note-3",
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
