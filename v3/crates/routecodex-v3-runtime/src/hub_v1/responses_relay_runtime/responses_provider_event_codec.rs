use super::*;

pub(super) fn observe_v3_runtime_responses_sse_transport_chunk(
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    observation: &V3RuntimeStreamObservation,
    response_scaffold: &mut Option<Value>,
    output_items: &mut Vec<Value>,
    output_text: &mut String,
) -> Result<Option<Value>, V3ResponsesRelayRuntimeError> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    let mut terminal_response = None;
    for frame in frames {
        let Some((event_type, data)) = parse_v3_runtime_sse_frame_fields(&frame)? else {
            continue;
        };
        if data == "[DONE]" {
            continue;
        }
        let event: Value = serde_json::from_str(&data).map_err(|error| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "V3 Responses Relay response event payload is malformed: {error}"
            ))
        })?;
        if let Some(message) = extract_v3_provider_event_error_payload_message(&event) {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                message,
            ));
        }
        observation
            .record_provider_event_json(&event)
            .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
        collect_v3_runtime_responses_event_payload_evidence(
            event_type.as_deref(),
            &event,
            response_scaffold,
            output_items,
            output_text,
        )?;
        if let Some(response) = apply_v3_runtime_responses_semantic_event(
            event_type.as_deref(),
            &event,
            response_scaffold,
            output_items,
            output_text,
        )? {
            terminal_response = Some(response);
        }
    }
    Ok(terminal_response)
}

fn apply_v3_runtime_responses_semantic_event(
    frame_event_type: Option<&str>,
    event: &Value,
    response_scaffold: &mut Option<Value>,
    output_items: &[Value],
    output_text: &str,
) -> Result<Option<Value>, V3ResponsesRelayRuntimeError> {
    let semantic_event_type =
        frame_event_type.or_else(|| event.get("type").and_then(Value::as_str));
    match semantic_event_type {
        Some("response.created" | "response.in_progress") => {
            if response_scaffold.is_none() {
                *response_scaffold = Some(
                    event
                        .get("response")
                        .cloned()
                        .unwrap_or_else(|| event.clone()),
                );
            }
            Ok(None)
        }
        Some("response.completed") => {
            let mut response = event
                .get("response")
                .cloned()
                .unwrap_or_else(|| event.clone());
            merge_v3_runtime_responses_scaffold(&mut response, response_scaffold.as_ref());
            attach_required_action_from_sse_event(&mut response, event);
            apply_responses_stream_protocol_events_to_terminal_response(
                &mut response,
                output_items,
                output_text,
            )?;
            Ok(Some(response))
        }
        Some(
            "response.failed"
            | "response.incomplete"
            | "response.cancelled"
            | "response.canceled"
            | "response.error",
        ) => {
            let message = event
                .pointer("/response/error/message")
                .or_else(|| event.pointer("/error/message"))
                .or_else(|| event.pointer("/response/incomplete_details/reason"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(V3_RESPONSES_RELAY_PROVIDER_EVENT_FAILED_MESSAGE);
            Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                message.to_string(),
            ))
        }
        Some(
            "response.output_item.added"
            | "response.output_item.done"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.reasoning_text.delta"
            | "response.reasoning_text.done"
            | "response.reasoning_signature.delta"
            | "response.reasoning_image.delta"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.output_text.delta"
            | "response.output_text.done"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.custom_tool_call_input.delta"
            | "response.custom_tool_call_input.done"
            | "response.requires_action"
            | "response.done",
        ) => Ok(None),
        Some(other) if other.starts_with("response.") => {
            Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                format!("V3 Responses Relay response event type {other} is unsupported"),
            ))
        }
        _ => Ok(None),
    }
}

fn merge_v3_runtime_responses_scaffold(response: &mut Value, scaffold: Option<&Value>) {
    let (Some(response), Some(scaffold)) = (
        response.as_object_mut(),
        scaffold.and_then(Value::as_object),
    ) else {
        return;
    };
    for (key, value) in scaffold {
        response.entry(key.clone()).or_insert_with(|| value.clone());
    }
}

fn attach_required_action_from_sse_event(response: &mut Value, event: &Value) {
    let Some(required_action) = event.get("required_action").cloned() else {
        return;
    };
    let Some(object) = response.as_object_mut() else {
        return;
    };
    object
        .entry("required_action".to_string())
        .or_insert(required_action);
}

pub(super) fn parse_v3_runtime_sse_frame_fields(
    frame: &routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
) -> Result<Option<(Option<String>, String)>, V3ResponsesRelayRuntimeError> {
    let mut event_type: Option<String> = None;
    let mut data = String::new();
    for field in frame.frame().fields() {
        let SseField::Named { name, value } = field else {
            continue;
        };
        match name.as_str() {
            "event" => event_type = Some(value.to_string()),
            "data" => {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value);
            }
            _ => {}
        }
    }
    let data = data.trim();
    if data.is_empty() {
        if let Some(message) = extract_v3_provider_event_error_message_from_sse_frame(frame) {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                message,
            ));
        }
        return Ok(None);
    }
    Ok(Some((event_type, data.to_string())))
}

fn extract_v3_provider_event_error_message_from_sse_frame(
    frame: &routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
) -> Option<String> {
    let raw = reconstruct_v3_runtime_sse_frame_text(frame)?;
    let payload = serde_json::from_str::<Value>(&raw).ok()?;
    extract_v3_provider_event_error_payload_message(&payload)
}

fn reconstruct_v3_runtime_sse_frame_text(
    frame: &routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
) -> Option<String> {
    let mut lines = Vec::new();
    for field in frame.frame().fields() {
        match field {
            SseField::Comment(value) => lines.push(format!(":{value}")),
            SseField::Named { name, value } if value.is_empty() => lines.push(name.clone()),
            SseField::Named { name, value } => lines.push(format!("{name}: {value}")),
        }
    }
    let text = lines.join("\n");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

pub(super) fn extract_v3_provider_event_error_payload_message(payload: &Value) -> Option<String> {
    let error = payload.get("error")?;
    match error {
        Value::Object(error) => {
            let message = read_v3_trimmed_string(error.get("message"))
                .or_else(|| read_v3_trimmed_string(error.get("error")))
                .or_else(|| read_v3_trimmed_string(error.get("detail")));
            let error_type = read_v3_trimmed_string(error.get("type"))
                .or_else(|| read_v3_trimmed_string(error.get("code")));
            match (error_type, message) {
                (Some(error_type), Some(message)) => {
                    Some(format!("provider event error {error_type}: {message}"))
                }
                (Some(error_type), None) => Some(format!("provider event error {error_type}")),
                (None, Some(message)) => Some(format!("provider event error: {message}")),
                (None, None) => None,
            }
        }
        Value::String(message) => {
            let message = message.trim();
            (!message.is_empty()).then(|| format!("provider event error: {message}"))
        }
        _ => None,
    }
}

fn collect_v3_runtime_responses_event_payload_evidence(
    event_type: Option<&str>,
    event: &Value,
    response_scaffold: &mut Option<Value>,
    output_items: &mut Vec<Value>,
    output_text: &mut String,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let semantic_event_type = event_type.or_else(|| event.get("type").and_then(Value::as_str));
    match semantic_event_type {
        Some("response.created" | "response.in_progress") => {
            if response_scaffold.is_none() {
                *response_scaffold = Some(
                    event
                        .get("response")
                        .cloned()
                        .unwrap_or_else(|| event.clone()),
                );
            }
        }
        Some("response.output_item.added" | "response.output_item.done") => {
            if let Some(item) = event.get("item").cloned() {
                upsert_v3_runtime_responses_event_output_item(output_items, item);
            }
        }
        Some("response.content_part.added" | "response.content_part.done") => {
            upsert_v3_runtime_responses_event_content_part(output_items, event);
        }
        Some("response.output_text.delta") => {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                output_text.push_str(delta);
            }
        }
        Some("response.output_text.done") => {
            if let Some(text) = event.get("text").and_then(Value::as_str) {
                output_text.clear();
                output_text.push_str(text);
            }
        }
        Some("response.function_call_arguments.delta") => {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                append_v3_runtime_responses_event_function_arguments(output_items, event, delta);
            }
        }
        Some("response.function_call_arguments.done") => {
            if let Some(arguments) = event.get("arguments").and_then(Value::as_str) {
                set_v3_runtime_responses_event_function_arguments(output_items, event, arguments);
            }
        }
        Some("response.custom_tool_call_input.delta") => {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                append_v3_runtime_responses_event_custom_tool_call_input(output_items, event, delta);
            }
        }
        Some("response.custom_tool_call_input.done") => {
            if let Some(input) = event.get("input").and_then(Value::as_str) {
                set_v3_runtime_responses_event_custom_tool_call_input(output_items, event, input);
            }
        }
        Some("response.reasoning_summary_part.added") => {
            upsert_v3_runtime_responses_event_reasoning_summary_part(output_items, event, false);
        }
        Some("response.reasoning_summary_part.done") => {
            upsert_v3_runtime_responses_event_reasoning_summary_part(output_items, event, true);
        }
        Some("response.reasoning_summary_text.delta") => {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                append_v3_runtime_responses_event_reasoning_summary_text(
                    output_items,
                    event,
                    delta,
                );
            }
        }
        Some("response.reasoning_summary_text.done") => {
            if let Some(text) = event.get("text").and_then(Value::as_str) {
                set_v3_runtime_responses_event_reasoning_summary_text(output_items, event, text);
            }
        }
        Some("response.reasoning_text.delta") => {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                append_v3_runtime_responses_event_reasoning_content_text(
                    output_items,
                    event,
                    delta,
                );
            }
        }
        Some("response.reasoning_text.done") => {
            let text = event
                .get("text")
                .or_else(|| event.get("delta"))
                .and_then(Value::as_str);
            if let Some(text) = text {
                set_v3_runtime_responses_event_reasoning_content_value(
                    output_items,
                    event,
                    "reasoning_text",
                    "text",
                    Value::String(text.to_string()),
                );
            }
        }
        Some("response.reasoning_signature.delta") => {
            if let Some(signature) = event.get("signature").cloned() {
                set_v3_runtime_responses_event_reasoning_content_value(
                    output_items,
                    event,
                    "reasoning_signature",
                    "signature",
                    signature,
                );
            }
        }
        Some("response.reasoning_image.delta") => {
            if let Some(image_url) = event.get("image_url").cloned() {
                set_v3_runtime_responses_event_reasoning_content_value(
                    output_items,
                    event,
                    "reasoning_image",
                    "image_url",
                    image_url,
                );
            }
        }
        Some(
            "response.completed"
            | "response.done"
            | "response.requires_action"
            | "response.failed"
            | "response.incomplete"
            | "response.error",
        ) => {}
        Some(other) if other.starts_with("response.") => {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                format!("V3 Responses Relay response event type {other} is unsupported"),
            ));
        }
        _ => {}
    }
    Ok(())
}

fn read_v3_runtime_responses_event_index(event: &Value, field: &str) -> Option<usize> {
    event
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn read_v3_runtime_responses_event_item_id(event: &Value) -> Option<&str> {
    event
        .get("item_id")
        .or_else(|| event.get("call_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn find_v3_runtime_responses_event_output_item_index(
    output_items: &[Value],
    event: &Value,
) -> Option<usize> {
    if let Some(item_id) = read_v3_runtime_responses_event_item_id(event) {
        if let Some(index) = output_items.iter().position(|item| {
            item.get("id")
                .or_else(|| item.get("call_id"))
                .and_then(Value::as_str)
                == Some(item_id)
        }) {
            return Some(index);
        }
    }
    read_v3_runtime_responses_event_index(event, "output_index")
        .filter(|index| *index < output_items.len())
}

fn ensure_v3_runtime_responses_event_output_item_index(
    output_items: &mut Vec<Value>,
    event: &Value,
    item_type: &str,
) -> Option<usize> {
    if let Some(index) = find_v3_runtime_responses_event_output_item_index(output_items, event) {
        return Some(index);
    }
    let item_id = read_v3_runtime_responses_event_item_id(event)?;
    let mut item = Map::new();
    item.insert("id".to_string(), Value::String(item_id.to_string()));
    item.insert("type".to_string(), Value::String(item_type.to_string()));
    output_items.push(Value::Object(item));
    Some(output_items.len() - 1)
}

fn ensure_v3_runtime_responses_event_array_field<'item>(
    item: &'item mut Value,
    field: &str,
) -> Option<&'item mut Vec<Value>> {
    let object = item.as_object_mut()?;
    object
        .entry(field.to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
}

fn ensure_v3_runtime_responses_event_summary_entry<'summary>(
    summary: &'summary mut Vec<Value>,
    summary_index: usize,
) -> Option<&'summary mut Value> {
    while summary.len() <= summary_index {
        summary.push(json!({"type":"summary_text","text":""}));
    }
    let entry = summary.get_mut(summary_index)?;
    if !entry.is_object() {
        *entry = json!({"type":"summary_text","text":""});
    }
    if let Some(object) = entry.as_object_mut() {
        object
            .entry("type".to_string())
            .or_insert_with(|| Value::String("summary_text".to_string()));
        object
            .entry("text".to_string())
            .or_insert_with(|| Value::String(String::new()));
    }
    Some(entry)
}

fn upsert_v3_runtime_responses_event_content_part(output_items: &mut Vec<Value>, event: &Value) {
    let Some(content_index) = read_v3_runtime_responses_event_index(event, "content_index") else {
        return;
    };
    let Some(part) = event
        .get("part")
        .or_else(|| event.get("content_part"))
        .cloned()
    else {
        return;
    };
    let Some(output_index) =
        ensure_v3_runtime_responses_event_output_item_index(output_items, event, "message")
    else {
        return;
    };
    let Some(content) =
        ensure_v3_runtime_responses_event_array_field(&mut output_items[output_index], "content")
    else {
        return;
    };
    while content.len() <= content_index {
        content.push(json!({"type":"output_text","text":""}));
    }
    content[content_index] = part;
}

fn upsert_v3_runtime_responses_event_reasoning_summary_part(
    output_items: &mut Vec<Value>,
    event: &Value,
    done: bool,
) {
    let Some(summary_index) = read_v3_runtime_responses_event_index(event, "summary_index") else {
        return;
    };
    let Some(output_index) =
        ensure_v3_runtime_responses_event_output_item_index(output_items, event, "reasoning")
    else {
        return;
    };
    let Some(summary) =
        ensure_v3_runtime_responses_event_array_field(&mut output_items[output_index], "summary")
    else {
        return;
    };
    let Some(entry) = ensure_v3_runtime_responses_event_summary_entry(summary, summary_index)
    else {
        return;
    };
    if !done {
        return;
    }
    let text = event
        .pointer("/part/text")
        .or_else(|| event.get("text"))
        .and_then(Value::as_str);
    if let Some(text) = text {
        entry["text"] = Value::String(text.to_string());
    }
}

fn append_v3_runtime_responses_event_reasoning_summary_text(
    output_items: &mut Vec<Value>,
    event: &Value,
    delta: &str,
) {
    let Some(summary_index) = read_v3_runtime_responses_event_index(event, "summary_index") else {
        return;
    };
    let Some(output_index) =
        ensure_v3_runtime_responses_event_output_item_index(output_items, event, "reasoning")
    else {
        return;
    };
    let Some(summary) =
        ensure_v3_runtime_responses_event_array_field(&mut output_items[output_index], "summary")
    else {
        return;
    };
    let Some(entry) = ensure_v3_runtime_responses_event_summary_entry(summary, summary_index)
    else {
        return;
    };
    let current = entry
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    entry["text"] = Value::String(format!("{current}{delta}"));
}

fn set_v3_runtime_responses_event_reasoning_summary_text(
    output_items: &mut Vec<Value>,
    event: &Value,
    text: &str,
) {
    let Some(summary_index) = read_v3_runtime_responses_event_index(event, "summary_index") else {
        return;
    };
    let Some(output_index) =
        ensure_v3_runtime_responses_event_output_item_index(output_items, event, "reasoning")
    else {
        return;
    };
    let Some(summary) =
        ensure_v3_runtime_responses_event_array_field(&mut output_items[output_index], "summary")
    else {
        return;
    };
    if let Some(entry) = ensure_v3_runtime_responses_event_summary_entry(summary, summary_index) {
        entry["text"] = Value::String(text.to_string());
    }
}

fn append_v3_runtime_responses_event_reasoning_content_text(
    output_items: &mut Vec<Value>,
    event: &Value,
    delta: &str,
) {
    let Some(current) = get_v3_runtime_responses_event_reasoning_content_value(
        output_items,
        event,
        "reasoning_text",
        "text",
    ) else {
        set_v3_runtime_responses_event_reasoning_content_value(
            output_items,
            event,
            "reasoning_text",
            "text",
            Value::String(delta.to_string()),
        );
        return;
    };
    set_v3_runtime_responses_event_reasoning_content_value(
        output_items,
        event,
        "reasoning_text",
        "text",
        Value::String(format!("{current}{delta}")),
    );
}

fn get_v3_runtime_responses_event_reasoning_content_value(
    output_items: &[Value],
    event: &Value,
    content_type: &str,
    field: &str,
) -> Option<String> {
    let output_index = find_v3_runtime_responses_event_output_item_index(output_items, event)?;
    let content_index = read_v3_runtime_responses_event_index(event, "content_index")?;
    output_items
        .get(output_index)?
        .get("content")?
        .as_array()?
        .get(content_index)?
        .get("type")
        .and_then(Value::as_str)
        .filter(|actual_type| *actual_type == content_type)?;
    output_items
        .get(output_index)?
        .get("content")?
        .as_array()?
        .get(content_index)?
        .get(field)?
        .as_str()
        .map(str::to_string)
}

fn set_v3_runtime_responses_event_reasoning_content_value(
    output_items: &mut Vec<Value>,
    event: &Value,
    content_type: &str,
    field: &str,
    value: Value,
) {
    let Some(content_index) = read_v3_runtime_responses_event_index(event, "content_index") else {
        return;
    };
    let Some(output_index) =
        ensure_v3_runtime_responses_event_output_item_index(output_items, event, "reasoning")
    else {
        return;
    };
    let Some(content) =
        ensure_v3_runtime_responses_event_array_field(&mut output_items[output_index], "content")
    else {
        return;
    };
    while content.len() <= content_index {
        content.push(json!({"type":content_type}));
    }
    if !content[content_index].is_object() {
        content[content_index] = json!({"type":content_type});
    }
    if let Some(object) = content[content_index].as_object_mut() {
        object.insert("type".to_string(), Value::String(content_type.to_string()));
        object.insert(field.to_string(), value);
    }
}

fn upsert_v3_runtime_responses_event_output_item(output_items: &mut Vec<Value>, item: Value) {
    let call_id = item
        .get("call_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(call_id) = call_id {
        if let Some(existing) = output_items.iter_mut().find(|existing| {
            existing
                .get("call_id")
                .or_else(|| existing.get("id"))
                .and_then(Value::as_str)
                == Some(call_id.as_str())
        }) {
            *existing = item;
            return;
        }
    }
    output_items.push(item);
}

fn append_v3_runtime_responses_event_function_arguments(
    output_items: &mut [Value],
    event: &Value,
    delta: &str,
) {
    let Some(item) = find_v3_runtime_responses_event_function_item_mut(output_items, event) else {
        return;
    };
    let current = item
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    item["arguments"] = Value::String(format!("{current}{delta}"));
}

fn set_v3_runtime_responses_event_function_arguments(
    output_items: &mut [Value],
    event: &Value,
    arguments: &str,
) {
    if let Some(item) = find_v3_runtime_responses_event_function_item_mut(output_items, event) {
        item["arguments"] = Value::String(arguments.to_string());
    }
}

fn append_v3_runtime_responses_event_custom_tool_call_input(
    output_items: &mut [Value],
    event: &Value,
    delta: &str,
) {
    let Some(item) = find_v3_runtime_responses_event_function_item_mut(output_items, event) else {
        return;
    };
    let current = item
        .get("input")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    item["input"] = Value::String(format!("{current}{delta}"));
}

fn set_v3_runtime_responses_event_custom_tool_call_input(
    output_items: &mut [Value],
    event: &Value,
    input: &str,
) {
    if let Some(item) = find_v3_runtime_responses_event_function_item_mut(output_items, event) {
        item["input"] = Value::String(input.to_string());
    }
}

fn find_v3_runtime_responses_event_function_item_mut<'items>(
    output_items: &'items mut [Value],
    event: &Value,
) -> Option<&'items mut Value> {
    if let Some(output_index) = event.get("output_index").and_then(Value::as_u64) {
        return output_items.get_mut(output_index as usize);
    }
    let call_id = event
        .get("call_id")
        .or_else(|| event.get("item_id"))
        .and_then(Value::as_str);
    if let Some(call_id) = call_id {
        return output_items.iter_mut().find(|item| {
            item.get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                == Some(call_id)
        });
    }
    output_items.iter_mut().rev().find(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call" | "custom_tool_call" | "tool_call")
        )
    })
}

fn apply_responses_stream_protocol_events_to_terminal_response(
    response: &mut Value,
    output_items: &[Value],
    output_text: &str,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let object = response.as_object_mut().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "V3 Responses Relay response event terminal response must be an object".to_string(),
        )
    })?;
    object
        .entry("status".to_string())
        .or_insert_with(|| Value::String("completed".to_string()));
    if !output_items.is_empty() {
        merge_v3_runtime_responses_stream_output_items_into_terminal_response(object, output_items);
    }
    let output_is_empty = object
        .get("output")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    if output_is_empty {
        if !output_text.trim().is_empty() {
            object.insert(
                "output".to_string(),
                json!([{"type":"output_text","text":output_text}]),
            );
        }
    } else if !output_text.trim().is_empty() {
        append_v3_runtime_responses_output_text_if_missing(object, output_text);
    }
    Ok(())
}

fn merge_v3_runtime_responses_stream_output_items_into_terminal_response(
    object: &mut Map<String, Value>,
    output_items: &[Value],
) {
    let output = object
        .entry("output".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !output.is_array() {
        *output = Value::Array(Vec::new());
    }
    let Some(output) = output.as_array_mut() else {
        return;
    };
    for (stream_index, stream_item) in output_items.iter().enumerate() {
        if let Some(target_index) =
            find_v3_runtime_responses_terminal_output_item_index(output, stream_item)
        {
            output[target_index] = merge_v3_runtime_responses_terminal_and_stream_output_item(
                &output[target_index],
                stream_item,
            );
            continue;
        }
        if output.get(stream_index) == Some(stream_item) {
            continue;
        }
        if stream_index < output.len() {
            output.insert(stream_index, stream_item.clone());
        } else {
            output.push(stream_item.clone());
        }
    }
}

fn find_v3_runtime_responses_terminal_output_item_index(
    output: &[Value],
    stream_item: &Value,
) -> Option<usize> {
    let identity = read_v3_runtime_responses_output_item_identity(stream_item)?;
    output
        .iter()
        .position(|item| read_v3_runtime_responses_output_item_identity(item) == Some(identity))
}

fn read_v3_runtime_responses_output_item_identity(item: &Value) -> Option<&str> {
    item.get("call_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            item.get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
}

fn merge_v3_runtime_responses_terminal_and_stream_output_item(
    terminal_item: &Value,
    stream_item: &Value,
) -> Value {
    let (Some(terminal), Some(stream)) = (terminal_item.as_object(), stream_item.as_object())
    else {
        return terminal_item.clone();
    };
    let mut merged = terminal.clone();
    for (key, value) in stream {
        merged.entry(key.clone()).or_insert_with(|| value.clone());
    }
    Value::Object(merged)
}

fn append_v3_runtime_responses_output_text_if_missing(
    object: &mut Map<String, Value>,
    output_text: &str,
) {
    let Some(output) = object.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    if output
        .iter()
        .any(v3_runtime_responses_output_item_has_visible_text)
    {
        return;
    }
    output.push(json!({"type":"output_text","text":output_text}));
}

fn v3_runtime_responses_output_item_has_visible_text(item: &Value) -> bool {
    if item.get("type").and_then(Value::as_str) == Some("output_text")
        && item
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
    {
        return true;
    }
    item.get("content")
        .and_then(Value::as_array)
        .is_some_and(|content| {
            content.iter().any(|part| {
                matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("output_text" | "text")
                ) && part
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty())
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_merge_matches_tool_calls_by_call_id_before_item_id() {
        let mut terminal = json!({
            "output": [{
                "type": "function_call",
                "call_id": "call_shared",
                "name": "exec_command",
                "arguments": "{}"
            }]
        });
        let stream_items = vec![json!({
            "type": "function_call",
            "id": "fc_stream",
            "call_id": "call_shared",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"pwd\"}"
        })];

        merge_v3_runtime_responses_stream_output_items_into_terminal_response(
            terminal.as_object_mut().expect("terminal response object"),
            &stream_items,
        );

        let output = terminal["output"].as_array().expect("terminal output");
        assert_eq!(output.len(), 1, "same tool call must not be duplicated");
        assert_eq!(output[0]["call_id"], "call_shared");
        assert_eq!(output[0]["id"], "fc_stream");
        assert_eq!(
            output[0]["arguments"], "{}",
            "response.completed arguments must remain authoritative"
        );
    }

    #[test]
    fn terminal_merge_keeps_distinct_tool_call_ids_separate() {
        let mut terminal = json!({
            "output": [{
                "type": "function_call",
                "id": "fc_shared",
                "call_id": "call_first",
                "name": "exec_command",
                "arguments": "{}"
            }]
        });
        let stream_items = vec![json!({
            "type": "function_call",
            "id": "fc_shared",
            "call_id": "call_second",
            "name": "exec_command",
            "arguments": "{}"
        })];

        merge_v3_runtime_responses_stream_output_items_into_terminal_response(
            terminal.as_object_mut().expect("terminal response object"),
            &stream_items,
        );

        let output = terminal["output"].as_array().expect("terminal output");
        assert_eq!(output.len(), 2, "distinct tool calls must remain separate");
    }

    #[test]
    fn terminal_merge_matches_tool_search_calls_by_call_id() {
        let mut terminal = json!({
            "output": [{
                "type": "tool_search_call",
                "call_id": "call_search",
                "status": "completed"
            }]
        });
        let stream_items = vec![json!({
            "type": "tool_search_call",
            "id": "ts_stream",
            "call_id": "call_search",
            "status": "in_progress"
        })];

        merge_v3_runtime_responses_stream_output_items_into_terminal_response(
            terminal.as_object_mut().expect("terminal response object"),
            &stream_items,
        );

        let output = terminal["output"].as_array().expect("terminal output");
        assert_eq!(
            output.len(),
            1,
            "same tool-search call must not be duplicated"
        );
        assert_eq!(output[0]["call_id"], "call_search");
        assert_eq!(output[0]["id"], "ts_stream");
        assert_eq!(
            output[0]["status"], "completed",
            "response.completed status must not regress to stream state"
        );
    }

    #[test]
    fn terminal_merge_matches_non_call_output_by_item_id() {
        let mut terminal = json!({
            "output": [{
                "type": "message",
                "id": "msg_shared",
                "role": "assistant",
                "content": []
            }]
        });
        let stream_items = vec![json!({
            "type": "message",
            "id": "msg_shared",
            "role": "assistant",
            "content": [{"type":"output_text","text":"ok"}]
        })];

        merge_v3_runtime_responses_stream_output_items_into_terminal_response(
            terminal.as_object_mut().expect("terminal response object"),
            &stream_items,
        );

        let output = terminal["output"].as_array().expect("terminal output");
        assert_eq!(output.len(), 1, "same message item must not be duplicated");
        assert_eq!(output[0]["id"], "msg_shared");
        assert_eq!(
            output[0]["content"],
            json!([]),
            "response.completed content must remain authoritative"
        );
    }
}
