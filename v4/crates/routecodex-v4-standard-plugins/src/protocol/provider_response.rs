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
        .ok_or_else(|| {
            "provider_json_shape: OpenAI Chat response choices must be non-empty".to_string()
        })?;
    let message = choice.get("message").ok_or_else(|| {
        "provider_json_shape: OpenAI Chat response message is missing".to_string()
    })?;
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
            let function = tool.get("function").ok_or_else(|| {
                "provider_json_shape: OpenAI tool call function is missing".to_string()
            })?;
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
    let object = body.as_object().ok_or_else(|| {
        "provider_json_shape: Anthropic Messages response must be an object".to_string()
    })?;
    let content = object
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "provider_json_shape: Anthropic Messages content must be an array".to_string()
        })?;
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
            .or_else(|| {
                input_tokens
                    .zip(output_tokens)
                    .map(|(input, output)| input + output)
            });
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
        other => Err(format!(
            "provider_protocol_unsupported: provider protocol {other} has no response normalizer"
        )),
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

fn normalize_chat_usage(value: &Value) -> Option<Value> {
    let usage = value.get("usage")?.as_object()?;
    let mut projected = serde_json::Map::new();
    for (source, target) in [
        ("prompt_tokens", "input_tokens"),
        ("completion_tokens", "output_tokens"),
        ("total_tokens", "total_tokens"),
    ] {
        if let Some(value) = usage.get(source) {
            projected.insert(target.to_string(), value.clone());
        }
    }
    (!projected.is_empty()).then_some(Value::Object(projected))
}

fn normalize_openai_sse_event(value: &Value) -> Result<Vec<Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "OpenAI Chat SSE chunk must be an object".to_string())?;
    let choices = object
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| "OpenAI Chat SSE choices must be an array".to_string())?;
    let response_id = object
        .get("id")
        .cloned()
        .unwrap_or_else(|| Value::String("response_unknown".to_string()));
    let response_model = object.get("model").cloned().unwrap_or(Value::Null);
    let usage = normalize_chat_usage(value);
    let mut events = Vec::new();

    for choice in choices {
        let choice = choice
            .as_object()
            .ok_or_else(|| "OpenAI Chat SSE choice must be an object".to_string())?;
        let output_index = choice.get("index").and_then(Value::as_u64).unwrap_or(0);
        let delta = choice
            .get("delta")
            .and_then(Value::as_object)
            .ok_or_else(|| "OpenAI Chat SSE delta must be an object".to_string())?;
        let before_delta = events.len();

        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            if !content.is_empty() {
                events.push(json!({
                    "type": "response.output_text.delta",
                    "output_index": output_index,
                    "content_index": 0,
                    "delta": content
                }));
            }
        }
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
        {
            if !reasoning.is_empty() {
                events.push(json!({
                    "type": "response.reasoning_summary_text.delta",
                    "output_index": output_index,
                    "summary_index": 0,
                    "delta": reasoning
                }));
            }
        }
        if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for tool in tool_calls {
                let tool = tool
                    .as_object()
                    .ok_or_else(|| "OpenAI Chat SSE tool call must be an object".to_string())?;
                let tool_index = tool
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(output_index);
                let call_id = tool.get("id").cloned();
                let function = tool.get("function").and_then(Value::as_object);
                let name = function.and_then(|function| function.get("name")).cloned();
                let arguments = function
                    .and_then(|function| function.get("arguments"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if call_id.is_some() || name.is_some() {
                    events.push(json!({
                        "type": "response.output_item.added",
                        "output_index": tool_index,
                        "item": {
                            "type": "function_call",
                            "call_id": call_id.unwrap_or(Value::Null),
                            "name": name.unwrap_or(Value::Null),
                            "arguments": arguments
                        }
                    }));
                } else if !arguments.is_empty() {
                    events.push(json!({
                        "type": "response.function_call_arguments.delta",
                        "output_index": tool_index,
                        "delta": arguments
                    }));
                }
            }
        }

        if let Some(finish_reason) = choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
        {
            let (event_type, status, incomplete_reason) = match finish_reason {
                "stop" | "tool_calls" | "function_call" => {
                    ("response.completed", "completed", None)
                }
                "length" => (
                    "response.incomplete",
                    "incomplete",
                    Some("max_output_tokens"),
                ),
                "content_filter" => ("response.incomplete", "incomplete", Some("content_filter")),
                other => {
                    return Err(format!(
                        "OpenAI Chat SSE finish_reason is unsupported: {other}"
                    ))
                }
            };
            let mut response = json!({
                "id": response_id,
                "model": response_model,
                "status": status,
                "output": []
            });
            if let Some(reason) = incomplete_reason {
                response["incomplete_details"] = json!({"reason": reason});
            }
            if let Some(usage) = usage.clone() {
                response["usage"] = usage;
            }
            events.push(json!({"type": event_type, "response": response}));
        } else if events.len() == before_delta && delta.contains_key("role") {
            events.push(json!({
                "type": "response.in_progress",
                "response": {
                    "id": response_id,
                    "model": response_model,
                    "status": "in_progress",
                    "output": []
                }
            }));
        }
    }
    Ok(events)
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
pub fn normalize_provider_sse_frame(protocol: &str, frame: &[u8]) -> Result<Vec<u8>, String> {
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
    let text = std::str::from_utf8(frame).map_err(|error| format!("provider_sse_utf8: {error}"))?;
    let mut output = Vec::new();
    let mut current_event: Option<String> = None;
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            current_event = None;
            continue;
        }
        if let Some(event) = line.strip_prefix("event:") {
            current_event = Some(event.trim().to_string());
            continue;
        }
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
        let mut events = match protocol {
            "openai" | "chat" => normalize_openai_sse_event(&value)?,
            "anthropic" => normalize_anthropic_sse_event(&value).into_iter().collect(),
            "responses" => vec![normalize_responses_response(
                &value,
                None,
                allow_relay_instructions,
            )?],
            other => return Err(format!(
                "provider_protocol_unsupported: provider protocol {other} has no SSE normalizer"
            )),
        };
        if protocol == "responses" {
            for event in &mut events {
                let Some(event_object) = event.as_object_mut() else {
                    continue;
                };
                if !event_object.contains_key("type") {
                    if let Some(event_name) = current_event
                        .as_ref()
                        .filter(|name| !name.trim().is_empty())
                    {
                        event_object.insert("type".to_string(), Value::String(event_name.clone()));
                    }
                }
            }
        }
        for event in events {
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    "provider Responses SSE event object must contain type after event-name normalization"
                        .to_string()
                })?;
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
