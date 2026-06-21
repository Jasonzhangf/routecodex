// feature_id: hub.servertool_stopless_cli_continuation
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessOrchestrationPlanInput {
    pub flow_id: Option<String>,
    pub execution: Value,
    pub session_id: Option<String>,
    #[serde(default)]
    pub adapter_context: Option<Value>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

fn normalize_stopless_session_id(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered == "unknown" || lowered == "none" || lowered == "null" || lowered == "-" {
        return None;
    }
    Some(trimmed)
}

pub fn plan_stopless_orchestration_action(
    input: StoplessOrchestrationPlanInput,
) -> StoplessOrchestrationPlan {
    let session_id = normalize_stopless_session_id(input.session_id)
        .or_else(|| resolve_stopless_session_id(input.adapter_context.as_ref()));
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
            session_id,
        };
    }
    if is_stop_message_terminal_final(&input.execution) {
        return StoplessOrchestrationPlan {
            action: StoplessOrchestrationAction::TerminalFinal,
            is_stop_message_flow: true,
            reason: "stop_message_terminal_final".to_string(),
            session_id,
        };
    }
    if session_id.is_none() {
        return StoplessOrchestrationPlan {
            action: StoplessOrchestrationAction::TerminalFinal,
            is_stop_message_flow: true,
            reason: "stop_message_missing_session".to_string(),
            session_id: None,
        };
    }
    if is_stop_message_budget_exhausted(&input.execution) {
        return StoplessOrchestrationPlan {
            action: StoplessOrchestrationAction::TerminalFinal,
            is_stop_message_flow: true,
            reason: "stop_message_budget_exhausted".to_string(),
            session_id,
        };
    }
    StoplessOrchestrationPlan {
        action: StoplessOrchestrationAction::CliProjection,
        is_stop_message_flow: true,
        reason: "stop_message_cli_projection".to_string(),
        session_id,
    }
}

fn resolve_stopless_session_id(adapter_context: Option<&Value>) -> Option<String> {
    let record = adapter_context?.as_object()?;
    normalize_stopless_session_id(read_session_id(record))
        .or_else(|| {
            record
                .get("metadata")
                .and_then(Value::as_object)
                .and_then(|row| normalize_stopless_session_id(read_session_id(row)))
        })
        .or_else(|| {
            record
                .get("__rt")
                .and_then(Value::as_object)
                .and_then(|row| normalize_stopless_session_id(read_session_id(row)))
        })
        .or_else(|| {
            record
                .get("__rt")
                .and_then(Value::as_object)
                .and_then(|row| row.get("__rt"))
                .and_then(Value::as_object)
                .and_then(|row| normalize_stopless_session_id(read_session_id(row)))
        })
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn read_session_id(record: &serde_json::Map<String, Value>) -> Option<String> {
    read_trimmed_string(record.get("sessionId"))
        .or_else(|| read_trimmed_string(record.get("session_id")))
}

fn is_stop_message_terminal_final(execution: &Value) -> bool {
    execution
        .get("context")
        .and_then(Value::as_object)
        .and_then(|context| context.get("stopMessageTerminalFinal"))
        .and_then(Value::as_bool)
        == Some(true)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stop_message_flow_uses_cli_projection_by_default() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow", "context": {} }),
            session_id: Some("sess-default".to_string()),
            adapter_context: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
        assert!(plan.is_stop_message_flow);
        assert_eq!(plan.reason, "stop_message_cli_projection");
        assert_eq!(plan.session_id.as_deref(), Some("sess-default"));
    }

    #[test]
    fn stop_message_flow_missing_session_stays_terminal() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow", "context": {} }),
            session_id: None,
            adapter_context: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert!(plan.is_stop_message_flow);
        assert_eq!(plan.reason, "stop_message_missing_session");
        assert!(plan.session_id.is_none());
    }

    #[test]
    fn stop_message_flow_unknown_session_stays_terminal() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow", "context": {} }),
            session_id: Some(" unknown ".to_string()),
            adapter_context: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert!(plan.is_stop_message_flow);
        assert_eq!(plan.reason, "stop_message_missing_session");
        assert!(plan.session_id.is_none());
    }

    #[test]
    fn stop_message_terminal_final_does_not_project_cli() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({
                "flowId": "stop_message_flow",
                "context": { "stopMessageTerminalFinal": true }
            }),
            session_id: Some("sess-terminal".to_string()),
            adapter_context: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert_eq!(plan.reason, "stop_message_terminal_final");
        assert_eq!(plan.session_id.as_deref(), Some("sess-terminal"));
    }

    #[test]
    fn non_stop_flow_uses_cli_projection() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("vision_flow".to_string()),
            execution: json!({ "flowId": "vision_flow" }),
            session_id: Some("sess-abc".to_string()),
            adapter_context: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
        assert!(!plan.is_stop_message_flow);
        assert_eq!(plan.session_id.as_deref(), Some("sess-abc"));
    }

    #[test]
    fn stop_message_flow_cli_projection_carries_session_id() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow", "context": {} }),
            session_id: Some("sess-xyz".to_string()),
            adapter_context: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
        assert!(plan.is_stop_message_flow);
        assert_eq!(plan.session_id.as_deref(), Some("sess-xyz"));
    }

    #[test]
    fn stop_message_flow_terminal_final_carries_session_id() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({
                "flowId": "stop_message_flow",
                "context": { "stopMessageTerminalFinal": true }
            }),
            session_id: Some("sess-final".to_string()),
            adapter_context: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert!(plan.is_stop_message_flow);
        assert_eq!(plan.session_id.as_deref(), Some("sess-final"));
    }

    #[test]
    fn stop_message_flow_reads_camel_case_adapter_context_session_id() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow", "context": {} }),
            session_id: None,
            adapter_context: Some(json!({
                "sessionId": "sess-camel-adapter"
            })),
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
        assert!(plan.is_stop_message_flow);
        assert_eq!(plan.reason, "stop_message_cli_projection");
        assert_eq!(plan.session_id.as_deref(), Some("sess-camel-adapter"));
    }

    #[test]
    fn stop_message_budget_exhausted_forces_terminal_final() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({
                "flowId": "stop_message_flow",
                "context": {
                    "serverToolLoopState": {
                        "flowId": "stop_message_flow",
                        "repeatCount": 3,
                        "maxRepeats": 3
                    }
                }
            }),
            session_id: Some("sess-budget".to_string()),
            adapter_context: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert!(plan.is_stop_message_flow);
        assert_eq!(plan.reason, "stop_message_budget_exhausted");
        assert_eq!(plan.session_id.as_deref(), Some("sess-budget"));
    }

    #[test]
    fn stop_message_budget_not_yet_exhausted_stays_cli_projection() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({
                "flowId": "stop_message_flow",
                "context": {
                    "serverToolLoopState": {
                        "flowId": "stop_message_flow",
                        "repeatCount": 2,
                        "maxRepeats": 3
                    }
                }
            }),
            session_id: Some("sess-still-arming".to_string()),
            adapter_context: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
        assert!(plan.is_stop_message_flow);
        assert_eq!(plan.reason, "stop_message_cli_projection");
        assert_eq!(plan.session_id.as_deref(), Some("sess-still-arming"));
    }

    #[test]
    fn stop_message_budget_exhausted_takes_precedence_over_cli_projection() {
        // Even without an explicit stopMessageTerminalFinal, the plan must
        // turn terminal as soon as the session's persisted budget is gone.
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({
                "flowId": "stop_message_flow",
                "context": {
                    "serverToolLoopState": {
                        "repeatCount": 4,
                        "maxRepeats": 3
                    }
                }
            }),
            session_id: Some("sess-budget".to_string()),
            adapter_context: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::TerminalFinal);
        assert_eq!(plan.reason, "stop_message_budget_exhausted");
    }

    #[test]
    fn stop_message_budget_exhausted_missing_loop_state_stays_cli_projection() {
        // Defensive: a malformed loop state must not silently bypass the
        // budget check. We require a positive maxRepeats before we trust
        // the comparison.
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({
                "flowId": "stop_message_flow",
                "context": {}
            }),
            session_id: Some("sess-still-cli".to_string()),
            adapter_context: None,
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
    }

    #[test]
    fn stop_message_flow_reads_session_id_from_adapter_context_when_input_missing() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow", "context": {} }),
            session_id: None,
            adapter_context: Some(json!({
                "metadata": { "sessionId": "sess-meta" }
            })),
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
        assert!(plan.is_stop_message_flow);
        assert_eq!(plan.session_id.as_deref(), Some("sess-meta"));
    }

    #[test]
    fn stop_message_flow_reads_snake_case_session_id_from_adapter_context_metadata() {
        let plan = plan_stopless_orchestration_action(StoplessOrchestrationPlanInput {
            flow_id: Some("stop_message_flow".to_string()),
            execution: json!({ "flowId": "stop_message_flow", "context": {} }),
            session_id: None,
            adapter_context: Some(json!({
                "metadata": { "session_id": "sess-snake" }
            })),
        });
        assert_eq!(plan.action, StoplessOrchestrationAction::CliProjection);
        assert!(plan.is_stop_message_flow);
        assert_eq!(plan.session_id.as_deref(), Some("sess-snake"));
    }
}
