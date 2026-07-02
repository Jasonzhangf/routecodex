use serde::{Deserialize, Serialize};

use crate::auto_hook_execution_contract::{
    plan_auto_hook_execution_decision, AutoHookExecutionAction, AutoHookExecutionDecisionInput,
    AutoHookTraceEventPlan,
};

// feature_id: hub.servertool_auto_hook_execution

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoHookRuntimeAttemptInput {
    pub hook_id: String,
    pub phase: String,
    pub priority: i64,
    pub queue: String,
    pub queue_index: i64,
    pub queue_total: i64,
    #[serde(default)]
    pub has_planned_result: bool,
    #[serde(default)]
    pub has_materialized_result: bool,
    #[serde(default)]
    pub error: Option<serde_json::Value>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub materialized_flow_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoHookRuntimeAttemptPlan {
    pub action: AutoHookRuntimeAttemptAction,
    pub trace_event: AutoHookTraceEventPlan,
    pub return_result: bool,
    pub continue_queue: bool,
    pub rethrow_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutoHookRuntimeAttemptAction {
    ReturnResult,
    ContinueQueue,
    RethrowError,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoHookCallerFinalizationInput {
    #[serde(default)]
    pub result_present: bool,
    #[serde(default)]
    pub queue_index: i64,
    #[serde(default)]
    pub queue_total: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoHookCallerFinalizationPlan {
    pub action: AutoHookCallerFinalizationAction,
    pub return_result: bool,
    pub continue_next_queue: bool,
    pub return_null: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_mode: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutoHookCallerFinalizationAction {
    ReturnResult,
    ContinueNextQueue,
    ReturnNull,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoHookCallerResultProjectionInput {
    pub result_present: bool,
    pub metadata_write_plan_present: bool,
    #[serde(default)]
    pub chat_response: Option<serde_json::Value>,
    #[serde(default)]
    pub execution: Option<serde_json::Value>,
    #[serde(default)]
    pub metadata_write_plan: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoHookCallerResultProjectionPlan {
    pub mode: String,
    pub include_metadata_write_plan: bool,
    pub result: serde_json::Value,
}

pub fn plan_auto_hook_runtime_attempt(
    input: AutoHookRuntimeAttemptInput,
) -> AutoHookRuntimeAttemptPlan {
    let error_message = normalize_error_message(input.error.as_ref(), input.message.as_deref());
    let error_reason = error_message
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let has_error = input.error.is_some() || input.message.is_some();
    let decision = plan_auto_hook_execution_decision(AutoHookExecutionDecisionInput {
        hook_id: input.hook_id,
        phase: input.phase,
        priority: input.priority,
        queue: input.queue,
        queue_index: input.queue_index,
        queue_total: input.queue_total,
        outcome: if has_error {
            Some("error".to_string())
        } else {
            None
        },
        has_planned_result: input.has_planned_result,
        has_materialized_result: input.has_materialized_result,
        message: Some(error_reason).filter(|_| has_error),
        flow_id: None,
        materialized_flow_id: input.materialized_flow_id,
    });
    let action = match decision.action {
        AutoHookExecutionAction::ReturnResult => AutoHookRuntimeAttemptAction::ReturnResult,
        AutoHookExecutionAction::ContinueQueue => AutoHookRuntimeAttemptAction::ContinueQueue,
        AutoHookExecutionAction::RethrowError => AutoHookRuntimeAttemptAction::RethrowError,
    };
    AutoHookRuntimeAttemptPlan {
        action,
        trace_event: decision.trace_event,
        return_result: matches!(decision.action, AutoHookExecutionAction::ReturnResult),
        continue_queue: matches!(decision.action, AutoHookExecutionAction::ContinueQueue),
        rethrow_error: matches!(decision.action, AutoHookExecutionAction::RethrowError),
        error_message: if has_error { error_message } else { None },
    }
}

pub fn plan_auto_hook_caller_finalization(
    input: AutoHookCallerFinalizationInput,
) -> AutoHookCallerFinalizationPlan {
    if input.result_present {
        return AutoHookCallerFinalizationPlan {
            action: AutoHookCallerFinalizationAction::ReturnResult,
            return_result: true,
            continue_next_queue: false,
            return_null: false,
            result_mode: Some("tool_flow".to_string()),
        };
    }
    let final_queue = input.queue_total <= 0 || input.queue_index >= input.queue_total;
    if final_queue {
        return AutoHookCallerFinalizationPlan {
            action: AutoHookCallerFinalizationAction::ReturnNull,
            return_result: false,
            continue_next_queue: false,
            return_null: true,
            result_mode: None,
        };
    }
    AutoHookCallerFinalizationPlan {
        action: AutoHookCallerFinalizationAction::ContinueNextQueue,
        return_result: false,
        continue_next_queue: true,
        return_null: false,
        result_mode: None,
    }
}

pub fn plan_auto_hook_caller_result_projection(
    input: AutoHookCallerResultProjectionInput,
) -> Result<AutoHookCallerResultProjectionPlan, String> {
    if !input.result_present {
        return Err("auto-hook caller result projection requires queue result".to_string());
    }
    let chat_response = input
        .chat_response
        .ok_or_else(|| "auto-hook caller result projection requires chatResponse".to_string())?;
    let execution = input.execution.unwrap_or(serde_json::Value::Null);
    if input.metadata_write_plan_present && input.metadata_write_plan.is_none() {
        return Err("auto-hook caller result projection requires metadataWritePlan".to_string());
    }
    let mut result = serde_json::json!({
        "mode": "tool_flow",
        "finalChatResponse": chat_response,
        "execution": execution,
    });
    if input.metadata_write_plan_present {
        if let Some(metadata_write_plan) = input.metadata_write_plan {
            result["metadataWritePlan"] = metadata_write_plan;
        }
    }
    Ok(AutoHookCallerResultProjectionPlan {
        mode: "tool_flow".to_string(),
        include_metadata_write_plan: input.metadata_write_plan_present,
        result,
    })
}

fn normalize_optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_error_message(
    error: Option<&serde_json::Value>,
    legacy_message: Option<&str>,
) -> Option<String> {
    let raw = match error {
        Some(serde_json::Value::String(text)) => text.trim().to_string(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        Some(serde_json::Value::Bool(value)) => value.to_string(),
        Some(serde_json::Value::Object(object)) => object
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string(),
        _ => legacy_message.unwrap_or_default().trim().to_string(),
    };
    normalize_optional_text(raw)
}

#[cfg(test)]
mod tests {
    use super::{
        plan_auto_hook_caller_finalization, plan_auto_hook_caller_result_projection,
        plan_auto_hook_runtime_attempt, AutoHookCallerFinalizationInput,
        AutoHookCallerResultProjectionInput, AutoHookRuntimeAttemptInput,
    };

    #[test]
    fn materializes_runtime_attempt_without_ts_action_interpretation() {
        let miss = plan_auto_hook_runtime_attempt(AutoHookRuntimeAttemptInput {
            hook_id: "vision_auto".to_string(),
            phase: "default".to_string(),
            priority: 20,
            queue: "A_optional".to_string(),
            queue_index: 1,
            queue_total: 2,
            has_planned_result: false,
            has_materialized_result: false,
            error: None,
            message: None,
            materialized_flow_id: None,
        });
        assert_eq!(
            miss.action,
            super::AutoHookRuntimeAttemptAction::ContinueQueue
        );
        assert!(miss.continue_queue);
        assert!(!miss.return_result);
        assert_eq!(miss.trace_event.reason, "predicate_false");

        let matched = plan_auto_hook_runtime_attempt(AutoHookRuntimeAttemptInput {
            hook_id: "stop_message_auto".to_string(),
            phase: "default".to_string(),
            priority: 40,
            queue: "A_optional".to_string(),
            queue_index: 2,
            queue_total: 2,
            has_planned_result: true,
            has_materialized_result: true,
            error: None,
            message: None,
            materialized_flow_id: Some("stop_message_flow".to_string()),
        });
        assert_eq!(
            matched.action,
            super::AutoHookRuntimeAttemptAction::ReturnResult
        );
        assert!(matched.return_result);
        assert!(!matched.continue_queue);
        assert_eq!(matched.trace_event.result, "match");
    }

    #[test]
    fn materializes_error_and_queue_finalization() {
        let error = plan_auto_hook_runtime_attempt(AutoHookRuntimeAttemptInput {
            hook_id: "stop_message_auto".to_string(),
            phase: "default".to_string(),
            priority: 40,
            queue: "A_optional".to_string(),
            queue_index: 1,
            queue_total: 1,
            has_planned_result: false,
            has_materialized_result: false,
            error: None,
            message: Some(" boom ".to_string()),
            materialized_flow_id: None,
        });
        assert_eq!(
            error.action,
            super::AutoHookRuntimeAttemptAction::RethrowError
        );
        assert!(error.rethrow_error);
        assert_eq!(error.error_message.as_deref(), Some("boom"));

        let blank_error = plan_auto_hook_runtime_attempt(AutoHookRuntimeAttemptInput {
            hook_id: "stop_message_auto".to_string(),
            phase: "default".to_string(),
            priority: 40,
            queue: "A_optional".to_string(),
            queue_index: 1,
            queue_total: 1,
            has_planned_result: false,
            has_materialized_result: false,
            error: None,
            message: Some("   ".to_string()),
            materialized_flow_id: None,
        });
        assert!(blank_error.rethrow_error);
        assert_eq!(blank_error.trace_event.reason, "unknown");
        assert_eq!(blank_error.error_message, None);

        let object_error = plan_auto_hook_runtime_attempt(AutoHookRuntimeAttemptInput {
            hook_id: "stop_message_auto".to_string(),
            phase: "default".to_string(),
            priority: 40,
            queue: "A_optional".to_string(),
            queue_index: 1,
            queue_total: 1,
            has_planned_result: false,
            has_materialized_result: false,
            error: Some(serde_json::json!({ "message": " boom-from-error-object " })),
            message: None,
            materialized_flow_id: None,
        });
        assert!(object_error.rethrow_error);
        assert_eq!(object_error.trace_event.reason, "boom-from-error-object");
        assert_eq!(
            object_error.error_message.as_deref(),
            Some("boom-from-error-object")
        );

        let next = plan_auto_hook_caller_finalization(AutoHookCallerFinalizationInput {
            result_present: false,
            queue_index: 1,
            queue_total: 2,
        });
        assert_eq!(
            next.action,
            super::AutoHookCallerFinalizationAction::ContinueNextQueue
        );
        assert!(next.continue_next_queue);
        assert_eq!(next.result_mode, None);

        let result = plan_auto_hook_caller_finalization(AutoHookCallerFinalizationInput {
            result_present: true,
            queue_index: 1,
            queue_total: 2,
        });
        assert_eq!(
            result.action,
            super::AutoHookCallerFinalizationAction::ReturnResult
        );
        assert_eq!(result.result_mode.as_deref(), Some("tool_flow"));

        let done = plan_auto_hook_caller_finalization(AutoHookCallerFinalizationInput {
            result_present: false,
            queue_index: 2,
            queue_total: 2,
        });
        assert_eq!(
            done.action,
            super::AutoHookCallerFinalizationAction::ReturnNull
        );
        assert!(done.return_null);

        let malformed = plan_auto_hook_caller_finalization(AutoHookCallerFinalizationInput {
            result_present: false,
            queue_index: 0,
            queue_total: 0,
        });
        assert_eq!(
            malformed.action,
            super::AutoHookCallerFinalizationAction::ReturnNull
        );
        assert!(malformed.return_null);

        let projection = plan_auto_hook_caller_result_projection(
            AutoHookCallerResultProjectionInput {
                result_present: true,
                metadata_write_plan_present: true,
                chat_response: Some(serde_json::json!({ "choices": [] })),
                execution: Some(serde_json::json!({ "flowId": "auto-hook" })),
                metadata_write_plan: Some(serde_json::json!({
                    "runtimeControl": { "servertool": true }
                })),
            },
        )
        .expect("projection");
        assert_eq!(projection.mode, "tool_flow");
        assert!(projection.include_metadata_write_plan);
        assert_eq!(projection.result["mode"], "tool_flow");
        assert_eq!(projection.result["finalChatResponse"], serde_json::json!({ "choices": [] }));
        assert_eq!(projection.result["execution"], serde_json::json!({ "flowId": "auto-hook" }));
        assert_eq!(
            projection.result["metadataWritePlan"],
            serde_json::json!({ "runtimeControl": { "servertool": true } })
        );

        let missing_chat_response = plan_auto_hook_caller_result_projection(
            AutoHookCallerResultProjectionInput {
                result_present: true,
                metadata_write_plan_present: false,
                chat_response: None,
                execution: None,
                metadata_write_plan: None,
            },
        );
        assert_eq!(
            missing_chat_response.expect_err("missing chat response"),
            "auto-hook caller result projection requires chatResponse"
        );

        let missing_metadata_write_plan = plan_auto_hook_caller_result_projection(
            AutoHookCallerResultProjectionInput {
                result_present: true,
                metadata_write_plan_present: true,
                chat_response: Some(serde_json::json!({ "choices": [] })),
                execution: None,
                metadata_write_plan: None,
            },
        );
        assert_eq!(
            missing_metadata_write_plan.expect_err("missing metadata write plan"),
            "auto-hook caller result projection requires metadataWritePlan"
        );

        let missing = plan_auto_hook_caller_result_projection(
            AutoHookCallerResultProjectionInput {
                result_present: false,
                metadata_write_plan_present: false,
                chat_response: None,
                execution: None,
                metadata_write_plan: None,
            },
        );
        assert_eq!(
            missing.expect_err("missing queue result"),
            "auto-hook caller result projection requires queue result"
        );
    }
}
