// feature_id: hub.servertool_stopless_cli_continuation
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessOrchestrationPlanInput {
    pub flow_id: Option<String>,
    pub execution: Value,
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
    if !has_stopless_session_truth(&input.execution) {
        return StoplessOrchestrationPlan {
            action: StoplessOrchestrationAction::TerminalFinal,
            is_stop_message_flow: true,
            reason: "stop_message_missing_session_truth".to_string(),
        };
    }
    if is_stop_message_budget_exhausted(&input.execution) {
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

fn has_stopless_session_truth(execution: &Value) -> bool {
    let Some(context) = execution.get("context").and_then(Value::as_object) else {
        return false;
    };
    read_trimmed_string(context.get("sessionId"))
        .or_else(|| {
            context
                .get("requestTruth")
                .and_then(Value::as_object)
                .and_then(|truth| read_trimmed_string(truth.get("sessionId")))
        })
        .is_some()
}

fn is_stop_message_budget_exhausted(execution: &Value) -> bool {
    let Some(context) = execution.get("context").and_then(Value::as_object) else {
        return false;
    };
    let Some(loop_state) = context.get("serverToolLoopState").and_then(Value::as_object) else {
        return false;
    };
    let repeat_count = loop_state
        .get("repeatCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let max_repeats = loop_state
        .get("maxRepeats")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    max_repeats > 0 && repeat_count >= max_repeats
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
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
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert_eq!(plan.reason, "stop_message_missing_session_truth");
    }

    #[test]
    fn stop_message_flow_uses_cli_projection_with_session_truth() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({
                "flowId": "stop_message_flow",
                "context": { "requestTruth": { "sessionId": "sess-default" } }
            }),
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
                    "stopMessageTerminalFinal": true,
                    "requestTruth": { "sessionId": "sess-terminal" }
                }
            }),
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert_eq!(plan.reason, "stop_message_terminal_final");
    }

    #[test]
    fn stop_message_budget_exhausted_forces_terminal_final() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({
                "flowId": "stop_message_flow",
                "context": {
                    "requestTruth": { "sessionId": "sess-budget" },
                    "serverToolLoopState": {
                        "flowId": "stop_message_flow",
                        "repeatCount": 3,
                        "maxRepeats": 3
                    }
                }
            }),
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert_eq!(plan.reason, "stop_message_budget_exhausted");
    }

    #[test]
    fn non_stop_flow_uses_cli_projection_without_session_truth() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("vision_flow".to_string()),
            execution: json!({ "flowId": "vision_flow" }),
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
        assert!(!plan.is_stop_message_flow);
    }
}
