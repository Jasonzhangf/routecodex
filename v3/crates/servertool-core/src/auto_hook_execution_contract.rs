use serde::{Deserialize, Serialize};

// feature_id: hub.servertool_auto_hook_execution

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoHookExecutionDecisionInput {
    pub hook_id: String,
    pub phase: String,
    pub priority: i64,
    pub queue: String,
    pub queue_index: i64,
    pub queue_total: i64,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub has_planned_result: bool,
    #[serde(default)]
    pub has_materialized_result: bool,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub flow_id: Option<String>,
    #[serde(default)]
    pub materialized_flow_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoHookExecutionDecisionPlan {
    pub action: AutoHookExecutionAction,
    pub trace_event: AutoHookTraceEventPlan,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AutoHookExecutionAction {
    ContinueQueue,
    ReturnResult,
    RethrowError,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoHookTraceEventPlan {
    pub hook_id: String,
    pub phase: String,
    pub priority: i64,
    pub queue: String,
    pub queue_index: i64,
    pub queue_total: i64,
    pub result: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
}

pub fn plan_auto_hook_execution_decision(
    input: AutoHookExecutionDecisionInput,
) -> AutoHookExecutionDecisionPlan {
    let trace_base = AutoHookTraceEventPlan {
        hook_id: input.hook_id.trim().to_string(),
        phase: input.phase.trim().to_string(),
        priority: input.priority,
        queue: input.queue.trim().to_string(),
        queue_index: input.queue_index.max(0),
        queue_total: input.queue_total.max(0),
        result: String::new(),
        reason: String::new(),
        flow_id: None,
    };

    let outcome = normalize_outcome(&input);
    match outcome.as_str() {
        "error" => AutoHookExecutionDecisionPlan {
            action: AutoHookExecutionAction::RethrowError,
            trace_event: AutoHookTraceEventPlan {
                result: "error".to_string(),
                reason: normalize_reason(input.message.as_deref(), "unknown"),
                ..trace_base
            },
        },
        "planned_null" => AutoHookExecutionDecisionPlan {
            action: AutoHookExecutionAction::ContinueQueue,
            trace_event: AutoHookTraceEventPlan {
                result: "miss".to_string(),
                reason: "predicate_false".to_string(),
                ..trace_base
            },
        },
        "materialized_match" => {
            let flow_id = normalize_optional_text(
                input
                    .materialized_flow_id
                    .as_deref()
                    .or(input.flow_id.as_deref()),
            );
            AutoHookExecutionDecisionPlan {
                action: AutoHookExecutionAction::ReturnResult,
                trace_event: AutoHookTraceEventPlan {
                    result: "match".to_string(),
                    reason: if flow_id.is_some() {
                        "matched".to_string()
                    } else {
                        "matched_without_flow".to_string()
                    },
                    flow_id,
                    ..trace_base
                },
            }
        }
        "materialized_empty" => AutoHookExecutionDecisionPlan {
            action: AutoHookExecutionAction::ContinueQueue,
            trace_event: AutoHookTraceEventPlan {
                result: "miss".to_string(),
                reason: "empty_materialized_result".to_string(),
                ..trace_base
            },
        },
        _ => AutoHookExecutionDecisionPlan {
            action: AutoHookExecutionAction::RethrowError,
            trace_event: AutoHookTraceEventPlan {
                result: "error".to_string(),
                reason: format!("invalid_auto_hook_execution_outcome:{outcome}"),
                ..trace_base
            },
        },
    }
}

fn normalize_outcome(input: &AutoHookExecutionDecisionInput) -> String {
    let explicit = input.outcome.as_deref().map(str::trim).unwrap_or_default();
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    if normalize_optional_text(input.message.as_deref()).is_some() {
        return "error".to_string();
    }
    if !input.has_planned_result {
        return "planned_null".to_string();
    }
    if input.has_materialized_result {
        return "materialized_match".to_string();
    }
    "materialized_empty".to_string()
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_reason(value: Option<&str>, fallback: &str) -> String {
    normalize_optional_text(value).unwrap_or_else(|| fallback.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        plan_auto_hook_execution_decision, AutoHookExecutionAction, AutoHookExecutionDecisionInput,
    };

    #[test]
    fn plans_match_and_empty_materialized_outcomes() {
        let matched = plan_auto_hook_execution_decision(AutoHookExecutionDecisionInput {
            hook_id: "stop_message_auto".to_string(),
            phase: "default".to_string(),
            priority: 40,
            queue: "A_optional".to_string(),
            queue_index: 1,
            queue_total: 2,
            outcome: None,
            has_planned_result: true,
            has_materialized_result: true,
            message: None,
            flow_id: None,
            materialized_flow_id: Some("stop_message_flow".to_string()),
        });
        assert_eq!(matched.action, AutoHookExecutionAction::ReturnResult);
        assert_eq!(matched.trace_event.result, "match");
        assert_eq!(matched.trace_event.reason, "matched");
        assert_eq!(
            matched.trace_event.flow_id.as_deref(),
            Some("stop_message_flow")
        );

        let empty = plan_auto_hook_execution_decision(AutoHookExecutionDecisionInput {
            hook_id: "vision_auto".to_string(),
            phase: "pre".to_string(),
            priority: 20,
            queue: "A_optional".to_string(),
            queue_index: 1,
            queue_total: 2,
            outcome: None,
            has_planned_result: true,
            has_materialized_result: false,
            message: None,
            flow_id: None,
            materialized_flow_id: None,
        });
        assert_eq!(empty.action, AutoHookExecutionAction::ContinueQueue);
        assert_eq!(empty.trace_event.result, "miss");
        assert_eq!(empty.trace_event.reason, "empty_materialized_result");
    }

    #[test]
    fn plans_error_and_planned_null_outcomes() {
        let planned_null = plan_auto_hook_execution_decision(AutoHookExecutionDecisionInput {
            hook_id: "vision_auto".to_string(),
            phase: "default".to_string(),
            priority: 20,
            queue: "A_optional".to_string(),
            queue_index: 1,
            queue_total: 1,
            outcome: None,
            has_planned_result: false,
            has_materialized_result: false,
            message: None,
            flow_id: None,
            materialized_flow_id: None,
        });
        assert_eq!(planned_null.action, AutoHookExecutionAction::ContinueQueue);
        assert_eq!(planned_null.trace_event.reason, "predicate_false");

        let error = plan_auto_hook_execution_decision(AutoHookExecutionDecisionInput {
            hook_id: "stop_message_auto".to_string(),
            phase: "default".to_string(),
            priority: 40,
            queue: "A_optional".to_string(),
            queue_index: 1,
            queue_total: 1,
            outcome: None,
            has_planned_result: false,
            has_materialized_result: false,
            message: Some("optional-hook-boom".to_string()),
            flow_id: None,
            materialized_flow_id: None,
        });
        assert_eq!(error.action, AutoHookExecutionAction::RethrowError);
        assert_eq!(error.trace_event.result, "error");
        assert_eq!(error.trace_event.reason, "optional-hook-boom");
    }

    #[test]
    fn keeps_legacy_explicit_outcome_compatibility() {
        let explicit = plan_auto_hook_execution_decision(AutoHookExecutionDecisionInput {
            hook_id: "legacy".to_string(),
            phase: "default".to_string(),
            priority: 1,
            queue: "A_optional".to_string(),
            queue_index: 1,
            queue_total: 1,
            outcome: Some("planned_null".to_string()),
            has_planned_result: true,
            has_materialized_result: true,
            message: None,
            flow_id: Some("legacy_flow".to_string()),
            materialized_flow_id: Some("ignored".to_string()),
        });
        assert_eq!(explicit.action, AutoHookExecutionAction::ContinueQueue);
        assert_eq!(explicit.trace_event.reason, "predicate_false");
    }
}
