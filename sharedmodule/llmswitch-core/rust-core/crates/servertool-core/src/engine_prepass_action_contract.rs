// feature_id: hub.servertool_engine_prepass_action_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEnginePrepassActionInput {
    pub has_prepass_result: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepass_result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolEnginePrepassAction {
    ReturnPrepassResult,
    ContinueToExecution,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEnginePrepassActionPlan {
    pub action: ServertoolEnginePrepassAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

pub fn plan_servertool_engine_prepass_action(
    input: ServertoolEnginePrepassActionInput,
) -> ServertoolEnginePrepassActionPlan {
    if input.has_prepass_result {
        return ServertoolEnginePrepassActionPlan {
            action: ServertoolEnginePrepassAction::ReturnPrepassResult,
            result: input.prepass_result,
        };
    }
    ServertoolEnginePrepassActionPlan {
        action: ServertoolEnginePrepassAction::ContinueToExecution,
        result: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        plan_servertool_engine_prepass_action, ServertoolEnginePrepassAction,
        ServertoolEnginePrepassActionInput,
    };

    #[test]
    fn returns_prepass_result_when_present() {
        let plan = plan_servertool_engine_prepass_action(ServertoolEnginePrepassActionInput {
            has_prepass_result: true,
            prepass_result: Some(serde_json::json!({
                "mode": "passthrough",
                "finalChatResponse": { "id": "prepass" }
            })),
        });
        assert_eq!(plan.action, ServertoolEnginePrepassAction::ReturnPrepassResult);
        assert_eq!(
            plan.result,
            Some(serde_json::json!({
                "mode": "passthrough",
                "finalChatResponse": { "id": "prepass" }
            }))
        );
    }

    #[test]
    fn continues_to_execution_when_prepass_has_no_result() {
        let plan = plan_servertool_engine_prepass_action(ServertoolEnginePrepassActionInput {
            has_prepass_result: false,
            prepass_result: None,
        });
        assert_eq!(plan.action, ServertoolEnginePrepassAction::ContinueToExecution);
        assert_eq!(plan.result, None);
    }
}
