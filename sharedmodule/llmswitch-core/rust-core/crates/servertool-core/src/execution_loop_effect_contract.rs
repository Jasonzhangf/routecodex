// feature_id: hub.servertool_execution_loop_effect_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionLoopEffectToolCallInput {
    pub id: String,
    pub name: String,
    pub arguments: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strip_after_execute: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionLoopEffectExecutionSummary {
    pub flow_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionLoopEffectInput {
    pub mode: String,
    pub tool_call: ServertoolExecutionLoopEffectToolCallInput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub noop_flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handler_error_message: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionLoopEffectPlan {
    pub tool_call: ServertoolExecutionLoopEffectToolCallInput,
    pub execution: ServertoolExecutionLoopEffectExecutionSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handler_error_message: Option<String>,
}

pub fn plan_servertool_execution_loop_effect(
    input: ServertoolExecutionLoopEffectInput,
) -> ServertoolExecutionLoopEffectPlan {
    let tool_name = input.tool_call.name.trim().to_string();
    let tool_arguments = input.tool_call.arguments.trim().to_string();
    let normalized_mode = input.mode.trim();

    if normalized_mode == "handler_error" {
        return ServertoolExecutionLoopEffectPlan {
            tool_call: ServertoolExecutionLoopEffectToolCallInput {
                id: input.tool_call.id.trim().to_string(),
                name: tool_name.clone(),
                arguments: tool_arguments,
                execution_mode: input.tool_call.execution_mode.clone(),
                strip_after_execute: input.tool_call.strip_after_execute,
            },
            execution: ServertoolExecutionLoopEffectExecutionSummary {
                flow_id: format!("{tool_name}_error"),
            },
            handler_error_message: Some(normalize_handler_error_message(
                input.handler_error_message.as_ref(),
            )),
        };
    }

    ServertoolExecutionLoopEffectPlan {
        tool_call: ServertoolExecutionLoopEffectToolCallInput {
            id: input.tool_call.id.trim().to_string(),
            name: tool_name,
            arguments: tool_arguments,
            execution_mode: Some("noop".to_string()),
            strip_after_execute: Some(true),
        },
        execution: ServertoolExecutionLoopEffectExecutionSummary {
            flow_id: input
                .noop_flow_id
                .unwrap_or_else(|| "continue_execution_flow".to_string())
                .trim()
                .to_string(),
        },
        handler_error_message: None,
    }
}

fn normalize_handler_error_message(value: Option<&serde_json::Value>) -> String {
    let raw = match value {
        Some(serde_json::Value::String(text)) => text.trim().to_string(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        Some(serde_json::Value::Bool(value)) => value.to_string(),
        Some(serde_json::Value::Object(object)) => object
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string(),
        _ => String::new(),
    };
    if raw.is_empty() {
        "unknown".to_string()
    } else {
        raw
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_handler_error_execution_summary_from_tool_name() {
        let plan = plan_servertool_execution_loop_effect(ServertoolExecutionLoopEffectInput {
            mode: "handler_error".to_string(),
            tool_call: ServertoolExecutionLoopEffectToolCallInput {
                id: "call_1".to_string(),
                name: "web_search".to_string(),
                arguments: "{}".to_string(),
                execution_mode: Some("guarded".to_string()),
                strip_after_execute: Some(true),
            },
            noop_flow_id: None,
            handler_error_message: Some(serde_json::json!(" boom ")),
        });
        assert_eq!(plan.tool_call.execution_mode.as_deref(), Some("guarded"));
        assert_eq!(plan.execution.flow_id, "web_search_error");
        assert_eq!(plan.handler_error_message.as_deref(), Some("boom"));
    }

    #[test]
    fn plans_noop_execution_record_with_rust_owned_mode_and_strip() {
        let plan = plan_servertool_execution_loop_effect(ServertoolExecutionLoopEffectInput {
            mode: "noop".to_string(),
            tool_call: ServertoolExecutionLoopEffectToolCallInput {
                id: "call_continue".to_string(),
                name: "continue_execution".to_string(),
                arguments: "{\"summary\":\"ok\"}".to_string(),
                execution_mode: Some("guarded".to_string()),
                strip_after_execute: Some(false),
            },
            noop_flow_id: Some("continue_execution_flow".to_string()),
            handler_error_message: Some(serde_json::json!("ignored")),
        });
        assert_eq!(plan.tool_call.execution_mode.as_deref(), Some("noop"));
        assert_eq!(plan.tool_call.strip_after_execute, Some(true));
        assert_eq!(plan.execution.flow_id, "continue_execution_flow");
        assert_eq!(plan.handler_error_message, None);
    }

    #[test]
    fn defaults_empty_handler_error_message_to_unknown() {
        let plan = plan_servertool_execution_loop_effect(ServertoolExecutionLoopEffectInput {
            mode: "handler_error".to_string(),
            tool_call: ServertoolExecutionLoopEffectToolCallInput {
                id: "call_1".to_string(),
                name: "web_search".to_string(),
                arguments: "{}".to_string(),
                execution_mode: Some("guarded".to_string()),
                strip_after_execute: Some(true),
            },
            noop_flow_id: None,
            handler_error_message: Some(serde_json::json!("  ")),
        });
        assert_eq!(plan.handler_error_message.as_deref(), Some("unknown"));
    }

    #[test]
    fn normalizes_error_object_message_in_rust() {
        let plan = plan_servertool_execution_loop_effect(ServertoolExecutionLoopEffectInput {
            mode: "handler_error".to_string(),
            tool_call: ServertoolExecutionLoopEffectToolCallInput {
                id: "call_1".to_string(),
                name: "web_search".to_string(),
                arguments: "{}".to_string(),
                execution_mode: Some("guarded".to_string()),
                strip_after_execute: Some(true),
            },
            noop_flow_id: None,
            handler_error_message: Some(
                serde_json::json!({ "message": " boom-from-error-object " }),
            ),
        });
        assert_eq!(
            plan.handler_error_message.as_deref(),
            Some("boom-from-error-object")
        );
    }
}
