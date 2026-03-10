use napi::bindgen_prelude::Result as NapiResult;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::hub_resp_outbound_client_semantics::build_anthropic_response_from_chat_value;
use crate::resp_process_stage1_tool_governance::{govern_response, ToolGovernanceInput};
use crate::shared_chat_output_normalizer::normalize_chat_message_content;

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

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
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
            if let Some(content) = row.get("content") {
                return flatten_text(content);
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn normalize_tool_result_content(block: &Map<String, Value>) -> String {
    match block.get("content") {
        Some(Value::String(text)) => text.clone(),
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
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
        None => String::new(),
    }
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

fn append_system_messages(raw_system: Option<&Value>, messages: &mut Vec<Value>) {
    let blocks: Vec<Value> = match raw_system {
        Some(Value::Array(items)) => items.clone(),
        Some(value) if !value.is_null() => vec![value.clone()],
        _ => Vec::new(),
    };

    for block in blocks {
        let text = flatten_text(&block).trim().to_string();
        if text.is_empty() {
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
            if text.is_empty() {
                continue;
            }
            let normalized = normalize_chat_message_content(&Value::String(text.clone()));
            let mut message = Map::<String, Value>::new();
            message.insert("role".to_string(), Value::String(role));
            message.insert(
                "content".to_string(),
                Value::String(normalized.content_text.unwrap_or(text)),
            );
            if let Some(reasoning) = normalized.reasoning_text.filter(|v| !v.trim().is_empty()) {
                message.insert("reasoning_content".to_string(), Value::String(reasoning));
            }
            out.push(Value::Object(message));
            continue;
        };

        let mut text_parts: Vec<String> = Vec::new();
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
                    let text = flatten_text(block).trim().to_string();
                    if !text.is_empty() {
                        text_parts.push(text);
                    }
                }
                "thinking" | "reasoning" => {
                    let text = flatten_text(block).trim().to_string();
                    if !text.is_empty() {
                        reasoning_parts.push(text);
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

        if !text_parts.is_empty() || !tool_calls.is_empty() || !reasoning_parts.is_empty() {
            let combined_text = text_parts.join("\n");
            let normalized = normalize_chat_message_content(&Value::String(combined_text.clone()));
            let mut message = Map::<String, Value>::new();
            message.insert("role".to_string(), Value::String(role));
            message.insert(
                "content".to_string(),
                Value::String(normalized.content_text.unwrap_or(combined_text)),
            );
            if !tool_calls.is_empty() {
                message.insert("tool_calls".to_string(), Value::Array(tool_calls));
            }
            let mut merged_reasoning = reasoning_parts;
            if let Some(reasoning) = normalized.reasoning_text.filter(|v| !v.trim().is_empty()) {
                merged_reasoning.push(reasoning);
            }
            if !merged_reasoning.is_empty() {
                message.insert(
                    "reasoning_content".to_string(),
                    Value::String(merged_reasoning.join("\n")),
                );
            }
            out.push(Value::Object(message));
        }

        out.extend(tool_results);
    }

    out
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
