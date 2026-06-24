// feature_id: hub.servertool_engine_skip_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineSkipInput {
    pub engine_mode: String,
    pub has_execution: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolEngineSkipAction {
    ReturnSkippedPassthrough,
    ReturnSkippedNoExecution,
    ContinueMatchedFlow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineSkipPlan {
    pub action: ServertoolEngineSkipAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
}

pub fn plan_servertool_engine_skip(input: ServertoolEngineSkipInput) -> ServertoolEngineSkipPlan {
    if input.engine_mode.trim() == "passthrough" {
        return ServertoolEngineSkipPlan {
            action: ServertoolEngineSkipAction::ReturnSkippedPassthrough,
            skip_reason: Some("passthrough".to_string()),
        };
    }
    if !input.has_execution {
        return ServertoolEngineSkipPlan {
            action: ServertoolEngineSkipAction::ReturnSkippedNoExecution,
            skip_reason: Some("no_execution".to_string()),
        };
    }
    ServertoolEngineSkipPlan {
        action: ServertoolEngineSkipAction::ContinueMatchedFlow,
        skip_reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_passthrough_skip() {
        let plan = plan_servertool_engine_skip(ServertoolEngineSkipInput {
            engine_mode: "passthrough".to_string(),
            has_execution: false,
        });
        assert_eq!(
            plan.action,
            ServertoolEngineSkipAction::ReturnSkippedPassthrough
        );
        assert_eq!(plan.skip_reason.as_deref(), Some("passthrough"));
    }

    #[test]
    fn returns_no_execution_skip() {
        let plan = plan_servertool_engine_skip(ServertoolEngineSkipInput {
            engine_mode: "tool_flow".to_string(),
            has_execution: false,
        });
        assert_eq!(
            plan.action,
            ServertoolEngineSkipAction::ReturnSkippedNoExecution
        );
        assert_eq!(plan.skip_reason.as_deref(), Some("no_execution"));
    }

    #[test]
    fn continues_when_execution_exists() {
        let plan = plan_servertool_engine_skip(ServertoolEngineSkipInput {
            engine_mode: "tool_flow".to_string(),
            has_execution: true,
        });
        assert_eq!(plan.action, ServertoolEngineSkipAction::ContinueMatchedFlow);
        assert_eq!(plan.skip_reason, None);
    }
}
