use super::namespace_tool_names::anthropic_tool_call_wire_name;
use super::*;

#[cfg(test)]
use super::responses_tool_projection::{
    responses_tool_as_anthropic_tool, responses_tools_for_anthropic_wire,
};

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
    chat_messages_as_anthropic_messages_with_hosted(value, system_parts, &[])
}

pub(super) fn chat_messages_as_anthropic_messages_with_hosted(
    value: &Value,
    system_parts: &mut Vec<String>,
    hosted_emissions: &[crate::operation_runner::HostedHistoryEmission],
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let messages = value
        .as_array()
        .ok_or(V3AnthropicCodecError::MessagesNotArray)?;
    let mut hosted_by_message = std::collections::BTreeMap::new();
    for emission in hosted_emissions {
        hosted_by_message
            .entry(emission.canonical_message_index)
            .or_insert_with(Vec::new)
            .push(emission);
    }
    let mut output = Vec::new();
    for (message_index, message) in messages.iter().enumerate() {
        let object = message
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField { field: "message" })?;
        let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
        if let Some(item_type) = object.get("type").and_then(Value::as_str) {
            if let Some(message) = chat_tool_search_history_as_anthropic_message(item_type, object)
            {
                output.push(message);
                continue;
            }
        }
        if role == "system" || role == "developer" {
            append_responses_instruction_part(system_parts, object.get("content"));
            continue;
        }
        if role == "tool" {
            let is_error = responses_tool_result_is_error(chat_tool_result_status(object)?)?;
            let mut tool_result = Map::new();
            tool_result.insert("type".to_string(), Value::String("tool_result".to_string()));
            tool_result.insert(
                "tool_use_id".to_string(),
                object.get("tool_call_id").cloned().unwrap_or(Value::Null),
            );
            tool_result.insert(
                "content".to_string(),
                responses_tool_output_as_anthropic_content(object.get("content")),
            );
            if is_error {
                tool_result.insert("is_error".to_string(), Value::Bool(true));
            }
            output.push(json!({
                "role":"user",
                "content":[Value::Object(tool_result)]
            }));
            continue;
        }
        let mut content = Vec::new();
        if let Some(reasoning_content) = object.get("reasoning_content") {
            if let Some(reasoning_content) = reasoning_content.as_str() {
                if !reasoning_content.is_empty() {
                    content.push(json!({
                        "type":"thinking",
                        "thinking":reasoning_content
                    }));
                }
            } else if !reasoning_content.is_null() {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "reasoning_content",
                });
            }
        }
        content.extend(responses_content_as_anthropic_content(
            object.get("content"),
        )?);
        if let Some(tool_calls) = object.get("tool_calls").and_then(Value::as_array) {
            for tool_call in tool_calls {
                content.push(openai_chat_tool_call_as_anthropic_tool_use(tool_call)?);
            }
        }
        if let Some(emissions) = hosted_by_message.get(&message_index) {
            let absorbed_by_ordinary_tool_use = role == "assistant"
                && output
                    .last()
                    .and_then(Value::as_object)
                    .is_some_and(|last| {
                        last.get("role").and_then(Value::as_str) == Some("assistant")
                            && last
                                .get("content")
                                .and_then(Value::as_array)
                                .is_some_and(|blocks| {
                                    blocks.iter().any(|block| {
                                        block.get("type").and_then(Value::as_str)
                                            == Some("tool_use")
                                    })
                                })
                    });
            if absorbed_by_ordinary_tool_use {
                if let Some(last) = output.last_mut().and_then(Value::as_object_mut) {
                    if let Some(blocks) = last.get_mut("content").and_then(Value::as_array_mut) {
                        for emission in emissions {
                            blocks.extend(emission.anthropic_blocks.iter().cloned());
                        }
                    }
                }
                continue;
            }
            for emission in emissions {
                content.extend(emission.anthropic_blocks.iter().cloned());
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

/// Responses hosted `tool_search` history stays in the canonical Chat as its raw
/// item shape. Anthropic has no hosted tool-search block, so the call and its
/// discovered-tool output project onto the adjacent ordinary tool blocks.
fn chat_tool_search_history_as_anthropic_message(
    item_type: &str,
    object: &Map<String, Value>,
) -> Option<Value> {
    let call_id = object.get("call_id").cloned().unwrap_or(Value::Null);
    match item_type {
        "tool_search_call" => Some(json!({
            "role":"assistant",
            "content":[{
                "type":"tool_use",
                "id":call_id,
                "name":anthropic_tool_call_wire_name("tool_search", false),
                "input":match object.get("arguments") {
                    Some(Value::String(raw)) => serde_json::from_str(raw).unwrap_or(Value::Null),
                    Some(value) => value.clone(),
                    None => json!({}),
                }
            }]
        })),
        "tool_search_output" => {
            let mut block = json!({
                "type":"tool_result",
                "tool_use_id":call_id,
                "content":object
                    .get("tools")
                    .map(|tools| serde_json::to_string(tools).unwrap_or_default())
                    .unwrap_or_default()
            });
            if object.get("status").and_then(Value::as_str) == Some("incomplete") {
                block["is_error"] = Value::Bool(true);
            }
            Some(json!({"role":"user","content":[block]}))
        }
        _ => None,
    }
}

pub(super) fn openai_chat_tool_call_as_anthropic_tool_use(
    value: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let object = value
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField { field: "tool_call" })?;
    let custom = if object.get("type").and_then(Value::as_str) == Some("custom") {
        object.get("custom").and_then(Value::as_object)
    } else {
        None
    };
    let function = object.get("function").and_then(Value::as_object);
    let input = if let Some(custom) = custom {
        match custom.get("input") {
            Some(Value::String(raw)) => json!({"input": raw}),
            _ => {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "custom_tool_call.input",
                });
            }
        }
    } else {
        match function
            .and_then(|function| function.get("arguments"))
            .or_else(|| object.get("arguments"))
        {
            Some(Value::String(raw)) => {
                serde_json::from_str(raw).unwrap_or_else(|_| json!({"input": raw}))
            }
            Some(value) => value.to_owned(),
            None => json!({}),
        }
    };
    let is_custom = custom.is_some()
        || value
            .pointer("/routecodex_chat_extension/responses_tool_call_type")
            .and_then(Value::as_str)
            == Some("custom_tool_call");
    let name = custom
        .and_then(|custom| custom.get("name"))
        .or_else(|| function.and_then(|function| function.get("name")))
        .or_else(|| object.get("name"))
        .and_then(Value::as_str)
        .map(|name| anthropic_tool_call_wire_name(name, is_custom))
        .map(Value::String)
        .unwrap_or(Value::Null);
    Ok(json!({
        "type":"tool_use",
        "id": object.get("id").cloned().unwrap_or(Value::Null),
        "name": name,
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
                tool_results.push(responses_tool_output_as_anthropic_tool_result(object)?);
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
                "content":[responses_tool_output_as_anthropic_tool_result(object)?]
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
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(|name| {
            anthropic_tool_call_wire_name(
                name,
                object.get("type").and_then(Value::as_str) == Some("custom_tool_call"),
            )
        })
        .map(Value::String)
        .unwrap_or(Value::Null);
    Ok(json!({
        "type":"tool_use",
        "id": responses_tool_call_id_value(object),
        "name": name,
        "input": responses_function_call_input(object)?
    }))
}

pub(super) fn responses_tool_output_as_anthropic_tool_result(
    object: &Map<String, Value>,
) -> Result<Value, V3AnthropicCodecError> {
    let is_error = responses_tool_result_is_error(object.get("status"))?;
    let mut result = Map::new();
    result.insert("type".to_string(), Value::String("tool_result".to_string()));
    result.insert(
        "tool_use_id".to_string(),
        responses_tool_output_id_value(object),
    );
    result.insert(
        "content".to_string(),
        responses_tool_output_as_anthropic_content(object.get("output")),
    );
    if is_error {
        result.insert("is_error".to_string(), Value::Bool(true));
    }
    Ok(Value::Object(result))
}

fn chat_tool_result_status<'a>(
    object: &'a Map<String, Value>,
) -> Result<Option<&'a Value>, V3AnthropicCodecError> {
    match object.get("routecodex_chat_extension") {
        None => Ok(None),
        Some(Value::Object(extension)) => Ok(extension.get("responses_tool_output_status")),
        Some(_) => Err(V3AnthropicCodecError::MalformedField {
            field: "routecodex_chat_extension",
        }),
    }
}

fn responses_tool_result_is_error(status: Option<&Value>) -> Result<bool, V3AnthropicCodecError> {
    Ok(match status {
        None => false,
        Some(Value::String(status)) if status == "completed" => false,
        Some(Value::String(status)) if status == "incomplete" => true,
        Some(_) => {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "function_call_output.status",
            })
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_namespace_tools_expand_to_qualified_children() {
        let object = json!({
            "tools": [{
                "type": "namespace",
                "name": "mcp__mcpx",
                "tools": [{
                    "type": "function",
                    "name": "workspace",
                    "parameters": {"type": "object"}
                }]
            }]
        });
        let tools = responses_tools_for_anthropic_wire(object.as_object().unwrap()).unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "mcp__mcpx__workspace");
        assert_ne!(tools[0]["name"], "mcp__mcpx");
    }

    #[test]
    fn anthropic_empty_namespace_is_omitted_from_provider_tools() {
        let tools = responses_tools_for_anthropic_wire(
            json!({"tools": [{"type": "namespace", "name": "mcp__mcpx", "tools": []}]} )
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert!(tools.is_empty());
    }

    #[test]
    fn anthropic_namespace_custom_child_is_projected_without_tools_shape_failure() {
        let object = json!({
            "tools": [{
                "type": "namespace",
                "name": "functions",
                "tools": [{
                    "type": "namespace",
                    "name": "mcp__mcpx",
                    "tools": [{
                        "type": "function",
                        "name": "workspace",
                        "parameters": {"type": "object"}
                    }]
                }]
            }]
        });
        let tools = responses_tools_for_anthropic_wire(object.as_object().unwrap())
            .expect("custom namespace child must have a legal Anthropic projection");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "mcp__mcpx__workspace");
    }

    #[test]
    fn anthropic_namespace_custom_history_uses_the_declared_provider_name() {
        let request = encode_v3_responses_semantic_as_anthropic_request(json!({
            "model": "glm-5.3",
            "messages": [
                {"role": "assistant", "tool_calls": [{"id": "call_exec", "type": "function", "function": {"name": "functions.exec", "arguments": "{\"input\":\"pwd\"}"}}]},
                {"role": "tool", "tool_call_id": "call_exec", "content": "/tmp"}
            ],
            "tools": [{"type": "namespace", "name": "functions", "tools": [
                {"type": "custom", "name": "exec", "format": {"type": "text"}}
            ]}]
        }))
        .expect("declared custom history must project to Anthropic");
        assert_eq!(request["tools"][0]["name"], "functions__exec");
        assert_eq!(
            request["messages"][0]["content"][0]["name"],
            "functions__exec"
        );
        assert_eq!(
            request["messages"][1]["content"][0]["tool_use_id"],
            "call_exec"
        );
    }

    #[test]
    fn anthropic_nested_namespace_custom_history_matches_its_declaration() {
        let request = encode_v3_responses_semantic_as_anthropic_request(json!({
            "model":"glm-5.3",
            "messages":[{"role":"assistant","tool_calls":[{"id":"call_nested","function":{"name":"functions.mcp__mcpx.exec","arguments":"{\"input\":\"pwd\"}"}}]}],
            "tools":[{"type":"namespace","name":"functions","tools":[{"type":"namespace","name":"mcp__mcpx","tools":[{"type":"custom","name":"exec","format":{"type":"text"}}]}]}]
        })).expect("nested custom history must project");
        assert_eq!(request["tools"][0]["name"], "mcp__mcpx__exec");
        assert_eq!(
            request["messages"][0]["content"][0]["name"],
            "mcp__mcpx__exec"
        );
    }

    #[test]
    fn anthropic_namespace_custom_choice_uses_declared_provider_name() {
        let request = encode_v3_responses_semantic_as_anthropic_request(json!({
            "model":"glm-5.3", "input":"run pwd",
            "tool_choice":{"type":"custom","name":"functions.exec"},
            "tools":[{"type":"namespace","name":"functions","tools":[
                {"type":"custom","name":"exec","format":{"type":"text"}}
            ]}]
        }))
        .expect("namespace custom choice must project to Anthropic");
        assert_eq!(request["tools"][0]["name"], "functions__exec");
        assert_eq!(request["tool_choice"]["name"], "functions__exec");
    }

    #[test]
    fn anthropic_namespace_tool_call_history_uses_declared_provider_name() {
        let request = encode_v3_responses_semantic_as_anthropic_request(json!({
            "model":"glm-5.3",
            "input":[
                {"type":"tool_call","call_id":"call_exec","name":"functions.exec","arguments":"{\"input\":\"pwd\"}"},
                {"type":"tool_call_output","call_id":"call_exec","output":"/tmp"}
            ],
            "tools":[{"type":"namespace","name":"functions","tools":[
                {"type":"custom","name":"exec","format":{"type":"text"}}
            ]}]
        })).expect("tool_call history must project to Anthropic");
        assert_eq!(
            request["messages"][0]["content"][0]["name"],
            "functions__exec"
        );
    }

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
    fn anthropic_tool_use_normalizes_legacy_mcp_function_name() {
        let mut system_parts = Vec::new();
        let messages = chat_messages_as_anthropic_messages(
            &json!([{
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_review",
                    "type": "function",
                    "function": {
                        "name": "functions.mcp__codex_review__review_start",
                        "arguments": "{}"
                    }
                }]
            }]),
            &mut system_parts,
        )
        .expect("Anthropic messages must use the provider-safe MCP name");
        assert_eq!(
            messages[0]["content"][0]["name"],
            "mcp__codex_review__review_start"
        );
    }

    #[test]
    fn anthropic_tool_declaration_normalizes_legacy_mcp_function_name() {
        let tools = responses_tools_for_anthropic_wire(
            json!({
                    "tools": [{
                        "type": "function",
                        "function": {
                            "name": "functions.mcp__codex_review__review_start",
                            "parameters": {"type": "object"}
                        }
                    }]
                }
            )
            .as_object()
            .unwrap(),
        )
        .expect("Anthropic tools must use the provider-safe MCP name");
        assert_eq!(tools[0]["name"], "mcp__codex_review__review_start");
    }

    #[test]
    fn responses_tool_history_normalizes_legacy_mcp_function_name() {
        let mut messages = Vec::new();
        responses_input_item_as_anthropic_messages(
            &json!({
                "type": "function_call",
                "call_id": "call_review",
                "name": "functions.mcp__codex_review__review_start",
                "arguments": "{}"
            }),
            &mut messages,
            &mut Vec::new(),
        )
        .expect("Responses tool history must use the provider-safe MCP name");
        assert_eq!(
            messages[0]["content"][0]["name"],
            "mcp__codex_review__review_start"
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
