use super::*;

pub(super) fn responses_system_as_anthropic_system(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty_string(text),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| item.as_str())
                        .and_then(non_empty_string)
                })
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join("\n\n"))
        }
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .and_then(non_empty_string),
        _ => None,
    }
}

pub(super) fn append_responses_instruction_part(
    system_parts: &mut Vec<String>,
    value: Option<&Value>,
) {
    if let Some(system) = value.and_then(responses_system_as_anthropic_system) {
        system_parts.push(system);
    }
}

pub(super) fn responses_input_as_anthropic_messages(
    value: Option<&Value>,
    system_parts: &mut Vec<String>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    match value {
        Value::String(text) => Ok(vec![json!({
            "role":"user",
            "content":[{"type":"text","text":text}]
        })]),
        Value::Array(items) => responses_input_array_as_anthropic_messages(items, system_parts),
        Value::Object(_) => {
            let mut messages = Vec::new();
            responses_input_item_as_anthropic_messages(value, &mut messages, system_parts)?;
            Ok(messages)
        }
        _ => Err(V3AnthropicCodecError::MalformedField { field: "input" }),
    }
}

pub(super) fn chat_messages_as_anthropic_messages(
    value: &Value,
    system_parts: &mut Vec<String>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let messages = value
        .as_array()
        .ok_or(V3AnthropicCodecError::MessagesNotArray)?;
    let mut output = Vec::new();
    for message in messages {
        let object = message
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField { field: "message" })?;
        let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
        if role == "system" || role == "developer" {
            append_responses_instruction_part(system_parts, object.get("content"));
            continue;
        }
        if role == "tool" {
            output.push(json!({
                "role":"user",
                "content":[{
                    "type":"tool_result",
                    "tool_use_id": object.get("tool_call_id").cloned().unwrap_or(Value::Null),
                    "content": responses_tool_output_as_anthropic_content(object.get("content"))
                }]
            }));
            continue;
        }
        let mut content = responses_content_as_anthropic_content(object.get("content"))?;
        if let Some(tool_calls) = object.get("tool_calls").and_then(Value::as_array) {
            for tool_call in tool_calls {
                content.push(openai_chat_tool_call_as_anthropic_tool_use(tool_call)?);
            }
        }
        if content.is_empty() {
            continue;
        }
        output.push(json!({
            "role": role,
            "content": content
        }));
    }
    Ok(output)
}

pub(super) fn openai_chat_tool_call_as_anthropic_tool_use(
    value: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let object = value
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField { field: "tool_call" })?;
    let function = object.get("function").and_then(Value::as_object);
    let input = match function
        .and_then(|function| function.get("arguments"))
        .or_else(|| object.get("arguments"))
    {
        Some(Value::String(raw)) => {
            serde_json::from_str(raw).unwrap_or_else(|_| json!({"input": raw}))
        }
        Some(value) => value.to_owned(),
        None => json!({}),
    };
    Ok(json!({
        "type":"tool_use",
        "id": object.get("id").cloned().unwrap_or(Value::Null),
        "name": function
            .and_then(|function| function.get("name"))
            .or_else(|| object.get("name"))
            .cloned()
            .unwrap_or(Value::Null),
        "input": input
    }))
}

pub(super) fn responses_input_array_as_anthropic_messages(
    items: &[Value],
    system_parts: &mut Vec<String>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let mut messages = Vec::new();
    let mut index = 0usize;
    while index < items.len() {
        let item = &items[index];
        if responses_input_item_type(item) == Some("reasoning") {
            messages.push(json!({
                "role":"assistant",
                "content":[project_v3_responses_reasoning_item_as_anthropic_content(item)?]
            }));
            index += 1;
            continue;
        }
        if responses_input_item_type(item) == Some("web_search_call") {
            messages.push(json!({
                "role":"assistant",
                "content": responses_web_search_call_as_anthropic_server_tool_history(item, index)?
            }));
            index += 1;
            continue;
        }
        if is_responses_tool_call_item(item) {
            let mut tool_uses = Vec::new();
            let mut expected_ids = Vec::new();
            while index < items.len() {
                let current = &items[index];
                if responses_input_item_type(current) == Some("reasoning") {
                    tool_uses.push(project_v3_responses_reasoning_item_as_anthropic_content(
                        current,
                    )?);
                    index += 1;
                    continue;
                }
                if !is_responses_tool_call_item(current) {
                    break;
                }
                let object = current
                    .as_object()
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "input item",
                    })?;
                expected_ids.push(responses_tool_call_id_value(object));
                tool_uses.push(responses_tool_call_as_anthropic_tool_use(object)?);
                index += 1;
            }

            let mut assistant_interleaved_content = Vec::new();
            while index < items.len() {
                let current = &items[index];
                if responses_input_item_type(current) == Some("reasoning") {
                    assistant_interleaved_content.push(
                        project_v3_responses_reasoning_item_as_anthropic_content(current)?,
                    );
                    index += 1;
                    continue;
                }
                if responses_input_item_type(current) == Some("web_search_call") {
                    assistant_interleaved_content.extend(
                        responses_web_search_call_as_anthropic_server_tool_history(current, index)?,
                    );
                    index += 1;
                    continue;
                }
                if is_responses_tool_output_item(current) {
                    break;
                }
                let Some(object) = current.as_object() else {
                    break;
                };
                if object.get("type").and_then(Value::as_str) != Some("message") {
                    break;
                }
                let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
                if role == "system" || role == "developer" {
                    append_responses_instruction_part(system_parts, object.get("content"));
                    index += 1;
                    continue;
                }
                if role != "assistant" {
                    break;
                }
                assistant_interleaved_content.extend(responses_content_as_anthropic_content(
                    object.get("content"),
                )?);
                index += 1;
            }

            let mut tool_results = Vec::new();
            let mut result_ids = Vec::new();
            while index < items.len() {
                let current = &items[index];
                if !is_responses_tool_output_item(current) {
                    break;
                }
                let object = current
                    .as_object()
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "input item",
                    })?;
                let result_id = responses_tool_output_id_value(object);
                if !expected_ids.iter().any(|expected| expected == &result_id) {
                    return Err(V3AnthropicCodecError::MalformedField {
                        field: "function_call_output",
                    });
                }
                result_ids.push(result_id);
                tool_results.push(responses_tool_output_as_anthropic_tool_result(object));
                index += 1;
            }

            let all_results_present = expected_ids
                .iter()
                .all(|expected| result_ids.iter().any(|actual| actual == expected));
            if tool_results.is_empty() || !all_results_present {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "function_call_output",
                });
            }

            let mut assistant_content = tool_uses;
            assistant_content.extend(assistant_interleaved_content);
            messages.push(json!({
                "role":"assistant",
                "content": assistant_content
            }));
            messages.push(json!({
                "role":"user",
                "content": tool_results
            }));
            continue;
        }
        if is_responses_tool_output_item(item) {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "function_call_output",
            });
        }
        responses_input_item_as_anthropic_messages(item, &mut messages, system_parts)?;
        index += 1;
    }
    Ok(messages)
}

pub(super) fn responses_input_item_as_anthropic_messages(
    item: &Value,
    messages: &mut Vec<Value>,
    system_parts: &mut Vec<String>,
) -> Result<(), V3AnthropicCodecError> {
    let object = item
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "input item",
        })?;
    match object.get("type").and_then(Value::as_str) {
        Some("reasoning") => {
            messages.push(json!({
                "role":"assistant",
                "content":[project_v3_responses_reasoning_item_as_anthropic_content(item)?]
            }));
            Ok(())
        }
        Some("function_call") | Some("custom_tool_call") | Some("tool_call") => {
            messages.push(json!({
                "role":"assistant",
                "content":[responses_tool_call_as_anthropic_tool_use(object)?]
            }));
            Ok(())
        }
        Some("function_call_output")
        | Some("custom_tool_call_output")
        | Some("tool_call_output") => {
            messages.push(json!({
                "role":"user",
                "content":[responses_tool_output_as_anthropic_tool_result(object)]
            }));
            Ok(())
        }
        _ => {
            let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
            if role == "system" || role == "developer" {
                append_responses_instruction_part(system_parts, object.get("content"));
                return Ok(());
            }
            let content = responses_content_as_anthropic_content(object.get("content"))?;
            if content.is_empty() {
                return Ok(());
            }
            messages.push(json!({
                "role": role,
                "content": content
            }));
            Ok(())
        }
    }
}

pub(super) fn responses_input_item_type(item: &Value) -> Option<&str> {
    item.as_object()
        .and_then(|object| object.get("type"))
        .and_then(Value::as_str)
}

pub(super) fn is_responses_tool_call_item(item: &Value) -> bool {
    matches!(
        responses_input_item_type(item),
        Some("function_call" | "custom_tool_call" | "tool_call")
    )
}

pub(super) fn is_responses_tool_output_item(item: &Value) -> bool {
    matches!(
        responses_input_item_type(item),
        Some("function_call_output" | "custom_tool_call_output" | "tool_call_output")
    )
}

pub(super) fn responses_tool_call_id_value(object: &Map<String, Value>) -> Value {
    object
        .get("call_id")
        .or_else(|| object.get("id"))
        .cloned()
        .unwrap_or(Value::Null)
}

pub(super) fn responses_tool_output_id_value(object: &Map<String, Value>) -> Value {
    object
        .get("call_id")
        .or_else(|| object.get("tool_call_id"))
        .cloned()
        .unwrap_or(Value::Null)
}

pub(super) fn responses_tool_call_as_anthropic_tool_use(
    object: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    Ok(json!({
        "type":"tool_use",
        "id": responses_tool_call_id_value(object),
        "name": object.get("name").cloned().unwrap_or(Value::Null),
        "input": responses_function_call_input(object)?
    }))
}

pub(super) fn responses_tool_output_as_anthropic_tool_result(object: &Map<String, Value>) -> Value {
    json!({
        "type":"tool_result",
        "tool_use_id": responses_tool_output_id_value(object),
        "content": responses_tool_output_as_anthropic_content(object.get("output"))
    })
}

pub(crate) fn project_v3_responses_reasoning_item_as_anthropic_content(
    item: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let object = item
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning item",
        })?;
    let content_text =
        responses_reasoning_text_entries(object.get("content"), &["reasoning_text"])?;
    let summary_text = responses_reasoning_text_entries(object.get("summary"), &["summary_text"])?;
    if !content_text.is_empty() && !summary_text.is_empty() {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "reasoning item",
        });
    }
    let thinking = if !content_text.is_empty() {
        content_text.join("\n\n")
    } else {
        summary_text.join("\n\n")
    };
    let encrypted_content = match object.get("encrypted_content") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let value = value
                .as_str()
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "reasoning item",
                })?;
            if value.trim().is_empty() {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "reasoning item",
                });
            }
            Some(value)
        }
    };
    if !thinking.is_empty() {
        let mut block = json!({
            "type":"thinking",
            "thinking":thinking
        });
        if let Some(signature) = encrypted_content {
            block["signature"] = Value::String(signature.to_string());
        }
        return Ok(block);
    }
    if let Some(data) = encrypted_content {
        return Ok(json!({
            "type":"redacted_thinking",
            "data":data
        }));
    }
    Err(V3AnthropicCodecError::MalformedField {
        field: "reasoning item",
    })
}

pub(super) fn responses_reasoning_text_entries(
    value: Option<&Value>,
    accepted_types: &[&str],
) -> Result<Vec<String>, V3AnthropicCodecError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let entries = value
        .as_array()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning item",
        })?;
    let mut text = Vec::new();
    for entry in entries {
        let object = entry
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "reasoning item",
            })?;
        if !accepted_types
            .iter()
            .any(|accepted| object.get("type").and_then(Value::as_str) == Some(*accepted))
        {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "reasoning item",
            });
        }
        let value = object
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "reasoning item",
            })?;
        text.push(value.to_string());
    }
    Ok(text)
}

pub(super) fn responses_web_search_call_as_anthropic_server_tool_history(
    item: &Value,
    input_index: usize,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let object = item
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "web_search_call",
        })?;
    let action = object.get("action").and_then(Value::as_object).ok_or(
        V3AnthropicCodecError::MalformedField {
            field: "web_search_call.action",
        },
    )?;
    let action = validate_responses_web_search_action(action)?;
    let call_id = responses_web_search_call_history_id(object, input_index)?;
    let result_content = responses_web_search_call_result_content(object)?;
    Ok(vec![
        json!({
            "type":"server_tool_use",
            "id":call_id,
            "name":"web_search",
            "input":Value::Object(action)
        }),
        json!({
            "type":"web_search_tool_result",
            "tool_use_id":call_id,
            "content":result_content
        }),
    ])
}

pub(super) fn responses_web_search_call_history_id(
    object: &Map<String, Value>,
    input_index: usize,
) -> Result<String, V3AnthropicCodecError> {
    let mut values = Vec::new();
    for key in ["call_id", "tool_call_id", "id"] {
        if let Some(value) = object
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !values.iter().any(|seen| seen == value) {
                values.push(value.to_string());
            }
        }
    }
    match values.len() {
        0 => Ok(format!("call_routecodex_web_search_{input_index}")),
        1 => Ok(values.pop().expect("single web search identity")),
        _ => Err(V3AnthropicCodecError::MalformedField {
            field: "web_search_call.id",
        }),
    }
}

pub(super) fn validate_responses_web_search_action(
    action: &Map<String, Value>,
) -> Result<Map<String, Value>, V3AnthropicCodecError> {
    reject_side_channel_object_keys(action)?;
    let action_type = action
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "web_search_call.action.type",
        })?;
    match action_type {
        "search" => {
            let has_scalar_query = action
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .is_some_and(|value| !value.is_empty());
            let has_queries =
                action
                    .get("queries")
                    .and_then(Value::as_array)
                    .is_some_and(|queries| {
                        queries.iter().any(|query| {
                            query
                                .as_str()
                                .map(str::trim)
                                .is_some_and(|value| !value.is_empty())
                        })
                    });
            if !has_scalar_query && !has_queries {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "web_search_call.action.query",
                });
            }
        }
        "open_page" => {
            action
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "web_search_call.action.url",
                })?;
        }
        "find_in_page" => {
            action
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "web_search_call.action.url",
                })?;
            action
                .get("pattern")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "web_search_call.action.pattern",
                })?;
        }
        _ => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "web_search_call.action.type",
            });
        }
    }
    Ok(action.clone())
}

pub(super) fn responses_web_search_call_result_content(
    object: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    let status = object.get("status").and_then(Value::as_str).ok_or(
        V3AnthropicCodecError::MalformedField {
            field: "web_search_call.status",
        },
    )?;
    let has_error = object.get("error").is_some();
    match status {
        "completed" if has_error => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "web_search_call.result",
            })
        }
        "completed" | "failed" => {}
        _ => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "web_search_call.status",
            })
        }
    }

    let mut outcome = Map::new();
    for key in [
        "status",
        "action",
        "result",
        "result_items",
        "output",
        "error",
    ] {
        if let Some(field_payload) = object.get(key) {
            outcome.insert(key.to_string(), field_payload.clone());
        }
    }
    Ok(Value::Object(outcome))
}

pub(super) fn responses_content_as_anthropic_content(
    value: Option<&Value>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    match value {
        Value::Null => Ok(Vec::new()),
        Value::String(text) => Ok(vec![json!({"type":"text","text":text})]),
        Value::Array(parts) => parts
            .iter()
            .map(responses_content_part_as_anthropic_content_part)
            .collect(),
        Value::Object(_) => Ok(vec![responses_content_part_as_anthropic_content_part(
            value,
        )?]),
        _ => Err(V3AnthropicCodecError::MalformedField { field: "content" }),
    }
}

pub(super) fn responses_content_part_as_anthropic_content_part(
    part: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let object = part
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "content part",
        })?;
    match object.get("type").and_then(Value::as_str) {
        Some("input_text" | "output_text" | "text") => Ok(json!({
            "type":"text",
            "text": object.get("text").cloned().unwrap_or(Value::String(String::new()))
        })),
        Some("input_image" | "image" | "image_url") => {
            responses_image_part_as_anthropic_image(part)
        }
        Some("refusal") => Ok(json!({
            "type":"text",
            "text": object.get("refusal").or_else(|| object.get("text")).cloned().unwrap_or(Value::String(String::new()))
        })),
        _ => Err(V3AnthropicCodecError::MalformedField {
            field: "content part type",
        }),
    }
}

pub(super) fn responses_image_part_as_anthropic_image(
    part: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let image_url_value = part
        .get("image_url")
        .ok_or(V3AnthropicCodecError::MalformedField { field: "image_url" })?;
    let image_url = match image_url_value {
        Value::String(value) => value.as_str(),
        Value::Object(object) => object.get("url").and_then(Value::as_str).ok_or(
            V3AnthropicCodecError::MalformedField {
                field: "image_url.url",
            },
        )?,
        _ => {
            return Err(V3AnthropicCodecError::MalformedField { field: "image_url" });
        }
    };
    if image_url.is_empty() {
        return Err(V3AnthropicCodecError::MalformedField { field: "image_url" });
    }
    if let Some((media_type, data)) = image_url.strip_prefix("data:").and_then(|rest| {
        let (media_type, data) = rest.split_once(";base64,")?;
        Some((media_type, data))
    }) {
        return Ok(json!({
            "type":"image",
            "source":{"type":"base64","media_type":media_type,"data":data}
        }));
    }
    Ok(json!({
        "type":"image",
        "source":{"type":"url","url":image_url}
    }))
}

pub(super) fn responses_function_call_input(
    object: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    if object.get("type").and_then(Value::as_str) == Some("custom_tool_call") {
        return match object.get("input") {
            Some(Value::String(raw)) => Ok(json!({"input": raw})),
            Some(_) => Err(V3AnthropicCodecError::MalformedField {
                field: "custom_tool_call.input",
            }),
            None => Err(V3AnthropicCodecError::MalformedField {
                field: "custom_tool_call.input",
            }),
        };
    }
    match object.get("arguments").or_else(|| object.get("input")) {
        Some(Value::String(raw)) => {
            Ok(serde_json::from_str(raw).unwrap_or_else(|_| json!({"input": raw})))
        }
        Some(value) => Ok(value.to_owned()),
        None => Ok(json!({})),
    }
}

pub(super) fn responses_tool_output_as_anthropic_content(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(value) => Value::String(serde_json::to_string(value).unwrap_or_default()),
        None => Value::String(String::new()),
    }
}

pub(super) fn responses_tools_for_anthropic_wire(
    object: &Map<String, Value>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let mut output = Vec::new();
    let mut seen_names = HashSet::new();
    append_responses_tools_for_anthropic_wire(object.get("tools"), &mut output, &mut seen_names)?;
    for item in object
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            append_responses_tools_for_anthropic_wire(
                item.get("tools"),
                &mut output,
                &mut seen_names,
            )?;
        }
    }
    Ok(output)
}

pub(super) fn append_responses_tools_for_anthropic_wire(
    tools: Option<&Value>,
    output: &mut Vec<Value>,
    seen_names: &mut HashSet<String>,
) -> Result<(), V3AnthropicCodecError> {
    for tool in tools.and_then(Value::as_array).into_iter().flatten() {
        let tool_object = tool
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField { field: "tools[]" })?;
        let anthropic_tool = responses_tool_as_anthropic_tool(tool_object)?;
        let name = anthropic_tool
            .get("name")
            .and_then(Value::as_str)
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "tools[].name",
            })?
            .to_string();
        if seen_names.insert(name) {
            output.push(anthropic_tool);
        }
    }
    Ok(())
}

pub(super) fn responses_tool_as_anthropic_tool(
    tool: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    if tool.get("type").and_then(Value::as_str) == Some("custom") {
        return responses_custom_tool_as_anthropic_compatibility_tool(tool);
    }
    if matches!(
        tool.get("type").and_then(Value::as_str),
        Some("web_search" | "web_search_preview")
    ) {
        return responses_web_search_tool_as_anthropic_tool(tool);
    }
    // Anthropic hosted server-tool 实际类型为 `web_search_20250305`（或未来
    // `_20990101` 等变体）：type 以 `web_search_` 开头即按 hosted 投影。
    // Mode A 直通 minimax 必须保留 `type:"web_search_20250305"`，否则
    // provider 把 tool 视作普通 function tool，model 返回 `function_call`
    // 而非 hosted `server_tool_use`（实测 root cause：wire 缺 type）。
    if tool
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.starts_with("web_search_"))
    {
        return responses_web_search_tool_as_anthropic_tool(tool);
    }
    // Mode B 本地 websearch function（chat 入口 client 声明
    // `{"type":"function","function":{"name":"websearch"}}`，outbound 投影保留
    // 为本地 function tool）在 Anthropic wire 上必须以官方 server tool 名
    // `web_search` 编码——MiniMax 等 Anthropic provider 不识别 `websearch`，
    // 否则 provider 收不到搜索工具（表现为"我没有 websearch 工具"纯文本回答）。
    // Codex client 也可能声明 `name:"web_search"`（无 type），按 hosted
    // 投影兼容处理。
    if tool
        .get("name")
        .or_else(|| tool.get("function").and_then(|f| f.get("name")))
        .and_then(Value::as_str)
        .is_some_and(|name| {
            let normalized = name.trim();
            normalized.eq_ignore_ascii_case("websearch")
                || normalized.eq_ignore_ascii_case("web_search")
        })
    {
        return responses_web_search_tool_as_anthropic_tool(tool);
    }
    let mut output = Map::new();
    let name = tool
        .get("name")
        .or_else(|| {
            tool.get("function")
                .and_then(|function| function.get("name"))
        })
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            tool.get("type")
                .and_then(Value::as_str)
                .filter(|tool_type| matches!(*tool_type, "tool_search"))
                .map(str::to_string)
        })
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "tools[].name",
        })?;
    output.insert("name".to_string(), Value::String(name));
    if let Some(description) = tool.get("description").or_else(|| {
        tool.get("function")
            .and_then(|function| function.get("description"))
    }) {
        output.insert("description".to_string(), description.clone());
    }
    output.insert(
        "input_schema".to_string(),
        tool.get("parameters")
            .or_else(|| {
                tool.get("function")
                    .and_then(|function| function.get("parameters"))
            })
            .cloned()
            .unwrap_or_else(|| json!({"type":"object"})),
    );
    Ok(Value::Object(output))
}

fn responses_custom_tool_as_anthropic_compatibility_tool(
    tool: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    for key in tool.keys() {
        if !matches!(key.as_str(), "type" | "name" | "description" | "format") {
            return Err(V3AnthropicCodecError::UnmappedOutboundFields {
                paths: format!("$.request.tools[].{key}"),
            });
        }
    }
    let name = tool
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "tools[].name",
        })?;
    let source_description = match tool.get("description") {
        Some(Value::String(description)) => Some(description.as_str()),
        Some(_) => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "tools[].description",
            })
        }
        None => None,
    };
    let compatibility_note = match tool.get("format") {
        Some(Value::String(format)) if format == "custom" => format!(
            "RouteCodex compatibility v3.custom_tool.anthropic_string_input_wrapper.v1: Anthropic does not natively enforce the source free-form custom-tool format; provide the exact raw string in the input field."
        ),
        Some(Value::Object(format)) => {
            let format_type = format.get("type").and_then(Value::as_str).ok_or(
                V3AnthropicCodecError::MalformedField {
                    field: "tools[].format.type",
                },
            )?;
            match format_type {
                "text" if format.len() == 1 => format!(
                    "RouteCodex compatibility v3.custom_tool.anthropic_string_input_wrapper.v1: Anthropic does not natively enforce the source free-form custom-tool format; provide the exact raw string in the input field."
                ),
                "grammar" if format.len() == 3 => {
                    let syntax = format
                        .get("syntax")
                        .and_then(Value::as_str)
                        .ok_or(V3AnthropicCodecError::MalformedField {
                            field: "tools[].format.syntax",
                        })?;
                    let definition = format
                        .get("definition")
                        .and_then(Value::as_str)
                        .ok_or(V3AnthropicCodecError::MalformedField {
                            field: "tools[].format.definition",
                        })?;
                    format!(
                        "RouteCodex compatibility v3.custom_tool.anthropic_string_input_wrapper.v1: source grammar syntax={} definition={}; Anthropic does not natively enforce this grammar; provide the exact raw string in the input field.",
                        serde_json::to_string(syntax).map_err(|_| V3AnthropicCodecError::MalformedField { field: "tools[].format.syntax" })?,
                        serde_json::to_string(definition).map_err(|_| V3AnthropicCodecError::MalformedField { field: "tools[].format.definition" })?
                    )
                }
                _ => {
                    return Err(V3AnthropicCodecError::UnmappedOutboundFields {
                        paths: "$.request.tools[].format".to_string(),
                    })
                }
            }
        }
        _ => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "tools[].format",
            })
        }
    };
    let description = source_description
        .map(|source| format!("{source}\n\n{compatibility_note}"))
        .unwrap_or_else(|| compatibility_note.clone());
    Ok(json!({
        "name":name,
        "description":description,
        "input_schema":{
            "type":"object",
            "properties":{
                "input":{
                    "type":"string",
                    "description":compatibility_note
                }
            },
            "required":["input"],
            "additionalProperties":false
        }
    }))
}

pub(crate) fn responses_web_search_tool_as_anthropic_tool(
    tool: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    let mut output = Map::from_iter([
        (
            "type".to_string(),
            Value::String("web_search_20250305".to_string()),
        ),
        ("name".to_string(), Value::String("web_search".to_string())),
    ]);
    for key in ["blocked_domains", "cache_control", "max_uses", "strict"] {
        if let Some(value) = tool.get(key) {
            output.insert(key.to_string(), value.to_owned());
        }
    }
    let allowed_domains = tool.get("allowed_domains").or_else(|| {
        tool.get("filters")
            .and_then(Value::as_object)
            .and_then(|filters| filters.get("allowed_domains"))
    });
    if let Some(allowed_domains) = allowed_domains {
        output.insert("allowed_domains".to_string(), allowed_domains.to_owned());
    }
    if let Some(user_location) = tool.get("user_location") {
        output.insert("user_location".to_string(), user_location.to_owned());
    }
    if output.contains_key("allowed_domains") && output.contains_key("blocked_domains") {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "tools[].web_search.allowed_domains",
        });
    }
    Ok(Value::Object(output))
}

pub(super) fn responses_tool_choice_as_anthropic_tool_choice(
    value: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    // responses tool_choice type -> hub -> anthropic type（查表；未命中与原 match 一致报错/透传）
    let responses_to_anthropic_type = |responses_type: &str| -> Option<&'static str> {
        let hub = crate::protocol_tables::map_value(
            crate::protocol_tables::V3TableKind::ToolChoice,
            "responses",
            responses_type,
            crate::protocol_tables::V3TableDirection::Inbound,
        )
        .ok()
        .flatten()?;
        crate::protocol_tables::map_value(
            crate::protocol_tables::V3TableKind::ToolChoice,
            "anthropic",
            hub,
            crate::protocol_tables::V3TableDirection::Outbound,
        )
        .ok()
        .flatten()
    };
    if let Some(choice) = value.as_str() {
        return match responses_to_anthropic_type(choice) {
            Some(anthropic_type) => Ok(json!({"type": anthropic_type})),
            None => Err(V3AnthropicCodecError::MalformedField {
                field: "tool_choice",
            }),
        };
    }
    let Some(object) = value.as_object() else {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "tool_choice",
        });
    };
    let mut projected = match object.get("type").and_then(Value::as_str) {
        Some("function") | Some("tool") | Some("custom") => object
            .get("name")
            .or_else(|| {
                object
                    .get("function")
                    .and_then(|function| function.get("name"))
            })
            .cloned()
            .map(|name| {
                json!({"type": responses_to_anthropic_type("tool").unwrap_or("tool"), "name": name})
            })
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "tool_choice.name",
            })?,
        Some("auto") | Some("any") | Some("none") => json!({
            "type": object.get("type").cloned().unwrap_or(Value::Null)
        }),
        Some("required") => json!({"type": responses_to_anthropic_type("required").unwrap_or("any")}),
        _ => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "tool_choice",
            })
        }
    };
    if let Some(disable_parallel) = object.get("disable_parallel_tool_use") {
        projected
            .as_object_mut()
            .ok_or(V3AnthropicCodecError::PayloadNotObject)?
            .insert(
                "disable_parallel_tool_use".to_string(),
                disable_parallel.clone(),
            );
    }
    Ok(projected)
}

pub(super) fn anthropic_usage_as_responses_usage(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    let input = object
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = object
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mut usage = Map::new();
    usage.insert("input_tokens".to_string(), json!(input));
    usage.insert("output_tokens".to_string(), json!(output));
    usage.insert("total_tokens".to_string(), json!(input + output));
    if let Some(cache_creation) = object.get("cache_creation_input_tokens") {
        usage.insert(
            "cache_creation_input_tokens".to_string(),
            cache_creation.clone(),
        );
    }
    if let Some(cache_read) = object.get("cache_read_input_tokens") {
        usage.insert("cache_read_input_tokens".to_string(), cache_read.clone());
    }
    Some(Value::Object(usage))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_chat_tool_call_malformed_arguments_project_reversible_anthropic_input() {
        let tool_use = openai_chat_tool_call_as_anthropic_tool_use(&json!({
            "id": "call_malformed_chat",
            "type": "function",
            "function": {
                "name": "exec_command",
                "arguments": "{\"cmd\":\"one\"}{\"cmd\":\"two\"}"
            }
        }))
        .expect("malformed historical Chat arguments project to legal Anthropic input");
        assert_eq!(
            tool_use["input"],
            json!({"input":"{\"cmd\":\"one\"}{\"cmd\":\"two\"}"})
        );
    }

    #[test]
    fn responses_function_call_malformed_arguments_project_reversible_anthropic_input() {
        let mut object = Map::new();
        object.insert("type".to_string(), json!("function_call"));
        object.insert(
            "arguments".to_string(),
            json!("{\"cmd\":\"one\"}{\"cmd\":\"two\"}"),
        );
        let input = responses_function_call_input(&object)
            .expect("malformed historical Responses arguments project to legal Anthropic input");
        assert_eq!(input, json!({"input":"{\"cmd\":\"one\"}{\"cmd\":\"two\"}"}));
    }
}

#[test]
fn websearch_function_tool_maps_to_anthropic_hosted_web_search_server_tool() {
    // chat 入口 client 声明 `{"type":"function","function":{"name":"websearch"}}`，
    // Anthropic wire 必须以官方 hosted server tool（web_search_20250305）编码，
    // 否则 MiniMax 等 provider 收不到搜索工具。
    let tool = json!({
        "type": "function",
        "function": {
            "name": "websearch",
            "description": "Search the web",
            "parameters": {"type":"object","properties":{"query":{"type":"string"}}}
        }
    });
    let anthropic =
        responses_tool_as_anthropic_tool(tool.as_object().unwrap()).expect("map must succeed");
    assert_eq!(anthropic["type"], "web_search_20250305");
    assert_eq!(anthropic["name"], "web_search");
    // 大小写不敏感：WebSearch / WEBSEARCH 同样映射。
    let upper = json!({"type":"function","function":{"name":"WEBSEARCH"}});
    let mapped =
        responses_tool_as_anthropic_tool(upper.as_object().unwrap()).expect("map must succeed");
    assert_eq!(mapped["name"], "web_search");
    // web_search 名（hosted 语义）保持官方 server tool。
    let hosted = json!({"type":"web_search"});
    let mapped =
        responses_tool_as_anthropic_tool(hosted.as_object().unwrap()).expect("map must succeed");
    assert_eq!(mapped["name"], "web_search");
    assert_eq!(mapped["type"], "web_search_20250305");
}
