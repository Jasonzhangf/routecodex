// Provider-standard Chat message projection, included by the single request
// format owner. This file owns no lifecycle transition or provider decision.

fn normalize_openai_chat_messages_payload(
    payload: &Value,
    model_id: Option<&str>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    has_web_search_capability: bool,
    drop_context: &V3ProjectionDropContext,
    mut observer: Option<&mut StandardOutboundDeclarationObserver<'_>>,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    normalize_openai_chat_messages_payload_with_hosted_history(
        payload,
        model_id,
        web_search_execution_mode,
        has_web_search_capability,
        drop_context,
        observer,
        &[],
        false,
    )
}

fn normalize_openai_chat_messages_payload_with_hosted_history(
    payload: &Value,
    model_id: Option<&str>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    has_web_search_capability: bool,
    drop_context: &V3ProjectionDropContext,
    mut observer: Option<&mut StandardOutboundDeclarationObserver<'_>>,
    hosted_emissions: &[crate::operation_runner::HostedHistoryEmission],
    responses_message_shape: bool,
) -> Result<(Value, Vec<V3ProjectionDropRecord>), String> {
    let mut drops = Vec::new();
    let declaration_sources = provider_tool_declaration_sources(payload)?;
    let (mut normalized, mut carrier_drops) =
        project_outbound_payload_for_target_protocol_with_drops(
            payload,
            V3OutboundTargetProtocol::OpenAiChat,
        )?;
    drops.append(&mut carrier_drops);
    if let Some(row) = normalized.as_object_mut() {
        if let Some(max_output_tokens) = row.remove("max_output_tokens") {
            row.entry("max_completion_tokens".to_string())
                .or_insert(max_output_tokens);
        }
        if let Some(reasoning_effort) = project_openai_chat_reasoning_effort_from_reasoning(row) {
            row.entry("reasoning_effort".to_string())
                .or_insert(reasoning_effort);
        }
    }
    let instructions = normalized
        .as_object_mut()
        .and_then(|row| row.remove("instructions"))
        .and_then(|value| value.as_str().map(str::to_string))
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    super::request_outbound_mcp_names::normalize_openai_chat_namespace_history_names(
        &mut normalized,
    )?;
    let Some(messages) = normalized.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok((normalized, drops));
    };
    if let Some(instructions) = instructions {
        let already_visible = messages.iter().any(|message| {
            matches!(
                message.get("role").and_then(Value::as_str),
                Some("system" | "developer")
            ) && message
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| content.contains(&instructions))
        });
        if !already_visible {
            if let Some(system_message) = messages.iter_mut().find(|message| {
                matches!(
                    message.get("role").and_then(Value::as_str),
                    Some("system" | "developer")
                )
            }) {
                if let Some(system_row) = system_message.as_object_mut() {
                    match system_row.get_mut("content") {
                        Some(Value::String(content)) => {
                            if !content.trim().is_empty() {
                                content.push_str("\n\n");
                            }
                            content.push_str(&instructions);
                        }
                        Some(Value::Array(parts)) => {
                            parts.push(json!({"type": "text", "text": instructions}));
                        }
                        _ => {
                            system_row.insert("content".to_string(), Value::String(instructions));
                        }
                    }
                }
            } else {
                messages.insert(0, json!({"role": "system", "content": instructions}));
            }
        }
    }
    expand_openai_chat_hosted_history_messages(messages, hosted_emissions);
    for message in messages.iter_mut() {
        let Some(message_row) = message.as_object_mut() else {
            continue;
        };
        super::request_outbound_mcp_names::normalize_openai_chat_message_tool_call_names(
            message_row,
        );
        consume_routecodex_chat_extension_for_openai_chat_provider(message_row);
        if responses_message_shape {
            project_openai_chat_provider_message_shape(message_row);
        }
        // Map `developer` role to `system` for OpenAI Chat provider wire
        // compatibility. Many third-party Chat Completions providers (e.g.
        // xmcc2) reject `developer` role with HTTP 400, accepting only
        // `system`. The `developer` role is an OpenAI extension; standard
        // Chat Completions providers expect `system` for instruction messages.
        if message_row
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role.eq_ignore_ascii_case("developer"))
        {
            message_row.insert("role".to_string(), Value::String("system".to_string()));
        }
        let Some(content) = message_row.get_mut("content") else {
            continue;
        };
        if let Value::Array(parts) = content {
            let normalized_parts = parts
                .iter()
                .map(request_outbound_openai_chat_content_part::normalize_openai_chat_message_content_part)
                .collect::<Result<Vec<_>, String>>()?;
            *content = Value::Array(normalized_parts);
        }
    }
    project_openai_chat_provider_tools_for_web_search_mode_recording(
        &mut normalized,
        model_id,
        web_search_execution_mode,
        has_web_search_capability,
        drop_context,
        &mut drops,
        observer,
        &declaration_sources,
    )?;
    ensure_openai_chat_stream_usage_option(&mut normalized);
    super::request_outbound_mcp_names::project_openai_chat_namespace_wire_names(
        &mut normalized,
        payload,
    )?;
    if let Some(choice) = normalized.get_mut("tool_choice").and_then(Value::as_object_mut) {
        if choice.get("type").and_then(Value::as_str) == Some("function")
            && !choice.contains_key("function")
        {
            if let Some(name) = choice.remove("name") {
                choice.insert("function".to_owned(), json!({"name": name}));
            }
        }
    }
    Ok((normalized, drops))
}

fn expand_openai_chat_hosted_history_messages(
    messages: &mut Vec<Value>,
    hosted_emissions: &[crate::operation_runner::HostedHistoryEmission],
) {
    if hosted_emissions.is_empty() {
        return;
    }
    let mut hosted_by_message = std::collections::BTreeMap::new();
    for emission in hosted_emissions {
        hosted_by_message
            .entry(emission.canonical_message_index)
            .or_insert_with(Vec::new)
            .push(emission);
    }
    let mut output = Vec::with_capacity(messages.len() + hosted_emissions.len());
    for (message_index, message) in messages.drain(..).enumerate() {
        if let Some(emissions) = hosted_by_message.get(&message_index) {
            for emission in emissions {
                output.push(emission.chat_assistant.clone());
                output.push(emission.chat_tool_result.clone());
            }
            // The registered canonical anchor is only the carrier for the
            // single current event; its derived pair replaces it on the wire.
            continue;
        }
        output.push(message);
    }
    *messages = output;
}

/// Project a canonical history message into the OpenAI Chat provider shape.
///
/// The registered Responses history walker keeps the original item
/// discriminator inline and a text-only `content` array. The Chat provider wire
/// has no message-level `type`, and the established provider shape collapses a
/// text-only content array to its joined string. Non-text content keeps its
/// array so images and other representable parts stay intact.
fn project_openai_chat_provider_message_shape(message_row: &mut Map<String, Value>) {
    if message_row.get("type").and_then(Value::as_str) != Some("message") {
        return;
    }
    message_row.remove("type");
    let Some(Value::Array(parts)) = message_row.get("content") else {
        return;
    };
    let mut text = String::new();
    for part in parts {
        let Some(part) = part.as_object() else {
            return;
        };
        if part.get("type").and_then(Value::as_str) != Some("text")
            || part.len() != 2
        {
            return;
        }
        let Some(part_text) = part.get("text").and_then(Value::as_str) else {
            return;
        };
        text.push_str(part_text);
    }
    message_row.insert("content".to_string(), Value::String(text));
}

fn consume_routecodex_chat_extension_for_openai_chat_provider(
    message_row: &mut Map<String, Value>,
) {
    remove_object_field(message_row, "routecodex_chat_extension");
    let Some(tool_calls) = message_row
        .get_mut("tool_calls")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for tool_call in tool_calls {
        if let Some(tool_call_row) = tool_call.as_object_mut() {
            remove_object_field(tool_call_row, "routecodex_chat_extension");
        }
    }
}

fn remove_object_field(row: &mut Map<String, Value>, key: &str) -> Option<Value> {
    row.remove(key)
}

fn ensure_openai_chat_stream_usage_option(payload: &mut Value) {
    let Some(row) = payload.as_object_mut() else {
        return;
    };
    if row.get("stream").and_then(Value::as_bool) != Some(true) {
        return;
    }
    if row.contains_key("stream_options") {
        return;
    }
    row.insert("stream_options".to_string(), json!({"include_usage": true}));
}
