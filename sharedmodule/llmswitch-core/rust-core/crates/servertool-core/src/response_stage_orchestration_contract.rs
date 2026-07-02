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
pub struct ServertoolResponseStageOrchestrationMaterializeInput {
    pub original_payload: serde_json::Value,
    pub executed_payload: serde_json::Value,
    pub orchestration_executed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orchestration_flow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStageOrchestrationMaterializedOutput {
    pub payload: serde_json::Value,
    pub executed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    pub returned_executed_payload: bool,
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
            ServertoolResponseStageOrchestrationMaterializedOutput {
                payload: input.executed_payload,
                executed: plan.record_executed,
                flow_id: plan.record_flow_id,
                returned_executed_payload: true,
            }
        }
        ServertoolResponseStageOrchestrationReturnAction::ReturnOriginalPayload => {
            ServertoolResponseStageOrchestrationMaterializedOutput {
                payload: input.original_payload,
                executed: plan.record_executed,
                flow_id: plan.record_flow_id,
                returned_executed_payload: false,
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
    fn materializes_executed_payload_when_orchestration_executed() {
        let output = materialize_servertool_response_stage_orchestration_output(
            ServertoolResponseStageOrchestrationMaterializeInput {
                original_payload: serde_json::json!({ "id": "original" }),
                executed_payload: serde_json::json!({ "id": "executed" }),
                orchestration_executed: true,
                orchestration_flow_id: Some(" flow_1 ".to_string()),
            },
        );

        assert_eq!(output.payload, serde_json::json!({ "id": "executed" }));
        assert_eq!(output.executed, true);
        assert_eq!(output.flow_id.as_deref(), Some("flow_1"));
        assert_eq!(output.returned_executed_payload, true);
    }

    #[test]
    fn materializes_original_payload_when_orchestration_did_not_execute() {
        let output = materialize_servertool_response_stage_orchestration_output(
            ServertoolResponseStageOrchestrationMaterializeInput {
                original_payload: serde_json::json!({ "id": "original" }),
                executed_payload: serde_json::json!({ "id": "ignored" }),
                orchestration_executed: false,
                orchestration_flow_id: Some("ignored".to_string()),
            },
        );

        assert_eq!(output.payload, serde_json::json!({ "id": "original" }));
        assert_eq!(output.executed, false);
        assert_eq!(output.flow_id, None);
        assert_eq!(output.returned_executed_payload, false);
    }
}
