use crate::outcome_contract::{
    classify_servertool_outcome, is_client_exec_cli_projection, is_denied_cli_projection,
    quote_posix_single_argument, DENIED_CLI_MARKERS,
};
use crate::stopless_prompt::{
    resolve_stopless_continuation_prompt, StoplessContinuationPromptInput,
    StoplessContinuationTrigger,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const STOP_MESSAGE_AUTO_TOOL_NAME: &str = "stop_message_auto";
const REASONING_STOP_PUBLIC_TOOL_NAME: &str = "reasoning_stop";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolCliRunInput {
    pub tool_name: String,
    pub input: Value,
    pub flow_id: Option<String>,
    pub repeat_count: Option<u32>,
    pub max_repeats: Option<u32>,
    #[serde(default)]
    pub session_dir: Option<String>,
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
    #[serde(skip_serializing_if = "String::is_empty")]
    pub continuation_prompt: String,
    pub repeat_count: u32,
    pub max_repeats: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
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
    pub trigger_hint: String,
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
    #[serde(default)]
    pub session_dir: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
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
    let input = normalize_cli_run_input_aliases(input)?;
    validate_cli_run_input(&input)?;
    match input.tool_name.as_str() {
        STOP_MESSAGE_AUTO_TOOL_NAME => build_stop_message_auto_run_output(input),
        "servertool_fixture" => build_servertool_fixture_run_output(input),
        other => Err(ServertoolCliError::UnsupportedTool(other.to_string())),
    }
}

fn validate_cli_run_input(input: &ServertoolCliRunInput) -> Result<(), ServertoolCliError> {
    validate_no_denied_cli_marker(&input.tool_name)?;
    if let Some(flow_id) = input.flow_id.as_deref() {
        validate_no_denied_cli_marker(flow_id)?;
    }
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

fn normalize_cli_run_input_aliases(
    mut input: ServertoolCliRunInput,
) -> Result<ServertoolCliRunInput, ServertoolCliError> {
    let normalized = match input.tool_name.trim() {
        REASONING_STOP_PUBLIC_TOOL_NAME => STOP_MESSAGE_AUTO_TOOL_NAME,
        other => other,
    };
    if normalized.is_empty() {
        return Err(ServertoolCliError::MissingField("toolName"));
    }
    input.tool_name = normalized.to_string();
    Ok(input)
}

fn build_terminal_stopless_output(
    session_id: Option<String>,
    request_id: Option<String>,
    continuation_prompt: String,
    max_repeats: u32,
) -> ServertoolCliRunOutput {
    ServertoolCliRunOutput {
        ok: true,
        kind: "stop_message_auto".to_string(),
        tool: "stop_message_auto".to_string(),
        summary: "stopless budget exhausted".to_string(),
        tool_name: "stop_message_auto".to_string(),
        flow_id: "stop_message_flow".to_string(),
        continuation_prompt,
        repeat_count: max_repeats,
        max_repeats,
        session_id,
        request_id,
        schema_guidance: Some(stopless_schema_guidance_with_trigger(
            StoplessContinuationTrigger::BudgetExhausted,
            max_repeats.saturating_sub(1),
            max_repeats,
        )),
        injected_prompt_preview: None,
        input: serde_json::json!({
            "flowId": "stop_message_flow",
            "repeatCount": max_repeats,
            "maxRepeats": max_repeats,
            "triggerHint": "budget_exhausted"
        }),
    }
}

fn build_stop_message_auto_run_output(
    input: ServertoolCliRunInput,
) -> Result<ServertoolCliRunOutput, ServertoolCliError> {
    let session_id = input.session_id.as_deref().and_then(read_optional_trimmed);
    let request_id = input.request_id.as_deref().and_then(read_optional_trimmed);
    let current_repeat_count = input
        .repeat_count
        .or_else(|| read_u32(&input.input, "repeatCount"))
        .unwrap_or(1);
    let current_max_repeats = input
        .max_repeats
        .or_else(|| read_u32(&input.input, "maxRepeats"))
        .unwrap_or(3);
    if current_max_repeats == 0 || current_repeat_count >= current_max_repeats {
        // 打满后优雅停止，不报错
        let continuation_prompt = resolve_stopless_continuation_prompt(
            StoplessContinuationPromptInput {
                used: current_max_repeats.saturating_sub(1),
                max_repeats: current_max_repeats,
                trigger: StoplessContinuationTrigger::BudgetExhausted,
            },
        )
        .expect("prompt");
        return Ok(build_terminal_stopless_output(
            session_id,
            request_id,
            continuation_prompt.client_visible_text,
            current_max_repeats,
        ));
    }
    let next_repeat_count = current_repeat_count
        .saturating_add(1)
        .min(current_max_repeats);
    let used_for_prompt = current_repeat_count.saturating_sub(1);
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
    let trigger = read_stopless_trigger_hint(&input.input);
    let canonical_input = serde_json::json!({
        "flowId": flow_id,
        "repeatCount": next_repeat_count,
        "maxRepeats": current_max_repeats,
        "triggerHint": stopless_trigger_hint(trigger)
    });
    let continuation_prompt = resolve_stopless_cli_continuation_prompt(
        trigger,
        used_for_prompt,
        current_max_repeats,
    )?;
    Ok(ServertoolCliRunOutput {
        ok: true,
        kind: "stop_message_auto".to_string(),
        tool: "stop_message_auto".to_string(),
        summary: "stopless continuation ready".to_string(),
        tool_name: input.tool_name,
        flow_id,
        continuation_prompt,
        repeat_count: next_repeat_count,
        max_repeats: current_max_repeats,
        session_id,
        request_id,
        schema_guidance: Some(stopless_schema_guidance_with_trigger(
            trigger,
            used_for_prompt,
            current_max_repeats,
        )),
        injected_prompt_preview: None,
        input: canonical_input,
    })
}

fn resolve_stopless_cli_continuation_prompt(
    trigger: StoplessContinuationTrigger,
    used_for_prompt: u32,
    max_repeats: u32,
) -> Result<String, ServertoolCliError> {
    resolve_stopless_continuation_prompt(StoplessContinuationPromptInput {
        used: used_for_prompt,
        max_repeats,
        trigger,
    })
    .map(|resolved| resolved.client_visible_text)
    .map_err(|_| ServertoolCliError::InvalidField("continuationPrompt"))
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
        session_id: input.session_id.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }),
        request_id: input.request_id.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }),
        schema_guidance: None,
        injected_prompt_preview: None,
        input: input.input,
    })
}

pub fn stopless_schema_guidance_with_trigger(
    trigger: StoplessContinuationTrigger,
    _used: u32,
    _max_repeats: u32,
) -> StoplessSchemaGuidance {
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
        trigger_hint: stopless_trigger_hint(trigger).to_string(),
    }
}

pub fn stopless_schema_guidance() -> StoplessSchemaGuidance {
    stopless_schema_guidance_with_trigger(StoplessContinuationTrigger::NoSchema, 0, 3)
}

fn stopless_trigger_hint(trigger: StoplessContinuationTrigger) -> &'static str {
    match trigger {
        StoplessContinuationTrigger::Stop | StoplessContinuationTrigger::NoSchema => "no_schema",
        StoplessContinuationTrigger::InvalidSchema => "invalid_schema",
        StoplessContinuationTrigger::NonTerminalSchema => "non_terminal_schema",
        StoplessContinuationTrigger::BudgetExhausted => "budget_exhausted",
        StoplessContinuationTrigger::SchemaPass => "schema_pass",
    }
}

fn read_stopless_trigger_hint(input: &Value) -> StoplessContinuationTrigger {
    let token = input
        .as_object()
        .and_then(|row| row.get("triggerHint").or_else(|| row.get("trigger_hint")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("no_schema");
    match token {
        "stop_schema_missing" => StoplessContinuationTrigger::NoSchema,
        "stop_schema_reason_missing" => StoplessContinuationTrigger::InvalidSchema,
        "stop_schema_terminal_missing_fields" => StoplessContinuationTrigger::InvalidSchema,
        "stop_schema_next_step_missing" => StoplessContinuationTrigger::InvalidSchema,
        "stop_schema_forcestop_reason_missing" => StoplessContinuationTrigger::InvalidSchema,
        "stop_schema_continue_without_next_step" => {
            StoplessContinuationTrigger::NonTerminalSchema
        }
        "stop_schema_continue_next_step" => StoplessContinuationTrigger::NonTerminalSchema,
        "stop_schema_budget_exhausted" => StoplessContinuationTrigger::BudgetExhausted,
        "stop_schema_finished" => StoplessContinuationTrigger::SchemaPass,
        "stop_schema_blocked" => StoplessContinuationTrigger::SchemaPass,
        "stop_schema_needs_user_input" => StoplessContinuationTrigger::SchemaPass,
        "stop_schema_forcestop" => StoplessContinuationTrigger::SchemaPass,
        "invalid_schema" => StoplessContinuationTrigger::InvalidSchema,
        "non_terminal_schema" => StoplessContinuationTrigger::NonTerminalSchema,
        "budget_exhausted" => StoplessContinuationTrigger::BudgetExhausted,
        "schema_pass" => StoplessContinuationTrigger::SchemaPass,
        _ => StoplessContinuationTrigger::NoSchema,
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

fn build_client_exec_cli_projection_output_with_identity(
    tool_name: &str,
    flow_id: &str,
    input: Value,
    repeat_count: u32,
    max_repeats: u32,
    session_dir: Option<&str>,
    session_id: Option<&str>,
    request_id: Option<&str>,
) -> Result<Value, ServertoolCliError> {
    validate_no_denied_cli_marker(tool_name)?;
    validate_no_denied_cli_marker(flow_id)?;
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
        let trigger_hint = input
            .as_object()
            .and_then(|row| row.get("triggerHint").or_else(|| row.get("trigger_hint")))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let mut input_payload = Map::new();
        input_payload.insert("flowId".to_string(), Value::String(flow_id.to_string()));
        input_payload.insert(
            "repeatCount".to_string(),
            Value::Number(serde_json::Number::from(repeat_count)),
        );
        input_payload.insert(
            "maxRepeats".to_string(),
            Value::Number(serde_json::Number::from(max_repeats)),
        );
        if let Some(trigger_hint) = trigger_hint.as_deref() {
            input_payload.insert(
                "triggerHint".to_string(),
                Value::String(trigger_hint.to_string()),
            );
        }
        let input_json = serde_json::to_string(&Value::Object(input_payload))
            .map_err(|_| ServertoolCliError::InvalidField("json"))?;
        let cmd = build_client_exec_command(
            tool_name,
            &input_json,
            None,
            None,
            None,
            Some(repeat_count),
            Some(max_repeats),
        );
        validate_no_denied_cli_marker(&cmd)?;
        let mut output = serde_json::json!({
            "toolName": tool_name,
            "flowId": flow_id,
            "repeatCount": repeat_count,
            "maxRepeats": max_repeats,
            "execCommand": cmd
        });
        return Ok(output);
    }

    let input_json =
        serde_json::to_string(&input).map_err(|_| ServertoolCliError::InvalidField("json"))?;
    // Non-stopless tools: do not carry session-id/request-id in the CLI command.
    let cmd = build_client_exec_command(
        tool_name,
        &input_json,
        session_dir,
        None,
        None,
        None,
        None,
    );
    validate_no_denied_cli_marker(&cmd)?;
    let mut output = serde_json::json!({
        "toolName": tool_name,
        "flowId": flow_id,
        "repeatCount": repeat_count,
        "maxRepeats": max_repeats,
        "execCommand": cmd
    });
    if let Some(session_id) = session_id.and_then(read_optional_trimmed) {
        output["sessionId"] = Value::String(session_id);
    }
    if let Some(request_id) = request_id.and_then(read_optional_trimmed) {
        output["requestId"] = Value::String(request_id);
    }
    Ok(output)
}

fn build_client_exec_command(
    tool_name: &str,
    input_json: &str,
    session_dir: Option<&str>,
    session_id: Option<&str>,
    request_id: Option<&str>,
    repeat_count: Option<u32>,
    max_repeats: Option<u32>,
) -> String {
    let quoted_input = quote_posix_single_argument(&input_json);
    let mut cmd = format!(
        "routecodex hook run {} --input-json {}",
        public_cli_tool_name(tool_name),
        quoted_input
    );
    if let Some(session_dir) = session_dir.and_then(read_optional_trimmed) {
        cmd.push_str(" --session-dir ");
        cmd.push_str(&quote_posix_single_argument(&session_dir));
    }
    if let Some(session_id) = session_id.and_then(read_optional_trimmed) {
        cmd.push_str(" --session-id ");
        cmd.push_str(&quote_posix_single_argument(&session_id));
    }
    if let Some(request_id) = request_id.and_then(read_optional_trimmed) {
        cmd.push_str(" --request-id ");
        cmd.push_str(&quote_posix_single_argument(&request_id));
    }
    if let Some(repeat_count) = repeat_count {
        cmd.push_str(" --repeat-count ");
        cmd.push_str(&quote_posix_single_argument(&repeat_count.to_string()));
    }
    if let Some(max_repeats) = max_repeats {
        cmd.push_str(" --max-repeats ");
        cmd.push_str(&quote_posix_single_argument(&max_repeats.to_string()));
    }
    cmd
}

fn public_cli_tool_name(tool_name: &str) -> &str {
    if tool_name == STOP_MESSAGE_AUTO_TOOL_NAME {
        REASONING_STOP_PUBLIC_TOOL_NAME
    } else {
        tool_name
    }
}

pub fn build_client_exec_cli_projection_output(
    tool_name: &str,
    flow_id: &str,
    input: Value,
    repeat_count: u32,
    max_repeats: u32,
) -> Result<Value, ServertoolCliError> {
    build_client_exec_cli_projection_output_with_identity(
        tool_name,
        flow_id,
        input,
        repeat_count,
        max_repeats,
        None,
        None,
        None,
    )
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
    if let Some(tool_name) = explicit_tool_name.as_deref() {
        validate_no_denied_cli_marker(tool_name)?;
    }
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
    validate_no_denied_cli_marker(&flow_id)?;
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
            "repeatCount".to_string(),
            Value::Number(serde_json::Number::from(repeat_count)),
        );
        canonical.insert(
            "maxRepeats".to_string(),
            Value::Number(serde_json::Number::from(max_repeats)),
        );
        // Always carry triggerHint in projection output
        let trigger_hint = read_stopless_trigger_hint(&payload);
        canonical.insert(
            "triggerHint".to_string(),
            Value::String(stopless_trigger_hint(trigger_hint).to_string()),
        );
        return build_client_exec_cli_projection_output_with_identity(
            &tool_name,
            &flow_id,
            Value::Object(canonical),
            repeat_count,
            max_repeats,
            None,
            None,
            None,
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
    // Non-stopless tools: do not carry session/request identity in CLI command.
    build_client_exec_cli_projection_output_with_identity(
        &tool_name,
        &flow_id,
        Value::Object(payload_object.clone()),
        repeat_count,
        max_repeats,
        input.session_dir.as_deref(),
        None,
        None,
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
        ]
    }))
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
    validate_no_denied_cli_marker(tool_name)?;
    validate_no_denied_cli_marker(flow_id)?;
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
    "reenterPipeline",
    "providerInvoker",
    "serverToolFollowup",
    "serverToolFollowupSource",
];

const DENIED_INTERNAL_CARRIER_TEXT: &[&str] = &[
    "__rt",
    "__raw_request_body",
    "__servertool_cli_projection",
    "metadata",
    "metaCarrier",
    "snapshot",
    "debugCarrier",
    "restoration handle",
    "restoration store",
    "reenterPipeline",
    "providerInvoker",
    "serverToolFollowup",
    "serverToolFollowupSource",
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
                    "continuationPrompt": "continue with full schema",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: Some("stopmessage-cli-output-spec-session".to_string()),
                request_id: Some("stopmessage-cli-output-spec-request".to_string()),
            },
        )
        .expect("stop_message_auto output");
        assert_eq!(output.tool_name, "stop_message_auto");
        assert_eq!(output.flow_id, "stop_message_flow");
        assert_eq!(output.repeat_count, 2);
        assert!(!output.continuation_prompt.is_empty());
        for forbidden in [
            "schema",
            "hook",
            "stopless",
            "servertool",
            "第一轮",
            "第二轮",
            "第三轮",
            "必须调用",
            "证据不足",
            "用户目标",
            "已排除因素",
            "排查顺序",
        ] {
            assert!(
                !output.continuation_prompt.contains(forbidden),
                "stopless prompt leaks forbidden token {forbidden}: {}",
                output.continuation_prompt
            );
        }
        let schema_guidance = output
            .schema_guidance
            .expect("NoSchema stopless CLI output must carry schema guidance");
        assert!(schema_guidance.required_fields.contains(&"stopreason".to_string()));
        assert!(schema_guidance.required_fields.contains(&"next_step".to_string()));
        assert_eq!(schema_guidance.stopreason_values.finished, 0);
        assert_eq!(schema_guidance.stopreason_values.blocked, 1);
        assert_eq!(schema_guidance.stopreason_values.continue_needed, 2);
        assert!(output.injected_prompt_preview.is_none());
        assert_eq!(
            output.input,
            json!({
                "flowId": "stop_message_flow",
                "repeatCount": 2,
                "maxRepeats": 3,
                "triggerHint": "no_schema"
            })
        );
        assert_eq!(schema_guidance.trigger_hint, "no_schema",
            "NoSchema default must produce no_schema trigger_hint");
        assert_eq!(output.ok, true);
        assert_eq!(output.kind, "stop_message_auto");
    }

    #[test]
    fn status_only_stopless_cli_output_does_not_require_prompt() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({ "repeatCount": 1, "maxRepeats": 3 }),
                flow_id: Some("stop_message_flow".to_string()),
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: Some(format!(
                    "session-status-only-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_nanos() as u64)
                        .unwrap_or(0)
                )),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect("status-only stopless CLI must not require prompt");
        assert_eq!(output.tool_name, "stop_message_auto");
        assert_eq!(output.flow_id, "stop_message_flow");
        assert_eq!(output.repeat_count, 2);
        assert_eq!(output.max_repeats, 3);
        assert!(!output.continuation_prompt.is_empty());
        for forbidden in [
            "schema",
            "hook",
            "stopless",
            "servertool",
            "第一轮",
            "第二轮",
            "第三轮",
            "必须调用",
            "证据不足",
            "用户目标",
            "已排除因素",
            "排查顺序",
        ] {
            assert!(
                !output.continuation_prompt.contains(forbidden),
                "status-only stopless prompt leaks forbidden token {forbidden}: {}",
                output.continuation_prompt
            );
        }
        let schema_guidance = output
            .schema_guidance
            .expect("status-only stopless CLI output must carry schema guidance");
        assert!(schema_guidance.required_fields.contains(&"reason".to_string()));
        assert!(schema_guidance.required_fields.contains(&"learned".to_string()));
        assert!(output.injected_prompt_preview.is_none());
        assert_eq!(
            output.input,
            json!({
                "flowId": "stop_message_flow",
                "repeatCount": 2,
                "maxRepeats": 3,
                "triggerHint": "no_schema"
            })
        );
        assert_eq!(schema_guidance.trigger_hint, "no_schema",
            "NoSchema default must produce no_schema trigger_hint");
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
                session_dir: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
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
                session_dir: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
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
    fn non_stopless_projection_command_does_not_carry_identity_flags() {
        let output = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: Some("servertool_fixture".to_string()),
            flow_id: Some("servertool_cli_projection".to_string()),
            input: Some(json!({"value": 1})),
            repeat_count: None,
            max_repeats: None,
            stdout_preview: None,
            session_dir: None,
            session_id: Some("sess-cli-proj".to_string()),
            request_id: Some("req-cli-proj".to_string()),
        })
        .expect("projection output");

        let command = output
            .get("execCommand")
            .and_then(Value::as_str)
            .expect("execCommand");
        assert!(!command.contains("--session-id 'sess-cli-proj'"));
        assert!(!command.contains("--request-id 'req-cli-proj'"));
    }

    #[test]
    fn stop_message_projection_command_omits_identity_and_session_dir_flags() {
        let output = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: Some("stop_message_auto".to_string()),
            flow_id: Some("stop_message_flow".to_string()),
            input: Some(json!({
                "flowId": "stop_message_flow",
                "repeatCount": 1,
                "maxRepeats": 3
            })),
            repeat_count: Some(1),
            max_repeats: Some(3),
            stdout_preview: None,
            session_dir: Some("/tmp/stopless-should-not-leak".to_string()),
            session_id: Some("sess-stop-proj".to_string()),
            request_id: Some("req-stop-proj".to_string()),
        })
        .expect("stop projection output");

        let command = output
            .get("execCommand")
            .and_then(Value::as_str)
            .expect("execCommand");
        assert!(!command.contains("--session-dir"));
        assert!(!command.contains("--session-id"));
        assert!(!command.contains("--request-id"));
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
                session_dir: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
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
                session_dir: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect_err("old marker must fail");
        assert_eq!(err, ServertoolCliError::DeniedMarker("old_cli_"));
    }

    #[test]
    fn cli_rejects_old_markers_in_tool_name_and_explicit_flow() {
        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "old_cli_123".to_string(),
                input: json!({"value":1}),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect_err("old marker in tool name must fail");
        assert_eq!(err, ServertoolCliError::DeniedMarker("old_cli_"));

        let err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "servertool_fixture".to_string(),
                input: json!({"value":1}),
                flow_id: Some("stcli_123".to_string()),
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect_err("old marker in flow id must fail");
        assert_eq!(err, ServertoolCliError::DeniedMarker("stcli_"));
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
                session_dir: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
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
                "continuationPrompt": "第一轮核对：补齐 stop schema",
                "repeatCount": 2,
                "maxRepeats": 5
            })),
            repeat_count: None,
            max_repeats: None,
            stdout_preview: Some("preview".to_string()),
            session_dir: None,
            session_id: None,
            request_id: None,
        })
        .expect("projection output");
        assert_eq!(out["toolName"], "stop_message_auto");
        assert_eq!(out["flowId"], "stop_message_flow");
        assert_eq!(out["repeatCount"], 2);
        assert_eq!(out["maxRepeats"], 5);
        assert!(out.get("continuationPrompt").is_none());
        assert!(out.get("schemaGuidance").is_none());
        let cmd = out["execCommand"].as_str().unwrap();
        assert!(cmd.contains("routecodex hook run"));
        assert!(!cmd.contains("continuationPrompt"));
        assert!(!cmd.contains("第一轮核对"));
        assert!(!cmd.contains("stdoutPreview"));
        assert!(!cmd.contains("schemaGuidance"));
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
                    "repeatCount": 1,
                    "maxRepeats": 3
                })),
                repeat_count: None,
                max_repeats: None,
                stdout_preview: None,
                session_dir: None,
            session_id: None,
            request_id: None,
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
                    "continuationPrompt": "continue with full schema",
                    "repeatCount": 4,
                    "maxRepeats": 3,
                    "triggerHint": "no_schema"
                })),
                repeat_count: Some(4),
                max_repeats: Some(3),
                stdout_preview: None,
                session_dir: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            }),
            Err(ServertoolCliError::InvalidField("repeatCount/maxRepeats"))
        );
    }

    #[test]
    fn projection_plan_rejects_old_markers_in_explicit_tool_and_flow() {
        assert_eq!(
            plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
                tool_name: Some("old_cli_123".to_string()),
                flow_id: Some("servertool_cli_projection".to_string()),
                input: Some(json!({"value": 1})),
                repeat_count: None,
                max_repeats: None,
                stdout_preview: None,
                session_dir: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            }),
            Err(ServertoolCliError::DeniedMarker("old_cli_"))
        );
        assert_eq!(
            plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
                tool_name: Some("servertool_fixture".to_string()),
                flow_id: Some("rcc_cli_123".to_string()),
                input: Some(json!({"value": 1})),
                repeat_count: None,
                max_repeats: None,
                stdout_preview: None,
                session_dir: None,
                session_id: Some("session-test".to_string()),
                request_id: Some("req-test".to_string()),
            }),
            Err(ServertoolCliError::DeniedMarker("rcc_cli_"))
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
            session_dir: None,
            session_id: None,
            request_id: None,
        })
        .expect("fixture projection");
        assert_eq!(out["toolName"], "servertool_fixture");
        assert_eq!(out["flowId"], "servertool_fixture");
        assert_eq!(
            out["execCommand"],
            "routecodex hook run servertool_fixture --input-json '{\"value\":1}'"
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
            session_dir: None,
            session_id: None,
            request_id: None,
        })
        .expect("projection output");
        let command = out["execCommand"].as_str().expect("exec command");
        let prefix = "routecodex hook run reasoning_stop --input-json '";
        assert!(command.starts_with(prefix));
        let input_start = prefix.len();
        let input_json = if let Some(input_end) = command[input_start..]
            .find("' --repeat-count")
            .or_else(|| command[input_start..].find("' --max-repeats"))
        {
            &command[input_start..input_start + input_end]
        } else {
            command[input_start..]
                .strip_suffix('\'')
                .expect("input json quoted block present")
        };
        let decoded = input_json.replace("'\\''", "'");
        let parsed: Value = serde_json::from_str(&decoded).expect("quoted json");
        assert_eq!(
            parsed,
            json!({
                "flowId": "stop_message_flow",
                "repeatCount": 2,
                "maxRepeats": 5,
                "triggerHint": "no_schema"
            })
        );
        assert!(!command.contains("continuationPrompt"));
        assert!(!command.contains("can't stop"));
    }

    #[test]
    fn client_visible_projection_shell_omits_responses_reasoning_content_array() {
        let native_projection = build_client_exec_cli_projection_output(
            "stop_message_auto",
            "stop_message_flow",
            json!({"repeatCount":2,"maxRepeats":5}),
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
        assert!(shell.get("__servertool_cli_projection").is_none());
        let serialized = serde_json::to_string(&shell).expect("serialize shell");
        for denied in [
            "reenterPipeline",
            "providerInvoker",
            "serverToolFollowup",
            "serverToolFollowupSource",
            "restorationHandle",
            "restorationStore",
            "ticket",
            "__rt",
            "metadata",
        ] {
            assert!(
                !serialized.contains(denied),
                "client-visible stopless CLI shell leaked private carrier {denied}"
            );
        }
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
    fn projection_output_rejects_old_markers_in_tool_and_flow() {
        assert_eq!(
            build_client_exec_cli_projection_output(
                "old_cli_123",
                "servertool_cli_projection",
                json!({"value":1}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedMarker("old_cli_"))
        );
        assert_eq!(
            build_client_exec_cli_projection_output(
                "servertool_fixture",
                "stcli_123",
                json!({"value":1}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedMarker("stcli_"))
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
    fn projection_rejects_private_carrier_text_input() {
        assert_eq!(
            build_client_exec_cli_projection_output(
                "servertool_fixture",
                "servertool_cli_projection",
                json!({"value":"serverToolFollowup should never be client-visible"}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedInternalCarrier(
                "serverToolFollowup"
            ))
        );
        assert_eq!(
            build_client_exec_cli_projection_output(
                "servertool_fixture",
                "servertool_cli_projection",
                json!({"value":"providerInvoker carrier leaked"}),
                0,
                0,
            ),
            Err(ServertoolCliError::DeniedInternalCarrier("providerInvoker"))
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
            Some("routecodex hook run servertool_fixture --input-json '{\"value\":1}'")
        );
        assert!(out.get("schemaGuidance").is_none());
    }

    #[test]
    fn projection_plan_error_codes_are_documented_in_tests() {
        let repeat_over_budget = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "continuationPrompt": "continue",
                    "repeatCount": 4,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: Some(format!(
                    "session-over-budget-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_nanos() as u64)
                        .unwrap_or(0)
                )),
                request_id: Some("req-test".to_string()),
            },
        )
        .expect("over budget must return terminal output, not error");
        assert_eq!(repeat_over_budget.ok, true);
        assert_eq!(repeat_over_budget.summary, "stopless budget exhausted");
        assert_eq!(repeat_over_budget.repeat_count, 3);
        assert_eq!(repeat_over_budget.max_repeats, 3);
        assert!(!repeat_over_budget.continuation_prompt.is_empty());

        let flow_err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "continuationPrompt": "continue",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: Some(format!(
                    "session-missing-flow-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_nanos() as u64)
                        .unwrap_or(0)
                )),
                request_id: Some("req-missing-flow".to_string()),
            },
        )
        .expect_err("missing flow id must fail fast");
        assert_eq!(flow_err.to_string(), "SERVERTOOL_CLI_MISSING_FIELD: flowId");

        let denied_err = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "fake_exec".to_string(),
                input: json!({"value": 1}),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: Some("session-denied-tool".to_string()),
                request_id: Some("req-denied-tool".to_string()),
            },
        )
        .expect_err("fake_exec must be denied");
        assert_eq!(denied_err.to_string(), "SERVERTOOL_DENIED_TOOL: fake_exec");
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
    fn exec_result_validation_rejects_old_markers_in_tool_and_flow() {
        let raw = json!({"toolName": "old_cli_123", "flowId": "servertool_cli_projection"});
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::DeniedMarker("old_cli_"))
        );
        let raw = json!({"toolName": "servertool_fixture", "flowId": "rcc_cli_123"});
        assert_eq!(
            validate_client_exec_command_result(&raw.to_string()),
            Err(ServertoolCliError::DeniedMarker("rcc_cli_"))
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

    // ── trigger hint branch tests ──────────────────────────────────────────

    #[test]
    fn stopless_cli_output_with_explicit_invalid_schema_trigger_hints_produces_invalid_schema_hint() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "triggerHint": "invalid_schema",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: Some("session-trigger-test".to_string()),
                request_id: Some("req-trigger-test".to_string()),
            },
        )
        .expect("stop_message_auto output");
        let schema_guidance = output.schema_guidance.expect("must carry schema guidance");
        assert_eq!(
            schema_guidance.trigger_hint, "invalid_schema",
            "explicit invalid_schema triggerHint must map to invalid_schema"
        );
        // output.input must also carry triggerHint
        let inp = output.input;
        assert_eq!(inp["triggerHint"], "invalid_schema");
    }

    #[test]
    fn stopless_cli_invalid_schema_uses_current_trigger_prompt() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "triggerHint": "invalid_schema",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: None,
                request_id: None,
            },
        )
        .expect("stop_message_auto output");

        assert!(!output.continuation_prompt.is_empty());
        let schema_guidance = output.schema_guidance.expect("must carry schema guidance");
        assert_eq!(schema_guidance.trigger_hint, "invalid_schema");
    }

    #[test]
    fn stopless_cli_output_with_explicit_non_terminal_schema_trigger_hints_produces_non_terminal_schema_hint() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "triggerHint": "non_terminal_schema",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: Some("session-trigger-test".to_string()),
                request_id: Some("req-trigger-test".to_string()),
            },
        )
        .expect("stop_message_auto output");
        let schema_guidance = output.schema_guidance.expect("must carry schema guidance");
        assert_eq!(
            schema_guidance.trigger_hint, "non_terminal_schema",
            "explicit non_terminal_schema triggerHint must map to non_terminal_schema"
        );
        let inp = output.input;
        assert_eq!(inp["triggerHint"], "non_terminal_schema");
    }

    #[test]
    fn stopless_cli_output_with_explicit_budget_exhausted_trigger_hints_produces_budget_exhausted_hint() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "triggerHint": "budget_exhausted",
                    "repeatCount": 3,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: Some("session-trigger-test".to_string()),
                request_id: Some("req-trigger-test".to_string()),
            },
        )
        .expect("stop_message_auto output");
        let schema_guidance = output.schema_guidance.expect("must carry schema guidance");
        assert_eq!(
            schema_guidance.trigger_hint, "budget_exhausted",
            "explicit budget_exhausted triggerHint must map to budget_exhausted"
        );
        let inp = output.input;
        assert_eq!(inp["triggerHint"], "budget_exhausted");
    }

    #[test]
    fn stopless_cli_output_with_explicit_schema_pass_trigger_hints_produces_schema_pass_hint() {
        let output = build_servertool_cli_binary_run_command_from_client_exec_result(
            ServertoolCliRunInput {
                tool_name: "stop_message_auto".to_string(),
                input: json!({
                    "flowId": "stop_message_flow",
                    "triggerHint": "schema_pass",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                flow_id: None,
                repeat_count: None,
                max_repeats: None,
                session_dir: None,
                session_id: Some("session-trigger-test".to_string()),
                request_id: Some("req-trigger-test".to_string()),
            },
        )
        .expect("stop_message_auto output");
        let schema_guidance = output.schema_guidance.expect("must carry schema guidance");
        assert_eq!(
            schema_guidance.trigger_hint, "schema_pass",
            "explicit schema_pass triggerHint must map to schema_pass"
        );
        let inp = output.input;
        assert_eq!(inp["triggerHint"], "schema_pass");
    }

    // projection_output_quotes_json_apostrophes already covers triggerHint in command JSON
    // but we add a dedicated projection triggerHint test for clarity:
    #[test]
    fn plan_projection_includes_trigger_hint_in_command_json() {
        let out = plan_client_exec_cli_projection_output(ClientExecCliProjectionInput {
            tool_name: Some("stop_message_auto".to_string()),
            flow_id: Some("stop_message_flow".to_string()),
            input: Some(json!({"repeatCount": 1, "maxRepeats": 3})),
            repeat_count: None,
            max_repeats: None,
            stdout_preview: None,
            session_dir: None,
            session_id: None,
            request_id: None,
        })
        .expect("projection output");
        let command = out["execCommand"].as_str().expect("exec command");
        // triggerHint must appear in the JSON embedded in the shell command
        assert!(command.contains("triggerHint"), "projection command must include triggerHint: {}", command);
    }


}
