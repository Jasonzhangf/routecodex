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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRunEnginePrepassApplicationInput {
    pub decision: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRunEnginePrepassApplicationPlan {
    pub return_result: bool,
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

pub fn plan_servertool_run_engine_prepass_application(
    input: ServertoolRunEnginePrepassApplicationInput,
) -> Result<ServertoolRunEnginePrepassApplicationPlan, String> {
    let decision = input
        .decision
        .as_object()
        .ok_or_else(|| "servertool run-engine prepass decision must be an object".to_string())?;
    let action = decision
        .get("action")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "servertool run-engine prepass decision missing action".to_string())?;

    match action {
        "return_result" => {
            let result = decision.get("result").cloned().ok_or_else(|| {
                "servertool run-engine prepass decision missing result".to_string()
            })?;
            Ok(ServertoolRunEnginePrepassApplicationPlan {
                return_result: true,
                result: Some(result),
            })
        }
        "continue_to_execution" => Ok(ServertoolRunEnginePrepassApplicationPlan {
            return_result: false,
            result: None,
        }),
        _ => Err(format!(
            "invalid servertool run-engine prepass decision action: {action}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        plan_servertool_engine_prepass_action, plan_servertool_run_engine_prepass_application,
        ServertoolEnginePrepassAction, ServertoolEnginePrepassActionInput,
        ServertoolRunEnginePrepassApplicationInput,
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
        assert_eq!(
            plan.action,
            ServertoolEnginePrepassAction::ReturnPrepassResult
        );
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
        assert_eq!(
            plan.action,
            ServertoolEnginePrepassAction::ContinueToExecution
        );
        assert_eq!(plan.result, None);
    }

    #[test]
    fn run_engine_prepass_application_returns_result() {
        let result = serde_json::json!({
            "mode": "passthrough",
            "finalChatResponse": { "id": "prepass" }
        });
        let plan = plan_servertool_run_engine_prepass_application(
            ServertoolRunEnginePrepassApplicationInput {
                decision: serde_json::json!({
                    "action": "return_result",
                    "result": result
                }),
            },
        )
        .expect("run-engine prepass application plan");

        assert!(plan.return_result);
        assert_eq!(plan.result, Some(result));
    }

    #[test]
    fn run_engine_prepass_application_continues_to_execution() {
        let plan = plan_servertool_run_engine_prepass_application(
            ServertoolRunEnginePrepassApplicationInput {
                decision: serde_json::json!({
                    "action": "continue_to_execution"
                }),
            },
        )
        .expect("run-engine prepass application plan");

        assert!(!plan.return_result);
        assert_eq!(plan.result, None);
    }

    #[test]
    fn run_engine_prepass_application_rejects_unknown_action() {
        let err = plan_servertool_run_engine_prepass_application(
            ServertoolRunEnginePrepassApplicationInput {
                decision: serde_json::json!({ "action": "unknown" }),
            },
        )
        .expect_err("unknown action must fail");

        assert!(err.contains("invalid servertool run-engine prepass decision action"));
    }
}
