// feature_id: hub.servertool_response_stage_runtime_action_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolEngineOrchestrationPreflightKind {
    ReturnOriginalChat,
    ReturnOriginalChatDirectPassthrough,
    Continue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineOrchestrationPreflightActionInput {
    pub preflight_kind: ServertoolEngineOrchestrationPreflightKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolEngineOrchestrationPreflightAction {
    ReturnPreflightChat,
    ContinueEngine,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineOrchestrationPreflightActionPlan {
    pub action: ServertoolEngineOrchestrationPreflightAction,
}

pub fn plan_servertool_engine_orchestration_preflight_action(
    input: ServertoolEngineOrchestrationPreflightActionInput,
) -> ServertoolEngineOrchestrationPreflightActionPlan {
    let action = match input.preflight_kind {
        ServertoolEngineOrchestrationPreflightKind::ReturnOriginalChat
        | ServertoolEngineOrchestrationPreflightKind::ReturnOriginalChatDirectPassthrough => {
            ServertoolEngineOrchestrationPreflightAction::ReturnPreflightChat
        }
        ServertoolEngineOrchestrationPreflightKind::Continue => {
            ServertoolEngineOrchestrationPreflightAction::ContinueEngine
        }
    };
    ServertoolEngineOrchestrationPreflightActionPlan { action }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_preflight_chat_for_early_return_kinds() {
        for preflight_kind in [
            ServertoolEngineOrchestrationPreflightKind::ReturnOriginalChat,
            ServertoolEngineOrchestrationPreflightKind::ReturnOriginalChatDirectPassthrough,
        ] {
            let plan = plan_servertool_engine_orchestration_preflight_action(
                ServertoolEngineOrchestrationPreflightActionInput { preflight_kind },
            );
            assert_eq!(
                plan.action,
                ServertoolEngineOrchestrationPreflightAction::ReturnPreflightChat
            );
        }
    }

    #[test]
    fn continues_engine_for_continue_preflight_kind() {
        let plan = plan_servertool_engine_orchestration_preflight_action(
            ServertoolEngineOrchestrationPreflightActionInput {
                preflight_kind: ServertoolEngineOrchestrationPreflightKind::Continue,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolEngineOrchestrationPreflightAction::ContinueEngine
        );
    }
}
