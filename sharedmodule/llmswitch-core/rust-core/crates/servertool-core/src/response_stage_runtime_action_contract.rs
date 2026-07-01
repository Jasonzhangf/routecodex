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
    ReturnRequiredResponseHookEmpty,
    ReturnPassthroughNoAutoHookResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStageRuntimeActionPlan {
    pub action: ServertoolResponseStageRuntimeAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_hook_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
}

fn resolve_response_stage_next_action(input: &ServertoolResponseStageRuntimeActionInput) -> &str {
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

fn resolve_response_hook_required(input: &ServertoolResponseStageRuntimeActionInput) -> bool {
    if let Some(Value::Object(plan)) = input.response_stage_gate_plan.as_ref() {
        if let Some(Value::Bool(required)) = plan.get("responseHookRequired") {
            return *required;
        }
    }
    false
}

fn resolve_response_hook_name(input: &ServertoolResponseStageRuntimeActionInput) -> Option<String> {
    if let Some(Value::Object(plan)) = input.response_stage_gate_plan.as_ref() {
        if let Some(Value::String(name)) = plan.get("responseHookName") {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn resolve_skip_reason(input: &ServertoolResponseStageRuntimeActionInput) -> Option<String> {
    if let Some(Value::Object(plan)) = input.response_stage_gate_plan.as_ref() {
        if let Some(Value::String(skip_reason)) = plan.get("skipReason") {
            let trimmed = skip_reason.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

pub fn plan_servertool_response_stage_runtime_action(
    input: ServertoolResponseStageRuntimeActionInput,
) -> ServertoolResponseStageRuntimeActionPlan {
    let next_action = resolve_response_stage_next_action(&input);

    if next_action == "bypass" {
        return ServertoolResponseStageRuntimeActionPlan {
            action: ServertoolResponseStageRuntimeAction::ReturnPassthroughBypass,
            response_hook_name: None,
            result_mode: Some("passthrough".to_string()),
            skip_reason: resolve_skip_reason(&input),
        };
    }

    if !input.auto_hook_evaluated {
        return ServertoolResponseStageRuntimeActionPlan {
            action: ServertoolResponseStageRuntimeAction::RunAutoHooks,
            response_hook_name: None,
            result_mode: None,
            skip_reason: None,
        };
    }

    if input.has_auto_hook_result && (next_action == "run_auto_hooks" || next_action.is_empty()) {
        return ServertoolResponseStageRuntimeActionPlan {
            action: ServertoolResponseStageRuntimeAction::ReturnAutoHookResult,
            response_hook_name: None,
            result_mode: None,
            skip_reason: None,
        };
    }

    if resolve_response_hook_required(&input) {
        return ServertoolResponseStageRuntimeActionPlan {
            action: ServertoolResponseStageRuntimeAction::ReturnRequiredResponseHookEmpty,
            response_hook_name: resolve_response_hook_name(&input),
            result_mode: None,
            skip_reason: None,
        };
    }

    ServertoolResponseStageRuntimeActionPlan {
        action: ServertoolResponseStageRuntimeAction::ReturnPassthroughNoAutoHookResult,
        response_hook_name: None,
        result_mode: Some("passthrough".to_string()),
        skip_reason: None,
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
        assert_eq!(plan.result_mode.as_deref(), Some("passthrough"));
        assert_eq!(plan.skip_reason, None);
    }

    #[test]
    fn returns_bypass_skip_reason_from_gate_plan() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: Some(serde_json::json!({
                    "nextAction": "bypass",
                    "skipReason": " empty_assistant_payload "
                })),
                response_stage_next_action: None,
                auto_hook_evaluated: false,
                has_auto_hook_result: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnPassthroughBypass
        );
        assert_eq!(plan.result_mode.as_deref(), Some("passthrough"));
        assert_eq!(plan.skip_reason.as_deref(), Some("empty_assistant_payload"));
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
        assert_eq!(plan.result_mode, None);
        assert_eq!(plan.skip_reason, None);
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
        assert_eq!(plan.result_mode, None);
        assert_eq!(plan.skip_reason, None);
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
        assert_eq!(plan.result_mode.as_deref(), Some("passthrough"));
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
        assert_eq!(plan.result_mode.as_deref(), Some("passthrough"));
    }

    #[test]
    fn returns_required_hook_empty_from_gate_plan() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: Some(serde_json::json!({
                    "nextAction": "run_auto_hooks",
                    "responseHookRequired": true,
                    "responseHookName": " stop_message_auto "
                })),
                response_stage_next_action: None,
                auto_hook_evaluated: true,
                has_auto_hook_result: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnRequiredResponseHookEmpty
        );
        assert_eq!(
            plan.response_hook_name.as_deref(),
            Some("stop_message_auto")
        );
        assert_eq!(plan.result_mode, None);
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
