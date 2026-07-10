use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::req_outbound_stage3_compat::responses::apply_responses_instructions_to_input;

const MAX_PAYLOAD_SIZE_BYTES: usize = 50 * 1024 * 1024; // 50MB limit

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatBuildInput {
    pub format_envelope: Value,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatBuildOutput {
    pub payload: Value,
}

fn validate_payload_size(payload: &Value) -> Result<(), String> {
    let payload_str = match serde_json::to_string(payload) {
        Ok(s) => s,
        Err(e) => return Err(format!("Failed to serialize payload for size check: {}", e)),
    };

    if payload_str.len() > MAX_PAYLOAD_SIZE_BYTES {
        return Err(format!(
            "Payload size {} exceeds maximum allowed {} bytes",
            payload_str.len(),
            MAX_PAYLOAD_SIZE_BYTES
        ));
    }

    Ok(())
}

fn strip_private_fields(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (key, val) in map {
                // Strip private/internal control fields from provider outbound payloads.
                if !is_provider_outbound_metadata_key(key) && !key.starts_with('_') {
                    new_map.insert(key.clone(), strip_private_fields(val));
                }
            }
            Value::Object(new_map)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(|v| strip_private_fields(v)).collect()),
        _ => value.clone(),
    }
}

fn is_provider_outbound_metadata_key(key: &str) -> bool {
    key.to_ascii_lowercase().contains("metadata")
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
        Value::String(text) => Value::Array(vec![serde_json::json!({
            "type": text_type,
            "text": text
        })]),
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

fn read_tool_call_id_style(payload: &Value, context: Option<&Value>) -> Option<String> {
    let metadata_style = payload
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("toolCallIdStyle"))
        .and_then(Value::as_str);
    let root_style = payload.get("toolCallIdStyle").and_then(Value::as_str);
    let context_style = context.and_then(Value::as_object).and_then(|row| {
        row.get("toolCallIdStyle")
            .and_then(Value::as_str)
            .or_else(|| {
                row.get("metadata")
                    .and_then(Value::as_object)
                    .and_then(|metadata| metadata.get("toolCallIdStyle"))
                    .and_then(Value::as_str)
            })
    });
    root_style
        .or(metadata_style)
        .or(context_style)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

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

fn normalize_response_tool_ids(value: &mut Value, style: Option<&str>) {
    let Some(style) = style else {
        return;
    };
    let Some(items) = value.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    for item in items {
        let Some(row) = item.as_object_mut() else {
            continue;
        };
        let item_type = row.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type != "function_call" && item_type != "function_call_output" {
            continue;
        }
        let raw_call_id = row
            .get("call_id")
            .or_else(|| row.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if raw_call_id.is_empty() {
            continue;
        }
        match style {
            "fc" => {
                let call_id = if raw_call_id.starts_with("call_") && raw_call_id.len() <= 64 {
                    raw_call_id.clone()
                } else {
                    compact_tool_id("call_", &raw_call_id)
                };
                let fc_id = if call_id.starts_with("call_") {
                    compact_tool_id("fc_", call_id.trim_start_matches("call_"))
                } else {
                    compact_tool_id("fc_", &call_id)
                };
                row.insert("call_id".to_string(), Value::String(call_id));
                row.insert("id".to_string(), Value::String(fc_id));
            }
            "preserve" => {
                let preserved = if raw_call_id.len() <= 64 {
                    raw_call_id
                } else {
                    compact_tool_id("call_", &raw_call_id)
                };
                row.insert("call_id".to_string(), Value::String(preserved.clone()));
                row.insert("id".to_string(), Value::String(preserved));
            }
            _ => {}
        }
    }
}

fn compact_oversized_response_input_ids(value: &mut Value) {
    let Some(items) = value.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    for item in items {
        let Some(row) = item.as_object_mut() else {
            continue;
        };
        let Some(id) = row
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| id.len() > 64)
            .map(str::to_string)
        else {
            continue;
        };
        let prefix = if id.starts_with("msg_") {
            "msg_"
        } else {
            "item_"
        };
        row.insert(
            "id".to_string(),
            Value::String(compact_tool_id(prefix, &id)),
        );
    }
}

fn merge_response_request_parameters(
    request: &mut Value,
    payload: &Value,
    context: Option<&Value>,
) {
    const ALLOWED_KEYS: &[&str] = &[
        "temperature",
        "top_p",
        "max_output_tokens",
        "seed",
        "logit_bias",
        "user",
        "parallel_tool_calls",
        "tool_choice",
        "response_format",
        "service_tier",
        "truncation",
        "include",
        "store",
        "prompt_cache_key",
        "reasoning",
        "stream",
    ];
    let Some(request_obj) = request.as_object_mut() else {
        return;
    };
    let mut source = Map::new();
    for candidate in [
        context
            .and_then(Value::as_object)
            .and_then(|row| row.get("parameters")),
        payload.get("parameters"),
    ] {
        if let Some(parameters) = candidate.and_then(Value::as_object) {
            for (key, value) in parameters {
                source.insert(key.clone(), value.clone());
            }
        }
    }
    if !source.contains_key("max_output_tokens") {
        if let Some(value) = source.get("max_tokens").cloned() {
            source.insert("max_output_tokens".to_string(), value);
        }
    }
    for key in ALLOWED_KEYS {
        if request_obj.contains_key(*key) {
            continue;
        }
        if let Some(value) = source.get(*key).cloned() {
            request_obj.insert((*key).to_string(), value);
        }
    }
    request_obj.remove("parameters");
}

fn merge_context_system_instruction(request: &mut Value, payload: &Value, context: Option<&Value>) {
    let Some(request_obj) = request.as_object_mut() else {
        return;
    };
    if request_obj.contains_key("instructions") {
        return;
    }
    let Some(instructions) = payload
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            context
                .and_then(Value::as_object)
                .and_then(|row| row.get("systemInstruction"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
    else {
        return;
    };
    request_obj.insert(
        "instructions".to_string(),
        Value::String(instructions.to_string()),
    );
}

fn merge_bridge_history_input(request: &mut Value, extras: Option<&Value>) {
    let Some(history_input) = extras
        .and_then(Value::as_object)
        .and_then(|row| row.get("bridgeHistory"))
        .and_then(Value::as_object)
        .and_then(|history| history.get("input"))
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    else {
        return;
    };
    let Some(request_obj) = request.as_object_mut() else {
        return;
    };
    let current_input = request_obj
        .remove("input")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let mut merged = history_input.clone();
    merged.extend(current_input);
    request_obj.insert("input".to_string(), Value::Array(merged));
}

fn build_responses_input_from_chat_messages(messages: &[Value]) -> Value {
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
    let Some(messages) = normalized.get_mut("messages").and_then(Value::as_array_mut) else {
        return normalized;
    };
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
    normalized
}

fn build_openai_responses_request(format_envelope: &Value) -> Result<Value, String> {
    let mut payload = format_envelope
        .get("payload")
        .ok_or("Missing 'payload' field in format envelope")?
        .clone();

    if payload.get("input").is_none() {
        if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
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
            ] {
                if let Some(value) = payload.get(key) {
                    responses_payload.insert(key.to_string(), value.clone());
                }
            }
            payload = Value::Object(responses_payload);
        }
    }

    if let Some(obj) = payload.as_object_mut() {
        apply_responses_instructions_to_input(obj);
    }

    // Ensure required fields for OpenAI Responses format
    if let Some(obj) = payload.as_object_mut() {
        // Remove any private fields
        let stripped = strip_private_fields(&Value::Object(obj.clone()));
        *obj = stripped.as_object().unwrap().clone();
    }

    Ok(payload)
}

fn build_openai_chat_request(format_envelope: &Value) -> Result<Value, String> {
    let mut payload = format_envelope
        .get("payload")
        .ok_or("Missing 'payload' field in format envelope")?
        .clone();
    if payload.get("input").is_some() {
        let converted = crate::responses_openai_codec::run_responses_openai_request_codec_json(
            payload.to_string(),
            None,
        )
        .map_err(|error| error.to_string())?;
        let converted_value: Value =
            serde_json::from_str(&converted).map_err(|error| error.to_string())?;
        return converted_value
            .get("request")
            .cloned()
            .ok_or_else(|| "responses-openai request codec returned no request".to_string());
    }
    if payload.get("messages").is_some() {
        return Ok(normalize_openai_chat_messages_payload(&payload));
    }
    Ok(strip_private_fields(&payload))
}

fn build_anthropic_messages_request(format_envelope: &Value) -> Result<Value, String> {
    let payload = format_envelope
        .get("payload")
        .ok_or("Missing 'payload' field in format envelope")?
        .clone();
    let source_format = format_envelope
        .get("format")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let source_instructions = payload
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if payload.get("input").is_some() {
        let chat = crate::responses_openai_codec::run_responses_openai_request_codec_json(
            payload.to_string(),
            None,
        )
        .map_err(|error| error.to_string())?;
        let chat_value: Value = serde_json::from_str(&chat).map_err(|error| error.to_string())?;
        let chat_request = chat_value
            .get("request")
            .cloned()
            .ok_or_else(|| "responses-openai request codec returned no request".to_string())?;
        let anthropic = crate::anthropic_openai_codec::build_anthropic_from_openai_chat_json(
            chat_request.to_string(),
            None,
        )
        .map_err(|error| error.to_string())?;
        let mut anthropic_value: Value =
            serde_json::from_str(&anthropic).map_err(|error| error.to_string())?;
        apply_anthropic_system_from_instructions(
            &mut anthropic_value,
            source_instructions.as_deref(),
        );
        return Ok(strip_private_fields(&anthropic_value));
    }
    if source_format != "anthropic-messages" && payload.get("messages").is_some() {
        let anthropic = crate::anthropic_openai_codec::build_anthropic_from_openai_chat_json(
            payload.to_string(),
            None,
        )
        .map_err(|error| error.to_string())?;
        let mut anthropic_value: Value =
            serde_json::from_str(&anthropic).map_err(|error| error.to_string())?;
        apply_anthropic_system_from_instructions(
            &mut anthropic_value,
            source_instructions.as_deref(),
        );
        return Ok(strip_private_fields(&anthropic_value));
    }
    Ok(strip_private_fields(&payload))
}

fn apply_anthropic_system_from_instructions(payload: &mut Value, instructions: Option<&str>) {
    let Some(instructions) = instructions
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let Some(obj) = payload.as_object_mut() else {
        return;
    };
    if obj
        .get("system")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return;
    }
    obj.insert(
        "system".to_string(),
        Value::String(instructions.to_string()),
    );
}

fn build_gemini_chat_request(format_envelope: &Value) -> Result<Value, String> {
    let mut payload = format_envelope
        .get("payload")
        .ok_or("Missing 'payload' field in format envelope")?
        .clone();

    if let Some(obj) = payload.as_object_mut() {
        let stripped = strip_private_fields(&Value::Object(obj.clone()));
        *obj = stripped.as_object().unwrap().clone();
    }

    Ok(payload)
}

pub fn build_format_request(input: FormatBuildInput) -> Result<FormatBuildOutput, String> {
    let payload = match input.protocol.as_str() {
        "openai-chat" => build_openai_chat_request(&input.format_envelope)?,
        "openai-responses" => build_openai_responses_request(&input.format_envelope)?,
        "anthropic-messages" => build_anthropic_messages_request(&input.format_envelope)?,
        "gemini-chat" => build_gemini_chat_request(&input.format_envelope)?,
        _ => {
            // Default fallback - just strip private fields
            let payload = input
                .format_envelope
                .get("payload")
                .ok_or("Missing 'payload' field in format envelope")?;
            strip_private_fields(payload)
        }
    };

    validate_payload_size(&payload)?;

    Ok(FormatBuildOutput { payload })
}

pub fn build_responses_request_from_chat_json(input_json: String) -> napi::Result<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let payload = input
        .as_object()
        .and_then(|row| row.get("payload"))
        .cloned()
        .ok_or_else(|| napi::Error::from_reason("Missing payload".to_string()))?;
    let context = input
        .as_object()
        .and_then(|row| row.get("context"))
        .cloned();
    let extras = input.as_object().and_then(|row| row.get("extras")).cloned();
    let output = build_format_request(FormatBuildInput {
        format_envelope: serde_json::json!({
            "format": "openai-chat",
            "version": "v1",
            "payload": payload
        }),
        protocol: "openai-responses".to_string(),
    })
    .map_err(napi::Error::from_reason)?;
    let mut request = output.payload;
    merge_bridge_history_input(&mut request, extras.as_ref());
    merge_context_system_instruction(&mut request, &payload, context.as_ref());
    merge_response_request_parameters(&mut request, &payload, context.as_ref());
    let tool_call_id_style = read_tool_call_id_style(&payload, context.as_ref());
    normalize_response_tool_ids(&mut request, tool_call_id_style.as_deref());
    compact_oversized_response_input_ids(&mut request);
    serde_json::to_string(&serde_json::json!({
        "request": request,
        "originalSystemMessages": []
    }))
    .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_openai_responses_request() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "gpt-4",
                    "messages": [{"role": "user", "content": "hello"}]
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert!(result.payload.get("model").is_some());
        assert_eq!(result.payload["model"], "gpt-4");
        assert!(result.payload.get("messages").is_none());
        assert_eq!(result.payload["input"][0]["type"], "message");
        assert_eq!(result.payload["input"][0]["role"], "user");
        assert_eq!(
            result.payload["input"][0]["content"][0]["type"],
            "input_text"
        );
        assert_eq!(result.payload["input"][0]["content"][0]["text"], "hello");
    }

    #[test]
    fn test_build_openai_responses_request_encodes_assistant_history_as_output_text() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-chat",
                "version": "v1",
                "payload": {
                    "model": "gpt-4",
                    "messages": [
                        {"role": "user", "content": "start"},
                        {"role": "assistant", "content": "assistant history"},
                        {"role": "assistant", "content": [{"type": "input_text", "text": "legacy assistant history"}]}
                    ]
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert_eq!(
            result.payload["input"][0]["content"][0]["type"],
            "input_text"
        );
        assert_eq!(result.payload["input"][1]["role"], "assistant");
        assert_eq!(
            result.payload["input"][1]["content"][0]["type"],
            "output_text"
        );
        assert_eq!(result.payload["input"][2]["role"], "assistant");
        assert_eq!(
            result.payload["input"][2]["content"][0]["type"],
            "output_text"
        );
    }

    #[test]
    fn test_build_openai_responses_request_normalizes_chat_image_url_parts() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "gpt-test",
                    "messages": [{
                        "role": "user",
                        "content": [
                            { "type": "text", "text": "describe" },
                            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } }
                        ]
                    }]
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        let content = result.payload["input"][0]["content"]
            .as_array()
            .expect("responses content");
        assert_eq!(content[0]["type"], "input_text");
        assert_eq!(content[0]["text"], "describe");
        assert_eq!(content[1]["type"], "input_image");
        assert_eq!(content[1]["image_url"], "data:image/png;base64,AAA");
    }

    #[test]
    fn test_build_openai_responses_request_preserves_tool_semantics_from_messages() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "gpt-4",
                    "messages": [
                        {
                            "role": "assistant",
                            "content": "",
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
                        }
                    ]
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        let input_items = result.payload["input"].as_array().expect("responses input");
        assert_eq!(input_items[0]["type"], "function_call");
        assert_eq!(input_items[0]["call_id"], "call_1");
        assert_eq!(input_items[0]["name"], "exec_command");
        assert_eq!(input_items[0]["arguments"], "{\"cmd\":\"pwd\"}");
        assert_eq!(input_items[1]["type"], "function_call_output");
        assert_eq!(input_items[1]["call_id"], "call_1");
        assert_eq!(input_items[1]["output"], "ok");
    }

    #[test]
    fn test_build_responses_request_from_chat_json_wraps_rust_owned_request_builder() {
        let result = build_responses_request_from_chat_json(
            serde_json::json!({
                "payload": {
                    "model": "gpt-4",
                    "messages": [
                        { "role": "user", "content": "hello" }
                    ],
                    "metadata": { "providerKey": "must-not-leak" }
                },
                "context": { "ignored": true },
                "extras": { "ignored": true }
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["request"]["model"], "gpt-4");
        assert_eq!(parsed["request"]["input"][0]["type"], "message");
        assert_eq!(parsed["request"]["input"][0]["role"], "user");
        assert_eq!(
            parsed["request"]["input"][0]["content"][0]["type"],
            "input_text"
        );
        assert_eq!(parsed["request"]["input"][0]["content"][0]["text"], "hello");
        assert!(parsed["request"].get("metadata").is_none());
        assert!(parsed["originalSystemMessages"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_build_responses_request_from_chat_json_flattens_chat_parameters() {
        let result = build_responses_request_from_chat_json(
            serde_json::json!({
                "payload": {
                    "model": "gpt-test",
                    "messages": [{ "role": "user", "content": "hi" }],
                    "parameters": {
                        "temperature": 0.2,
                        "max_tokens": 123
                    }
                },
                "context": { "stream": false }
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["request"]["temperature"], 0.2);
        assert_eq!(parsed["request"]["max_output_tokens"], 123);
        assert!(parsed["request"].get("parameters").is_none());
    }

    #[test]
    fn test_build_responses_request_from_chat_json_restores_context_system_instruction() {
        let result = build_responses_request_from_chat_json(
            serde_json::json!({
                "payload": {
                    "model": "gpt-test",
                    "messages": [{ "role": "user", "content": "hi" }]
                },
                "context": {
                    "systemInstruction": "You are a helpful assistant that responds in Chinese."
                }
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            parsed["request"]["instructions"],
            "You are a helpful assistant that responds in Chinese."
        );
    }

    #[test]
    fn test_build_responses_request_from_chat_json_preserves_payload_instructions() {
        let result = build_responses_request_from_chat_json(
            serde_json::json!({
                "payload": {
                    "model": "gpt-test",
                    "instructions": "Use Chinese.",
                    "messages": [{ "role": "user", "content": "hi" }]
                },
                "context": {
                    "systemInstruction": "Use English."
                }
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["request"]["instructions"], "Use Chinese.");
    }

    #[test]
    fn test_build_responses_request_from_chat_json_prefers_chat_tool_parameters() {
        let result = build_responses_request_from_chat_json(
            serde_json::json!({
                "payload": {
                    "model": "gpt-test",
                    "messages": [{ "role": "user", "content": "hi" }],
                    "tools": [{
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "parameters": { "type": "object" }
                        }
                    }],
                    "parameters": {
                        "tool_choice": "required",
                        "parallel_tool_calls": true
                    }
                },
                "context": {
                    "parameters": {
                        "tool_choice": "none",
                        "parallel_tool_calls": false
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["request"]["tool_choice"], "required");
        assert_eq!(parsed["request"]["parallel_tool_calls"], true);
    }

    #[test]
    fn test_build_responses_request_from_chat_json_applies_fc_tool_id_style() {
        let long_raw_id = format!("functions.call_{}:40", "a".repeat(240));
        let result = build_responses_request_from_chat_json(
            serde_json::json!({
                "payload": {
                    "model": "gpt-test",
                    "messages": [
                        {
                            "role": "assistant",
                            "content": null,
                            "tool_calls": [{
                                "id": long_raw_id,
                                "type": "function",
                                "function": {
                                    "name": "exec_command",
                                    "arguments": "{\"cmd\":\"pwd\"}"
                                }
                            }]
                        },
                        {
                            "role": "tool",
                            "tool_call_id": long_raw_id,
                            "content": "ok"
                        }
                    ],
                    "metadata": { "toolCallIdStyle": "fc" }
                }
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        let items = parsed["request"]["input"].as_array().unwrap();
        assert_eq!(items[0]["type"], "function_call");
        assert!(items[0]["call_id"].as_str().unwrap().starts_with("call_"));
        assert!(items[0]["id"].as_str().unwrap().starts_with("fc_"));
        assert!(items[0]["call_id"].as_str().unwrap().len() <= 64);
        assert!(items[0]["id"].as_str().unwrap().len() <= 64);
        assert_eq!(items[1]["call_id"], items[0]["call_id"]);
        assert_eq!(items[1]["id"], items[0]["id"]);
    }

    #[test]
    fn test_build_responses_request_from_chat_json_preserves_tool_id_style() {
        let result = build_responses_request_from_chat_json(
            serde_json::json!({
                "payload": {
                    "model": "gpt-test",
                    "messages": [{
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_keep_me",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{}"
                            }
                        }]
                    }],
                    "metadata": { "toolCallIdStyle": "preserve" }
                },
                "context": {
                    "toolCallIdStyle": "fc"
                }
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        let item = &parsed["request"]["input"][0];
        assert_eq!(item["id"], "call_keep_me");
        assert_eq!(item["call_id"], "call_keep_me");
    }

    #[test]
    fn test_build_responses_request_from_chat_json_merges_bridge_history_input() {
        let result = build_responses_request_from_chat_json(
            serde_json::json!({
                "payload": {
                    "model": "gpt-test",
                    "messages": [{ "role": "user", "content": "continue" }]
                },
                "extras": {
                    "bridgeHistory": {
                        "input": [{
                            "type": "message",
                            "id": format!("msg_{}", "x".repeat(240)),
                            "role": "assistant",
                            "content": [{ "type": "output_text", "text": "previous step" }]
                        }],
                        "originalSystemMessages": []
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        let items = parsed["request"]["input"].as_array().unwrap();
        assert!(items[0]["id"].as_str().unwrap().starts_with("msg_"));
        assert!(items[0]["id"].as_str().unwrap().len() <= 64);
        assert_eq!(items[0]["content"][0]["text"], "previous step");
        assert_eq!(items[1]["role"], "user");
    }

    #[test]
    fn test_build_openai_responses_request_lifts_instructions_into_system_input() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "gpt-5.3-codex",
                    "instructions": "<rcc_stop_schema>\nstopreason 取值：0=finished，1=blocked，2=continue_needed",
                    "input": [
                        {
                            "type": "message",
                            "role": "user",
                            "content": [
                                {
                                    "type": "input_text",
                                    "text": "hello"
                                }
                            ]
                        }
                    ]
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        let input_items = result.payload["input"].as_array().expect("responses input");
        assert!(result.payload.get("instructions").is_none());
        assert_eq!(input_items[0]["type"], "message");
        assert_eq!(input_items[0]["role"], "system");
        assert_eq!(input_items[0]["content"][0]["type"], "input_text");
        assert!(input_items[0]["content"][0]["text"]
            .as_str()
            .expect("system text")
            .contains("stopreason 取值：0=finished，1=blocked，2=continue_needed"));
        assert_eq!(input_items[1]["role"], "user");
        assert_eq!(input_items[1]["content"][0]["text"], "hello");
    }

    #[test]
    fn test_build_anthropic_messages_request() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "anthropic-messages",
                "version": "v1",
                "payload": {
                    "model": "claude-3-opus"
                }
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert_eq!(result.payload["model"], "claude-3-opus");
        assert!(result.payload.get("max_tokens").is_none());
    }

    #[test]
    fn test_build_anthropic_messages_request_converts_chat_payload() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "MiniMax-M3",
                    "messages": [{"role": "user", "content": "search latest"}],
                    "metadata": {"providerKey": "must-not-leak"}
                }
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert_eq!(result.payload["model"], "MiniMax-M3");
        assert_eq!(result.payload["messages"].as_array().unwrap().len(), 1);
        assert_eq!(result.payload["messages"][0]["role"], "user");
        assert_eq!(result.payload["messages"][0]["content"][0]["type"], "text");
        assert_eq!(
            result.payload["messages"][0]["content"][0]["text"],
            "search latest"
        );
        assert!(result.payload.get("metadata").is_none());
    }

    #[test]
    fn test_build_anthropic_messages_request_preserves_responses_instructions_as_system() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "MiniMax-M2.7",
                    "instructions": "stopreason 取值：0=finished，1=blocked，2=continue_needed",
                    "input": [{
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "search latest"}]
                    }]
                }
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert_eq!(
            result.payload["system"],
            "stopreason 取值：0=finished，1=blocked，2=continue_needed"
        );
        assert!(result.payload.get("instructions").is_none());
    }

    #[test]
    fn test_build_openai_chat_request_normalizes_responses_text_parts_inside_messages() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-chat",
                "version": "v1",
                "payload": {
                    "model": "DeepSeek-V4-Pro",
                    "messages": [{
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "<image name=[Image #1]>" },
                            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } },
                            { "type": "input_text", "text": "</image>" },
                            { "type": "input_text", "text": "[Image #1]继续" }
                        ]
                    }]
                }
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = build_format_request(input).unwrap();
        let content = result.payload["messages"][0]["content"]
            .as_array()
            .expect("chat content");
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "<image name=[Image #1]>");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAA");
        assert_eq!(content[2]["type"], "text");
        assert_eq!(content[2]["text"], "</image>");
        assert_eq!(content[3]["type"], "text");
        assert_eq!(content[3]["text"], "[Image #1]继续");
    }

    #[test]
    fn test_build_gemini_chat_request() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "gemini-chat",
                "version": "v1",
                "payload": {
                    "model": "gemini-pro",
                    "contents": [{"role": "user", "parts": [{"text": "hello"}]}]
                }
            }),
            protocol: "gemini-chat".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert_eq!(result.payload["model"], "gemini-pro");
    }

    #[test]
    fn test_build_anthropic_messages_from_responses_preserves_tool_result_pair() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "MiniMax-M3",
                    "input": [
                        {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "start"}]
                        },
                        {
                            "type": "function_call",
                            "call_id": "call_keep_result",
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"tail -n 60 note.md\"}"
                        },
                        {
                            "type": "function_call_output",
                            "call_id": "call_keep_result",
                            "output": "Total output lines: 141\n\n## verified tool output"
                        },
                        {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "continue"}]
                        }
                    ],
                    "tools": [{
                        "type": "function",
                        "name": "exec_command",
                        "description": "run command",
                        "parameters": {"type": "object"}
                    }]
                }
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = build_format_request(input).unwrap();
        let messages = result.payload["messages"].as_array().unwrap();
        let tool_use_index = messages
            .iter()
            .position(|message| {
                message["content"].as_array().is_some_and(|content| {
                    content.iter().any(|part| {
                        part["type"].as_str() == Some("tool_use")
                            && part["id"].as_str() == Some("call_keep_result")
                    })
                })
            })
            .expect("assistant tool_use message");
        let result_message = messages
            .get(tool_use_index + 1)
            .expect("tool_result must immediately follow tool_use");
        assert_eq!(result_message["role"].as_str(), Some("user"));
        assert_eq!(
            result_message["content"][0]["type"].as_str(),
            Some("tool_result")
        );
        assert_eq!(
            result_message["content"][0]["tool_use_id"].as_str(),
            Some("call_keep_result")
        );
    }

    #[test]
    fn test_build_anthropic_messages_from_responses_serializes_parallel_tool_results() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "MiniMax-M3",
                    "input": [
                        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "start"}]},
                        {"type": "function_call", "call_id": "call_a", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
                        {"type": "function_call", "call_id": "call_b", "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}"},
                        {"type": "function_call_output", "call_id": "call_a", "output": "pwd output"},
                        {"type": "function_call_output", "call_id": "call_b", "output": "ls output"}
                    ],
                    "tools": [{"type": "function", "name": "exec_command", "description": "run command", "parameters": {"type": "object"}}]
                }
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = build_format_request(input).unwrap();
        let messages = result.payload["messages"].as_array().unwrap();
        let tool_turns = messages
            .iter()
            .filter(|message| {
                message["content"].as_array().is_some_and(|content| {
                    content.iter().any(|part| {
                        part["type"].as_str() == Some("tool_use")
                            || part["type"].as_str() == Some("tool_result")
                    })
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(tool_turns.len(), 4);
        for pair in tool_turns.chunks(2) {
            assert_eq!(pair[0]["role"].as_str(), Some("assistant"));
            assert_eq!(pair[1]["role"].as_str(), Some("user"));
            assert_eq!(pair[0]["content"].as_array().unwrap().len(), 1);
            assert_eq!(pair[1]["content"].as_array().unwrap().len(), 1);
            assert_eq!(
                pair[0]["content"][0]["id"].as_str(),
                pair[1]["content"][0]["tool_use_id"].as_str()
            );
        }
    }

    #[test]
    fn test_build_anthropic_messages_from_responses_does_not_emit_undeclared_tool_use() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "MiniMax-M3",
                    "input": [
                        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "inspect app"}]},
                        {"type": "function_call", "call_id": "call_ui", "name": "get_app_state", "arguments": "{\"app\":\"ZTerm\"}"},
                        {"type": "function_call_output", "call_id": "call_ui", "output": [{"type": "text", "text": "[Image omitted]"}]},
                        {"type": "function_call", "call_id": "call_exec", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
                        {"type": "function_call_output", "call_id": "call_exec", "output": "ok"}
                    ],
                    "tools": [{"type": "function", "name": "exec_command", "description": "run command", "parameters": {"type": "object"}}]
                }
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = build_format_request(input).unwrap();
        let serialized = serde_json::to_string(&result.payload).unwrap();
        assert!(!serialized.contains("call_ui"));
        assert!(!serialized.contains("get_app_state"));
        assert!(serialized.contains("call_exec"));
        let messages = result.payload["messages"].as_array().unwrap();
        for (index, message) in messages.iter().enumerate() {
            for part in message["content"].as_array().cloned().unwrap_or_default() {
                if part["type"].as_str() == Some("tool_result") {
                    let previous = messages.get(index.saturating_sub(1)).unwrap();
                    assert_eq!(previous["role"].as_str(), Some("assistant"));
                    assert_eq!(
                        previous["content"][0]["id"].as_str(),
                        part["tool_use_id"].as_str()
                    );
                }
            }
        }
    }

    #[test]
    fn test_build_anthropic_messages_preserves_tool_result_with_inline_image_placeholder() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "MiniMax-M3",
                    "input": [
                        {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "start"}]
                        },
                        {
                            "type": "function_call",
                            "call_id": "call_inline_image_result",
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"tail -n 60 note.md\"}"
                        },
                        {
                            "type": "function_call_output",
                            "call_id": "call_inline_image_result",
                            "output": "before data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB after"
                        },
                        {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "continue"}]
                        }
                    ],
                    "tools": [{
                        "type": "function",
                        "name": "exec_command",
                        "description": "run command",
                        "parameters": {"type": "object"}
                    }]
                }
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = build_format_request(input).unwrap();
        let messages = result.payload["messages"].as_array().unwrap();
        let tool_use_index = messages
            .iter()
            .position(|message| {
                message["content"].as_array().is_some_and(|content| {
                    content.iter().any(|part| {
                        part["type"].as_str() == Some("tool_use")
                            && part["id"].as_str() == Some("call_inline_image_result")
                    })
                })
            })
            .expect("assistant tool_use message");
        let result_message = messages
            .get(tool_use_index + 1)
            .expect("tool_result must immediately follow tool_use");
        assert_eq!(result_message["role"].as_str(), Some("user"));
        assert_eq!(
            result_message["content"][0]["type"].as_str(),
            Some("tool_result")
        );
        assert_eq!(
            result_message["content"][0]["tool_use_id"].as_str(),
            Some("call_inline_image_result")
        );
        assert!(result_message["content"][0]["content"]
            .as_str()
            .unwrap_or_default()
            .contains("[Image omitted]"));
    }

    #[test]
    fn test_build_anthropic_messages_keeps_html_exec_tool_result_before_later_stopless_turns() {
        let html_tool_output = concat!(
            "Total output lines: 170\n\n",
            "<!DOCTYPE html><html><head><title>Static Residential Proxies</title></head><body>",
            "<img src=\"data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%3e\" />",
            "<img src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB\" />",
            "<p>gateway.iproyal.com:19123</p>",
            "</body></html>"
        );
        let stopless_output = "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"summary\":\"stopless continuation ready\",\"repeatCount\":2,\"maxRepeats\":3,\"continuationPrompt\":\"继续。\",\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2},\"triggerHint\":\"no_schema\"},\"input\":{\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"maxRepeats\":3,\"triggerHint\":\"no_schema\"}}";
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "MiniMax-M3",
                    "input": [
                        {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "我其实想知道，我如何配置和它的连接IPRoyal 的静态 IP"}]
                        },
                        {
                            "type": "reasoning",
                            "summary": [{"type": "summary_text", "text": "**Thinking** search static proxy details"}]
                        },
                        {
                            "type": "function_call",
                            "call_id": "call_html_exec_1",
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"curl -s 'https://iproyal.com/static-residential-proxies/' 2>/dev/null | head -200\",\"yield_time_ms\":10000}"
                        },
                        {
                            "type": "function_call_output",
                            "call_id": "call_html_exec_1",
                            "output": html_tool_output
                        },
                        {
                            "type": "reasoning",
                            "summary": [{"type": "summary_text", "text": "**Thinking** summarize proxy setup"}]
                        },
                        {
                            "type": "function_call",
                            "call_id": "call_stopless_1",
                            "name": "reasoningStop",
                            "arguments": "{\"stopreason\":2,\"reason\":\"continue_needed\"}"
                        },
                        {
                            "type": "function_call_output",
                            "call_id": "call_stopless_1",
                            "output": stopless_output
                        },
                        {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "它是用一个特殊的协议做单次请求，请求本身包括鉴权和内容？无状态请求？"}]
                        }
                    ],
                    "tools": [{
                        "type": "function",
                        "name": "exec_command",
                        "description": "run command",
                        "parameters": {"type": "object"}
                    }]
                }
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = build_format_request(input).unwrap();
        let messages = result.payload["messages"].as_array().unwrap();
        let tool_use_index = messages
            .iter()
            .position(|message| {
                message["content"].as_array().is_some_and(|content| {
                    content.iter().any(|part| {
                        part["type"].as_str() == Some("tool_use")
                            && part["id"].as_str() == Some("call_html_exec_1")
                    })
                })
            })
            .expect("assistant exec_command tool_use message");
        let result_message = messages
            .get(tool_use_index + 1)
            .expect("tool_result must immediately follow HTML exec tool_use");
        assert_eq!(result_message["role"].as_str(), Some("user"));
        assert_eq!(
            result_message["content"][0]["type"].as_str(),
            Some("tool_result")
        );
        assert_eq!(
            result_message["content"][0]["tool_use_id"].as_str(),
            Some("call_html_exec_1")
        );
        assert!(
            result_message["content"][0]["content"]
                .as_str()
                .unwrap_or_default()
                .contains("[Image omitted]"),
            "HTML/data-uri output may be placeholder-normalized, but must stay a tool_result"
        );

        let next_message = messages
            .get(tool_use_index + 2)
            .expect("later turn after exec tool_result");
        let is_placeholder_only_user_turn = next_message["role"].as_str() == Some("user")
            && next_message["content"].as_array().is_some_and(|content| {
                content.len() == 1
                    && content[0]["type"].as_str() == Some("text")
                    && content[0]["text"].as_str() == Some("[Image omitted]")
            });
        assert!(
            !is_placeholder_only_user_turn,
            "tool_result must not be rewritten into a standalone user placeholder turn"
        );
    }

    #[test]
    fn test_strip_private_fields() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "gpt-4",
                    "_private": "should_be_stripped",
                    "__internal": "also_stripped",
                    "messages": [{"role": "user", "content": "hello", "_temp": "strip_me"}]
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert!(result.payload.get("_private").is_none());
        assert!(result.payload.get("__internal").is_none());
        assert!(result.payload.get("model").is_some());

        assert!(result.payload.get("messages").is_none());
        assert!(result.payload["input"][0]["content"][0]
            .get("_temp")
            .is_none());
    }

    #[test]
    fn test_provider_outbound_strips_metadata_field() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-chat",
                "version": "v1",
                "payload": {
                    "model": "gpt-4",
                    "messages": [{"role": "user", "content": "hello"}],
                    "metadata": {"user_id": "must-not-leak"}
                }
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert!(result.payload.get("metadata").is_none());
    }

    #[test]
    fn test_provider_outbound_strips_client_metadata_fields() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "gpt-5.3-codex-spark",
                    "input": [{
                        "role": "user",
                        "content": [{
                            "type": "input_text",
                            "text": "hello",
                            "metadata": {"nested": "must-not-leak"}
                        }]
                    }],
                    "client_metadata": {"session_id": "must-not-leak"},
                    "metadata": {"request": "must-not-leak"}
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        let serialized = serde_json::to_string(&result.payload).unwrap();
        assert!(!serialized.contains("metadata"));
        assert!(!serialized.contains("must-not-leak"));
    }

    #[test]
    fn test_provider_outbound_does_not_backfill_from_metadata_context() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "version": "v1",
                "payload": {
                    "model": "gpt-4",
                    "metadata": {
                        "context": {
                            "input": [{"role": "user", "content": [{"type": "input_text", "text": "must not backfill"}]}],
                            "toolsRaw": [{"type": "function", "name": "leak"}]
                        }
                    }
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert!(result.payload.get("metadata").is_none());
        assert!(result.payload.get("input").is_none());
        assert!(result.payload.get("tools").is_none());
    }

    #[test]
    fn test_error_missing_payload() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses"
            }),
            protocol: "openai-responses".to_string(),
        };

        let err = build_format_request(input).unwrap_err();
        assert_eq!(err, "Missing 'payload' field in format envelope");
    }

    #[test]
    fn test_payload_size_limit() {
        let small_payload = serde_json::json!({"model": "test"});
        assert!(validate_payload_size(&small_payload).is_ok());
    }

    // Critical path test: Protocol not found fallback
    #[test]
    fn test_unknown_protocol_fallback() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "unknown-protocol",
                "version": "v1",
                "payload": {
                    "model": "test-model",
                    "_private": "should_be_stripped"
                }
            }),
            protocol: "unknown-protocol".to_string(),
        };

        let result = build_format_request(input).unwrap();
        assert_eq!(result.payload["model"], "test-model");
        assert!(result.payload.get("_private").is_none());
    }

    // Critical path test: Nested private fields in arrays
    #[test]
    fn test_nested_private_fields_in_array() {
        let input = FormatBuildInput {
            format_envelope: serde_json::json!({
                "format": "openai-responses",
                "payload": {
                    "messages": [
                        {"role": "user", "content": "hello", "_temp_id": "123"},
                        {"role": "assistant", "content": "hi", "__internal_cache": "xyz"}
                    ]
                }
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = build_format_request(input).unwrap();
        if let Some(input) = result.payload.get("input").and_then(|v| v.as_array()) {
            for msg in input {
                assert!(msg.get("_temp_id").is_none());
                assert!(msg.get("__internal_cache").is_none());
            }
        }
    }
}
