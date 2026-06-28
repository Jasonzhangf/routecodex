// feature_id: hub.servertool_engine_runtime_action_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineRuntimeActionInput {
    pub has_pending_injection: bool,
    pub is_stop_message_flow: bool,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEngineRuntimeActionPlan {
    pub action: ServertoolEngineRuntimeAction,
}

pub fn plan_servertool_engine_runtime_action(
    input: ServertoolEngineRuntimeActionInput,
) -> Result<ServertoolEngineRuntimeActionPlan, String> {
    if input.has_pending_injection {
        return Ok(ServertoolEngineRuntimeActionPlan {
            action: ServertoolEngineRuntimeAction::PersistPendingInjectionAndReturn,
        });
    }
    if !input.is_stop_message_flow && input.has_servertool_cli_projection_context {
        return Ok(ServertoolEngineRuntimeActionPlan {
            action: ServertoolEngineRuntimeAction::ReturnServertoolCliProjectionFinal,
        });
    }
    if input.stopless_action.trim() == "terminal_final" {
        return Ok(ServertoolEngineRuntimeActionPlan {
            action: ServertoolEngineRuntimeAction::ReturnStopMessageTerminalFinal,
        });
    }
    if input.is_stop_message_flow && input.stopless_action.trim() == "cli_projection" {
        return Ok(ServertoolEngineRuntimeActionPlan {
            action: ServertoolEngineRuntimeAction::BuildStopMessageCliProjection,
        });
    }
    Err(format!(
        "servertool runtime action has no reenter mainline: isStopMessageFlow={} stoplessAction={} hasPendingInjection={} hasServertoolCliProjectionContext={}",
        input.is_stop_message_flow,
        input.stopless_action.trim(),
        input.has_pending_injection,
        input.has_servertool_cli_projection_context
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_pending_injection_before_all_other_paths() {
        let plan = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            has_pending_injection: true,
            is_stop_message_flow: true,
            has_servertool_cli_projection_context: true,
            stopless_action: "terminal_final".to_string(),
        })
        .expect("pending plan");
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
            has_servertool_cli_projection_context: true,
            stopless_action: "cli_projection".to_string(),
        })
        .expect("cli projection plan");
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
            has_servertool_cli_projection_context: false,
            stopless_action: "terminal_final".to_string(),
        })
        .expect("terminal plan");
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
            has_servertool_cli_projection_context: false,
            stopless_action: "cli_projection".to_string(),
        })
        .expect("stopless cli plan");
        assert_eq!(
            plan.action,
            ServertoolEngineRuntimeAction::BuildStopMessageCliProjection
        );
    }

    #[test]
    fn fails_fast_when_residual_reenter_mainline_is_requested() {
        let err = plan_servertool_engine_runtime_action(ServertoolEngineRuntimeActionInput {
            has_pending_injection: false,
            is_stop_message_flow: false,
            has_servertool_cli_projection_context: false,
            stopless_action: "continue".to_string(),
        })
        .expect_err("residual reenter mainline must fail");
        assert!(err.contains("no reenter mainline"));
    }
}
