use napi::bindgen_prelude::Result as NapiResult;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::hub_reasoning_tool_normalizer::{
    build_message_reasoning_value, normalize_message_reasoning_ssot, project_message_reasoning_text,
};
use crate::hub_resp_outbound_client_semantics::build_anthropic_response_from_chat_value;
use crate::resp_process_stage1_tool_governance::{govern_response, ToolGovernanceInput};
use crate::shared_chat_output_normalizer::normalize_chat_message_content;
use crate::shared_tool_result_text_normalizer::normalize_tool_result_text;

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

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn has_visible_text(value: &str) -> bool {
    !value.trim().is_empty()
}

fn is_likely_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("ftp://")
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
        Value::Array(items) => items
            .iter()
            .map(flatten_text)
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<String>>()
            .join(""),
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

fn map_chat_tools_to_anthropic_tools(raw_tools: Option<&Value>) -> Option<Value> {
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
        let input_schema = function_row
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
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

fn collect_openai_chat_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(collect_openai_chat_text)
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<String>>()
            .join(""),
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
        let tool_calls = row
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for tool_call in tool_calls {
            let Some(tool_row) = tool_call.as_object() else {
                continue;
            };
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
                let id = read_trimmed_string(tool_row.get("id"))
                    .unwrap_or_else(|| format!("call_{}", index));
                let input = function_row
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
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
            let combined_text = text_parts.join("");
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

    let governed = govern_response(ToolGovernanceInput {
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
