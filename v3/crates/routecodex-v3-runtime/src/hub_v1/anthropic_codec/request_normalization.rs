use super::*;

/// Inbound protocol owner: normalize Anthropic messages to Chat canonical.
/// Provider-target projection is performed later by the registered Req07 codec.
pub fn normalize_v3_anthropic_request_to_chat(
    source_payload: Value,
) -> Result<Value, V3AnthropicCodecError> {
    let transport_intent = match source_payload.get("stream").and_then(Value::as_bool) {
        Some(true) => V3HubTransportIntent::Sse,
        _ => V3HubTransportIntent::Json,
    };
    let source_payload = characterize_v3_anthropic_client_input_to_hub_semantic(
        source_payload,
        V3HubEntryProtocol::Anthropic,
        transport_intent,
    )?
    .into_payload();
    let source = source_payload
        .as_object()
        .ok_or(V3AnthropicCodecError::PayloadNotObject)?;
    let source_messages = source
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(V3AnthropicCodecError::MessagesNotArray)?;

    let mut messages = Vec::new();
    if let Some(system) = source.get("system") {
        let text = match system {
            Value::String(text) => Some(text.clone()),
            Value::Array(blocks) => {
                let text = blocks
                    .iter()
                    .filter_map(message_encoding::anthropic_text_block_text)
                    .collect::<Vec<_>>();
                (!text.is_empty()).then(|| text.join("\n\n"))
            }
            Value::Object(_) => message_encoding::anthropic_text_block_text(system),
            _ => None,
        };
        if let Some(text) = text {
            messages.push(json!({"role":"system","content":text}));
        }
    }
    let mut chat_extensions = Map::new();
    let mut anthropic_fields = Map::new();
    for field in [
        "system",
        "thinking",
        "output_config",
        "metadata",
        "context_management",
    ] {
        if let Some(value) = source.get(field) {
            anthropic_fields.insert(field.to_string(), value.clone());
        }
    }
    let canonical_source_fields = [
        "model",
        "system",
        "messages",
        "tools",
        "tool_choice",
        "max_tokens",
        "temperature",
        "top_p",
        "top_k",
        "stream",
        "stop_sequences",
        "thinking",
        "output_config",
        "metadata",
        "context_management",
    ];
    let source_extensions = source
        .iter()
        .filter(|(key, _)| !canonical_source_fields.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Map<_, _>>();
    if !source_extensions.is_empty() {
        anthropic_fields.insert(
            "source_extensions".to_string(),
            Value::Object(source_extensions),
        );
    }
    for (message_index, message) in source_messages.iter().enumerate() {
        let role = message.get("role").and_then(Value::as_str).ok_or(
            V3AnthropicCodecError::MalformedField {
                field: "message.role",
            },
        )?;
        let content = message
            .get("content")
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "message.content",
            })?;
        let parts = match content {
            Value::String(text) => vec![json!({"type":"text","text":text})],
            Value::Array(parts) => parts.clone(),
            _ => {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "message.content",
                });
            }
        };
        let mut chat_content = Vec::new();
        let mut tool_calls = Vec::new();
        let mut tool_results = Vec::new();
        let mut content_order = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    content_order.push(json!({"kind":"content","index":chat_content.len()}));
                    chat_content.push(json!({"type":"text","text":part.get("text").cloned().ok_or(V3AnthropicCodecError::MalformedField { field: "text" })?}));
                }
                Some("image") => {
                    let image_source = part.get("source").and_then(Value::as_object).ok_or(
                        V3AnthropicCodecError::MalformedField {
                            field: "image.source",
                        },
                    )?;
                    let url = match image_source.get("type").and_then(Value::as_str) {
                        Some("url") => image_source
                            .get("url")
                            .and_then(Value::as_str)
                            .filter(|url| !url.is_empty())
                            .map(str::to_string)
                            .ok_or(V3AnthropicCodecError::MalformedField {
                                field: "image.source.url",
                            })?,
                        Some("base64") => {
                            let media_type = image_source
                                .get("media_type")
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty())
                                .ok_or(V3AnthropicCodecError::MalformedField {
                                    field: "image.source.media_type",
                                })?;
                            let data = image_source
                                .get("data")
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty())
                                .ok_or(V3AnthropicCodecError::MalformedField {
                                    field: "image.source.data",
                                })?;
                            format!("data:{media_type};base64,{data}")
                        }
                        _ => {
                            return Err(V3AnthropicCodecError::MalformedField {
                                field: "image.source.type",
                            });
                        }
                    };
                    content_order.push(json!({"kind":"content","index":chat_content.len()}));
                    chat_content.push(json!({"type":"image_url","image_url":{"url":url}}));
                }
                Some("tool_use") => {
                    let id = part
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.trim().is_empty())
                        .ok_or(V3AnthropicCodecError::MalformedField {
                            field: "tool_use.id",
                        })?;
                    let name = part
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|name| !name.trim().is_empty())
                        .ok_or(V3AnthropicCodecError::MalformedField {
                            field: "tool_use.name",
                        })?;
                    let arguments = serde_json::to_string(
                        part.get("input").unwrap_or(&Value::Null),
                    )
                    .map_err(|_| V3AnthropicCodecError::MalformedField {
                        field: "tool_use.input",
                    })?;
                    content_order.push(json!({"kind":"tool_call","index":tool_calls.len()}));
                    tool_calls.push(json!({"id":id,"type":"function","function":{"name":name,"arguments":arguments}}));
                }
                Some("tool_result") => {
                    let tool_call_id = part.get("tool_use_id").and_then(Value::as_str).ok_or(
                        V3AnthropicCodecError::MalformedField {
                            field: "tool_result.tool_use_id",
                        },
                    )?;
                    anthropic_fields
                        .entry("history_tool_result_blocks")
                        .or_insert_with(|| Value::Array(Vec::new()))
                        .as_array_mut()
                        .ok_or(V3AnthropicCodecError::MalformedField {
                            field: "history_tool_result_blocks",
                        })?
                        .push(
                            json!({"message_index":message_index,"block_index":index,"block":part}),
                        );
                    let raw_output = part.get("content").cloned().unwrap_or(Value::Null);
                    let preserved_raw_output = raw_output.clone();
                    let output = match raw_output {
                        Value::String(_) => raw_output,
                        Value::Array(parts) => {
                            let text = parts
                                .iter()
                                .filter_map(|part| part.get("text").and_then(Value::as_str))
                                .collect::<Vec<_>>()
                                .join("");
                            if text.is_empty() {
                                Value::String(serde_json::to_string(&parts).map_err(|_| {
                                    V3AnthropicCodecError::MalformedField {
                                        field: "tool_result.content",
                                    }
                                })?)
                            } else {
                                Value::String(text)
                            }
                        }
                        value => Value::String(serde_json::to_string(&value).map_err(|_| {
                            V3AnthropicCodecError::MalformedField {
                                field: "tool_result.content",
                            }
                        })?),
                    };
                    tool_results
                        .push(json!({"role":"tool","tool_call_id":tool_call_id,"content":output}));
                    if let Some(result) = tool_results.last_mut() {
                        result["routecodex_chat_extension"] = json!({
                            "anthropic_tool_result_content": preserved_raw_output
                        });
                    }
                }
                Some("thinking" | "redacted_thinking") => anthropic_fields
                    .entry("history_reasoning_blocks")
                    .or_insert_with(|| Value::Array(Vec::new()))
                    .as_array_mut()
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "history_reasoning_blocks",
                    })?
                    .push(json!({"message_index":message_index,"block_index":index,"block":part})),
                Some(_) => anthropic_fields
                    .entry("history_content_blocks")
                    .or_insert_with(|| Value::Array(Vec::new()))
                    .as_array_mut()
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "history_content_blocks",
                    })?
                    .push(json!({"message_index":message_index,"block_index":index,"block":part})),
                None => {
                    return Err(V3AnthropicCodecError::MalformedField {
                        field: "content block type",
                    });
                }
            }
        }
        let mut chat_message = Map::new();
        chat_message.insert("role".to_string(), Value::String(role.to_string()));
        let has_chat_message_content = !chat_content.is_empty();
        chat_message.insert(
            "content".to_string(),
            if !has_chat_message_content {
                Value::Null
            } else {
                Value::Array(chat_content)
            },
        );
        let has_tool_calls = !tool_calls.is_empty();
        if has_tool_calls {
            chat_message.insert("tool_calls".to_string(), Value::Array(tool_calls));
        }
        if !content_order.is_empty() {
            chat_message.insert(
                "routecodex_chat_extension".to_string(),
                json!({"anthropic_content_order":content_order}),
            );
        }
        if has_chat_message_content || has_tool_calls || tool_results.is_empty() {
            messages.push(Value::Object(chat_message));
        }
        messages.extend(tool_results);
    }
    if !anthropic_fields.is_empty() {
        chat_extensions.insert(
            ANTHROPIC_REQUEST_EXTENSION.to_string(),
            Value::Object(anthropic_fields),
        );
    }

    let mut canonical = Map::new();
    if let Some(value) = source.get("model") {
        canonical.insert("model".to_string(), value.clone());
    }
    canonical.insert("messages".to_string(), Value::Array(messages));
    if let Some(tools) = source.get("tools").and_then(Value::as_array) {
        canonical.insert("tools".to_string(), Value::Array(tools.iter().map(|tool| json!({"type":"function","function":{"name":tool.get("name"),"description":tool.get("description"),"parameters":tool.get("input_schema")}})).collect()));
    }
    if let Some(choice) = source.get("tool_choice") {
        canonical.insert(
            "tool_choice".to_string(),
            match choice.get("type").and_then(Value::as_str) {
                Some("auto") => json!("auto"),
                Some("any") => json!("required"),
                Some("tool") => json!({"type":"function","function":{"name":choice.get("name")}}),
                _ => {
                    return Err(V3AnthropicCodecError::MalformedField {
                        field: "tool_choice",
                    });
                }
            },
        );
    }
    if let Some(effort) = source
        .get("output_config")
        .and_then(Value::as_object)
        .and_then(|config| config.get("effort"))
    {
        canonical.insert("reasoning_effort".to_string(), effort.clone());
    }
    for (source_key, target_key) in [
        ("max_tokens", "max_tokens"),
        ("temperature", "temperature"),
        ("top_p", "top_p"),
        ("top_k", "top_k"),
        ("stream", "stream"),
    ] {
        if let Some(value) = source.get(source_key) {
            canonical.insert(target_key.to_string(), value.clone());
        }
    }
    if let Some(stop) = source.get("stop_sequences") {
        canonical.insert("stop".to_string(), stop.clone());
    }
    if !chat_extensions.is_empty() {
        canonical.insert(
            "routecodex_chat_extension".to_string(),
            Value::Object(chat_extensions),
        );
    }
    Ok(Value::Object(canonical))
}
