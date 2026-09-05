//! Provider response protocol hooks.
//!
//! This is the only owner for provider-specific response and SSE projection.
//! The provider crate stops at raw transport bytes; the response inbound
//! NodePluginPlan invokes these hooks and owns the semantic boundary.

use serde_json::{json, Value};

fn normalize_responses_response(
    body: &Value,
    expected_instructions: Option<&str>,
    allow_relay_instructions: bool,
) -> Result<Value, String> {
    const KNOWN_DIAGNOSTIC_FIELDS: &[&str] = &[
        "chunk_index",
        "dropped_compat_plugin_params",
        "latency",
        "original_model_requested",
        "provider",
        "provider_response_headers",
        "request_type",
        "resolved_model_used",
    ];
    let mut object = body
        .as_object()
        .cloned()
        .ok_or_else(|| "provider Responses JSON must be an object".to_string())?;
    if let Some(value) = object.get("instructions") {
        if !allow_relay_instructions && expected_instructions != value.as_str() {
            return Err("provider_response_instructions_injected: provider Responses instructions must exactly match request instructions".to_string());
        }
    }
    if let Some(extra_fields) = object.remove("extra_fields") {
        let Some(extra_fields) = extra_fields.as_object() else {
            return Err("provider_response_control_envelope: Responses extra_fields envelope must be an object".to_string());
        };
        if let Some(unknown) = extra_fields
            .keys()
            .find(|key| !KNOWN_DIAGNOSTIC_FIELDS.contains(&key.as_str()))
        {
            return Err(format!(
                "provider_response_control_envelope: unknown Responses extra_fields member {unknown}"
            ));
        }
    }
    if let Some(response) = object.get_mut("response").and_then(Value::as_object_mut) {
        if let Some(value) = response.get("instructions") {
            if !allow_relay_instructions && expected_instructions != value.as_str() {
                return Err("provider_response_instructions_injected: provider Responses instructions must exactly match request instructions".to_string());
            }
        }
        if let Some(extra_fields) = response.remove("extra_fields") {
            let Some(extra_fields) = extra_fields.as_object() else {
                return Err("provider_response_control_envelope: Responses response.extra_fields envelope must be an object".to_string());
            };
            if let Some(unknown) = extra_fields
                .keys()
                .find(|key| !KNOWN_DIAGNOSTIC_FIELDS.contains(&key.as_str()))
            {
                return Err(format!(
                    "provider_response_control_envelope: unknown Responses response.extra_fields member {unknown}"
                ));
            }
        }
    }
    Ok(Value::Object(object))
}

fn normalize_openai_response(body: &Value) -> Result<Value, String> {
    let object = body
        .as_object()
        .ok_or_else(|| "provider_json_shape: OpenAI Chat response must be an object".to_string())?;
    let choice = object
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| "provider_json_shape: OpenAI Chat response choices must be non-empty".to_string())?;
    let message = choice
        .get("message")
        .ok_or_else(|| "provider_json_shape: OpenAI Chat response message is missing".to_string())?;
    let mut output = Vec::new();
    if let Some(content) = message.get("content") {
        if !content.is_null() {
            output.push(json!({
                "type": "message",
                "content": [{"type": "output_text", "text": content}]
            }));
        }
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for tool in tool_calls {
            let function = tool
                .get("function")
                .ok_or_else(|| "provider_json_shape: OpenAI tool call function is missing".to_string())?;
            output.push(json!({
                "type": "function_call",
                "call_id": tool.get("id").cloned().unwrap_or(Value::Null),
                "name": function.get("name").cloned().unwrap_or(Value::Null),
                "arguments": function.get("arguments").cloned().unwrap_or_else(|| Value::String("{}".to_string()))
            }));
        }
    }
    let mut normalized = json!({
        "id": object.get("id").cloned().unwrap_or(Value::String("response_unknown".to_string())),
        "model": object.get("model").cloned().unwrap_or(Value::Null),
        "status": "completed",
        "output": output
    });
    if let Some(usage) = object.get("usage") {
        normalized["usage"] = json!({
            "input_tokens": usage.get("prompt_tokens").cloned().unwrap_or(Value::Null),
            "output_tokens": usage.get("completion_tokens").cloned().unwrap_or(Value::Null),
            "total_tokens": usage.get("total_tokens").cloned().unwrap_or(Value::Null)
        });
    }
    Ok(normalized)
}

fn normalize_anthropic_response(body: &Value) -> Result<Value, String> {
    let object = body
        .as_object()
        .ok_or_else(|| "provider_json_shape: Anthropic Messages response must be an object".to_string())?;
    let content = object
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "provider_json_shape: Anthropic Messages content must be an array".to_string())?;
    let mut output = Vec::new();
    for item in content {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => output.push(json!({
                "type": "message",
                "content": [{"type": "output_text", "text": item.get("text").cloned().unwrap_or(Value::String(String::new()))}]
            })),
            Some("tool_use") => output.push(json!({
                "type": "function_call",
                "call_id": item.get("id").cloned().unwrap_or(Value::Null),
                "name": item.get("name").cloned().unwrap_or(Value::Null),
                "arguments": serde_json::to_string(item.get("input").unwrap_or(&Value::Object(Default::default()))).unwrap_or_else(|_| "{}".to_string())
            })),
            Some(other) => {
                return Err(format!("provider_json_shape: unsupported Anthropic content type {other}"));
            }
            None => return Err("provider_json_shape: Anthropic content type is missing".to_string()),
        }
    }
    let mut normalized = json!({
        "id": object.get("id").cloned().unwrap_or(Value::String("response_unknown".to_string())),
        "model": object.get("model").cloned().unwrap_or(Value::Null),
        "status": "completed",
        "output": output
    });
    if let Some(usage) = object.get("usage") {
        let input_tokens = usage.get("input_tokens").and_then(Value::as_u64);
        let output_tokens = usage.get("output_tokens").and_then(Value::as_u64);
        let total_tokens = usage
            .get("total_tokens")
            .and_then(Value::as_u64)
            .or_else(|| input_tokens.zip(output_tokens).map(|(input, output)| input + output));
        normalized["usage"] = json!({
            "input_tokens": input_tokens.map(Value::from).unwrap_or(Value::Null),
            "output_tokens": output_tokens.map(Value::from).unwrap_or(Value::Null),
            "total_tokens": total_tokens.map(Value::from).unwrap_or(Value::Null)
        });
    }
    Ok(normalized)
}

/// Normalize a complete provider JSON response into the Responses semantic
/// contract. This hook is called by response inbound, never by transport.
pub fn normalize_provider_response(protocol: &str, body: &Value) -> Result<Value, String> {
    match protocol {
        "responses" => normalize_responses_response(body, None, false),
        "openai" | "chat" => normalize_openai_response(body),
        "anthropic" => normalize_anthropic_response(body),
        other => Err(format!("provider_protocol_unsupported: provider protocol {other} has no response normalizer")),
    }
}

/// Relay Responses may retain provider-owned instructions until the adjacent
/// client hook projects them; direct Responses remains strict.
pub fn normalize_provider_response_for_relay(
    protocol: &str,
    body: &Value,
) -> Result<Value, String> {
    match protocol {
        "responses" => normalize_responses_response(body, None, true),
        _ => normalize_provider_response(protocol, body),
    }
}

fn normalize_openai_sse_event(value: &Value) -> Option<Value> {
    let choice = value.get("choices")?.as_array()?.first()?;
    let delta = choice.get("delta")?;
    if let Some(content) = delta.get("content").and_then(Value::as_str) {
        return Some(json!({"type":"response.output_text.delta","delta":content}));
    }
    if choice
        .get("finish_reason")
        .is_some_and(|reason| !reason.is_null())
    {
        return Some(json!({"type":"response.completed","response":{"status":"completed"}}));
    }
    None
}

fn normalize_anthropic_sse_event(value: &Value) -> Option<Value> {
    match value.get("type").and_then(Value::as_str)? {
        "content_block_delta" => value
            .get("delta")
            .and_then(|delta| delta.get("text"))
            .and_then(Value::as_str)
            .map(|text| json!({"type":"response.output_text.delta","delta":text})),
        "message_stop" => Some(json!({
            "type":"response.completed",
            "response":{"status":"completed"}
        })),
        _ => None,
    }
}

/// Normalize one complete provider SSE frame. Framing/buffering remains the
/// transport owner; this hook only parses data events and projects semantics.
pub fn normalize_provider_sse_frame(
    protocol: &str,
    frame: &[u8],
) -> Result<Vec<u8>, String> {
    normalize_provider_sse_frame_with_lane(protocol, frame, false)
}

pub fn normalize_provider_sse_frame_for_relay(
    protocol: &str,
    frame: &[u8],
) -> Result<Vec<u8>, String> {
    normalize_provider_sse_frame_with_lane(protocol, frame, true)
}

fn normalize_provider_sse_frame_with_lane(
    protocol: &str,
    frame: &[u8],
    allow_relay_instructions: bool,
) -> Result<Vec<u8>, String> {
    let text = std::str::from_utf8(frame)
        .map_err(|error| format!("provider_sse_utf8: {error}"))?;
    let mut output = Vec::new();
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            output.extend_from_slice(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n");
            continue;
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|error| format!("provider_sse_malformed: {error}"))?;
        let event = match protocol {
            "openai" | "chat" => normalize_openai_sse_event(&value),
            "anthropic" => normalize_anthropic_sse_event(&value),
            "responses" => Some(normalize_responses_response(&value, None, allow_relay_instructions)?),
            other => return Err(format!("provider_protocol_unsupported: provider protocol {other} has no SSE normalizer")),
        };
        if let Some(event) = event {
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("response.output_text.delta");
            output.extend_from_slice(
                format!(
                    "event: {event_type}\ndata: {}\n\n",
                    serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string())
                )
                .as_bytes(),
            );
        }
    }
    if output.is_empty() {
        return Err("provider_sse_empty: provider SSE frame contained no data event".to_string());
    }
    Ok(output)
}
