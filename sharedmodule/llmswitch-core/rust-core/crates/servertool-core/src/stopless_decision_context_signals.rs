use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessDecisionContextSignalsInput {
    pub adapter_context: Value,
    pub runtime_metadata: Option<Value>,
    pub captured_request: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessDecisionContextSignals {
    pub port_stop_message_disabled: bool,
    pub has_responses_submit_tool_outputs_resume: bool,
    pub plan_mode_active: bool,
}

pub fn plan_stopless_decision_context_signals(
    input: &StoplessDecisionContextSignalsInput,
) -> StoplessDecisionContextSignals {
    let metadata = input
        .adapter_context
        .get("metadata")
        .filter(|value| value.is_object());
    StoplessDecisionContextSignals {
        port_stop_message_disabled: has_disabled_port_signal(
            &input.adapter_context,
            metadata,
            input.runtime_metadata.as_ref(),
        ),
        has_responses_submit_tool_outputs_resume: has_responses_submit_tool_outputs_resume(
            &input.adapter_context,
            metadata,
            input.runtime_metadata.as_ref(),
        ),
        plan_mode_active: is_plan_mode_active(input.captured_request.as_ref()),
    }
}

fn has_disabled_port_signal(
    adapter_context: &Value,
    metadata: Option<&Value>,
    runtime_metadata: Option<&Value>,
) -> bool {
    [
        adapter_context.get("stopMessageEnabled"),
        metadata.and_then(|row| row.get("stopMessageEnabled")),
        runtime_metadata.and_then(|row| row.get("stopMessagePortEnabled")),
        runtime_metadata.and_then(|row| row.get("stopMessageEnabled")),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.as_bool() == Some(false))
}

fn has_responses_submit_tool_outputs_resume(
    adapter_context: &Value,
    metadata: Option<&Value>,
    runtime_metadata: Option<&Value>,
) -> bool {
    [
        adapter_context.get("responsesResume"),
        metadata.and_then(|row| row.get("responsesResume")),
        runtime_metadata.and_then(|row| row.get("responsesResume")),
    ]
    .into_iter()
    .flatten()
    .any(resume_has_tool_outputs)
}

fn resume_has_tool_outputs(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|record| record.get("toolOutputsDetailed"))
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
}

fn is_plan_mode_active(captured_request: Option<&Value>) -> bool {
    let Some(captured_request) = captured_request else {
        return false;
    };
    let Ok(text) = serde_json::to_string(captured_request) else {
        return false;
    };
    let lower = text.to_lowercase();
    lower.contains("<collaboration_mode>")
        && lower.contains("collaboration mode: plan")
        && !lower.contains("collaboration mode: default")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_submit_resume_and_port_disable_from_metadata_carriers() {
        let plan = plan_stopless_decision_context_signals(&StoplessDecisionContextSignalsInput {
            adapter_context: json!({
                "metadata": {
                    "stopMessageEnabled": false,
                    "responsesResume": {
                        "toolOutputsDetailed": [{ "tool_call_id": "call_1" }]
                    }
                }
            }),
            runtime_metadata: None,
            captured_request: None,
        });

        assert!(plan.port_stop_message_disabled);
        assert!(plan.has_responses_submit_tool_outputs_resume);
        assert!(!plan.plan_mode_active);
    }

    #[test]
    fn detects_plan_mode_from_captured_request_only() {
        let plan = plan_stopless_decision_context_signals(&StoplessDecisionContextSignalsInput {
            adapter_context: json!({}),
            runtime_metadata: Some(json!({ "stopMessageEnabled": true })),
            captured_request: Some(json!({
                "system": "<collaboration_mode># Collaboration Mode: Plan\n</collaboration_mode>"
            })),
        });

        assert!(!plan.port_stop_message_disabled);
        assert!(!plan.has_responses_submit_tool_outputs_resume);
        assert!(plan.plan_mode_active);
    }

    #[test]
    fn default_mode_suppresses_plan_mode_signal() {
        let plan = plan_stopless_decision_context_signals(&StoplessDecisionContextSignalsInput {
            adapter_context: json!({}),
            runtime_metadata: None,
            captured_request: Some(json!({
                "system": "<collaboration_mode># Collaboration Mode: Plan\n# Collaboration Mode: Default</collaboration_mode>"
            })),
        });

        assert!(!plan.plan_mode_active);
    }
}
