use super::{
    V3HubRelayRequestError, V3HubRelayRequestHookEvent, V3HubRelayResponseError,
    V3HubRelayResponseHookProfile, V3HubRespInbound02Normalized, V3StoplessHookState,
};
use serde_json::{json, Value};
use std::sync::Arc;

const STOPLESS_CALL_ID: &str = "call_stopless_reasoning";
const STOPLESS_SCHEMA_INSTRUCTION: &str = "Stopless managed turn: final answers must include a stop schema JSON object with numeric stopreason 0, 1, or 2. Use stopreason=2 with next_step when more work is needed.";
const STOPLESS_DEFAULT_PROMPT: &str = "Continue from the previous stopless hook result.";

pub fn apply_v3_stopless_response_hook_at_resp03(
    mut input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError> {
    if !profile.stopless_reasoning_stop_enabled() {
        return Ok(input);
    }
    let object = input
        .provider_payload()
        .as_object()
        .ok_or(V3HubRelayResponseError::ProviderResponseNotObject)?;
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if status != "completed" {
        return Ok(input);
    }
    let Some(text) = first_output_text(object.get("output")) else {
        return Ok(input);
    };
    let cli_input = match classify_stopless_schema(text) {
        V3StoplessSchemaDecision::Terminal => return Ok(input),
        V3StoplessSchemaDecision::Continue => {
            stopless_cli_input_from_schema(text, profile, "non_terminal_schema")
        }
        V3StoplessSchemaDecision::Invalid => {
            stopless_cli_input_from_schema(text, profile, "invalid_schema")
        }
        V3StoplessSchemaDecision::Missing => {
            if !response_has_stopless_stop_trigger(input.provider_payload().as_ref())
                && !response_is_completed_responses_object(input.provider_payload().as_ref())
            {
                return Ok(input);
            }
            stopless_no_schema_cli_input_from_profile(profile)
        }
    };
    let Some(cli_input) = cli_input else {
        return Ok(input);
    };
    let command = build_stopless_cli_command(Some(&cli_input));
    let projected = json!({
        "id": object.get("id").cloned().unwrap_or_else(|| json!("resp_stopless_projected")),
        "status": "requires_action",
        "output": [{
            "type": "function_call",
            "call_id": STOPLESS_CALL_ID,
            "name": "exec_command",
            "arguments": json!({"cmd": command}).to_string()
        }]
    });
    *input.provider_payload_mut() = Arc::new(projected);
    Ok(input)
}

pub fn apply_v3_stopless_request_hook_at_req04(
    payload: &mut Value,
    events: &mut Vec<V3HubRelayRequestHookEvent>,
) -> Result<Option<V3StoplessHookState>, V3HubRelayRequestError> {
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        inject_stopless_schema(payload);
        events.push(V3HubRelayRequestHookEvent::Req04StoplessToolInjected);
        return Ok(None);
    };
    let Some((index, output)) = input
        .iter()
        .enumerate()
        .find(|(_, item)| is_stopless_cli_output(item))
    else {
        inject_stopless_schema(payload);
        events.push(V3HubRelayRequestHookEvent::Req04StoplessToolInjected);
        return Ok(None);
    };
    let parsed = parse_stopless_cli_output(output, index)?;
    *input = vec![json!({
        "role": "user",
        "content": parsed.next_step
    })];
    events.push(V3HubRelayRequestHookEvent::Req04StoplessResultParsed);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessTextRewritten);
    inject_stopless_schema(payload);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessToolInjected);
    Ok(Some(parsed.state))
}

fn first_output_text(output: Option<&Value>) -> Option<&str> {
    output?.as_array()?.iter().find_map(output_item_text)
}

fn output_item_text(item: &Value) -> Option<&str> {
    match item.get("type").and_then(Value::as_str) {
        Some("output_text") => item.get("text").and_then(Value::as_str),
        Some("message") => item
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| first_message_content_text(item.get("content"))),
        _ => None,
    }
}

fn first_message_content_text(content: Option<&Value>) -> Option<&str> {
    content?
        .as_array()?
        .iter()
        .find_map(|part| match part.get("type").and_then(Value::as_str) {
            Some("output_text" | "text") => part.get("text").and_then(Value::as_str),
            _ => None,
        })
}

fn response_has_stopless_stop_trigger(response: &Value) -> bool {
    [
        &["finish_reason"][..],
        &["finishReason"][..],
        &["stop_reason"][..],
        &["stopReason"][..],
        &["response", "finish_reason"][..],
        &["response", "finishReason"][..],
        &["response", "stop_reason"][..],
        &["response", "stopReason"][..],
        &["choices", "0", "finish_reason"][..],
        &["candidates", "0", "finishReason"][..],
    ]
    .iter()
    .any(|path| {
        response_string_path(response, path).is_some_and(|value| value.eq_ignore_ascii_case("stop"))
    })
}

fn response_is_completed_responses_object(response: &Value) -> bool {
    response
        .get("object")
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("response"))
        && response
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|value| value.eq_ignore_ascii_case("completed"))
}

fn response_string_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for segment in path {
        if let Ok(index) = segment.parse::<usize>() {
            current = current.get(index)?;
        } else {
            current = current.get(*segment)?;
        }
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3StoplessSchemaDecision {
    Missing,
    Invalid,
    Continue,
    Terminal,
}

fn classify_stopless_schema(text: &str) -> V3StoplessSchemaDecision {
    let Some(parsed) = read_stopless_json_object(text) else {
        return classify_stopless_schema_from_scan(text);
    };
    let Some(stopreason_value) = parsed.get("stopreason") else {
        return V3StoplessSchemaDecision::Missing;
    };
    let Some(stopreason) = stopreason_value
        .as_i64()
        .or_else(|| stopreason_value.as_str()?.trim().parse().ok())
    else {
        return V3StoplessSchemaDecision::Invalid;
    };
    match stopreason {
        0 | 1 => V3StoplessSchemaDecision::Terminal,
        2 => V3StoplessSchemaDecision::Continue,
        _ => V3StoplessSchemaDecision::Invalid,
    }
}

fn classify_stopless_schema_from_scan(text: &str) -> V3StoplessSchemaDecision {
    let Some(stopreason) = read_stopless_stopreason_by_scan(text) else {
        return if text.contains("stopreason") {
            V3StoplessSchemaDecision::Invalid
        } else {
            V3StoplessSchemaDecision::Missing
        };
    };
    match stopreason {
        0 | 1 => V3StoplessSchemaDecision::Terminal,
        2 => V3StoplessSchemaDecision::Continue,
        _ => V3StoplessSchemaDecision::Invalid,
    }
}

fn stopless_cli_input_from_schema(
    text: &str,
    profile: &V3HubRelayResponseHookProfile,
    trigger_hint: &'static str,
) -> Option<Value> {
    let mut value =
        read_stopless_json_object(text).filter(|value| value.get("stopreason").is_some())?;
    let state = next_stopless_projection_state(profile, Some(trigger_hint));
    if state.repeat_count >= state.max_repeats {
        return None;
    }
    if let Some(object) = value.as_object_mut() {
        object
            .entry("flowId".to_string())
            .or_insert_with(|| json!("stop_message_flow"));
        object
            .entry("repeatCount".to_string())
            .or_insert_with(|| json!(state.repeat_count));
        object
            .entry("maxRepeats".to_string())
            .or_insert_with(|| json!(state.max_repeats));
        object
            .entry("triggerHint".to_string())
            .or_insert_with(|| json!(trigger_hint));
    }
    Some(value)
}

fn stopless_no_schema_cli_input_from_profile(
    profile: &V3HubRelayResponseHookProfile,
) -> Option<Value> {
    let state = next_stopless_projection_state(profile, Some("no_schema"));
    if state.repeat_count >= state.max_repeats {
        return None;
    }
    Some(json!({
        "flowId": "stop_message_flow",
        "repeatCount": state.repeat_count,
        "maxRepeats": state.max_repeats,
        "triggerHint": state.trigger_hint.unwrap_or_else(|| "no_schema".to_string())
    }))
}

#[derive(Debug, Clone)]
struct V3NextStoplessProjectionState {
    repeat_count: u32,
    max_repeats: u32,
    trigger_hint: Option<String>,
}

fn next_stopless_projection_state(
    profile: &V3HubRelayResponseHookProfile,
    trigger_hint: Option<&str>,
) -> V3NextStoplessProjectionState {
    let current = profile.stopless_request_state();
    V3NextStoplessProjectionState {
        repeat_count: current
            .map(V3StoplessHookState::repeat_count)
            .unwrap_or(0)
            .saturating_add(1),
        max_repeats: current
            .map(V3StoplessHookState::max_repeats)
            .unwrap_or(3)
            .max(1),
        trigger_hint: trigger_hint
            .map(str::to_string)
            .or_else(|| current.and_then(|state| state.trigger_hint().map(str::to_string))),
    }
}

fn read_stopless_json_object(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(trimmed) {
        return Some(Value::Object(object));
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    match serde_json::from_str::<Value>(&text[start..=end]).ok()? {
        Value::Object(object) => Some(Value::Object(object)),
        _ => None,
    }
}

fn build_stopless_cli_command(cli_input: Option<&Value>) -> String {
    let input_json = cli_input
        .map(Value::to_string)
        .unwrap_or_else(|| "{}".to_string());
    let mut command = format!(
        "routecodex hook run reasoningStop --input-json {}",
        shell_quote_for_stopless_cli(&input_json)
    );
    if let Some(cli_input) = cli_input {
        if let Some(repeat_count) = read_stopless_u32_field(cli_input, "repeatCount") {
            command.push_str(&format!(" --repeat-count '{}'", repeat_count));
        }
        if let Some(max_repeats) = read_stopless_u32_field(cli_input, "maxRepeats") {
            command.push_str(&format!(" --max-repeats '{}'", max_repeats));
        }
    }
    command
}

fn shell_quote_for_stopless_cli(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn read_stopless_stopreason_by_scan(text: &str) -> Option<i64> {
    let key_index = text.find("\"stopreason\"")?;
    let tail = &text[key_index + "\"stopreason\"".len()..];
    let colon_index = tail.find(':')?;
    let mut value = tail[colon_index + 1..].trim_start();
    if let Some(rest) = value.strip_prefix('"') {
        value = rest.trim_start();
    }
    let digits: String = value
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '-')
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

fn is_stopless_cli_output(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call_output" | "tool_call_output")
    ) && item
        .get("call_id")
        .and_then(Value::as_str)
        .is_some_and(|call_id| call_id == STOPLESS_CALL_ID)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct V3ParsedStoplessCliOutput {
    next_step: String,
    state: V3StoplessHookState,
}

fn parse_stopless_cli_output(
    output: &Value,
    index: usize,
) -> Result<V3ParsedStoplessCliOutput, V3HubRelayRequestError> {
    let raw = output.get("output").and_then(Value::as_str).ok_or(
        V3HubRelayRequestError::MalformedStoplessCliOutput {
            index,
            reason: "output string is required",
        },
    )?;
    let parsed = parse_stopless_cli_output_json(raw, index)?;
    let next_step = parsed
        .get("next_step")
        .or_else(|| parsed.get("continuationPrompt"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(STOPLESS_DEFAULT_PROMPT)
        .to_owned();
    Ok(V3ParsedStoplessCliOutput {
        next_step,
        state: parse_stopless_state_from_cli_output(&parsed),
    })
}

fn parse_stopless_state_from_cli_output(parsed: &Value) -> V3StoplessHookState {
    let repeat_count = read_stopless_nested_u32(parsed, &["repeatCount", "repeat_count"])
        .or_else(|| {
            parsed
                .get("input")
                .and_then(|input| read_stopless_nested_u32(input, &["repeatCount", "repeat_count"]))
        })
        .unwrap_or(1)
        .max(1);
    let max_repeats = read_stopless_nested_u32(parsed, &["maxRepeats", "max_repeats"])
        .or_else(|| {
            parsed
                .get("input")
                .and_then(|input| read_stopless_nested_u32(input, &["maxRepeats", "max_repeats"]))
        })
        .unwrap_or(3)
        .max(1);
    let trigger_hint = parsed
        .get("input")
        .and_then(|input| read_stopless_nested_string(input, &["triggerHint", "trigger_hint"]))
        .or_else(|| read_stopless_nested_string(parsed, &["triggerHint", "trigger_hint"]))
        .or_else(|| {
            parsed.get("schemaGuidance").and_then(|value| {
                read_stopless_nested_string(value, &["triggerHint", "trigger_hint"])
            })
        })
        .or_else(|| {
            parsed.get("schemaFeedback").and_then(|value| {
                read_stopless_nested_string(value, &["triggerHint", "trigger_hint"])
            })
        })
        .or_else(|| Some("no_schema".to_string()));
    V3StoplessHookState::new(repeat_count, max_repeats, trigger_hint)
}

fn read_stopless_nested_u32(value: &Value, keys: &[&str]) -> Option<u32> {
    keys.iter()
        .find_map(|key| read_stopless_u32_field(value, key))
}

fn read_stopless_u32_field(value: &Value, key: &str) -> Option<u32> {
    value.get(key).and_then(|field| {
        field
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .or_else(|| field.as_str()?.trim().parse().ok())
    })
}

fn read_stopless_nested_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|field| !field.is_empty())
            .map(str::to_string)
    })
}

fn parse_stopless_cli_output_json(
    raw: &str,
    index: usize,
) -> Result<Value, V3HubRelayRequestError> {
    serde_json::from_str(raw.trim())
        .or_else(|_| {
            let Some(stdout) = codex_exec_output_section(raw) else {
                return Err(());
            };
            serde_json::from_str(stdout.trim()).map_err(|_| ())
        })
        .map_err(|_| V3HubRelayRequestError::MalformedStoplessCliOutput {
            index,
            reason: "output must be JSON",
        })
}

fn codex_exec_output_section(raw: &str) -> Option<&str> {
    ["Output:\n", "Output:\r\n", "Output:\r"]
        .iter()
        .find_map(|marker| raw.rfind(marker).map(|index| &raw[index + marker.len()..]))
}

fn inject_stopless_schema(payload: &mut Value) {
    match payload.get_mut("instructions") {
        Some(Value::String(existing)) if !existing.contains("stopreason") => {
            existing.push('\n');
            existing.push_str(STOPLESS_SCHEMA_INSTRUCTION);
        }
        Some(Value::String(_)) => {}
        _ => {
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "instructions".to_string(),
                    Value::String(STOPLESS_SCHEMA_INSTRUCTION.to_string()),
                );
            }
        }
    }
}
