// feature_id: hub.servertool_stopless_cli_projection_context
use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_REASONING_TEXT: &str = "继续推进当前任务。";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessCliProjectionRuntimeSnapshotInput {
    #[serde(default)]
    pub used: Option<u32>,
    #[serde(default)]
    pub max_repeats: Option<u32>,
    #[serde(default)]
    pub trigger_hint: Option<String>,
    #[serde(default)]
    pub schema_feedback: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessCliProjectionContextInput {
    #[serde(default)]
    pub execution_context: Option<Value>,
    #[serde(default)]
    pub stopless_control: Option<Value>,
    #[serde(default)]
    pub runtime_snapshot: Option<StoplessCliProjectionRuntimeSnapshotInput>,
    #[serde(default)]
    pub chat_stop_text: Option<String>,
    #[serde(default)]
    pub adapter_stop_text: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessCliProjectionContextPlan {
    pub reasoning_text: String,
    pub repeat_count: u32,
    pub max_repeats: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_feedback: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

pub fn plan_stopless_cli_projection_context(
    input: StoplessCliProjectionContextInput,
) -> StoplessCliProjectionContextPlan {
    let execution_context = input.execution_context.as_ref().and_then(Value::as_object);
    let execution_stopless = execution_context
        .and_then(|row| row.get("stopless"))
        .and_then(Value::as_object);
    let loop_state = execution_context
        .and_then(|row| row.get("serverToolLoopState"))
        .and_then(Value::as_object);
    let stopless_control = input.stopless_control.as_ref().and_then(Value::as_object);
    let runtime_snapshot = input.runtime_snapshot.as_ref();

    let execution_stopless_repeat_count = execution_stopless
        .and_then(|row| row.get("repeatCount"))
        .and_then(read_u32);
    let stopless_control_repeat_count = stopless_control
        .and_then(|row| row.get("repeatCount"))
        .and_then(read_u32);
    let loop_state_repeat_count = loop_state
        .and_then(|row| row.get("repeatCount"))
        .and_then(read_u32);
    let explicit_repeat_count = execution_stopless_repeat_count
        .or(stopless_control_repeat_count)
        .or(loop_state_repeat_count);
    let runtime_repeat_count = runtime_snapshot
        .and_then(|snapshot| snapshot.used)
        .map(|used| used.saturating_add(1));
    let repeat_count = match (explicit_repeat_count, runtime_repeat_count) {
        (_, _) if execution_stopless_repeat_count.is_some() => execution_stopless_repeat_count,
        (Some(explicit), Some(runtime)) if runtime > explicit && stopless_control_repeat_count.is_some() => {
            Some(runtime)
        }
        (Some(explicit), _) => Some(explicit),
        (None, Some(runtime)) => Some(runtime),
        (None, None) => None,
    }
        .map(|count| count.max(1))
        .unwrap_or(1);

    let explicit_max_repeats = execution_stopless
        .and_then(|row| row.get("maxRepeats"))
        .and_then(read_u32)
        .or_else(|| {
            stopless_control
                .and_then(|row| row.get("maxRepeats"))
                .and_then(read_u32)
        })
        .or_else(|| {
            loop_state
                .and_then(|row| row.get("maxRepeats"))
                .and_then(read_u32)
        })
        .filter(|value| *value > 0);
    let max_repeats = explicit_max_repeats
        .or_else(|| runtime_snapshot.and_then(|snapshot| snapshot.max_repeats).filter(|value| *value > 0))
        .unwrap_or_else(|| repeat_count.max(1));

    let trigger_hint = first_non_empty_string([
        execution_stopless.and_then(|row| row.get("triggerHint")),
        execution_context.and_then(|row| row.get("stopSchemaTriggerHint")),
        stopless_control.and_then(|row| row.get("triggerHint")),
        loop_state.and_then(|row| row.get("triggerHint")),
    ])
    .or_else(|| {
        runtime_snapshot
            .and_then(|snapshot| snapshot.trigger_hint.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    });

    let schema_feedback = [
        execution_stopless.and_then(|row| row.get("schemaFeedback")),
        execution_context.and_then(|row| row.get("stopSchemaFeedback")),
        stopless_control.and_then(|row| row.get("schemaFeedback")),
        loop_state.and_then(|row| row.get("schemaFeedback")),
    ]
    .into_iter()
    .flatten()
    .find(|value| value.is_object())
    .cloned()
    .or_else(|| {
        runtime_snapshot
            .and_then(|snapshot| snapshot.schema_feedback.as_ref())
            .filter(|value| value.is_object())
            .cloned()
    });

    StoplessCliProjectionContextPlan {
        reasoning_text: first_non_empty_owned_string([
            input.chat_stop_text.as_deref(),
            input.adapter_stop_text.as_deref(),
        ])
        .unwrap_or_else(|| DEFAULT_REASONING_TEXT.to_string()),
        repeat_count,
        max_repeats,
        trigger_hint,
        schema_feedback,
        session_id: first_non_empty_owned_string([input.session_id.as_deref()]),
        request_id: first_non_empty_owned_string([input.request_id.as_deref()]),
    }
}

fn read_u32(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|number| u32::try_from(number).ok())
}

fn first_non_empty_string<'a, I>(candidates: I) -> Option<String>
where
    I: IntoIterator<Item = Option<&'a Value>>,
{
    candidates
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn first_non_empty_owned_string<'a, I>(candidates: I) -> Option<String>
where
    I: IntoIterator<Item = Option<&'a str>>,
{
    candidates
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prefers_current_execution_stopless_then_runtime_snapshot() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            execution_context: Some(json!({
                "stopless": {
                    "repeatCount": 2,
                    "maxRepeats": 4,
                    "triggerHint": " loop-hint ",
                    "schemaFeedback": {
                        "reason_code": "loop_feedback"
                    }
                },
                "stopSchemaTriggerHint": "context-hint",
                "stopSchemaFeedback": {
                    "reason_code": "context_feedback"
                }
            })),
            stopless_control: Some(json!({
                "triggerHint": "control-hint",
                "schemaFeedback": {
                    "reason_code": "control_feedback"
                }
            })),
            runtime_snapshot: Some(StoplessCliProjectionRuntimeSnapshotInput {
                used: Some(1),
                max_repeats: Some(3),
                trigger_hint: Some(" runtime-hint ".to_string()),
                schema_feedback: Some(json!({
                    "reason_code": "runtime_feedback"
                })),
            }),
            chat_stop_text: Some("  来自 chat 的 stop 文本  ".to_string()),
            adapter_stop_text: Some("来自 adapter 的 stop 文本".to_string()),
            session_id: Some(" session-truth-1 ".to_string()),
            request_id: Some(" request-truth-1 ".to_string()),
        });

        assert_eq!(plan.reasoning_text, "来自 chat 的 stop 文本");
        assert_eq!(plan.repeat_count, 2);
        assert_eq!(plan.max_repeats, 4);
        assert_eq!(plan.trigger_hint.as_deref(), Some("loop-hint"));
        assert_eq!(
            plan.schema_feedback,
            Some(json!({
                "reason_code": "loop_feedback"
            }))
        );
        assert_eq!(plan.session_id.as_deref(), Some("session-truth-1"));
        assert_eq!(plan.request_id.as_deref(), Some("request-truth-1"));
    }

    #[test]
    fn falls_back_to_execution_loop_state_only_when_stopless_block_is_absent() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            execution_context: Some(json!({
                "serverToolLoopState": {
                    "repeatCount": 2,
                    "maxRepeats": 4,
                    "triggerHint": " loop-hint ",
                    "schemaFeedback": {
                        "reason_code": "loop_feedback"
                    }
                }
            })),
            stopless_control: None,
            runtime_snapshot: Some(StoplessCliProjectionRuntimeSnapshotInput {
                used: Some(1),
                max_repeats: Some(3),
                trigger_hint: Some(" runtime-hint ".to_string()),
                schema_feedback: Some(json!({
                    "reason_code": "runtime_feedback"
                })),
            }),
            chat_stop_text: Some("stop text".to_string()),
            adapter_stop_text: None,
            session_id: None,
            request_id: None,
        });

        assert_eq!(plan.repeat_count, 2);
        assert_eq!(plan.max_repeats, 4);
        assert_eq!(plan.trigger_hint.as_deref(), Some("loop-hint"));
        assert_eq!(
            plan.schema_feedback,
            Some(json!({
                "reason_code": "loop_feedback"
            }))
        );
    }

    #[test]
    fn explicit_repeat_count_beats_advanced_runtime_snapshot() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            execution_context: Some(json!({
                "stopless": {
                    "repeatCount": 2,
                    "maxRepeats": 3
                }
            })),
            stopless_control: None,
            runtime_snapshot: Some(StoplessCliProjectionRuntimeSnapshotInput {
                used: Some(2),
                max_repeats: Some(3),
                trigger_hint: None,
                schema_feedback: None,
            }),
            chat_stop_text: Some("stop text".to_string()),
            adapter_stop_text: None,
            session_id: None,
            request_id: None,
        });

        assert_eq!(plan.repeat_count, 2);
        assert_eq!(plan.max_repeats, 3);
    }

    #[test]
    fn uses_persisted_runtime_snapshot_when_current_loop_state_is_absent() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            execution_context: Some(json!({})),
            stopless_control: None,
            runtime_snapshot: Some(StoplessCliProjectionRuntimeSnapshotInput {
                used: Some(1),
                max_repeats: Some(3),
                trigger_hint: Some(" runtime-hint ".to_string()),
                schema_feedback: Some(json!({
                    "reason_code": "runtime_feedback"
                })),
            }),
            chat_stop_text: Some("stop text".to_string()),
            adapter_stop_text: None,
            session_id: None,
            request_id: None,
        });

        assert_eq!(plan.repeat_count, 2);
        assert_eq!(plan.max_repeats, 3);
        assert_eq!(plan.trigger_hint.as_deref(), Some("runtime-hint"));
        assert_eq!(
            plan.schema_feedback,
            Some(json!({
                "reason_code": "runtime_feedback"
            }))
        );
    }

    #[test]
    fn explicit_execution_stopless_repeat_count_stays_current_turn_even_if_runtime_snapshot_is_higher() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            execution_context: Some(json!({
                "stopless": {
                    "repeatCount": 1,
                    "maxRepeats": 3
                }
            })),
            stopless_control: Some(json!({
                "repeatCount": 1,
                "maxRepeats": 3
            })),
            runtime_snapshot: Some(StoplessCliProjectionRuntimeSnapshotInput {
                used: Some(1),
                max_repeats: Some(3),
                trigger_hint: None,
                schema_feedback: None,
            }),
            chat_stop_text: Some("stop text".to_string()),
            adapter_stop_text: None,
            session_id: None,
            request_id: None,
        });

        assert_eq!(plan.repeat_count, 1);
        assert_eq!(plan.max_repeats, 3);
    }


    #[test]
    fn prefers_canonical_stopless_budget_over_legacy_loop_budget() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            execution_context: Some(json!({
                "serverToolLoopState": {
                    "repeatCount": 1,
                    "maxRepeats": 1,
                    "triggerHint": "legacy-hint",
                    "schemaFeedback": {
                        "reason_code": "legacy_feedback"
                    }
                },
                "stopless": {
                    "repeatCount": 1,
                    "maxRepeats": 3,
                    "triggerHint": "invalid_schema",
                    "schemaFeedback": {
                        "reasonCode": "stop_schema_terminal_missing_fields"
                    }
                }
            })),
            stopless_control: Some(json!({
                "repeatCount": 1,
                "maxRepeats": 3,
                "triggerHint": "control-hint"
            })),
            runtime_snapshot: Some(StoplessCliProjectionRuntimeSnapshotInput {
                used: Some(0),
                max_repeats: Some(1),
                trigger_hint: None,
                schema_feedback: None,
            }),
            chat_stop_text: Some("stop text".to_string()),
            adapter_stop_text: None,
            session_id: None,
            request_id: None,
        });

        assert_eq!(plan.repeat_count, 1);
        assert_eq!(plan.max_repeats, 3);
        assert_eq!(plan.trigger_hint.as_deref(), Some("invalid_schema"));
        assert_eq!(
            plan.schema_feedback,
            Some(json!({
                "reasonCode": "stop_schema_terminal_missing_fields"
            }))
        );
    }

    #[test]
    fn falls_back_to_defaults_when_snapshot_and_context_missing() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            execution_context: Some(json!({})),
            stopless_control: None,
            runtime_snapshot: None,
            chat_stop_text: Some(" ".to_string()),
            adapter_stop_text: None,
            session_id: Some(" ".to_string()),
            request_id: None,
        });

        assert_eq!(plan.reasoning_text, DEFAULT_REASONING_TEXT);
        assert_eq!(plan.repeat_count, 1);
        assert_eq!(plan.max_repeats, 1);
        assert_eq!(plan.trigger_hint, None);
        assert_eq!(plan.schema_feedback, None);
        assert_eq!(plan.session_id, None);
        assert_eq!(plan.request_id, None);
    }

    #[test]
    fn uses_context_and_control_when_loop_state_missing_fields() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            execution_context: Some(json!({
                "serverToolLoopState": {},
                "stopSchemaTriggerHint": "context-hint",
                "stopSchemaFeedback": {
                    "reason_code": "context_feedback"
                }
            })),
            stopless_control: Some(json!({
                "triggerHint": "control-hint"
            })),
            runtime_snapshot: Some(StoplessCliProjectionRuntimeSnapshotInput {
                used: None,
                max_repeats: None,
                trigger_hint: None,
                schema_feedback: None,
            }),
            chat_stop_text: None,
            adapter_stop_text: Some("adapter stop".to_string()),
            session_id: None,
            request_id: Some(" request-context-2 ".to_string()),
        });

        assert_eq!(plan.reasoning_text, "adapter stop");
        assert_eq!(plan.repeat_count, 1);
        assert_eq!(plan.max_repeats, 1);
        assert_eq!(plan.trigger_hint.as_deref(), Some("context-hint"));
        assert_eq!(
            plan.schema_feedback,
            Some(json!({
                "reason_code": "context_feedback"
            }))
        );
        assert_eq!(plan.session_id, None);
        assert_eq!(plan.request_id.as_deref(), Some("request-context-2"));
    }
}
