// feature_id: hub.servertool_response_stage_runtime_action_contract
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStageRuntimeActionInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_stage_gate_plan: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_stage_next_action: Option<String>,
    pub auto_hook_evaluated: bool,
    pub has_auto_hook_result: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolResponseStageRuntimeAction {
    ReturnPassthroughBypass,
    RunAutoHooks,
    ReturnAutoHookResult,
    ReturnPassthroughNoAutoHookResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStageRuntimeActionPlan {
    pub action: ServertoolResponseStageRuntimeAction,
}

fn resolve_response_stage_next_action(
    input: &ServertoolResponseStageRuntimeActionInput,
) -> &str {
    if let Some(Value::Object(plan)) = input.response_stage_gate_plan.as_ref() {
        if let Some(Value::String(next_action)) = plan.get("nextAction") {
            return next_action.trim();
        }
    }

    input
        .response_stage_next_action
        .as_deref()
        .unwrap_or_default()
        .trim()
}

pub fn plan_servertool_response_stage_runtime_action(
    input: ServertoolResponseStageRuntimeActionInput,
) -> ServertoolResponseStageRuntimeActionPlan {
    let next_action = resolve_response_stage_next_action(&input);

    if next_action == "bypass" {
        return ServertoolResponseStageRuntimeActionPlan {
            action: ServertoolResponseStageRuntimeAction::ReturnPassthroughBypass,
        };
    }

    if !input.auto_hook_evaluated {
        return ServertoolResponseStageRuntimeActionPlan {
            action: ServertoolResponseStageRuntimeAction::RunAutoHooks,
        };
    }

    if input.has_auto_hook_result && (next_action == "run_auto_hooks" || next_action.is_empty()) {
        return ServertoolResponseStageRuntimeActionPlan {
            action: ServertoolResponseStageRuntimeAction::ReturnAutoHookResult,
        };
    }

    ServertoolResponseStageRuntimeActionPlan {
        action: ServertoolResponseStageRuntimeAction::ReturnPassthroughNoAutoHookResult,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_bypass_passthrough_when_gate_requests_bypass() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: None,
                response_stage_next_action: Some("bypass".to_string()),
                auto_hook_evaluated: false,
                has_auto_hook_result: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnPassthroughBypass
        );
    }

    #[test]
    fn runs_auto_hooks_before_result_exists() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: None,
                response_stage_next_action: Some("run_auto_hooks".to_string()),
                auto_hook_evaluated: false,
                has_auto_hook_result: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::RunAutoHooks
        );
    }

    #[test]
    fn returns_auto_hook_result_after_run() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: None,
                response_stage_next_action: Some("run_auto_hooks".to_string()),
                auto_hook_evaluated: true,
                has_auto_hook_result: true,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnAutoHookResult
        );
    }

    #[test]
    fn returns_passthrough_when_no_auto_hook_result_after_run() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: None,
                response_stage_next_action: Some("other".to_string()),
                auto_hook_evaluated: true,
                has_auto_hook_result: true,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnPassthroughNoAutoHookResult
        );
    }

    #[test]
    fn returns_passthrough_when_auto_hook_ran_and_returned_null() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: None,
                response_stage_next_action: Some("run_auto_hooks".to_string()),
                auto_hook_evaluated: true,
                has_auto_hook_result: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnPassthroughNoAutoHookResult
        );
    }

    #[test]
    fn resolves_next_action_from_gate_plan_object() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: Some(serde_json::json!({
                    "shouldBypass": false,
                    "nextAction": "run_auto_hooks"
                })),
                response_stage_next_action: None,
                auto_hook_evaluated: true,
                has_auto_hook_result: true,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnAutoHookResult
        );
    }
}
