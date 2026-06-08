use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::outcome_contract::classify_servertool_outcome;

/// The result of projecting a client exec_command result back to model-side tool result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolNameProjectionResult {
    /// The original servertool tool name (e.g. "stop_message_auto")
    pub original_tool_name: String,
    /// The projected model-side tool result content
    pub tool_result: Value,
    /// Whether the projection was successful
    pub projected: bool,
    /// Reason for projection failure (if any)
    pub error: Option<String>,
}

/// Project a client exec_command result back to model-side original tool name.
///
/// This is the Rust owner of req_chatprocess 03 tool name conversion:
/// client exec_command result → model-side original tool name.
///
/// Input: the raw output from `routecodex-servertool run <toolName> --input-json <json>`
/// Output: the projected model-side tool result
pub fn project_exec_command_result_to_model_tool_result(
    raw_output: &str,
) -> ToolNameProjectionResult {
    // Parse the CLI output JSON
    let value: Value = match serde_json::from_str(raw_output) {
        Ok(v) => v,
        Err(_) => {
            return ToolNameProjectionResult {
                original_tool_name: String::new(),
                tool_result: Value::Null,
                projected: false,
                error: Some("exec_command_output_not_valid_json".to_string()),
            };
        }
    };

    if !value.is_object() {
        return ToolNameProjectionResult {
            original_tool_name: String::new(),
            tool_result: Value::Null,
            projected: false,
            error: Some("exec_command_output_not_object".to_string()),
        };
    }

    // Extract tool_name from CLI output
    let tool_name = match value.get("toolName").and_then(|v| v.as_str()) {
        Some(name) => name.to_string(),
        None => {
            return ToolNameProjectionResult {
                original_tool_name: String::new(),
                tool_result: Value::Null,
                projected: false,
                error: Some("exec_command_output_missing_tool_name".to_string()),
            };
        }
    };

    // Validate tool_name is a known servertool with ClientExecCliProjection outcome
    let outcome = classify_servertool_outcome(&tool_name);
    if outcome != Some(crate::outcome_contract::ServertoolOutcome::ClientExecCliProjection) {
        return ToolNameProjectionResult {
            original_tool_name: tool_name,
            tool_result: Value::Null,
            projected: false,
            error: Some("tool_not_client_exec_cli_projection".to_string()),
        };
    }

    // Extract flow_id and validate
    let flow_id = match value.get("flowId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            return ToolNameProjectionResult {
                original_tool_name: tool_name,
                tool_result: Value::Null,
                projected: false,
                error: Some("exec_command_output_missing_flow_id".to_string()),
            };
        }
    };

    if flow_id != "stop_message_flow" {
        return ToolNameProjectionResult {
            original_tool_name: tool_name,
            tool_result: Value::Null,
            projected: false,
            error: Some("exec_command_output_invalid_flow_id".to_string()),
        };
    }

    // Build model-side tool result
    // The model sees the original tool name and the CLI output content
    let model_result = serde_json::json!({
        "toolName": tool_name,
        "flowId": flow_id,
        "repeatCount": value.get("repeatCount").and_then(|v| v.as_u64()).unwrap_or(0),
        "maxRepeats": value.get("maxRepeats").and_then(|v| v.as_u64()).unwrap_or(0),
        "continuationPrompt": value.get("continuationPrompt").and_then(|v| v.as_str()).unwrap_or(""),
        "projected": true
    });

    ToolNameProjectionResult {
        original_tool_name: tool_name,
        tool_result: model_result,
        projected: true,
        error: None,
    }
}

/// Validate that an exec_command result is from a known servertool
/// and not a fake_exec or old restoration marker.
pub fn validate_exec_command_result_for_projection(raw_output: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(raw_output)
        .map_err(|_| "exec_command_output_not_valid_json".to_string())?;

    let tool_name = value
        .get("toolName")
        .and_then(|v| v.as_str())
        .ok_or("exec_command_output_missing_tool_name")?;

    // Deny fake_exec
    if tool_name == "fake_exec" {
        return Err("tool_name_denied_fake_exec".to_string());
    }

    // Check for denied CLI markers in the output
    if raw_output.contains("--ticket")
        || raw_output.contains("stcli_")
        || raw_output.contains("rcc_cli_")
    {
        return Err("exec_command_output_contains_denied_marker".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn projects_stop_message_auto_correctly() {
        let cli_output = json!({
            "toolName": "stop_message_auto",
            "flowId": "stop_message_flow",
            "continuationPrompt": "continue with schema",
            "repeatCount": 1,
            "maxRepeats": 3,
            "schemaGuidance": { "requiredFields": ["stopreason"] }
        });

        let result = project_exec_command_result_to_model_tool_result(&cli_output.to_string());
        assert!(result.projected);
        assert_eq!(result.original_tool_name, "stop_message_auto");
        assert_eq!(result.tool_result["toolName"], "stop_message_auto");
        assert_eq!(result.tool_result["flowId"], "stop_message_flow");
        assert!(result.error.is_none());
    }

    #[test]
    fn rejects_invalid_json() {
        let result = project_exec_command_result_to_model_tool_result("not json");
        assert!(!result.projected);
        assert!(result.error.as_ref().unwrap().contains("not_valid_json"));
    }

    #[test]
    fn rejects_missing_tool_name() {
        let cli_output = json!({"flowId": "stop_message_flow"});
        let result = project_exec_command_result_to_model_tool_result(&cli_output.to_string());
        assert!(!result.projected);
        assert!(result.error.as_ref().unwrap().contains("missing_tool_name"));
    }

    #[test]
    fn rejects_web_search_not_client_exec() {
        let cli_output = json!({
            "toolName": "web_search",
            "flowId": "stop_message_flow"
        });
        let result = project_exec_command_result_to_model_tool_result(&cli_output.to_string());
        assert!(!result.projected);
        assert!(result
            .error
            .as_ref()
            .unwrap()
            .contains("not_client_exec_cli_projection"));
    }

    #[test]
    fn rejects_wrong_flow_id() {
        let cli_output = json!({
            "toolName": "stop_message_auto",
            "flowId": "wrong_flow"
        });
        let result = project_exec_command_result_to_model_tool_result(&cli_output.to_string());
        assert!(!result.projected);
        assert!(result.error.as_ref().unwrap().contains("invalid_flow_id"));
    }

    #[test]
    fn validate_rejects_fake_exec() {
        let output = json!({"toolName": "fake_exec", "flowId": "stop_message_flow"});
        let err = validate_exec_command_result_for_projection(&output.to_string()).unwrap_err();
        assert!(err.contains("denied_fake_exec"));
    }

    #[test]
    fn validate_rejects_ticket_marker() {
        let output = json!({"toolName": "stop_message_auto", "flowId": "stop_message_flow", "extra": "--ticket abc"});
        let err = validate_exec_command_result_for_projection(&output.to_string()).unwrap_err();
        assert!(err.contains("denied_marker"));
    }

    #[test]
    fn validate_accepts_clean_output() {
        let output = json!({"toolName": "stop_message_auto", "flowId": "stop_message_flow"});
        assert!(validate_exec_command_result_for_projection(&output.to_string()).is_ok());
    }

    #[test]
    fn projection_rejects_non_object() {
        let result = project_exec_command_result_to_model_tool_result("[1,2,3]");
        assert!(!result.projected);
        assert!(result.error.as_ref().unwrap().contains("not_object"));
    }

    #[test]
    fn projection_rejects_null() {
        let result = project_exec_command_result_to_model_tool_result("null");
        assert!(!result.projected);
    }
}
