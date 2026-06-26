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
    let metadata = resolve_metadata_carrier(&input.adapter_context);
    StoplessDecisionContextSignals {
        port_stop_message_disabled: has_disabled_port_signal(metadata),
        has_responses_submit_tool_outputs_resume: has_responses_submit_tool_outputs_resume(metadata),
        plan_mode_active: is_plan_mode_active(input.captured_request.as_ref()),
    }
}

fn resolve_metadata_carrier(adapter_context: &Value) -> Option<&Value> {
    adapter_context
        .get("metadata")
        .filter(|value| value.is_object())
        .or_else(|| adapter_context.is_object().then_some(adapter_context))
}

fn has_disabled_port_signal(metadata: Option<&Value>) -> bool {
    [
        metadata
            .and_then(|row| row.get("metadataCenterSnapshot"))
            .and_then(|snapshot| snapshot.get("runtimeControl"))
            .and_then(|runtime_control| runtime_control.get("stopMessage"))
            .and_then(|stop_message| stop_message.get("enabled")),
        metadata
            .and_then(|row| row.get("runtime_control"))
            .and_then(|runtime_control| runtime_control.get("stopMessageEnabled")),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.as_bool() == Some(false))
}

fn has_responses_submit_tool_outputs_resume(metadata: Option<&Value>) -> bool {
    metadata
        .and_then(|row| row.get("responsesResume"))
        .is_some_and(resume_has_tool_outputs)
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
                "runtime_control": {
                    "stopMessageEnabled": false
                },
                "responsesResume": {
                    "toolOutputsDetailed": [{ "tool_call_id": "call_1" }]
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
    fn prefers_metadata_center_snapshot_stop_message_signal_over_flat_metadata() {
        let plan = plan_stopless_decision_context_signals(&StoplessDecisionContextSignalsInput {
            adapter_context: json!({
                "runtime_control": {
                    "stopMessageEnabled": true
                },
                "metadataCenterSnapshot": {
                    "runtimeControl": {
                        "stopMessage": {
                            "enabled": false
                        }
                    }
                }
            }),
            runtime_metadata: None,
            captured_request: None,
        });

        assert!(plan.port_stop_message_disabled);
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
    fn nested_metadata_carrier_still_works_for_transition_contexts() {
        let plan = plan_stopless_decision_context_signals(&StoplessDecisionContextSignalsInput {
            adapter_context: json!({
                "metadata": {
                    "runtime_control": {
                        "stopMessageEnabled": false
                    },
                    "responsesResume": {
                        "toolOutputsDetailed": [{ "tool_call_id": "call_nested" }]
                    }
                }
            }),
            runtime_metadata: Some(json!({
                "stopMessageEnabled": true,
                "responsesResume": {
                    "toolOutputsDetailed": [{ "tool_call_id": "call_ignored_runtime" }]
                }
            })),
            captured_request: None,
        });

        assert!(plan.port_stop_message_disabled);
        assert!(plan.has_responses_submit_tool_outputs_resume);
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
