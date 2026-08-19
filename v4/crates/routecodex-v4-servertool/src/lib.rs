use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServertoolRunInput {
    pub tool_name: String,
    pub input: Value,
    pub flow_id: Option<String>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRunOutput {
    pub tool_name: String,
    pub route_hint: String,
    pub input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ServertoolError {
    #[error("SERVERTOOL_CLI_INVALID_FIELD: tool name must not be blank")]
    ToolName,
    #[error("SERVERTOOL_CLI_INVALID_FIELD: --input-json must be an object")]
    InputObject,
}

pub fn build_run_output(input: ServertoolRunInput) -> Result<ServertoolRunOutput, ServertoolError> {
    if input.tool_name.trim().is_empty() {
        return Err(ServertoolError::ToolName);
    }
    if !input.input.is_object() {
        return Err(ServertoolError::InputObject);
    }
    Ok(ServertoolRunOutput {
        route_hint: input.tool_name.clone(),
        tool_name: input.tool_name,
        input: input.input,
        flow_id: input.flow_id,
        session_id: input.session_id,
        request_id: input.request_id,
    })
}
