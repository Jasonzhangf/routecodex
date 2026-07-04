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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineOrchestrationPreflightApplicationInput {
    pub action_plan: ServertoolEngineOrchestrationPreflightActionPlan,
    pub preflight_kind: ServertoolEngineOrchestrationPreflightKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_signal: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineOrchestrationPreflightApplicationPlan {
    pub return_preflight_chat: bool,
    pub continue_engine: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_signal: Option<serde_json::Value>,
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

pub fn plan_servertool_engine_orchestration_preflight_application(
    input: ServertoolEngineOrchestrationPreflightApplicationInput,
) -> Result<ServertoolEngineOrchestrationPreflightApplicationPlan, String> {
    match input.action_plan.action {
        ServertoolEngineOrchestrationPreflightAction::ReturnPreflightChat => {
            if input.preflight_kind == ServertoolEngineOrchestrationPreflightKind::Continue {
                return Err("return preflight chat action received continue preflight".to_string());
            }
            let chat = input
                .chat
                .ok_or_else(|| "return preflight chat action missing chat".to_string())?;
            Ok(ServertoolEngineOrchestrationPreflightApplicationPlan {
                return_preflight_chat: true,
                continue_engine: false,
                chat: Some(chat),
                stop_signal: None,
            })
        }
        ServertoolEngineOrchestrationPreflightAction::ContinueEngine => {
            if input.preflight_kind != ServertoolEngineOrchestrationPreflightKind::Continue {
                return Err("continue engine action received non-continue preflight".to_string());
            }
            Ok(ServertoolEngineOrchestrationPreflightApplicationPlan {
                return_preflight_chat: false,
                continue_engine: true,
                chat: None,
                stop_signal: input.stop_signal,
            })
        }
    }
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

    #[test]
    fn application_returns_preflight_chat() {
        let plan = plan_servertool_engine_orchestration_preflight_application(
            ServertoolEngineOrchestrationPreflightApplicationInput {
                action_plan: ServertoolEngineOrchestrationPreflightActionPlan {
                    action: ServertoolEngineOrchestrationPreflightAction::ReturnPreflightChat,
                },
                preflight_kind: ServertoolEngineOrchestrationPreflightKind::ReturnOriginalChat,
                chat: Some(serde_json::json!({ "id": "preflight" })),
                stop_signal: None,
            },
        )
        .expect("application plan");

        assert_eq!(plan.return_preflight_chat, true);
        assert_eq!(plan.continue_engine, false);
        assert_eq!(plan.chat, Some(serde_json::json!({ "id": "preflight" })));
    }

    #[test]
    fn application_continues_engine_with_stop_signal() {
        let plan = plan_servertool_engine_orchestration_preflight_application(
            ServertoolEngineOrchestrationPreflightApplicationInput {
                action_plan: ServertoolEngineOrchestrationPreflightActionPlan {
                    action: ServertoolEngineOrchestrationPreflightAction::ContinueEngine,
                },
                preflight_kind: ServertoolEngineOrchestrationPreflightKind::Continue,
                chat: None,
                stop_signal: Some(serde_json::json!({ "observed": true })),
            },
        )
        .expect("application plan");

        assert_eq!(plan.return_preflight_chat, false);
        assert_eq!(plan.continue_engine, true);
        assert_eq!(
            plan.stop_signal,
            Some(serde_json::json!({ "observed": true }))
        );
    }

    #[test]
    fn application_rejects_mismatched_action() {
        let err = plan_servertool_engine_orchestration_preflight_application(
            ServertoolEngineOrchestrationPreflightApplicationInput {
                action_plan: ServertoolEngineOrchestrationPreflightActionPlan {
                    action: ServertoolEngineOrchestrationPreflightAction::ReturnPreflightChat,
                },
                preflight_kind: ServertoolEngineOrchestrationPreflightKind::Continue,
                chat: Some(serde_json::json!({})),
                stop_signal: None,
            },
        )
        .expect_err("mismatched action must fail");

        assert!(err.contains("continue preflight"));
    }
}
