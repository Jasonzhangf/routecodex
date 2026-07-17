use super::{
    V3HubRelayRequestError, V3HubRelayRequestHookEvent, V3HubRelayResponseError,
    V3HubRelayResponseHookProfile, V3HubRespInbound02Normalized,
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
    if !response_has_stopless_stop_trigger(input.provider_payload().as_ref()) {
        return Ok(input);
    }
    let Some(text) = first_output_text(object.get("output")) else {
        return Ok(input);
    };
    if stop_schema_is_terminal(text) {
        return Ok(input);
    }
    let projected = json!({
        "id": object.get("id").cloned().unwrap_or_else(|| json!("resp_stopless_projected")),
        "status": "requires_action",
        "output": [{
            "type": "function_call",
            "call_id": STOPLESS_CALL_ID,
            "name": "exec_command",
            "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json status-control\"}"
        }]
    });
    *input.provider_payload_mut() = Arc::new(projected);
    Ok(input)
}

pub fn apply_v3_stopless_request_hook_at_req04(
    payload: &mut Value,
    events: &mut Vec<V3HubRelayRequestHookEvent>,
) -> Result<(), V3HubRelayRequestError> {
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        inject_stopless_schema(payload);
        events.push(V3HubRelayRequestHookEvent::Req04StoplessToolInjected);
        return Ok(());
    };
    let Some((index, output)) = input
        .iter()
        .enumerate()
        .find(|(_, item)| is_stopless_cli_output(item))
    else {
        inject_stopless_schema(payload);
        events.push(V3HubRelayRequestHookEvent::Req04StoplessToolInjected);
        return Ok(());
    };
    let next_step = parse_stopless_next_step(output, index)?;
    *input = vec![json!({
        "role": "user",
        "content": next_step
    })];
    events.push(V3HubRelayRequestHookEvent::Req04StoplessResultParsed);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessTextRewritten);
    inject_stopless_schema(payload);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessToolInjected);
    Ok(())
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

fn stop_schema_is_terminal(text: &str) -> bool {
    text.contains("\"stopreason\"")
        && (text.contains("\"stopreason\":0")
            || text.contains("\"stopreason\": 0")
            || text.contains("\"stopreason\":1")
            || text.contains("\"stopreason\": 1"))
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

fn parse_stopless_next_step(
    output: &Value,
    index: usize,
) -> Result<String, V3HubRelayRequestError> {
    let raw = output.get("output").and_then(Value::as_str).ok_or(
        V3HubRelayRequestError::MalformedStoplessCliOutput {
            index,
            reason: "output string is required",
        },
    )?;
    let parsed: Value = serde_json::from_str(raw).map_err(|_| {
        V3HubRelayRequestError::MalformedStoplessCliOutput {
            index,
            reason: "output must be JSON",
        }
    })?;
    Ok(parsed
        .get("next_step")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(STOPLESS_DEFAULT_PROMPT)
        .to_owned())
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
