// feature_id: hub.servertool_stopless_cli_projection_context
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli_contract::normalize_stopless_trigger_hint_for_metadata;

const DEFAULT_REASONING_TEXT: &str = "继续推进当前任务。";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessCliProjectionMetadataWritePlanInput {
    #[serde(default)]
    pub stopless: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessCliProjectionContextInput {
    #[serde(default)]
    pub metadata_write_plan: Option<StoplessCliProjectionMetadataWritePlanInput>,
    #[serde(default)]
    pub stopless_control: Option<Value>,
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
    pub public_trigger_hint: Option<String>,
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
    let metadata_plan_stopless = input
        .metadata_write_plan
        .as_ref()
        .and_then(|plan| plan.stopless.as_ref())
        .and_then(Value::as_object);
    let stopless_control = input.stopless_control.as_ref().and_then(Value::as_object);

    let metadata_plan_repeat_count = metadata_plan_stopless
        .and_then(|row| row.get("repeatCount").or_else(|| row.get("repeat_count")))
        .and_then(read_u32);
    let stopless_control_repeat_count = stopless_control
        .and_then(|row| row.get("repeatCount").or_else(|| row.get("repeat_count")))
        .and_then(read_u32);
    let repeat_count = metadata_plan_repeat_count
        .or(stopless_control_repeat_count)
        .map(|count| count.max(1))
        .unwrap_or(1);

    let max_repeats = metadata_plan_stopless
        .and_then(|row| row.get("maxRepeats").or_else(|| row.get("max_repeats")))
        .and_then(read_u32)
        .or_else(|| {
            stopless_control
                .and_then(|row| row.get("maxRepeats").or_else(|| row.get("max_repeats")))
                .and_then(read_u32)
        })
        .filter(|value| *value > 0)
        .unwrap_or_else(|| repeat_count.max(1));

    let public_trigger_hint = first_non_empty_string([
        metadata_plan_stopless
            .and_then(|row| row.get("triggerHint").or_else(|| row.get("trigger_hint"))),
        stopless_control.and_then(|row| row.get("triggerHint")),
    ])
    .map(|hint| normalize_stopless_trigger_hint_for_metadata(Some(&hint)).to_string());

    let schema_feedback = [
        metadata_plan_stopless.and_then(|row| row.get("schemaFeedback")),
        stopless_control.and_then(|row| row.get("schemaFeedback")),
    ]
    .into_iter()
    .flatten()
    .find(|value| value.is_object())
    .cloned();

    StoplessCliProjectionContextPlan {
        reasoning_text: first_non_empty_owned_string([
            input.chat_stop_text.as_deref(),
            input.adapter_stop_text.as_deref(),
        ])
        .unwrap_or_else(|| DEFAULT_REASONING_TEXT.to_string()),
        repeat_count,
        max_repeats,
        public_trigger_hint,
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
    fn uses_metadata_write_plan_as_current_stopless_control() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            metadata_write_plan: Some(StoplessCliProjectionMetadataWritePlanInput {
                stopless: Some(json!({
                    "repeatCount": 2,
                    "maxRepeats": 4,
                    "triggerHint": " stop_schema_continue_next_step ",
                    "schemaFeedback": {
                        "reasonCode": "stop_schema_continue_next_step"
                    }
                })),
            }),
            stopless_control: Some(json!({
                "triggerHint": "control-hint",
                "schemaFeedback": {
                    "reason_code": "control_feedback"
                }
            })),
            chat_stop_text: Some("  来自 chat 的 stop 文本  ".to_string()),
            adapter_stop_text: Some("来自 adapter 的 stop 文本".to_string()),
            session_id: Some(" session-truth-1 ".to_string()),
            request_id: Some(" request-truth-1 ".to_string()),
        });

        assert_eq!(plan.reasoning_text, "来自 chat 的 stop 文本");
        assert_eq!(plan.repeat_count, 2);
        assert_eq!(plan.max_repeats, 4);
        assert_eq!(
            plan.public_trigger_hint.as_deref(),
            Some("non_terminal_schema")
        );
        assert_eq!(
            plan.schema_feedback,
            Some(json!({
                "reasonCode": "stop_schema_continue_next_step"
            }))
        );
        assert_eq!(plan.session_id.as_deref(), Some("session-truth-1"));
        assert_eq!(plan.request_id.as_deref(), Some("request-truth-1"));
    }

    #[test]
    fn uses_existing_metadata_center_control_when_current_write_plan_is_absent() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            metadata_write_plan: None,
            stopless_control: Some(json!({
                "repeatCount": 3,
                "maxRepeats": 5,
                "triggerHint": "stop_schema_missing",
                "schemaFeedback": {
                    "reasonCode": "stop_schema_missing"
                }
            })),
            chat_stop_text: Some("stop text".to_string()),
            adapter_stop_text: None,
            session_id: None,
            request_id: None,
        });

        assert_eq!(plan.repeat_count, 3);
        assert_eq!(plan.max_repeats, 5);
        assert_eq!(plan.public_trigger_hint.as_deref(), Some("no_schema"));
        assert_eq!(
            plan.schema_feedback,
            Some(json!({
                "reasonCode": "stop_schema_missing"
            }))
        );
    }

    #[test]
    fn ignores_legacy_context_and_loop_state_control() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            metadata_write_plan: None,
            stopless_control: None,
            chat_stop_text: Some("stop text".to_string()),
            adapter_stop_text: None,
            session_id: None,
            request_id: None,
        });

        assert_eq!(plan.repeat_count, 1);
        assert_eq!(plan.max_repeats, 1);
        assert_eq!(plan.public_trigger_hint, None);
        assert_eq!(plan.schema_feedback, None);
    }

    #[test]
    fn falls_back_to_defaults_when_control_is_missing() {
        let plan = plan_stopless_cli_projection_context(StoplessCliProjectionContextInput {
            metadata_write_plan: None,
            stopless_control: None,
            chat_stop_text: Some(" ".to_string()),
            adapter_stop_text: None,
            session_id: Some(" ".to_string()),
            request_id: None,
        });

        assert_eq!(plan.reasoning_text, DEFAULT_REASONING_TEXT);
        assert_eq!(plan.repeat_count, 1);
        assert_eq!(plan.max_repeats, 1);
        assert_eq!(plan.public_trigger_hint, None);
        assert_eq!(plan.schema_feedback, None);
        assert_eq!(plan.session_id, None);
        assert_eq!(plan.request_id, None);
    }
}
