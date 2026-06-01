use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

use crate::hub_req_inbound_context_capture::map_bridge_tools_to_chat;
use crate::shared_chat_output_normalizer::normalize_chat_message_content;
use crate::shared_metadata_semantics::ensure_protocol_state_mut;
use crate::shared_openai_message_normalize::normalize_openai_chat_messages;
use crate::shared_tool_mapping::flatten_chat_tools_for_function_calling;
use crate::shared_tooling::{normalize_standard_chunked_tool_text, normalize_tool_result_value};

const CHAT_PARAMETER_KEYS: [&str; 19] = [
    "model",
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "frequency_penalty",
    "presence_penalty",
    "logit_bias",
    "response_format",
    "parallel_tool_calls",
    "tool_choice",
    "seed",
    "user",
    "metadata",
    "reasoning",
    "reasoning_effort",
    "stop",
    "stop_sequences",
    "stream",
];

const KNOWN_TOP_LEVEL_FIELDS: [&str; 24] = [
    "messages",
    "tools",
    "tool_outputs",
    "model",
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "frequency_penalty",
    "presence_penalty",
    "logit_bias",
    "response_format",
    "parallel_tool_calls",
    "tool_choice",
    "seed",
    "user",
    "metadata",
    "reasoning",
    "reasoning_effort",
    "stop",
    "stop_sequences",
    "stream",
    "stageExpectations",
    "stages",
];

struct NormalizedMessages {
    messages: Vec<Value>,
    system_segments: Vec<String>,
    tool_outputs: Vec<Value>,
    missing_fields: Vec<Value>,
}

fn flatten_system_content(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(flatten_system_content)
            .filter(|value| !value.is_empty())
            .collect::<Vec<String>>()
            .join("\n"),
        Value::Object(obj) => {
            if let Some(Value::String(text)) = obj.get("text") {
                return text.clone();
            }
            if let Some(Value::String(text)) = obj.get("content") {
                return text.clone();
            }
            if let Some(Value::Array(items)) = obj.get("content") {
                return items
                    .iter()
                    .map(flatten_system_content)
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<String>>()
                    .join("\n");
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn push_missing_field(
    missing: &mut Vec<Value>,
    path: String,
    reason: &str,
    original_value: Option<Value>,
) {
    let mut row = Map::new();
    row.insert("path".to_string(), Value::String(path));
    row.insert("reason".to_string(), Value::String(reason.to_string()));
    if let Some(original) = original_value {
        row.insert("originalValue".to_string(), original);
    }
    missing.push(Value::Object(row));
}

fn record_tool_call_issues(
    message: &Map<String, Value>,
    message_index: usize,
    missing: &mut Vec<Value>,
) {
    let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) else {
        return;
    };
    if tool_calls.is_empty() {
        return;
    }
    for (call_index, entry) in tool_calls.iter().enumerate() {
        let Some(entry_obj) = entry.as_object() else {
            push_missing_field(
                missing,
                format!("messages[{message_index}].tool_calls[{call_index}]"),
                "invalid_tool_call_entry",
                Some(entry.clone()),
            );
            continue;
        };
        let function_value = entry_obj.get("function");
        let Some(function_obj) = function_value.and_then(Value::as_object) else {
            push_missing_field(
                missing,
                format!("messages[{message_index}].tool_calls[{call_index}].function"),
                "missing_tool_function",
                Some(function_value.cloned().unwrap_or(Value::Null)),
            );
            continue;
        };
        let fn_name = function_obj
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("");
        if fn_name.trim().is_empty() {
            push_missing_field(
                missing,
                format!("messages[{message_index}].tool_calls[{call_index}].function.name"),
                "missing_tool_name",
                None,
            );
        }
    }
}

fn collect_system_raw_blocks(raw: Option<&Value>) -> Option<Vec<Value>> {
    let Some(raw_array) = raw.and_then(Value::as_array) else {
        return None;
    };
    let mut blocks = Vec::new();
    for entry in raw_array {
        let Some(entry_obj) = entry.as_object() else {
            continue;
        };
        let role = entry_obj
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if role != "system" {
            continue;
        }
        blocks.push(Value::Object(entry_obj.clone()));
    }
    if blocks.is_empty() {
        None
    } else {
        Some(blocks)
    }
}

fn normalize_chat_messages(raw: Option<&Value>) -> NormalizedMessages {
    let mut normalized = NormalizedMessages {
        messages: Vec::new(),
        system_segments: Vec::new(),
        tool_outputs: Vec::new(),
        missing_fields: Vec::new(),
    };

    let Some(raw_value) = raw else {
        push_missing_field(
            &mut normalized.missing_fields,
            "messages".to_string(),
            "absent",
            None,
        );
        return normalized;
    };

    let mut normalized_value = if raw_value.is_array() {
        normalize_openai_chat_messages(raw_value)
    } else {
        raw_value.clone()
    };

    let Some(messages_array) = normalized_value.as_array_mut() else {
        push_missing_field(
            &mut normalized.missing_fields,
            "messages".to_string(),
            "invalid_type",
            Some(raw_value.clone()),
        );
        return normalized;
    };

    for (index, entry) in messages_array.iter_mut().enumerate() {
        let Some(entry_obj) = entry.as_object_mut() else {
            push_missing_field(
                &mut normalized.missing_fields,
                format!("messages[{index}]"),
                "invalid_entry",
                Some(entry.clone()),
            );
            continue;
        };

        let role = match entry_obj.get("role").and_then(Value::as_str) {
            Some(value) => value.to_string(),
            None => {
                push_missing_field(
                    &mut normalized.missing_fields,
                    format!("messages[{index}].role"),
                    "missing_role",
                    None,
                );
                continue;
            }
        };

        if role != "system" && role != "tool" {
            let content_value = entry_obj.get("content").cloned().unwrap_or(Value::Null);
            let normalized_content = normalize_chat_message_content(&content_value);
            let should_overwrite = !matches!(content_value, Value::Array(_));
            if should_overwrite {
                if let Some(content_text) = normalized_content.content_text {
                    entry_obj.insert("content".to_string(), Value::String(content_text));
                }
            }
            if let Some(reasoning_text) = normalized_content.reasoning_text {
                let trimmed = reasoning_text.trim();
                if !trimmed.is_empty() {
                    entry_obj.insert(
                        "reasoning_content".to_string(),
                        Value::String(trimmed.to_string()),
                    );
                }
            }
        }

        record_tool_call_issues(entry_obj, index, &mut normalized.missing_fields);

        if role == "system" {
            let segment = entry_obj
                .get("content")
                .map(flatten_system_content)
                .unwrap_or_default();
            if !segment.trim().is_empty() {
                normalized.system_segments.push(segment);
            }
        } else if role == "tool" {
            let raw_call_id = entry_obj
                .get("tool_call_id")
                .or_else(|| entry_obj.get("call_id"))
                .or_else(|| entry_obj.get("id"));
            let tool_call_id = raw_call_id
                .and_then(Value::as_str)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
            if tool_call_id.is_none() {
                push_missing_field(
                    &mut normalized.missing_fields,
                    format!("messages[{index}].tool_call_id"),
                    "missing_tool_call_id",
                    None,
                );
            } else {
                let name_value = entry_obj
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty());
                let raw_content = entry_obj
                    .get("content")
                    .or_else(|| entry_obj.get("output"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let normalized_content = normalize_standard_chunked_tool_text(
                    normalize_tool_result_value(&raw_content).as_str(),
                );
                let mut output_entry = Map::new();
                output_entry.insert(
                    "tool_call_id".to_string(),
                    Value::String(tool_call_id.clone().unwrap()),
                );
                output_entry.insert(
                    "content".to_string(),
                    Value::String(normalized_content.clone()),
                );
                if let Some(name) = name_value.clone() {
                    output_entry.insert("name".to_string(), Value::String(name));
                }
                normalized.tool_outputs.push(Value::Object(output_entry));
            }
        }

        normalized.messages.push(Value::Object(entry_obj.clone()));
    }

    normalized
}

fn normalize_standalone_tool_outputs(raw: Option<&Value>, missing: &mut Vec<Value>) -> Vec<Value> {
    let Some(raw_array) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    if raw_array.is_empty() {
        return Vec::new();
    }
    let mut outputs = Vec::new();
    for (index, entry) in raw_array.iter().enumerate() {
        let Some(entry_obj) = entry.as_object() else {
            push_missing_field(
                missing,
                format!("tool_outputs[{index}]"),
                "invalid_entry",
                Some(entry.clone()),
            );
            continue;
        };
        let raw_call_id = entry_obj
            .get("tool_call_id")
            .or_else(|| entry_obj.get("call_id"))
            .or_else(|| entry_obj.get("id"));
        let tool_call_id = raw_call_id
            .and_then(Value::as_str)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        if tool_call_id.is_none() {
            push_missing_field(
                missing,
                format!("tool_outputs[{index}].tool_call_id"),
                "missing_tool_call_id",
                None,
            );
            continue;
        }
        let name_value = entry_obj
            .get("name")
            .and_then(Value::as_str)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let raw_content = entry_obj
            .get("content")
            .or_else(|| entry_obj.get("output"))
            .cloned()
            .unwrap_or(Value::Null);
        let normalized = normalize_standard_chunked_tool_text(
            normalize_tool_result_value(&raw_content).as_str(),
        );
        let mut output_entry = Map::new();
        output_entry.insert(
            "tool_call_id".to_string(),
            Value::String(tool_call_id.unwrap()),
        );
        output_entry.insert("content".to_string(), Value::String(normalized));
        if let Some(name) = name_value {
            output_entry.insert("name".to_string(), Value::String(name));
        }
        outputs.push(Value::Object(output_entry));
    }
    outputs
}

fn normalize_tools(raw: Option<&Value>, missing: &mut Vec<Value>) -> Option<Vec<Value>> {
    let Some(raw_array) = raw.and_then(Value::as_array) else {
        return None;
    };
    if raw_array.is_empty() {
        return None;
    }
    let mapped = map_bridge_tools_to_chat(raw_array);
    if mapped.is_empty() {
        for (index, entry) in raw_array.iter().enumerate() {
            push_missing_field(
                missing,
                format!("tools[{index}]"),
                "invalid_entry",
                Some(entry.clone()),
            );
        }
    }
    if mapped.is_empty() {
        None
    } else {
        Some(mapped)
    }
}

fn extract_parameters(payload: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut params = Map::new();
    for key in CHAT_PARAMETER_KEYS {
        if let Some(value) = payload.get(key) {
            params.insert(key.to_string(), value.clone());
        }
    }
    if params.is_empty() {
        None
    } else {
        Some(params)
    }
}

fn collect_extra_fields(payload: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut extras = Map::new();
    for (key, value) in payload {
        if KNOWN_TOP_LEVEL_FIELDS.iter().any(|entry| entry == key) {
            continue;
        }
        extras.insert(key.clone(), value.clone());
    }
    if extras.is_empty() {
        None
    } else {
        Some(extras)
    }
}

fn extract_openai_extra_fields_from_semantics(
    semantics: Option<&Value>,
) -> Option<Map<String, Value>> {
    let Some(semantics_obj) = semantics.and_then(Value::as_object) else {
        return None;
    };
    let provider_extras = semantics_obj.get("providerExtras")?.as_object()?;
    let openai_chat = provider_extras.get("openaiChat")?.as_object()?;
    let extra_fields = openai_chat.get("extraFields")?.as_object()?;
    if extra_fields.is_empty() {
        None
    } else {
        Some(extra_fields.clone())
    }
}

fn has_explicit_empty_tools_semantics(semantics: Option<&Value>) -> bool {
    let Some(semantics_obj) = semantics.and_then(Value::as_object) else {
        return false;
    };
    let Some(tools_obj) = semantics_obj.get("tools").and_then(Value::as_object) else {
        return false;
    };
    matches!(tools_obj.get("explicitEmpty"), Some(Value::Bool(true)))
}

fn build_openai_semantics(
    system_segments: &[String],
    extra_fields: Option<Map<String, Value>>,
    explicit_empty_tools: bool,
) -> Option<Map<String, Value>> {
    let mut semantics = Map::new();
    if !system_segments.is_empty() {
        semantics.insert(
            "system".to_string(),
            Value::Object({
                let mut system = Map::new();
                system.insert(
                    "textBlocks".to_string(),
                    Value::Array(
                        system_segments
                            .iter()
                            .map(|s| Value::String(s.clone()))
                            .collect(),
                    ),
                );
                system
            }),
        );
    }
    if let Some(extra_fields) = extra_fields {
        if !extra_fields.is_empty() {
            let mut openai_chat = Map::new();
            openai_chat.insert("extraFields".to_string(), Value::Object(extra_fields));
            let mut provider_extras = Map::new();
            provider_extras.insert("openaiChat".to_string(), Value::Object(openai_chat));
            semantics.insert("providerExtras".to_string(), Value::Object(provider_extras));
        }
    }
    if explicit_empty_tools {
        let mut tools = Map::new();
        tools.insert("explicitEmpty".to_string(), Value::Bool(true));
        semantics.insert("tools".to_string(), Value::Object(tools));
    }
    if semantics.is_empty() {
        None
    } else {
        Some(semantics)
    }
}

fn map_openai_chat_to_chat(payload: Value, context: Value) -> Result<Value, String> {
    let payload_obj = payload.as_object().cloned().unwrap_or_default();
    let messages_raw = payload_obj.get("messages");
    let tools_raw = payload_obj.get("tools");
    let tool_outputs_raw = payload_obj.get("tool_outputs");

    let mut normalized = normalize_chat_messages(messages_raw);
    let top_level_outputs =
        normalize_standalone_tool_outputs(tool_outputs_raw, &mut normalized.missing_fields);
    if !top_level_outputs.is_empty() {
        let mut existing: Vec<String> = normalized
            .tool_outputs
            .iter()
            .filter_map(|entry| {
                entry
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .map(|v| v.to_string())
            })
            .collect();
        for entry in top_level_outputs {
            let call_id = entry
                .get("tool_call_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if call_id.is_empty() || existing.iter().any(|id| id == &call_id) {
                continue;
            }
            existing.push(call_id);
            normalized.tool_outputs.push(entry);
        }
    }

    let explicit_empty_tools = tools_raw
        .and_then(Value::as_array)
        .map(|arr| arr.is_empty())
        .unwrap_or(false);

    let extra_fields = collect_extra_fields(&payload_obj);
    let semantics = build_openai_semantics(
        &normalized.system_segments,
        extra_fields,
        explicit_empty_tools,
    );

    let normalized_tools = normalize_tools(tools_raw, &mut normalized.missing_fields);

    let mut metadata = Map::new();
    let context_value = if context.is_object() {
        context
    } else {
        Value::Object(Map::new())
    };
    metadata.insert("context".to_string(), context_value);
    if let Some(raw_system_blocks) = collect_system_raw_blocks(messages_raw) {
        let protocol_state = ensure_protocol_state_mut(&mut metadata, "openai");
        protocol_state.insert(
            "systemMessages".to_string(),
            Value::Array(raw_system_blocks),
        );
    }

    if !normalized.missing_fields.is_empty() {
        metadata.insert(
            "missingFields".to_string(),
            Value::Array(normalized.missing_fields.clone()),
        );
    }

    let mut output = Map::new();
    output.insert("messages".to_string(), Value::Array(normalized.messages));
    if let Some(tools) = normalized_tools {
        if !tools.is_empty() {
            output.insert("tools".to_string(), Value::Array(tools));
        }
    }
    if !normalized.tool_outputs.is_empty() {
        output.insert(
            "toolOutputs".to_string(),
            Value::Array(normalized.tool_outputs),
        );
    }
    if let Some(params) = extract_parameters(&payload_obj) {
        output.insert("parameters".to_string(), Value::Object(params));
    }
    if let Some(semantics) = semantics {
        output.insert("semantics".to_string(), Value::Object(semantics));
    }
    output.insert("metadata".to_string(), Value::Object(metadata));
    Ok(Value::Object(output))
}

fn map_openai_chat_from_chat(chat: Value, context: Value) -> Result<Value, String> {
    let Some(chat_obj) = chat.as_object() else {
        return Err("Chat envelope must be an object".to_string());
    };
    let messages = chat_obj
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tools = chat_obj.get("tools").and_then(Value::as_array).cloned();
    let parameters = chat_obj
        .get("parameters")
        .and_then(Value::as_object)
        .cloned();
    let semantics = chat_obj.get("semantics");

    let should_emit_empty_tools = has_explicit_empty_tools_semantics(semantics);

    let mut payload = Map::new();
    payload.insert("messages".to_string(), Value::Array(messages));
    if let Some(tools) = tools {
        let flattened_tools =
            flatten_chat_tools_for_function_calling(tools.as_slice(), "responses");
        payload.insert(
            "tools".to_string(),
            Value::Array(if flattened_tools.is_empty() {
                tools
            } else {
                flattened_tools
            }),
        );
    } else if should_emit_empty_tools {
        payload.insert("tools".to_string(), Value::Array(Vec::new()));
    }
    if let Some(params) = parameters {
        for (key, value) in params {
            payload.insert(key, value);
        }
    }

    if let Some(extra_fields) = extract_openai_extra_fields_from_semantics(semantics) {
        for (key, value) in extra_fields {
            if !payload.contains_key(&key) {
                payload.insert(key, value);
            }
        }
    }

    if !payload.contains_key("max_tokens") {
        if let Some(Value::Number(num)) = payload.get("max_output_tokens") {
            payload.insert("max_tokens".to_string(), Value::Number(num.clone()));
            payload.remove("max_output_tokens");
        }
    }

    let mut output = Map::new();
    output.insert(
        "protocol".to_string(),
        Value::String("openai-chat".to_string()),
    );
    output.insert(
        "direction".to_string(),
        Value::String("response".to_string()),
    );
    output.insert("payload".to_string(), Value::Object(payload));
    let mut meta = Map::new();
    let context_value = if context.is_object() {
        context
    } else {
        Value::Object(Map::new())
    };
    meta.insert("context".to_string(), context_value);
    output.insert("meta".to_string(), Value::Object(meta));
    Ok(Value::Object(output))
}

#[napi]
pub fn map_openai_chat_to_chat_json(
    payload_json: String,
    context_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output =
        map_openai_chat_to_chat(payload, context).map_err(|e| napi::Error::from_reason(e))?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn map_openai_chat_from_chat_json(
    chat_json: String,
    context_json: String,
) -> NapiResult<String> {
    let chat: Value =
        serde_json::from_str(&chat_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output =
        map_openai_chat_from_chat(chat, context).map_err(|e| napi::Error::from_reason(e))?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::map_openai_chat_to_chat;
    use crate::shared_tooling::normalize_tool_result_value;
    use serde_json::{json, Value};

    #[test]
    fn normalize_tool_content_preserves_empty_as_empty_string() {
        assert_eq!(normalize_tool_result_value(&Value::Null), "");
        assert_eq!(
            normalize_tool_result_value(&Value::String("   ".to_string())),
            ""
        );
    }

    #[test]
    fn normalize_tool_content_unwraps_chunked_exec_transcript_shape() {
        let content = Value::String(
            "Chunk ID: abc\nWall time: 0.1s\nProcess exited with code 1\nOriginal token count: 12\nOutput:\nSyntaxError: invalid syntax\n"
                .to_string(),
        );
        assert_eq!(
            normalize_tool_result_value(&content),
            "SyntaxError: invalid syntax"
        );
    }

    #[test]
    fn normalize_tool_content_strips_terminal_right_gutter_noise() {
        let content = Value::String(
            "Chunk ID: abc\nWall time: 0.1s\nProcess exited with code 1\nOriginal token count: 12\nOutput:\n  File \"<stdin>\", line 21                                                    │··········································\n    SyntaxError: invalid syntax                                               │··········································\n"
                .to_string(),
        );
        let normalized = normalize_tool_result_value(&content);
        assert!(normalized.contains("File \"<stdin>\", line 21"));
        assert!(normalized.contains("SyntaxError: invalid syntax"));
        assert!(!normalized.contains("│····"));
        assert!(!normalized.contains("Original token count"));
    }

    #[test]
    fn map_openai_chat_to_chat_keeps_empty_tool_output_for_next_round() {
        let payload = json!({
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_exec_1",
                  "type": "function",
                  "function": { "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                }
              ]
            },
            {
              "role": "tool",
              "tool_call_id": "call_exec_1",
              "name": "exec_command",
              "content": ""
            }
          ],
          "model": "test-model"
        });
        let mapped = map_openai_chat_to_chat(payload, json!({})).expect("map success");
        let tool_outputs = mapped
            .get("toolOutputs")
            .and_then(Value::as_array)
            .expect("tool outputs");
        assert_eq!(tool_outputs.len(), 1);
        assert_eq!(tool_outputs[0]["tool_call_id"], "call_exec_1");
        assert_eq!(tool_outputs[0]["content"], "");
    }

    #[test]
    fn map_openai_chat_to_chat_preserves_reasoning_parameters() {
        let payload = json!({
          "messages": [
            { "role": "user", "content": "hello" }
          ],
          "model": "test-model",
          "reasoning": { "effort": "high", "summary": "detailed" },
          "reasoning_effort": "high"
        });
        let mapped = map_openai_chat_to_chat(payload, json!({})).expect("map success");
        let params = mapped
            .get("parameters")
            .and_then(Value::as_object)
            .expect("parameters");
        assert_eq!(
            params.get("reasoning"),
            Some(&json!({ "effort": "high", "summary": "detailed" }))
        );
        assert_eq!(params.get("reasoning_effort"), Some(&json!("high")));
    }
}
