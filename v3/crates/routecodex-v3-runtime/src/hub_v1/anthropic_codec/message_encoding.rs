// Anthropic message/part -> Responses semantic encoding helpers, split from
// anthropic_codec.rs to satisfy verify:v3-file-size. Semantics unchanged; the
// call sites in anthropic_codec.rs were prefixed with `message_encoding::`.

use super::*;

pub(super) fn push_anthropic_shape_string(
    semantics: &mut Vec<V3AnthropicRequestShapeBranchSemantic>,
    message_index: usize,
    content_index: usize,
    source: &Map<String, Value>,
    provider_field: &'static str,
    source_field: &'static str,
    chat_semantic: V3AnthropicChatShapeBranchSemantic,
) -> Result<(), V3AnthropicCodecError> {
    let value = source
        .get(provider_field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: source_field,
        })?;
    semantics.push(V3AnthropicRequestShapeBranchSemantic {
        message_index,
        content_index,
        source_field,
        chat_semantic,
        value: value.to_owned(),
    });
    Ok(())
}

pub(super) fn encode_anthropic_messages_as_responses_semantic(
    messages: &[Value],
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let mut encoded = Vec::new();
    for message in messages {
        let role = message.get("role").cloned().unwrap_or(Value::Null);
        match message.get("content") {
            Some(Value::String(text)) => {
                encoded.push(json!({
                    "role":role,
                    "content":[{"type":"input_text","text":text}]
                }));
            }
            Some(Value::Array(parts)) => {
                let mut message_content = Vec::new();
                for part in parts {
                    match part.get("type").and_then(Value::as_str) {
                        Some("text" | "image") => {
                            if let Some(content_part) =
                                anthropic_content_part_as_responses_message_part(part)
                            {
                                message_content.push(content_part?);
                            }
                        }
                        Some("thinking" | "redacted_thinking") => {
                            push_responses_message_content(
                                &mut encoded,
                                &role,
                                &mut message_content,
                            );
                            encoded
                                .push(anthropic_reasoning_part_as_responses_reasoning(part, None)?);
                        }
                        Some("reasoning") => {
                            return Err(V3AnthropicCodecError::MalformedField {
                                field: "reasoning content",
                            });
                        }
                        Some("tool_use") => {
                            push_responses_message_content(
                                &mut encoded,
                                &role,
                                &mut message_content,
                            );
                            encoded.push(json!({"type":"function_call","call_id":part.get("id").cloned().unwrap_or(Value::Null),"name":part.get("name").cloned().unwrap_or(Value::Null),"arguments":serde_json::to_string(part.get("input").unwrap_or(&Value::Null)).map_err(|_| V3AnthropicCodecError::MalformedField { field: "tool_use input" })?}));
                        }
                        Some("tool_result") => {
                            push_responses_message_content(
                                &mut encoded,
                                &role,
                                &mut message_content,
                            );
                            encoded.push(json!({"type":"function_call_output","call_id":part.get("tool_use_id").cloned().unwrap_or(Value::Null),"output":anthropic_tool_result_output_as_responses_semantic(part.get("content"))}));
                        }
                        _ => {}
                    }
                }
                push_responses_message_content(&mut encoded, &role, &mut message_content);
            }
            _ => {}
        }
    }
    Ok(encoded)
}

pub(super) fn push_responses_message_content(
    encoded: &mut Vec<Value>,
    role: &Value,
    content: &mut Vec<Value>,
) {
    if !content.is_empty() {
        encoded.push(json!({
            "role":role,
            "content":std::mem::take(content)
        }));
    }
}

pub(super) fn anthropic_tool_result_output_as_responses_semantic(content: Option<&Value>) -> Value {
    match content {
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(Value::Array(parts)) => {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");
            if text.is_empty() {
                Value::String(serde_json::to_string(parts).unwrap_or_else(|_| "[]".into()))
            } else {
                Value::String(text)
            }
        }
        Some(value) => {
            Value::String(serde_json::to_string(value).unwrap_or_else(|_| "null".into()))
        }
        None => Value::String(String::new()),
    }
}

pub(super) fn system_as_responses_instructions(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty_string(text),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(anthropic_text_block_text)
                .collect::<Vec<_>>();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        }
        Value::Object(_) => anthropic_text_block_text(value),
        _ => None,
    }
}

pub(super) fn anthropic_text_block_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty_string(text),
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .and_then(non_empty_string),
        _ => None,
    }
}

pub(super) fn non_empty_string(text: &str) -> Option<String> {
    if text.trim().is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

pub(super) fn anthropic_content_part_as_responses_message_part(
    part: &Value,
) -> Option<Result<Value, V3AnthropicCodecError>> {
    let part_type = part.get("type").and_then(Value::as_str)?;
    match part_type {
        "text" => Some(Ok(
            json!({"type":"input_text","text":part.get("text").cloned().unwrap_or(Value::Null)}),
        )),
        "image" => Some(anthropic_image_part_as_responses_input_image(part)),
        _ => None,
    }
}

pub(super) fn anthropic_image_part_as_responses_input_image(
    part: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let source = part.get("source").and_then(Value::as_object).ok_or(
        V3AnthropicCodecError::MalformedField {
            field: "image source",
        },
    )?;
    match source.get("type").and_then(Value::as_str) {
        Some("url") => source
            .get("url")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|url| json!({"type":"input_image","image_url":url}))
            .ok_or(V3AnthropicCodecError::MalformedField { field: "image url" }),
        Some("base64") => {
            let media_type = source
                .get("media_type")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "image media_type",
                })?;
            let data = source
                .get("data")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "image data",
                })?;
            Ok(json!({"type":"input_image","image_url":format!("data:{media_type};base64,{data}")}))
        }
        _ => Err(V3AnthropicCodecError::MalformedField {
            field: "image source type",
        }),
    }
}
