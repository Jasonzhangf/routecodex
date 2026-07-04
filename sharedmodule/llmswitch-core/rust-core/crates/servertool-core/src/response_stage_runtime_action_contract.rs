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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_object: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_hook_result: Option<Value>,
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
    pub passthrough_result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pass_result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepass_result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finalize_result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStagePrepassInitialApplicationInput {
    pub decision: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolResponseStagePrepassInitialApplicationPlan {
    pub run_auto_hook: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}

fn build_passthrough_result(input: &ServertoolResponseStageRuntimeActionInput) -> Value {
    serde_json::json!({
        "mode": "passthrough",
        "finalChatResponse": input.base_object.clone().unwrap_or(Value::Null)
    })
}

fn build_prepass_continue_result(input: &ServertoolResponseStageRuntimeActionInput) -> Value {
    serde_json::json!({
        "action": "continue_to_execution",
        "responseStageGatePlan": input.response_stage_gate_plan.clone().unwrap_or(Value::Null)
    })
}

fn build_prepass_return_result(
    input: &ServertoolResponseStageRuntimeActionInput,
    result: Value,
) -> Value {
    serde_json::json!({
        "action": "return_result",
        "responseStageGatePlan": input.response_stage_gate_plan.clone().unwrap_or(Value::Null),
        "result": result
    })
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
            result_mode: None,
            passthrough_result: Some(build_passthrough_result(&input)),
            pass_result: Some(serde_json::json!({
                "action": "return_passthrough_bypass"
            })),
            prepass_result: Some(build_prepass_continue_result(&input)),
            finalize_result: Some(build_passthrough_result(&input)),
            skip_reason: resolve_skip_reason(&input),
        };
    }

    if !input.auto_hook_evaluated {
        return ServertoolResponseStageRuntimeActionPlan {
            action: ServertoolResponseStageRuntimeAction::RunAutoHooks,
            response_hook_name: None,
            result_mode: None,
            passthrough_result: None,
            pass_result: None,
            prepass_result: None,
            finalize_result: None,
            skip_reason: None,
        };
    }

    if input.has_auto_hook_result && (next_action == "run_auto_hooks" || next_action.is_empty()) {
        let auto_hook_result = input.auto_hook_result.clone().unwrap_or(Value::Null);
        return ServertoolResponseStageRuntimeActionPlan {
            action: ServertoolResponseStageRuntimeAction::ReturnAutoHookResult,
            response_hook_name: None,
            result_mode: None,
            passthrough_result: None,
            pass_result: Some(serde_json::json!({
                "action": "return_auto_hook_result",
                "result": auto_hook_result.clone()
            })),
            prepass_result: Some(build_prepass_return_result(
                &input,
                auto_hook_result.clone(),
            )),
            finalize_result: Some(auto_hook_result),
            skip_reason: None,
        };
    }

    if resolve_response_hook_required(&input) {
        return ServertoolResponseStageRuntimeActionPlan {
            action: ServertoolResponseStageRuntimeAction::ReturnRequiredResponseHookEmpty,
            response_hook_name: resolve_response_hook_name(&input),
            result_mode: None,
            passthrough_result: None,
            pass_result: None,
            prepass_result: None,
            finalize_result: None,
            skip_reason: None,
        };
    }

    let passthrough_result = build_passthrough_result(&input);
    ServertoolResponseStageRuntimeActionPlan {
        action: ServertoolResponseStageRuntimeAction::ReturnPassthroughNoAutoHookResult,
        response_hook_name: None,
        result_mode: None,
        passthrough_result: Some(passthrough_result.clone()),
        pass_result: Some(serde_json::json!({
            "action": "continue_without_result"
        })),
        prepass_result: Some(build_prepass_continue_result(&input)),
        finalize_result: Some(passthrough_result),
        skip_reason: None,
    }
}

pub fn plan_servertool_response_stage_prepass_initial_application(
    input: ServertoolResponseStagePrepassInitialApplicationInput,
) -> Result<ServertoolResponseStagePrepassInitialApplicationPlan, String> {
    let decision = input
        .decision
        .as_object()
        .ok_or_else(|| "response-stage prepass decision must be an object".to_string())?;
    let action = decision
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "response-stage prepass decision missing action".to_string())?;

    match action {
        "run_auto_hooks" => Ok(ServertoolResponseStagePrepassInitialApplicationPlan {
            run_auto_hook: true,
            result: None,
        }),
        "return_prepass_result" => {
            let result = decision
                .get("result")
                .cloned()
                .ok_or_else(|| "response-stage prepass decision missing result".to_string())?;
            Ok(ServertoolResponseStagePrepassInitialApplicationPlan {
                run_auto_hook: false,
                result: Some(result),
            })
        }
        _ => Err(format!(
            "invalid response-stage prepass decision action: {action}"
        )),
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
                base_object: Some(serde_json::json!({"id": "chat_bypass"})),
                auto_hook_result: None,
                auto_hook_evaluated: false,
                has_auto_hook_result: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnPassthroughBypass
        );
        assert_eq!(plan.result_mode, None);
        assert_eq!(
            plan.passthrough_result,
            Some(serde_json::json!({
                "mode": "passthrough",
                "finalChatResponse": {"id": "chat_bypass"}
            }))
        );
        assert_eq!(
            plan.pass_result,
            Some(serde_json::json!({
                "action": "return_passthrough_bypass"
            }))
        );
        assert_eq!(
            plan.prepass_result,
            Some(serde_json::json!({
                "action": "continue_to_execution",
                "responseStageGatePlan": null
            }))
        );
        assert_eq!(
            plan.finalize_result,
            Some(serde_json::json!({
                "mode": "passthrough",
                "finalChatResponse": {"id": "chat_bypass"}
            }))
        );
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
                base_object: Some(serde_json::json!({"id": "chat_bypass_skip"})),
                auto_hook_result: None,
                auto_hook_evaluated: false,
                has_auto_hook_result: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnPassthroughBypass
        );
        assert_eq!(plan.result_mode, None);
        assert_eq!(plan.skip_reason.as_deref(), Some("empty_assistant_payload"));
    }

    #[test]
    fn runs_auto_hooks_before_result_exists() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: None,
                response_stage_next_action: Some("run_auto_hooks".to_string()),
                base_object: None,
                auto_hook_result: None,
                auto_hook_evaluated: false,
                has_auto_hook_result: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::RunAutoHooks
        );
        assert_eq!(plan.result_mode, None);
        assert_eq!(plan.passthrough_result, None);
        assert_eq!(plan.skip_reason, None);
    }

    #[test]
    fn returns_auto_hook_result_after_run() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: None,
                response_stage_next_action: Some("run_auto_hooks".to_string()),
                base_object: None,
                auto_hook_result: Some(serde_json::json!({
                    "mode": "tool_flow",
                    "finalChatResponse": { "ok": true },
                    "execution": { "flowId": "flow_1" }
                })),
                auto_hook_evaluated: true,
                has_auto_hook_result: true,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnAutoHookResult
        );
        assert_eq!(plan.result_mode, None);
        assert_eq!(plan.passthrough_result, None);
        assert_eq!(
            plan.pass_result,
            Some(serde_json::json!({
                "action": "return_auto_hook_result",
                "result": {
                    "mode": "tool_flow",
                    "finalChatResponse": { "ok": true },
                    "execution": { "flowId": "flow_1" }
                }
            }))
        );
        assert_eq!(
            plan.prepass_result,
            Some(serde_json::json!({
                "action": "return_result",
                "responseStageGatePlan": null,
                "result": {
                    "mode": "tool_flow",
                    "finalChatResponse": { "ok": true },
                    "execution": { "flowId": "flow_1" }
                }
            }))
        );
        assert_eq!(
            plan.finalize_result,
            Some(serde_json::json!({
                "mode": "tool_flow",
                "finalChatResponse": { "ok": true },
                "execution": { "flowId": "flow_1" }
            }))
        );
        assert_eq!(plan.skip_reason, None);
    }

    #[test]
    fn returns_passthrough_when_no_auto_hook_result_after_run() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: None,
                response_stage_next_action: Some("other".to_string()),
                base_object: Some(serde_json::json!({"id": "chat_other"})),
                auto_hook_result: None,
                auto_hook_evaluated: true,
                has_auto_hook_result: true,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnPassthroughNoAutoHookResult
        );
        assert_eq!(plan.result_mode, None);
        assert_eq!(
            plan.passthrough_result,
            Some(serde_json::json!({
                "mode": "passthrough",
                "finalChatResponse": {"id": "chat_other"}
            }))
        );
        assert_eq!(
            plan.prepass_result,
            Some(serde_json::json!({
                "action": "continue_to_execution",
                "responseStageGatePlan": null
            }))
        );
        assert_eq!(
            plan.finalize_result,
            Some(serde_json::json!({
                "mode": "passthrough",
                "finalChatResponse": {"id": "chat_other"}
            }))
        );
    }

    #[test]
    fn returns_passthrough_when_auto_hook_ran_and_returned_null() {
        let plan = plan_servertool_response_stage_runtime_action(
            ServertoolResponseStageRuntimeActionInput {
                response_stage_gate_plan: None,
                response_stage_next_action: Some("run_auto_hooks".to_string()),
                base_object: Some(serde_json::json!({"id": "chat_no_hook"})),
                auto_hook_result: None,
                auto_hook_evaluated: true,
                has_auto_hook_result: false,
            },
        );
        assert_eq!(
            plan.action,
            ServertoolResponseStageRuntimeAction::ReturnPassthroughNoAutoHookResult
        );
        assert_eq!(plan.result_mode, None);
        assert_eq!(
            plan.passthrough_result,
            Some(serde_json::json!({
                "mode": "passthrough",
                "finalChatResponse": {"id": "chat_no_hook"}
            }))
        );
        assert_eq!(
            plan.pass_result,
            Some(serde_json::json!({
                "action": "continue_without_result"
            }))
        );
        assert_eq!(
            plan.prepass_result,
            Some(serde_json::json!({
                "action": "continue_to_execution",
                "responseStageGatePlan": null
            }))
        );
        assert_eq!(
            plan.finalize_result,
            Some(serde_json::json!({
                "mode": "passthrough",
                "finalChatResponse": {"id": "chat_no_hook"}
            }))
        );
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
                base_object: None,
                auto_hook_result: None,
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
        assert_eq!(plan.passthrough_result, None);
        assert_eq!(plan.prepass_result, None);
        assert_eq!(plan.finalize_result, None);
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
                base_object: None,
                auto_hook_result: None,
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
    fn prepass_initial_application_runs_auto_hooks_for_run_action() {
        let plan = plan_servertool_response_stage_prepass_initial_application(
            ServertoolResponseStagePrepassInitialApplicationInput {
                decision: serde_json::json!({ "action": "run_auto_hooks" }),
            },
        )
        .expect("prepass application plan");

        assert!(plan.run_auto_hook);
        assert_eq!(plan.result, None);
    }

    #[test]
    fn prepass_initial_application_returns_native_result() {
        let result = serde_json::json!({
            "action": "continue_to_execution",
            "responseStageGatePlan": { "nextAction": "continue_to_execution" }
        });
        let plan = plan_servertool_response_stage_prepass_initial_application(
            ServertoolResponseStagePrepassInitialApplicationInput {
                decision: serde_json::json!({
                    "action": "return_prepass_result",
                    "result": result
                }),
            },
        )
        .expect("prepass application plan");

        assert!(!plan.run_auto_hook);
        assert_eq!(plan.result, Some(result));
    }

    #[test]
    fn prepass_initial_application_rejects_unknown_action() {
        let err = plan_servertool_response_stage_prepass_initial_application(
            ServertoolResponseStagePrepassInitialApplicationInput {
                decision: serde_json::json!({ "action": "unknown" }),
            },
        )
        .expect_err("unknown prepass decision must fail");

        assert!(err.contains("invalid response-stage prepass decision action"));
    }
}
