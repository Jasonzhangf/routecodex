use serde_json::{json, Map, Value};

pub(crate) fn build_v3_chat_canonical_request_from_responses_payload(
    payload: &Value,
) -> Result<Value, String> {
    let root = payload.as_object().ok_or_else(|| {
        "Responses request payload must be an object before OpenAI Chat encoding".to_string()
    })?;
    let input = match root.get("input") {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => vec![json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": text}]
        })],
        _ => {
            return Err(
                "Responses request payload must contain input array before OpenAI Chat encoding"
                    .to_string(),
            );
        }
    };
    let mut messages = Vec::new();
    let mut pending_tool_message_index: Option<usize> = None;
    let mut pending_tool_call_ids: Vec<String> = Vec::new();
    if let Some(instructions) = root
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        messages.push(json!({"role":"system","content":instructions}));
    }
    let original_tools = root.get("tools").cloned();
    let mut tools = original_tools
        .as_ref()
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for item in input.iter() {
        let item = item.as_object().ok_or_else(|| {
            "Responses input item must be an object before OpenAI Chat encoding".to_string()
        })?;
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        match item_type {
            "additional_tools" => {
                let embedded = item.get("tools").and_then(Value::as_array).ok_or_else(|| {
                    "Responses additional_tools.tools must be an array before OpenAI Chat encoding"
                        .to_string()
                })?;
                for tool in embedded {
                    tools.push(tool.clone());
                }
            }
            "message" => append_v3_openai_chat_message_preserving_tool_adjacency(
                &mut messages,
                &mut pending_tool_message_index,
                &pending_tool_call_ids,
                build_v3_openai_chat_message_from_responses_message(item)?,
            )?,
            "reasoning" => {}
            "function_call" | "tool_call" | "custom_tool_call" => {
                append_v3_openai_chat_tool_call_message(
                    &mut messages,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    build_v3_openai_chat_assistant_tool_call_message(item)?,
                )?;
            }
            "function_call_output"
            | "tool_call_output"
            | "custom_tool_call_output"
            | "tool_result"
            | "tool_message" => {
                append_v3_openai_chat_tool_result_message(
                    &mut messages,
                    &mut pending_tool_message_index,
                    &mut pending_tool_call_ids,
                    build_v3_openai_chat_tool_result_message(item)?,
                )?;
            }
            other => {
                return Err(format!(
                    "unsupported Responses input item type for OpenAI Chat provider encoding: {other}"
                ));
            }
        }
    }
    if messages.is_empty() {
        return Err("OpenAI Chat provider encoding produced no messages".to_string());
    }
    let mut request = Map::new();
    if let Some(model) = root.get("model") {
        request.insert("model".to_string(), model.clone());
    }
    request.insert("messages".to_string(), Value::Array(messages));
    if !tools.is_empty() {
        request.insert("tools".to_string(), Value::Array(tools));
    } else if let Some(value) = original_tools.filter(|value| !value.is_null()) {
        request.insert("tools".to_string(), value);
    }
    for key in [
        "tool_choice",
        "parallel_tool_calls",
        "user",
        "temperature",
        "top_p",
        "logit_bias",
        "seed",
        "stream",
        "response_format",
        "max_tokens",
        "max_output_tokens",
        "metadata",
        "client_metadata",
        "stop",
    ] {
        if let Some(value) = root.get(key) {
            request.insert(key.to_string(), value.clone());
        }
    }
    Ok(Value::Object(request))
}

fn append_v3_openai_chat_message_preserving_tool_adjacency(
    messages: &mut Vec<Value>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_call_ids: &[String],
    message: Value,
) -> Result<(), String> {
    if let Some(index) = *pending_tool_message_index {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .trim();
        if role.eq_ignore_ascii_case("assistant") {
            merge_v3_openai_chat_message_into_pending_tool_message(messages, index, &message)?;
            return Ok(());
        }
        if v3_openai_chat_message_has_visible_payload(&message) {
            return Err(format!(
                "OpenAI Chat provider encoding cannot place {role} message before pending tool results: {}",
                pending_tool_call_ids.join(",")
            ));
        }
    }
    messages.push(message);
    Ok(())
}

fn append_v3_openai_chat_tool_call_message(
    messages: &mut Vec<Value>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_call_ids: &mut Vec<String>,
    message: Value,
) -> Result<(), String> {
    let call_ids = collect_v3_openai_chat_tool_call_ids(&message);
    if call_ids.is_empty() {
        messages.push(message);
        return Ok(());
    }
    if let Some(index) = *pending_tool_message_index {
        merge_v3_openai_chat_message_into_pending_tool_message(messages, index, &message)?;
    } else {
        messages.push(message);
        *pending_tool_message_index = Some(messages.len() - 1);
    }
    for call_id in call_ids {
        if !pending_tool_call_ids.iter().any(|entry| entry == &call_id) {
            pending_tool_call_ids.push(call_id);
        }
    }
    Ok(())
}

fn append_v3_openai_chat_tool_result_message(
    messages: &mut Vec<Value>,
    pending_tool_message_index: &mut Option<usize>,
    pending_tool_call_ids: &mut Vec<String>,
    message: Value,
) -> Result<(), String> {
    let call_id = message
        .get("tool_call_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(call_id) = call_id {
        if let Some(position) = pending_tool_call_ids
            .iter()
            .position(|entry| entry == &call_id)
        {
            messages.push(message);
            pending_tool_call_ids.remove(position);
            if pending_tool_call_ids.is_empty() {
                *pending_tool_message_index = None;
            }
            return Ok(());
        }
    }
    messages.push(message);
    Ok(())
}

fn merge_v3_openai_chat_message_into_pending_tool_message(
    messages: &mut [Value],
    index: usize,
    source: &Value,
) -> Result<(), String> {
    let target = messages
        .get_mut(index)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            "OpenAI Chat provider encoding pending tool message is not an object".to_string()
        })?;
    if let Some(source_tool_calls) = source.get("tool_calls").and_then(Value::as_array) {
        let target_tool_calls = target
            .entry("tool_calls".to_string())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| {
                "OpenAI Chat provider encoding pending tool_calls is not an array".to_string()
            })?;
        target_tool_calls.extend(source_tool_calls.iter().cloned());
    }
    if let Some(source_content) = source.get("content") {
        merge_v3_openai_chat_message_content(target, source_content);
    }
    if let Some(source_reasoning) = source
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let existing = target
            .get("reasoning_content")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default();
        let merged = if existing.trim().is_empty() {
            source_reasoning.to_string()
        } else {
            format!("{existing}\n{source_reasoning}")
        };
        target.insert("reasoning_content".to_string(), Value::String(merged));
    }
    Ok(())
}

fn merge_v3_openai_chat_message_content(target: &mut Map<String, Value>, source_content: &Value) {
    if v3_openai_chat_content_is_empty(source_content) {
        return;
    }
    let Some(existing) = target.get_mut("content") else {
        target.insert("content".to_string(), source_content.clone());
        return;
    };
    if v3_openai_chat_content_is_empty(existing) {
        *existing = source_content.clone();
        return;
    }
    match (existing, source_content) {
        (Value::String(existing_text), Value::String(source_text)) => {
            if !existing_text.trim().is_empty() && !source_text.trim().is_empty() {
                existing_text.push('\n');
            }
            existing_text.push_str(source_text);
        }
        (existing_value, source_value) => {
            let mut parts = v3_openai_chat_content_to_parts(existing_value);
            parts.extend(v3_openai_chat_content_to_parts(source_value));
            *existing_value = Value::Array(parts);
        }
    }
}

fn v3_openai_chat_content_is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        Value::Array(parts) => parts.is_empty(),
        _ => false,
    }
}

fn v3_openai_chat_content_to_parts(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(parts) => parts.clone(),
        Value::String(text) => {
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![json!({"type":"text","text":text})]
            }
        }
        Value::Null => Vec::new(),
        other => vec![other.clone()],
    }
}

fn v3_openai_chat_message_has_visible_payload(message: &Value) -> bool {
    message
        .get("content")
        .is_some_and(|content| !v3_openai_chat_content_is_empty(content))
        || message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|tool_calls| !tool_calls.is_empty())
}

fn collect_v3_openai_chat_tool_call_ids(message: &Value) -> Vec<String> {
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|tool_calls| {
            tool_calls
                .iter()
                .filter_map(|call| {
                    call.get("id")
                        .or_else(|| call.get("call_id"))
                        .or_else(|| call.get("tool_call_id"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(crate) fn build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(
    payload: &Value,
) -> Result<Value, String> {
    if responses_payload_needs_req04_original_surface(payload) {
        return Err(
            "Responses inbound payload contains request-side Chat Process original-surface items"
                .to_string(),
        );
    }
    build_v3_chat_canonical_request_from_responses_payload(payload)
}

fn responses_payload_needs_req04_original_surface(payload: &Value) -> bool {
    let Some(input) = payload.get("input").and_then(Value::as_array) else {
        return false;
    };
    input
        .iter()
        .any(responses_input_item_needs_req04_original_surface)
}

fn responses_input_item_needs_req04_original_surface(item: &Value) -> bool {
    match item.get("type").and_then(Value::as_str).unwrap_or_default() {
        "function_call"
        | "tool_call"
        | "custom_tool_call"
        | "function_call_output"
        | "tool_call_output"
        | "custom_tool_call_output"
        | "tool_result"
        | "tool_message" => return true,
        _ => {}
    }
    item.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|part| {
            matches!(
                part.get("type").and_then(Value::as_str),
                Some("input_image" | "image_url")
            )
        })
}

fn build_v3_openai_chat_message_from_responses_message(
    item: &Map<String, Value>,
) -> Result<Value, String> {
    let role = item
        .get("role")
        .and_then(Value::as_str)
        .map(v3_openai_chat_wire_role)
        .unwrap_or("user");
    let (content, mut reasoning_segments) =
        build_v3_openai_chat_content_from_responses_content(item.get("content"))?;
    reasoning_segments.extend(collect_v3_openai_chat_reasoning_segments(
        item.get("reasoning_content")
            .or_else(|| item.get("reasoning_text"))
            .or_else(|| item.get("thinking")),
    ));
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String(role.to_string()));
    message.insert("content".to_string(), content);
    if let Some(reasoning_content) =
        join_v3_openai_chat_reasoning_segments(reasoning_segments.as_slice())
    {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning_content),
        );
    }
    Ok(Value::Object(message))
}

fn build_v3_openai_chat_assistant_tool_call_message(
    item: &Map<String, Value>,
) -> Result<Value, String> {
    let call_id = read_v3_non_empty_str(item.get("call_id"))
        .or_else(|| read_v3_non_empty_str(item.get("tool_call_id")))
        .or_else(|| read_v3_non_empty_str(item.get("id")))
        .ok_or_else(|| {
            "Responses function_call is missing call_id/id before OpenAI Chat encoding".to_string()
        })?;
    let name = read_v3_non_empty_str(item.get("name"))
        .or_else(|| {
            item.get("function")
                .and_then(Value::as_object)
                .and_then(|function| read_v3_non_empty_str(function.get("name")))
        })
        .ok_or_else(|| {
            "Responses function_call is missing name before OpenAI Chat encoding".to_string()
        })?;
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    let arguments = if item_type == "custom_tool_call" {
        let input = item.get("input").ok_or_else(|| {
            "Responses custom_tool_call is missing input before OpenAI Chat encoding".to_string()
        })?;
        let input = match input {
            Value::String(text) => Value::String(text.clone()),
            other => {
                Value::String(serde_json::to_string(other).map_err(|error| error.to_string())?)
            }
        };
        serde_json::to_string(&json!({ "input": input })).map_err(|error| error.to_string())?
    } else {
        let arguments = item
            .get("arguments")
            .or_else(|| {
                item.get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("arguments"))
            })
            .ok_or("Responses function_call is missing arguments before OpenAI Chat encoding")?;
        match arguments {
            Value::String(text) => text.clone(),
            other => serde_json::to_string(other).map_err(|error| error.to_string())?,
        }
    };
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    message.insert("content".to_string(), Value::String(String::new()));
    message.insert(
        "tool_calls".to_string(),
        Value::Array(vec![json!({
            "id":call_id,
            "type":"function",
            "function":{"name":name,"arguments":arguments}
        })]),
    );
    if let Some(reasoning_content) = join_v3_openai_chat_reasoning_segments(
        collect_v3_openai_chat_reasoning_segments(
            item.get("reasoning_content")
                .or_else(|| item.get("reasoning_text"))
                .or_else(|| item.get("thinking")),
        )
        .as_slice(),
    ) {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning_content),
        );
    }
    Ok(Value::Object(message))
}

fn build_v3_openai_chat_tool_result_message(item: &Map<String, Value>) -> Result<Value, String> {
    let call_id = read_v3_non_empty_str(item.get("tool_call_id"))
        .or_else(|| read_v3_non_empty_str(item.get("call_id")))
        .or_else(|| read_v3_non_empty_str(item.get("tool_use_id")))
        .or_else(|| read_v3_non_empty_str(item.get("id")))
        .ok_or_else(|| {
            "Responses tool output is missing call_id/tool_call_id before OpenAI Chat encoding"
                .to_string()
        })?;
    let output = item
        .get("output")
        .or_else(|| item.get("content"))
        .ok_or("Responses tool output is missing output/content before OpenAI Chat encoding")?;
    let content = match output {
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).map_err(|error| error.to_string())?,
    };
    Ok(json!({"role":"tool","tool_call_id":call_id,"content":content}))
}

fn build_v3_openai_chat_content_from_responses_content(
    content: Option<&Value>,
) -> Result<(Value, Vec<String>), String> {
    let Some(content) = content else {
        return Ok((Value::String(String::new()), Vec::new()));
    };
    if let Some(text) = content.as_str() {
        return Ok((Value::String(text.to_string()), Vec::new()));
    }
    let Some(parts) = content.as_array() else {
        return Ok((Value::String(content.to_string()), Vec::new()));
    };
    let mut text_segments = Vec::new();
    let mut converted_parts = Vec::new();
    let mut reasoning_segments = Vec::new();
    let mut text_only = true;
    for part in parts {
        let object = part.as_object().ok_or_else(|| {
            "Responses message content part must be an object before OpenAI Chat encoding"
                .to_string()
        })?;
        match object.get("type").and_then(Value::as_str) {
            Some("input_text" | "output_text" | "text") => {
                let text = object
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                text_segments.push(text.to_string());
                converted_parts.push(json!({"type":"text","text":text}));
            }
            Some("reasoning_text" | "thinking" | "reasoning") => {
                reasoning_segments.extend(collect_v3_openai_chat_reasoning_segments(Some(part)));
            }
            Some("input_image" | "image_url") => {
                text_only = false;
                converted_parts.push(convert_v3_responses_image_part_to_openai_chat_part(object));
            }
            Some(other) => {
                return Err(format!(
                    "unsupported Responses message content part for OpenAI Chat provider encoding: {other}"
                ));
            }
            None => {
                return Err(
                    "Responses message content part is missing type before OpenAI Chat encoding"
                        .to_string(),
                );
            }
        }
    }
    if text_only {
        Ok((Value::String(text_segments.join("")), reasoning_segments))
    } else {
        Ok((Value::Array(converted_parts), reasoning_segments))
    }
}

fn collect_v3_openai_chat_reasoning_segments(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    match value {
        Value::String(text) => read_v3_trimmed_owned(text).into_iter().collect(),
        Value::Array(items) => items
            .iter()
            .flat_map(|item| collect_v3_openai_chat_reasoning_segments(Some(item)))
            .collect(),
        Value::Object(row) => row
            .get("text")
            .or_else(|| row.get("content"))
            .or_else(|| row.get("reasoning_content"))
            .or_else(|| row.get("thinking"))
            .into_iter()
            .flat_map(|item| collect_v3_openai_chat_reasoning_segments(Some(item)))
            .collect(),
        _ => Vec::new(),
    }
}

fn join_v3_openai_chat_reasoning_segments(segments: &[String]) -> Option<String> {
    let joined = segments
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    read_v3_trimmed_owned(joined.as_str())
}

fn read_v3_trimmed_owned(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn convert_v3_responses_image_part_to_openai_chat_part(part: &Map<String, Value>) -> Value {
    if part.get("type").and_then(Value::as_str) == Some("image_url") {
        return Value::Object(part.clone());
    }
    let image_url = part
        .get("image_url")
        .cloned()
        .or_else(|| part.get("url").cloned())
        .unwrap_or(Value::Null);
    json!({"type":"image_url","image_url":image_url})
}

fn v3_openai_chat_wire_role(role: &str) -> &str {
    match role {
        "developer" => "system",
        other => other,
    }
}

fn read_v3_non_empty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
