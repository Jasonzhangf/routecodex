// feature_id: hub.servertool_stopless_cli_continuation
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessOrchestrationPlanInput {
    pub flow_id: Option<String>,
    pub execution: Value,
    #[serde(default)]
    pub request_truth_session_id: Option<String>,
    #[serde(default)]
    pub stopless_control: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StoplessOrchestrationAction {
    TerminalFinal,
    CliProjection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessOrchestrationPlan {
    pub action: StoplessOrchestrationAction,
    pub is_stop_message_flow: bool,
    pub reason: String,
}

pub fn plan_stopless_orchestration_action(
    input: StoplessOrchestrationPlanInput,
) -> StoplessOrchestrationPlan {
    let flow_id = input
        .flow_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            input
                .execution
                .get("flowId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        });
    let is_stop_message_flow = flow_id == Some("stop_message_flow");
    if !is_stop_message_flow {
        return StoplessOrchestrationPlan {
            action: StoplessOrchestrationAction::CliProjection,
            is_stop_message_flow: false,
            reason: "non_stop_message_flow".to_string(),
        };
    }
    if is_stop_message_terminal_final(&input.execution) {
        return StoplessOrchestrationPlan {
            action: StoplessOrchestrationAction::TerminalFinal,
            is_stop_message_flow: true,
            reason: "stop_message_terminal_final".to_string(),
        };
    }
    if !has_stopless_session_truth(input.request_truth_session_id.as_deref()) {
        return StoplessOrchestrationPlan {
            action: StoplessOrchestrationAction::TerminalFinal,
            is_stop_message_flow: true,
            reason: "stop_message_missing_session_truth".to_string(),
        };
    }
    if is_stop_message_budget_exhausted(input.stopless_control.as_ref()) {
        return StoplessOrchestrationPlan {
            action: StoplessOrchestrationAction::TerminalFinal,
            is_stop_message_flow: true,
            reason: "stop_message_budget_exhausted".to_string(),
        };
    }
    StoplessOrchestrationPlan {
        action: StoplessOrchestrationAction::CliProjection,
        is_stop_message_flow: true,
        reason: "stop_message_cli_projection".to_string(),
    }
}

fn is_stop_message_terminal_final(execution: &Value) -> bool {
    execution
        .get("context")
        .and_then(Value::as_object)
        .and_then(|context| context.get("stopMessageTerminalFinal"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn has_stopless_session_truth(request_truth_session_id: Option<&str>) -> bool {
    request_truth_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
}

fn is_stop_message_budget_exhausted(stopless_control: Option<&Value>) -> bool {
    let Some(stopless) = stopless_control.and_then(Value::as_object) else {
        return false;
    };
    let repeat_count = stopless
        .get("repeatCount")
        .and_then(Value::as_u64)
        .or_else(|| {
            stopless
                .get("repeat_count")
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    let max_repeats = stopless
        .get("maxRepeats")
        .and_then(Value::as_u64)
        .or_else(|| {
            stopless
                .get("max_repeats")
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    max_repeats > 0 && repeat_count >= max_repeats
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stop_message_flow_requires_session_truth() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow", "context": {} }),
            request_truth_session_id: None,
            stopless_control: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert_eq!(plan.reason, "stop_message_missing_session_truth");
    }

    #[test]
    fn stop_message_flow_uses_cli_projection_with_session_truth() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow" }),
            request_truth_session_id: Some("sess-default".to_string()),
            stopless_control: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
        assert_eq!(plan.reason, "stop_message_cli_projection");
    }

    #[test]
    fn stop_message_terminal_final_does_not_project_cli() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({
                "flowId": "stop_message_flow",
                "context": {
                    "stopMessageTerminalFinal": true
                }
            }),
            request_truth_session_id: Some("sess-terminal".to_string()),
            stopless_control: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert_eq!(plan.reason, "stop_message_terminal_final");
    }

    #[test]
    fn stop_message_budget_exhausted_forces_terminal_final() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow" }),
            request_truth_session_id: Some("sess-budget".to_string()),
            stopless_control: Some(json!({
                "flowId": "stop_message_flow",
                "repeatCount": 3,
                "maxRepeats": 3
            })),
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert_eq!(plan.reason, "stop_message_budget_exhausted");
    }

    #[test]
    fn stop_message_budget_exhausted_prefers_stopless_runtime_control_without_loop_state() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow" }),
            request_truth_session_id: Some("sess-budget-stopless".to_string()),
            stopless_control: Some(json!({
                "flowId": "stop_message_flow",
                "repeatCount": 3,
                "maxRepeats": 3
            })),
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert_eq!(plan.reason, "stop_message_budget_exhausted");
    }

    #[test]
    fn stop_message_budget_exhausted_prefers_canonical_stopless_budget_over_legacy_loop_budget() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow" }),
            request_truth_session_id: Some("sess-budget-canonical".to_string()),
            stopless_control: Some(json!({
                "flowId": "stop_message_flow",
                "repeatCount": 2,
                "maxRepeats": 3
            })),
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
        assert_eq!(plan.reason, "stop_message_cli_projection");
    }

    #[test]
    fn non_stop_flow_uses_cli_projection_without_session_truth() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("vision_flow".to_string()),
            execution: json!({ "flowId": "vision_flow" }),
            request_truth_session_id: None,
            stopless_control: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
        assert!(!plan.is_stop_message_flow);
    }
}
