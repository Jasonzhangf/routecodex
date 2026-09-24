use super::V3AnthropicCodecError;
use crate::protocol_tables::{map_value, V3TableDirection, V3TableKind};
use serde_json::{json, Map, Value};

/// Normalize an Anthropic provider message into the runtime's Chat response
/// semantic shape. Target-protocol projection happens after Chat Process.
pub fn normalize_v3_anthropic_message_to_chat_response(
    payload: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let object = payload
        .as_object()
        .ok_or(V3AnthropicCodecError::PayloadNotObject)?;
    let content = object
        .get("content")
        .and_then(Value::as_array)
        .ok_or(V3AnthropicCodecError::ContentNotArray)?;

    let mut text = String::new();
    let mut reasoning_blocks = Vec::new();
    let mut tool_calls = Vec::new();
    let mut reasoning_extensions = Vec::new();
    let mut text_blocks = Vec::new();
    let mut content_order = Vec::new();
    let mut provider_extensions = Map::new();
    for (index, block) in content.iter().enumerate() {
        let block_object = block
            .as_object()
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "content block",
            })?;
        match block_object.get("type").and_then(Value::as_str) {
            Some("text") => {
                let value = block_object.get("text").and_then(Value::as_str).ok_or(
                    V3AnthropicCodecError::MalformedField {
                        field: "text content",
                    },
                )?;
                text.push_str(value);
                content_order.push(json!({"kind":"text","index":text_blocks.len()}));
                text_blocks.push(Value::String(value.to_string()));
            }
            Some("thinking") => {
                let value = block_object.get("thinking").and_then(Value::as_str).ok_or(
                    V3AnthropicCodecError::MalformedField {
                        field: "thinking content",
                    },
                )?;
                let mut reasoning = Map::new();
                reasoning.insert(
                    "summary".to_string(),
                    json!([{"type":"summary_text","text":value}]),
                );
                if let Some(signature) = block_object.get("signature") {
                    reasoning.insert("encrypted_content".to_string(), signature.clone());
                }
                reasoning_blocks.push(Value::Object(reasoning));
                content_order.push(json!({"kind":"reasoning","index":reasoning_blocks.len()-1}));
                let extensions = block_object
                    .iter()
                    .filter(|(key, _)| !["type", "thinking", "signature"].contains(&key.as_str()))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<Map<_, _>>();
                if !extensions.is_empty() {
                    reasoning_extensions.push(json!({"block_index":index,"fields":extensions}));
                }
            }
            Some("redacted_thinking") => {
                if let Some(data) = block_object.get("data") {
                    reasoning_blocks.push(json!({"encrypted_content":data}));
                    content_order
                        .push(json!({"kind":"reasoning","index":reasoning_blocks.len()-1}));
                }
                let extensions = block_object
                    .iter()
                    .filter(|(key, _)| !["type", "data"].contains(&key.as_str()))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<Map<_, _>>();
                if !extensions.is_empty() {
                    reasoning_extensions.push(json!({"block_index":index,"fields":extensions}));
                }
            }
            Some("tool_use") => {
                let id = block_object
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "tool_use.id",
                    })?;
                let name = block_object
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "tool_use.name",
                    })?;
                let input = block_object
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let arguments = serde_json::to_string(&input).map_err(|_| {
                    V3AnthropicCodecError::MalformedField {
                        field: "tool_use.input",
                    }
                })?;
                tool_calls.push(json!({
                    "id":id,
                    "type":"function",
                    "function":{"name":name,"arguments":arguments}
                }));
                content_order.push(json!({"kind":"tool_call","index":tool_calls.len()-1}));
            }
            Some(kind) => {
                // Preserve non-Chat provider blocks as data-plane extensions. The selected
                // target's Outbound projection decides whether each extension is compatible.
                reasoning_extensions.push(json!({"block_index":index,"block":block,"type":kind}));
            }
            None => {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "content block type",
                });
            }
        }
    }

    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    message.insert(
        "content".to_string(),
        (!text.is_empty())
            .then_some(Value::String(text))
            .unwrap_or(Value::Null),
    );
    if !tool_calls.is_empty() {
        message.insert("tool_calls".to_string(), Value::Array(tool_calls));
    }
    if !reasoning_extensions.is_empty()
        || !reasoning_blocks.is_empty()
        || content
            .iter()
            .any(|block| block.get("type").and_then(Value::as_str) == Some("text"))
    {
        message.insert(
            "routecodex_chat_extension".to_string(),
            json!({
                "anthropic_reasoning_blocks":reasoning_blocks,
                "anthropic_provider_reasoning_extensions":reasoning_extensions,
                "anthropic_text_blocks":text_blocks,
                "anthropic_content_order":content_order
            }),
        );
    }

    let stop_reason = object
        .get("stop_reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(V3AnthropicCodecError::InvalidTerminalField {
            field: "stop_reason",
            reason: "missing or empty on materialized Anthropic message".to_string(),
        })?;
    let hub_reason = map_value(
        V3TableKind::FinishReason,
        "anthropic",
        stop_reason,
        V3TableDirection::Inbound,
    )
    .map_err(|error| V3AnthropicCodecError::InvalidTerminalField {
        field: "stop_reason",
        reason: error.to_string(),
    })?
    .ok_or_else(|| V3AnthropicCodecError::InvalidTerminalField {
        field: "stop_reason",
        reason: format!("unknown value '{stop_reason}'"),
    })?;
    let finish_reason = match hub_reason {
        "stop" | "stop_sequence" | "pause_turn" => "stop",
        "tool_calls" => "tool_calls",
        "max_tokens" | "context_window_exceeded" => "length",
        "content_filter" => "content_filter",
        other => {
            return Err(V3AnthropicCodecError::InvalidTerminalField {
                field: "stop_reason",
                reason: format!("unsupported normalized finish reason '{other}'"),
            });
        }
    };
    for field in ["stop_sequence", "stop_details"] {
        if let Some(value) = object.get(field) {
            provider_extensions.insert(field.to_string(), value.clone());
        }
    }
    provider_extensions.insert(
        "stop_reason".to_string(),
        Value::String(stop_reason.to_string()),
    );
    let normalized_response_fields = [
        "id",
        "model",
        "type",
        "role",
        "content",
        "stop_reason",
        "stop_sequence",
        "stop_details",
        "usage",
    ];
    for (key, value) in object {
        if !normalized_response_fields.contains(&key.as_str()) {
            provider_extensions.insert(key.clone(), value.clone());
        }
    }
    if !provider_extensions.is_empty() || !reasoning_extensions.is_empty() {
        let extension = message
            .entry("routecodex_chat_extension")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "routecodex_chat_extension",
            })?;
        extension.insert(
            "anthropic_provider_response_extensions".to_string(),
            Value::Object(provider_extensions),
        );
    }
    let mut response = Map::new();
    if let Some(id) = object.get("id") {
        response.insert("id".to_string(), id.clone());
    }
    if let Some(model) = object.get("model") {
        response.insert("model".to_string(), model.clone());
    }
    response.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    response.insert(
        "choices".to_string(),
        json!([{"index":0,"message":message,"finish_reason":finish_reason}]),
    );
    if let Some(usage) = object.get("usage").and_then(Value::as_object) {
        let mut normalized_usage = Map::new();
        for (source, target) in [
            ("input_tokens", "prompt_tokens"),
            ("output_tokens", "completion_tokens"),
            ("total_tokens", "total_tokens"),
        ] {
            if let Some(value) = usage.get(source) {
                normalized_usage.insert(target.to_string(), value.clone());
            }
        }
        if !normalized_usage.contains_key("total_tokens") {
            if let (Some(input), Some(output)) = (
                normalized_usage
                    .get("prompt_tokens")
                    .and_then(Value::as_u64),
                normalized_usage
                    .get("completion_tokens")
                    .and_then(Value::as_u64),
            ) {
                normalized_usage.insert("total_tokens".to_string(), json!(input + output));
            }
        }
        response.insert("usage".to_string(), Value::Object(normalized_usage));
    }
    Ok(Value::Object(response))
}
