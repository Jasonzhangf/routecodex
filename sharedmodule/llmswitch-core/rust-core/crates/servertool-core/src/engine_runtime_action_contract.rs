// feature_id: hub.servertool_engine_runtime_action_contract
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineRuntimeActionInput {
    pub has_pending_injection: bool,
    pub is_stop_message_flow: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_context: Option<Value>,
    pub has_servertool_cli_projection_context: bool,
    pub stopless_action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolEngineRuntimeAction {
    PersistPendingInjectionAndReturn,
    ReturnServertoolCliProjectionFinal,
    ReturnStopMessageTerminalFinal,
    BuildStopMessageCliProjection,
    ContinueFollowupMainline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineRuntimeActionPlan {
    pub action: ServertoolEngineRuntimeAction,
}

pub fn plan_servertool_engine_runtime_action(
    input: ServertoolEngineRuntimeActionInput,
) -> ServertoolEngineRuntimeActionPlan {
    let has_servertool_cli_projection_context = match input.execution_context.as_ref() {
        Some(Value::Object(context)) => context
            .get("servertoolCliProjection")
            .map(|value| !value.is_null())
            .unwrap_or(false),
        _ => input.has_servertool_cli_projection_context,
    };

    if input.has_pending_injection {
        return ServertoolEngineRuntimeActionPlan {
            action: ServertoolEngineRuntimeAction::PersistPendingInjectionAndReturn,
        };
    }
    if !input.is_stop_message_flow && has_servertool_cli_projection_context {
        return ServertoolEngineRuntimeActionPlan {
            action: ServertoolEngineRuntimeAction::ReturnServertoolCliProjectionFinal,
        };
    }
    if input.stopless_action.trim() == "terminal_final" {
        return ServertoolEngineRuntimeActionPlan {
            action: ServertoolEngineRuntimeAction::ReturnStopMessageTerminalFinal,
        };
    }
    if input.is_stop_message_flow && input.stopless_action.trim() == "cli_projection" {
        return ServertoolEngineRuntimeActionPlan {
            action: ServertoolEngineRuntimeAction::BuildStopMessageCliProjection,
        };
    }
    ServertoolEngineRuntimeActionPlan {
        action: ServertoolEngineRuntimeAction::ContinueFollowupMainline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_pending_injection_before_all_other_paths() {
        let plan = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            has_pending_injection: true,
            is_stop_message_flow: true,
            execution_context: None,
            has_servertool_cli_projection_context: true,
            stopless_action: "terminal_final".to_string(),
        });
        assert_eq!(
            plan.action,
            ServertoolEngineRuntimeAction::PersistPendingInjectionAndReturn
        );
    }

    #[test]
    fn returns_generic_cli_projection_for_non_stop_flow() {
        let plan = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            has_pending_injection: false,
            is_stop_message_flow: false,
            execution_context: None,
            has_servertool_cli_projection_context: true,
            stopless_action: "cli_projection".to_string(),
        });
        assert_eq!(
            plan.action,
            ServertoolEngineRuntimeAction::ReturnServertoolCliProjectionFinal
        );
    }

    #[test]
    fn returns_terminal_final_for_stop_message_terminal_action() {
        let plan = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            has_pending_injection: false,
            is_stop_message_flow: true,
            execution_context: None,
            has_servertool_cli_projection_context: false,
            stopless_action: "terminal_final".to_string(),
        });
        assert_eq!(
            plan.action,
            ServertoolEngineRuntimeAction::ReturnStopMessageTerminalFinal
        );
    }

    #[test]
    fn builds_stop_message_cli_projection_only_for_stop_flow() {
        let plan = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            has_pending_injection: false,
            is_stop_message_flow: true,
            execution_context: None,
            has_servertool_cli_projection_context: false,
            stopless_action: "cli_projection".to_string(),
        });
        assert_eq!(
            plan.action,
            ServertoolEngineRuntimeAction::BuildStopMessageCliProjection
        );
    }

    #[test]
    fn falls_through_to_followup_mainline() {
        let plan = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            has_pending_injection: false,
            is_stop_message_flow: false,
            execution_context: None,
            has_servertool_cli_projection_context: false,
            stopless_action: "continue".to_string(),
        });
        assert_eq!(
            plan.action,
            ServertoolEngineRuntimeAction::ContinueFollowupMainline
        );
    }

    #[test]
    fn derives_cli_projection_context_from_execution_context_object() {
        let plan = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            has_pending_injection: false,
            is_stop_message_flow: false,
            execution_context: Some(serde_json::json!({
                "servertoolCliProjection": {
                    "flowId": "servertool_cli_projection"
                }
            })),
            has_servertool_cli_projection_context: false,
            stopless_action: "continue".to_string(),
        });
        assert_eq!(
            plan.action,
            ServertoolEngineRuntimeAction::ReturnServertoolCliProjectionFinal
        );
    }
}
