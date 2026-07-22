use serde_json::{json, Map, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub(crate) fn build_v3_openai_chat_standard_request_from_chat_canonical(
    payload: &Value,
) -> Result<Value, String> {
    if payload.get("messages").and_then(Value::as_array).is_none() && payload.get("input").is_some()
    {
        let chat =
            super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
                payload,
            )?;
        return Ok(normalize_openai_chat_messages_payload(&chat));
    }
    if payload.get("messages").and_then(Value::as_array).is_none() {
        return Err("OpenAI Chat provider wire requires Chat canonical messages".to_string());
    }
    Ok(normalize_openai_chat_messages_payload(payload))
}

pub(crate) fn build_v3_openai_responses_standard_request_from_chat_canonical(
    payload: &Value,
) -> Result<Value, String> {
    if payload.get("messages").and_then(Value::as_array).is_none()
        && payload.get("input").and_then(Value::as_array).is_some()
    {
        return Ok(normalize_responses_payload_for_provider_standard(payload));
    }
    let messages = payload
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Responses provider wire requires Chat canonical messages".to_string())?;
    let mut responses_payload = Map::new();
    if let Some(model) = payload.get("model") {
        responses_payload.insert("model".to_string(), model.clone());
    }
    responses_payload.insert(
        "input".to_string(),
        build_responses_input_from_chat_messages(messages),
    );
    for key in [
        "tools",
        "tool_choice",
        "instructions",
        "temperature",
        "top_p",
        "max_output_tokens",
        "max_tokens",
        "stream",
        "parallel_tool_calls",
        "user",
        "logit_bias",
        "seed",
        "response_format",
        "metadata",
        "client_metadata",
        "stop",
    ] {
        if let Some(value) = payload.get(key) {
            responses_payload.insert(key.to_string(), value.clone());
        }
    }
    Ok(normalize_responses_payload_for_provider_standard(
        &Value::Object(responses_payload),
    ))
}

fn normalize_responses_payload_for_provider_standard(payload: &Value) -> Value {
    let mut normalized = strip_private_fields(payload);
    let instructions = normalized
        .as_object_mut()
        .and_then(|row| row.remove("instructions"))
        .and_then(|value| value.as_str().map(str::to_string))
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    if let Some(instructions) = instructions {
        lift_responses_instructions_into_input(&mut normalized, instructions);
    }
    normalized
}

fn lift_responses_instructions_into_input(payload: &mut Value, instructions: String) {
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    if input
        .iter()
        .any(|item| responses_system_message_contains(item, &instructions))
    {
        return;
    }
    if let Some(system_item) = input
        .iter_mut()
        .find(|item| responses_input_item_is_system_message(item))
    {
        append_responses_system_instruction(system_item, instructions);
        return;
    }
    input.insert(
        0,
        json!({
            "type": "message",
            "role": "system",
            "content": [{"type": "input_text", "text": instructions}]
        }),
    );
}

fn responses_input_item_is_system_message(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("message")
        && matches!(
            item.get("role").and_then(Value::as_str),
            Some("system" | "developer")
        )
}

fn responses_system_message_contains(item: &Value, needle: &str) -> bool {
    if !responses_input_item_is_system_message(item) {
        return false;
    }
    match item.get("content") {
        Some(Value::String(text)) => text.contains(needle),
        Some(Value::Array(parts)) => parts.iter().any(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains(needle))
        }),
        _ => false,
    }
}

fn append_responses_system_instruction(item: &mut Value, instructions: String) {
    let Some(row) = item.as_object_mut() else {
        return;
    };
    match row.get_mut("content") {
        Some(Value::Array(parts)) => {
            parts.push(json!({"type": "input_text", "text": instructions}));
        }
        Some(Value::String(text)) => {
            if !text.trim().is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(&instructions);
        }
        _ => {
            row.insert(
                "content".to_string(),
                Value::Array(vec![json!({"type": "input_text", "text": instructions})]),
            );
        }
    }
}

pub(crate) fn build_v3_responses_original_input_surface_from_chat_canonical(
    payload: &Value,
    original_responses_payload: Option<&Value>,
) -> Option<Value> {
    let original = original_responses_payload?;
    original.get("input").and_then(Value::as_array)?;
    let mut projected = strip_private_fields(original);
    merge_chat_governance_into_original_responses_surface(&mut projected, payload);
    if !has_responses_non_message_input_surface(&projected) {
        return Some(normalize_responses_payload_for_provider_standard(
            &projected,
        ));
    }
    Some(projected)
}

fn has_responses_non_message_input_surface(payload: &Value) -> bool {
    payload
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("message")
                    != "message"
            })
        })
}

fn merge_chat_governance_into_original_responses_surface(projected: &mut Value, payload: &Value) {
    let Some(projected_object) = projected.as_object_mut() else {
        return;
    };
    let Some(payload_object) = payload.as_object() else {
        return;
    };
    for key in [
        "instructions",
        "tool_choice",
        "parallel_tool_calls",
        "temperature",
        "top_p",
        "max_output_tokens",
        "max_tokens",
        "stream",
        "user",
        "logit_bias",
        "seed",
        "response_format",
        "metadata",
        "client_metadata",
        "stop",
    ] {
        if let Some(value) = payload_object.get(key) {
            projected_object.insert(key.to_string(), value.clone());
        }
    }
    let Some(tools) = payload_object
        .get("tools")
        .and_then(Value::as_array)
        .filter(|tools| !tools.is_empty())
        .cloned()
    else {
        return;
    };
    if projected_object.get("tools").is_some() {
        projected_object.insert("tools".to_string(), Value::Array(tools));
        return;
    }
    if replace_first_additional_tools_surface(projected_object, tools.as_slice()) {
        projected_object.remove("tools");
        return;
    }
    projected_object.insert("tools".to_string(), Value::Array(tools));
}

fn replace_first_additional_tools_surface(
    projected_object: &mut Map<String, Value>,
    tools: &[Value],
) -> bool {
    let Some(input) = projected_object
        .get_mut("input")
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let Some(additional_tools) = input.iter_mut().find(|item| {
        item.get("type").and_then(Value::as_str) == Some("additional_tools")
            && item.as_object().is_some()
    }) else {
        return false;
    };
    if let Some(row) = additional_tools.as_object_mut() {
        row.insert("tools".to_string(), Value::Array(tools.to_vec()));
        return true;
    }
    false
}

fn strip_private_fields(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut new_map = Map::new();
            for (key, val) in map {
                if !is_provider_outbound_control_key(key) && !key.starts_with('_') {
                    new_map.insert(key.clone(), strip_private_fields(val));
                }
            }
            Value::Object(new_map)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(strip_private_fields).collect()),
        _ => value.clone(),
    }
}

fn is_provider_outbound_control_key(key: &str) -> bool {
    matches!(
        key,
        "routecodex_internal"
            | "routecodexInternal"
            | "metadata_center"
            | "metadataCenter"
            | "__metadataCenter"
            | "continuation_owner"
            | "continuationOwner"
            | "runtime_control"
            | "runtimeControl"
            | "request_truth"
            | "requestTruth"
            | "route_selection"
            | "routeSelection"
            | "retry_exclusion_set"
            | "retryExclusionSet"
            | "selected_target"
            | "selectedTarget"
            | "resume_meta"
            | "resumeMeta"
            | "servertool_state"
            | "servertoolState"
            | "stopless_state"
            | "stoplessState"
            | "stopless_center"
            | "stoplessCenter"
            | "__routecodex_stopless_center"
            | "error_chain"
            | "errorChain"
            | "node_trace"
            | "nodeTrace"
            | "capturedChatRequest"
            | "entryOriginRequest"
            | "requestSemantics"
            | "responsesRequestContext"
            | "__raw_request_body"
            | "__rt"
            | "__rccDryRunSerialized"
    )
}

fn normalize_responses_content_part_for_role(part: &Value, role: &str) -> Value {
    let mut normalized = strip_private_fields(part);
    let is_assistant = role.eq_ignore_ascii_case("assistant");
    if let Some(row) = normalized.as_object_mut() {
        let part_type = row.get("type").and_then(Value::as_str).unwrap_or("").trim();
        if part_type == "text" || (!is_assistant && part_type.is_empty()) {
            row.insert("type".to_string(), Value::String("input_text".to_string()));
        } else if is_assistant && (part_type.is_empty() || part_type == "input_text") {
            row.insert("type".to_string(), Value::String("output_text".to_string()));
        } else if part_type == "image_url" {
            row.insert("type".to_string(), Value::String("input_image".to_string()));
        }
        if row.get("type").and_then(Value::as_str) == Some("input_image") {
            if let Some(url) = row
                .get("image_url")
                .and_then(Value::as_object)
                .and_then(|image_url| image_url.get("url"))
                .and_then(Value::as_str)
                .map(str::to_string)
            {
                row.insert("image_url".to_string(), Value::String(url));
            }
        }
    }
    normalized
}

fn chat_content_to_responses_content(content: &Value, role: &str) -> Value {
    let text_type = if role.eq_ignore_ascii_case("assistant") {
        "output_text"
    } else {
        "input_text"
    };
    match content {
        Value::String(text) => Value::Array(vec![json!({"type": text_type, "text": text})]),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|part| normalize_responses_content_part_for_role(part, role))
                .collect::<Vec<Value>>(),
        ),
        Value::Null => Value::Array(Vec::new()),
        other => Value::Array(vec![normalize_responses_content_part_for_role(other, role)]),
    }
}

fn chat_tool_call_to_responses_input_item(call: &Value) -> Option<Value> {
    let row = call.as_object()?;
    let function = row.get("function").and_then(Value::as_object);
    let call_id = row
        .get("call_id")
        .or_else(|| row.get("tool_call_id"))
        .or_else(|| row.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let name = function
        .and_then(|entry| entry.get("name"))
        .or_else(|| row.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let arguments = function
        .and_then(|entry| entry.get("arguments"))
        .or_else(|| row.get("arguments"))
        .cloned()
        .unwrap_or_else(|| Value::String("{}".to_string()));
    let arguments_text = arguments
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string(&arguments).unwrap_or_else(|_| "{}".to_string()));

    Some(Value::Object(Map::from_iter([
        (
            "type".to_string(),
            Value::String("function_call".to_string()),
        ),
        ("id".to_string(), Value::String(call_id.to_string())),
        ("call_id".to_string(), Value::String(call_id.to_string())),
        ("name".to_string(), Value::String(name.to_string())),
        ("arguments".to_string(), Value::String(arguments_text)),
    ])))
}

fn chat_tool_result_to_responses_input_item(row: &Map<String, Value>) -> Option<Value> {
    let call_id = row
        .get("tool_call_id")
        .or_else(|| row.get("call_id"))
        .or_else(|| row.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let output = row
        .get("content")
        .or_else(|| row.get("output"))
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => serde_json::to_string(other).unwrap_or_else(|_| String::new()),
        })
        .unwrap_or_default();

    Some(Value::Object(Map::from_iter([
        (
            "type".to_string(),
            Value::String("function_call_output".to_string()),
        ),
        ("id".to_string(), Value::String(call_id.to_string())),
        ("call_id".to_string(), Value::String(call_id.to_string())),
        ("output".to_string(), Value::String(output)),
    ])))
}

pub(crate) fn build_responses_input_from_chat_messages(messages: &[Value]) -> Value {
    Value::Array(
        messages
            .iter()
            .flat_map(|message| {
                let Some(row) = message.as_object() else {
                    return Vec::new();
                };
                let role = row
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("user")
                    .trim();
                if role.eq_ignore_ascii_case("tool") {
                    return chat_tool_result_to_responses_input_item(row)
                        .into_iter()
                        .collect::<Vec<_>>();
                }
                if role.eq_ignore_ascii_case("assistant") {
                    if let Some(tool_calls) = row.get("tool_calls").and_then(Value::as_array) {
                        let items = tool_calls
                            .iter()
                            .filter_map(chat_tool_call_to_responses_input_item)
                            .collect::<Vec<Value>>();
                        if !items.is_empty() {
                            return items;
                        }
                    }
                }
                let content = row
                    .get("content")
                    .map(|content| chat_content_to_responses_content(content, role))
                    .unwrap_or_else(|| Value::Array(Vec::new()));
                vec![Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("message".to_string())),
                    (
                        "role".to_string(),
                        Value::String(if role.is_empty() { "user" } else { role }.to_string()),
                    ),
                    ("content".to_string(), content),
                ]))]
            })
            .collect::<Vec<Value>>(),
    )
}

fn normalize_openai_chat_message_content_part(part: &Value) -> Value {
    let mut normalized = strip_private_fields(part);
    let Some(row) = normalized.as_object_mut() else {
        return normalized;
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
    normalized
}

fn normalize_openai_chat_messages_payload(payload: &Value) -> Value {
    let mut normalized = strip_private_fields(payload);
    let instructions = normalized
        .as_object_mut()
        .and_then(|row| row.remove("instructions"))
        .and_then(|value| value.as_str().map(str::to_string))
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let Some(messages) = normalized.get_mut("messages").and_then(Value::as_array_mut) else {
        return normalized;
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
        let Some(content) = message_row.get_mut("content") else {
            continue;
        };
        if let Value::Array(parts) = content {
            let normalized_parts = parts
                .iter()
                .map(normalize_openai_chat_message_content_part)
                .collect::<Vec<_>>();
            *content = Value::Array(normalized_parts);
        }
    }
    if let Some(tools) = normalized.get_mut("tools").and_then(Value::as_array_mut) {
        let normalized_tools = tools
            .iter()
            .map(normalize_openai_chat_provider_tool)
            .collect::<Vec<_>>();
        *tools = normalized_tools;
    }
    normalized
}

fn normalize_openai_chat_provider_tool(tool: &Value) -> Value {
    let Some(row) = tool.as_object() else {
        return tool.clone();
    };
    match row.get("type").and_then(Value::as_str) {
        Some("function") => normalize_openai_chat_function_tool(row),
        Some("custom") => normalize_openai_chat_custom_tool(row),
        _ => tool.clone(),
    }
}

fn normalize_openai_chat_function_tool(row: &Map<String, Value>) -> Value {
    if row.get("function").and_then(Value::as_object).is_some() {
        return Value::Object(row.clone());
    }
    let mut function = Map::new();
    for key in ["name", "description", "parameters", "strict"] {
        if let Some(value) = row.get(key) {
            function.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(Map::from_iter([
        ("type".to_string(), Value::String("function".to_string())),
        ("function".to_string(), Value::Object(function)),
    ]))
}

fn normalize_openai_chat_custom_tool(row: &Map<String, Value>) -> Value {
    let name = row
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("custom_tool");
    let original_description = row
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let format_text = row
        .get("format")
        .map(|format| serde_json::to_string(format).unwrap_or_else(|_| format.to_string()))
        .unwrap_or_else(|| "null".to_string());
    let description = format!(
        "{original_description}\n\nOriginal Responses custom tool format: {format_text}\nPass the raw tool input string as JSON function.arguments.input."
    );
    Value::Object(Map::from_iter([
        ("type".to_string(), Value::String("function".to_string())),
        (
            "function".to_string(),
            Value::Object(Map::from_iter([
                ("name".to_string(), Value::String(name.to_string())),
                ("description".to_string(), Value::String(description)),
                (
                    "parameters".to_string(),
                    json!({
                        "type": "object",
                        "properties": {
                            "input": {"type": "string"}
                        },
                        "required": ["input"]
                    }),
                ),
            ])),
        ),
    ]))
}

#[allow(dead_code)]
fn compact_tool_id(prefix: &str, raw: &str) -> String {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix("functions.")
        .unwrap_or(trimmed)
        .strip_prefix("call_")
        .unwrap_or_else(|| trimmed.strip_prefix("fc_").unwrap_or(trimmed));
    let safe: String = stripped
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .take(48)
        .collect();
    let mut id = if safe.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}{safe}")
    };
    if id.len() > 64 {
        let mut hasher = DefaultHasher::new();
        raw.hash(&mut hasher);
        let hash = format!("{:x}", hasher.finish());
        let keep = 64usize.saturating_sub(prefix.len() + 1 + hash.len());
        let body: String = safe.chars().take(keep).collect();
        id = format!("{prefix}{body}_{hash}");
    }
    id
}
