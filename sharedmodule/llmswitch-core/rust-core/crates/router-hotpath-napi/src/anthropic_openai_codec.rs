use napi::bindgen_prelude::Result as NapiResult;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::hub_reasoning_tool_normalizer::{
    build_message_reasoning_value, normalize_message_reasoning_ssot, project_message_reasoning_text,
};
use crate::hub_resp_chatprocess_03_governance_boundary::govern_hub_resp_chatprocess_03_response;
use crate::hub_resp_outbound_client_semantics::build_anthropic_response_from_chat_value;
use crate::resp_process_stage1_tool_governance::ToolGovernanceInput;
use crate::resp_process_stage1_tool_governance_blocks::apply_patch_schema_args::normalize_apply_patch_schema_args;
use crate::shared_chat_output_normalizer::normalize_chat_message_content;
use crate::shared_json_utils::read_trimmed_string;
use crate::shared_tooling::normalize_tool_result_text;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BuildOpenAiFromAnthropicOptions {
    #[serde(default)]
    include_tool_call_ids: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildOpenAiFromAnthropicOutput {
    request: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    anthropic_tool_name_map: Option<Value>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BuildAnthropicFromChatOptions {
    #[serde(default)]
    tool_name_map: Option<Value>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    entry_endpoint: Option<String>,
}

const ANTHROPIC_REQUEST_TOP_LEVEL_FIELDS: &[&str] = &[
    "model",
    "messages",
    "tools",
    "system",
    "stop_sequences",
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "max_output_tokens",
    "metadata",
    "stream",
    "tool_choice",
    "thinking",
];

fn has_visible_text(value: &str) -> bool {
    !value.trim().is_empty()
}

fn is_likely_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("ftp://")
}

fn text_needs_separator(left: &str, right: &str) -> bool {
    let Some(left_char) = left.chars().next_back() else {
        return false;
    };
    let Some(right_char) = right.chars().next() else {
        return false;
    };
    !left_char.is_whitespace()
        && !right_char.is_whitespace()
        && (left_char.is_alphanumeric() || left_char == '.')
        && (right_char.is_alphanumeric() || right_char == '`')
}

fn join_text_segments(parts: &[String]) -> String {
    let mut out = String::new();
    for part in parts {
        if part.is_empty() {
            continue;
        }
        if !out.is_empty() && text_needs_separator(&out, part) {
            out.push(' ');
        }
        out.push_str(part);
    }
    out
}

fn normalize_anthropic_tool_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("mcp__") {
        return Some(lower);
    }
    Some(lower)
}

fn flatten_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            let parts = items
                .iter()
                .map(flatten_text)
                .filter(|entry| !entry.is_empty())
                .collect::<Vec<String>>();
            join_text_segments(&parts)
        }
        Value::Object(row) => {
            if let Some(text) = row.get("text").and_then(|v| v.as_str()) {
                return text.to_string();
            }
            if let Some(text) = row.get("thinking").and_then(|v| v.as_str()) {
                return text.to_string();
            }
            if let Some(text) = row.get("reasoning").and_then(|v| v.as_str()) {
                return text.to_string();
            }
            if let Some(content) = row.get("content") {
                return flatten_text(content);
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn normalize_tool_result_content(block: &Map<String, Value>) -> String {
    let normalized = match block.get("content") {
        Some(Value::String(text)) => normalize_tool_result_text(text),
        Some(Value::Array(items)) => items
            .iter()
            .map(|entry| match entry {
                Value::String(text) => text.clone(),
                Value::Object(obj) => read_trimmed_string(obj.get("text"))
                    .or_else(|| read_trimmed_string(obj.get("content")))
                    .unwrap_or_else(|| serde_json::to_string(entry).unwrap_or_default()),
                _ => serde_json::to_string(entry).unwrap_or_default(),
            })
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<String>>()
            .join("\n"),
        Some(other) => {
            normalize_tool_result_text(serde_json::to_string(other).unwrap_or_default().as_str())
        }
        None => String::new(),
    };
    normalize_tool_result_text(normalized.as_str())
}

fn build_openai_image_part(block: &Map<String, Value>) -> Option<Value> {
    let source = block.get("source").and_then(Value::as_object)?;
    let source_type = read_trimmed_string(source.get("type"))?.to_ascii_lowercase();
    let url = match source_type.as_str() {
        "url" => read_trimmed_string(source.get("url"))?,
        "base64" => {
            let data = read_trimmed_string(source.get("data"))?;
            let media_type = read_trimmed_string(source.get("media_type"))
                .unwrap_or_else(|| "image/png".to_string());
            format!("data:{media_type};base64,{data}")
        }
        _ => return None,
    };

    Some(Value::Object(Map::from_iter([
        ("type".to_string(), Value::String("image_url".to_string())),
        (
            "image_url".to_string(),
            Value::Object(Map::from_iter([("url".to_string(), Value::String(url))])),
        ),
    ])))
}

fn build_anthropic_tool_alias_map(raw_tools: Option<&Value>) -> Option<Value> {
    let rows = raw_tools.and_then(|v| v.as_array())?;
    if rows.is_empty() {
        return None;
    }

    let mut alias_map = Map::<String, Value>::new();
    for entry in rows {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let Some(raw_name) = row
            .get("name")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let normalized =
            normalize_anthropic_tool_name(raw_name.as_str()).unwrap_or(raw_name.clone());
        alias_map.insert(normalized.clone(), Value::String(raw_name.clone()));
        let lower = normalized.to_ascii_lowercase();
        if lower != normalized && !alias_map.contains_key(lower.as_str()) {
            alias_map.insert(lower, Value::String(raw_name));
        }
    }

    if alias_map.is_empty() {
        return None;
    }
    Some(Value::Object(alias_map))
}

fn convert_anthropic_tools_to_chat(raw_tools: Option<&Value>) -> Option<Value> {
    let rows = raw_tools.and_then(|v| v.as_array())?;
    if rows.is_empty() {
        return None;
    }

    let mut out: Vec<Value> = Vec::new();
    for entry in rows {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let Some(raw_name) = row.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(name) = normalize_anthropic_tool_name(raw_name) else {
            continue;
        };
        let description = read_trimmed_string(row.get("description"));
        let parameters = row
            .get("input_schema")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));

        let mut function = Map::<String, Value>::new();
        function.insert("name".to_string(), Value::String(name));
        function.insert("parameters".to_string(), parameters);
        if let Some(text) = description {
            function.insert("description".to_string(), Value::String(text));
        }

        out.push(Value::Object(Map::from_iter([
            ("type".to_string(), Value::String("function".to_string())),
            ("function".to_string(), Value::Object(function)),
        ])));
    }

    if out.is_empty() {
        return None;
    }
    Some(Value::Array(out))
}

fn default_anthropic_tool_input_schema() -> Value {
    Value::Object(Map::from_iter([
        ("type".to_string(), Value::String("object".to_string())),
        ("properties".to_string(), Value::Object(Map::new())),
        ("additionalProperties".to_string(), Value::Bool(true)),
    ]))
}

fn normalize_anthropic_tool_input_schema(raw: Option<&Value>) -> Value {
    let candidate = match raw {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text).ok(),
        Some(value) => Some(value.clone()),
        None => None,
    };

    match candidate {
        Some(Value::Object(mut map)) if !map.is_empty() => {
            if !map.contains_key("type") {
                map.insert("type".to_string(), Value::String("object".to_string()));
            }
            if !map.contains_key("properties") {
                map.insert("properties".to_string(), Value::Object(Map::new()));
            }
            Value::Object(map)
        }
        _ => default_anthropic_tool_input_schema(),
    }
}

fn read_chat_tool_schema_source<'a>(
    row: &'a Map<String, Value>,
    function_row: &'a Map<String, Value>,
) -> Option<&'a Value> {
    function_row
        .get("parameters")
        .or_else(|| function_row.get("input_schema"))
        .or_else(|| row.get("parameters"))
        .or_else(|| row.get("input_schema"))
}

pub(crate) fn map_chat_tools_to_anthropic_tools(raw_tools: Option<&Value>) -> Option<Value> {
    let rows = raw_tools.and_then(|v| v.as_array())?;
    if rows.is_empty() {
        return None;
    }

    let mut out: Vec<Value> = Vec::new();
    for entry in rows {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let function_row = row
            .get("function")
            .and_then(|v| v.as_object())
            .unwrap_or(row);
        let Some(name) = read_trimmed_string(function_row.get("name")) else {
            continue;
        };
        let tool_type = row
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let input_schema = if tool_type.eq_ignore_ascii_case("custom") && name == "apply_patch" {
            serde_json::json!({
                "type": "object",
                "properties": {
                        "patch": {
                            "type": "string",
                            "description": "Raw apply_patch text. Send canonical *** Begin Patch / *** End Patch grammar as a single string. Put workspace-relative paths inside patch headers such as *** Add File: tmp/example.txt or *** Update File: src/main.ts. For temporary tests, use tmp/... inside the workspace, not /tmp/.... Do not use absolute paths."
                        }
                    },
                "required": ["patch"],
                "additionalProperties": true
            })
        } else {
            normalize_anthropic_tool_input_schema(read_chat_tool_schema_source(row, function_row))
        };
        let mut tool = Map::<String, Value>::new();
        tool.insert("name".to_string(), Value::String(name));
        tool.insert("input_schema".to_string(), input_schema);
        if let Some(description) = function_row.get("description").cloned() {
            tool.insert("description".to_string(), description);
        }
        out.push(Value::Object(tool));
    }

    if out.is_empty() {
        return None;
    }
    Some(Value::Array(out))
}

#[cfg(test)]
mod apply_patch_tool_schema_tests {
    use super::map_chat_tools_to_anthropic_tools;
    use serde_json::json;

    #[test]
    fn map_chat_tools_to_anthropic_tools_repairs_custom_apply_patch_to_patch_schema() {
        let input = json!([
            {
                "type": "custom",
                "name": "apply_patch",
                "description": "Use the `apply_patch` tool to edit files."
            }
        ]);

        let out = map_chat_tools_to_anthropic_tools(Some(&input)).unwrap();
        let tools = out.as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], json!("apply_patch"));
        assert_eq!(tools[0]["input_schema"]["required"], json!(["patch"]));
        let patch_desc = tools[0]["input_schema"]["properties"]["patch"]["description"]
            .as_str()
            .unwrap_or("");
        assert!(patch_desc.contains("*** Begin Patch"));
        assert!(patch_desc.contains("workspace-relative"));
        assert!(patch_desc.contains("tmp/..."));
        assert!(patch_desc.contains("not /tmp/"));
        assert!(patch_desc.contains("Do not use absolute paths"));
        assert!(!patch_desc.contains("filePath"));
    }

    #[test]
    fn map_chat_tools_to_anthropic_tools_normalizes_missing_parameters_to_object_schema() {
        let input = json!([
            {
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": "search the web"
                }
            },
            {
                "type": "function",
                "name": "continue_execution"
            }
        ]);

        let out = map_chat_tools_to_anthropic_tools(Some(&input)).unwrap();
        let tools = out.as_array().unwrap();
        assert_eq!(tools.len(), 2);
        for tool in tools {
            assert_eq!(tool["input_schema"]["type"], json!("object"));
            assert_eq!(tool["input_schema"]["properties"], json!({}));
            assert_eq!(tool["input_schema"]["additionalProperties"], json!(true));
        }
    }

    #[test]
    fn map_chat_tools_to_anthropic_tools_preserves_top_level_input_schema() {
        let input = json!([
            {
                "type": "function",
                "name": "read_file",
                "description": "read a file",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": ["path"]
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "list_directory",
                    "description": "list files"
                },
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    }
                }
            }
        ]);

        let out = map_chat_tools_to_anthropic_tools(Some(&input)).unwrap();
        let tools = out.as_array().unwrap();
        assert_eq!(tools[0]["input_schema"]["required"], json!(["path"]));
        assert_eq!(
            tools[0]["input_schema"]["properties"]["path"]["type"],
            json!("string")
        );
        assert_eq!(
            tools[1]["input_schema"]["properties"]["path"]["type"],
            json!("string")
        );
    }
}

fn collect_openai_chat_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            let parts = items
                .iter()
                .map(collect_openai_chat_text)
                .filter(|entry| !entry.is_empty())
                .collect::<Vec<String>>();
            join_text_segments(&parts)
        }
        Value::Object(row) => {
            if let Some(text) = row.get("text").and_then(|v| v.as_str()) {
                return text.to_string();
            }
            if let Some(text) = row.get("input_text").and_then(|v| v.as_str()) {
                return text.to_string();
            }
            if let Some(text) = row.get("output_text").and_then(|v| v.as_str()) {
                return text.to_string();
            }
            if let Some(text) = row.get("content").and_then(|v| v.as_str()) {
                return text.to_string();
            }
            if let Some(content) = row.get("content") {
                return collect_openai_chat_text(content);
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn is_request_like_openai_chat_payload(value: &Value) -> bool {
    let Some(row) = value.as_object() else {
        return false;
    };
    row.get("choices").is_none()
        && row
            .get("messages")
            .and_then(|v| v.as_array())
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
}

fn content_blocks_are_all_type(content: &Value, expected_type: &str) -> bool {
    let Some(blocks) = content.as_array() else {
        return false;
    };
    if blocks.is_empty() {
        return false;
    }
    blocks.iter().all(|block| {
        block
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("type")))
            .map(|block_type| block_type.eq_ignore_ascii_case(expected_type))
            .unwrap_or(false)
    })
}

fn content_blocks_contain_type(content: &Value, expected_type: &str) -> bool {
    content
        .as_array()
        .map(|blocks| {
            blocks.iter().any(|block| {
                block
                    .as_object()
                    .and_then(|row| read_trimmed_string(row.get("type")))
                    .map(|block_type| block_type.eq_ignore_ascii_case(expected_type))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn should_merge_adjacent_anthropic_messages(role: &str, previous: &Value, next: &Value) -> bool {
    if role.eq_ignore_ascii_case("assistant") {
        return content_blocks_are_all_type(previous, "tool_use")
            && content_blocks_are_all_type(next, "tool_use");
    }
    if role.eq_ignore_ascii_case("user") {
        let previous_has_tool_result = content_blocks_contain_type(previous, "tool_result");
        let next_is_tool_result_only = content_blocks_are_all_type(next, "tool_result");
        let next_has_non_empty_text = next.as_array().is_some_and(|blocks| {
            blocks.iter().any(|block| {
                let Some(row) = block.as_object() else {
                    return false;
                };
                let is_text = read_trimmed_string(row.get("type"))
                    .is_some_and(|block_type| block_type.eq_ignore_ascii_case("text"));
                let has_text =
                    read_trimmed_string(row.get("text")).is_some_and(|text| !text.is_empty());
                is_text && has_text
            })
        });
        return previous_has_tool_result && (next_is_tool_result_only || next_has_non_empty_text);
    }
    false
}

fn merge_adjacent_anthropic_messages(messages: Vec<Value>) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    for message in messages {
        let Some(row) = message.as_object() else {
            continue;
        };
        let role = read_trimmed_string(row.get("role")).unwrap_or_else(|| "user".to_string());
        let content = row.get("content").cloned().unwrap_or(Value::Null);
        if let Some(previous) = merged.last_mut().and_then(Value::as_object_mut) {
            let previous_role =
                read_trimmed_string(previous.get("role")).unwrap_or_else(|| "user".to_string());
            if previous_role == role {
                let previous_content_value =
                    previous.get("content").cloned().unwrap_or(Value::Null);
                if let (Some(previous_content), Some(next_content)) = (
                    previous.get_mut("content").and_then(Value::as_array_mut),
                    content.as_array(),
                ) {
                    if should_merge_adjacent_anthropic_messages(
                        role.as_str(),
                        &previous_content_value,
                        &content,
                    ) {
                        previous_content.extend(next_content.iter().cloned());
                        continue;
                    }
                }
            }
        }
        merged.push(message);
    }
    merged
}

fn block_type(block: &Value) -> Option<String> {
    block
        .as_object()
        .and_then(|row| read_trimmed_string(row.get("type")))
        .map(|value| value.to_ascii_lowercase())
}

fn block_id(block: &Value, keys: &[&str]) -> Option<String> {
    let row = block.as_object()?;
    keys.iter()
        .find_map(|key| read_trimmed_string(row.get(*key)))
}

fn split_parallel_tool_use_result_turns(messages: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut index = 0;
    while index < messages.len() {
        let current = &messages[index];
        let next = messages.get(index + 1);
        let current_role = current
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("role")))
            .unwrap_or_else(|| "user".to_string());
        let next_role = next
            .and_then(Value::as_object)
            .and_then(|row| read_trimmed_string(row.get("role")))
            .unwrap_or_else(|| "user".to_string());
        let current_content = current
            .as_object()
            .and_then(|row| row.get("content"))
            .and_then(Value::as_array);
        let next_content = next
            .and_then(Value::as_object)
            .and_then(|row| row.get("content"))
            .and_then(Value::as_array);

        if current_role.eq_ignore_ascii_case("assistant")
            && next_role.eq_ignore_ascii_case("user")
            && current_content.is_some_and(|blocks| {
                blocks.len() > 1
                    && blocks
                        .iter()
                        .all(|block| block_type(block).as_deref() == Some("tool_use"))
            })
            && next_content.is_some_and(|blocks| {
                blocks.len() > 1
                    && blocks
                        .iter()
                        .all(|block| block_type(block).as_deref() == Some("tool_result"))
            })
        {
            let tool_uses = current_content.unwrap();
            let tool_results = next_content.unwrap();
            if tool_uses.len() == tool_results.len() {
                let mut matched = true;
                for (tool_use, tool_result) in tool_uses.iter().zip(tool_results.iter()) {
                    let use_id = block_id(tool_use, &["id"]);
                    let result_id = block_id(
                        tool_result,
                        &["tool_use_id", "tool_call_id", "call_id", "id"],
                    );
                    if use_id.is_none() || use_id != result_id {
                        matched = false;
                        break;
                    }
                }
                if matched {
                    for (tool_use, tool_result) in tool_uses.iter().zip(tool_results.iter()) {
                        out.push(Value::Object(Map::from_iter([
                            ("role".to_string(), Value::String("assistant".to_string())),
                            ("content".to_string(), Value::Array(vec![tool_use.clone()])),
                        ])));
                        out.push(Value::Object(Map::from_iter([
                            ("role".to_string(), Value::String("user".to_string())),
                            (
                                "content".to_string(),
                                Value::Array(vec![tool_result.clone()]),
                            ),
                        ])));
                    }
                    index += 2;
                    continue;
                }
            }
        }
        out.push(current.clone());
        index += 1;
    }
    out
}

fn collect_declared_tool_names(tools: Option<&Value>) -> Vec<String> {
    tools
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|tool| {
                    let row = tool.as_object()?;
                    read_trimmed_string(row.get("name")).or_else(|| {
                        row.get("function")
                            .and_then(Value::as_object)
                            .and_then(|function| read_trimmed_string(function.get("name")))
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn is_declared_tool_name(name: &str, declared_tool_names: &[String]) -> bool {
    if declared_tool_names.is_empty() {
        return true;
    }
    declared_tool_names.iter().any(|entry| entry == name)
}

fn normalize_anthropic_tool_history(messages: Vec<Value>) -> Vec<Value> {
    split_parallel_tool_use_result_turns(merge_adjacent_anthropic_messages(messages))
}

fn build_anthropic_request_from_openai_chat_value(chat_request: &Value) -> Value {
    let Some(request_row) = chat_request.as_object() else {
        return Value::Object(Map::new());
    };

    let model =
        read_trimmed_string(request_row.get("model")).unwrap_or_else(|| "unknown".to_string());
    let messages_source = request_row
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let declared_tool_names = collect_declared_tool_names(request_row.get("tools"));

    let mut known_tool_call_ids: Vec<String> = Vec::new();
    for entry in &messages_source {
        let Some(row) = entry.as_object() else {
            continue;
        };
        if !read_trimmed_string(row.get("role"))
            .unwrap_or_else(|| "user".to_string())
            .eq_ignore_ascii_case("assistant")
        {
            continue;
        }
        if let Some(content_items) = row.get("content").and_then(Value::as_array).cloned() {
            for block in content_items {
                let Some(block_row) = block.as_object() else {
                    continue;
                };
                let block_type = read_trimmed_string(block_row.get("type"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if block_type != "tool_use" {
                    continue;
                }
                if read_trimmed_string(block_row.get("name"))
                    .as_deref()
                    .is_some_and(|name| !is_declared_tool_name(name, &declared_tool_names))
                {
                    continue;
                }
                if let Some(id) = read_trimmed_string(block_row.get("id")) {
                    if !known_tool_call_ids.iter().any(|entry| entry == &id) {
                        known_tool_call_ids.push(id);
                    }
                }
            }
        }
        let tool_calls = row
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for tool_call in tool_calls {
            let Some(tool_row) = tool_call.as_object() else {
                continue;
            };
            let tool_name = tool_row
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| read_trimmed_string(function.get("name")))
                .or_else(|| read_trimmed_string(tool_row.get("name")));
            if tool_name
                .as_deref()
                .is_some_and(|name| !is_declared_tool_name(name, &declared_tool_names))
            {
                continue;
            }
            if let Some(id) = read_trimmed_string(tool_row.get("id")) {
                if !known_tool_call_ids.iter().any(|entry| entry == &id) {
                    known_tool_call_ids.push(id);
                }
            }
        }
    }

    let mut system_blocks: Vec<Value> = Vec::new();
    if let Some(system_value) = request_row.get("system") {
        match system_value {
            Value::String(text) => {
                if has_visible_text(text) {
                    system_blocks.push(Value::Object(Map::from_iter([
                        ("type".to_string(), Value::String("text".to_string())),
                        ("text".to_string(), Value::String(text.clone())),
                    ])));
                }
            }
            Value::Array(items) => {
                for item in items {
                    let text = flatten_text(item);
                    if has_visible_text(&text) {
                        system_blocks.push(Value::Object(Map::from_iter([
                            ("type".to_string(), Value::String("text".to_string())),
                            ("text".to_string(), Value::String(text)),
                        ])));
                    }
                }
            }
            Value::Object(_) => {
                let text = flatten_text(system_value);
                if has_visible_text(&text) {
                    system_blocks.push(Value::Object(Map::from_iter([
                        ("type".to_string(), Value::String("text".to_string())),
                        ("text".to_string(), Value::String(text)),
                    ])));
                }
            }
            _ => {}
        }
    }

    let mut messages: Vec<Value> = Vec::new();
    for entry in messages_source {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let role = read_trimmed_string(row.get("role")).unwrap_or_else(|| "user".to_string());
        if role.eq_ignore_ascii_case("system") {
            let text = collect_openai_chat_text(row.get("content").unwrap_or(&Value::Null));
            if has_visible_text(&text) {
                system_blocks.push(Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("text".to_string())),
                    ("text".to_string(), Value::String(text)),
                ])));
            }
            continue;
        }

        if role.eq_ignore_ascii_case("tool") {
            let tool_call_id = read_trimmed_string(row.get("tool_call_id"))
                .or_else(|| read_trimmed_string(row.get("call_id")))
                .or_else(|| read_trimmed_string(row.get("tool_use_id")))
                .or_else(|| read_trimmed_string(row.get("id")));
            let Some(tool_call_id) = tool_call_id else {
                continue;
            };
            if !known_tool_call_ids
                .iter()
                .any(|entry| entry == &tool_call_id)
            {
                continue;
            }
            let content = collect_openai_chat_text(row.get("content").unwrap_or(&Value::Null));
            messages.push(Value::Object(Map::from_iter([
                ("role".to_string(), Value::String("user".to_string())),
                (
                    "content".to_string(),
                    Value::Array(vec![Value::Object(Map::from_iter([
                        ("type".to_string(), Value::String("tool_result".to_string())),
                        ("tool_use_id".to_string(), Value::String(tool_call_id)),
                        (
                            "content".to_string(),
                            Value::String(normalize_tool_result_text(content.as_str())),
                        ),
                    ]))]),
                ),
            ])));
            continue;
        }

        let mut blocks: Vec<Value> = Vec::new();
        let content_node = row.get("content").unwrap_or(&Value::Null);
        if let Some(content_parts) = content_node.as_array() {
            for part in content_parts {
                let Some(part_obj) = part.as_object() else {
                    continue;
                };
                let part_type = read_trimmed_string(part_obj.get("type"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if part_type == "tool_use" {
                    let Some(name) = read_trimmed_string(part_obj.get("name")) else {
                        continue;
                    };
                    if !is_declared_tool_name(&name, &declared_tool_names) {
                        continue;
                    }
                    let Some(id) = read_trimmed_string(part_obj.get("id")) else {
                        continue;
                    };
                    let input = part_obj
                        .get("input")
                        .cloned()
                        .unwrap_or_else(|| Value::Object(Map::new()));
                    blocks.push(Value::Object(Map::from_iter([
                        ("type".to_string(), Value::String("tool_use".to_string())),
                        ("id".to_string(), Value::String(id)),
                        ("name".to_string(), Value::String(name)),
                        ("input".to_string(), input),
                    ])));
                    continue;
                }
                if part_type == "tool_result" {
                    let Some(tool_use_id) = read_trimmed_string(part_obj.get("tool_use_id"))
                        .or_else(|| read_trimmed_string(part_obj.get("tool_call_id")))
                        .or_else(|| read_trimmed_string(part_obj.get("call_id")))
                        .or_else(|| read_trimmed_string(part_obj.get("id")))
                    else {
                        continue;
                    };
                    let content =
                        collect_openai_chat_text(part_obj.get("content").unwrap_or(&Value::Null));
                    blocks.push(Value::Object(Map::from_iter([
                        ("type".to_string(), Value::String("tool_result".to_string())),
                        ("tool_use_id".to_string(), Value::String(tool_use_id)),
                        (
                            "content".to_string(),
                            Value::String(normalize_tool_result_text(content.as_str())),
                        ),
                    ])));
                    continue;
                }
                if part_type == "image" {
                    if let Some(source) = part_obj.get("source").and_then(|v| v.as_object()) {
                        let source_type = read_trimmed_string(source.get("type"))
                            .unwrap_or_default()
                            .to_ascii_lowercase();
                        if source_type == "base64" {
                            let media_type =
                                read_trimmed_string(source.get("media_type")).unwrap_or_default();
                            let data = read_trimmed_string(source.get("data")).unwrap_or_default();
                            if media_type.is_empty() || data.is_empty() {
                                panic!("Anthropic bridge constraint violated: embedded image source must include non-empty base64 data and media_type");
                            }
                        }
                        blocks.push(Value::Object(Map::from_iter([
                            ("type".to_string(), Value::String("image".to_string())),
                            ("source".to_string(), Value::Object(source.clone())),
                        ])));
                    }
                    continue;
                }
                if part_type == "image_url" || part_type == "input_image" {
                    let image_url_value = part_obj.get("image_url");
                    let mut url = String::new();
                    if let Some(Value::String(raw)) = image_url_value {
                        url = raw.trim().to_string();
                    } else if let Some(Value::Object(node)) = image_url_value {
                        if let Some(raw) = read_trimmed_string(node.get("url")) {
                            url = raw;
                        }
                    }
                    if url.is_empty() {
                        continue;
                    }
                    let source = if url.to_ascii_lowercase().starts_with("data:") {
                        let Some(comma_idx) = url.find(',') else {
                            panic!("Anthropic bridge constraint violated: malformed data URL image payload");
                        };
                        let header = &url[..comma_idx];
                        let data = &url[comma_idx + 1..];
                        let media_type = header
                            .strip_prefix("data:")
                            .and_then(|s| s.split(';').next())
                            .filter(|s| !s.trim().is_empty())
                            .unwrap_or("image/png");
                        Value::Object(Map::from_iter([
                            ("type".to_string(), Value::String("base64".to_string())),
                            (
                                "media_type".to_string(),
                                Value::String(media_type.to_string()),
                            ),
                            ("data".to_string(), Value::String(data.to_string())),
                        ]))
                    } else if is_likely_url(&url) {
                        Value::Object(Map::from_iter([
                            ("type".to_string(), Value::String("url".to_string())),
                            ("url".to_string(), Value::String(url)),
                        ]))
                    } else {
                        panic!("Anthropic bridge constraint violated: image_url must be a valid URL or data URL");
                    };
                    blocks.push(Value::Object(Map::from_iter([
                        ("type".to_string(), Value::String("image".to_string())),
                        ("source".to_string(), source),
                    ])));
                    continue;
                }
                if part_type == "text" || part_type == "input_text" {
                    if let Some(text) = read_trimmed_string(part_obj.get("text")) {
                        blocks.push(Value::Object(Map::from_iter([
                            ("type".to_string(), Value::String("text".to_string())),
                            ("text".to_string(), Value::String(text)),
                        ])));
                    }
                }
            }
        } else {
            let text = collect_openai_chat_text(content_node);
            if has_visible_text(&text) {
                blocks.push(Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("text".to_string())),
                    ("text".to_string(), Value::String(text)),
                ])));
            }
        }

        if role.eq_ignore_ascii_case("assistant") {
            if let Some(reasoning_text) = read_trimmed_string(row.get("reasoning_content"))
                .or_else(|| read_trimmed_string(row.get("reasoning")))
            {
                if has_visible_text(&reasoning_text) {
                    blocks.push(Value::Object(Map::from_iter([
                        ("type".to_string(), Value::String("thinking".to_string())),
                        ("text".to_string(), Value::String(reasoning_text)),
                    ])));
                }
            }

            let tool_calls = row
                .get("tool_calls")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for (index, tool_call) in tool_calls.iter().enumerate() {
                let Some(tool_row) = tool_call.as_object() else {
                    continue;
                };
                let Some(function_row) = tool_row.get("function").and_then(|v| v.as_object())
                else {
                    continue;
                };
                let Some(name) = read_trimmed_string(function_row.get("name")) else {
                    continue;
                };
                if !is_declared_tool_name(&name, &declared_tool_names) {
                    continue;
                }
                let id = read_trimmed_string(tool_row.get("id"))
                    .unwrap_or_else(|| format!("call_{}", index));
                let input = function_row
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .and_then(|raw| {
                        if name == "apply_patch" {
                            let raw_value = Value::String(raw.to_string());
                            let normalized = normalize_apply_patch_schema_args(Some(&raw_value)).0;
                            return serde_json::from_str::<Value>(&normalized).ok();
                        }
                        serde_json::from_str::<Value>(raw).ok()
                    })
                    .unwrap_or_else(|| Value::Object(Map::new()));
                blocks.push(Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("tool_use".to_string())),
                    ("id".to_string(), Value::String(id)),
                    ("name".to_string(), Value::String(name)),
                    ("input".to_string(), input),
                ])));
            }
        }

        if !blocks.is_empty() {
            messages.push(Value::Object(Map::from_iter([
                ("role".to_string(), Value::String(role)),
                ("content".to_string(), Value::Array(blocks)),
            ])));
        }
    }

    let messages = normalize_anthropic_tool_history(messages);

    let mut out = Map::<String, Value>::new();
    out.insert("model".to_string(), Value::String(model));
    out.insert("messages".to_string(), Value::Array(messages));
    if !system_blocks.is_empty() {
        out.insert("system".to_string(), Value::Array(system_blocks));
    }
    if let Some(tools) = map_chat_tools_to_anthropic_tools(request_row.get("tools")) {
        out.insert("tools".to_string(), tools);
    }
    for key in [
        "tool_choice",
        "thinking",
        "metadata",
        "temperature",
        "top_p",
        "top_k",
        "max_tokens",
        "max_output_tokens",
        "stream",
    ] {
        if let Some(value) = request_row.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    if let Some(stop) = request_row.get("stop") {
        match stop {
            Value::String(text) if has_visible_text(text) => {
                out.insert(
                    "stop_sequences".to_string(),
                    Value::Array(vec![Value::String(text.trim().to_string())]),
                );
            }
            Value::Array(items) if !items.is_empty() => {
                out.insert("stop_sequences".to_string(), Value::Array(items.clone()));
            }
            _ => {}
        }
    }

    let mut pruned = Map::<String, Value>::new();
    for key in ANTHROPIC_REQUEST_TOP_LEVEL_FIELDS {
        if let Some(value) = out.get(*key) {
            pruned.insert((*key).to_string(), value.clone());
        }
    }
    Value::Object(pruned)
}

fn append_system_messages(raw_system: Option<&Value>, messages: &mut Vec<Value>) {
    let blocks: Vec<Value> = match raw_system {
        Some(Value::Array(items)) => items.clone(),
        Some(value) if !value.is_null() => vec![value.clone()],
        _ => Vec::new(),
    };

    for block in blocks {
        let text = flatten_text(&block);
        if !has_visible_text(&text) {
            continue;
        }
        messages.push(Value::Object(Map::from_iter([
            ("role".to_string(), Value::String("system".to_string())),
            ("content".to_string(), Value::String(text)),
        ])));
    }
}

fn convert_anthropic_messages(
    raw_messages: Option<&Value>,
    include_tool_call_ids: bool,
) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let rows = match raw_messages.and_then(|v| v.as_array()) {
        Some(rows) => rows,
        None => return out,
    };

    for entry in rows {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let role = read_trimmed_string(row.get("role")).unwrap_or_else(|| "user".to_string());
        let content = row.get("content").cloned().unwrap_or(Value::Null);
        let Some(blocks) = content.as_array() else {
            let text = flatten_text(&content);
            if !has_visible_text(&text) {
                continue;
            }
            let normalized = normalize_chat_message_content(&Value::String(text.clone()));
            let normalized_reasoning = normalized.reasoning_text.filter(|v| !v.trim().is_empty());
            let mut message = Map::<String, Value>::new();
            message.insert("role".to_string(), Value::String(role));
            message.insert(
                "content".to_string(),
                Value::String(if normalized_reasoning.is_some() {
                    normalized.content_text.unwrap_or_else(|| text.clone())
                } else {
                    text.clone()
                }),
            );
            if let Some(rc) = row.get("reasoning_content") {
                if !rc.is_null() {
                    message.insert("reasoning_content".to_string(), rc.clone());
                }
            }
            if let Some(reasoning) = normalized_reasoning {
                if let Some(reasoning_payload) =
                    build_message_reasoning_value(&[], &[reasoning], None)
                {
                    if let Some(text) = project_message_reasoning_text(&reasoning_payload) {
                        message.insert("reasoning_content".to_string(), Value::String(text));
                    }
                    message.insert("reasoning".to_string(), reasoning_payload);
                }
            }
            normalize_message_reasoning_ssot(&mut message);
            out.push(Value::Object(message));
            continue;
        };

        let mut text_parts: Vec<String> = Vec::new();
        let mut image_parts: Vec<Value> = Vec::new();
        let mut reasoning_parts: Vec<String> = Vec::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        let mut tool_results: Vec<Value> = Vec::new();

        for block in blocks {
            let Some(block_obj) = block.as_object() else {
                continue;
            };
            let kind = read_trimmed_string(block_obj.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            match kind.as_str() {
                "text" => {
                    let text = flatten_text(block);
                    if has_visible_text(&text) {
                        text_parts.push(text);
                    }
                }
                "thinking" | "reasoning" => {
                    let text = flatten_text(block);
                    if has_visible_text(&text) {
                        reasoning_parts.push(text);
                    }
                }
                "image" => {
                    if let Some(image_part) = build_openai_image_part(block_obj) {
                        image_parts.push(image_part);
                    }
                }
                "tool_use" => {
                    let Some(name) = read_trimmed_string(block_obj.get("name")) else {
                        continue;
                    };
                    let canonical_name = normalize_anthropic_tool_name(&name).unwrap_or(name);
                    let Some(id) = read_trimmed_string(block_obj.get("id")) else {
                        continue;
                    };
                    let args = block_obj
                        .get("input")
                        .cloned()
                        .unwrap_or_else(|| Value::Object(Map::new()));
                    let mut tool_call = Map::<String, Value>::new();
                    tool_call.insert("id".to_string(), Value::String(id.clone()));
                    if include_tool_call_ids {
                        tool_call.insert("call_id".to_string(), Value::String(id.clone()));
                        tool_call.insert("tool_call_id".to_string(), Value::String(id.clone()));
                    }
                    let mut function = Map::<String, Value>::new();
                    function.insert("name".to_string(), Value::String(canonical_name));
                    function.insert(
                        "arguments".to_string(),
                        Value::String(
                            serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string()),
                        ),
                    );
                    tool_call.insert("type".to_string(), Value::String("function".to_string()));
                    tool_call.insert("function".to_string(), Value::Object(function));
                    tool_calls.push(Value::Object(tool_call));
                }
                "tool_result" => {
                    let call_id = read_trimmed_string(block_obj.get("tool_call_id"))
                        .or_else(|| read_trimmed_string(block_obj.get("call_id")))
                        .or_else(|| read_trimmed_string(block_obj.get("tool_use_id")))
                        .or_else(|| read_trimmed_string(block_obj.get("id")));
                    let Some(tool_call_id) = call_id else {
                        continue;
                    };
                    let content = normalize_tool_result_content(block_obj);
                    tool_results.push(Value::Object(Map::from_iter([
                        ("role".to_string(), Value::String("tool".to_string())),
                        ("tool_call_id".to_string(), Value::String(tool_call_id)),
                        ("content".to_string(), Value::String(content)),
                    ])));
                }
                _ => {}
            }
        }

        if !text_parts.is_empty()
            || !image_parts.is_empty()
            || !tool_calls.is_empty()
            || !reasoning_parts.is_empty()
        {
            let combined_text = join_text_segments(&text_parts);
            let normalized = normalize_chat_message_content(&Value::String(combined_text.clone()));
            let normalized_reasoning = normalized.reasoning_text.filter(|v| !v.trim().is_empty());
            let text_payload = if normalized_reasoning.is_some() {
                normalized
                    .content_text
                    .unwrap_or_else(|| combined_text.clone())
            } else {
                combined_text.clone()
            };
            let mut message = Map::<String, Value>::new();
            message.insert("role".to_string(), Value::String(role));
            if image_parts.is_empty() {
                message.insert("content".to_string(), Value::String(text_payload.clone()));
            } else {
                let mut content_parts: Vec<Value> = Vec::new();
                if has_visible_text(&text_payload) {
                    content_parts.push(Value::Object(Map::from_iter([
                        ("type".to_string(), Value::String("text".to_string())),
                        ("text".to_string(), Value::String(text_payload.clone())),
                    ])));
                }
                content_parts.extend(image_parts);
                message.insert("content".to_string(), Value::Array(content_parts));
            }
            if !tool_calls.is_empty() {
                message.insert("tool_calls".to_string(), Value::Array(tool_calls));
            }
            let mut merged_reasoning = reasoning_parts;
            if let Some(reasoning) = normalized_reasoning {
                merged_reasoning.push(reasoning);
            }
            if let Some(reasoning_payload) =
                build_message_reasoning_value(&[], &merged_reasoning, None)
            {
                if let Some(text) = project_message_reasoning_text(&reasoning_payload) {
                    message.insert("reasoning_content".to_string(), Value::String(text));
                }
                message.insert("reasoning".to_string(), reasoning_payload);
            }
            normalize_message_reasoning_ssot(&mut message);
            out.push(Value::Object(message));
        }

        out.extend(tool_results);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::{build_anthropic_from_openai_chat_json, build_openai_chat_from_anthropic_json};
    use crate::responses_openai_codec::run_responses_openai_request_codec_json;
    use serde_json::{json, Value};

    #[test]
    fn build_openai_chat_from_anthropic_preserves_image_blocks() {
        let payload = json!({
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": "AAA"
                            }
                        },
                        { "type": "text", "text": "describe the image" }
                    ]
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": { "type": "object" }
                    }
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_openai_chat_from_anthropic_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let content = output["request"]["messages"][0]["content"]
            .as_array()
            .expect("content array");
        assert_eq!(content[0]["type"].as_str(), Some("text"));
        assert_eq!(content[0]["text"].as_str(), Some("describe the image"));
        assert_eq!(content[1]["type"].as_str(), Some("image_url"));
        assert_eq!(
            content[1]["image_url"]["url"].as_str(),
            Some("data:image/png;base64,AAA")
        );
    }

    #[test]
    fn build_anthropic_from_openai_chat_preserves_tool_history_without_declared_tools() {
        let raw = build_anthropic_from_openai_chat_json(
            json!({
                "model": "key1.MiniMax-M2.7",
                "messages": [
                    {
                        "role": "system",
                        "content": "当你准备结束当前轮时，必须输出 stop schema JSON。"
                    },
                    {
                        "role": "user",
                        "content": "继续执行 stopless 在线验证"
                    },
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_stopless_1",
                                "type": "function",
                                "function": {
                                    "name": "exec_command",
                                    "arguments": "{\"cmd\":\"routecodex hook run reasoning_stop\"}"
                                }
                            }
                        ]
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_stopless_1",
                        "name": "exec_command",
                        "content": "{\"repeatCount\":2,\"summary\":\"stopless continuation ready\"}"
                    }
                ],
                "stream": false
            })
            .to_string(),
            None,
        )
        .expect("anthropic request");

        let payload: Value = serde_json::from_str(&raw).expect("anthropic payload");
        let messages = payload["messages"].as_array().expect("anthropic messages");

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], json!("user"));
        assert_eq!(messages[1]["role"], json!("assistant"));
        assert_eq!(messages[1]["content"][0]["type"], json!("tool_use"));
        assert_eq!(messages[1]["content"][0]["id"], json!("call_stopless_1"));
        assert_eq!(messages[1]["content"][0]["name"], json!("exec_command"));
        assert_eq!(messages[2]["role"], json!("user"));
        assert_eq!(messages[2]["content"][0]["type"], json!("tool_result"));
        assert_eq!(
            messages[2]["content"][0]["tool_use_id"],
            json!("call_stopless_1")
        );
        assert_eq!(
            payload["system"][0]["text"],
            json!("当你准备结束当前轮时，必须输出 stop schema JSON。")
        );
    }

    #[test]
    fn build_openai_chat_from_anthropic_preserves_text_block_word_boundaries() {
        let payload = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "Let me understand" },
                        { "type": "text", "text": "what we need to do." }
                    ]
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_openai_chat_from_anthropic_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        assert_eq!(
            output["request"]["messages"][0]["content"].as_str(),
            Some("Let me understand what we need to do.")
        );
    }

    #[test]
    fn build_openai_chat_from_anthropic_preserves_tool_use_as_tool_calls() {
        let payload = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "I will run pwd." },
                        {
                            "type": "tool_use",
                            "id": "call_exec_1",
                            "name": "exec_command",
                            "input": { "cmd": "pwd" }
                        }
                    ]
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_openai_chat_from_anthropic_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let message = &output["request"]["messages"][0];
        assert_eq!(message["content"].as_str(), Some("I will run pwd."));
        let tool_calls = message["tool_calls"].as_array().expect("tool calls");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0]["id"].as_str(), Some("call_exec_1"));
        assert_eq!(
            tool_calls[0]["function"]["name"].as_str(),
            Some("exec_command")
        );
        assert_eq!(
            tool_calls[0]["function"]["arguments"].as_str(),
            Some("{\"cmd\":\"pwd\"}")
        );
    }

    #[test]
    fn build_openai_chat_from_anthropic_preserves_parallel_tool_pair_order() {
        let payload = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "call_parallel_1",
                            "name": "exec_command",
                            "input": { "cmd": "pwd" }
                        },
                        {
                            "type": "tool_use",
                            "id": "call_parallel_2",
                            "name": "exec_command",
                            "input": { "cmd": "ls" }
                        }
                    ]
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_parallel_1",
                            "content": "/tmp"
                        },
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_parallel_2",
                            "content": "file-a"
                        }
                    ]
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_openai_chat_from_anthropic_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let messages = output["request"]["messages"]
            .as_array()
            .expect("messages array");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], json!("assistant"));
        assert_eq!(messages[0]["tool_calls"][0]["id"], json!("call_parallel_1"));
        assert_eq!(messages[0]["tool_calls"][1]["id"], json!("call_parallel_2"));
        assert_eq!(messages[1]["role"], json!("tool"));
        assert_eq!(messages[1]["tool_call_id"], json!("call_parallel_1"));
        assert_eq!(messages[1]["content"], json!("/tmp"));
        assert_eq!(messages[2]["role"], json!("tool"));
        assert_eq!(messages[2]["tool_call_id"], json!("call_parallel_2"));
        assert_eq!(messages[2]["content"], json!("file-a"));
    }

    #[test]
    fn build_anthropic_from_openai_chat_does_not_resurrect_stringified_tool_use_blocks() {
        let payload = json!({
            "model": "mimo-v2.5",
            "messages": [
                {
                    "role": "assistant",
                    "content": "[{\"id\":\"call_stringified_tool_use_1\",\"input\":{\"cmd\":\"pwd\"},\"name\":\"exec_command\",\"type\":\"tool_use\"}]"
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_stringified_tool_use_1",
                    "content": "ok"
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_anthropic_from_openai_chat_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let messages = output["messages"].as_array().expect("messages array");
        let serialized = serde_json::to_string(messages).unwrap();
        assert!(!serialized.contains("\"type\":\"tool_use\""));
        assert!(!serialized.contains("\"type\":\"tool_result\""));
        assert!(serialized.contains("call_stringified_tool_use_1"));
    }

    #[test]
    fn build_anthropic_from_openai_chat_does_not_resurrect_content_tool_use_blocks() {
        let payload = json!({
            "model": "mimo-v2.5",
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {"id":"call_content_tool_use_1","input":{"cmd":"bd"},"name":"bd","type":"tool_use"}
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_content_tool_use_1",
                    "content": "ok"
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": { "type": "object" }
                    }
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_anthropic_from_openai_chat_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let messages = output["messages"].as_array().expect("messages array");
        let serialized = serde_json::to_string(messages).unwrap();
        assert!(!serialized.contains("\"name\":\"bd\""));
        assert!(!serialized.contains("\"type\":\"tool_use\""));
        assert!(!serialized.contains("\"type\":\"tool_result\""));
    }

    #[test]
    fn build_anthropic_from_openai_chat_merges_tool_result_with_following_user_text_turn() {
        let payload = json!({
            "model": "MiniMax-M3",
            "messages": [
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"pwd\"}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "content": "ok"
                },
                {
                    "role": "user",
                    "content": "继续"
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": { "type": "object" }
                    }
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_anthropic_from_openai_chat_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let messages = output["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["role"].as_str(), Some("user"));
        assert_eq!(messages[1]["content"].as_array().unwrap().len(), 2);
        assert_eq!(
            messages[1]["content"][0]["type"].as_str(),
            Some("tool_result")
        );
        assert_eq!(messages[1]["content"][1]["type"].as_str(), Some("text"));
        assert_eq!(messages[1]["content"][1]["text"].as_str(), Some("继续"));
    }

    #[test]
    fn build_anthropic_from_openai_chat_keeps_tool_result_then_user_image_placeholder_in_one_user_turn(
    ) {
        let payload = json!({
            "model": "MiniMax-M3",
            "messages": [
                { "role": "user", "content": "start" },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_inline_image_history",
                            "tool_call_id": "call_inline_image_history",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"tail -n 60 note.md\"}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_inline_image_history",
                    "id": "call_inline_image_history",
                    "content": "Total output lines: 141\n[data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB]"
                },
                {
                    "role": "user",
                    "content": [{ "type": "text", "text": "[Image omitted]" }]
                },
                { "role": "assistant", "content": "continue" }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": { "type": "object" }
                    }
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_anthropic_from_openai_chat_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let messages = output["messages"].as_array().expect("messages array");
        let tool_use_index = messages
            .iter()
            .position(|message| {
                message["content"].as_array().is_some_and(|content| {
                    content.iter().any(|part| {
                        part["type"].as_str() == Some("tool_use")
                            && part["id"].as_str() == Some("call_inline_image_history")
                    })
                })
            })
            .expect("tool_use exists");
        let merged_user_turn = messages
            .get(tool_use_index + 1)
            .expect("merged user turn follows tool_use");
        assert_eq!(merged_user_turn["role"].as_str(), Some("user"));
        let content = merged_user_turn["content"]
            .as_array()
            .expect("merged user content");
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"].as_str(), Some("tool_result"));
        assert_eq!(
            content[0]["tool_use_id"].as_str(),
            Some("call_inline_image_history")
        );
        assert_eq!(content[1]["type"].as_str(), Some("text"));
        assert_eq!(content[1]["text"].as_str(), Some("[Image omitted]"));
    }

    #[test]
    fn build_anthropic_from_openai_chat_splits_parallel_tool_pairs_before_followup_user_turn() {
        let payload = json!({
            "model": "MiniMax-M3",
            "messages": [
                { "role": "user", "content": "start" },
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_parallel_1",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"pwd\"}"
                            }
                        },
                        {
                            "id": "call_parallel_2",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"ls\"}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_parallel_1",
                    "content": "/tmp"
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_parallel_2",
                    "content": "file-a"
                },
                {
                    "role": "user",
                    "content": [{ "type": "text", "text": "继续" }]
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": { "type": "object" }
                    }
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_anthropic_from_openai_chat_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let messages = output["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 6);
        assert_eq!(messages[0]["role"], json!("user"));
        assert_eq!(messages[1]["role"], json!("assistant"));
        assert_eq!(messages[1]["content"][0]["type"], json!("tool_use"));
        assert_eq!(messages[1]["content"][0]["id"], json!("call_parallel_1"));
        assert_eq!(messages[2]["role"], json!("user"));
        assert_eq!(messages[2]["content"][0]["type"], json!("tool_result"));
        assert_eq!(
            messages[2]["content"][0]["tool_use_id"],
            json!("call_parallel_1")
        );
        assert_eq!(messages[3]["role"], json!("assistant"));
        assert_eq!(messages[3]["content"][0]["type"], json!("tool_use"));
        assert_eq!(messages[3]["content"][0]["id"], json!("call_parallel_2"));
        assert_eq!(messages[4]["role"], json!("user"));
        assert_eq!(messages[4]["content"][0]["type"], json!("tool_result"));
        assert_eq!(
            messages[4]["content"][0]["tool_use_id"],
            json!("call_parallel_2")
        );
    }

    #[test]
    fn build_openai_chat_from_anthropic_preserves_blank_lines() {
        let payload = json!({
            "system": [{ "type": "text", "text": "system line 1\n\nsystem line 2\n" }],
            "messages": [
                {
                    "role": "user",
                    "content": "alpha\n\nbeta\n\ngamma"
                },
                {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "first\n\nsecond" },
                        { "type": "text", "text": "\n\nthird" }
                    ]
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_openai_chat_from_anthropic_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let messages = output["request"]["messages"]
            .as_array()
            .expect("messages array");
        assert_eq!(
            messages[0]["content"].as_str(),
            Some("system line 1\n\nsystem line 2\n")
        );
        assert_eq!(
            messages[1]["content"].as_str(),
            Some("alpha\n\nbeta\n\ngamma")
        );
        assert_eq!(
            messages[2]["content"].as_str(),
            Some("first\n\nsecond\n\nthird")
        );
    }

    #[test]
    fn build_openai_chat_from_anthropic_preserves_thinking_field_reasoning() {
        let payload = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "先检查代码路径", "signature": "sig_payload" }
                    ]
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_openai_chat_from_anthropic_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let messages = output["request"]["messages"]
            .as_array()
            .expect("messages array");
        assert_eq!(messages[0]["content"].as_str(), Some(""));
        assert_eq!(
            messages[0]["reasoning_content"].as_str(),
            Some("先检查代码路径")
        );
        assert_eq!(
            messages[0]["reasoning"]["content"][0]["text"].as_str(),
            Some("先检查代码路径")
        );
    }

    #[test]
    fn build_openai_chat_from_anthropic_strips_tool_result_transcript_wrappers() {
        let payload = json!({
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_1",
                            "content": "Chunk ID: 93f309\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 2221\nOutput:\nalpha\nbeta\n"
                        }
                    ]
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_openai_chat_from_anthropic_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let messages = output["request"]["messages"]
            .as_array()
            .expect("messages array");
        assert_eq!(messages[0]["role"].as_str(), Some("tool"));
        assert_eq!(messages[0]["tool_call_id"].as_str(), Some("call_1"));
        assert_eq!(messages[0]["content"].as_str(), Some("alpha\nbeta"));
    }

    #[test]
    fn build_anthropic_from_openai_chat_request_preserves_reasoning_only_assistant_turn() {
        let payload = json!({
            "model": "mimo-v2.5-pro",
            "messages": [
                { "role": "user", "content": "请调用 echo_json 工具，并传入 {\"message\":\"ping\"}。不要直接回答。" },
                { "role": "assistant", "content": "", "reasoning_content": "The user wants me to call the echo_json tool with {\"message\":\"ping\"}." },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_x",
                            "type": "function",
                            "function": {
                                "name": "echo_json",
                                "arguments": "{\"message\":\"ping\"}"
                            }
                        }
                    ]
                },
                { "role": "tool", "tool_call_id": "call_x", "content": "{\"message\":\"ping\"}" }
            ],
            "thinking": { "type": "adaptive" },
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "echo_json",
                        "description": "echo structured payload",
                        "parameters": {
                            "type": "object",
                            "properties": { "message": { "type": "string" } },
                            "required": ["message"],
                            "additionalProperties": false
                        }
                    }
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_anthropic_from_openai_chat_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let messages = output["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[1]["role"].as_str(), Some("assistant"));
        let assistant_blocks = messages[1]["content"]
            .as_array()
            .expect("assistant content");
        assert_eq!(assistant_blocks.len(), 1);
        assert_eq!(assistant_blocks[0]["type"].as_str(), Some("thinking"));
        assert_eq!(
            assistant_blocks[0]["text"].as_str(),
            Some("The user wants me to call the echo_json tool with {\"message\":\"ping\"}.")
        );
        let tool_use_blocks = messages[2]["content"]
            .as_array()
            .expect("assistant tool use content");
        assert_eq!(messages[2]["role"].as_str(), Some("assistant"));
        assert_eq!(tool_use_blocks[0]["type"].as_str(), Some("tool_use"));
        assert_eq!(tool_use_blocks[0]["id"].as_str(), Some("call_x"));
        assert_eq!(messages[3]["role"].as_str(), Some("user"));
        assert_eq!(
            messages[3]["content"][0]["tool_use_id"].as_str(),
            Some("call_x")
        );
    }

    #[test]
    fn build_anthropic_from_openai_chat_keeps_tool_result_before_user_image_turn() {
        let payload = json!({
            "model": "MiniMax-M3",
            "messages": [
                { "role": "user", "content": "start" },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_inline_image_history",
                            "tool_call_id": "call_inline_image_history",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"tail -n 60 note.md\"}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_inline_image_history",
                    "id": "call_inline_image_history",
                    "content": "Total output lines: 141\n[data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB]"
                },
                {
                    "role": "user",
                    "content": [{ "type": "text", "text": "[Image omitted]" }]
                },
                { "role": "assistant", "content": "continue" }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": { "type": "object" }
                    }
                }
            ]
        });

        let output: Value = serde_json::from_str(
            &build_anthropic_from_openai_chat_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");

        let messages = output["messages"].as_array().expect("messages array");
        let tool_use_index = messages
            .iter()
            .position(|message| {
                message["content"].as_array().is_some_and(|content| {
                    content.iter().any(|part| {
                        part["type"].as_str() == Some("tool_use")
                            && part["id"].as_str() == Some("call_inline_image_history")
                    })
                })
            })
            .expect("tool_use exists");
        let tool_result_message = messages
            .get(tool_use_index + 1)
            .expect("tool_result follows tool_use");
        assert_eq!(tool_result_message["role"].as_str(), Some("user"));
        assert_eq!(
            tool_result_message["content"][0]["type"].as_str(),
            Some("tool_result")
        );
        assert_eq!(
            tool_result_message["content"][0]["tool_use_id"].as_str(),
            Some("call_inline_image_history")
        );
        assert!(tool_result_message["content"][0]["content"]
            .as_str()
            .unwrap_or_default()
            .contains("[Image omitted]"));
    }

    #[test]
    fn responses_to_anthropic_chain_preserves_image_turn_after_tool_result() {
        let responses_raw = run_responses_openai_request_codec_json(
            json!({
                "model": "router-gpt-5.5",
                "previous_response_id": "resp_prev_image_1",
                "stream": true,
                "input": [
                    {
                        "type": "function_call",
                        "id": "fc_call_image_1",
                        "call_id": "call_image_1",
                        "name": "probe_tool",
                        "arguments": "{\"query\":\"routecodex_probe\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_call_image_1",
                        "call_id": "call_image_1",
                        "output": "TOOL_RESULT_ROUTE_CODEX_OK"
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_image", "image_url": "data:image/png;base64,AAA" },
                            { "type": "input_text", "text": "看看这张图" }
                        ]
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "probe_tool",
                        "parameters": { "type": "object", "properties": {} }
                    }
                ]
            })
            .to_string(),
            Some(json!({ "requestId": "req_responses_to_anthropic_image_turn" }).to_string()),
        )
        .expect("responses build success");
        let openai_chat: Value = serde_json::from_str(&responses_raw).expect("responses json");

        let anthropic_raw =
            build_anthropic_from_openai_chat_json(openai_chat["request"].to_string(), None)
                .expect("anthropic build success");
        let anthropic: Value = serde_json::from_str(&anthropic_raw).expect("anthropic json");
        let messages = anthropic["messages"].as_array().expect("messages array");

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], json!("assistant"));
        assert_eq!(messages[0]["content"][0]["type"], json!("tool_use"));
        assert_eq!(messages[1]["role"], json!("user"));
        assert_eq!(messages[1]["content"][0]["type"], json!("tool_result"));
        assert_eq!(
            messages[1]["content"][0]["tool_use_id"],
            json!("call_image_1")
        );
        assert_eq!(messages[2]["role"], json!("user"));
        assert_eq!(messages[2]["content"][0]["type"], json!("image"));
        assert_eq!(messages[2]["content"][1]["type"], json!("text"));
        assert_eq!(messages[2]["content"][1]["text"], json!("看看这张图"));
    }

    #[test]
    fn build_anthropic_from_openai_chat_wraps_freeform_apply_patch_history_as_patch_input() {
        let patch = "*** Begin Patch\n*** Add File: tmp/apply-patch-test/hello.txt\n+hello apply_patch\n*** End Patch";
        let payload = json!({
            "model": "MiniMax-M3",
            "messages": [
                { "role": "user", "content": "add file" },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_apply_patch",
                        "type": "function",
                        "function": {
                            "name": "apply_patch",
                            "arguments": patch
                        }
                    }]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_apply_patch",
                    "content": "aborted"
                }
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "apply_patch",
                    "description": "apply patch",
                    "parameters": {
                        "type": "object",
                        "properties": { "patch": { "type": "string" } },
                        "required": ["patch"]
                    }
                }
            }]
        });

        let output: Value = serde_json::from_str(
            &build_anthropic_from_openai_chat_json(payload.to_string(), None)
                .expect("build success"),
        )
        .expect("json output");
        let messages = output["messages"].as_array().expect("messages array");
        let tool_use = &messages[1]["content"][0];

        assert_eq!(tool_use["type"].as_str(), Some("tool_use"));
        assert_eq!(tool_use["name"].as_str(), Some("apply_patch"));
        assert_eq!(tool_use["input"]["patch"].as_str(), Some(patch));
        assert_ne!(
            tool_use["input"],
            json!({}),
            "freeform apply_patch history must not be dropped to empty provider input"
        );
    }
}

pub(crate) fn build_openai_chat_from_anthropic_json(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let options: BuildOpenAiFromAnthropicOptions = match options_json {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).map_err(|e| napi::Error::from_reason(e.to_string()))?
        }
        _ => BuildOpenAiFromAnthropicOptions::default(),
    };

    let body = payload.as_object().cloned().unwrap_or_default();
    let mut messages = Vec::<Value>::new();
    append_system_messages(body.get("system"), &mut messages);
    messages.extend(convert_anthropic_messages(
        body.get("messages"),
        options.include_tool_call_ids,
    ));

    let mut request = Map::<String, Value>::new();
    request.insert("messages".to_string(), Value::Array(messages));
    if let Some(model) = read_trimmed_string(body.get("model")) {
        request.insert("model".to_string(), Value::String(model));
    }
    if let Some(value) = body.get("stop_sequences").and_then(|v| v.as_array()) {
        request.insert("stop".to_string(), Value::Array(value.clone()));
    }
    for key in [
        "temperature",
        "top_p",
        "max_tokens",
        "stream",
        "tool_choice",
    ] {
        if let Some(value) = body.get(key) {
            request.insert(key.to_string(), value.clone());
        }
    }
    if let Some(tools) = convert_anthropic_tools_to_chat(body.get("tools")) {
        request.insert("tools".to_string(), tools);
    }
    if let Some(request_id) =
        read_trimmed_string(body.get("id")).or_else(|| read_trimmed_string(body.get("request_id")))
    {
        request.insert("request_id".to_string(), Value::String(request_id));
    }

    let output = BuildOpenAiFromAnthropicOutput {
        request: Value::Object(request),
        anthropic_tool_name_map: build_anthropic_tool_alias_map(body.get("tools")),
    };

    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub(crate) fn build_anthropic_from_openai_chat_json(
    chat_response_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    let chat_response: Value = serde_json::from_str(&chat_response_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let options: BuildAnthropicFromChatOptions = match options_json {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).map_err(|e| napi::Error::from_reason(e.to_string()))?
        }
        _ => BuildAnthropicFromChatOptions::default(),
    };

    if is_request_like_openai_chat_payload(&chat_response) {
        let output = build_anthropic_request_from_openai_chat_value(&chat_response);
        return serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()));
    }

    let unwrapped = chat_response
        .as_object()
        .and_then(|row| row.get("data"))
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or(chat_response);

    let request_id = options
        .request_id
        .unwrap_or_else(|| "anthropic-openai-codec".to_string());
    let entry_endpoint = options
        .entry_endpoint
        .unwrap_or_else(|| "/v1/messages".to_string());

    let governed = govern_hub_resp_chatprocess_03_response(ToolGovernanceInput {
        payload: unwrapped,
        client_protocol: "anthropic-messages".to_string(),
        entry_endpoint,
        request_id,
    })
    .map_err(napi::Error::from_reason)?;

    let output = build_anthropic_response_from_chat_value(
        &governed.governed_payload,
        options.tool_name_map.as_ref(),
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
