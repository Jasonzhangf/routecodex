//! MetadataCenter runtime_control write plan — built by Rust.
//!
//! This module produces the Rust runtime effect that the generic MetadataCenter
//! runtime_control writer applies at the Chat Process boundary.
//!
//! Feature: hub.servertool_stopless_cli_continuation

use crate::metadata_center::types::MetadataCenter;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use servertool_core::stop_message_auto_handler::StopMessageAutoHandlerPlan;

// ── Write plan types ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessMetadataCenterWritePlan {
    pub stopless: Option<StoplessRuntimeControlWrite>,
    pub stop_message_compare_context: Option<Value>,
    pub learned_note: Option<LearnedNoteWrite>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessRuntimeControlWrite {
    pub flow_id: String,
    pub active: bool,
    pub repeat_count: u32,
    pub max_repeats: u32,
    pub trigger_hint: Option<String>,
    pub continuation_prompt: Option<String>,
    pub schema_feedback: Option<Value>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LearnedNoteWrite {
    pub request_id: String,
    pub session_id: Option<String>,
    pub working_directory: Option<String>,
    pub timestamp_ms: u64,
    pub learned: Option<String>,
    pub reason: Option<String>,
    pub evidence: Option<String>,
}

// ── Builder ──────────────────────────────────────────────────────────────────

/// Build a MetadataCenter write plan from a StopMessageAutoHandlerPlan.
///
/// Called from Rust stopless runtime assembly. The resulting value is returned
/// with the Chat Process runtime effects and applied only as runtime_control.
pub fn build_stopless_metadata_center_write_plan(
    handler_plan: &StopMessageAutoHandlerPlan,
    center: &MetadataCenter,
    request_id: &str,
    timestamp_ms: u64,
) -> StoplessMetadataCenterWritePlan {
    let stopless = handler_plan.effective_decision.as_ref().map(|effective| {
        let repeat_count = handler_plan
            .persist_plan
            .as_ref()
            .map(|p| p.next_used)
            .unwrap_or(0) as u32;
        let max_repeats = handler_plan
            .persist_plan
            .as_ref()
            .map(|p| p.next_max_repeats)
            .unwrap_or(0) as u32;

        StoplessRuntimeControlWrite {
            flow_id: "stop_message_flow".to_string(),
            active: true,
            repeat_count,
            max_repeats,
            trigger_hint: handler_plan.stopless_trigger_hint.clone(),
            continuation_prompt: effective
                .get("followup_text")
                .and_then(Value::as_str)
                .map(String::from),
            schema_feedback: handler_plan.schema_feedback.as_ref().map(|sf| {
                serde_json::json!({
                    "reasonCode": sf.reason_code,
                    "missingFields": sf.missing_fields,
                })
            }),
            updated_at: timestamp_ms,
        }
    });

    let learned_note = handler_plan
        .learned_note
        .as_ref()
        .filter(|note| {
            note.get("learned")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .is_some()
        })
        .map(|note| {
            let session_id = center.request_truth.session_id.as_ref().map(|s| s.clone());
            let working_directory = resolve_working_directory_from_metadata(&center);
            LearnedNoteWrite {
                request_id: request_id.to_string(),
                session_id,
                working_directory,
                timestamp_ms,
                learned: note
                    .get("learned")
                    .and_then(Value::as_str)
                    .map(String::from),
                reason: note.get("reason").and_then(Value::as_str).map(String::from),
                evidence: note
                    .get("evidence")
                    .and_then(Value::as_str)
                    .map(String::from),
            }
        });

    StoplessMetadataCenterWritePlan {
        stopless,
        stop_message_compare_context: Some(
            serde_json::to_value(&handler_plan.compare_context).unwrap_or_default(),
        ),
        learned_note,
    }
}

fn resolve_working_directory_from_metadata(center: &MetadataCenter) -> Option<String> {
    // The working directory is not directly in MetadataCenter.
    // It is resolved by TS from adapterContext at write time.
    // Return None here; TS caller fills it in.
    None
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata_center::types::MetadataCenter;
    use serde_json::json;
    use servertool_core::stop_message_compare_context::StopMessageCompareContext;

    #[test]
    fn builds_write_plan_from_handler_plan_with_decision() {
        let mut compare = StopMessageCompareContext::default();
        compare.decision = "trigger".to_string();
        compare.reason = "stop_schema_missing".to_string();
        let plan = StopMessageAutoHandlerPlan {
            action: servertool_core::stop_message_auto_handler::StopMessageAutoPlanAction::ReturnHandlerPlan,
            compare_context: compare,
            terminal_chat_response: None,
            should_write_learned_note: None,
            learned_note: None,
            flow_id: None,
            effective_decision: Some(json!({
                "action": "trigger",
                "used": 1,
                "maxRepeats": 3,
                "followup_text": "continue doing"
            })),
            persist_plan: Some(servertool_core::stop_message_persist_plan::StopMessagePersistPlan {
                compare_max_repeats: 3,
                compare_remaining: 1,
                next_used: 2,
                next_max_repeats: 3,
                snapshot: servertool_core::stop_message_persist_plan::StopMessagePersistSnapshotPlan {
                    text: String::new(),
                    provider_key: None,
                    max_repeats: 3,
                    used: 2,
                    source: "default".to_string(),
                    stage_mode: "on".to_string(),
                    ai_mode: "off".to_string(),
                },
            }),
            stopless_trigger_hint: Some("no_schema".to_string()),
            schema_feedback: None,
            assistant_stop_text: None,
            native_handler_result: None,
            finalize_context: None,
            finalize_stopless: None,
            schema_gate: None,
        };
        let center = MetadataCenter::default();
        let write_plan = build_stopless_metadata_center_write_plan(&plan, &center, "req-1", 1000);
        assert!(write_plan.stopless.is_some());
        let stopless = write_plan.stopless.unwrap();
        assert_eq!(stopless.repeat_count, 2);
        assert_eq!(stopless.max_repeats, 3);
        assert_eq!(stopless.trigger_hint.as_deref(), Some("no_schema"));
        assert_eq!(
            stopless.continuation_prompt.as_deref(),
            Some("continue doing")
        );
    }

    #[test]
    fn builds_write_plan_without_decision_yields_no_stopless() {
        let mut compare = StopMessageCompareContext::default();
        compare.decision = "skip".to_string();
        let plan = StopMessageAutoHandlerPlan {
            action:
                servertool_core::stop_message_auto_handler::StopMessageAutoPlanAction::ReturnNull,
            compare_context: compare,
            terminal_chat_response: None,
            should_write_learned_note: None,
            learned_note: None,
            flow_id: None,
            effective_decision: None,
            persist_plan: None,
            stopless_trigger_hint: None,
            schema_feedback: None,
            assistant_stop_text: None,
            native_handler_result: None,
            finalize_context: None,
            finalize_stopless: None,
            schema_gate: None,
        };
        let center = MetadataCenter::default();
        let write_plan = build_stopless_metadata_center_write_plan(&plan, &center, "req-2", 2000);
        assert!(write_plan.stopless.is_none());
        assert!(write_plan.learned_note.is_none());
    }

    #[test]
    fn builds_learned_note_when_plan_has_learned() {
        let mut compare = StopMessageCompareContext::default();
        let plan = StopMessageAutoHandlerPlan {
            action: servertool_core::stop_message_auto_handler::StopMessageAutoPlanAction::ReturnSchemaAllowStop,
            compare_context: compare,
            terminal_chat_response: None,
            should_write_learned_note: Some(true),
            learned_note: Some(json!({
                "learned": "observed that X is true",
                "reason": "verification complete",
                "evidence": "test output"
            })),
            flow_id: None,
            effective_decision: None,
            persist_plan: None,
            stopless_trigger_hint: None,
            schema_feedback: None,
            assistant_stop_text: None,
            native_handler_result: None,
            finalize_context: None,
            finalize_stopless: None,
            schema_gate: None,
        };
        let mut center = MetadataCenter::default();
        center.request_truth.session_id = Some("sess-learned".to_string());
        let write_plan = build_stopless_metadata_center_write_plan(&plan, &center, "req-3", 3000);
        assert!(write_plan.learned_note.is_some());
        let note = write_plan.learned_note.unwrap();
        assert_eq!(note.request_id, "req-3");
        assert_eq!(note.learned.as_deref(), Some("observed that X is true"));
        assert_eq!(note.session_id.as_deref(), Some("sess-learned"));
    }
}
