// feature_id: hub.servertool_engine_skip_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineSkipInput {
    pub engine_mode: String,
    pub has_execution: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_chat_response: Option<serde_json::Value>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_result: Option<serde_json::Value>,
}

pub fn plan_servertool_engine_skip(input: ServertoolEngineSkipInput) -> ServertoolEngineSkipPlan {
    if input.engine_mode.trim() == "passthrough" {
        let skip_reason = "passthrough".to_string();
        return ServertoolEngineSkipPlan {
            action: ServertoolEngineSkipAction::ReturnSkippedPassthrough,
            skip_reason: Some(skip_reason.clone()),
            trigger_result: Some(format!("skipped_{skip_reason}")),
            shell_result: Some(serde_json::json!({
                "chat": input.final_chat_response.unwrap_or(serde_json::Value::Null),
                "executed": false
            })),
        };
    }
    if !input.has_execution {
        let skip_reason = "no_execution".to_string();
        return ServertoolEngineSkipPlan {
            action: ServertoolEngineSkipAction::ReturnSkippedNoExecution,
            skip_reason: Some(skip_reason.clone()),
            trigger_result: Some(format!("skipped_{skip_reason}")),
            shell_result: Some(serde_json::json!({
                "chat": input.final_chat_response.unwrap_or(serde_json::Value::Null),
                "executed": false
            })),
        };
    }
    ServertoolEngineSkipPlan {
        action: ServertoolEngineSkipAction::ContinueMatchedFlow,
        skip_reason: None,
        trigger_result: None,
        shell_result: None,
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
            final_chat_response: Some(serde_json::json!({ "id": "passthrough" })),
        });
        assert_eq!(
            plan.action,
            ServertoolEngineSkipAction::ReturnSkippedPassthrough
        );
        assert_eq!(plan.skip_reason.as_deref(), Some("passthrough"));
        assert_eq!(plan.trigger_result.as_deref(), Some("skipped_passthrough"));
        assert_eq!(
            plan.shell_result,
            Some(serde_json::json!({
                "chat": { "id": "passthrough" },
                "executed": false
            }))
        );
    }

    #[test]
    fn returns_no_execution_skip() {
        let plan = plan_servertool_engine_skip(ServertoolEngineSkipInput {
            engine_mode: "tool_flow".to_string(),
            has_execution: false,
            final_chat_response: Some(serde_json::json!({ "id": "no_execution" })),
        });
        assert_eq!(
            plan.action,
            ServertoolEngineSkipAction::ReturnSkippedNoExecution
        );
        assert_eq!(plan.skip_reason.as_deref(), Some("no_execution"));
        assert_eq!(plan.trigger_result.as_deref(), Some("skipped_no_execution"));
        assert_eq!(
            plan.shell_result,
            Some(serde_json::json!({
                "chat": { "id": "no_execution" },
                "executed": false
            }))
        );
    }

    #[test]
    fn continues_when_execution_exists() {
        let plan = plan_servertool_engine_skip(ServertoolEngineSkipInput {
            engine_mode: "tool_flow".to_string(),
            has_execution: true,
            final_chat_response: Some(serde_json::json!({ "id": "matched" })),
        });
        assert_eq!(plan.action, ServertoolEngineSkipAction::ContinueMatchedFlow);
        assert_eq!(plan.skip_reason, None);
        assert_eq!(plan.trigger_result, None);
        assert_eq!(plan.shell_result, None);
    }
}
