use crate::outcome_contract::{
    is_client_exec_cli_projection, is_denied_cli_projection, quote_posix_single_argument,
    DENIED_CLI_MARKERS,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolCliRunInput {
    pub tool_name: String,
    pub input: Value,
    pub flow_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolCliRunOutput {
    pub ok: bool,
    pub kind: String,
    pub tool: String,
    pub summary: String,
    pub tool_name: String,
    pub flow_id: String,
    pub input: Value,
    pub exec_command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolCliProjectionToolArgumentsInput {
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServertoolCliError {
    UnsupportedTool(String),
    DeniedTool(String),
    DeniedMarker(&'static str),
    DeniedInternalCarrier(&'static str),
    MissingField(&'static str),
    InvalidField(&'static str),
}

impl std::fmt::Display for ServertoolCliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedTool(tool) => write!(f, "SERVERTOOL_UNSUPPORTED_TOOL: {tool}"),
            Self::DeniedTool(tool) => write!(f, "SERVERTOOL_DENIED_TOOL: {tool}"),
            Self::DeniedMarker(marker) => write!(f, "SERVERTOOL_DENIED_CLI_MARKER: {marker}"),
            Self::DeniedInternalCarrier(carrier) => {
                write!(f, "SERVERTOOL_DENIED_INTERNAL_CARRIER: {carrier}")
            }
            Self::MissingField(field) => write!(f, "SERVERTOOL_CLI_MISSING_FIELD: {field}"),
            Self::InvalidField(field) => write!(f, "SERVERTOOL_CLI_INVALID_FIELD: {field}"),
        }
    }
}

impl std::error::Error for ServertoolCliError {}

pub fn build_servertool_cli_binary_run_command_from_client_exec_result(
    input: ServertoolCliRunInput,
) -> Result<ServertoolCliRunOutput, ServertoolCliError> {
    validate_tool_input(&input.tool_name, &input.input)?;
    if !is_client_exec_cli_projection(&input.tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(input.tool_name));
    }
    let flow_id = input
        .flow_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("servertool_cli_projection")
        .to_string();
    let input_json = serde_json::to_string(&input.input)
        .map_err(|_| ServertoolCliError::InvalidField("inputJson"))?;
    let exec_command = format!(
        "routecodex servertool run {} --input-json {}",
        input.tool_name,
        quote_posix_single_argument(&input_json)
    );
    validate_no_denied_cli_marker(&exec_command)?;
    Ok(ServertoolCliRunOutput {
        ok: true,
        kind: "client_exec_cli_projection".to_string(),
        tool: input.tool_name.clone(),
        summary: format!("servertool {} projected to exec_command", input.tool_name),
        tool_name: input.tool_name,
        flow_id,
        input: input.input,
        exec_command,
        session_id: input.session_id,
        request_id: input.request_id,
    })
}

pub fn build_client_exec_cli_projection_output(
    tool_name: &str,
    flow_id: &str,
    input: Value,
) -> Result<Value, ServertoolCliError> {
    validate_tool_input(tool_name, &input)?;
    if !is_client_exec_cli_projection(tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(tool_name.to_string()));
    }
    let input_json =
        serde_json::to_string(&input).map_err(|_| ServertoolCliError::InvalidField("input"))?;
    let exec_command = format!(
        "routecodex servertool run {tool_name} --input-json {}",
        quote_posix_single_argument(&input_json)
    );
    validate_no_denied_cli_marker(&exec_command)?;
    let mut output = serde_json::json!({
        "toolName": tool_name,
        "flowId": flow_id,
        "execCommand": exec_command
    });
    if tool_name == "web_search" {
        output["routeHint"] = Value::String("web_search".to_string());
    }
    Ok(output)
}

pub fn parse_servertool_cli_projection_tool_arguments(
    input: ServertoolCliProjectionToolArgumentsInput,
) -> Result<Value, ServertoolCliError> {
    if input.arguments.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let parsed: Value = serde_json::from_str(&input.arguments)
        .map_err(|_| ServertoolCliError::InvalidField("arguments"))?;
    if parsed.is_object() {
        Ok(parsed)
    } else {
        Err(ServertoolCliError::InvalidField("arguments"))
    }
}

pub fn validate_client_exec_command_result(raw_output: &str) -> Result<Value, ServertoolCliError> {
    validate_no_denied_cli_marker(raw_output)?;
    let value: Value = serde_json::from_str(raw_output)
        .map_err(|_| ServertoolCliError::InvalidField("exec_command_output"))?;
    let record = value
        .as_object()
        .ok_or(ServertoolCliError::InvalidField("exec_command_output"))?;
    validate_no_internal_carrier(&value)?;
    let tool_name = record
        .get("toolName")
        .and_then(Value::as_str)
        .ok_or(ServertoolCliError::MissingField("toolName"))?;
    if !is_client_exec_cli_projection(tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(tool_name.to_string()));
    }
    if record.get("flowId").and_then(Value::as_str).is_none() {
        return Err(ServertoolCliError::MissingField("flowId"));
    }
    Ok(value)
}

fn validate_tool_input(tool_name: &str, input: &Value) -> Result<(), ServertoolCliError> {
    validate_no_denied_cli_marker(tool_name)?;
    if !tool_name
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || matches!(value, '_' | '-'))
    {
        return Err(ServertoolCliError::InvalidField("toolName"));
    }
    if is_denied_cli_projection(tool_name) {
        return Err(ServertoolCliError::DeniedTool(tool_name.to_string()));
    }
    if !input.is_object() {
        return Err(ServertoolCliError::InvalidField("input"));
    }
    let serialized =
        serde_json::to_string(input).map_err(|_| ServertoolCliError::InvalidField("input"))?;
    validate_no_denied_cli_marker(&serialized)?;
    validate_no_internal_carrier(input)
}

fn validate_no_denied_cli_marker(raw: &str) -> Result<(), ServertoolCliError> {
    for marker in DENIED_CLI_MARKERS {
        if raw.contains(marker) {
            return Err(ServertoolCliError::DeniedMarker(marker));
        }
    }
    Ok(())
}

const DENIED_INTERNAL_CARRIER_KEYS: &[&str] = &[
    "__rt",
    "__raw_request_body",
    "__servertool_cli_projection",
    "metadata",
    "metaCarrier",
    "snapshot",
    "debug",
    "debugCarrier",
    "ticket",
    "restorationHandle",
    "restorationStore",
    "reenterPipeline",
    "providerInvoker",
    "serverToolFollowup",
    "serverToolFollowupSource",
];

fn validate_no_internal_carrier(value: &Value) -> Result<(), ServertoolCliError> {
    match value {
        Value::Object(record) => {
            for (key, item) in record {
                if let Some(marker) = DENIED_INTERNAL_CARRIER_KEYS
                    .iter()
                    .copied()
                    .find(|marker| *marker == key)
                {
                    return Err(ServertoolCliError::DeniedInternalCarrier(marker));
                }
                validate_no_internal_carrier(item)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_no_internal_carrier(item)?;
            }
        }
        Value::String(text) => {
            for marker in DENIED_INTERNAL_CARRIER_KEYS {
                if text.contains(marker) {
                    return Err(ServertoolCliError::DeniedInternalCarrier(marker));
                }
            }
        }
        _ => {}
    }
    Ok(())
}
