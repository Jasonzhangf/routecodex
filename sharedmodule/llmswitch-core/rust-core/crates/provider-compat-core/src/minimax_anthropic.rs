use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub(crate) fn apply_request_compat(payload: Value) -> Result<Value, String> {
    let mut payload = payload;
    let root = payload
        .as_object_mut()
        .ok_or_else(|| "MiniMax Anthropic request payload must be an object".to_string())?;
    project_web_search_tools(root)?;
    project_web_search_history(root)?;
    Ok(payload)
}

pub(crate) fn apply_response_compat(payload: Value) -> Value {
    strip_minimax_provider_sentinel_recursive(payload)
}

fn strip_minimax_provider_sentinel_recursive(value: Value) -> Value {
    match value {
        Value::String(text) => match strip_minimax_provider_sentinel_text(&text) {
            Some(stripped) => Value::String(stripped),
            None => Value::String(text),
        },
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(strip_minimax_provider_sentinel_recursive)
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, strip_minimax_provider_sentinel_recursive(value)))
                .collect(),
        ),
        other => other,
    }
}

fn strip_minimax_provider_sentinel_text(text: &str) -> Option<String> {
    if !text.contains("]<]minimax[>[") {
        return None;
    }
    let mut next = text.replace("]<]minimax[>[", "");
    for marker in ["<think\n", "<think\r\n", "<think"] {
        if next.starts_with(marker) {
            next = next[marker.len()..].to_string();
            break;
        }
    }
    let trimmed_start = next.trim_start_matches(['\r', '\n', ' ', '\t']);
    if let Some(rest) = trimmed_start.strip_prefix("<continue") {
        next = rest.to_string();
    }
    Some(next)
}

fn project_web_search_tools(root: &mut Map<String, Value>) -> Result<(), String> {
    let tools = match root.get_mut("tools") {
        None => return Ok(()),
        Some(Value::Array(tools)) => tools,
        Some(_) => return Err("MiniMax Anthropic tools must be an array".to_string()),
    };
    for tool in tools {
        let object = tool
            .as_object_mut()
            .ok_or_else(|| "MiniMax Anthropic tools[] must be objects".to_string())?;
        let Some(tool_type) = object.get("type").and_then(Value::as_str) else {
            continue;
        };
        if !tool_type.starts_with("web_search_") {
            continue;
        }
        if tool_type != "web_search_20250305" {
            return Err(format!(
                "MiniMax Anthropic hosted web-search tool type {tool_type} is unsupported"
            ));
        }
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "MiniMax Anthropic hosted web-search tool name is required".to_string()
            })?;
        if name != "web_search" {
            return Err(format!(
                "MiniMax Anthropic hosted web-search tool name {name} is unsupported"
            ));
        }
        let unsupported_fields: Vec<String> = object
            .keys()
            .filter(|key| key.as_str() != "type" && key.as_str() != "name")
            .cloned()
            .collect();
        if !unsupported_fields.is_empty() {
            return Err(format!(
                "MiniMax Anthropic hosted web-search tool has unrepresentable fields: {}",
                unsupported_fields.join(",")
            ));
        }
        let mut projected = Map::new();
        projected.insert("name".to_string(), Value::String("web_search".to_string()));
        projected.insert(
            "description".to_string(),
            Value::String("Search the web for current information.".to_string()),
        );
        projected.insert(
            "input_schema".to_string(),
            json!({
                "type":"object",
                "properties":{
                    "type":{"type":"string"},
                    "query":{"type":"string"}
                },
                "required":["query"],
                "additionalProperties":true
            }),
        );
        *object = projected;
    }
    Ok(())
}

fn project_web_search_history(root: &mut Map<String, Value>) -> Result<(), String> {
    let messages = match root.get("messages") {
        None => return Ok(()),
        Some(Value::Array(messages)) => messages,
        Some(_) => return Err("MiniMax Anthropic messages must be an array".to_string()),
    };
    let mut projected = Vec::with_capacity(messages.len());
    let mut seen_tool_call_ids: HashSet<String> = HashSet::new();
    let mut index = 0usize;
    while index < messages.len() {
        let message = messages[index]
            .as_object()
            .ok_or_else(|| "MiniMax Anthropic messages[] must be objects".to_string())?;
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            projected.push(Value::Object(message.clone()));
            index += 1;
            continue;
        }
        let Some(content) = message.get("content").and_then(Value::as_array) else {
            projected.push(Value::Object(message.clone()));
            index += 1;
            continue;
        };
        let mut assistant_content = Vec::with_capacity(content.len());
        let mut server_call_ids = Vec::new();
        let mut tool_results = Vec::new();
        for part in content {
            let part_object = part.as_object().ok_or_else(|| {
                "MiniMax Anthropic assistant content blocks must be objects".to_string()
            })?;
            match part_object.get("type").and_then(Value::as_str) {
                Some("tool_use") => {
                    let call_id = required_non_empty_str(
                        part_object,
                        "id",
                        "MiniMax Anthropic ordinary tool_use id is required",
                    )?;
                    if !seen_tool_call_ids.insert(call_id.to_string()) {
                        return Err(format!(
                            "MiniMax Anthropic tool call id {call_id} is duplicated"
                        ));
                    }
                    assistant_content.push(part.clone());
                }
                Some("server_tool_use")
                    if part_object.get("name").and_then(Value::as_str) == Some("web_search") =>
                {
                    let call_id = required_non_empty_str(
                        part_object,
                        "id",
                        "MiniMax Anthropic hosted web-search call id is required",
                    )?;
                    if !seen_tool_call_ids.insert(call_id.to_string()) {
                        return Err(format!(
                            "MiniMax Anthropic hosted web-search call id {call_id} is duplicated"
                        ));
                    }
                    let input = part_object
                        .get("input")
                        .and_then(Value::as_object)
                        .ok_or_else(|| {
                            "MiniMax Anthropic hosted web-search call input object is required"
                                .to_string()
                        })?;
                    let query = input
                        .get("query")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            "MiniMax Anthropic hosted web-search call input query is required"
                                .to_string()
                        })?;
                    server_call_ids.push(call_id.to_string());
                    assistant_content.push(json!({
                        "type":"tool_use",
                        "id":call_id,
                        "name":"web_search",
                        "input":{"query":query}
                    }));
                }
                Some("web_search_tool_result") => {
                    let call_id = required_non_empty_str(
                        part_object,
                        "tool_use_id",
                        "MiniMax Anthropic hosted web-search result tool_use_id is required",
                    )?;
                    if !server_call_ids.iter().any(|expected| expected == call_id) {
                        return Err(format!(
                            "MiniMax Anthropic hosted web-search result id {call_id} has no matching server call"
                        ));
                    }
                    if tool_results.iter().any(|result: &Value| {
                        result.get("tool_use_id").and_then(Value::as_str) == Some(call_id)
                    }) {
                        return Err(format!(
                            "MiniMax Anthropic hosted web-search result id {call_id} is duplicated"
                        ));
                    }
                    let projected_result =
                        project_hosted_web_search_result_content(part_object.get("content"))?;
                    let mut tool_result = Map::new();
                    tool_result
                        .insert("type".to_string(), Value::String("tool_result".to_string()));
                    tool_result.insert(
                        "tool_use_id".to_string(),
                        Value::String(call_id.to_string()),
                    );
                    tool_result.insert("content".to_string(), projected_result.content);
                    if projected_result.is_error {
                        tool_result.insert("is_error".to_string(), Value::Bool(true));
                    }
                    tool_results.push(Value::Object(tool_result));
                }
                _ => assistant_content.push(part.clone()),
            }
        }
        if server_call_ids.is_empty() && tool_results.is_empty() {
            projected.push(Value::Object(message.clone()));
            index += 1;
            continue;
        }
        let all_calls_have_results = server_call_ids.iter().all(|call_id| {
            tool_results.iter().any(|result| {
                result.get("tool_use_id").and_then(Value::as_str) == Some(call_id.as_str())
            })
        });
        if !all_calls_have_results || server_call_ids.len() != tool_results.len() {
            return Err(
                "MiniMax Anthropic hosted web-search calls and results must match exactly"
                    .to_string(),
            );
        }
        let mut assistant = message.clone();
        assistant.insert("content".to_string(), Value::Array(assistant_content));
        projected.push(Value::Object(assistant));
        if let Some(next_user) = messages
            .get(index + 1)
            .and_then(Value::as_object)
            .filter(|next| next.get("role").and_then(Value::as_str) == Some("user"))
        {
            let mut merged_user = next_user.clone();
            let mut merged_content = tool_results;
            merged_content.extend(anthropic_message_content_as_blocks(
                next_user.get("content"),
            )?);
            merged_user.insert("content".to_string(), Value::Array(merged_content));
            projected.push(Value::Object(merged_user));
            index += 2;
        } else {
            projected.push(json!({"role":"user","content":tool_results}));
            index += 1;
        }
    }
    root.insert("messages".to_string(), Value::Array(projected));
    Ok(())
}

fn required_non_empty_str<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    error: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error.to_string())
}

struct ProjectedHostedResult {
    content: Value,
    is_error: bool,
}

fn project_hosted_web_search_result_content(
    content: Option<&Value>,
) -> Result<ProjectedHostedResult, String> {
    let content = content.ok_or_else(|| {
        "MiniMax Anthropic hosted web-search result content is required".to_string()
    })?;
    let is_error = hosted_web_search_result_is_error(content)?;
    let content = match content {
        Value::Array(items) if items.is_empty() => Value::Array(Vec::new()),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(hosted_web_search_result_item_as_text_block)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Value::String(text) => Value::String(text.clone()),
        Value::Object(_) => {
            Value::Array(vec![hosted_web_search_result_item_as_text_block(content)?])
        }
        _ => return Err(
            "MiniMax Anthropic hosted web-search result content must be string, object, or array"
                .to_string(),
        ),
    };
    Ok(ProjectedHostedResult { content, is_error })
}

fn hosted_web_search_result_is_error(content: &Value) -> Result<bool, String> {
    let Some(object) = content.as_object() else {
        return Ok(false);
    };
    let has_error = object.get("error").is_some();
    match object.get("status").and_then(Value::as_str) {
        Some("failed") => {
            if !has_error {
                return Err(
                    "MiniMax Anthropic hosted web-search failed result error is required"
                        .to_string(),
                );
            }
            Ok(true)
        }
        Some("completed") => {
            if has_error {
                return Err(
                    "MiniMax Anthropic hosted web-search completed result must not include error"
                        .to_string(),
                );
            }
            Ok(false)
        }
        Some(other) => Err(format!(
            "MiniMax Anthropic hosted web-search result status {other} is not terminal"
        )),
        None => Ok(has_error),
    }
}

fn hosted_web_search_result_item_as_text_block(item: &Value) -> Result<Value, String> {
    let text = match item {
        Value::String(text) => text.clone(),
        Value::Object(object) if object.get("type").and_then(Value::as_str) == Some("text") => {
            object
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| {
                    "MiniMax Anthropic hosted web-search text result text is required".to_string()
                })?
        }
        Value::Object(_) | Value::Array(_) => serde_json::to_string(item).map_err(|error| {
            format!("MiniMax Anthropic hosted web-search result serialization failed: {error}")
        })?,
        _ => {
            return Err(
                "MiniMax Anthropic hosted web-search result item must be object, array, or string"
                    .to_string(),
            )
        }
    };
    Ok(json!({"type":"text","text":text}))
}

fn anthropic_message_content_as_blocks(content: Option<&Value>) -> Result<Vec<Value>, String> {
    match content {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Object(_) => Ok(item.clone()),
                Value::String(text) => Ok(json!({"type":"text","text":text})),
                _ => Err("MiniMax Anthropic user content array blocks must be objects".to_string()),
            })
            .collect(),
        Some(Value::String(text)) => Ok(vec![json!({"type":"text","text":text})]),
        Some(Value::Object(_)) => Ok(vec![content.cloned().unwrap()]),
        Some(_) => {
            Err("MiniMax Anthropic user content must be string, object, or array".to_string())
        }
    }
}
