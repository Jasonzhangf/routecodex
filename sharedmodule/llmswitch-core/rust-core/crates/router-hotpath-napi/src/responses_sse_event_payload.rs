use serde_json::{Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

fn current_unix_timestamp_ms() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Responses SSE event clock before UNIX_EPOCH: {}", error))?;
    i64::try_from(duration.as_millis())
        .map_err(|_| "Responses SSE event timestamp overflow".to_string())
}

pub fn build_responses_sse_event_envelope_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        format!(
            "Failed to parse Responses SSE event envelope JSON: {}",
            error
        )
    })?;
    let Some(input) = input.as_object() else {
        return Err("Responses SSE event envelope expected object".to_string());
    };
    let request_id = input
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Responses SSE event envelope missing request_id".to_string())?;
    let current_sequence = input
        .get("current_sequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Responses SSE event envelope missing current_sequence".to_string())?;
    if current_sequence < 0 {
        return Err(
            "Responses SSE event envelope current_sequence must be non-negative".to_string(),
        );
    }
    let enable_timestamp_generation = input
        .get("enable_timestamp_generation")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let enable_sequence_numbers = input
        .get("enable_sequence_numbers")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let sequence_number = if enable_sequence_numbers {
        current_sequence
    } else {
        0
    };
    let next_sequence_counter = if enable_sequence_numbers {
        current_sequence + 1
    } else {
        current_sequence
    };
    let timestamp = if enable_timestamp_generation {
        current_unix_timestamp_ms()?
    } else {
        0
    };

    serde_json::to_string(&serde_json::json!({
        "requestId": request_id,
        "timestamp": timestamp,
        "sequenceNumber": sequence_number,
        "nextSequenceCounter": next_sequence_counter,
        "protocol": "responses",
        "direction": "json_to_sse"
    }))
    .map_err(|error| {
        format!(
            "Failed to serialize Responses SSE event envelope JSON: {}",
            error
        )
    })
}

fn is_responses_sse_text_chunk_boundary(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            ',' | '.'
                | '!'
                | '?'
                | ';'
                | ':'
                | '-'
                | '，'
                | '。'
                | '、'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '！'
                | '？'
                | '\u{3000}'
        )
}

pub fn build_responses_sse_text_chunks(
    text: &str,
    chunk_size: Option<i64>,
) -> Result<Vec<String>, String> {
    let size = chunk_size.unwrap_or(0);
    if size <= 0 {
        return Ok(vec![text.to_string()]);
    }

    let chunk_size = usize::try_from(size)
        .map_err(|_| "Responses SSE text chunk size is invalid".to_string())?
        .max(1);
    let boundary_threshold = std::cmp::max(4, chunk_size / 2);
    let mut chunks: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut buf_len_utf16 = 0usize;

    for ch in text.chars() {
        buf.push(ch);
        buf_len_utf16 += ch.len_utf16();
        if buf_len_utf16 >= chunk_size
            || (is_responses_sse_text_chunk_boundary(ch) && buf_len_utf16 >= boundary_threshold)
        {
            if !buf.is_empty() {
                chunks.push(std::mem::take(&mut buf));
                buf_len_utf16 = 0;
            }
        }
    }

    if !buf.is_empty() {
        chunks.push(buf);
    }
    Ok(chunks)
}

pub fn build_responses_sse_text_chunks_json(payload_json: String) -> Result<String, String> {
    let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
        format!(
            "Failed to parse Responses SSE text chunk payload JSON: {}",
            error
        )
    })?;
    let Some(source) = payload.as_object() else {
        return Err("Responses SSE text chunk payload expected object".to_string());
    };
    let text = source
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "Responses SSE text chunk payload missing text".to_string())?;
    let chunk_size = source.get("chunk_size").and_then(Value::as_i64);
    let chunks = build_responses_sse_text_chunks(text, chunk_size)?;
    serde_json::to_string(&chunks).map_err(|error| {
        format!(
            "Failed to serialize Responses SSE text chunks JSON: {}",
            error
        )
    })
}

fn read_required_created_at(source: &Map<String, Value>) -> Result<Value, String> {
    let Some(created_at) = source.get("created_at") else {
        return Err("Invalid Responses response: missing created_at".to_string());
    };
    if created_at.as_i64().is_some_and(|value| value > 0)
        || created_at.as_u64().is_some_and(|value| value > 0)
    {
        return Ok(created_at.clone());
    }
    Err("Invalid Responses response: missing created_at".to_string())
}

fn read_required_usage_token(usage: &Map<String, Value>, field: &str) -> Result<i64, String> {
    let Some(value) = usage.get(field) else {
        return Err("Invalid Responses usage: missing token fields".to_string());
    };
    let parsed = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    let Some(number) = parsed else {
        return Err(format!("Invalid Responses usage.{}", field));
    };
    if !number.is_finite() || number < 0.0 {
        return Err(format!("Invalid Responses usage.{}", field));
    }
    Ok(number.round() as i64)
}

fn normalize_strict_responses_usage(usage_raw: &Value) -> Result<Value, String> {
    let Some(usage) = usage_raw.as_object() else {
        return Err("Invalid Responses usage: expected object".to_string());
    };
    let input_tokens = read_required_usage_token(usage, "input_tokens")?;
    let output_tokens = read_required_usage_token(usage, "output_tokens")?;
    let total_tokens = read_required_usage_token(usage, "total_tokens")?;

    let mut out = Map::new();
    out.insert("input_tokens".to_string(), Value::from(input_tokens));
    out.insert("output_tokens".to_string(), Value::from(output_tokens));
    out.insert("total_tokens".to_string(), Value::from(total_tokens));

    if let Some(details_raw) = usage.get("input_tokens_details") {
        let Some(details) = details_raw.as_object() else {
            return Err("Invalid Responses usage cached_tokens".to_string());
        };
        if let Some(cached_raw) = details.get("cached_tokens") {
            let parsed = match cached_raw {
                Value::Number(number) => number.as_f64(),
                Value::String(text) => text.trim().parse::<f64>().ok(),
                _ => None,
            };
            let Some(cached) = parsed else {
                return Err("Invalid Responses usage cached_tokens".to_string());
            };
            if !cached.is_finite() || cached < 0.0 {
                return Err("Invalid Responses usage cached_tokens".to_string());
            }
            let mut details_out = Map::new();
            details_out.insert(
                "cached_tokens".to_string(),
                Value::from(cached.round() as i64),
            );
            out.insert(
                "input_tokens_details".to_string(),
                Value::Object(details_out),
            );
        }
    }

    Ok(Value::Object(out))
}

fn read_required_response_string(
    source: &Map<String, Value>,
    field: &str,
    message: &str,
) -> Result<String, String> {
    source
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| message.to_string())
}

fn normalize_responses_sse_reasoning_summary(summary_raw: &Value) -> Result<Value, String> {
    if summary_raw.is_null() {
        return Ok(Value::Array(Vec::new()));
    }
    let Some(summary) = summary_raw.as_array() else {
        return Err("Responses reasoning summary must be an array".to_string());
    };

    let mut normalized: Vec<Value> = Vec::new();
    for (index, entry) in summary.iter().enumerate() {
        if let Some(text) = entry.as_str() {
            if text.is_empty() {
                return Err(format!(
                    "Responses reasoning summary entry missing text at index {}",
                    index
                ));
            }
            normalized.push(serde_json::json!({
                "type": "summary_text",
                "text": text
            }));
            continue;
        }

        let Some(row) = entry.as_object() else {
            return Err(format!(
                "Responses reasoning summary entry must be an object or string at index {}",
                index
            ));
        };
        let Some(text) = row.get("text").and_then(Value::as_str) else {
            return Err(format!(
                "Responses reasoning summary entry missing text at index {}",
                index
            ));
        };
        if text.is_empty() {
            return Err(format!(
                "Responses reasoning summary entry missing text at index {}",
                index
            ));
        }
        normalized.push(serde_json::json!({
            "type": "summary_text",
            "text": text
        }));
    }

    Ok(Value::Array(normalized))
}

fn insert_string_if_present(
    target: &mut Map<String, Value>,
    source: &Map<String, Value>,
    field: &str,
) {
    if let Some(text) = source.get(field).and_then(Value::as_str) {
        if !text.is_empty() {
            target.insert(field.to_string(), Value::String(text.to_string()));
        }
    }
}

fn validate_reasoning_content_shape(source: &Map<String, Value>) -> Result<(), String> {
    if let Some(content) = source.get("content") {
        if !content.is_array() {
            return Err("Invalid Responses reasoning content: expected array".to_string());
        }
    }
    Ok(())
}

fn build_responses_sse_output_item_added_descriptor(
    source: &Map<String, Value>,
) -> Result<Value, String> {
    let item_type = source
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Responses output item descriptor missing type".to_string())?;

    let mut item = Map::new();
    insert_string_if_present(&mut item, source, "id");
    item.insert("type".to_string(), Value::String(item_type.to_string()));
    item.insert(
        "status".to_string(),
        Value::String("in_progress".to_string()),
    );

    match item_type {
        "message" => {
            insert_string_if_present(&mut item, source, "role");
            item.insert("content".to_string(), Value::Array(Vec::new()));
        }
        "function_call" => {
            insert_string_if_present(&mut item, source, "name");
            insert_string_if_present(&mut item, source, "call_id");
            item.insert("arguments".to_string(), Value::String(String::new()));
        }
        "function_call_output" => {
            insert_string_if_present(&mut item, source, "call_id");
            insert_string_if_present(&mut item, source, "tool_call_id");
            if let Some(output) = source.get("output") {
                item.insert("output".to_string(), output.clone());
            }
        }
        "reasoning" => {
            validate_reasoning_content_shape(source)?;
            if let Some(summary) = source.get("summary") {
                let normalized = normalize_responses_sse_reasoning_summary(summary)?;
                if normalized
                    .as_array()
                    .is_some_and(|entries| !entries.is_empty())
                {
                    item.insert("summary".to_string(), normalized);
                }
            }
            insert_string_if_present(&mut item, source, "encrypted_content");
        }
        _ => {}
    }

    Ok(Value::Object(item))
}

fn build_responses_sse_output_item_done_descriptor(
    source: &Map<String, Value>,
) -> Result<Value, String> {
    let mut item = source.clone();
    item.insert("status".to_string(), Value::String("completed".to_string()));
    if source.get("type").and_then(Value::as_str) == Some("reasoning") {
        validate_reasoning_content_shape(source)?;
        if let Some(summary) = source.get("summary") {
            let normalized = normalize_responses_sse_reasoning_summary(summary)?;
            if normalized
                .as_array()
                .is_some_and(|entries| !entries.is_empty())
            {
                item.insert("summary".to_string(), normalized);
            } else {
                item.remove("summary");
            }
        }
    }
    Ok(Value::Object(item))
}

pub fn build_responses_sse_output_item_descriptor(
    output_item: Value,
    lifecycle: Option<&str>,
) -> Result<Value, String> {
    let source = output_item
        .as_object()
        .ok_or_else(|| "Responses output item descriptor expected object".to_string())?;
    match lifecycle.unwrap_or("done") {
        "added" => build_responses_sse_output_item_added_descriptor(source),
        "done" => build_responses_sse_output_item_done_descriptor(source),
        other => Err(format!(
            "Unsupported Responses output item descriptor lifecycle: {}",
            other
        )),
    }
}

fn build_responses_sse_content_part_added_descriptor(
    source: &Map<String, Value>,
) -> Result<Value, String> {
    let part_type = source
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Responses content part descriptor missing type".to_string())?;

    let mut part = Map::new();
    part.insert("type".to_string(), Value::String(part_type.to_string()));
    match part_type {
        "input_text" => {
            let text = source
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "Responses content part descriptor missing text".to_string())?;
            part.insert("text".to_string(), Value::String(text.to_string()));
        }
        "output_text" => {
            let text = source
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "Responses content part descriptor missing text".to_string())?;
            part.insert("text".to_string(), Value::String(text.to_string()));
            part.insert(
                "annotations".to_string(),
                source
                    .get("annotations")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new())),
            );
            part.insert(
                "logprobs".to_string(),
                source
                    .get("logprobs")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new())),
            );
        }
        "input_image" => {
            if let Some(image_url) = source.get("image_url") {
                part.insert("image_url".to_string(), image_url.clone());
            }
            insert_string_if_present(&mut part, source, "detail");
        }
        "file_search" => {
            if let Some(value) = source.get("file_search") {
                part.insert("file_search".to_string(), value.clone());
            }
        }
        "computer_use" => {
            if let Some(value) = source.get("computer_use") {
                part.insert("computer_use".to_string(), value.clone());
            }
        }
        "function_call" => {
            if let Some(value) = source.get("name") {
                part.insert("name".to_string(), value.clone());
            }
            if let Some(value) = source.get("arguments") {
                part.insert("arguments".to_string(), value.clone());
            }
        }
        "function_result" => {
            if let Some(value) = source.get("result") {
                part.insert("result".to_string(), value.clone());
            }
            if let Some(value) = source.get("tool_call_id") {
                part.insert("tool_call_id".to_string(), value.clone());
            }
        }
        "conversation" => {
            if let Some(value) = source.get("conversation") {
                part.insert("conversation".to_string(), value.clone());
            }
        }
        _ => {}
    }

    Ok(Value::Object(part))
}

fn build_responses_sse_content_part_done_descriptor(
    source: &Map<String, Value>,
) -> Result<Value, String> {
    let part_type = source
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Responses content part descriptor missing type".to_string())?;

    let mut part = Map::new();
    part.insert("type".to_string(), Value::String(part_type.to_string()));
    match part_type {
        "input_text" | "output_text" => {
            let text = source
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "Responses content part descriptor missing text".to_string())?;
            part.insert("text".to_string(), Value::String(text.to_string()));
            if part_type == "output_text" {
                part.insert(
                    "annotations".to_string(),
                    source
                        .get("annotations")
                        .cloned()
                        .unwrap_or_else(|| Value::Array(Vec::new())),
                );
                part.insert(
                    "logprobs".to_string(),
                    source
                        .get("logprobs")
                        .cloned()
                        .unwrap_or_else(|| Value::Array(Vec::new())),
                );
            }
        }
        "input_image" => {
            if let Some(image_url) = source.get("image_url") {
                part.insert("image_url".to_string(), image_url.clone());
            }
            insert_string_if_present(&mut part, source, "detail");
        }
        "function_call" => {
            if let Some(value) = source.get("name") {
                part.insert("name".to_string(), value.clone());
            }
            if let Some(value) = source.get("arguments") {
                part.insert("arguments".to_string(), value.clone());
            }
        }
        "function_result" => {
            if let Some(value) = source.get("result") {
                part.insert("result".to_string(), value.clone());
            }
            if let Some(value) = source.get("tool_call_id") {
                part.insert("tool_call_id".to_string(), value.clone());
            }
        }
        "conversation" => {
            if let Some(value) = source.get("conversation") {
                part.insert("conversation".to_string(), value.clone());
            }
        }
        _ => {}
    }

    Ok(Value::Object(part))
}

pub fn build_responses_sse_content_part_descriptor(
    content_part: Value,
    lifecycle: Option<&str>,
) -> Result<Value, String> {
    let source = content_part
        .as_object()
        .ok_or_else(|| "Responses content part descriptor expected object".to_string())?;
    match lifecycle.unwrap_or("done") {
        "added" => build_responses_sse_content_part_added_descriptor(source),
        "done" => build_responses_sse_content_part_done_descriptor(source),
        other => Err(format!(
            "Unsupported Responses content part descriptor lifecycle: {}",
            other
        )),
    }
}

pub fn build_responses_sse_output_text_done_payload(
    output_index: i64,
    item_id: &str,
    content_index: i64,
    text: &str,
) -> Result<Value, String> {
    if item_id.trim().is_empty() {
        return Err("Responses output text done payload item_id is required".to_string());
    }
    Ok(serde_json::json!({
        "output_index": output_index,
        "item_id": item_id,
        "content_index": content_index,
        "text": text,
        "logprobs": []
    }))
}

pub fn build_responses_sse_output_text_delta_payload(
    output_index: i64,
    item_id: &str,
    content_index: i64,
    delta: &str,
) -> Result<Value, String> {
    if item_id.trim().is_empty() {
        return Err("Responses output text delta payload item_id is required".to_string());
    }
    Ok(serde_json::json!({
        "output_index": output_index,
        "item_id": item_id,
        "content_index": content_index,
        "delta": delta,
        "logprobs": []
    }))
}

fn read_responses_sse_output_text_payload_args(
    payload_json: String,
    label: &str,
) -> Result<(i64, String, i64, String), String> {
    let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
        format!(
            "Failed to parse Responses {} payload JSON: {}",
            label, error
        )
    })?;
    let Some(source) = payload.as_object() else {
        return Err(format!("Responses {} payload expected object", label));
    };
    let output_index = source
        .get("output_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Responses {} payload missing output_index", label))?;
    let item_id = source
        .get("item_id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Responses {} payload missing item_id", label))?
        .to_string();
    let content_index = source
        .get("content_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Responses {} payload missing content_index", label))?;
    let text = source
        .get("text")
        .or_else(|| source.get("delta"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Responses {} payload missing text", label))?
        .to_string();
    Ok((output_index, item_id, content_index, text))
}

pub fn build_responses_sse_output_text_delta_payload_json(
    payload_json: String,
) -> Result<String, String> {
    let (output_index, item_id, content_index, delta) =
        read_responses_sse_output_text_payload_args(payload_json, "output text delta")?;
    let output = build_responses_sse_output_text_delta_payload(
        output_index,
        &item_id,
        content_index,
        &delta,
    )?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses output text delta payload JSON: {}",
            error
        )
    })
}

pub fn build_responses_sse_output_text_done_payload_json(
    payload_json: String,
) -> Result<String, String> {
    let (output_index, item_id, content_index, text) =
        read_responses_sse_output_text_payload_args(payload_json, "output text done")?;
    let output =
        build_responses_sse_output_text_done_payload(output_index, &item_id, content_index, &text)?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses output text done payload JSON: {}",
            error
        )
    })
}

fn event_type(input: &Map<String, Value>) -> Result<&str, String> {
    input
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Responses SSE event missing type".to_string())
}

fn read_sequence_number(input: &Map<String, Value>) -> Option<Value> {
    input.get("sequenceNumber").cloned()
}

fn supported_responses_sse_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "response.created"
            | "response.in_progress"
            | "response.reasoning_text.delta"
            | "response.reasoning_text.done"
            | "response.reasoning_signature.delta"
            | "response.reasoning_image.delta"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.output_item.added"
            | "response.output_item.done"
            | "response.output_text.delta"
            | "response.output_text.done"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.required_action"
            | "response.completed"
            | "response.done"
            | "response.error"
            | "response.cancelled"
            | "response.failed"
            | "response.incomplete"
    )
}

fn data_object(input: &Map<String, Value>, event_type: &str) -> Result<Map<String, Value>, String> {
    match input.get("data") {
        Some(Value::Object(map)) => Ok(map.clone()),
        _ => Err(format!(
            "Responses event payload must be an object before serialization: {}",
            event_type
        )),
    }
}

pub fn canonicalize_responses_sse_event_payload(value: Value) -> Result<Value, String> {
    let mut event = match value {
        Value::Object(map) => map,
        _ => return Err("Responses SSE event must be an object".to_string()),
    };
    let event_type_owned = event_type(&event)?.to_string();
    let mut data = data_object(&event, &event_type_owned)?;
    if let Some(Value::String(payload_type)) = data.get("type") {
        if payload_type != &event_type_owned {
            return Err(format!(
                "Responses event payload type mismatch: event={} payload={}",
                event_type_owned, payload_type
            ));
        }
    } else if data.contains_key("type") {
        return Err(format!(
            "Responses event payload type must be a string: {}",
            event_type_owned
        ));
    }

    data.insert("type".to_string(), Value::String(event_type_owned));
    if !data.contains_key("sequence_number") {
        if let Some(sequence_number) = read_sequence_number(&event) {
            data.insert("sequence_number".to_string(), sequence_number);
        }
    }
    event.insert("data".to_string(), Value::Object(data));
    Ok(Value::Object(event))
}

pub fn canonicalize_responses_sse_event_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse Responses SSE event JSON: {}", error))?;
    let output = canonicalize_responses_sse_event_payload(input)?;
    serde_json::to_string(&output)
        .map_err(|error| format!("Failed to serialize Responses SSE event JSON: {}", error))
}

pub fn serialize_responses_sse_event_to_wire(event: Value) -> Result<String, String> {
    let event = match event {
        Value::Object(map) => map,
        _ => return Err("Responses SSE event must be an object".to_string()),
    };
    let event_type_owned = event_type(&event)?.to_string();
    if !supported_responses_sse_event_type(&event_type_owned) {
        return Err(format!(
            "Unsupported ResponsesSseEvent type: {}",
            event_type_owned
        ));
    }
    let data = data_object(&event, &event_type_owned)?;
    let Some(Value::String(payload_type)) = data.get("type") else {
        return Err(format!(
            "Responses SSE payload missing canonical type for {}",
            event_type_owned
        ));
    };
    if payload_type != &event_type_owned {
        return Err(format!(
            "Responses SSE payload missing canonical type for {}",
            event_type_owned
        ));
    }

    let mut wire = format!(
        "event: {}\ndata: {}\n",
        event_type_owned,
        serde_json::to_string(&Value::Object(data)).map_err(|error| {
            format!(
                "Failed to serialize Responses SSE event payload JSON: {}",
                error
            )
        })?
    );
    if let Some(timestamp) = event.get("timestamp") {
        if !timestamp.is_null() {
            match timestamp {
                Value::Number(number) => {
                    wire.push_str("id: ");
                    wire.push_str(&number.to_string());
                    wire.push('\n');
                }
                Value::String(text) if !text.trim().is_empty() => {
                    wire.push_str("id: ");
                    wire.push_str(text);
                    wire.push('\n');
                }
                _ => {}
            }
        }
    }
    wire.push('\n');
    Ok(wire)
}

pub fn serialize_responses_sse_event_to_wire_json(event_json: String) -> Result<String, String> {
    let event: Value = serde_json::from_str(&event_json)
        .map_err(|error| format!("Failed to parse Responses SSE event JSON: {}", error))?;
    serialize_responses_sse_event_to_wire(event)
}

fn parse_responses_sse_timestamp(source: Option<&str>) -> Result<i64, String> {
    let Some(source) = source else {
        return Err("Missing Responses SSE timestamp".to_string());
    };
    let source = source.trim();
    if source.is_empty() {
        return Err("Missing Responses SSE timestamp".to_string());
    }
    source
        .parse::<i64>()
        .map_err(|_| format!("Invalid Responses SSE timestamp: {}", source))
}

pub fn deserialize_responses_sse_event_from_wire(wire_data: &str) -> Result<Value, String> {
    let mut event_type_value: Option<String> = None;
    let mut event_data: Option<Value> = None;
    let mut event_id: Option<String> = None;

    for line in wire_data.trim().split('\n') {
        if let Some(value) = line.strip_prefix("event:") {
            event_type_value = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            let data_str = value.trim();
            let parsed: Value = serde_json::from_str(data_str).map_err(|error| {
                format!(
                    "Invalid Responses SSE data payload: {}; {}",
                    data_str, error
                )
            })?;
            event_data = Some(parsed);
        } else if let Some(value) = line.strip_prefix("id:") {
            event_id = Some(value.trim().to_string());
        }
    }

    let Some(event_type_value) = event_type_value.filter(|value| !value.is_empty()) else {
        return Err("Missing event type in SSE data".to_string());
    };
    let timestamp = parse_responses_sse_timestamp(event_id.as_deref())?;
    Ok(serde_json::json!({
        "type": event_type_value,
        "timestamp": timestamp,
        "data": event_data.unwrap_or(Value::Null),
        "protocol": "responses",
        "direction": "sse_to_json"
    }))
}

pub fn deserialize_responses_sse_event_from_wire_json(
    wire_data_json: String,
) -> Result<String, String> {
    let wire_data: Value = serde_json::from_str(&wire_data_json)
        .map_err(|error| format!("Failed to parse Responses SSE wire data JSON: {}", error))?;
    let Some(wire_data) = wire_data.as_str() else {
        return Err("Responses SSE wire data must be a string".to_string());
    };
    let output = deserialize_responses_sse_event_from_wire(wire_data)?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses SSE deserialized event JSON: {}",
            error
        )
    })
}

pub fn validate_responses_sse_wire_format(wire_data: &str) -> Result<bool, String> {
    let mut has_event = false;
    let mut has_data = false;
    for line in wire_data.trim().split('\n') {
        if line.starts_with("event:") {
            has_event = true;
        } else if line.starts_with("data:") {
            has_data = true;
        }
    }
    Ok(has_event && has_data)
}

pub fn validate_responses_sse_wire_format_json(wire_data_json: String) -> Result<String, String> {
    let wire_data: Value = serde_json::from_str(&wire_data_json)
        .map_err(|error| format!("Failed to parse Responses SSE wire data JSON: {}", error))?;
    let Some(wire_data) = wire_data.as_str() else {
        return Err("Responses SSE wire data must be a string".to_string());
    };
    serde_json::to_string(&validate_responses_sse_wire_format(wire_data)?).map_err(|error| {
        format!(
            "Failed to serialize Responses SSE wire validation JSON: {}",
            error
        )
    })
}

pub fn normalize_responses_sse_response_payload(
    response: Value,
    status: Option<&str>,
) -> Result<Value, String> {
    let source = match response {
        Value::Object(map) => map,
        _ => return Err("Invalid Responses response payload: expected object".to_string()),
    };

    let mut payload_row = source.clone();
    payload_row.remove("metadata");
    let object = read_required_response_string(
        &source,
        "object",
        "Invalid Responses response: missing object",
    )?;
    if object != "response" {
        return Err("Invalid Responses response: object must be response".to_string());
    }
    let id =
        read_required_response_string(&source, "id", "Invalid Responses response: missing id")?;
    let model = read_required_response_string(
        &source,
        "model",
        "Invalid Responses response: missing model",
    )?;
    let explicit_status = source
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid Responses response: missing status".to_string())?;
    let response_output = source
        .get("output")
        .filter(|value| value.is_array())
        .cloned()
        .ok_or_else(|| "Invalid Responses response: missing output array".to_string())?;

    payload_row.insert("object".to_string(), Value::String(object));
    payload_row.insert("id".to_string(), Value::String(id));
    payload_row.insert("model".to_string(), Value::String(model));
    payload_row.insert("created_at".to_string(), read_required_created_at(&source)?);
    payload_row.insert(
        "status".to_string(),
        Value::String(status.unwrap_or(explicit_status).to_string()),
    );
    payload_row.insert("output".to_string(), response_output);
    if !payload_row.contains_key("background") {
        payload_row.insert("background".to_string(), Value::Bool(false));
    }
    if !payload_row.contains_key("error") {
        payload_row.insert("error".to_string(), Value::Null);
    }
    if !payload_row.contains_key("incomplete_details") {
        payload_row.insert("incomplete_details".to_string(), Value::Null);
    }

    if let Some(usage_raw) = payload_row.get("usage").cloned() {
        payload_row.insert(
            "usage".to_string(),
            normalize_strict_responses_usage(&usage_raw)?,
        );
    }

    Ok(Value::Object(payload_row))
}

pub fn normalize_responses_sse_response_payload_json(
    response_json: String,
    status_json: Option<String>,
) -> Result<String, String> {
    let response: Value = serde_json::from_str(&response_json)
        .map_err(|error| format!("Failed to parse Responses response JSON: {}", error))?;
    let status = status_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let output = normalize_responses_sse_response_payload(response, status)?;
    serde_json::to_string(&output)
        .map_err(|error| format!("Failed to serialize Responses response JSON: {}", error))
}

pub fn build_responses_sse_response_event_payload(
    response: Value,
    status: Option<&str>,
    lifecycle: &str,
    required_action: Option<Value>,
) -> Result<Value, String> {
    let mut response_payload = normalize_responses_sse_response_payload(response, status)?;
    if lifecycle == "start" {
        let Some(row) = response_payload.as_object_mut() else {
            return Err("Responses SSE response event payload expected object".to_string());
        };
        if row.contains_key("output") {
            row.insert("output".to_string(), Value::Array(Vec::new()));
        }
    }

    let mut payload = Map::new();
    payload.insert("response".to_string(), response_payload);
    if lifecycle == "required_action" {
        let Some(action) = required_action else {
            return Err(
                "Responses SSE required_action payload missing required_action".to_string(),
            );
        };
        payload.insert("required_action".to_string(), action);
    }
    Ok(Value::Object(payload))
}

pub fn build_responses_sse_response_event_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> Result<String, String> {
    let lifecycle = lifecycle_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Responses SSE response event payload lifecycle is required".to_string())?;
    let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
        format!(
            "Failed to parse Responses SSE response event payload JSON: {}",
            error
        )
    })?;
    let Some(source) = payload.as_object() else {
        return Err("Responses SSE response event payload expected object".to_string());
    };
    let response = source
        .get("response")
        .cloned()
        .ok_or_else(|| "Responses SSE response event payload missing response".to_string())?;
    let status = source
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let required_action = source.get("required_action").cloned();
    let output =
        build_responses_sse_response_event_payload(response, status, lifecycle, required_action)?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses SSE response event payload JSON: {}",
            error
        )
    })
}

pub fn normalize_responses_sse_reasoning_summary_json(
    summary_json: String,
) -> Result<String, String> {
    let summary: Value = serde_json::from_str(&summary_json).map_err(|error| {
        format!(
            "Failed to parse Responses reasoning summary JSON: {}",
            error
        )
    })?;
    let output = normalize_responses_sse_reasoning_summary(&summary)?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses reasoning summary JSON: {}",
            error
        )
    })
}

pub fn build_responses_sse_output_item_descriptor_json(
    output_item_json: String,
    lifecycle_json: Option<String>,
) -> Result<String, String> {
    let output_item: Value = serde_json::from_str(&output_item_json).map_err(|error| {
        format!(
            "Failed to parse Responses output item descriptor JSON: {}",
            error
        )
    })?;
    let lifecycle = lifecycle_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let output = build_responses_sse_output_item_descriptor(output_item, lifecycle)?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses output item descriptor JSON: {}",
            error
        )
    })
}

pub fn build_responses_sse_content_part_descriptor_json(
    content_part_json: String,
    lifecycle_json: Option<String>,
) -> Result<String, String> {
    let content_part: Value = serde_json::from_str(&content_part_json).map_err(|error| {
        format!(
            "Failed to parse Responses content part descriptor JSON: {}",
            error
        )
    })?;
    let lifecycle = lifecycle_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let output = build_responses_sse_content_part_descriptor(content_part, lifecycle)?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses content part descriptor JSON: {}",
            error
        )
    })
}

pub fn build_responses_sse_output_item_event_payload(
    output_item: Value,
    output_index: i64,
    lifecycle: &str,
) -> Result<Value, String> {
    let item = build_responses_sse_output_item_descriptor(output_item, Some(lifecycle))?;
    let mut payload = Map::new();
    payload.insert("output_index".to_string(), Value::from(output_index));
    payload.insert("item".to_string(), item);
    Ok(Value::Object(payload))
}

pub fn build_responses_sse_output_item_event_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> Result<String, String> {
    let lifecycle = lifecycle_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Responses output item event payload lifecycle is required".to_string())?;
    let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
        format!(
            "Failed to parse Responses output item event payload JSON: {}",
            error
        )
    })?;
    let Some(source) = payload.as_object() else {
        return Err("Responses output item event payload expected object".to_string());
    };
    let output_item = source
        .get("output_item")
        .cloned()
        .ok_or_else(|| "Responses output item event payload missing output_item".to_string())?;
    let output_index = source
        .get("output_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Responses output item event payload missing output_index".to_string())?;
    let output =
        build_responses_sse_output_item_event_payload(output_item, output_index, lifecycle)?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses output item event payload JSON: {}",
            error
        )
    })
}

pub fn build_responses_sse_content_part_event_payload(
    content_part: Option<Value>,
    output_index: i64,
    item_id: &str,
    content_index: i64,
    lifecycle: &str,
) -> Result<Value, String> {
    let mut payload = Map::new();
    payload.insert("output_index".to_string(), Value::from(output_index));
    payload.insert("item_id".to_string(), Value::String(item_id.to_string()));
    payload.insert("content_index".to_string(), Value::from(content_index));
    if let Some(content_part) = content_part {
        let part = build_responses_sse_content_part_descriptor(content_part, Some(lifecycle))?;
        payload.insert("part".to_string(), part);
    } else if lifecycle == "added" {
        return Err("Responses content part event payload missing content_part".to_string());
    }
    Ok(Value::Object(payload))
}

pub fn build_responses_sse_content_part_event_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> Result<String, String> {
    let lifecycle = lifecycle_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Responses content part event payload lifecycle is required".to_string())?;
    let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
        format!(
            "Failed to parse Responses content part event payload JSON: {}",
            error
        )
    })?;
    let Some(source) = payload.as_object() else {
        return Err("Responses content part event payload expected object".to_string());
    };
    let content_part = source.get("content_part").cloned();
    let output_index = source
        .get("output_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Responses content part event payload missing output_index".to_string())?;
    let item_id = source
        .get("item_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Responses content part event payload missing item_id".to_string())?;
    let content_index = source
        .get("content_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Responses content part event payload missing content_index".to_string())?;
    let output = build_responses_sse_content_part_event_payload(
        content_part,
        output_index,
        item_id,
        content_index,
        lifecycle,
    )?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses content part event payload JSON: {}",
            error
        )
    })
}

pub fn build_responses_sse_function_call_arguments_delta_payload(
    output_index: i64,
    item_id: &str,
    call_id: &str,
    delta: &str,
) -> Result<Value, String> {
    if item_id.trim().is_empty() {
        return Err(
            "Responses function call arguments delta payload item_id is required".to_string(),
        );
    }
    if call_id.trim().is_empty() {
        return Err(
            "Responses function call arguments delta payload call_id is required".to_string(),
        );
    }
    Ok(serde_json::json!({
        "output_index": output_index,
        "item_id": item_id,
        "call_id": call_id,
        "delta": delta
    }))
}

pub fn build_responses_sse_function_call_arguments_done_payload(
    output_index: i64,
    item_id: &str,
    call_id: &str,
    name: &str,
    arguments: &str,
) -> Result<Value, String> {
    if item_id.trim().is_empty() {
        return Err(
            "Responses function call arguments done payload item_id is required".to_string(),
        );
    }
    if call_id.trim().is_empty() {
        return Err(
            "Responses function call arguments done payload call_id is required".to_string(),
        );
    }
    if name.trim().is_empty() {
        return Err("Responses function call arguments done payload name is required".to_string());
    }
    Ok(serde_json::json!({
        "output_index": output_index,
        "item_id": item_id,
        "call_id": call_id,
        "name": name,
        "arguments": arguments
    }))
}

fn read_responses_sse_function_call_arguments_payload_source(
    payload_json: String,
    label: &str,
) -> Result<Map<String, Value>, String> {
    let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
        format!(
            "Failed to parse Responses {} payload JSON: {}",
            label, error
        )
    })?;
    payload
        .as_object()
        .cloned()
        .ok_or_else(|| format!("Responses {} payload expected object", label))
}

fn read_required_i64(source: &Map<String, Value>, field: &str, label: &str) -> Result<i64, String> {
    source
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Responses {} payload missing {}", label, field))
}

fn read_required_string(
    source: &Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<String, String> {
    source
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("Responses {} payload missing {}", label, field))
}

pub fn build_responses_sse_function_call_arguments_delta_payload_json(
    payload_json: String,
) -> Result<String, String> {
    let label = "function call arguments delta";
    let source = read_responses_sse_function_call_arguments_payload_source(payload_json, label)?;
    let output_index = read_required_i64(&source, "output_index", label)?;
    let item_id = read_required_string(&source, "item_id", label)?;
    let call_id = read_required_string(&source, "call_id", label)?;
    let delta = read_required_string(&source, "delta", label)?;
    let output = build_responses_sse_function_call_arguments_delta_payload(
        output_index,
        &item_id,
        &call_id,
        &delta,
    )?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses function call arguments delta payload JSON: {}",
            error
        )
    })
}

pub fn build_responses_sse_function_call_arguments_done_payload_json(
    payload_json: String,
) -> Result<String, String> {
    let label = "function call arguments done";
    let source = read_responses_sse_function_call_arguments_payload_source(payload_json, label)?;
    let output_index = read_required_i64(&source, "output_index", label)?;
    let item_id = read_required_string(&source, "item_id", label)?;
    let call_id = read_required_string(&source, "call_id", label)?;
    let name = read_required_string(&source, "name", label)?;
    let arguments = read_required_string(&source, "arguments", label)?;
    let output = build_responses_sse_function_call_arguments_done_payload(
        output_index,
        &item_id,
        &call_id,
        &name,
        &arguments,
    )?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses function call arguments done payload JSON: {}",
            error
        )
    })
}

fn build_responses_sse_reasoning_summary_payload(
    lifecycle: &str,
    output_index: i64,
    item_id: &str,
    summary_index: i64,
    text: &str,
) -> Result<Value, String> {
    if item_id.trim().is_empty() {
        return Err("Responses reasoning summary payload item_id is required".to_string());
    }
    let mut payload = Map::new();
    payload.insert("output_index".to_string(), Value::from(output_index));
    payload.insert("item_id".to_string(), Value::String(item_id.to_string()));
    payload.insert("summary_index".to_string(), Value::from(summary_index));
    match lifecycle {
        "part_added" => {
            payload.insert(
                "part".to_string(),
                serde_json::json!({ "type": "summary_text", "text": "" }),
            );
        }
        "part_done" => {
            payload.insert(
                "part".to_string(),
                serde_json::json!({ "type": "summary_text", "text": text }),
            );
        }
        "text_delta" => {
            payload.insert("delta".to_string(), Value::String(text.to_string()));
        }
        "text_done" => {
            payload.insert("text".to_string(), Value::String(text.to_string()));
        }
        other => {
            return Err(format!(
                "Unsupported Responses reasoning summary payload lifecycle: {}",
                other
            ));
        }
    }
    Ok(Value::Object(payload))
}

pub fn build_responses_sse_reasoning_summary_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> Result<String, String> {
    let lifecycle = lifecycle_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Responses reasoning summary payload lifecycle is required".to_string())?;
    let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
        format!(
            "Failed to parse Responses reasoning summary payload JSON: {}",
            error
        )
    })?;
    let Some(source) = payload.as_object() else {
        return Err("Responses reasoning summary payload expected object".to_string());
    };
    let output_index = source
        .get("output_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Responses reasoning summary payload missing output_index".to_string())?;
    let item_id = source
        .get("item_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Responses reasoning summary payload missing item_id".to_string())?;
    let summary_index = source
        .get("summary_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Responses reasoning summary payload missing summary_index".to_string())?;
    let text = source.get("text").and_then(Value::as_str).unwrap_or("");
    let output = build_responses_sse_reasoning_summary_payload(
        lifecycle,
        output_index,
        item_id,
        summary_index,
        text,
    )?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses reasoning summary payload JSON: {}",
            error
        )
    })
}

fn build_responses_sse_reasoning_lifecycle_payload(
    lifecycle: &str,
    item_id: &str,
    summary: Option<&Value>,
) -> Result<Value, String> {
    if item_id.trim().is_empty() {
        return Err("Responses reasoning lifecycle payload item_id is required".to_string());
    }
    let mut payload = Map::new();
    payload.insert("item_id".to_string(), Value::String(item_id.to_string()));
    match lifecycle {
        "start" => {
            if let Some(summary) = summary {
                let normalized = normalize_responses_sse_reasoning_summary(summary)?;
                if !normalized.is_null() {
                    payload.insert("summary".to_string(), normalized);
                }
            }
        }
        "done" => {}
        other => {
            return Err(format!(
                "Unsupported Responses reasoning lifecycle payload: {}",
                other
            ));
        }
    }
    Ok(Value::Object(payload))
}

pub fn build_responses_sse_reasoning_lifecycle_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> Result<String, String> {
    let lifecycle = lifecycle_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Responses reasoning lifecycle payload lifecycle is required".to_string())?;
    let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
        format!(
            "Failed to parse Responses reasoning lifecycle payload JSON: {}",
            error
        )
    })?;
    let Some(source) = payload.as_object() else {
        return Err("Responses reasoning lifecycle payload expected object".to_string());
    };
    let item_id = source
        .get("item_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Responses reasoning lifecycle payload missing item_id".to_string())?;
    let output =
        build_responses_sse_reasoning_lifecycle_payload(lifecycle, item_id, source.get("summary"))?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses reasoning lifecycle payload JSON: {}",
            error
        )
    })
}

fn build_responses_sse_reasoning_delta_payload(
    lifecycle: &str,
    output_index: i64,
    item_id: &str,
    content_index: i64,
    value: Value,
) -> Result<Value, String> {
    if item_id.trim().is_empty() {
        return Err("Responses reasoning delta payload item_id is required".to_string());
    }
    let mut payload = Map::new();
    payload.insert("output_index".to_string(), Value::from(output_index));
    payload.insert("item_id".to_string(), Value::String(item_id.to_string()));
    payload.insert("content_index".to_string(), Value::from(content_index));
    match lifecycle {
        "text" => {
            payload.insert("delta".to_string(), value);
        }
        "signature" => {
            payload.insert("signature".to_string(), value);
        }
        "image" => {
            payload.insert("image_url".to_string(), value);
        }
        other => {
            return Err(format!(
                "Unsupported Responses reasoning delta payload lifecycle: {}",
                other
            ));
        }
    }
    Ok(Value::Object(payload))
}

pub fn build_responses_sse_reasoning_delta_payload_json(
    payload_json: String,
    lifecycle_json: Option<String>,
) -> Result<String, String> {
    let lifecycle = lifecycle_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Responses reasoning delta payload lifecycle is required".to_string())?;
    let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
        format!(
            "Failed to parse Responses reasoning delta payload JSON: {}",
            error
        )
    })?;
    let Some(source) = payload.as_object() else {
        return Err("Responses reasoning delta payload expected object".to_string());
    };
    let output_index = source
        .get("output_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Responses reasoning delta payload missing output_index".to_string())?;
    let item_id = source
        .get("item_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Responses reasoning delta payload missing item_id".to_string())?;
    let content_index = source
        .get("content_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Responses reasoning delta payload missing content_index".to_string())?;
    let value = source
        .get("value")
        .cloned()
        .ok_or_else(|| "Responses reasoning delta payload missing value".to_string())?;
    let output = build_responses_sse_reasoning_delta_payload(
        lifecycle,
        output_index,
        item_id,
        content_index,
        value,
    )?;
    serde_json::to_string(&output).map_err(|error| {
        format!(
            "Failed to serialize Responses reasoning delta payload JSON: {}",
            error
        )
    })
}

fn read_config_bool(config: &Map<String, Value>, field: &str, default_value: bool) -> bool {
    config
        .get(field)
        .and_then(Value::as_bool)
        .unwrap_or(default_value)
}

fn read_config_i64(config: &Map<String, Value>, field: &str, default_value: i64) -> i64 {
    config
        .get(field)
        .and_then(Value::as_i64)
        .unwrap_or(default_value)
}

fn next_sequence_envelope(
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let envelope_raw = build_responses_sse_event_envelope_json(
        serde_json::json!({
            "request_id": request_id,
            "current_sequence": *sequence_counter,
            "enable_timestamp_generation": read_config_bool(config, "enableTimestampGeneration", true),
            "enable_sequence_numbers": read_config_bool(config, "includeSequenceNumbers", true)
        })
        .to_string(),
    )?;
    let envelope: Value = serde_json::from_str(&envelope_raw).map_err(|error| {
        format!(
            "Failed to parse Responses SSE event envelope output: {}",
            error
        )
    })?;
    let Some(envelope) = envelope.as_object() else {
        return Err("Responses SSE event envelope output expected object".to_string());
    };
    *sequence_counter = envelope
        .get("nextSequenceCounter")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            "Responses SSE event envelope output missing nextSequenceCounter".to_string()
        })?;
    Ok(envelope.clone())
}

fn push_responses_sse_event(
    events: &mut Vec<Value>,
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
    event_type: &str,
    data: Value,
) -> Result<(), String> {
    let envelope = next_sequence_envelope(request_id, sequence_counter, config)?;
    let timestamp = envelope
        .get("timestamp")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Responses SSE event envelope output missing timestamp".to_string())?;
    let sequence_number = envelope
        .get("sequenceNumber")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Responses SSE event envelope output missing sequenceNumber".to_string())?;
    let event = canonicalize_responses_sse_event_payload(serde_json::json!({
        "type": event_type,
        "timestamp": timestamp,
        "protocol": "responses",
        "direction": "json_to_sse",
        "sequenceNumber": sequence_number,
        "data": data
    }))?;
    events.push(event);
    Ok(())
}

fn read_response_output_items(response: &Map<String, Value>) -> Result<&Vec<Value>, String> {
    response
        .get("output")
        .and_then(Value::as_array)
        .ok_or_else(|| "Invalid Responses response: missing output array".to_string())
}

fn read_required_item_string<'a>(
    item: &'a Map<String, Value>,
    field: &str,
    item_type: &str,
) -> Result<&'a str, String> {
    item.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Invalid Responses {} item: missing {}", item_type, field))
}

fn read_required_item_string_allow_empty<'a>(
    item: &'a Map<String, Value>,
    field: &str,
    item_type: &str,
) -> Result<&'a str, String> {
    item.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Invalid Responses {} item: missing {}", item_type, field))
}

fn push_response_event(
    events: &mut Vec<Value>,
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
    event_type: &str,
    response: Value,
    status: &str,
    lifecycle: &str,
    required_action: Option<Value>,
) -> Result<(), String> {
    let data = build_responses_sse_response_event_payload(
        response,
        Some(status),
        lifecycle,
        required_action,
    )?;
    push_responses_sse_event(
        events,
        request_id,
        sequence_counter,
        config,
        event_type,
        data,
    )
}

fn push_output_item_event(
    events: &mut Vec<Value>,
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
    event_type: &str,
    item: Value,
    output_index: i64,
    lifecycle: &str,
) -> Result<(), String> {
    let data = build_responses_sse_output_item_event_payload(item, output_index, lifecycle)?;
    push_responses_sse_event(
        events,
        request_id,
        sequence_counter,
        config,
        event_type,
        data,
    )
}

fn push_content_part_event(
    events: &mut Vec<Value>,
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
    event_type: &str,
    content_part: Option<Value>,
    output_index: i64,
    item_id: &str,
    content_index: i64,
    lifecycle: &str,
) -> Result<(), String> {
    let data = build_responses_sse_content_part_event_payload(
        content_part,
        output_index,
        item_id,
        content_index,
        lifecycle,
    )?;
    push_responses_sse_event(
        events,
        request_id,
        sequence_counter,
        config,
        event_type,
        data,
    )
}

fn push_text_chunks(
    events: &mut Vec<Value>,
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
    event_type: &str,
    output_index: i64,
    item_id: &str,
    content_index: i64,
    text: &str,
    payload_builder: fn(i64, &str, i64, &str) -> Result<Value, String>,
) -> Result<(), String> {
    let chunks =
        build_responses_sse_text_chunks(text, Some(read_config_i64(config, "chunkSize", 0)))?;
    for chunk in chunks {
        let data = payload_builder(output_index, item_id, content_index, &chunk)?;
        push_responses_sse_event(
            events,
            request_id,
            sequence_counter,
            config,
            event_type,
            data,
        )?;
    }
    Ok(())
}

fn sequence_responses_message_item(
    events: &mut Vec<Value>,
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
    item: &Map<String, Value>,
    output_index: i64,
) -> Result<(), String> {
    let item_id = read_required_item_string(item, "id", "message")?;
    let content = item
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "Invalid Responses message item: missing content".to_string())?;
    push_output_item_event(
        events,
        request_id,
        sequence_counter,
        config,
        "response.output_item.added",
        Value::Object(item.clone()),
        output_index,
        "added",
    )?;

    for (content_index, content_part) in content.iter().enumerate() {
        let Some(content_part_object) = content_part.as_object() else {
            return Err("Invalid Responses message content: expected object".to_string());
        };
        let content_type = content_part_object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "Invalid Responses message content: missing type".to_string())?;
        let content_index = i64::try_from(content_index)
            .map_err(|_| "Responses content index overflow".to_string())?;
        push_content_part_event(
            events,
            request_id,
            sequence_counter,
            config,
            "response.content_part.added",
            Some(content_part.clone()),
            output_index,
            item_id,
            content_index,
            "added",
        )?;
        if content_type == "input_text" || content_type == "output_text" {
            let text = content_part_object
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "Responses content part descriptor missing text".to_string())?;
            push_text_chunks(
                events,
                request_id,
                sequence_counter,
                config,
                "response.output_text.delta",
                output_index,
                item_id,
                content_index,
                text,
                build_responses_sse_output_text_delta_payload,
            )?;
            if content_type == "output_text" {
                let data = build_responses_sse_output_text_done_payload(
                    output_index,
                    item_id,
                    content_index,
                    text,
                )?;
                push_responses_sse_event(
                    events,
                    request_id,
                    sequence_counter,
                    config,
                    "response.output_text.done",
                    data,
                )?;
            }
        }
        push_content_part_event(
            events,
            request_id,
            sequence_counter,
            config,
            "response.content_part.done",
            Some(content_part.clone()),
            output_index,
            item_id,
            content_index,
            "done",
        )?;
    }

    push_output_item_event(
        events,
        request_id,
        sequence_counter,
        config,
        "response.output_item.done",
        Value::Object(item.clone()),
        output_index,
        "done",
    )
}

fn sequence_responses_function_call_item(
    events: &mut Vec<Value>,
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
    item: &Map<String, Value>,
    output_index: i64,
) -> Result<(), String> {
    let item_id = read_required_item_string(item, "id", "function_call")?;
    let call_id = read_required_item_string(item, "call_id", "function_call")?;
    let name = read_required_item_string(item, "name", "function_call")?;
    let arguments = read_required_item_string_allow_empty(item, "arguments", "function_call")?;
    push_output_item_event(
        events,
        request_id,
        sequence_counter,
        config,
        "response.output_item.added",
        Value::Object(item.clone()),
        output_index,
        "added",
    )?;
    let chunks =
        build_responses_sse_text_chunks(arguments, Some(read_config_i64(config, "chunkSize", 0)))?;
    for chunk in chunks {
        let data = build_responses_sse_function_call_arguments_delta_payload(
            output_index,
            item_id,
            call_id,
            &chunk,
        )?;
        push_responses_sse_event(
            events,
            request_id,
            sequence_counter,
            config,
            "response.function_call_arguments.delta",
            data,
        )?;
    }
    let data = build_responses_sse_function_call_arguments_done_payload(
        output_index,
        item_id,
        call_id,
        name,
        arguments,
    )?;
    push_responses_sse_event(
        events,
        request_id,
        sequence_counter,
        config,
        "response.function_call_arguments.done",
        data,
    )?;
    push_output_item_event(
        events,
        request_id,
        sequence_counter,
        config,
        "response.output_item.done",
        Value::Object(item.clone()),
        output_index,
        "done",
    )
}

fn sequence_responses_function_call_output_item(
    events: &mut Vec<Value>,
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
    item: &Map<String, Value>,
    output_index: i64,
) -> Result<(), String> {
    push_output_item_event(
        events,
        request_id,
        sequence_counter,
        config,
        "response.output_item.added",
        Value::Object(item.clone()),
        output_index,
        "added",
    )?;
    push_output_item_event(
        events,
        request_id,
        sequence_counter,
        config,
        "response.output_item.done",
        Value::Object(item.clone()),
        output_index,
        "done",
    )
}

fn sequence_responses_reasoning_item(
    events: &mut Vec<Value>,
    request_id: &str,
    sequence_counter: &mut i64,
    config: &Map<String, Value>,
    item: &Map<String, Value>,
    output_index: i64,
) -> Result<(), String> {
    let item_id = read_required_item_string(item, "id", "reasoning")?;
    push_output_item_event(
        events,
        request_id,
        sequence_counter,
        config,
        "response.output_item.added",
        Value::Object(item.clone()),
        output_index,
        "added",
    )?;

    let summary = item.get("summary").unwrap_or(&Value::Null);
    let normalized_summary = normalize_responses_sse_reasoning_summary(summary)?;
    if let Some(entries) = normalized_summary.as_array() {
        for (summary_index, entry) in entries.iter().enumerate() {
            let text = entry
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "Responses reasoning summary entry missing text".to_string())?;
            let summary_index = i64::try_from(summary_index)
                .map_err(|_| "Responses reasoning summary index overflow".to_string())?;
            let data = build_responses_sse_reasoning_summary_payload(
                "part_added",
                output_index,
                item_id,
                summary_index,
                text,
            )?;
            push_responses_sse_event(
                events,
                request_id,
                sequence_counter,
                config,
                "response.reasoning_summary_part.added",
                data,
            )?;
            let chunks = build_responses_sse_text_chunks(
                text,
                Some(read_config_i64(config, "chunkSize", 0)),
            )?;
            for chunk in chunks {
                let data = build_responses_sse_reasoning_summary_payload(
                    "text_delta",
                    output_index,
                    item_id,
                    summary_index,
                    &chunk,
                )?;
                push_responses_sse_event(
                    events,
                    request_id,
                    sequence_counter,
                    config,
                    "response.reasoning_summary_text.delta",
                    data,
                )?;
            }
            let data = build_responses_sse_reasoning_summary_payload(
                "text_done",
                output_index,
                item_id,
                summary_index,
                text,
            )?;
            push_responses_sse_event(
                events,
                request_id,
                sequence_counter,
                config,
                "response.reasoning_summary_text.done",
                data,
            )?;
            let data = build_responses_sse_reasoning_summary_payload(
                "part_done",
                output_index,
                item_id,
                summary_index,
                text,
            )?;
            push_responses_sse_event(
                events,
                request_id,
                sequence_counter,
                config,
                "response.reasoning_summary_part.done",
                data,
            )?;
        }
    }

    if let Some(content) = item.get("content") {
        let Some(content) = content.as_array() else {
            return Err("Invalid Responses reasoning content: expected array".to_string());
        };
        for (content_index, content_entry) in content.iter().enumerate() {
            let Some(content_entry) = content_entry.as_object() else {
                return Err("Invalid Responses reasoning content: expected object".to_string());
            };
            let content_type = content_entry
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| "Invalid Responses reasoning content: missing type".to_string())?;
            let content_index = i64::try_from(content_index)
                .map_err(|_| "Responses reasoning content index overflow".to_string())?;
            let (event_type, lifecycle, value) = match content_type {
                "reasoning_text" => (
                    "response.reasoning_text.delta",
                    "text",
                    content_entry.get("text").cloned().ok_or_else(|| {
                        "Invalid Responses reasoning_text: missing text".to_string()
                    })?,
                ),
                "reasoning_signature" => (
                    "response.reasoning_signature.delta",
                    "signature",
                    content_entry.get("signature").cloned().ok_or_else(|| {
                        "Invalid Responses reasoning_signature: missing signature".to_string()
                    })?,
                ),
                "reasoning_image" => (
                    "response.reasoning_image.delta",
                    "image",
                    content_entry.get("image_url").cloned().ok_or_else(|| {
                        "Invalid Responses reasoning_image: missing image_url".to_string()
                    })?,
                ),
                other => {
                    return Err(format!(
                        "Unsupported Responses reasoning content type: {}",
                        other
                    ))
                }
            };
            let data = build_responses_sse_reasoning_delta_payload(
                lifecycle,
                output_index,
                item_id,
                content_index,
                value,
            )?;
            push_responses_sse_event(
                events,
                request_id,
                sequence_counter,
                config,
                event_type,
                data,
            )?;
        }
    }

    push_output_item_event(
        events,
        request_id,
        sequence_counter,
        config,
        "response.output_item.done",
        Value::Object(item.clone()),
        output_index,
        "done",
    )
}

pub fn build_responses_sse_event_sequence_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        format!(
            "Failed to parse Responses SSE event sequence JSON: {}",
            error
        )
    })?;
    let Some(input) = input.as_object() else {
        return Err("Responses SSE event sequence expected object".to_string());
    };
    let response = input
        .get("response")
        .and_then(Value::as_object)
        .ok_or_else(|| "Responses SSE event sequence missing response".to_string())?;
    let request_id = input
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Responses SSE event sequence missing request_id".to_string())?;
    let config = input
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let status = response
        .get("status")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Invalid Responses response: missing status".to_string())?;
    let output_items = read_response_output_items(response)?;
    let response_value = Value::Object(response.clone());
    let mut events = Vec::new();
    let mut sequence_counter = 0_i64;

    push_response_event(
        &mut events,
        request_id,
        &mut sequence_counter,
        &config,
        "response.created",
        response_value.clone(),
        "in_progress",
        "start",
        None,
    )?;
    push_response_event(
        &mut events,
        request_id,
        &mut sequence_counter,
        &config,
        "response.in_progress",
        response_value.clone(),
        "in_progress",
        "start",
        None,
    )?;

    for (output_index, item) in output_items.iter().enumerate() {
        let Some(item) = item.as_object() else {
            return Err("Invalid Responses output item: expected object".to_string());
        };
        let output_index = i64::try_from(output_index)
            .map_err(|_| "Responses output index overflow".to_string())?;
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Invalid Responses output item: missing type".to_string())?;
        match item_type {
            "message" => sequence_responses_message_item(
                &mut events,
                request_id,
                &mut sequence_counter,
                &config,
                item,
                output_index,
            )?,
            "function_call" => sequence_responses_function_call_item(
                &mut events,
                request_id,
                &mut sequence_counter,
                &config,
                item,
                output_index,
            )?,
            "function_call_output" => sequence_responses_function_call_output_item(
                &mut events,
                request_id,
                &mut sequence_counter,
                &config,
                item,
                output_index,
            )?,
            "reasoning" => sequence_responses_reasoning_item(
                &mut events,
                request_id,
                &mut sequence_counter,
                &config,
                item,
                output_index,
            )?,
            other => return Err(format!("Unknown output item type: {}", other)),
        }
    }

    push_response_event(
        &mut events,
        request_id,
        &mut sequence_counter,
        &config,
        "response.completed",
        response_value.clone(),
        status,
        "completed",
        None,
    )?;
    push_response_event(
        &mut events,
        request_id,
        &mut sequence_counter,
        &config,
        "response.done",
        response_value,
        status,
        "done",
        None,
    )?;

    serde_json::to_string(&events).map_err(|error| {
        format!(
            "Failed to serialize Responses SSE event sequence JSON: {}",
            error
        )
    })
}

/// Build full Responses SSE stream (events + stats) for the converter shell.
pub fn build_responses_sse_stream_json(input_json: String) -> Result<String, String> {
    let events_json = build_responses_sse_event_sequence_json(input_json.clone())?;
    let events: Vec<Value> = serde_json::from_str(&events_json)
        .map_err(|error| format!("Failed to deserialize Responses SSE events: {}", error))?;
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse Responses SSE stream input: {}", error))?;
    let response = input
        .get("response")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut event_types: std::collections::BTreeMap<String, i64> =
        std::collections::BTreeMap::new();
    let mut error_count: i64 = 0;
    for event in &events {
        let event_type = event
            .get("event")
            .or_else(|| event.get("type"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(et) = event_type {
            if et == "response.error" {
                error_count += 1;
            }
            *event_types.entry(et).or_insert(0) += 1;
        }
    }
    let now = current_unix_timestamp_ms().unwrap_or(0);
    let stats = serde_json::json!({
        "totalEvents": events.len() as i64,
        "eventTypes": event_types,
        "errorCount": error_count,
        "responseId": response.get("id").and_then(Value::as_str).unwrap_or(""),
        "model": response.get("model").and_then(Value::as_str).unwrap_or(""),
        "startTime": now,
        "endTime": now,
        "lastEventTime": now,
    });
    let output = serde_json::json!({
        "events": events,
        "stats": stats,
    });
    serde_json::to_string(&output)
        .map_err(|error| format!("Failed to serialize Responses SSE stream JSON: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_responses_sse_text_chunks_disabled_as_single_chunk() {
        let chunks = build_responses_sse_text_chunks("hello world", Some(0)).unwrap();
        assert_eq!(chunks, vec!["hello world".to_string()]);
    }

    #[test]
    fn builds_responses_sse_event_envelope_and_advances_sequence() {
        let output = build_responses_sse_event_envelope_json(
            json!({
                "request_id": "req_envelope",
                "current_sequence": 7,
                "enable_timestamp_generation": false,
                "enable_sequence_numbers": true
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["requestId"], json!("req_envelope"));
        assert_eq!(parsed["timestamp"], json!(0));
        assert_eq!(parsed["sequenceNumber"], json!(7));
        assert_eq!(parsed["nextSequenceCounter"], json!(8));
        assert_eq!(parsed["protocol"], json!("responses"));
        assert_eq!(parsed["direction"], json!("json_to_sse"));
    }

    #[test]
    fn builds_responses_sse_event_envelope_without_sequence_generation() {
        let output = build_responses_sse_event_envelope_json(
            json!({
                "request_id": "req_envelope_no_sequence",
                "current_sequence": 7,
                "enable_timestamp_generation": false,
                "enable_sequence_numbers": false
            })
            .to_string(),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["sequenceNumber"], json!(0));
        assert_eq!(parsed["nextSequenceCounter"], json!(7));
    }

    #[test]
    fn builds_responses_sse_text_chunks_at_size_and_boundary() {
        let chunks = build_responses_sse_text_chunks("hello world again", Some(8)).unwrap();
        assert_eq!(
            chunks,
            vec![
                "hello ".to_string(),
                "world ".to_string(),
                "again".to_string()
            ]
        );
    }

    #[test]
    fn rejects_responses_sse_text_chunks_missing_text() {
        let err =
            build_responses_sse_text_chunks_json("{\"chunk_size\":8}".to_string()).unwrap_err();
        assert!(err.contains("Responses SSE text chunk payload missing text"));
    }

    #[test]
    fn canonicalizes_missing_payload_type_and_sequence_number() {
        let output = canonicalize_responses_sse_event_payload(json!({
            "type": "response.completed",
            "sequenceNumber": 7,
            "data": {
                "response": { "id": "resp_1" }
            }
        }))
        .unwrap();

        assert_eq!(output["data"]["type"], json!("response.completed"));
        assert_eq!(output["data"]["sequence_number"], json!(7));
        assert_eq!(output["data"]["response"]["id"], json!("resp_1"));
    }

    #[test]
    fn serializes_responses_sse_event_to_wire() {
        let output = serialize_responses_sse_event_to_wire(json!({
            "type": "response.completed",
            "timestamp": 123,
            "data": {
                "type": "response.completed",
                "response": { "id": "resp_1" }
            }
        }))
        .unwrap();

        assert_eq!(
            output,
            "event: response.completed\ndata: {\"response\":{\"id\":\"resp_1\"},\"type\":\"response.completed\"}\nid: 123\n\n"
        );
    }

    #[test]
    fn rejects_responses_sse_wire_payload_missing_type() {
        let err = serialize_responses_sse_event_to_wire(json!({
            "type": "response.completed",
            "timestamp": 123,
            "data": { "response": { "id": "resp_1" } }
        }))
        .unwrap_err();

        assert!(err.contains("Responses SSE payload missing canonical type for response.completed"));
    }

    #[test]
    fn deserializes_responses_sse_event_from_wire() {
        let output = deserialize_responses_sse_event_from_wire(
            "event: response.done\nid: 123\ndata: {\"type\":\"response.done\",\"response\":{}}\n",
        )
        .unwrap();

        assert_eq!(output["type"], json!("response.done"));
        assert_eq!(output["timestamp"], json!(123));
        assert_eq!(output["protocol"], json!("responses"));
        assert_eq!(output["direction"], json!("sse_to_json"));
    }

    #[test]
    fn rejects_responses_sse_event_from_wire_invalid_timestamp() {
        let err = deserialize_responses_sse_event_from_wire(
            "event: response.done\nid: not-a-timestamp\ndata: {\"type\":\"response.done\",\"response\":{}}\n",
        )
        .unwrap_err();

        assert!(err.contains("Invalid Responses SSE timestamp: not-a-timestamp"));
    }

    #[test]
    fn validates_responses_sse_wire_format() {
        assert!(validate_responses_sse_wire_format(
            "event: response.done\ndata: {\"type\":\"response.done\"}\n"
        )
        .unwrap());
        assert!(!validate_responses_sse_wire_format("event: response.done\n").unwrap());
    }

    #[test]
    fn rejects_payload_type_mismatch() {
        let err = canonicalize_responses_sse_event_payload(json!({
            "type": "response.completed",
            "data": { "type": "response.error" }
        }))
        .unwrap_err();

        assert!(err.contains("Responses event payload type mismatch"));
    }

    #[test]
    fn rejects_scalar_payload() {
        let err = canonicalize_responses_sse_event_payload(json!({
            "type": "response.output_text.delta",
            "data": "hello"
        }))
        .unwrap_err();

        assert!(err.contains("Responses event payload must be an object"));
    }

    #[test]
    fn normalizes_responses_sse_response_payload_with_strict_usage() {
        let output = normalize_responses_sse_response_payload(
            json!({
                "id": "resp_sse_payload_1",
                "object": "response",
                "created_at": 1781149537,
                "status": "completed",
                "model": "gpt-test",
                "output": [],
                "usage": {
                    "input_tokens": "10",
                    "output_tokens": 5,
                    "total_tokens": 15,
                    "input_tokens_details": { "cached_tokens": "7" }
                }
            }),
            Some("completed"),
        )
        .unwrap();

        assert_eq!(output["status"], json!("completed"));
        assert_eq!(output["background"], json!(false));
        assert_eq!(output["error"], Value::Null);
        assert_eq!(output["usage"]["input_tokens"], json!(10));
        assert_eq!(
            output["usage"]["input_tokens_details"]["cached_tokens"],
            json!(7)
        );
    }

    #[test]
    fn normalizes_responses_sse_response_payload_without_metadata() {
        let output = normalize_responses_sse_response_payload(
            json!({
                "id": "resp_sse_payload_metadata",
                "object": "response",
                "created_at": 1781149537,
                "status": "completed",
                "model": "gpt-test",
                "metadata": {
                    "session_id": "must-not-leak",
                    "__shadowCompareForcedProviderKey": "provider.key"
                },
                "output": []
            }),
            Some("completed"),
        )
        .unwrap();

        assert!(output.get("metadata").is_none());
        assert!(!output.to_string().contains("must-not-leak"));
        assert!(!output
            .to_string()
            .contains("__shadowCompareForcedProviderKey"));
    }

    #[test]
    fn rejects_responses_sse_response_payload_usage_aliases() {
        let err = normalize_responses_sse_response_payload(
            json!({
                "id": "resp_sse_payload_alias",
                "object": "response",
                "created_at": 1781149537,
                "status": "completed",
                "model": "gpt-test",
                "output": [],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15
                }
            }),
            Some("completed"),
        )
        .unwrap_err();

        assert!(err.contains("Invalid Responses usage: missing token fields"));
    }

    #[test]
    fn rejects_responses_sse_response_payload_missing_created_at() {
        let err = normalize_responses_sse_response_payload(
            json!({
                "id": "resp_sse_payload_missing_created",
                "object": "response",
                "status": "completed",
                "model": "gpt-test",
                "output": []
            }),
            Some("completed"),
        )
        .unwrap_err();

        assert!(err.contains("Invalid Responses response: missing created_at"));
    }

    #[test]
    fn rejects_responses_sse_response_payload_missing_object() {
        let err = normalize_responses_sse_response_payload(
            json!({
                "id": "resp_sse_payload_missing_object",
                "created_at": 1781149537,
                "status": "completed",
                "model": "gpt-test",
                "output": []
            }),
            Some("completed"),
        )
        .unwrap_err();

        assert!(err.contains("Invalid Responses response: missing object"));
    }

    #[test]
    fn rejects_responses_sse_response_payload_missing_output_array() {
        let err = normalize_responses_sse_response_payload(
            json!({
                "id": "resp_sse_payload_missing_output",
                "object": "response",
                "created_at": 1781149537,
                "status": "completed",
                "model": "gpt-test"
            }),
            Some("completed"),
        )
        .unwrap_err();

        assert!(err.contains("Invalid Responses response: missing output array"));
    }

    #[test]
    fn builds_responses_sse_start_response_event_payload_with_empty_output() {
        let output = build_responses_sse_response_event_payload(
            json!({
                "id": "resp_start",
                "object": "response",
                "created_at": 1781149537,
                "status": "completed",
                "model": "gpt-test",
                "output": [{ "id": "item_1", "type": "message" }],
                "usage": { "input_tokens": 1, "output_tokens": 1, "total_tokens": 2 }
            }),
            Some("in_progress"),
            "start",
            None,
        )
        .unwrap();

        assert_eq!(output["response"]["status"], json!("in_progress"));
        assert_eq!(output["response"]["output"], json!([]));
    }

    #[test]
    fn builds_responses_sse_required_action_event_payload() {
        let output = build_responses_sse_response_event_payload(
            json!({
                "id": "resp_required",
                "object": "response",
                "created_at": 1781149537,
                "status": "requires_action",
                "model": "gpt-test",
                "output": [],
                "usage": { "input_tokens": 1, "output_tokens": 1, "total_tokens": 2 }
            }),
            Some("requires_action"),
            "required_action",
            Some(json!({ "type": "submit_tool_outputs", "submit_tool_outputs": { "tool_calls": [] } })),
        )
        .unwrap();

        assert_eq!(output["response"]["status"], json!("requires_action"));
        assert_eq!(
            output["required_action"]["type"],
            json!("submit_tool_outputs")
        );
    }

    #[test]
    fn rejects_responses_sse_required_action_event_payload_missing_required_action() {
        let err = build_responses_sse_response_event_payload(
            json!({
                "id": "resp_required",
                "object": "response",
                "created_at": 1781149537,
                "status": "requires_action",
                "model": "gpt-test",
                "output": [],
                "usage": { "input_tokens": 1, "output_tokens": 1, "total_tokens": 2 }
            }),
            Some("requires_action"),
            "required_action",
            None,
        )
        .unwrap_err();

        assert!(err.contains("Responses SSE required_action payload missing required_action"));
    }

    #[test]
    fn normalize_responses_sse_reasoning_summary_preserves_verbatim_text() {
        let output = normalize_responses_sse_reasoning_summary(&json!([
            "- inspect `file.ts`",
            { "text": "> keep quoted detail" },
            { "type": "summary_text", "text": "  spaced summary  " },
            { "type": "other", "text": "still kept" }
        ]))
        .unwrap();

        assert_eq!(
            output,
            json!([
                { "type": "summary_text", "text": "- inspect `file.ts`" },
                { "type": "summary_text", "text": "> keep quoted detail" },
                { "type": "summary_text", "text": "  spaced summary  " },
                { "type": "summary_text", "text": "still kept" }
            ])
        );
    }

    #[test]
    fn rejects_responses_sse_reasoning_summary_entry_missing_text() {
        let err = normalize_responses_sse_reasoning_summary(&json!([
            { "type": "summary_text" }
        ]))
        .unwrap_err();

        assert!(err.contains("Responses reasoning summary entry missing text at index 0"));
    }

    #[test]
    fn rejects_responses_sse_reasoning_summary_empty_text_entry() {
        let err = normalize_responses_sse_reasoning_summary(&json!([""])).unwrap_err();

        assert!(err.contains("Responses reasoning summary entry missing text at index 0"));
    }

    #[test]
    fn builds_responses_sse_output_item_added_descriptor() {
        let output = build_responses_sse_output_item_descriptor(
            json!({
                "id": "fc_1",
                "type": "function_call",
                "status": "completed",
                "name": "search",
                "call_id": "call_1",
                "arguments": "{\"q\":\"rust\"}"
            }),
            Some("added"),
        )
        .unwrap();

        assert_eq!(
            output,
            json!({
                "id": "fc_1",
                "type": "function_call",
                "status": "in_progress",
                "name": "search",
                "call_id": "call_1",
                "arguments": ""
            })
        );
    }

    #[test]
    fn builds_responses_sse_output_item_done_descriptor_with_normalized_reasoning_summary() {
        let output = build_responses_sse_output_item_descriptor(
            json!({
                "id": "rs_1",
                "type": "reasoning",
                "summary": ["- inspect `file.ts`"],
                "content": [],
                "encrypted_content": "enc_1"
            }),
            Some("done"),
        )
        .unwrap();

        assert_eq!(output["status"], json!("completed"));
        assert_eq!(
            output["summary"],
            json!([{ "type": "summary_text", "text": "- inspect `file.ts`" }])
        );
        assert_eq!(output["encrypted_content"], json!("enc_1"));
    }

    #[test]
    fn rejects_responses_sse_output_item_added_descriptor_missing_type() {
        let err = build_responses_sse_output_item_descriptor(
            json!({
                "id": "item_missing_type"
            }),
            Some("added"),
        )
        .unwrap_err();

        assert!(err.contains("Responses output item descriptor missing type"));
    }

    #[test]
    fn rejects_responses_sse_reasoning_descriptor_malformed_content() {
        let err = build_responses_sse_output_item_descriptor(
            json!({
                "id": "rs_malformed_content",
                "type": "reasoning",
                "summary": [],
                "content": { "type": "reasoning_text", "text": "think" }
            }),
            Some("done"),
        )
        .unwrap_err();

        assert!(err.contains("Invalid Responses reasoning content: expected array"));
    }

    #[test]
    fn builds_responses_sse_content_part_added_descriptor() {
        let output = build_responses_sse_content_part_descriptor(
            json!({
                "type": "output_text",
                "text": "final text",
                "annotations": [{ "type": "file_citation" }],
                "logprobs": [{ "token": "x" }]
            }),
            Some("added"),
        )
        .unwrap();

        assert_eq!(
            output,
            json!({
                "type": "output_text",
                "text": "final text",
                "annotations": [{ "type": "file_citation" }],
                "logprobs": [{ "token": "x" }]
            })
        );
    }

    #[test]
    fn rejects_responses_sse_content_part_descriptor_missing_text() {
        let err = build_responses_sse_content_part_descriptor(
            json!({
                "type": "output_text"
            }),
            Some("added"),
        )
        .unwrap_err();

        assert!(err.contains("Responses content part descriptor missing text"));
    }

    #[test]
    fn builds_responses_sse_content_part_done_descriptor() {
        let output = build_responses_sse_content_part_descriptor(
            json!({
                "type": "function_result",
                "result": { "ok": true },
                "tool_call_id": "call_1"
            }),
            Some("done"),
        )
        .unwrap();

        assert_eq!(
            output,
            json!({
                "type": "function_result",
                "result": { "ok": true },
                "tool_call_id": "call_1"
            })
        );
    }

    #[test]
    fn rejects_responses_sse_content_part_descriptor_missing_type() {
        let err = build_responses_sse_content_part_descriptor(
            json!({
                "text": "missing type"
            }),
            Some("added"),
        )
        .unwrap_err();

        assert!(err.contains("Responses content part descriptor missing type"));
    }

    #[test]
    fn builds_responses_sse_output_item_event_payload_with_added_item() {
        let output = build_responses_sse_output_item_event_payload(
            json!({
                "id": "msg_1",
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "hello" }]
            }),
            7,
            "added",
        )
        .unwrap();

        assert_eq!(output["output_index"], json!(7));
        assert_eq!(output["item"]["status"], json!("in_progress"));
        assert_eq!(output["item"]["content"], json!([]));
    }

    #[test]
    fn builds_responses_sse_content_part_event_payload_with_done_part() {
        let output = build_responses_sse_content_part_event_payload(
            Some(json!({
                "type": "output_text",
                "text": "final text",
                "annotations": [{ "type": "file_citation" }],
                "logprobs": [{ "token": "x" }]
            })),
            7,
            "msg_1",
            1,
            "done",
        )
        .unwrap();

        assert_eq!(output["output_index"], json!(7));
        assert_eq!(output["item_id"], json!("msg_1"));
        assert_eq!(output["content_index"], json!(1));
        assert_eq!(output["part"]["type"], json!("output_text"));
        assert_eq!(output["part"]["text"], json!("final text"));
    }

    #[test]
    fn builds_responses_sse_content_part_event_payload_without_part_for_done() {
        let output =
            build_responses_sse_content_part_event_payload(None, 7, "msg_1", 1, "done").unwrap();

        assert_eq!(
            output,
            json!({
                "output_index": 7,
                "item_id": "msg_1",
                "content_index": 1
            })
        );
    }

    #[test]
    fn builds_responses_sse_output_text_done_payload() {
        let output =
            build_responses_sse_output_text_done_payload(3, "msg_1", 1, "final text").unwrap();

        assert_eq!(
            output,
            json!({
                "output_index": 3,
                "item_id": "msg_1",
                "content_index": 1,
                "text": "final text",
                "logprobs": []
            })
        );
    }

    #[test]
    fn builds_responses_sse_output_text_delta_payload() {
        let output =
            build_responses_sse_output_text_delta_payload(3, "msg_1", 1, "delta text").unwrap();

        assert_eq!(
            output,
            json!({
                "output_index": 3,
                "item_id": "msg_1",
                "content_index": 1,
                "delta": "delta text",
                "logprobs": []
            })
        );
    }

    #[test]
    fn rejects_responses_sse_output_text_done_payload_missing_item_id() {
        let err =
            build_responses_sse_output_text_done_payload(3, "   ", 1, "final text").unwrap_err();

        assert!(err.contains("Responses output text done payload item_id is required"));
    }

    #[test]
    fn builds_responses_sse_function_call_arguments_delta_payload() {
        let output = build_responses_sse_function_call_arguments_delta_payload(
            2, "fc_1", "call_1", "{\"q\"",
        )
        .unwrap();

        assert_eq!(
            output,
            json!({
                "output_index": 2,
                "item_id": "fc_1",
                "call_id": "call_1",
                "delta": "{\"q\""
            })
        );
    }

    #[test]
    fn builds_responses_sse_function_call_arguments_done_payload() {
        let output = build_responses_sse_function_call_arguments_done_payload(
            2,
            "fc_1",
            "call_1",
            "search",
            "{\"q\":\"rust\"}",
        )
        .unwrap();

        assert_eq!(
            output,
            json!({
                "output_index": 2,
                "item_id": "fc_1",
                "call_id": "call_1",
                "name": "search",
                "arguments": "{\"q\":\"rust\"}"
            })
        );
    }

    #[test]
    fn rejects_responses_sse_function_call_arguments_done_missing_call_id() {
        let err = build_responses_sse_function_call_arguments_done_payload(
            2,
            "fc_1",
            " ",
            "search",
            "{\"q\":\"rust\"}",
        )
        .unwrap_err();

        assert!(err.contains("Responses function call arguments done payload call_id is required"));
    }

    #[test]
    fn builds_responses_sse_reasoning_summary_part_payloads() {
        let added = build_responses_sse_reasoning_summary_payload(
            "part_added",
            1,
            "rs_1",
            0,
            "summary text",
        )
        .unwrap();
        let done = build_responses_sse_reasoning_summary_payload(
            "part_done",
            1,
            "rs_1",
            0,
            "summary text",
        )
        .unwrap();

        assert_eq!(
            added,
            json!({
                "output_index": 1,
                "item_id": "rs_1",
                "summary_index": 0,
                "part": { "type": "summary_text", "text": "" }
            })
        );
        assert_eq!(
            done,
            json!({
                "output_index": 1,
                "item_id": "rs_1",
                "summary_index": 0,
                "part": { "type": "summary_text", "text": "summary text" }
            })
        );
    }

    #[test]
    fn builds_responses_sse_reasoning_summary_text_payloads() {
        let delta =
            build_responses_sse_reasoning_summary_payload("text_delta", 1, "rs_1", 0, "summary")
                .unwrap();
        let done = build_responses_sse_reasoning_summary_payload(
            "text_done",
            1,
            "rs_1",
            0,
            "summary text",
        )
        .unwrap();

        assert_eq!(
            delta,
            json!({
                "output_index": 1,
                "item_id": "rs_1",
                "summary_index": 0,
                "delta": "summary"
            })
        );
        assert_eq!(
            done,
            json!({
                "output_index": 1,
                "item_id": "rs_1",
                "summary_index": 0,
                "text": "summary text"
            })
        );
    }

    #[test]
    fn rejects_responses_sse_reasoning_summary_payload_missing_item_id() {
        let err =
            build_responses_sse_reasoning_summary_payload("part_done", 1, " ", 0, "summary text")
                .unwrap_err();

        assert!(err.contains("Responses reasoning summary payload item_id is required"));
    }

    #[test]
    fn builds_responses_sse_reasoning_lifecycle_payloads() {
        let start = build_responses_sse_reasoning_lifecycle_payload(
            "start",
            "rs_1",
            Some(&json!(["- keep `verbatim`"])),
        )
        .unwrap();
        let done = build_responses_sse_reasoning_lifecycle_payload("done", "rs_1", None).unwrap();

        assert_eq!(
            start,
            json!({
                "item_id": "rs_1",
                "summary": [{ "type": "summary_text", "text": "- keep `verbatim`" }]
            })
        );
        assert_eq!(done, json!({ "item_id": "rs_1" }));
    }

    #[test]
    fn rejects_responses_sse_reasoning_lifecycle_payload_missing_item_id() {
        let err = build_responses_sse_reasoning_lifecycle_payload("start", " ", None).unwrap_err();

        assert!(err.contains("Responses reasoning lifecycle payload item_id is required"));
    }

    #[test]
    fn builds_responses_sse_reasoning_delta_payloads() {
        let text = build_responses_sse_reasoning_delta_payload(
            "text",
            1,
            "rs_1",
            0,
            Value::String("think".to_string()),
        )
        .unwrap();
        let signature = build_responses_sse_reasoning_delta_payload(
            "signature",
            1,
            "rs_1",
            1,
            json!({ "ciphertext": "sig" }),
        )
        .unwrap();
        let image = build_responses_sse_reasoning_delta_payload(
            "image",
            1,
            "rs_1",
            2,
            Value::String("https://img".to_string()),
        )
        .unwrap();

        assert_eq!(
            text,
            json!({
                "output_index": 1,
                "item_id": "rs_1",
                "content_index": 0,
                "delta": "think"
            })
        );
        assert_eq!(
            signature,
            json!({
                "output_index": 1,
                "item_id": "rs_1",
                "content_index": 1,
                "signature": { "ciphertext": "sig" }
            })
        );
        assert_eq!(
            image,
            json!({
                "output_index": 1,
                "item_id": "rs_1",
                "content_index": 2,
                "image_url": "https://img"
            })
        );
    }

    #[test]
    fn rejects_responses_sse_reasoning_delta_payload_missing_item_id() {
        let err = build_responses_sse_reasoning_delta_payload(
            "text",
            1,
            " ",
            0,
            Value::String("think".to_string()),
        )
        .unwrap_err();

        assert!(err.contains("Responses reasoning delta payload item_id is required"));
    }

    #[test]
    fn rejects_responses_sse_reasoning_delta_payload_missing_value() {
        let err = build_responses_sse_reasoning_delta_payload_json(
            json!({
                "output_index": 1,
                "item_id": "rs_1",
                "content_index": 0
            })
            .to_string(),
            Some("text".to_string()),
        )
        .unwrap_err();

        assert!(err.contains("Responses reasoning delta payload missing value"));
    }

    fn sequence_event_types(output: &str) -> Vec<String> {
        let parsed: Value = serde_json::from_str(output).unwrap();
        parsed
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["type"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn builds_responses_sse_event_sequence_for_text_response() {
        let output = build_responses_sse_event_sequence_json(
            json!({
                "request_id": "req_responses_sequence_text",
                "config": {
                    "enableTimestampGeneration": false,
                    "includeSequenceNumbers": true,
                    "chunkSize": 0
                },
                "response": {
                    "id": "resp_text",
                    "object": "response",
                    "created_at": 1781149537,
                    "status": "completed",
                    "model": "gpt-test",
                    "output": [{
                        "id": "msg_1",
                        "type": "message",
                        "status": "completed",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": "hello" }]
                    }]
                }
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            sequence_event_types(&output),
            vec![
                "response.created",
                "response.in_progress",
                "response.output_item.added",
                "response.content_part.added",
                "response.output_text.delta",
                "response.output_text.done",
                "response.content_part.done",
                "response.output_item.done",
                "response.completed",
                "response.done"
            ]
        );
        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed[4]["data"]["delta"], json!("hello"));
        assert_eq!(
            parsed[4]["data"]["type"],
            json!("response.output_text.delta")
        );
        assert_eq!(parsed[4]["data"]["sequence_number"], json!(4));
    }

    #[test]
    fn builds_responses_sse_event_sequence_for_function_call() {
        let output = build_responses_sse_event_sequence_json(
            json!({
                "request_id": "req_responses_sequence_function",
                "config": {
                    "enableTimestampGeneration": false,
                    "includeSequenceNumbers": true,
                    "chunkSize": 0
                },
                "response": {
                    "id": "resp_function",
                    "object": "response",
                    "created_at": 1781149537,
                    "status": "completed",
                    "model": "gpt-test",
                    "output": [{
                        "id": "fc_1",
                        "type": "function_call",
                        "status": "completed",
                        "call_id": "call_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }]
                }
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            sequence_event_types(&output),
            vec![
                "response.created",
                "response.in_progress",
                "response.output_item.added",
                "response.function_call_arguments.delta",
                "response.function_call_arguments.done",
                "response.output_item.done",
                "response.completed",
                "response.done"
            ]
        );
        let parsed: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed[4]["data"]["name"], json!("exec_command"));
    }

    #[test]
    fn builds_responses_sse_event_sequence_for_reasoning_summary() {
        let output = build_responses_sse_event_sequence_json(
            json!({
                "request_id": "req_responses_sequence_reasoning",
                "config": {
                    "enableTimestampGeneration": false,
                    "includeSequenceNumbers": true,
                    "chunkSize": 0
                },
                "response": {
                    "id": "resp_reasoning",
                    "object": "response",
                    "created_at": 1781149537,
                    "status": "completed",
                    "model": "gpt-test",
                    "output": [{
                        "id": "rs_1",
                        "type": "reasoning",
                        "summary": [{ "type": "summary_text", "text": "summary" }]
                    }]
                }
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            sequence_event_types(&output),
            vec![
                "response.created",
                "response.in_progress",
                "response.output_item.added",
                "response.reasoning_summary_part.added",
                "response.reasoning_summary_text.delta",
                "response.reasoning_summary_text.done",
                "response.reasoning_summary_part.done",
                "response.output_item.done",
                "response.completed",
                "response.done"
            ]
        );
    }

    #[test]
    fn rejects_responses_sse_event_sequence_missing_status() {
        let err = build_responses_sse_event_sequence_json(
            json!({
                "request_id": "req_responses_sequence_missing_status",
                "response": {
                    "id": "resp_missing_status",
                    "object": "response",
                    "created_at": 1781149537,
                    "model": "gpt-test",
                    "output": []
                }
            })
            .to_string(),
        )
        .unwrap_err();

        assert!(err.contains("Invalid Responses response: missing status"));
    }
}
