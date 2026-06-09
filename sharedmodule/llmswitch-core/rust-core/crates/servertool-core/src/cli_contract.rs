use crate::outcome_contract::{
    classify_servertool_outcome, is_client_exec_cli_projection, is_denied_cli_projection,
    quote_posix_single_argument, DENIED_CLI_MARKERS,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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
    pub ok: bool,
    pub kind: String,
    pub tool: String,
    pub summary: String,
    pub tool_name: String,
    pub flow_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub continuation_prompt: String,
    pub repeat_count: u32,
    pub max_repeats: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_guidance: Option<StoplessSchemaGuidance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injected_prompt_preview: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolClientVisibleProjectionShellInput {
    pub request_id: String,
    pub client_call_id: String,
    pub native_projection: Value,
    pub reasoning_text: String,
    #[serde(default)]
    pub additional_tool_calls: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageCliProjectionSeedInput {
    pub execution: Value,
    pub final_chat_response: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageCliProjectionSeed {
    pub flow_id: String,
    pub reasoning_text: String,
    pub continuation_prompt: String,
    pub repeat_count: u32,
    pub max_repeats: u32,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientExecCliProjectionInput {
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub flow_id: Option<String>,
    #[serde(default)]
    pub input: Option<Value>,
    #[serde(default)]
    pub repeat_count: Option<u32>,
    #[serde(default)]
    pub max_repeats: Option<u32>,
    #[serde(default)]
    pub stdout_preview: Option<String>,
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
            ServertoolCliError::UnsupportedTool(tool) => {
                write!(f, "SERVERTOOL_UNSUPPORTED_TOOL: {tool}")
            }
            ServertoolCliError::DeniedTool(tool) => {
                write!(f, "SERVERTOOL_DENIED_TOOL: {tool}")
            }
            ServertoolCliError::DeniedMarker(marker) => {
                write!(f, "SERVERTOOL_DENIED_CLI_MARKER: {marker}")
            }
            ServertoolCliError::DeniedInternalCarrier(carrier) => {
                write!(f, "SERVERTOOL_DENIED_INTERNAL_CARRIER: {carrier}")
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
    validate_cli_run_input(&input)?;
    match input.tool_name.as_str() {
        "stop_message_auto" => build_stop_message_auto_run_output(input),
        "servertool_fixture" => build_servertool_fixture_run_output(input),
        other => Err(ServertoolCliError::UnsupportedTool(other.to_string())),
    }
}

fn validate_cli_run_input(input: &ServertoolCliRunInput) -> Result<(), ServertoolCliError> {
    if !is_safe_tool_name(&input.tool_name) {
        return Err(ServertoolCliError::InvalidField("toolName"));
    }
    if is_denied_cli_projection(&input.tool_name) {
        return Err(ServertoolCliError::DeniedTool(input.tool_name.clone()));
    }
    if !input.input.is_object() {
        return Err(ServertoolCliError::InvalidField("inputJson"));
    }
    validate_no_denied_cli_marker(
        &serde_json::to_string(&input.input)
            .map_err(|_| ServertoolCliError::InvalidField("inputJson"))?,
    )?;
    validate_no_internal_carrier(&input.input)?;
    Ok(())
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
    let injected_prompt_preview = read_optional_non_empty_string(&input.input, "stdoutPreview")
        .unwrap_or_else(|| truncate_preview(&continuation_prompt, 160));
    Ok(ServertoolCliRunOutput {
        ok: true,
        kind: "stop_message_auto".to_string(),
        tool: "stop_message_auto".to_string(),
        summary: "stopless continuation ready".to_string(),
        tool_name: input.tool_name,
        flow_id,
        continuation_prompt: continuation_prompt.clone(),
        repeat_count,
        max_repeats,
        schema_guidance: Some(stopless_schema_guidance()),
        injected_prompt_preview: Some(injected_prompt_preview),
        input: input.input,
    })
}

fn build_servertool_fixture_run_output(
    input: ServertoolCliRunInput,
) -> Result<ServertoolCliRunOutput, ServertoolCliError> {
    let flow_id = input
        .flow_id
        .as_deref()
        .map(|value| non_empty(Some(value), "flowId"))
        .transpose()?
        .or_else(|| read_non_empty_string(&input.input, "flowId").ok())
        .unwrap_or_else(|| "servertool_cli_projection".to_string());
    Ok(ServertoolCliRunOutput {
        ok: true,
        kind: "servertool_fixture".to_string(),
        tool: "servertool_fixture".to_string(),
        summary: "servertool fixture result".to_string(),
        tool_name: input.tool_name,
        flow_id,
        continuation_prompt: String::new(),
        repeat_count: input
            .repeat_count
            .or_else(|| read_u32(&input.input, "repeatCount"))
            .unwrap_or(0),
        max_repeats: input
            .max_repeats
            .or_else(|| read_u32(&input.input, "maxRepeats"))
            .unwrap_or(0),
        schema_guidance: None,
        injected_prompt_preview: None,
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

fn read_optional_non_empty_string(value: &Value, field: &'static str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_optional_trimmed(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn normalize_projection_payload(input: Option<Value>) -> Result<Value, ServertoolCliError> {
    match input {
        None | Some(Value::Null) => Ok(Value::Object(Map::new())),
        Some(Value::Object(map)) => Ok(Value::Object(map)),
        Some(_) => Err(ServertoolCliError::InvalidField("input")),
    }
}

fn read_u32(value: &Value, field: &'static str) -> Option<u32> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

fn is_safe_tool_name(tool_name: &str) -> bool {
    !tool_name.is_empty()
        && tool_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn is_safe_call_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn read_object_string<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a str, ServertoolCliError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(ServertoolCliError::MissingField(field))
}

fn validate_no_denied_cli_marker(raw: &str) -> Result<(), ServertoolCliError> {
    for marker in DENIED_CLI_MARKERS {
        if raw.contains(marker) {
            return Err(ServertoolCliError::DeniedMarker(marker));
        }
    }
    Ok(())
}

fn truncate_preview(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

pub fn build_client_exec_cli_projection_output(
    tool_name: &str,
    flow_id: &str,
    input: Value,
    repeat_count: u32,
    max_repeats: u32,
) -> Result<Value, ServertoolCliError> {
    if !is_safe_tool_name(tool_name) {
        return Err(ServertoolCliError::InvalidField("toolName"));
    }
    if is_denied_cli_projection(tool_name) {
        return Err(ServertoolCliError::DeniedTool(tool_name.to_string()));
    }
    if !input.is_object() {
        return Err(ServertoolCliError::InvalidField("input"));
    }
    validate_no_denied_cli_marker(
        &serde_json::to_string(&input).map_err(|_| ServertoolCliError::InvalidField("input"))?,
    )?;
    validate_no_internal_carrier(&input)?;
    if !is_client_exec_cli_projection(tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(tool_name.to_string()));
    }
    if tool_name == "stop_message_auto" {
        if flow_id != "stop_message_flow" {
            return Err(ServertoolCliError::InvalidField("flowId"));
        }
        let continuation_prompt = read_non_empty_string(&input, "continuationPrompt")?;
        let mut input_payload = Map::new();
        input_payload.insert("flowId".to_string(), Value::String(flow_id.to_string()));
        input_payload.insert(
            "continuationPrompt".to_string(),
            Value::String(continuation_prompt.clone()),
        );
        input_payload.insert(
            "repeatCount".to_string(),
            Value::Number(serde_json::Number::from(repeat_count)),
        );
        input_payload.insert(
            "maxRepeats".to_string(),
            Value::Number(serde_json::Number::from(max_repeats)),
        );
        if let Some(stdout_preview) = read_optional_non_empty_string(&input, "stdoutPreview") {
            input_payload.insert("stdoutPreview".to_string(), Value::String(stdout_preview));
        }
        let input_json = serde_json::to_string(&Value::Object(input_payload))
            .map_err(|_| ServertoolCliError::InvalidField("json"))?;
        let cmd = format!(
            "routecodex servertool run {} --input-json {}",
            tool_name,
            quote_posix_single_argument(&input_json)
        );
        validate_no_denied_cli_marker(&cmd)?;
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

    let input_json =
        serde_json::to_string(&input).map_err(|_| ServertoolCliError::InvalidField("json"))?;
    let cmd = format!(
        "routecodex servertool run {} --input-json {}",
        tool_name,
        quote_posix_single_argument(&input_json)
    );
    validate_no_denied_cli_marker(&cmd)?;
    Ok(serde_json::json!({
        "toolName": tool_name,
        "flowId": flow_id,
        "repeatCount": repeat_count,
        "maxRepeats": max_repeats,
        "execCommand": cmd
    }))
}

/// feature_id: hub.servertool_cli_projection
pub fn plan_client_exec_cli_projection_output(
    input: ClientExecCliProjectionInput,
) -> Result<Value, ServertoolCliError> {
    let payload = normalize_projection_payload(input.input)?;
    let payload_object = payload
        .as_object()
        .ok_or(ServertoolCliError::InvalidField("input"))?;
    let explicit_tool_name = input.tool_name.as_deref().and_then(read_optional_trimmed);
    let flow_id = input
        .flow_id
        .as_deref()
        .and_then(read_optional_trimmed)
        .or_else(|| read_optional_non_empty_string(&payload, "flowId"))
        .or_else(|| {
            explicit_tool_name
                .as_ref()
                .map(|_| "servertool_cli_projection".to_string())
        })
        .ok_or(ServertoolCliError::MissingField("flowId"))?;
    let tool_name = if flow_id == "stop_message_flow" {
        if let Some(explicit) = explicit_tool_name.as_deref() {
            if explicit != "stop_message_auto" {
                return Err(ServertoolCliError::InvalidField("toolName"));
            }
        }
        "stop_message_auto".to_string()
    } else {
        explicit_tool_name.unwrap_or_else(|| flow_id.clone())
    };
    if tool_name == "stop_message_auto" && flow_id != "stop_message_flow" {
        return Err(ServertoolCliError::InvalidField("flowId"));
    }

    if tool_name == "stop_message_auto" {
        let continuation_prompt = read_non_empty_string(&payload, "continuationPrompt")?;
        let repeat_count = input
            .repeat_count
            .or_else(|| read_u32(&payload, "repeatCount"))
            .ok_or(ServertoolCliError::MissingField("repeatCount"))?;
        let max_repeats = input
            .max_repeats
            .or_else(|| read_u32(&payload, "maxRepeats"))
            .ok_or(ServertoolCliError::MissingField("maxRepeats"))?;
        if max_repeats == 0 || repeat_count > max_repeats {
            return Err(ServertoolCliError::InvalidField("repeatCount/maxRepeats"));
        }
        let mut canonical = Map::new();
        canonical.insert("flowId".to_string(), Value::String(flow_id.clone()));
        canonical.insert(
            "continuationPrompt".to_string(),
            Value::String(continuation_prompt),
        );
        canonical.insert(
            "repeatCount".to_string(),
            Value::Number(serde_json::Number::from(repeat_count)),
        );
        canonical.insert(
            "maxRepeats".to_string(),
            Value::Number(serde_json::Number::from(max_repeats)),
        );
        if let Some(stdout_preview) = input
            .stdout_preview
            .as_deref()
            .and_then(read_optional_trimmed)
        {
            canonical.insert("stdoutPreview".to_string(), Value::String(stdout_preview));
        }
        return build_client_exec_cli_projection_output(
            &tool_name,
            &flow_id,
            Value::Object(canonical),
            repeat_count,
            max_repeats,
        );
    }

    let repeat_count = input
        .repeat_count
        .or_else(|| read_u32(&payload, "repeatCount"))
        .unwrap_or(0);
    let max_repeats = input
        .max_repeats
        .or_else(|| read_u32(&payload, "maxRepeats"))
        .unwrap_or(0);
    build_client_exec_cli_projection_output(
        &tool_name,
        &flow_id,
        Value::Object(payload_object.clone()),
        repeat_count,
        max_repeats,
    )
}

pub fn build_client_visible_projection_shell(
    input: ServertoolClientVisibleProjectionShellInput,
) -> Result<Value, ServertoolCliError> {
    let request_id = input.request_id.trim();
    if request_id.is_empty() {
        return Err(ServertoolCliError::MissingField("requestId"));
    }
    let client_call_id = input.client_call_id.trim();
    if !is_safe_call_id(client_call_id) {
        return Err(ServertoolCliError::InvalidField("clientCallId"));
    }
    let reasoning_text = input.reasoning_text.trim();
    if reasoning_text.is_empty() {
        return Err(ServertoolCliError::MissingField("reasoningText"));
    }
    validate_no_denied_cli_marker(reasoning_text)?;

    let native_projection = input
        .native_projection
        .as_object()
        .ok_or(ServertoolCliError::InvalidField("nativeProjection"))?;
    let tool_name = read_object_string(native_projection, "toolName")?;
    if !is_safe_tool_name(tool_name) {
        return Err(ServertoolCliError::InvalidField("toolName"));
    }
    if is_denied_cli_projection(tool_name) {
        return Err(ServertoolCliError::DeniedTool(tool_name.to_string()));
    }
    if !is_client_exec_cli_projection(tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(tool_name.to_string()));
    }
    let command = read_object_string(native_projection, "execCommand")?;
    validate_no_denied_cli_marker(command)?;
    let tool_arguments = serde_json::to_string(&serde_json::json!({ "cmd": command }))
        .map_err(|_| ServertoolCliError::InvalidField("toolCallArguments"))?;
    let mut tool_calls = vec![serde_json::json!({
        "id": client_call_id,
        "type": "function",
        "function": {
            "name": "exec_command",
            "arguments": tool_arguments
        }
    })];
    for tool_call in input.additional_tool_calls {
        let row = tool_call
            .as_object()
            .ok_or(ServertoolCliError::InvalidField("additionalToolCalls"))?;
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .ok_or(ServertoolCliError::InvalidField("additionalToolCalls.id"))?;
        if !is_safe_call_id(id) {
            return Err(ServertoolCliError::InvalidField("additionalToolCalls.id"));
        }
        let function = row.get("function").and_then(Value::as_object).ok_or(
            ServertoolCliError::InvalidField("additionalToolCalls.function"),
        )?;
        let function_name = function.get("name").and_then(Value::as_str).ok_or(
            ServertoolCliError::InvalidField("additionalToolCalls.function.name"),
        )?;
        if is_denied_cli_projection(function_name) {
            return Err(ServertoolCliError::DeniedTool(function_name.to_string()));
        }
        if classify_servertool_outcome(function_name).is_some() {
            return Err(ServertoolCliError::UnsupportedTool(
                function_name.to_string(),
            ));
        }
        validate_no_denied_cli_marker(
            &serde_json::to_string(&tool_call)
                .map_err(|_| ServertoolCliError::InvalidField("additionalToolCalls"))?,
        )?;
        validate_no_internal_carrier(&tool_call)?;
        tool_calls.push(Value::Object(row.clone()));
    }

    Ok(serde_json::json!({
        "id": format!("chatcmpl_{client_call_id}"),
        "object": "chat.completion",
        "created": 0,
        "model": "routecodex-servertool-cli",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_text": reasoning_text,
                    "reasoning_content": reasoning_text,
                    "reasoning": {
                        "summary": [{ "type": "summary_text", "text": reasoning_text }]
                    },
                    "tool_calls": tool_calls
                },
                "finish_reason": "tool_calls"
            }
        ],
        "__servertool_cli_projection": {
            "clientCallId": client_call_id,
            "toolName": tool_name,
            "requestId": request_id
        }
    }))
}

/// feature_id: hub.servertool_stopless_cli_projection_seed
pub fn plan_stop_message_cli_projection_seed(
    input: StopMessageCliProjectionSeedInput,
) -> Result<StopMessageCliProjectionSeed, ServertoolCliError> {
    let execution = input
        .execution
        .as_object()
        .ok_or(ServertoolCliError::InvalidField("execution"))?;
    let flow_id = read_optional_string_from_object(execution, "flowId")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "stop_message_flow".to_string());
    if flow_id != "stop_message_flow" {
        return Err(ServertoolCliError::InvalidField("flowId"));
    }
    let continuation_prompt = read_stop_message_followup_text(&input.execution);
    let assistant_stop_text = read_stop_message_assistant_stop_text(&input.execution)
        .or_else(|| read_assistant_stop_text_from_chat(&input.final_chat_response))
        .unwrap_or_else(|| {
            "模型以 finish_reason=stop 结束，RouteCodex 正在请求继续执行。".to_string()
        });
    let stripped_reasoning =
        crate::stop_visible_text::strip_stop_schema_control_text(&assistant_stop_text);
    let reasoning_text = if stripped_reasoning.trim().is_empty() {
        "模型以 finish_reason=stop 结束，RouteCodex 正在请求继续执行。".to_string()
    } else {
        stripped_reasoning
    };
    let repeat_count = read_stop_message_loop_number(&input.execution, "repeatCount").unwrap_or(0);
    let max_repeats = read_stop_message_loop_number(&input.execution, "maxRepeats").unwrap_or(1);
    if max_repeats == 0 || repeat_count > max_repeats {
        return Err(ServertoolCliError::InvalidField("repeatCount/maxRepeats"));
    }
    Ok(StopMessageCliProjectionSeed {
        flow_id: flow_id.clone(),
        reasoning_text,
        continuation_prompt: continuation_prompt.clone(),
        repeat_count,
        max_repeats,
        input: serde_json::json!({
            "flowId": flow_id,
            "continuationPrompt": continuation_prompt,
            "repeatCount": repeat_count,
            "maxRepeats": max_repeats
        }),
    })
}

pub fn validate_client_exec_command_result(raw_output: &str) -> Result<Value, ServertoolCliError> {
    validate_no_denied_cli_marker(raw_output)?;
    let value: Value = serde_json::from_str(raw_output)
        .map_err(|_| ServertoolCliError::InvalidField("exec_command_output"))?;
    if !value.is_object() {
        return Err(ServertoolCliError::InvalidField("exec_command_output"));
    }
    validate_no_internal_carrier(&value)?;
    let tool_name = value
        .get("toolName")
        .and_then(|v| v.as_str())
        .ok_or(ServertoolCliError::MissingField("toolName"))?;
    let flow_id = value
        .get("flowId")
        .and_then(|v| v.as_str())
        .ok_or(ServertoolCliError::MissingField("flowId"))?;
    if is_denied_cli_projection(tool_name) {
        return Err(ServertoolCliError::DeniedTool(tool_name.to_string()));
    }
    if !is_client_exec_cli_projection(tool_name) {
        return Err(ServertoolCliError::UnsupportedTool(tool_name.to_string()));
    }
    if tool_name == "stop_message_auto" && flow_id != "stop_message_flow" {
        return Err(ServertoolCliError::InvalidField("flowId"));
    }
    Ok(value)
}

fn read_stop_message_followup_text(execution: &Value) -> String {
    let decision_text = execution
        .get("context")
        .and_then(Value::as_object)
        .and_then(|context| context.get("decision"))
        .and_then(Value::as_object)
        .and_then(|decision| {
            read_optional_string_from_object(decision, "followupText")
                .or_else(|| read_optional_string_from_object(decision, "followup_text"))
        });
    if let Some(text) = decision_text {
        return text;
    }
    let ops = execution
        .get("followup")
        .and_then(Value::as_object)
        .and_then(|followup| followup.get("injection"))
        .and_then(Value::as_object)
        .and_then(|injection| injection.get("ops"))
        .and_then(Value::as_array);
    if let Some(ops) = ops {
        for op in ops.iter().rev() {
            let Some(record) = op.as_object() else {
                continue;
            };
            let Some("append_user_text") = record.get("op").and_then(Value::as_str) else {
                continue;
            };
            if let Some(text) = read_optional_string_from_object(record, "text") {
                return text;
            }
        }
    }
    "继续完成当前用户目标。若仍需操作、检查或验证，必须调用可用工具继续执行；不要只总结、道歉、复述状态或输出计划。只有目标已经完成时，才输出最终简短结果，并说明完成证据。".to_string()
}

fn read_stop_message_assistant_stop_text(execution: &Value) -> Option<String> {
    execution
        .get("context")
        .and_then(Value::as_object)
        .and_then(|context| read_optional_string_from_object(context, "assistantStopText"))
}

fn read_stop_message_loop_number(execution: &Value, key: &'static str) -> Option<u32> {
    let context = execution.get("context").and_then(Value::as_object);
    read_runtime_metadata_from_execution(execution, context)
        .and_then(|runtime| runtime.get("serverToolLoopState"))
        .and_then(Value::as_object)
        .and_then(|loop_state| loop_state.get(key))
        .and_then(read_js_nonnegative_u32)
}

fn read_js_nonnegative_u32(value: &Value) -> Option<u32> {
    let number = value.as_f64()?;
    if !number.is_finite() {
        return None;
    }
    let floored = number.floor().max(0.0);
    if floored > u32::MAX as f64 {
        Some(u32::MAX)
    } else {
        Some(floored as u32)
    }
}

fn read_runtime_metadata_from_execution<'a>(
    execution: &'a Value,
    context: Option<&'a Map<String, Value>>,
) -> Option<&'a Map<String, Value>> {
    if let Some(context) = context.filter(|context| {
        context
            .get("serverToolLoopState")
            .and_then(Value::as_object)
            .is_some()
    }) {
        return Some(context);
    }
    if let Some(rt) = execution
        .get("followup")
        .and_then(Value::as_object)
        .and_then(|followup| followup.get("metadata"))
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("__rt"))
        .and_then(Value::as_object)
    {
        return Some(rt);
    }
    context
}

fn read_assistant_stop_text_from_chat(chat: &Value) -> Option<String> {
    let mut out = Vec::new();
    if let Some(choices) = chat.get("choices").and_then(Value::as_array) {
        for choice in choices {
            if let Some(content) = choice
                .get("message")
                .and_then(Value::as_object)
                .and_then(|message| message.get("content"))
            {
                collect_text_from_content_parts(content, &mut out);
            }
        }
    }
    if let Some(output) = chat.get("output").and_then(Value::as_array) {
        for item in output {
            if let Some(content) = item.as_object().and_then(|record| record.get("content")) {
                collect_text_from_content_parts(content, &mut out);
            }
        }
    }
    let joined = out.join("\n").trim().to_string();
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

fn collect_text_from_content_parts(value: &Value, out: &mut Vec<String>) {
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        out.push(text.to_string());
        return;
    }
    let Some(parts) = value.as_array() else {
        return;
    };
    for part in parts {
        if let Some(text) = part.as_str().map(str::trim).filter(|text| !text.is_empty()) {
            out.push(text.to_string());
            continue;
        }
        let Some(record) = part.as_object() else {
            continue;
        };
        let text = read_optional_string_from_object(record, "text")
            .or_else(|| read_optional_string_from_object(record, "output_text"))
            .or_else(|| read_optional_string_from_object(record, "content"));
        if let Some(text) = text {
            out.push(text);
        }
    }
}

fn read_optional_string_from_object(object: &Map<String, Value>, field: &str) -> Option<String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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
];

const DENIED_INTERNAL_CARRIER_TEXT: &[&str] = &[
    "__rt",
    "__raw_request_body",
    "__servertool_cli_projection",
    "metaCarrier",
    "restoration handle",
    "restoration store",
];

fn validate_no_internal_carrier(value: &Value) -> Result<(), ServertoolCliError> {
    match value {
        Value::Object(record) => {
            for (key, item) in record {
                let normalized_key = key.trim();
                for denied in DENIED_INTERNAL_CARRIER_KEYS {
                    if normalized_key == *denied {
                        return Err(ServertoolCliError::DeniedInternalCarrier(denied));
                    }
                }
                validate_no_internal_carrier(item)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                validate_no_internal_carrier(item)?;
            }
            Ok(())
        }
        Value::String(raw) => {
            for denied in DENIED_INTERNAL_CARRIER_TEXT {
                if raw.contains(denied) {
                    return Err(ServertoolCliError::DeniedInternalCarrier(denied));
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
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
            .as_ref()
            .expect("schema guidance")
            .required_fields
            .contains(&"stopreason".to_string()));
        assert_eq!(output.ok, true);
        assert_eq!(output.kind, "stop_message_auto");
        assert_eq!(
            output.injected_prompt_preview.as_deref(),
            Some("continue with schema")
        );
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
        assert_eq!(
            err,
            ServertoolCliError::UnsupportedTool("web_search".to_string())
        );
    }

    #[test]
    fn servertool_fixture_cli_output_is_executable() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "servertool_fixture".to_string(),
                input: json!({"value":1}),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
            },
        )
        .expect("fixture output");
        assert_eq!(output.ok, true);
        assert_eq!(output.kind, "servertool_fixture");
        assert_eq!(output.tool_name, "servertool_fixture");
        assert_eq!(output.flow_id, "servertool_cli_projection");
        assert!(output.schema_guidance.is_none());
        assert_eq!(output.input, json!({"value":1}));
    }

    #[test]
    fn cli_rejects_non_object_input_json() {
        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!(["not", "object"]),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
            },
        )
        .expect_err("non-object input must fail");
        assert_eq!(err, ServertoolCliError::InvalidField("inputJson"));
    }

    #[test]
    fn cli_rejects_old_restoration_markers_in_input() {
        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "servertool_fixture".to_string(),
                input: json!({"value":"old_cli_result_123"}),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
            },
        )
        .expect_err("old marker must fail");
        assert_eq!(err, ServertoolCliError::DeniedMarker("old_cli_"));
    }

    #[test]
    fn cli_rejects_internal_carrier_in_input_json() {
        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "servertool_fixture".to_string(),
                input: json!({"__rt":{"requestId":"req_internal"}}),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
            },
        )
        .expect_err("internal carrier must fail");
        assert_eq!(err, ServertoolCliError::DeniedInternalCarrier("__rt"));
    }

    #[test]
    fn projection_output_is_rust_owned_schema() {
        let out = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: None,
            flow_id: Some("stop_message_flow".to_string()),
            input: Some(json!({
                "continuationPrompt": "continue",
                "repeatCount": 2,
                "maxRepeats": 5
            })),
            repeat_count: None,
            max_repeats: None,
            stdout_preview: Some("preview".to_string()),
        })
        .expect("projection output");
        assert_eq!(out["toolName"], "stop_message_auto");
        assert_eq!(out["flowId"], "stop_message_flow");
        assert_eq!(out["repeatCount"], 2);
        assert_eq!(out["maxRepeats"], 5);
        assert_eq!(out["schemaGuidance"]["stopreasonValues"]["finished"], 0);
        let cmd = out["execCommand"].as_str().unwrap();
        assert!(cmd.contains("routecodex servertool run"));
        assert!(cmd.contains("stdoutPreview"));
        assert!(!cmd.contains("stcli_"), "no old stcli_ marker");
        assert!(!cmd.contains("rcc_cli_"), "no old rcc_cli_ marker");
        assert!(!cmd.contains("--ticket"), "no --ticket marker");
    }

    #[test]
    fn projection_plan_rejects_wrong_explicit_stopless_tool_name() {
        assert_eq!(
            plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
                tool_name: Some("servertool_fixture".to_string()),
                flow_id: Some("stop_message_flow".to_string()),
                input: Some(json!({
                    "continuationPrompt": "continue",
                    "repeatCount": 1,
                    "maxRepeats": 3
                })),
                repeat_count: None,
                max_repeats: None,
                stdout_preview: None,
            }),
            Err(ServertoolCliError::InvalidField("toolName"))
        );
    }

    #[test]
    fn projection_plan_rejects_invalid_stopless_repeat_window() {
        assert_eq!(
            plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
                tool_name: None,
                flow_id: Some("stop_message_flow".to_string()),
                input: Some(json!({
                    "continuationPrompt": "continue",
                    "repeatCount": 4,
                    "maxRepeats": 3
                })),
                repeat_count: None,
                max_repeats: None,
                stdout_preview: None,
            }),
            Err(ServertoolCliError::InvalidField("repeatCount/maxRepeats"))
        );
    }

    #[test]
    fn projection_plan_defaults_non_stopless_tool_name_to_flow_id() {
        let out = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: None,
            flow_id: Some("servertool_fixture".to_string()),
            input: Some(json!({"value": 1})),
            repeat_count: None,
            max_repeats: None,
            stdout_preview: None,
        })
        .expect("fixture projection");
        assert_eq!(out["toolName"], "servertool_fixture");
        assert_eq!(out["flowId"], "servertool_fixture");
        assert_eq!(
            out["execCommand"],
            "routecodex servertool run servertool_fixture --input-json '{\"value\":1}'"
        );
    }

    #[test]
    fn projection_output_quotes_json_apostrophes() {
        let out = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: None,
            flow_id: Some("stop_message_flow".to_string()),
            input: Some(json!({
                "continuationPrompt": "can't stop",
                "repeatCount": 2,
                "maxRepeats": 5
            })),
            repeat_count: None,
            max_repeats: None,
            stdout_preview: None,
        })
        .expect("projection output");
        assert_eq!(
            out["execCommand"],
            "routecodex servertool run stop_message_auto --input-json '{\"continuationPrompt\":\"can'\\''t stop\",\"flowId\":\"stop_message_flow\",\"maxRepeats\":5,\"repeatCount\":2}'"
        );
    }

    #[test]
    fn client_visible_projection_shell_omits_responses_reasoning_content_array() {
        let native_projection = build_client_exec_cli_projection_output(
            "stop_message_auto",
            "stop_message_flow",
            json!({"continuationPrompt":"continue","repeatCount":2,"maxRepeats":5}),
            2,
            5,
        )
        .expect("projection output");
        let shell =
            build_client_visible_projection_shell(ServertoolClientVisibleProjectionShellInput {
                request_id: "req_stop_projection".to_string(),
                client_call_id: "call_servertool_cli_stop_1".to_string(),
                native_projection,
                reasoning_text: "intercepted stop text".to_string(),
                additional_tool_calls: vec![],
            })
            .expect("client visible shell");

        let message = &shell["choices"][0]["message"];
        assert_eq!(message["reasoning_content"], "intercepted stop text");
        assert_eq!(message["reasoning"]["summary"][0]["type"], "summary_text");
        assert!(message["reasoning"].get("content").is_none());
        assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
        assert_eq!(
            shell["__servertool_cli_projection"]["requestId"],
            "req_stop_projection"
        );
    }

    #[test]
    fn client_visible_projection_shell_preserves_additional_client_tool_calls() {
        let native_projection = build_client_exec_cli_projection_output(
            "servertool_fixture",
            "servertool_cli_projection",
            json!({"value":1}),
            0,
            0,
        )
        .expect("projection output");
        let shell =
            build_client_visible_projection_shell(ServertoolClientVisibleProjectionShellInput {
                request_id: "req_mixed_projection".to_string(),
                client_call_id: "call_servertool_cli_fixture_1".to_string(),
                native_projection,
                reasoning_text: "servertool fixture projection".to_string(),
                additional_tool_calls: vec![json!({
                    "id": "call_exec_command_1",
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"echo hi\"}"
                    }
                })],
            })
            .expect("client visible shell");

        let calls = shell["choices"][0]["message"]["tool_calls"]
            .as_array()
            .unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["function"]["name"], "exec_command");
        assert_eq!(calls[1]["id"], "call_exec_command_1");
        assert_eq!(calls[1]["function"]["name"], "exec_command");
    }

    #[test]
    fn client_visible_projection_shell_rejects_additional_servertool_calls() {
        let native_projection = build_client_exec_cli_projection_output(
            "servertool_fixture",
            "servertool_cli_projection",
            json!({"value":1}),
            0,
            0,
        )
        .expect("fixture projection output");
        let err =
            build_client_visible_projection_shell(ServertoolClientVisibleProjectionShellInput {
                request_id: "req_mixed_projection".to_string(),
                client_call_id: "call_servertool_cli_fixture_1".to_string(),
                native_projection,
                reasoning_text: "servertool fixture projection".to_string(),
                additional_tool_calls: vec![json!({
                    "id": "call_web_search_1",
                    "type": "function",
                    "function": {
                        "name": "web_search",
                        "arguments": "{}"
                    }
                })],
            })
            .expect_err("additional registered servertool must not be client-visible");
        assert_eq!(
            err,
            ServertoolCliError::UnsupportedTool("web_search".to_string())
        );
    }

    #[test]
    fn client_visible_projection_shell_rejects_additional_internal_carrier() {
        let native_projection = build_client_exec_cli_projection_output(
            "servertool_fixture",
            "servertool_cli_projection",
            json!({"value":1}),
            0,
            0,
        )
        .expect("fixture projection output");
        let err =
            build_client_visible_projection_shell(ServertoolClientVisibleProjectionShellInput {
                request_id: "req_mixed_projection".to_string(),
                client_call_id: "call_servertool_cli_fixture_1".to_string(),
                native_projection,
                reasoning_text: "servertool fixture projection".to_string(),
                additional_tool_calls: vec![json!({
                    "id": "call_exec_command_1",
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"echo hi\"}"
                    },
                    "metadata": {"requestId": "req_internal"}
                })],
            })
            .expect_err("additional internal carrier must not be client-visible");
        assert_eq!(err, ServertoolCliError::DeniedInternalCarrier("metadata"));
    }

    #[test]
    fn projection_rejects_fake_exec_and_web_search() {
        assert_eq!(
            build_client_exec_cli_projection_output(
                "web_search",
                "stop_message_flow",
                json!({}),
                1,
                3
            ),
            Err(ServertoolCliError::UnsupportedTool(
                "web_search".to_string()
            ))
        );
        assert_eq!(
            build_client_exec_cli_projection_output(
                "fake_exec",
                "stop_message_flow",
                json!({}),
                1,
                3
            ),
            Err(ServertoolCliError::DeniedTool("fake_exec".to_string()))
        );
    }

    #[test]
    fn projection_rejects_old_restoration_marker_input() {
        assert_eq!(
            build_client_exec_cli_projection_output(
                "servertool_fixture",
                "servertool_cli_projection",
                json!({"value":"old_cli_result_123"}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedMarker("old_cli_"))
        );
    }

    #[test]
    fn projection_rejects_internal_metadata_input() {
        assert_eq!(
            build_client_exec_cli_projection_output(
                "servertool_fixture",
                "servertool_cli_projection",
                json!({"metadata":{"debug":true}}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedInternalCarrier("metadata"))
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
            Err(ServertoolCliError::UnsupportedTool(
                "web_search".to_string()
            ))
        );
    }

    #[test]
    fn exec_result_validation_rejects_denied_markers() {
        let raw = json!({
            "toolName": "stop_message_auto",
            "flowId": "stop_message_flow",
            "extra": "old_cli_result_123"
        });
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::DeniedMarker("old_cli_"))
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
    fn exec_result_validation_rejects_internal_snapshot_carrier() {
        let raw = json!({
            "toolName": "servertool_fixture",
            "flowId": "servertool_cli_projection",
            "snapshot": {"requestId": "req_internal"}
        });
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::DeniedInternalCarrier("snapshot"))
        );
    }

    #[test]
    fn exec_result_validation_accepts_servertool_fixture() {
        let raw = json!({"toolName": "servertool_fixture", "flowId": "servertool_cli_projection"});
        let parsed = validate_client_exec_command_result(&raw.to_string()).expect("valid result");
        assert_eq!(parsed["toolName"], "servertool_fixture");
    }

    #[test]
    fn stop_message_cli_projection_seed_uses_decision_and_context_loop_state() {
        let seed = plan_stop_message_cli_projection_seed(StopMessageCliProjectionSeedInput {
            execution: json!({
                "flowId": "stop_message_flow",
                "context": {
                    "assistantStopText": "停止原因：会被剥离\nvisible stop summary",
                    "decision": { "followupText": "decision followup" },
                    "serverToolLoopState": {
                        "repeatCount": 2,
                        "maxRepeats": 4
                    }
                }
            }),
            final_chat_response: json!({}),
        })
        .expect("seed");
        assert_eq!(seed.flow_id, "stop_message_flow");
        assert_eq!(seed.continuation_prompt, "decision followup");
        assert_eq!(seed.reasoning_text, "visible stop summary");
        assert_eq!(seed.repeat_count, 2);
        assert_eq!(seed.max_repeats, 4);
        assert_eq!(seed.input["continuationPrompt"], "decision followup");
    }

    #[test]
    fn stop_message_cli_projection_seed_uses_last_injection_and_runtime_metadata_loop_state() {
        let seed = plan_stop_message_cli_projection_seed(StopMessageCliProjectionSeedInput {
            execution: json!({
                "flowId": "stop_message_flow",
                "followup": {
                    "injection": {
                        "ops": [
                            { "op": "append_user_text", "text": "old followup" },
                            { "op": "append_user_text", "text": "new followup" }
                        ]
                    },
                    "metadata": {
                        "__rt": {
                            "serverToolLoopState": {
                                "repeatCount": 1,
                                "maxRepeats": 3
                            }
                        }
                    }
                }
            }),
            final_chat_response: json!({
                "choices": [
                    {
                        "message": {
                            "content": [
                                { "type": "text", "text": "assistant from chat" }
                            ]
                        }
                    }
                ]
            }),
        })
        .expect("seed");
        assert_eq!(seed.continuation_prompt, "new followup");
        assert_eq!(seed.reasoning_text, "assistant from chat");
        assert_eq!(seed.repeat_count, 1);
        assert_eq!(seed.max_repeats, 3);
    }

    #[test]
    fn stop_message_cli_projection_seed_floors_js_loop_numbers() {
        let seed = plan_stop_message_cli_projection_seed(StopMessageCliProjectionSeedInput {
            execution: json!({
                "flowId": "stop_message_flow",
                "context": {
                    "decision": { "followupText": "continue" },
                    "serverToolLoopState": {
                        "repeatCount": 1.9,
                        "maxRepeats": 3.8
                    }
                }
            }),
            final_chat_response: json!({ "choices": [{ "message": { "content": "summary" } }] }),
        })
        .expect("seed");
        assert_eq!(seed.repeat_count, 1);
        assert_eq!(seed.max_repeats, 3);
        assert_eq!(seed.input["repeatCount"], 1);
        assert_eq!(seed.input["maxRepeats"], 3);
    }

    #[test]
    fn stop_message_cli_projection_seed_fails_fast_for_invalid_budget() {
        let err = plan_stop_message_cli_projection_seed(StopMessageCliProjectionSeedInput {
            execution: json!({
                "flowId": "stop_message_flow",
                "context": {
                    "decision": { "followupText": "continue" },
                    "serverToolLoopState": {
                        "repeatCount": 4,
                        "maxRepeats": 3
                    }
                }
            }),
            final_chat_response: json!({ "choices": [{ "message": { "content": "summary" } }] }),
        })
        .expect_err("invalid budget must fail");
        assert_eq!(
            err,
            ServertoolCliError::InvalidField("repeatCount/maxRepeats")
        );
    }
}
