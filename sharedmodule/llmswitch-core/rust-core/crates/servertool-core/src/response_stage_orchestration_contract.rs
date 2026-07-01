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
}
