use super::*;

fn normalize_openai_chat_message_content_part(part: &Value) -> Result<Value, String> {
    let mut normalized = project_outbound_nested_payload_for_target_protocol(
        part,
        V3OutboundTargetProtocol::OpenAiChat,
    )?;
    let Some(row) = normalized.as_object_mut() else {
        return Ok(normalized);
    };
    let part_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match part_type.as_str() {
        "input_text" | "output_text" | "commentary" => {
            row.insert("type".to_string(), Value::String("text".to_string()));
        }
        "input_image" => {
            row.insert("type".to_string(), Value::String("image_url".to_string()));
            let image_url_value = match row.get("image_url").cloned() {
                Some(Value::String(url)) => Some(Value::Object(Map::from_iter([(
                    "url".to_string(),
                    Value::String(url),
                )]))),
                Some(Value::Object(existing)) => Some(Value::Object(existing)),
                _ => None,
            };
            if let Some(image_url) = image_url_value {
                row.insert("image_url".to_string(), image_url);
            }
        }
        _ => {}
    }
    Ok(normalized)
}

pub(super) fn normalize_openai_chat_messages_payload(
    payload: &Value,
    model_id: Option<&str>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    has_web_search_capability: bool,
) -> Result<Value, String> {
    let mut normalized = project_outbound_payload_for_target_protocol(
        payload,
        V3OutboundTargetProtocol::OpenAiChat,
    )?;
    if let Some(row) = normalized.as_object_mut() {
        if let Some(max_output_tokens) = row.remove("max_output_tokens") {
            row.entry("max_completion_tokens".to_string())
                .or_insert(max_output_tokens);
        }
        if let Some(reasoning_effort) = project_openai_chat_reasoning_effort_from_reasoning(row) {
            row.entry("reasoning_effort".to_string())
                .or_insert(reasoning_effort);
        }
    }
    let instructions = normalized
        .as_object_mut()
        .and_then(|row| row.remove("instructions"))
        .and_then(|value| value.as_str().map(str::to_string))
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    crate::hub_v1::request_outbound_mcp_names::qualify_openai_chat_missing_mcp_tool_call_names(
        &mut normalized,
    );
    let Some(messages) = normalized.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(normalized);
    };
    if let Some(instructions) = instructions {
        let already_visible = messages.iter().any(|message| {
            matches!(
                message.get("role").and_then(Value::as_str),
                Some("system" | "developer")
            ) && message
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| content.contains(&instructions))
        });
        if !already_visible {
            if let Some(system_message) = messages.iter_mut().find(|message| {
                matches!(
                    message.get("role").and_then(Value::as_str),
                    Some("system" | "developer")
                )
            }) {
                if let Some(system_row) = system_message.as_object_mut() {
                    match system_row.get_mut("content") {
                        Some(Value::String(content)) => {
                            if !content.trim().is_empty() {
                                content.push_str("\n\n");
                            }
                            content.push_str(&instructions);
                        }
                        Some(Value::Array(parts)) => {
                            parts.push(json!({"type": "text", "text": instructions}));
                        }
                        _ => {
                            system_row.insert("content".to_string(), Value::String(instructions));
                        }
                    }
                }
            } else {
                messages.insert(0, json!({"role": "system", "content": instructions}));
            }
        }
    }
    for message in messages.iter_mut() {
        let Some(message_row) = message.as_object_mut() else {
            continue;
        };
        crate::hub_v1::request_outbound_mcp_names::normalize_openai_chat_message_tool_call_names(
            message_row,
        );
        consume_routecodex_chat_extension_for_openai_chat_provider(message_row);
        let Some(content) = message_row.get_mut("content") else {
            continue;
        };
        if let Value::Array(parts) = content {
            let normalized_parts = parts
                .iter()
                .map(normalize_openai_chat_message_content_part)
                .collect::<Result<Vec<_>, String>>()?;
            *content = Value::Array(normalized_parts);
        }
    }
    project_openai_chat_provider_tools_for_web_search_mode(
        &mut normalized,
        model_id,
        web_search_execution_mode,
        has_web_search_capability,
    )?;
    ensure_openai_chat_stream_usage_option(&mut normalized);
    Ok(normalized)
}
fn consume_routecodex_chat_extension_for_openai_chat_provider(
    message_row: &mut Map<String, Value>,
) {
    remove_object_field(message_row, "routecodex_chat_extension");
    let Some(tool_calls) = message_row
        .get_mut("tool_calls")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for tool_call in tool_calls {
        if let Some(tool_call_row) = tool_call.as_object_mut() {
            remove_object_field(tool_call_row, "routecodex_chat_extension");
        }
    }
}

fn project_openai_chat_reasoning_effort_from_reasoning(
    row: &mut Map<String, Value>,
) -> Option<Value> {
    let reasoning = remove_object_field(row, "reasoning")?;
    let effort = reasoning
        .get("effort")
        .and_then(Value::as_str)
        .or_else(|| reasoning.as_str())
        .map(str::trim)
        .filter(|effort| !effort.is_empty())?
        .to_ascii_lowercase();
    (!matches!(
        effort.as_str(),
        "none" | "off" | "disabled" | "disable" | "false"
    ))
    .then(|| Value::String(effort))
}

fn remove_object_field(row: &mut Map<String, Value>, key: &str) -> Option<Value> {
    row.remove(key)
}

fn ensure_openai_chat_stream_usage_option(payload: &mut Value) {
    let Some(row) = payload.as_object_mut() else {
        return;
    };
    if row.get("stream").and_then(Value::as_bool) != Some(true) {
        return;
    }
    if row.contains_key("stream_options") {
        return;
    }
    row.insert("stream_options".to_string(), json!({"include_usage": true}));
}
