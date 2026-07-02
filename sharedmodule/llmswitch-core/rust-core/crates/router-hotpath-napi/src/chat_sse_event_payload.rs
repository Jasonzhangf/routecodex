use crate::hub_reasoning_tool_normalizer::normalize_message_reasoning_tools_record;
use crate::shared_chat_output_normalizer::normalize_chat_message_content;
use serde_json::{Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

fn current_unix_timestamp_ms() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Chat SSE event clock before UNIX_EPOCH: {}", error))?;
    i64::try_from(duration.as_millis()).map_err(|_| "Chat SSE event timestamp overflow".to_string())
}

pub fn build_chat_sse_event_envelope_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse Chat SSE event envelope JSON: {}", error))?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE event envelope expected object".to_string());
    };
    let request_id = input
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Chat SSE event envelope missing request_id".to_string())?;
    let current_sequence = input
        .get("current_sequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Chat SSE event envelope missing current_sequence".to_string())?;
    if current_sequence < 0 {
        return Err("Chat SSE event envelope current_sequence must be non-negative".to_string());
    }
    let enable_timestamp_generation = input
        .get("enable_timestamp_generation")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let enable_sequence_numbers = input
        .get("enable_sequence_numbers")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let sequence_number = if enable_sequence_numbers {
        current_sequence
    } else {
        0
    };
    let next_sequence_counter = if enable_sequence_numbers {
        current_sequence + 1
    } else {
        current_sequence
    };
    let timestamp = if enable_timestamp_generation {
        current_unix_timestamp_ms()?
    } else {
        0
    };

    serde_json::to_string(&serde_json::json!({
        "requestId": request_id,
        "timestamp": timestamp,
        "sequenceNumber": sequence_number,
        "nextSequenceCounter": next_sequence_counter,
        "protocol": "chat",
        "direction": "json_to_sse"
    }))
    .map_err(|error| {
        format!(
            "Failed to serialize Chat SSE event envelope JSON: {}",
            error
        )
    })
}

pub fn build_chat_sse_error_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse Chat SSE error payload JSON: {}", error))?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE error payload expected object".to_string());
    };
    let message = input
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Chat SSE error payload missing message".to_string())?;

    serde_json::to_string(&serde_json::json!({
        "error": {
            "message": message,
            "type": "internal_error",
            "code": "generation_error"
        }
    }))
    .map_err(|error| format!("Failed to serialize Chat SSE error payload JSON: {}", error))
}

fn read_required_string<'a>(
    row: &'a serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<&'a str, String> {
    row.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Chat SSE {} missing {}", label, field))
}

fn read_required_i64(
    row: &serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<i64, String> {
    row.get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Chat SSE {} missing {}", label, field))
}

fn read_chat_usage_token(value: Option<&Value>, field: &str) -> Result<i64, String> {
    let Some(value) = value else {
        return Err("Invalid Chat usage: missing token fields".to_string());
    };
    let parsed = match value {
        Value::Number(number) => number
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(f64::round),
        Value::String(raw) if !raw.trim().is_empty() => raw
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(f64::round),
        _ => None,
    };
    parsed
        .filter(|value| *value <= i64::MAX as f64)
        .map(|value| value as i64)
        .ok_or_else(|| format!("Invalid Chat usage.{}", field))
}

fn read_chat_finish_usage(input: &serde_json::Map<String, Value>) -> Result<Option<Value>, String> {
    let Some(usage) = input.get("usage") else {
        return Ok(None);
    };
    if usage.is_null() {
        return Ok(None);
    }
    let Some(usage) = usage.as_object() else {
        return Err("Invalid Chat usage: expected object".to_string());
    };
    let prompt_tokens = read_chat_usage_token(usage.get("prompt_tokens"), "prompt_tokens")?;
    let completion_tokens =
        read_chat_usage_token(usage.get("completion_tokens"), "completion_tokens")?;
    let total_tokens = read_chat_usage_token(usage.get("total_tokens"), "total_tokens")?;

    Ok(Some(serde_json::json!({
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens
    })))
}

pub fn build_chat_sse_role_delta_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        format!(
            "Failed to parse Chat SSE role delta payload JSON: {}",
            error
        )
    })?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE role delta payload expected object".to_string());
    };
    let response_id = read_required_string(input, "response_id", "role delta payload")?;
    let model = read_required_string(input, "model", "role delta payload")?;
    let role = read_required_string(input, "role", "role delta payload")?;
    match role {
        "user" | "system" | "assistant" | "tool" => {}
        _ => {
            return Err(format!(
                "Chat SSE role delta payload invalid role: {}",
                role
            ))
        }
    }
    let created = read_required_i64(input, "created", "role delta payload")?;
    if created <= 0 {
        return Err("Chat SSE role delta payload created must be positive".to_string());
    }
    let choice_index = read_required_i64(input, "choice_index", "role delta payload")?;
    if choice_index < 0 {
        return Err("Chat SSE role delta payload choice_index must be non-negative".to_string());
    }

    serde_json::to_string(&serde_json::json!({
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": choice_index,
            "delta": { "role": role },
            "logprobs": null,
            "finish_reason": null
        }]
    }))
    .map_err(|error| {
        format!(
            "Failed to serialize Chat SSE role delta payload JSON: {}",
            error
        )
    })
}

pub fn build_chat_sse_content_delta_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        format!(
            "Failed to parse Chat SSE content delta payload JSON: {}",
            error
        )
    })?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE content delta payload expected object".to_string());
    };
    let response_id = read_required_string(input, "response_id", "content delta payload")?;
    let model = read_required_string(input, "model", "content delta payload")?;
    let content = read_required_string(input, "content", "content delta payload")?;
    let created = read_required_i64(input, "created", "content delta payload")?;
    if created <= 0 {
        return Err("Chat SSE content delta payload created must be positive".to_string());
    }
    let choice_index = read_required_i64(input, "choice_index", "content delta payload")?;
    if choice_index < 0 {
        return Err("Chat SSE content delta payload choice_index must be non-negative".to_string());
    }

    serde_json::to_string(&serde_json::json!({
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": choice_index,
            "delta": { "content": content },
            "logprobs": null,
            "finish_reason": null
        }]
    }))
    .map_err(|error| {
        format!(
            "Failed to serialize Chat SSE content delta payload JSON: {}",
            error
        )
    })
}

pub fn build_chat_sse_reasoning_delta_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        format!(
            "Failed to parse Chat SSE reasoning delta payload JSON: {}",
            error
        )
    })?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE reasoning delta payload expected object".to_string());
    };
    let response_id = read_required_string(input, "response_id", "reasoning delta payload")?;
    let model = read_required_string(input, "model", "reasoning delta payload")?;
    let reasoning = read_required_string(input, "reasoning", "reasoning delta payload")?;
    let created = read_required_i64(input, "created", "reasoning delta payload")?;
    if created <= 0 {
        return Err("Chat SSE reasoning delta payload created must be positive".to_string());
    }
    let choice_index = read_required_i64(input, "choice_index", "reasoning delta payload")?;
    if choice_index < 0 {
        return Err(
            "Chat SSE reasoning delta payload choice_index must be non-negative".to_string(),
        );
    }

    serde_json::to_string(&serde_json::json!({
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": choice_index,
            "delta": {
                "reasoning": reasoning,
                "reasoning_content": reasoning
            },
            "logprobs": null,
            "finish_reason": null
        }]
    }))
    .map_err(|error| {
        format!(
            "Failed to serialize Chat SSE reasoning delta payload JSON: {}",
            error
        )
    })
}

pub fn build_chat_sse_tool_call_args_delta_payload_json(
    input_json: String,
) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        format!(
            "Failed to parse Chat SSE tool call args delta payload JSON: {}",
            error
        )
    })?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE tool call args delta payload expected object".to_string());
    };
    let response_id = read_required_string(input, "response_id", "tool call args delta payload")?;
    let model = read_required_string(input, "model", "tool call args delta payload")?;
    let arguments = read_required_string(input, "arguments", "tool call args delta payload")?;
    let created = read_required_i64(input, "created", "tool call args delta payload")?;
    if created <= 0 {
        return Err("Chat SSE tool call args delta payload created must be positive".to_string());
    }
    let choice_index = read_required_i64(input, "choice_index", "tool call args delta payload")?;
    if choice_index < 0 {
        return Err(
            "Chat SSE tool call args delta payload choice_index must be non-negative".to_string(),
        );
    }
    let tool_call_index =
        read_required_i64(input, "tool_call_index", "tool call args delta payload")?;
    if tool_call_index < 0 {
        return Err(
            "Chat SSE tool call args delta payload tool_call_index must be non-negative"
                .to_string(),
        );
    }

    serde_json::to_string(&serde_json::json!({
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": choice_index,
            "delta": {
                "tool_calls": [{
                    "index": tool_call_index,
                    "function": { "arguments": arguments }
                }]
            },
            "logprobs": null,
            "finish_reason": null
        }]
    }))
    .map_err(|error| {
        format!(
            "Failed to serialize Chat SSE tool call args delta payload JSON: {}",
            error
        )
    })
}

pub fn build_chat_sse_tool_call_start_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        format!(
            "Failed to parse Chat SSE tool call start payload JSON: {}",
            error
        )
    })?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE tool call start payload expected object".to_string());
    };
    let response_id = read_required_string(input, "response_id", "tool call start payload")?;
    let model = read_required_string(input, "model", "tool call start payload")?;
    let tool_call_id = read_required_string(input, "tool_call_id", "tool call start payload")?;
    let tool_call_type = read_required_string(input, "tool_call_type", "tool call start payload")?;
    if tool_call_type != "function" {
        return Err(format!(
            "Chat SSE tool call start payload invalid tool_call_type: {}",
            tool_call_type
        ));
    }
    let function_name = read_required_string(input, "function_name", "tool call start payload")?;
    let created = read_required_i64(input, "created", "tool call start payload")?;
    if created <= 0 {
        return Err("Chat SSE tool call start payload created must be positive".to_string());
    }
    let choice_index = read_required_i64(input, "choice_index", "tool call start payload")?;
    if choice_index < 0 {
        return Err(
            "Chat SSE tool call start payload choice_index must be non-negative".to_string(),
        );
    }
    let tool_call_index = read_required_i64(input, "tool_call_index", "tool call start payload")?;
    if tool_call_index < 0 {
        return Err(
            "Chat SSE tool call start payload tool_call_index must be non-negative".to_string(),
        );
    }

    serde_json::to_string(&serde_json::json!({
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": choice_index,
            "delta": {
                "tool_calls": [{
                    "index": tool_call_index,
                    "id": tool_call_id,
                    "type": tool_call_type,
                    "function": {
                        "name": function_name,
                        "arguments": ""
                    }
                }]
            },
            "logprobs": null,
            "finish_reason": null
        }]
    }))
    .map_err(|error| {
        format!(
            "Failed to serialize Chat SSE tool call start payload JSON: {}",
            error
        )
    })
}

pub fn build_chat_sse_finish_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse Chat SSE finish payload JSON: {}", error))?;
    let Some(input) = input.as_object() else {
        return Err("Chat SSE finish payload expected object".to_string());
    };
    let response_id = read_required_string(input, "response_id", "finish payload")?;
    let model = read_required_string(input, "model", "finish payload")?;
    let finish_reason = read_required_string(input, "finish_reason", "finish payload")?;
    match finish_reason {
        "stop" | "length" | "tool_calls" | "content_filter" | "function_call" => {}
        _ => {
            return Err(format!(
                "Chat SSE finish payload invalid finish_reason: {}",
                finish_reason
            ))
        }
    }
    let created = read_required_i64(input, "created", "finish payload")?;
    if created <= 0 {
        return Err("Chat SSE finish payload created must be positive".to_string());
    }
    let choice_index = read_required_i64(input, "choice_index", "finish payload")?;
    if choice_index < 0 {
        return Err("Chat SSE finish payload choice_index must be non-negative".to_string());
    }
    let usage = read_chat_finish_usage(input)?;

    let mut payload = serde_json::json!({
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": choice_index,
            "delta": {},
            "logprobs": null,
            "finish_reason": finish_reason
        }]
    });
    if let Some(usage) = usage {
        payload
            .as_object_mut()
            .expect("Chat SSE finish payload root must be object")
            .insert("usage".to_string(), usage);
    }

    serde_json::to_string(&payload).map_err(|error| {
        format!(
            "Failed to serialize Chat SSE finish payload JSON: {}",
            error
        )
    })
}

fn read_input_object(input_json: String, label: &str) -> Result<Map<String, Value>, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse {} JSON: {}", label, error))?;
    input
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} expected object", label))
}

fn has_meaningful_content(content: Option<&Value>) -> bool {
    match content {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(row)) => !row.is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => false,
    }
}

fn read_config_bool(config: &Map<String, Value>, field: &str, default_value: bool) -> bool {
    config
        .get(field)
        .and_then(Value::as_bool)
        .unwrap_or(default_value)
}

fn read_reasoning_mode(config: &Map<String, Value>) -> &str {
    config
        .get("reasoningMode")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("channel")
}

fn dispatch_reasoning_for_channel(reasoning: Option<String>, config: &Map<String, Value>) -> Option<String> {
    let raw = reasoning?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || read_reasoning_mode(config) == "drop" {
        return None;
    }
    if read_reasoning_mode(config) == "text" {
        return None;
    }
    Some(trimmed.to_string())
}

fn next_envelope(
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let envelope_raw = build_chat_sse_event_envelope_json(
        serde_json::json!({
            "request_id": request_id,
            "current_sequence": *sequence_counter,
            "enable_timestamp_generation": read_config_bool(config, "enableTimestampGeneration", true),
            "enable_sequence_numbers": read_config_bool(config, "includeSequenceNumbers", true)
        })
        .to_string(),
    )?;
    let envelope = read_input_object(envelope_raw, "Chat SSE event envelope output")?;
    *sequence_counter = envelope
        .get("nextSequenceCounter")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Chat SSE event envelope output missing nextSequenceCounter".to_string())?;
    Ok(envelope)
}

fn push_chat_event(
    events: &mut Vec<Value>,
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
    event_name: &str,
    payload: Value,
) -> Result<(), String> {
    let envelope = next_envelope(request_id, sequence_counter, config)?;
    let timestamp = envelope
        .get("timestamp")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Chat SSE event envelope output missing timestamp".to_string())?;
    let sequence_number = envelope
        .get("sequenceNumber")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Chat SSE event envelope output missing sequenceNumber".to_string())?;
    events.push(serde_json::json!({
        "event": event_name,
        "type": event_name,
        "timestamp": timestamp,
        "data": if event_name == "chat.done" { "[DONE]".to_string() } else { serde_json::to_string(&payload).map_err(|error| format!("Failed to serialize Chat SSE event data: {}", error))? },
        "sequenceNumber": sequence_number,
        "protocol": "chat",
        "direction": "json_to_sse"
    }));
    Ok(())
}

fn build_payload_value(input: Value, builder: fn(String) -> Result<String, String>) -> Result<Value, String> {
    let raw = builder(input.to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("Failed to parse Chat SSE payload JSON: {}", error))
}

pub fn build_chat_sse_event_sequence_json(input_json: String) -> Result<String, String> {
    let input = read_input_object(input_json, "Chat SSE event sequence")?;
    let response = input
        .get("response")
        .and_then(Value::as_object)
        .ok_or_else(|| "Chat SSE event sequence missing response".to_string())?;
    let model = input
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| response.get("model").and_then(Value::as_str))
        .ok_or_else(|| "Chat SSE event sequence missing model".to_string())?;
    let request_id = input
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Chat SSE event sequence missing request_id".to_string())?;
    let response_id = response
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Invalid ChatCompletionResponse: missing id".to_string())?;
    let created = response
        .get("created")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "Invalid ChatCompletionResponse: missing created timestamp".to_string())?;
    let config = input
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let choices = response
        .get("choices")
        .and_then(Value::as_array)
        .filter(|choices| !choices.is_empty())
        .ok_or_else(|| "Invalid ChatCompletionResponse: missing choices".to_string())?;
    let choice = choices
        .first()
        .and_then(Value::as_object)
        .ok_or_else(|| "Invalid ChatCompletionResponse choice".to_string())?;
    let choice_index = choice.get("index").and_then(Value::as_i64).unwrap_or(0);
    if choice_index < 0 {
        return Err("Invalid ChatCompletionResponse choice: negative index".to_string());
    }

    let mut message = choice
        .get("message")
        .and_then(Value::as_object)
        .cloned()
        .or_else(|| {
            let delta = choice.get("delta")?.as_object()?;
            Some(delta.clone())
        })
        .ok_or_else(|| "Invalid ChatCompletionResponse choice: missing message".to_string())?;
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Invalid message sequence for role: unknown".to_string())?
        .to_string();

    if !message.contains_key("tool_calls") {
        if let Some(function_call) = message.get("function_call").and_then(Value::as_object) {
            let id = function_call
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Invalid legacy function_call: missing id".to_string())?;
            let name = function_call
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Invalid legacy function_call: missing name".to_string())?;
            let arguments = function_call
                .get("arguments")
                .and_then(Value::as_str)
                .ok_or_else(|| "Invalid legacy function_call: missing arguments".to_string())?;
            message.insert(
                "tool_calls".to_string(),
                serde_json::json!([{
                    "id": id,
                    "type": "function",
                    "function": { "name": name, "arguments": arguments }
                }]),
            );
        }
    }

    let content_normalization =
        normalize_chat_message_content(message.get("content").unwrap_or(&Value::Null));
    if let Some(content_text) = content_normalization.content_text {
        message.insert("content".to_string(), Value::String(content_text));
    }
    let (_tool_calls_added, cleaned_reasoning) =
        normalize_message_reasoning_tools_record(&mut message, "chat_seq_reasoning_1");
    let reasoning_text = cleaned_reasoning
        .or(content_normalization.reasoning_text)
        .or_else(|| message.get("reasoning_content").and_then(Value::as_str).map(str::to_string))
        .or_else(|| message.get("reasoning").and_then(Value::as_str).map(str::to_string));
    let reasoning_for_channel = dispatch_reasoning_for_channel(reasoning_text, &config);
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if reasoning_for_channel.is_some()
        && tool_calls.is_empty()
        && !has_meaningful_content(message.get("content"))
    {
        message.insert(
            "content".to_string(),
            Value::String(reasoning_for_channel.clone().unwrap()),
        );
    }
    if !has_meaningful_content(message.get("content"))
        && reasoning_for_channel.is_none()
        && tool_calls.is_empty()
    {
        return Err(format!("Invalid message sequence for role: {}", role));
    }

    let finish_reason = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Invalid ChatCompletionResponse choice: missing finish_reason".to_string())?;

    let mut events = Vec::new();
    let mut sequence_counter = 0_i64;
    let common = |extra: Value| -> Value {
        let mut row = extra.as_object().cloned().unwrap_or_default();
        row.insert("response_id".to_string(), Value::String(response_id.to_string()));
        row.insert("created".to_string(), Value::Number(created.into()));
        row.insert("model".to_string(), Value::String(model.to_string()));
        row.insert("choice_index".to_string(), Value::Number(choice_index.into()));
        Value::Object(row)
    };

    push_chat_event(
        &mut events,
        request_id,
        &mut sequence_counter,
        &config,
        "chat_chunk",
        build_payload_value(common(serde_json::json!({ "role": role })), build_chat_sse_role_delta_payload_json)?,
    )?;
    if let Some(reasoning) = reasoning_for_channel {
        push_chat_event(
            &mut events,
            request_id,
            &mut sequence_counter,
            &config,
            "chat_chunk",
            build_payload_value(
                common(serde_json::json!({ "reasoning": reasoning })),
                build_chat_sse_reasoning_delta_payload_json,
            )?,
        )?;
    }
    if let Some(content) = message.get("content").and_then(Value::as_str).filter(|value| !value.is_empty()) {
        push_chat_event(
            &mut events,
            request_id,
            &mut sequence_counter,
            &config,
            "chat_chunk",
            build_payload_value(
                common(serde_json::json!({ "content": content })),
                build_chat_sse_content_delta_payload_json,
            )?,
        )?;
    }
    for (tool_call_index, tool_call) in tool_calls.iter().enumerate() {
        let tool_call = tool_call
            .as_object()
            .ok_or_else(|| "Invalid Chat tool call: expected object".to_string())?;
        let function = tool_call
            .get("function")
            .and_then(Value::as_object)
            .ok_or_else(|| "Invalid Chat tool call: missing function".to_string())?;
        let tool_call_id = tool_call
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Chat SSE tool call start payload missing tool_call_id".to_string())?;
        let tool_call_type = tool_call
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Chat SSE tool call start payload missing tool_call_type".to_string())?;
        let function_name = function
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Chat SSE tool call start payload missing function_name".to_string())?;
        push_chat_event(
            &mut events,
            request_id,
            &mut sequence_counter,
            &config,
            "chat_chunk",
            build_payload_value(
                common(serde_json::json!({
                    "tool_call_index": tool_call_index,
                    "tool_call_id": tool_call_id,
                    "tool_call_type": tool_call_type,
                    "function_name": function_name
                })),
                build_chat_sse_tool_call_start_payload_json,
            )?,
        )?;
        let arguments = function
            .get("arguments")
            .and_then(Value::as_str)
            .ok_or_else(|| "Chat SSE tool call args delta payload missing arguments".to_string())?;
        push_chat_event(
            &mut events,
            request_id,
            &mut sequence_counter,
            &config,
            "chat_chunk",
            build_payload_value(
                common(serde_json::json!({
                    "tool_call_index": tool_call_index,
                    "arguments": arguments
                })),
                build_chat_sse_tool_call_args_delta_payload_json,
            )?,
        )?;
    }

    let mut finish_input = common(serde_json::json!({ "finish_reason": finish_reason }));
    if let Some(usage) = response.get("usage") {
        finish_input
            .as_object_mut()
            .expect("finish input must be object")
            .insert("usage".to_string(), usage.clone());
    }
    push_chat_event(
        &mut events,
        request_id,
        &mut sequence_counter,
        &config,
        "chat_chunk",
        build_payload_value(finish_input, build_chat_sse_finish_payload_json)?,
    )?;
    push_chat_event(
        &mut events,
        request_id,
        &mut sequence_counter,
        &config,
        "chat.done",
        Value::Null,
    )?;

    serde_json::to_string(&events)
        .map_err(|error| format!("Failed to serialize Chat SSE event sequence JSON: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn builds_chat_sse_event_envelope_and_advances_sequence() {
        let output = build_chat_sse_event_envelope_json(
            json!({
                "request_id": "req_chat_envelope",
                "current_sequence": 4,
                "enable_timestamp_generation": false,
                "enable_sequence_numbers": true
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["requestId"], json!("req_chat_envelope"));
        assert_eq!(parsed["timestamp"], json!(0));
        assert_eq!(parsed["sequenceNumber"], json!(4));
        assert_eq!(parsed["nextSequenceCounter"], json!(5));
        assert_eq!(parsed["protocol"], json!("chat"));
        assert_eq!(parsed["direction"], json!("json_to_sse"));
    }

    #[test]
    fn builds_chat_sse_event_envelope_without_sequence_generation() {
        let output = build_chat_sse_event_envelope_json(
            json!({
                "request_id": "req_chat_envelope_no_sequence",
                "current_sequence": 4,
                "enable_timestamp_generation": false,
                "enable_sequence_numbers": false
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["sequenceNumber"], json!(0));
        assert_eq!(parsed["nextSequenceCounter"], json!(4));
    }

    #[test]
    fn rejects_chat_sse_event_envelope_missing_request_id() {
        let err = build_chat_sse_event_envelope_json(
            json!({
                "current_sequence": 0,
                "enable_timestamp_generation": false,
                "enable_sequence_numbers": true
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("missing request_id"));
    }

    #[test]
    fn builds_chat_sse_error_payload() {
        let output = build_chat_sse_error_payload_json(
            json!({
                "message": "Invalid ChatCompletionResponse: missing choices"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(
            parsed,
            json!({
                "error": {
                    "message": "Invalid ChatCompletionResponse: missing choices",
                    "type": "internal_error",
                    "code": "generation_error"
                }
            })
        );
    }

    #[test]
    fn rejects_chat_sse_error_payload_missing_message() {
        let err = build_chat_sse_error_payload_json(json!({}).to_string()).unwrap_err();

        assert!(err.contains("missing message"));
    }

    #[test]
    fn builds_chat_sse_role_delta_payload() {
        let output = build_chat_sse_role_delta_payload_json(
            json!({
                "response_id": "chatcmpl_role_delta",
                "created": 1782778486,
                "model": "gpt-test",
                "choice_index": 0,
                "role": "assistant"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!("chatcmpl_role_delta"));
        assert_eq!(parsed["object"], json!("chat.completion.chunk"));
        assert_eq!(parsed["created"], json!(1782778486));
        assert_eq!(parsed["model"], json!("gpt-test"));
        assert_eq!(parsed["choices"][0]["index"], json!(0));
        assert_eq!(parsed["choices"][0]["delta"]["role"], json!("assistant"));
        assert_eq!(parsed["choices"][0]["finish_reason"], Value::Null);
    }

    #[test]
    fn rejects_chat_sse_role_delta_payload_invalid_role() {
        let err = build_chat_sse_role_delta_payload_json(
            json!({
                "response_id": "chatcmpl_role_delta",
                "created": 1782778486,
                "model": "gpt-test",
                "choice_index": 0,
                "role": "invalid"
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("invalid role"));
    }

    #[test]
    fn builds_chat_sse_content_delta_payload() {
        let output = build_chat_sse_content_delta_payload_json(
            json!({
                "response_id": "chatcmpl_content_delta",
                "created": 1782778487,
                "model": "gpt-test",
                "choice_index": 1,
                "content": "hello world"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!("chatcmpl_content_delta"));
        assert_eq!(parsed["object"], json!("chat.completion.chunk"));
        assert_eq!(parsed["created"], json!(1782778487));
        assert_eq!(parsed["model"], json!("gpt-test"));
        assert_eq!(parsed["choices"][0]["index"], json!(1));
        assert_eq!(
            parsed["choices"][0]["delta"]["content"],
            json!("hello world")
        );
        assert_eq!(parsed["choices"][0]["finish_reason"], Value::Null);
    }

    #[test]
    fn rejects_chat_sse_content_delta_payload_missing_content() {
        let err = build_chat_sse_content_delta_payload_json(
            json!({
                "response_id": "chatcmpl_content_delta",
                "created": 1782778487,
                "model": "gpt-test",
                "choice_index": 1
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("missing content"));
    }

    #[test]
    fn builds_chat_sse_reasoning_delta_payload() {
        let output = build_chat_sse_reasoning_delta_payload_json(
            json!({
                "response_id": "chatcmpl_reasoning_delta",
                "created": 1782778488,
                "model": "qwen-test",
                "choice_index": 0,
                "reasoning": "先检查上下文"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!("chatcmpl_reasoning_delta"));
        assert_eq!(parsed["object"], json!("chat.completion.chunk"));
        assert_eq!(parsed["created"], json!(1782778488));
        assert_eq!(parsed["model"], json!("qwen-test"));
        assert_eq!(parsed["choices"][0]["index"], json!(0));
        assert_eq!(
            parsed["choices"][0]["delta"]["reasoning"],
            json!("先检查上下文")
        );
        assert_eq!(
            parsed["choices"][0]["delta"]["reasoning_content"],
            json!("先检查上下文")
        );
        assert_eq!(parsed["choices"][0]["finish_reason"], Value::Null);
    }

    #[test]
    fn rejects_chat_sse_reasoning_delta_payload_missing_reasoning() {
        let err = build_chat_sse_reasoning_delta_payload_json(
            json!({
                "response_id": "chatcmpl_reasoning_delta",
                "created": 1782778488,
                "model": "qwen-test",
                "choice_index": 0
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("missing reasoning"));
    }

    #[test]
    fn builds_chat_sse_tool_call_args_delta_payload() {
        let output = build_chat_sse_tool_call_args_delta_payload_json(
            json!({
                "response_id": "chatcmpl_tool_args_delta",
                "created": 1782778489,
                "model": "gpt-test",
                "choice_index": 0,
                "tool_call_index": 2,
                "arguments": "{\"cmd\":\"pwd\"}"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!("chatcmpl_tool_args_delta"));
        assert_eq!(parsed["object"], json!("chat.completion.chunk"));
        assert_eq!(parsed["created"], json!(1782778489));
        assert_eq!(parsed["model"], json!("gpt-test"));
        assert_eq!(parsed["choices"][0]["index"], json!(0));
        assert_eq!(
            parsed["choices"][0]["delta"]["tool_calls"][0]["index"],
            json!(2)
        );
        assert_eq!(
            parsed["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"],
            json!("{\"cmd\":\"pwd\"}")
        );
        assert_eq!(parsed["choices"][0]["finish_reason"], Value::Null);
    }

    #[test]
    fn rejects_chat_sse_tool_call_args_delta_payload_missing_arguments() {
        let err = build_chat_sse_tool_call_args_delta_payload_json(
            json!({
                "response_id": "chatcmpl_tool_args_delta",
                "created": 1782778489,
                "model": "gpt-test",
                "choice_index": 0,
                "tool_call_index": 2
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("missing arguments"));
    }

    #[test]
    fn builds_chat_sse_tool_call_start_payload() {
        let output = build_chat_sse_tool_call_start_payload_json(
            json!({
                "response_id": "chatcmpl_tool_start",
                "created": 1782778490,
                "model": "gpt-test",
                "choice_index": 0,
                "tool_call_index": 3,
                "tool_call_id": "call_test",
                "tool_call_type": "function",
                "function_name": "exec_command"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!("chatcmpl_tool_start"));
        assert_eq!(parsed["object"], json!("chat.completion.chunk"));
        assert_eq!(parsed["created"], json!(1782778490));
        assert_eq!(parsed["model"], json!("gpt-test"));
        assert_eq!(parsed["choices"][0]["index"], json!(0));
        assert_eq!(
            parsed["choices"][0]["delta"]["tool_calls"][0]["index"],
            json!(3)
        );
        assert_eq!(
            parsed["choices"][0]["delta"]["tool_calls"][0]["id"],
            json!("call_test")
        );
        assert_eq!(
            parsed["choices"][0]["delta"]["tool_calls"][0]["type"],
            json!("function")
        );
        assert_eq!(
            parsed["choices"][0]["delta"]["tool_calls"][0]["function"]["name"],
            json!("exec_command")
        );
        assert_eq!(
            parsed["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"],
            json!("")
        );
        assert_eq!(parsed["choices"][0]["finish_reason"], Value::Null);
    }

    #[test]
    fn rejects_chat_sse_tool_call_start_payload_missing_type() {
        let err = build_chat_sse_tool_call_start_payload_json(
            json!({
                "response_id": "chatcmpl_tool_start",
                "created": 1782778490,
                "model": "gpt-test",
                "choice_index": 0,
                "tool_call_index": 3,
                "tool_call_id": "call_test",
                "function_name": "exec_command"
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("missing tool_call_type"));
    }

    #[test]
    fn rejects_chat_sse_tool_call_start_payload_invalid_type() {
        let err = build_chat_sse_tool_call_start_payload_json(
            json!({
                "response_id": "chatcmpl_tool_start",
                "created": 1782778490,
                "model": "gpt-test",
                "choice_index": 0,
                "tool_call_index": 3,
                "tool_call_id": "call_test",
                "tool_call_type": "other",
                "function_name": "exec_command"
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("invalid tool_call_type"));
    }

    #[test]
    fn builds_chat_sse_finish_payload_with_usage() {
        let output = build_chat_sse_finish_payload_json(
            json!({
                "response_id": "chatcmpl_finish",
                "created": 1782778490,
                "model": "gpt-test",
                "choice_index": 0,
                "finish_reason": "tool_calls",
                "usage": {
                    "prompt_tokens": "12",
                    "completion_tokens": 5.4,
                    "total_tokens": 17
                }
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["id"], json!("chatcmpl_finish"));
        assert_eq!(parsed["object"], json!("chat.completion.chunk"));
        assert_eq!(parsed["choices"][0]["index"], json!(0));
        assert_eq!(parsed["choices"][0]["delta"], json!({}));
        assert_eq!(parsed["choices"][0]["finish_reason"], json!("tool_calls"));
        assert_eq!(
            parsed["usage"],
            json!({
                "prompt_tokens": 12,
                "completion_tokens": 5,
                "total_tokens": 17
            })
        );
    }

    #[test]
    fn builds_chat_sse_finish_payload_without_usage() {
        let output = build_chat_sse_finish_payload_json(
            json!({
                "response_id": "chatcmpl_finish_no_usage",
                "created": 1782778490,
                "model": "gpt-test",
                "choice_index": 0,
                "finish_reason": "stop"
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert!(parsed.get("usage").is_none());
        assert_eq!(parsed["choices"][0]["finish_reason"], json!("stop"));
    }

    #[test]
    fn rejects_chat_sse_finish_payload_missing_usage_tokens() {
        let err = build_chat_sse_finish_payload_json(
            json!({
                "response_id": "chatcmpl_finish_bad_usage",
                "created": 1782778490,
                "model": "gpt-test",
                "choice_index": 0,
                "finish_reason": "stop",
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 5
                }
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("Invalid Chat usage: missing token fields"));
    }

    #[test]
    fn rejects_chat_sse_finish_payload_invalid_finish_reason() {
        let err = build_chat_sse_finish_payload_json(
            json!({
                "response_id": "chatcmpl_finish_bad_reason",
                "created": 1782778490,
                "model": "gpt-test",
                "choice_index": 0,
                "finish_reason": "other"
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("invalid finish_reason"));
    }
}
