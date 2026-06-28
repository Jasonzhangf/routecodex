use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessDecisionContextSignalsInput {
    pub runtime_metadata: Option<Value>,
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
    let metadata = resolve_metadata_carrier(input.runtime_metadata.as_ref());
    StoplessDecisionContextSignals {
        port_stop_message_disabled: has_disabled_port_signal(metadata),
        has_responses_submit_tool_outputs_resume: has_responses_submit_tool_outputs_resume(
            metadata,
        ),
        plan_mode_active: false,
    }
}

fn resolve_metadata_carrier(runtime_metadata: Option<&Value>) -> Option<&Value> {
    runtime_metadata.filter(|value| value.is_object())
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
        .and_then(find_responses_resume_carrier)
        .is_some_and(resume_has_tool_outputs)
}

fn find_responses_resume_carrier(carrier: &Value) -> Option<&Value> {
    carrier
        .get("responsesResume")
        .or_else(|| {
            carrier
                .get("metadataCenterSnapshot")
                .and_then(|snapshot| snapshot.get("continuationContext"))
                .and_then(|continuation| continuation.get("responsesResume"))
        })
        .or_else(|| {
            carrier
                .get("metadata")
                .and_then(|metadata| metadata.get("metadataCenterSnapshot"))
                .and_then(|snapshot| snapshot.get("continuationContext"))
                .and_then(|continuation| continuation.get("responsesResume"))
        })
}

fn resume_has_tool_outputs(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|record| record.get("toolOutputsDetailed"))
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_submit_resume_and_port_disable_from_metadata_carriers() {
        let plan = plan_stopless_decision_context_signals(&StoplessDecisionContextSignalsInput {
            runtime_metadata: Some(json!({
                "runtime_control": {
                    "stopMessageEnabled": false
                },
                "responsesResume": {
                    "toolOutputsDetailed": [{ "tool_call_id": "call_1" }]
                }
            })),
        });

        assert!(plan.port_stop_message_disabled);
        assert!(plan.has_responses_submit_tool_outputs_resume);
        assert!(!plan.plan_mode_active);
    }

    #[test]
    fn prefers_metadata_center_snapshot_stop_message_signal_over_flat_metadata() {
        let plan = plan_stopless_decision_context_signals(&StoplessDecisionContextSignalsInput {
            runtime_metadata: Some(json!({
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
            })),
        });

        assert!(plan.port_stop_message_disabled);
    }

    #[test]
    fn reads_submit_resume_from_metadata_center_continuation_context() {
        let plan = plan_stopless_decision_context_signals(&StoplessDecisionContextSignalsInput {
            runtime_metadata: Some(json!({
                "metadataCenterSnapshot": {
                    "continuationContext": {
                        "responsesResume": {
                            "toolOutputsDetailed": [{ "tool_call_id": "call_1" }]
                        }
                    }
                }
            })),
        });

        assert!(plan.has_responses_submit_tool_outputs_resume);
    }

    #[test]
    fn does_not_derive_plan_mode_from_request_context() {
        let plan = plan_stopless_decision_context_signals(&StoplessDecisionContextSignalsInput {
            runtime_metadata: Some(json!({ "stopMessageEnabled": true })),
        });

        assert!(!plan.port_stop_message_disabled);
        assert!(!plan.has_responses_submit_tool_outputs_resume);
        assert!(!plan.plan_mode_active);
    }

    #[test]
    fn runtime_metadata_carrier_still_works_without_adapter_context() {
        let plan = plan_stopless_decision_context_signals(&StoplessDecisionContextSignalsInput {
            runtime_metadata: Some(json!({
                "runtime_control": {
                    "stopMessageEnabled": false
                },
                "responsesResume": {
                    "toolOutputsDetailed": [{ "tool_call_id": "call_runtime" }]
                }
            })),
        });

        assert!(plan.port_stop_message_disabled);
        assert!(plan.has_responses_submit_tool_outputs_resume);
    }

    #[test]
    fn plan_mode_signal_requires_metadata_center_control_not_context_text() {
        let plan = plan_stopless_decision_context_signals(&StoplessDecisionContextSignalsInput {
            runtime_metadata: None,
        });

        assert!(!plan.plan_mode_active);
    }
}
