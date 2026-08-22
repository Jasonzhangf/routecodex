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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineSkipApplicationInput {
    pub skip_plan: ServertoolEngineSkipPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineSkipApplicationPlan {
    pub return_skipped: bool,
    pub continue_matched_flow: bool,
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

pub fn plan_servertool_engine_skip_application(
    input: ServertoolEngineSkipApplicationInput,
) -> Result<ServertoolEngineSkipApplicationPlan, String> {
    match input.skip_plan.action {
        ServertoolEngineSkipAction::ReturnSkippedPassthrough
        | ServertoolEngineSkipAction::ReturnSkippedNoExecution => {
            let skip_reason = input
                .skip_plan
                .skip_reason
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "skipped engine plan missing skip reason".to_string())?;
            let trigger_result = input
                .skip_plan
                .trigger_result
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "skipped engine plan missing trigger result".to_string())?;
            let shell_result = input
                .skip_plan
                .shell_result
                .ok_or_else(|| "skipped engine plan missing shell result".to_string())?;
            Ok(ServertoolEngineSkipApplicationPlan {
                return_skipped: true,
                continue_matched_flow: false,
                skip_reason: Some(skip_reason),
                trigger_result: Some(trigger_result),
                shell_result: Some(shell_result),
            })
        }
        ServertoolEngineSkipAction::ContinueMatchedFlow => {
            Ok(ServertoolEngineSkipApplicationPlan {
                return_skipped: false,
                continue_matched_flow: true,
                skip_reason: None,
                trigger_result: None,
                shell_result: None,
            })
        }
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

    #[test]
    fn application_returns_skipped_plan() {
        let skip_plan = plan_servertool_engine_skip(ServertoolEngineSkipInput {
            engine_mode: "passthrough".to_string(),
            has_execution: false,
            final_chat_response: Some(serde_json::json!({ "id": "passthrough" })),
        });
        let application =
            plan_servertool_engine_skip_application(ServertoolEngineSkipApplicationInput {
                skip_plan,
            })
            .expect("skip application");

        assert_eq!(application.return_skipped, true);
        assert_eq!(application.continue_matched_flow, false);
        assert_eq!(application.skip_reason.as_deref(), Some("passthrough"));
        assert_eq!(
            application.trigger_result.as_deref(),
            Some("skipped_passthrough")
        );
    }

    #[test]
    fn application_continues_matched_flow() {
        let application =
            plan_servertool_engine_skip_application(ServertoolEngineSkipApplicationInput {
                skip_plan: ServertoolEngineSkipPlan {
                    action: ServertoolEngineSkipAction::ContinueMatchedFlow,
                    skip_reason: None,
                    trigger_result: None,
                    shell_result: None,
                },
            })
            .expect("skip application");

        assert_eq!(application.return_skipped, false);
        assert_eq!(application.continue_matched_flow, true);
    }

    #[test]
    fn application_rejects_incomplete_skipped_plan() {
        let err = plan_servertool_engine_skip_application(ServertoolEngineSkipApplicationInput {
            skip_plan: ServertoolEngineSkipPlan {
                action: ServertoolEngineSkipAction::ReturnSkippedNoExecution,
                skip_reason: None,
                trigger_result: Some("skipped_no_execution".to_string()),
                shell_result: Some(serde_json::json!({ "chat": {}, "executed": false })),
            },
        })
        .expect_err("incomplete skipped plan must fail");

        assert!(err.contains("missing skip reason"));
    }
}
