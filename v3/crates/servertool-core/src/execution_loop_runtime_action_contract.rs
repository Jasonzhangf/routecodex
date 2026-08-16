// feature_id: hub.servertool_execution_loop_runtime_action_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionLoopRuntimeActionInput {
    pub has_handler_entry: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_execution_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts_execution_mode: Option<String>,
    pub has_materialized_result: bool,
    pub has_handler_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolExecutionLoopRuntimeAction {
    SkipNonToolCallHandler,
    ThrowDispatchSpecMismatch,
    ApplyMaterializedResult,
    ApplyHandlerErrorToolOutput,
    ContinueWithoutEffect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionLoopRuntimeActionPlan {
    pub action: ServertoolExecutionLoopRuntimeAction,
}

pub fn plan_servertool_execution_loop_runtime_action(
    input: ServertoolExecutionLoopRuntimeActionInput,
) -> ServertoolExecutionLoopRuntimeActionPlan {
    if !input.has_handler_entry
        || input.trigger_mode.as_deref().unwrap_or_default().trim() != "tool_call"
    {
        return ServertoolExecutionLoopRuntimeActionPlan {
            action: ServertoolExecutionLoopRuntimeAction::SkipNonToolCallHandler,
        };
    }
    let native_execution_mode = input
        .native_execution_mode
        .as_deref()
        .unwrap_or_default()
        .trim();
    let ts_execution_mode = input
        .ts_execution_mode
        .as_deref()
        .unwrap_or_default()
        .trim();
    if !native_execution_mode.is_empty()
        && !ts_execution_mode.is_empty()
        && native_execution_mode != ts_execution_mode
    {
        return ServertoolExecutionLoopRuntimeActionPlan {
            action: ServertoolExecutionLoopRuntimeAction::ThrowDispatchSpecMismatch,
        };
    }
    if input.has_materialized_result {
        return ServertoolExecutionLoopRuntimeActionPlan {
            action: ServertoolExecutionLoopRuntimeAction::ApplyMaterializedResult,
        };
    }
    if input.has_handler_error {
        return ServertoolExecutionLoopRuntimeActionPlan {
            action: ServertoolExecutionLoopRuntimeAction::ApplyHandlerErrorToolOutput,
        };
    }
    ServertoolExecutionLoopRuntimeActionPlan {
        action: ServertoolExecutionLoopRuntimeAction::ContinueWithoutEffect,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_when_handler_is_missing() {
        let plan = plan_servertool_execution_loop_runtime_action(
            ServertoolExecutionLoopRuntimeActionInput {
                has_handler_entry: false,
                trigger_mode: None,
                native_execution_mode: None,
                ts_execution_mode: None,
                has_materialized_result: false,
                has_handler_error: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionLoopRuntimeAction::SkipNonToolCallHandler
        );
    }

    #[test]
    fn skips_when_handler_is_not_tool_call() {
        let plan = plan_servertool_execution_loop_runtime_action(
            ServertoolExecutionLoopRuntimeActionInput {
                has_handler_entry: true,
                trigger_mode: Some("auto".to_string()),
                native_execution_mode: None,
                ts_execution_mode: None,
                has_materialized_result: false,
                has_handler_error: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionLoopRuntimeAction::SkipNonToolCallHandler
        );
    }

    #[test]
    fn prefers_materialized_result_over_error() {
        let plan = plan_servertool_execution_loop_runtime_action(
            ServertoolExecutionLoopRuntimeActionInput {
                has_handler_entry: true,
                trigger_mode: Some("tool_call".to_string()),
                native_execution_mode: Some("guarded".to_string()),
                ts_execution_mode: Some("guarded".to_string()),
                has_materialized_result: true,
                has_handler_error: true,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionLoopRuntimeAction::ApplyMaterializedResult
        );
    }

    #[test]
    fn applies_handler_error_when_result_is_missing() {
        let plan = plan_servertool_execution_loop_runtime_action(
            ServertoolExecutionLoopRuntimeActionInput {
                has_handler_entry: true,
                trigger_mode: Some("tool_call".to_string()),
                native_execution_mode: Some("guarded".to_string()),
                ts_execution_mode: Some("guarded".to_string()),
                has_materialized_result: false,
                has_handler_error: true,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionLoopRuntimeAction::ApplyHandlerErrorToolOutput
        );
    }

    #[test]
    fn continues_without_effect_when_nothing_happened() {
        let plan = plan_servertool_execution_loop_runtime_action(
            ServertoolExecutionLoopRuntimeActionInput {
                has_handler_entry: true,
                trigger_mode: Some("tool_call".to_string()),
                native_execution_mode: Some("guarded".to_string()),
                ts_execution_mode: Some("guarded".to_string()),
                has_materialized_result: false,
                has_handler_error: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionLoopRuntimeAction::ContinueWithoutEffect
        );
    }

    #[test]
    fn throws_dispatch_spec_mismatch_before_runtime_result_handling() {
        let plan = plan_servertool_execution_loop_runtime_action(
            ServertoolExecutionLoopRuntimeActionInput {
                has_handler_entry: true,
                trigger_mode: Some("tool_call".to_string()),
                native_execution_mode: Some("guarded".to_string()),
                ts_execution_mode: Some("legacy".to_string()),
                has_materialized_result: true,
                has_handler_error: true,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolExecutionLoopRuntimeAction::ThrowDispatchSpecMismatch
        );
    }
}
