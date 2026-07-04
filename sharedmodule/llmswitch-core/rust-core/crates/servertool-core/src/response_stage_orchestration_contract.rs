// feature_id: hub.servertool_response_stage_runtime_action_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStageOrchestrationOutputInput {
    pub orchestration_executed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orchestration_flow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolResponseStageOrchestrationReturnAction {
    ReturnExecutedPayload,
    ReturnOriginalPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStageOrchestrationOutputPlan {
    pub return_action: ServertoolResponseStageOrchestrationReturnAction,
    pub record_executed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_flow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStageOrchestrationGateApplicationInput {
    pub runtime_action: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStageOrchestrationGateApplicationPlan {
    pub bypass: bool,
    pub run_orchestration: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStageOrchestrationMaterializeInput {
    pub original_payload: serde_json::Value,
    pub executed_payload: serde_json::Value,
    pub orchestration_executed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orchestration_flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_shape: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_shape: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStageOrchestrationMaterializedOutput {
    pub payload: serde_json::Value,
    pub executed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    pub returned_executed_payload: bool,
    pub shell_result: serde_json::Value,
    pub record_event: serde_json::Value,
}

pub fn plan_servertool_response_stage_orchestration_output(
    input: ServertoolResponseStageOrchestrationOutputInput,
) -> ServertoolResponseStageOrchestrationOutputPlan {
    if input.orchestration_executed {
        let flow_id = input
            .orchestration_flow_id
            .as_deref()
            .unwrap_or_default()
            .trim();
        return ServertoolResponseStageOrchestrationOutputPlan {
            return_action: ServertoolResponseStageOrchestrationReturnAction::ReturnExecutedPayload,
            record_executed: true,
            record_flow_id: if flow_id.is_empty() {
                None
            } else {
                Some(flow_id.to_string())
            },
        };
    }

    ServertoolResponseStageOrchestrationOutputPlan {
        return_action: ServertoolResponseStageOrchestrationReturnAction::ReturnOriginalPayload,
        record_executed: false,
        record_flow_id: None,
    }
}

pub fn plan_servertool_response_stage_orchestration_gate_application(
    input: ServertoolResponseStageOrchestrationGateApplicationInput,
) -> Result<ServertoolResponseStageOrchestrationGateApplicationPlan, String> {
    let runtime_action = input
        .runtime_action
        .as_object()
        .ok_or_else(|| "runtime action must be an object".to_string())?;
    let action = runtime_action
        .get("action")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "runtime action missing action".to_string())?;

    match action {
        "return_passthrough_bypass" => {
            let skip_reason = runtime_action
                .get("skipReason")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            Ok(ServertoolResponseStageOrchestrationGateApplicationPlan {
                bypass: true,
                run_orchestration: false,
                skip_reason,
            })
        }
        "run_auto_hooks" => Ok(ServertoolResponseStageOrchestrationGateApplicationPlan {
            bypass: false,
            run_orchestration: true,
            skip_reason: None,
        }),
        other => Err(format!(
            "unsupported response stage orchestration gate runtime action: {other}"
        )),
    }
}

pub fn materialize_servertool_response_stage_orchestration_output(
    input: ServertoolResponseStageOrchestrationMaterializeInput,
) -> ServertoolResponseStageOrchestrationMaterializedOutput {
    let plan = plan_servertool_response_stage_orchestration_output(
        ServertoolResponseStageOrchestrationOutputInput {
            orchestration_executed: input.orchestration_executed,
            orchestration_flow_id: input.orchestration_flow_id,
        },
    );

    match plan.return_action {
        ServertoolResponseStageOrchestrationReturnAction::ReturnExecutedPayload => {
            let mut shell_result = serde_json::json!({
                "payload": input.executed_payload.clone(),
                "executed": plan.record_executed
            });
            if let Some(flow_id) = plan.record_flow_id.clone() {
                shell_result["flowId"] = serde_json::Value::String(flow_id);
            }

            let mut record_event = serde_json::json!({
                "executed": plan.record_executed
            });
            if let Some(flow_id) = plan.record_flow_id.clone() {
                record_event["flowId"] = serde_json::Value::String(flow_id);
            }
            if let Some(input_shape) = input.input_shape.clone() {
                record_event["inputShape"] = serde_json::Value::String(input_shape);
            }
            if let Some(output_shape) = input.output_shape.clone() {
                record_event["outputShape"] = serde_json::Value::String(output_shape);
            }

            ServertoolResponseStageOrchestrationMaterializedOutput {
                payload: input.executed_payload,
                executed: plan.record_executed,
                flow_id: plan.record_flow_id,
                returned_executed_payload: true,
                shell_result,
                record_event,
            }
        }
        ServertoolResponseStageOrchestrationReturnAction::ReturnOriginalPayload => {
            let mut record_event = serde_json::json!({
                "executed": plan.record_executed
            });
            if let Some(input_shape) = input.input_shape.clone() {
                record_event["inputShape"] = serde_json::Value::String(input_shape);
            }

            ServertoolResponseStageOrchestrationMaterializedOutput {
                payload: input.original_payload.clone(),
                executed: plan.record_executed,
                flow_id: plan.record_flow_id,
                returned_executed_payload: false,
                shell_result: serde_json::json!({
                    "payload": input.original_payload,
                    "executed": plan.record_executed
                }),
                record_event,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_executed_payload_and_trims_flow_id_when_orchestration_executed() {
        let plan = plan_servertool_response_stage_orchestration_output(
            ServertoolResponseStageOrchestrationOutputInput {
                orchestration_executed: true,
                orchestration_flow_id: Some(" flow_1 ".to_string()),
            },
        );

        assert_eq!(
            plan.return_action,
            ServertoolResponseStageOrchestrationReturnAction::ReturnExecutedPayload
        );
        assert_eq!(plan.record_executed, true);
        assert_eq!(plan.record_flow_id.as_deref(), Some("flow_1"));
    }

    #[test]
    fn returns_original_payload_when_orchestration_did_not_execute() {
        let plan = plan_servertool_response_stage_orchestration_output(
            ServertoolResponseStageOrchestrationOutputInput {
                orchestration_executed: false,
                orchestration_flow_id: Some("flow_ignored".to_string()),
            },
        );

        assert_eq!(
            plan.return_action,
            ServertoolResponseStageOrchestrationReturnAction::ReturnOriginalPayload
        );
        assert_eq!(plan.record_executed, false);
        assert_eq!(plan.record_flow_id, None);
    }

    #[test]
    fn gate_application_bypasses_with_trimmed_skip_reason() {
        let plan = plan_servertool_response_stage_orchestration_gate_application(
            ServertoolResponseStageOrchestrationGateApplicationInput {
                runtime_action: serde_json::json!({
                    "action": "return_passthrough_bypass",
                    "skipReason": " empty_assistant_payload "
                }),
            },
        )
        .expect("gate application plan");

        assert_eq!(
            plan,
            ServertoolResponseStageOrchestrationGateApplicationPlan {
                bypass: true,
                run_orchestration: false,
                skip_reason: Some("empty_assistant_payload".to_string())
            }
        );
    }

    #[test]
    fn gate_application_runs_orchestration_for_auto_hooks() {
        let plan = plan_servertool_response_stage_orchestration_gate_application(
            ServertoolResponseStageOrchestrationGateApplicationInput {
                runtime_action: serde_json::json!({
                    "action": "run_auto_hooks"
                }),
            },
        )
        .expect("gate application plan");

        assert_eq!(
            plan,
            ServertoolResponseStageOrchestrationGateApplicationPlan {
                bypass: false,
                run_orchestration: true,
                skip_reason: None
            }
        );
    }

    #[test]
    fn gate_application_rejects_unknown_action() {
        let err = plan_servertool_response_stage_orchestration_gate_application(
            ServertoolResponseStageOrchestrationGateApplicationInput {
                runtime_action: serde_json::json!({
                    "action": "return_auto_hook_result"
                }),
            },
        )
        .expect_err("unknown action must fail");

        assert!(err.contains("unsupported response stage orchestration gate runtime action"));
    }

    #[test]
    fn gate_application_rejects_missing_action() {
        let err = plan_servertool_response_stage_orchestration_gate_application(
            ServertoolResponseStageOrchestrationGateApplicationInput {
                runtime_action: serde_json::json!({}),
            },
        )
        .expect_err("missing action must fail");

        assert!(err.contains("runtime action missing action"));
    }

    #[test]
    fn materializes_executed_payload_when_orchestration_executed() {
        let output = materialize_servertool_response_stage_orchestration_output(
            ServertoolResponseStageOrchestrationMaterializeInput {
                original_payload: serde_json::json!({ "id": "original" }),
                executed_payload: serde_json::json!({ "id": "executed" }),
                orchestration_executed: true,
                orchestration_flow_id: Some(" flow_1 ".to_string()),
                input_shape: Some("chat_completion".to_string()),
                output_shape: Some("responses".to_string()),
            },
        );

        assert_eq!(output.payload, serde_json::json!({ "id": "executed" }));
        assert_eq!(output.executed, true);
        assert_eq!(output.flow_id.as_deref(), Some("flow_1"));
        assert_eq!(output.returned_executed_payload, true);
        assert_eq!(
            output.shell_result,
            serde_json::json!({
                "payload": { "id": "executed" },
                "executed": true,
                "flowId": "flow_1"
            })
        );
        assert_eq!(
            output.record_event,
            serde_json::json!({
                "executed": true,
                "flowId": "flow_1",
                "inputShape": "chat_completion",
                "outputShape": "responses"
            })
        );
    }

    #[test]
    fn materializes_original_payload_when_orchestration_did_not_execute() {
        let output = materialize_servertool_response_stage_orchestration_output(
            ServertoolResponseStageOrchestrationMaterializeInput {
                original_payload: serde_json::json!({ "id": "original" }),
                executed_payload: serde_json::json!({ "id": "ignored" }),
                orchestration_executed: false,
                orchestration_flow_id: Some("ignored".to_string()),
                input_shape: Some("chat_completion".to_string()),
                output_shape: None,
            },
        );

        assert_eq!(output.payload, serde_json::json!({ "id": "original" }));
        assert_eq!(output.executed, false);
        assert_eq!(output.flow_id, None);
        assert_eq!(output.returned_executed_payload, false);
        assert_eq!(
            output.shell_result,
            serde_json::json!({
                "payload": { "id": "original" },
                "executed": false
            })
        );
        assert_eq!(
            output.record_event,
            serde_json::json!({
                "executed": false,
                "inputShape": "chat_completion"
            })
        );
    }
}
