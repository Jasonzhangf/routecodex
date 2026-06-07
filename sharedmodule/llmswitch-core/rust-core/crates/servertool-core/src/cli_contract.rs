use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::outcome_contract::is_client_exec_cli_projection;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolCliRunInput {
    pub tool_name: String,
    pub input: Value,
    pub flow_id: Option<String>,
    pub repeat_count: Option<u32>,
    pub max_repeats: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolCliRunOutput {
    pub tool_name: String,
    pub flow_id: String,
    pub continuation_prompt: String,
    pub repeat_count: u32,
    pub max_repeats: u32,
    pub schema_guidance: StoplessSchemaGuidance,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoplessSchemaGuidance {
    pub required_fields: Vec<String>,
    pub stopreason_values: StopreasonValues,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopreasonValues {
    pub finished: u8,
    pub blocked: u8,
    pub continue_needed: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServertoolCliError {
    UnsupportedTool(String),
    MissingField(&'static str),
    InvalidField(&'static str),
}

impl std::fmt::Display for ServertoolCliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServertoolCliError::UnsupportedTool(tool) => {
                write!(f, "SERVERTOOL_UNSUPPORTED_TOOL: {tool}")
            }
            ServertoolCliError::MissingField(field) => {
                write!(f, "SERVERTOOL_CLI_MISSING_FIELD: {field}")
            }
            ServertoolCliError::InvalidField(field) => {
                write!(f, "SERVERTOOL_CLI_INVALID_FIELD: {field}")
            }
        }
    }
}

impl std::error::Error for ServertoolCliError {}

pub fn build_servertool_cli_binary_run_command_from_client_exec_result(
    input: ServertoolCliRunInput,
) -> Result<ServertoolCliRunOutput, ServertoolCliError> {
    match input.tool_name.as_str() {
        "stop_message_auto" => build_stop_message_auto_run_output(input),
        other => Err(ServertoolCliError::UnsupportedTool(other.to_string())),
    }
}

fn build_stop_message_auto_run_output(
    input: ServertoolCliRunInput,
) -> Result<ServertoolCliRunOutput, ServertoolCliError> {
    let flow_id = input
        .flow_id
        .as_deref()
        .map(|value| non_empty(Some(value), "flowId"))
        .transpose()?
        .or_else(|| read_non_empty_string(&input.input, "flowId").ok())
        .ok_or(ServertoolCliError::MissingField("flowId"))?;
    if flow_id != "stop_message_flow" {
        return Err(ServertoolCliError::InvalidField("flowId"));
    }
    let continuation_prompt = read_non_empty_string(&input.input, "continuationPrompt")?;
    let repeat_count = input
        .repeat_count
        .or_else(|| read_u32(&input.input, "repeatCount"))
        .ok_or(ServertoolCliError::MissingField("repeatCount"))?;
    let max_repeats = input
        .max_repeats
        .or_else(|| read_u32(&input.input, "maxRepeats"))
        .ok_or(ServertoolCliError::MissingField("maxRepeats"))?;
    if max_repeats == 0 || repeat_count > max_repeats {
        return Err(ServertoolCliError::InvalidField("repeatCount/maxRepeats"));
    }
    Ok(ServertoolCliRunOutput {
        tool_name: input.tool_name,
        flow_id,
        continuation_prompt,
        repeat_count,
        max_repeats,
        schema_guidance: stopless_schema_guidance(),
        input: input.input,
    })
}

pub fn stopless_schema_guidance() -> StoplessSchemaGuidance {
    StoplessSchemaGuidance {
        required_fields: vec![
            "stopreason".to_string(),
            "reason".to_string(),
            "has_evidence".to_string(),
            "evidence".to_string(),
            "issue_cause".to_string(),
            "excluded_factors".to_string(),
            "diagnostic_order".to_string(),
            "done_steps".to_string(),
            "next_step".to_string(),
            "next_suggested_path".to_string(),
            "needs_user_input".to_string(),
            "learned".to_string(),
        ],
        stopreason_values: StopreasonValues {
            finished: 0,
            blocked: 1,
            continue_needed: 2,
        },
    }
}

fn non_empty(raw: Option<&str>, field: &'static str) -> Result<String, ServertoolCliError> {
    let value = raw
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or(ServertoolCliError::MissingField(field))?;
    Ok(value.to_string())
}

fn read_non_empty_string(value: &Value, field: &'static str) -> Result<String, ServertoolCliError> {
    let Some(raw) = value.get(field).and_then(Value::as_str) else {
        return Err(ServertoolCliError::MissingField(field));
    };
    non_empty(Some(raw), field)
}

fn read_u32(value: &Value, field: &'static str) -> Option<u32> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}


pub fn build_client_exec_cli_projection_output(
    tool_name: &str,
    flow_id: &str,
    input: Value,
    repeat_count: u32,
    max_repeats: u32,
) -> Result<Value, ServertoolCliError> {
    if !is_client_exec_cli_projection(tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(tool_name.to_string()));
    }
    if tool_name == "stop_message_auto" {
        if flow_id != "stop_message_flow" {
            return Err(ServertoolCliError::InvalidField("flowId"));
        }
        let continuation_prompt = read_non_empty_string(&input, "continuationPrompt")?;
        let cmd = format!(
            "routecodex servertool run {} --input-json '{}'",
            tool_name,
            serde_json::to_string(&serde_json::json!({
                "flowId": flow_id,
                "continuationPrompt": continuation_prompt,
                "repeatCount": repeat_count,
                "maxRepeats": max_repeats
            })).map_err(|_| ServertoolCliError::InvalidField("json"))?
        );
        return Ok(serde_json::json!({
            "toolName": tool_name,
            "flowId": flow_id,
            "continuationPrompt": continuation_prompt,
            "repeatCount": repeat_count,
            "maxRepeats": max_repeats,
            "schemaGuidance": stopless_schema_guidance(),
            "execCommand": cmd
        }));
    }

    let cmd = format!(
        "routecodex servertool run {} --input-json '{}'",
        tool_name,
        serde_json::to_string(&input).map_err(|_| ServertoolCliError::InvalidField("json"))?
    );
    Ok(serde_json::json!({
        "toolName": tool_name,
        "flowId": flow_id,
        "repeatCount": repeat_count,
        "maxRepeats": max_repeats,
        "execCommand": cmd
    }))
}

pub fn validate_client_exec_command_result(raw_output: &str) -> Result<Value, ServertoolCliError> {
    let value: Value = serde_json::from_str(raw_output)
        .map_err(|_| ServertoolCliError::InvalidField("exec_command_output"))?;
    if !value.is_object() {
        return Err(ServertoolCliError::InvalidField("exec_command_output"));
    }
    let tool_name = value.get("toolName")
        .and_then(|v| v.as_str())
        .ok_or(ServertoolCliError::MissingField("toolName"))?;
    let flow_id = value.get("flowId")
        .and_then(|v| v.as_str())
        .ok_or(ServertoolCliError::MissingField("flowId"))?;
    if !is_client_exec_cli_projection(tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(tool_name.to_string()));
    }
    if tool_name == "stop_message_auto" && flow_id != "stop_message_flow" {
        return Err(ServertoolCliError::InvalidField("flowId"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_stop_message_auto_cli_output() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "continuationPrompt": "continue with schema",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
            },
        )
        .expect("stop_message_auto output");
        assert_eq!(output.tool_name, "stop_message_auto");
        assert_eq!(output.flow_id, "stop_message_flow");
        assert_eq!(output.repeat_count, 1);
        assert!(output
            .schema_guidance
            .required_fields
            .contains(&"stopreason".to_string()));
    }

    #[test]
    fn missing_continuation_prompt_fails_fast() {
        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({ "repeatCount": 1, "maxRepeats": 3 }),
                flow_id: Some("stop_message_flow".to_string()),
                repeat_count: None,
                max_repeats: None,
            },
        )
        .expect_err("missing prompt must fail");
        assert_eq!(err, ServertoolCliError::MissingField("continuationPrompt"));
    }

    #[test]
    fn web_search_is_not_client_exec_cli_projection() {
        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "web_search".to_string(),
                input: json!({}),
                flow_id: Some("stop_message_flow".to_string()),
                repeat_count: Some(1),
                max_repeats: Some(3),
            },
        )
        .expect_err("web_search must not be CLI projection");
        assert_eq!(err, ServertoolCliError::UnsupportedTool("web_search".to_string()));
    }

    #[test]
    fn projection_output_is_rust_owned_schema() {
        let out = build_client_exec_cli_projection_output(
            "stop_message_auto",
            "stop_message_flow",
            json!({"continuationPrompt":"continue","repeatCount":2,"maxRepeats":5}),
            2,
            5,
        )
        .expect("projection output");
        assert_eq!(out["toolName"], "stop_message_auto");
        assert_eq!(out["flowId"], "stop_message_flow");
        assert_eq!(out["repeatCount"], 2);
        assert_eq!(out["maxRepeats"], 5);
        assert_eq!(out["schemaGuidance"]["stopreasonValues"]["finished"], 0);
        let cmd = out["execCommand"].as_str().unwrap();
        assert!(cmd.contains("routecodex servertool run"));
        assert!(!cmd.contains("stcli_"), "no old stcli_ marker");
        assert!(!cmd.contains("rcc_cli_"), "no old rcc_cli_ marker");
        assert!(!cmd.contains("--ticket"), "no --ticket marker");
    }

    #[test]
    fn projection_rejects_fake_exec_and_web_search() {
        assert_eq!(
            build_client_exec_cli_projection_output("web_search", "stop_message_flow", json!({}), 1, 3),
            Err(ServertoolCliError::UnsupportedTool("web_search".to_string()))
        );
        assert_eq!(
            build_client_exec_cli_projection_output("fake_exec", "stop_message_flow", json!({}), 1, 3),
            Err(ServertoolCliError::UnsupportedTool("fake_exec".to_string()))
        );
    }

    #[test]
    fn projection_output_supports_servertool_fixture_without_stopless_schema() {
        let out = build_client_exec_cli_projection_output(
            "servertool_fixture",
            "servertool_cli_projection",
            json!({"value":1}),
            0,
            0,
        )
        .expect("fixture projection output");
        assert_eq!(out["toolName"], "servertool_fixture");
        assert_eq!(out["flowId"], "servertool_cli_projection");
        assert_eq!(
            out["execCommand"].as_str(),
            Some("routecodex servertool run servertool_fixture --input-json '{\"value\":1}'")
        );
        assert!(out.get("schemaGuidance").is_none());
    }

    #[test]
    fn exec_result_validation_accepts_valid_stop_message_auto() {
        let raw = json!({
            "toolName": "stop_message_auto",
            "flowId": "stop_message_flow",
            "continuationPrompt": "continue",
            "repeatCount": 1,
            "maxRepeats": 3
        });
        let parsed = validate_client_exec_command_result(&raw.to_string()).expect("valid result");
        assert_eq!(parsed["toolName"], "stop_message_auto");
    }

    #[test]
    fn exec_result_validation_rejects_wrong_tool_name() {
        let raw = json!({"toolName": "web_search", "flowId": "stop_message_flow"});
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::UnsupportedTool("web_search".to_string()))
        );
    }

    #[test]
    fn exec_result_validation_rejects_wrong_flow_id() {
        let raw = json!({"toolName": "stop_message_auto", "flowId": "wrong_flow"});
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::InvalidField("flowId"))
        );
    }

    #[test]
    fn exec_result_validation_accepts_servertool_fixture() {
        let raw = json!({"toolName": "servertool_fixture", "flowId": "servertool_cli_projection"});
        let parsed = validate_client_exec_command_result(&raw.to_string()).expect("valid result");
        assert_eq!(parsed["toolName"], "servertool_fixture");
    }
}
