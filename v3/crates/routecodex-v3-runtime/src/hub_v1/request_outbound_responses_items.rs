use crate::protocol_tables::{
    map_field as table_map_field, map_value as table_map_value, V3TableDirection, V3TableKind,
};
use serde_json::{json, Map, Value};

use super::super::request_outbound_mcp_names::provider_function_name;
use super::super::request_outbound_tool_id::compact_tool_id;
use super::{project_outbound_nested_payload_for_target_protocol, V3OutboundTargetProtocol};

pub(super) fn normalize_responses_content_part_for_role(
    part: &Value,
    role: &str,
) -> Result<Value, String> {
    let mut normalized = project_outbound_nested_payload_for_target_protocol(
        part,
        V3OutboundTargetProtocol::OpenAiResponses,
    )?;
    let is_assistant = role.eq_ignore_ascii_case("assistant");
    if let Some(row) = normalized.as_object_mut() {
        let part_type = row.get("type").and_then(Value::as_str).unwrap_or("").trim();
        // chat part type -> responses part type（查表；未命中时保留原字面量，行为零变化）
        let responses_part_type = |hub_type: &'static str| -> &'static str {
            table_map_value(
                V3TableKind::PartType,
                "responses",
                hub_type,
                V3TableDirection::Outbound,
            )
            .ok()
            .flatten()
            .unwrap_or(hub_type)
        };
        if is_assistant && part_type == "text" {
            // Responses assistant content uses the registered `text` part type.
        } else if part_type == "text" || (!is_assistant && part_type.is_empty()) {
            row.insert(
                "type".to_string(),
                Value::String(responses_part_type("input_text").to_string()),
            );
        } else if is_assistant && (part_type.is_empty() || part_type == "input_text") {
            row.insert(
                "type".to_string(),
                Value::String(responses_part_type("text").to_string()),
            );
        } else if part_type == "image_url" {
            row.insert(
                "type".to_string(),
                Value::String(responses_part_type("input_image").to_string()),
            );
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
    Ok(normalized)
}

pub(super) fn chat_content_to_responses_content(
    content: &Value,
    role: &str,
) -> Result<Value, String> {
    // chat text -> responses part type（查表；未命中时保留原字面量，行为零变化）
    let responses_part_type = |hub_type: &'static str| -> &'static str {
        table_map_value(
            V3TableKind::PartType,
            "responses",
            hub_type,
            V3TableDirection::Outbound,
        )
        .ok()
        .flatten()
        .unwrap_or(hub_type)
    };
    let text_type = if role.eq_ignore_ascii_case("assistant") {
        responses_part_type("text")
    } else {
        responses_part_type("input_text")
    };
    match content {
        Value::String(text) => Ok(Value::Array(vec![json!({"type": text_type, "text": text})])),
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(|part| normalize_responses_content_part_for_role(part, role))
                .collect::<Result<Vec<Value>, String>>()?,
        )),
        Value::Null => Ok(Value::Array(Vec::new())),
        other => Ok(Value::Array(vec![
            normalize_responses_content_part_for_role(other, role)?,
        ])),
    }
}

pub(super) fn chat_tool_call_to_responses_input_item(
    call: &Value,
) -> Result<Option<Value>, String> {
    let Some(row) = call.as_object() else {
        return Ok(None);
    };
    let function = row.get("function").and_then(Value::as_object);
    let responses_tool_call_type = row
        .get("routecodex_chat_extension")
        .and_then(|extension| extension.get("responses_tool_call_type"))
        .and_then(Value::as_str)
        .unwrap_or("function_call");
    let call_id = row
        .get("call_id")
        .or_else(|| row.get("tool_call_id"))
        .or_else(|| row.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(call_id) = call_id else {
        return Ok(None);
    };
    let name = function
        .and_then(|entry| entry.get("name"))
        .or_else(|| row.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(name) = name else {
        return Ok(None);
    };
    let name = if responses_tool_call_type == "custom_tool_call" {
        name.to_string()
    } else {
        provider_function_name(name)
    };
    let arguments = function
        .and_then(|entry| entry.get("arguments"))
        .or_else(|| row.get("arguments"))
        .cloned()
        .unwrap_or_else(|| Value::String("{}".to_string()));
    let arguments_text = arguments
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string(&arguments).unwrap_or_else(|_| "{}".to_string()));
    if responses_tool_call_type == "custom_tool_call" {
        let item_id = responses_custom_item_id(row, call_id);
        let input = serde_json::from_str::<Value>(&arguments_text)
            .ok()
            .and_then(|value| value.get("input").cloned())
            .unwrap_or_else(|| Value::String(arguments_text.clone()));
        return Ok(Some(Value::Object(Map::from_iter([
            (
                "type".to_string(),
                Value::String("custom_tool_call".to_string()),
            ),
            ("id".to_string(), Value::String(item_id)),
            ("call_id".to_string(), Value::String(call_id.to_string())),
            ("name".to_string(), Value::String(name.clone())),
            ("input".to_string(), input),
        ]))));
    }

    if responses_tool_call_type == "tool_search_call" {
        let arguments = serde_json::from_str::<Value>(&arguments_text).map_err(|error| {
            format!(
                "MalformedOutboundField target_protocol=responses path=$.input[].tool_search_call.arguments: {error}"
            )
        })?;
        let mut item = Map::from_iter([
            (
                "type".to_string(),
                Value::String("tool_search_call".to_string()),
            ),
            ("call_id".to_string(), Value::String(call_id.to_string())),
            ("arguments".to_string(), arguments),
        ]);
        project_responses_item_extension_fields(row, &mut item);
        return Ok(Some(Value::Object(item)));
    }

    let item_id = responses_function_item_id(row, call_id);
    Ok(Some(Value::Object(Map::from_iter([
        (
            "type".to_string(),
            Value::String("function_call".to_string()),
        ),
        ("id".to_string(), Value::String(item_id)),
        ("call_id".to_string(), Value::String(call_id.to_string())),
        ("name".to_string(), Value::String(name)),
        ("arguments".to_string(), Value::String(arguments_text)),
    ]))))
}

fn responses_item_id_from_chat_extension(row: &Map<String, Value>) -> Option<&str> {
    row.get("routecodex_chat_extension")
        .and_then(|extension| extension.get("responses_item_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn responses_function_item_id(row: &Map<String, Value>, call_id: &str) -> String {
    match responses_item_id_from_chat_extension(row) {
        Some(item_id) if item_id.starts_with("fc_") => item_id.to_string(),
        Some(item_id) => compact_tool_id("fc_", item_id),
        None => compact_tool_id("fc_", call_id),
    }
}

fn responses_custom_item_id(row: &Map<String, Value>, call_id: &str) -> String {
    responses_item_id_from_chat_extension(row)
        .map(str::to_string)
        .unwrap_or_else(|| compact_tool_id("fc_", call_id))
}

pub(super) fn chat_tool_result_to_responses_input_item(
    row: &Map<String, Value>,
) -> Result<Option<Value>, String> {
    let responses_tool_output_type = row
        .get("routecodex_chat_extension")
        .and_then(|extension| extension.get("responses_tool_output_type"))
        .and_then(Value::as_str)
        .unwrap_or("function_call_output");
    let call_id = row
        .get("tool_call_id")
        .or_else(|| row.get("call_id"))
        .or_else(|| row.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(call_id) = call_id else {
        return Ok(None);
    };
    let output = row
        .get("content")
        .or_else(|| row.get("output"))
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => serde_json::to_string(other).unwrap_or_else(|_| String::new()),
        })
        .unwrap_or_default();
    if responses_tool_output_type == "tool_search_output" {
        let tools = serde_json::from_str::<Value>(&output).map_err(|error| {
            format!(
                "MalformedOutboundField target_protocol=responses path=$.input[].tool_search_output.tools: {error}"
            )
        })?;
        if !tools.is_array() {
            return Err(
                "MalformedOutboundField target_protocol=responses path=$.input[].tool_search_output.tools"
                    .to_string(),
            );
        }
        let mut item = Map::from_iter([
            (
                "type".to_string(),
                Value::String("tool_search_output".to_string()),
            ),
            ("call_id".to_string(), Value::String(call_id.to_string())),
            ("tools".to_string(), tools),
        ]);
        project_responses_item_extension_fields(row, &mut item);
        return Ok(Some(Value::Object(item)));
    }

    let item_id = if responses_tool_output_type == "custom_tool_call_output" {
        responses_custom_item_id(row, call_id)
    } else {
        responses_function_item_id(row, call_id)
    };

    Ok(Some(Value::Object(Map::from_iter([
        (
            "type".to_string(),
            Value::String(responses_tool_output_type.to_string()),
        ),
        ("id".to_string(), Value::String(item_id)),
        ("call_id".to_string(), Value::String(call_id.to_string())),
        ("output".to_string(), Value::String(output)),
    ]))))
}

fn project_responses_item_extension_fields(
    chat_item: &Map<String, Value>,
    responses_item: &mut Map<String, Value>,
) {
    let Some(extension) = chat_item
        .get("routecodex_chat_extension")
        .and_then(Value::as_object)
    else {
        return;
    };
    // hub 字段 -> openai_chat 字段（互逆字段对查表；与原手写数组一致）
    for source in [
        "responses_item_id",
        "responses_status",
        "responses_execution",
    ] {
        if let Some(value) = extension.get(source) {
            if let Some(target) = table_map_field("openai_chat", source, V3TableDirection::Outbound)
                .ok()
                .flatten()
            {
                responses_item.insert(target.to_string(), value.clone());
            }
        }
    }
}
