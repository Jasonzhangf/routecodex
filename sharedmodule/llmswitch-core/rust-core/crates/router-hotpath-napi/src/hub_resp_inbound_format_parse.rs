use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::hub_resp_outbound_client_semantics::build_openai_chat_response_from_anthropic_message;

// feature_id: hub.response_provider_sse_materialization

const MAX_PAYLOAD_SIZE_BYTES: usize = 50 * 1024 * 1024; // 50MB limit

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespFormatParseInput {
    pub payload: Value,
    pub protocol: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatEnvelope {
    pub format: String,
    pub version: String,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespFormatParseOutput {
    pub envelope: FormatEnvelope,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResponseSseMaterializeInput {
    pub payload: Value,
    #[serde(default)]
    pub stream_body_text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResponseSseStreamReadErrorInput {
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub upstream_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResponseSseStreamReadErrorOutput {
    pub message: String,
    pub code: String,
    pub upstream_code: String,
    pub status_code: i64,
    pub retryable: bool,
    pub request_executor_provider_error_stage: String,
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

fn read_non_empty_text(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    if text.trim().is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn read_provider_response_sse_text(payload: &Value) -> Option<String> {
    let record = payload.as_object()?;
    if let Some(body_text) = read_non_empty_text(record.get("bodyText")) {
        return Some(body_text);
    }
    if let Some(raw) = read_non_empty_text(record.get("raw")) {
        return Some(raw);
    }
    if let Some(nested) = record.get("data").and_then(Value::as_object) {
        if let Some(body_text) = read_non_empty_text(nested.get("bodyText")) {
            return Some(body_text);
        }
        if let Some(raw) = read_non_empty_text(nested.get("raw")) {
            return Some(raw);
        }
    }
    None
}

fn has_provider_sse_marker_signal(record: &Map<String, Value>) -> bool {
    let mode = record
        .get("mode")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    mode == "sse"
        || mode == "sse_passthrough"
        || (record
            .get("clientStream")
            .and_then(Value::as_bool)
            .unwrap_or(false))
}

fn is_provider_response_sse_marker(payload: &Value) -> bool {
    payload.as_object().is_some_and(|record| {
        has_provider_sse_marker_signal(record) && read_provider_response_sse_text(payload).is_none()
    })
}

pub fn materialize_provider_response_sse_payload(
    input: ProviderResponseSseMaterializeInput,
) -> Result<Value, String> {
    let Some(record) = input.payload.as_object() else {
        return Ok(input.payload);
    };

    if let Some(body_text) = read_provider_response_sse_text(&input.payload).or_else(|| {
        input.stream_body_text.and_then(|text| {
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        })
    }) {
        let mut output = record.clone();
        output.insert("mode".to_string(), Value::String("sse".to_string()));
        output.insert("bodyText".to_string(), Value::String(body_text));
        return Ok(Value::Object(output));
    }

    if !is_provider_response_sse_marker(&input.payload) {
        return Ok(input.payload);
    }

    Err("Provider SSE marker did not include materializable stream or bodyText".to_string())
}

pub fn build_provider_sse_stream_read_error_descriptor(
    input: ProviderResponseSseStreamReadErrorInput,
) -> ProviderResponseSseStreamReadErrorOutput {
    let message = input
        .message
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let normalized_message = message.to_ascii_lowercase();
    let normalized_code = input
        .code
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let upstream_code =
        if normalized_message.contains("terminated") || normalized_code.contains("terminated") {
            "UPSTREAM_STREAM_TERMINATED".to_string()
        } else if let Some(value) = input
            .upstream_code
            .or(input.code)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            value
        } else {
            "SSE_TO_JSON_ERROR".to_string()
        };
    ProviderResponseSseStreamReadErrorOutput {
        message,
        code: "SSE_DECODE_ERROR".to_string(),
        upstream_code,
        status_code: 502,
        retryable: true,
        request_executor_provider_error_stage: "provider.sse_decode".to_string(),
    }
}

fn parse_openai_responses_response(payload: &Value) -> Result<FormatEnvelope, String> {
    let materialized = materialize_openai_responses_response_payload(payload)?;
    validate_payload_size(&materialized)?;

    // Extract model from response if available
    let model = materialized
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(FormatEnvelope {
        format: "openai-responses".to_string(),
        version: "v1".to_string(),
        payload: materialized,
        metadata: Some(serde_json::json!({
            "model": model,
            "extracted_at": "resp_format_parse"
        })),
    })
}

fn materialize_openai_responses_response_payload(payload: &Value) -> Result<Value, String> {
    if is_openai_responses_response_payload(payload) {
        let mut materialized = payload.clone();
        normalize_openai_responses_tool_calls_arrays(&mut materialized);
        return Ok(materialized);
    }
    if let Some(body_text) = payload
        .get("bodyText")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        let mut materialized = materialize_openai_responses_sse_body_text(body_text)?;
        normalize_openai_responses_tool_calls_arrays(&mut materialized);
        return Ok(materialized);
    }
    if let Some(body) = payload.get("body") {
        if is_openai_responses_response_payload(body) {
            let mut materialized = body.clone();
            normalize_openai_responses_tool_calls_arrays(&mut materialized);
            return Ok(materialized);
        }
        if let Some(body_text) = body
            .get("bodyText")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        {
            let mut materialized = materialize_openai_responses_sse_body_text(body_text)?;
            normalize_openai_responses_tool_calls_arrays(&mut materialized);
            return Ok(materialized);
        }
    }
    let mut materialized = payload.clone();
    normalize_openai_responses_tool_calls_arrays(&mut materialized);
    Ok(materialized)
}

fn is_openai_responses_response_payload(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|row| row.get("output").and_then(Value::as_array).is_some())
}

fn normalize_openai_responses_tool_calls_arrays(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if let Some(tool_calls) = object.get_mut("tool_calls") {
                if !tool_calls.is_array() {
                    let normalized = match std::mem::take(tool_calls) {
                        Value::Null => Value::Array(Vec::new()),
                        other => Value::Array(vec![other]),
                    };
                    *tool_calls = normalized;
                }
            }
            for child in object.values_mut() {
                normalize_openai_responses_tool_calls_arrays(child);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                normalize_openai_responses_tool_calls_arrays(item);
            }
        }
        _ => {}
    }
}

fn parse_openai_chat_response(payload: &Value) -> Result<FormatEnvelope, String> {
    let materialized = materialize_openai_chat_response_payload(payload)?;
    validate_payload_size(&materialized)?;

    if !materialized.is_object() {
        return Err("OpenAI chat response must be a JSON object".to_string());
    }
    let choices = materialized
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| "OpenAI chat response must contain choices array".to_string())?;
    if choices.is_empty() {
        return Err("OpenAI chat response choices array must not be empty".to_string());
    }

    let model = materialized
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(FormatEnvelope {
        format: "openai-chat".to_string(),
        version: "v1".to_string(),
        payload: materialized,
        metadata: Some(serde_json::json!({
            "model": model,
            "extracted_at": "resp_format_parse"
        })),
    })
}

#[derive(Default)]
struct OpenAiChatStreamChoice {
    role: Option<String>,
    content: String,
    reasoning_content: String,
    tool_calls: std::collections::BTreeMap<usize, OpenAiChatStreamToolCall>,
    finish_reason: Option<Value>,
}

#[derive(Default)]
struct OpenAiChatStreamToolCall {
    id: Option<String>,
    kind: Option<String>,
    function_name: Option<String>,
    function_arguments: String,
}

fn materialize_openai_chat_response_payload(payload: &Value) -> Result<Value, String> {
    if payload.get("choices").and_then(Value::as_array).is_some() {
        let mut materialized = payload.clone();
        normalize_openai_chat_message_tool_calls_arrays(&mut materialized);
        return Ok(materialized);
    }
    if let Some(data) = payload.get("data") {
        if data.get("choices").and_then(Value::as_array).is_some() {
            let mut materialized = data.clone();
            normalize_openai_chat_message_tool_calls_arrays(&mut materialized);
            return Ok(materialized);
        }
    }
    if let Some(body_text) = payload
        .get("bodyText")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        return materialize_openai_chat_sse_body_text(body_text);
    }
    if let Some(body) = payload.get("body") {
        if body.get("choices").and_then(Value::as_array).is_some() {
            let mut materialized = body.clone();
            normalize_openai_chat_message_tool_calls_arrays(&mut materialized);
            return Ok(materialized);
        }
        if let Some(data) = body.get("data") {
            if data.get("choices").and_then(Value::as_array).is_some() {
                let mut materialized = data.clone();
                normalize_openai_chat_message_tool_calls_arrays(&mut materialized);
                return Ok(materialized);
            }
        }
        if let Some(body_text) = body
            .get("bodyText")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        {
            return materialize_openai_chat_sse_body_text(body_text);
        }
    }
    let mut materialized = payload.clone();
    normalize_openai_chat_message_tool_calls_arrays(&mut materialized);
    Ok(materialized)
}

fn normalize_openai_chat_message_tool_calls_arrays(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if let Some(choices) = object.get_mut("choices").and_then(Value::as_array_mut) {
                for choice in choices {
                    if let Some(choice_row) = choice.as_object_mut() {
                        if let Some(message) =
                            choice_row.get_mut("message").and_then(Value::as_object_mut)
                        {
                            if let Some(tool_calls) = message.get_mut("tool_calls") {
                                if !tool_calls.is_array() {
                                    let normalized = match std::mem::take(tool_calls) {
                                        Value::Null => Value::Array(Vec::new()),
                                        other => Value::Array(vec![other]),
                                    };
                                    *tool_calls = normalized;
                                }
                            }
                        }
                    }
                }
            }
            for child in object.values_mut() {
                normalize_openai_chat_message_tool_calls_arrays(child);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                normalize_openai_chat_message_tool_calls_arrays(item);
            }
        }
        _ => {}
    }
}

fn parse_openai_chat_sse_json_events(body_text: &str) -> Vec<Value> {
    let mut events: Vec<Value> = Vec::new();
    let mut data_lines: Vec<String> = Vec::new();
    let flush = |events: &mut Vec<Value>, data_lines: &mut Vec<String>| {
        if data_lines.is_empty() {
            return;
        }
        let data = data_lines.join("\n");
        data_lines.clear();
        let trimmed = data.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            return;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            events.push(value);
        }
    };

    for line in body_text.lines() {
        let trimmed_end = line.trim_end_matches('\r');
        if trimmed_end.is_empty() {
            flush(&mut events, &mut data_lines);
            continue;
        }
        if let Some(raw) = trimmed_end.strip_prefix("data:") {
            data_lines.push(raw.trim_start().to_string());
        }
    }
    flush(&mut events, &mut data_lines);
    events
}

fn parse_sse_json_events(body_text: &str) -> Vec<(Option<String>, Value)> {
    let mut events: Vec<(Option<String>, Value)> = Vec::new();
    let mut event_name: Option<String> = None;
    let mut data_lines: Vec<String> = Vec::new();
    let flush = |events: &mut Vec<(Option<String>, Value)>,
                 event_name: &mut Option<String>,
                 data_lines: &mut Vec<String>| {
        if data_lines.is_empty() {
            *event_name = None;
            return;
        }
        let data = data_lines.join("\n");
        data_lines.clear();
        let event = event_name.take();
        let trimmed = data.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            return;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            events.push((event, value));
        }
    };

    for line in body_text.lines() {
        let trimmed_end = line.trim_end_matches('\r');
        if trimmed_end.is_empty() {
            flush(&mut events, &mut event_name, &mut data_lines);
            continue;
        }
        if let Some(raw) = trimmed_end.strip_prefix("event:") {
            event_name = Some(raw.trim().to_string());
            continue;
        }
        if let Some(raw) = trimmed_end.strip_prefix("data:") {
            data_lines.push(raw.trim_start().to_string());
        }
    }
    flush(&mut events, &mut event_name, &mut data_lines);
    events
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn merge_response_object(target: &mut Map<String, Value>, response: &Map<String, Value>) {
    for (key, value) in response {
        if key == "metadata" {
            continue;
        }
        if key == "output" {
            merge_response_output_array(target, value);
            continue;
        }
        target.insert(key.clone(), value.clone());
    }
}

fn output_item_matches(
    existing_obj: &Map<String, Value>,
    item_id: &Option<String>,
    call_id: &Option<String>,
) -> bool {
    item_id
        .as_ref()
        .zip(read_trimmed_string(existing_obj.get("id")).as_ref())
        .is_some_and(|(left, right)| left == right)
        || call_id
            .as_ref()
            .zip(read_trimmed_string(existing_obj.get("call_id")).as_ref())
            .is_some_and(|(left, right)| left == right)
}

fn merge_output_item_value(existing: &Value, item: &Value) -> Value {
    let (Some(existing_obj), Some(item_obj)) = (existing.as_object(), item.as_object()) else {
        return item.clone();
    };
    let mut merged = existing_obj.clone();
    for (key, value) in item_obj {
        merged.insert(key.clone(), value.clone());
    }
    Value::Object(merged)
}

fn record_response_output_item(
    target: &mut Map<String, Value>,
    item: &Value,
    merge_existing: bool,
) {
    let Some(item_obj) = item.as_object() else {
        return;
    };
    let item_id = read_trimmed_string(item_obj.get("id"));
    let call_id = read_trimmed_string(item_obj.get("call_id"));
    let mut output = target
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let existing_index = output.iter().position(|existing| {
        existing
            .as_object()
            .is_some_and(|existing_obj| output_item_matches(existing_obj, &item_id, &call_id))
    });
    match existing_index {
        Some(index) if merge_existing => {
            output[index] = merge_output_item_value(&output[index], item);
        }
        Some(_) => {}
        None => output.push(item.clone()),
    }
    target.insert("output".to_string(), Value::Array(output));
}

fn merge_response_output_array(target: &mut Map<String, Value>, value: &Value) {
    let Some(items) = value.as_array() else {
        target.insert("output".to_string(), value.clone());
        return;
    };
    if items.is_empty() {
        if !target.contains_key("output") {
            target.insert("output".to_string(), Value::Array(Vec::new()));
        }
        return;
    }
    for item in items {
        record_response_output_item(target, item, true);
    }
}

fn read_response_function_call_arguments_key(event_obj: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(event_obj.get("item_id"))
        .or_else(|| read_trimmed_string(event_obj.get("id")))
        .or_else(|| read_trimmed_string(event_obj.get("call_id")))
}

fn apply_function_call_argument_buffers(
    target: &mut Map<String, Value>,
    buffers: &std::collections::BTreeMap<String, String>,
) {
    if buffers.is_empty() {
        return;
    }
    let mut output = target
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut changed = false;
    for item in &mut output {
        let Some(item_obj) = item.as_object_mut() else {
            continue;
        };
        if item_obj.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }
        let item_id = read_trimmed_string(item_obj.get("id"));
        let call_id = read_trimmed_string(item_obj.get("call_id"));
        let Some(arguments) = item_id
            .as_ref()
            .and_then(|id| buffers.get(id))
            .or_else(|| call_id.as_ref().and_then(|id| buffers.get(id)))
        else {
            continue;
        };
        item_obj.insert("arguments".to_string(), Value::String(arguments.clone()));
        changed = true;
    }
    if changed {
        target.insert("output".to_string(), Value::Array(output));
    }
}

fn materialize_openai_responses_sse_body_text(body_text: &str) -> Result<Value, String> {
    let events = parse_sse_json_events(body_text);
    if events.is_empty() {
        return Err("OpenAI Responses SSE response did not contain JSON data events".to_string());
    }

    let mut response = Map::new();
    let mut function_call_argument_buffers = std::collections::BTreeMap::<String, String>::new();
    for (event_name, event) in events {
        let Some(event_obj) = event.as_object() else {
            continue;
        };
        let event_type = read_trimmed_string(event_obj.get("type")).unwrap_or_default();
        let event_name = event_name.unwrap_or_default();
        if event_name == "response.error" || event_type == "response.error" {
            let message = event_obj
                .get("error")
                .and_then(Value::as_object)
                .and_then(|error| read_trimmed_string(error.get("message")))
                .unwrap_or_else(|| "OpenAI Responses SSE stream error".to_string());
            return Err(format!("OpenAI Responses SSE stream error: {}", message));
        }
        if let Some(response_obj) = event_obj.get("response").and_then(Value::as_object) {
            merge_response_object(&mut response, response_obj);
        }
        let is_output_item_added = event_name == "response.output_item.added"
            || event_type == "response.output_item.added";
        let is_output_item_done =
            event_name == "response.output_item.done" || event_type == "response.output_item.done";
        if is_output_item_added || is_output_item_done {
            if let Some(item) = event_obj.get("item") {
                record_response_output_item(&mut response, item, is_output_item_done);
            }
        }
        let is_function_call_arguments_delta = event_name
            == "response.function_call_arguments.delta"
            || event_type == "response.function_call_arguments.delta";
        let is_function_call_arguments_done = event_name == "response.function_call_arguments.done"
            || event_type == "response.function_call_arguments.done";
        if is_function_call_arguments_delta || is_function_call_arguments_done {
            if let Some(key) = read_response_function_call_arguments_key(event_obj) {
                if let Some(arguments) = event_obj.get("arguments").and_then(Value::as_str) {
                    function_call_argument_buffers.insert(key, arguments.to_string());
                } else if let Some(delta) = event_obj.get("delta").and_then(Value::as_str) {
                    function_call_argument_buffers
                        .entry(key)
                        .or_default()
                        .push_str(delta);
                }
            }
        }
        if (event_name == "response.required_action" || event_type == "response.required_action")
            && event_obj.get("required_action").is_some()
        {
            response.insert(
                "required_action".to_string(),
                event_obj
                    .get("required_action")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            response.insert(
                "status".to_string(),
                Value::String("requires_action".to_string()),
            );
        }
    }
    apply_function_call_argument_buffers(&mut response, &function_call_argument_buffers);

    if response.is_empty() {
        return Err("OpenAI Responses SSE response did not contain response payload".to_string());
    }
    if !response.contains_key("object") {
        response.insert("object".to_string(), Value::String("response".to_string()));
    }
    if !response.contains_key("status") {
        response.insert("status".to_string(), Value::String("completed".to_string()));
    }
    Ok(Value::Object(response))
}

fn materialize_openai_chat_sse_body_text(body_text: &str) -> Result<Value, String> {
    let events = parse_openai_chat_sse_json_events(body_text);
    if events.is_empty() {
        return Err("OpenAI chat SSE response did not contain JSON data events".to_string());
    }

    let mut response_id: Option<String> = None;
    let mut model: Option<String> = None;
    let mut created: Option<Value> = None;
    let mut usage: Option<Value> = None;
    let mut choices = std::collections::BTreeMap::<usize, OpenAiChatStreamChoice>::new();

    for event in events {
        let Some(event_row) = event.as_object() else {
            continue;
        };
        response_id = read_trimmed_string(event_row.get("id")).or(response_id);
        model = read_trimmed_string(event_row.get("model")).or(model);
        if created.is_none() {
            created = event_row.get("created").cloned();
        }
        if event_row.get("usage").is_some()
            && !event_row.get("usage").unwrap_or(&Value::Null).is_null()
        {
            usage = event_row.get("usage").cloned();
        }
        let Some(event_choices) = event_row.get("choices").and_then(Value::as_array) else {
            continue;
        };
        for choice_value in event_choices {
            let Some(choice_row) = choice_value.as_object() else {
                continue;
            };
            let index = choice_row.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let choice = choices.entry(index).or_default();
            if choice_row.get("finish_reason").is_some()
                && !choice_row
                    .get("finish_reason")
                    .unwrap_or(&Value::Null)
                    .is_null()
            {
                choice.finish_reason = choice_row.get("finish_reason").cloned();
            }
            let Some(delta) = choice_row.get("delta").and_then(Value::as_object) else {
                continue;
            };
            choice.role = read_trimmed_string(delta.get("role")).or(choice.role.take());
            if let Some(content) = delta.get("content").and_then(Value::as_str) {
                choice.content.push_str(content);
            }
            if let Some(reasoning) = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str)
            {
                choice.reasoning_content.push_str(reasoning);
            }
            if let Some(tool_call_deltas) = delta.get("tool_calls").and_then(Value::as_array) {
                for tool_call_value in tool_call_deltas {
                    let Some(tool_call_row) = tool_call_value.as_object() else {
                        continue;
                    };
                    let tool_index = tool_call_row
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as usize;
                    let tool_call = choice.tool_calls.entry(tool_index).or_default();
                    tool_call.id =
                        read_trimmed_string(tool_call_row.get("id")).or(tool_call.id.take());
                    tool_call.kind =
                        read_trimmed_string(tool_call_row.get("type")).or(tool_call.kind.take());
                    if let Some(function) = tool_call_row.get("function").and_then(Value::as_object)
                    {
                        tool_call.function_name = read_trimmed_string(function.get("name"))
                            .or(tool_call.function_name.take());
                        if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                            tool_call.function_arguments.push_str(arguments);
                        }
                    }
                }
            }
        }
    }

    if choices.is_empty() {
        return Err("OpenAI chat SSE response did not contain choices array".to_string());
    }

    let mut materialized_choices: Vec<Value> = Vec::new();
    for (index, choice) in choices {
        let mut message = Map::new();
        message.insert(
            "role".to_string(),
            Value::String(choice.role.unwrap_or_else(|| "assistant".to_string())),
        );
        message.insert("content".to_string(), Value::String(choice.content));
        if !choice.reasoning_content.is_empty() {
            message.insert(
                "reasoning_content".to_string(),
                Value::String(choice.reasoning_content),
            );
        }
        if !choice.tool_calls.is_empty() {
            let tool_calls = choice
                .tool_calls
                .into_iter()
                .map(|(tool_index, tool_call)| {
                    Value::Object(Map::from_iter([
                        (
                            "id".to_string(),
                            Value::String(
                                tool_call.id.unwrap_or_else(|| format!("call_{tool_index}")),
                            ),
                        ),
                        (
                            "type".to_string(),
                            Value::String(tool_call.kind.unwrap_or_else(|| "function".to_string())),
                        ),
                        (
                            "function".to_string(),
                            Value::Object(Map::from_iter([
                                (
                                    "name".to_string(),
                                    Value::String(
                                        tool_call
                                            .function_name
                                            .unwrap_or_else(|| "tool".to_string()),
                                    ),
                                ),
                                (
                                    "arguments".to_string(),
                                    Value::String(tool_call.function_arguments),
                                ),
                            ])),
                        ),
                    ]))
                })
                .collect::<Vec<Value>>();
            message.insert("tool_calls".to_string(), Value::Array(tool_calls));
        }
        materialized_choices.push(Value::Object(Map::from_iter([
            ("index".to_string(), Value::from(index as u64)),
            ("message".to_string(), Value::Object(message)),
            (
                "finish_reason".to_string(),
                choice
                    .finish_reason
                    .unwrap_or(Value::String("stop".to_string())),
            ),
        ])));
    }

    let mut response = Map::new();
    response.insert(
        "id".to_string(),
        Value::String(response_id.unwrap_or_else(|| "chatcmpl_sse".to_string())),
    );
    response.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    response.insert(
        "model".to_string(),
        Value::String(model.unwrap_or_default()),
    );
    response.insert("choices".to_string(), Value::Array(materialized_choices));
    if let Some(created) = created {
        response.insert("created".to_string(), created);
    }
    if let Some(usage) = usage {
        response.insert("usage".to_string(), usage);
    }
    Ok(Value::Object(response))
}

fn unsupported_protocol_error(protocol: &str) -> String {
    format!(
        "Unsupported response protocol for Rust HubPipeline resp format parse: {}",
        protocol
    )
}

fn parse_anthropic_messages_response(payload: &Value) -> Result<FormatEnvelope, String> {
    let materialized = build_openai_chat_response_from_anthropic_message(payload, "resp_inbound")?;
    validate_payload_size(&materialized)?;

    let model = materialized
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(FormatEnvelope {
        format: "openai-chat".to_string(),
        version: "v1".to_string(),
        payload: materialized,
        metadata: Some(serde_json::json!({
            "model": model,
            "provider_format": "anthropic-messages",
            "extracted_at": "resp_format_parse"
        })),
    })
}

fn parse_gemini_chat_response(payload: &Value) -> Result<FormatEnvelope, String> {
    validate_payload_size(payload)?;

    // Gemini response model might be in different locations
    let model = payload
        .get("modelVersion")
        .or_else(|| payload.get("model"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(FormatEnvelope {
        format: "gemini-chat".to_string(),
        version: "v1".to_string(),
        payload: payload.clone(),
        metadata: Some(serde_json::json!({
            "model": model,
            "extracted_at": "resp_format_parse"
        })),
    })
}

pub fn parse_resp_format_envelope(
    input: RespFormatParseInput,
) -> Result<RespFormatParseOutput, String> {
    let envelope = match input.protocol.as_str() {
        "openai-chat" => parse_openai_chat_response(&input.payload)?,
        "openai-responses" => parse_openai_responses_response(&input.payload)?,
        "anthropic-messages" => parse_anthropic_messages_response(&input.payload)?,
        "gemini-chat" => parse_gemini_chat_response(&input.payload)?,
        _ => return Err(unsupported_protocol_error(&input.protocol)),
    };

    Ok(RespFormatParseOutput { envelope })
}

pub(crate) fn parse_resp_format_envelope_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: RespFormatParseInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = parse_resp_format_envelope(input).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn materialize_provider_response_sse_payload_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: ProviderResponseSseMaterializeInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output =
        materialize_provider_response_sse_payload(input).map_err(napi::Error::from_reason)?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn build_provider_sse_stream_read_error_descriptor_json(
    input_json: String,
) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: ProviderResponseSseStreamReadErrorInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = build_provider_sse_stream_read_error_descriptor(input);

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

pub fn build_responses_json_from_sse_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse input JSON: {}", error))?;
    let body_text = input
        .get("bodyText")
        .and_then(Value::as_str)
        .ok_or_else(|| "buildResponsesJsonFromSseJson missing bodyText".to_string())?;
    let payload = materialize_openai_responses_sse_body_text(body_text)?;
    // Detect incomplete stream: missing response.done or response.completed terminal
    let payload_obj = payload.as_object().unwrap();
    let status = payload_obj
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("");
    let saw_terminal = body_text.contains("response.done")
        || body_text.contains("response.completed")
        || body_text.contains("response.cancelled")
        || body_text.contains("response.failed");
    if !saw_terminal && status != "requires_action" && !body_text.trim().is_empty() {
        return Err("OpenAI Responses SSE stream ended before terminal event".to_string());
    }
    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let envelope = FormatEnvelope {
        format: "openai-responses".to_string(),
        version: "v1".to_string(),
        payload,
        metadata: Some(serde_json::json!({
            "model": model,
            "extracted_at": "responses_sse_rust_decode"
        })),
    };
    serde_json::to_string(&envelope).map_err(|error| {
        format!(
            "Failed to serialize Responses SSE decode envelope: {}",
            error
        )
    })
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_openai_responses_response() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "resp_123",
                "model": "gpt-4",
                "output": [{"type": "message", "content": "hello"}]
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
        assert_eq!(result.envelope.version, "v1");
        assert_eq!(result.envelope.metadata.as_ref().unwrap()["model"], "gpt-4");
    }

    #[test]
    fn test_parse_openai_responses_sse_body_text_wrapper() {
        let body_text = concat!(
            "event: response.created\n",
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_sse_1\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\",\"output\":[]}}\n\n",
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"msg_sse_1\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"stopped\"}]}}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_sse_1\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.5\",\"output\":[{\"id\":\"msg_sse_1\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"stopped\"}]}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
            "event: response.done\n",
            "data: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_sse_1\",\"object\":\"response\",\"status\":\"completed\",\"output\":[{\"id\":\"msg_sse_1\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"stopped\"}]}]}}\n\n",
            "data: [DONE]\n\n"
        );
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "mode": "sse",
                "bodyText": body_text
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "gpt-5.5"
        );
        assert_eq!(result.envelope.payload["id"], "resp_sse_1");
        assert_eq!(result.envelope.payload["object"], "response");
        assert_eq!(result.envelope.payload["status"], "completed");
        assert_eq!(
            result.envelope.payload["output"][0]["content"][0]["text"],
            "stopped"
        );
    }

    #[test]
    fn provider_sse_materialize_payload_uses_top_level_raw_text() {
        let output =
            materialize_provider_response_sse_payload(ProviderResponseSseMaterializeInput {
                payload: serde_json::json!({
                    "mode": "sse",
                    "raw": " event: response.completed\n data: {}\n\n "
                }),
                stream_body_text: None,
            })
            .unwrap();
        assert_eq!(output["mode"], "sse");
        assert_eq!(
            output["bodyText"],
            " event: response.completed\n data: {}\n\n "
        );
    }

    #[test]
    fn provider_sse_materialize_payload_uses_stream_body_text() {
        let output =
            materialize_provider_response_sse_payload(ProviderResponseSseMaterializeInput {
                payload: serde_json::json!({
                    "clientStream": true,
                    "trace": "kept"
                }),
                stream_body_text: Some(" data: {\"ok\":true}\n\n ".to_string()),
            })
            .unwrap();
        assert_eq!(output["mode"], "sse");
        assert_eq!(output["bodyText"], " data: {\"ok\":true}\n\n ");
        assert_eq!(output["trace"], "kept");
    }

    #[test]
    fn provider_sse_materialize_payload_rejects_marker_without_body() {
        let error =
            materialize_provider_response_sse_payload(ProviderResponseSseMaterializeInput {
                payload: serde_json::json!({
                    "mode": "sse_passthrough",
                    "clientStream": true
                }),
                stream_body_text: None,
            })
            .unwrap_err();
        assert!(
            error.contains("Provider SSE marker did not include materializable stream or bodyText")
        );
    }

    #[test]
    fn provider_sse_stream_read_error_descriptor_marks_terminated() {
        let output = build_provider_sse_stream_read_error_descriptor(
            ProviderResponseSseStreamReadErrorInput {
                message: Some("Upstream terminated".to_string()),
                code: Some("terminated".to_string()),
                upstream_code: None,
            },
        );
        assert_eq!(output.code, "SSE_DECODE_ERROR");
        assert_eq!(output.upstream_code, "UPSTREAM_STREAM_TERMINATED");
        assert_eq!(output.status_code, 502);
        assert!(output.retryable);
        assert_eq!(
            output.request_executor_provider_error_stage,
            "provider.sse_decode"
        );
    }

    #[test]
    fn test_parse_openai_responses_sse_function_call_arguments_delta() {
        let body_text = concat!(
            "event: response.created\n",
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_sse_call_1\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\",\"output\":[]}}\n\n",
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_fc_1\",\"name\":\"exec_command\",\"arguments\":\"\",\"status\":\"in_progress\"}}\n\n",
            "event: response.function_call_arguments.delta\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"cmd\\\":\"}\n\n",
            "event: response.function_call_arguments.delta\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"\\\"pwd\\\"}\"}\n\n",
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_fc_1\",\"name\":\"exec_command\",\"arguments\":\"\",\"status\":\"completed\"}}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_sse_call_1\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.5\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
            "data: [DONE]\n\n"
        );
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "mode": "sse",
                "bodyText": body_text
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.payload["id"], "resp_sse_call_1");
        assert_eq!(result.envelope.payload["status"], "completed");
        assert_eq!(
            result.envelope.payload["output"][0]["type"],
            "function_call"
        );
        assert_eq!(result.envelope.payload["output"][0]["name"], "exec_command");
        assert_eq!(result.envelope.payload["output"][0]["status"], "completed");
        assert_eq!(
            result.envelope.payload["output"][0]["arguments"],
            "{\"cmd\":\"pwd\"}"
        );
    }

    #[test]
    fn test_parse_openai_responses_sse_strips_response_metadata() {
        let body_text = concat!(
            "event: response.created\n",
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_sse_metadata\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\",\"output\":[],\"metadata\":{\"secret\":\"must-not-leak\"}}}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_sse_metadata\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.5\",\"output\":[],\"metadata\":{\"secret\":\"must-not-leak\"}}}\n\n",
            "event: response.done\n",
            "data: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_sse_metadata\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.5\",\"output\":[],\"metadata\":{\"secret\":\"must-not-leak\"}}}\n\n",
            "data: [DONE]\n\n"
        );
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "mode": "sse",
                "bodyText": body_text
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert!(result.envelope.payload.get("metadata").is_none());
        assert!(!result
            .envelope
            .payload
            .to_string()
            .contains("must-not-leak"));
    }

    #[test]
    fn test_parse_openai_responses_sse_error_event_fails_fast() {
        let body_text = concat!(
            "event: response.created\n",
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_sse_error\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\",\"output\":[]}}\n\n",
            "event: response.error\n",
            "data: {\"type\":\"response.error\",\"error\":{\"message\":\"provider failed\",\"code\":\"upstream_error\"}}\n\n"
        );
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "mode": "sse",
                "bodyText": body_text
            }),
            protocol: "openai-responses".to_string(),
        };

        let err = parse_resp_format_envelope(input).unwrap_err();
        assert!(err.contains("OpenAI Responses SSE stream error: provider failed"));
    }

    #[test]
    fn test_parse_openai_chat_response() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "chatcmpl_123",
                "model": "gpt-4",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "hello"},
                    "finish_reason": "stop"
                }]
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-chat");
        assert_eq!(result.envelope.version, "v1");
        assert_eq!(result.envelope.metadata.as_ref().unwrap()["model"], "gpt-4");
    }

    #[test]
    fn test_openai_chat_missing_choices_fails_fast() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "raw_unobservable_shape"
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("OpenAI chat response must contain choices array"));
    }

    #[test]
    fn test_parse_openai_chat_provider_wrapper_body_data() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "body": {
                    "status": 200,
                    "data": {
                        "id": "chatcmpl_wrapped_1",
                        "object": "chat.completion",
                        "model": "deepseek-ai/deepseek-v4-pro",
                        "choices": [{
                            "index": 0,
                            "message": {"role": "assistant", "content": "wrapped hello"},
                            "finish_reason": "stop"
                        }]
                    }
                }
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-chat");
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "deepseek-ai/deepseek-v4-pro"
        );
        assert_eq!(
            result.envelope.payload["choices"][0]["message"]["content"],
            "wrapped hello"
        );
    }

    #[test]
    fn test_parse_openai_chat_root_data_wrapper() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "data": {
                    "id": "chatcmpl_root_data_1",
                    "object": "chat.completion",
                    "model": "@cf/zai-org/glm-5.2",
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": null,
                            "tool_calls": [{
                                "id": "call_root_data_1",
                                "type": "function",
                                "function": {
                                    "name": "exec_command",
                                    "arguments": "{\"cmd\":\"pwd\"}"
                                }
                            }]
                        },
                        "finish_reason": "tool_calls"
                    }]
                }
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-chat");
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "@cf/zai-org/glm-5.2"
        );
        assert_eq!(
            result.envelope.payload["choices"][0]["message"]["tool_calls"][0]["id"],
            "call_root_data_1"
        );
    }

    #[test]
    fn test_parse_openai_chat_sse_body_text_wrapper() {
        let body_text = concat!(
            "data: {\"id\":\"chatcmpl_sse_1\",\"object\":\"chat.completion.chunk\",\"model\":\"MiniMax-M2.7\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"id\":\"chatcmpl_sse_1\",\"object\":\"chat.completion.chunk\",\"model\":\"MiniMax-M2.7\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n",
            "data: {\"id\":\"chatcmpl_sse_1\",\"object\":\"chat.completion.chunk\",\"model\":\"MiniMax-M2.7\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "mode": "sse",
                "bodyText": body_text
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-chat");
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "MiniMax-M2.7"
        );
        assert_eq!(
            result.envelope.payload["choices"][0]["message"]["role"],
            "assistant"
        );
        assert_eq!(
            result.envelope.payload["choices"][0]["message"]["content"],
            "ok"
        );
        assert_eq!(
            result.envelope.payload["choices"][0]["message"]["reasoning_content"],
            "think"
        );
        assert_eq!(
            result.envelope.payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
    }

    #[test]
    fn test_parse_openai_chat_sse_minimax_usage_empty_choices_tail() {
        let body_text = concat!(
            "data: {\"id\":\"066c6f5b6c8765d17c5e3449736a8c00\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"<think>\\nThe user\",\"role\":\"assistant\",\"name\":\"MiniMax AI\",\"audio_content\":\"\"}}],\"created\":1780300891,\"model\":\"MiniMax-M2.7\",\"object\":\"chat.completion.chunk\",\"usage\":null}\n\n",
            "data: {\"id\":\"066c6f5b6c8765d17c5e3449736a8c00\",\"choices\":[{\"finish_reason\":\"length\",\"index\":0,\"delta\":{\"content\":\" says ping\\n</think>\\n\",\"role\":\"assistant\",\"name\":\"MiniMax AI\",\"audio_content\":\"\"}}],\"created\":1780300891,\"model\":\"MiniMax-M2.7\",\"object\":\"chat.completion.chunk\",\"usage\":null}\n\n",
            "data: {\"id\":\"066c6f5b6c8765d17c5e3449736a8c00\",\"choices\":[],\"created\":1780300891,\"model\":\"MiniMax-M2.7\",\"object\":\"chat.completion.chunk\",\"usage\":{\"total_tokens\":58,\"prompt_tokens\":42,\"completion_tokens\":16,\"completion_tokens_details\":{\"reasoning_tokens\":16}},\"base_resp\":{\"status_code\":0,\"status_msg\":\"\"}}\n\n"
        );
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "mode": "sse",
                "bodyText": body_text
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(
            result.envelope.payload["choices"][0]["finish_reason"],
            "length"
        );
        assert_eq!(result.envelope.payload["usage"]["total_tokens"], 58);
        assert_eq!(
            result.envelope.payload["choices"][0]["message"]["role"],
            "assistant"
        );
    }

    #[test]
    fn test_parse_anthropic_messages_response() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "msg_123",
                "model": "claude-3-opus",
                "content": [{"type": "text", "text": "hello"}],
                "stop_reason": "end_turn"
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-chat");
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "claude-3-opus"
        );
        assert_eq!(result.envelope.payload["object"], "chat.completion");
        assert_eq!(
            result.envelope.payload["choices"][0]["finish_reason"],
            "stop"
        );
        assert_eq!(
            result.envelope.payload["choices"][0]["message"]["content"],
            "hello"
        );
        assert!(result.envelope.payload.get("stop_reason").is_none());
        assert!(result.envelope.payload.get("content").is_none());
    }

    #[test]
    fn test_parse_anthropic_reasoning_stop_tool_use_to_openai_chat_tool_calls() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "msg_reasoning_stop",
                "model": "MiniMax-M3",
                "content": [{
                    "type": "tool_use",
                    "id": "call_reasoning_stop",
                    "name": "reasoningStop",
                    "input": {
                        "stopreason": 0,
                        "reason": "done",
                        "has_evidence": 1,
                        "evidence": "ok",
                        "issue_cause": "none",
                        "excluded_factors": "none",
                        "diagnostic_order": "1",
                        "done_steps": "done",
                        "next_step": "",
                        "next_suggested_path": "",
                        "needs_user_input": false,
                        "learned": "ok"
                    }
                }],
                "stop_reason": "tool_use"
            }),
            protocol: "anthropic-messages".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-chat");
        assert_eq!(result.envelope.payload["object"], "chat.completion");
        assert_eq!(
            result.envelope.payload["choices"][0]["finish_reason"],
            "tool_calls"
        );
        let tool_call = &result.envelope.payload["choices"][0]["message"]["tool_calls"][0];
        assert_eq!(tool_call["id"], "call_reasoning_stop");
        assert_eq!(tool_call["function"]["name"], "reasoningStop");
        assert!(tool_call["function"]["arguments"]
            .as_str()
            .unwrap_or_default()
            .contains("\"stopreason\":0"));
        assert!(result.envelope.payload.get("stop_reason").is_none());
        assert!(result.envelope.payload.get("content").is_none());
    }

    #[test]
    fn test_parse_gemini_chat_response() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "candidates": [{"content": {"parts": [{"text": "hello"}]}}],
                "modelVersion": "gemini-pro"
            }),
            protocol: "gemini-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "gemini-chat");
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "gemini-pro"
        );
    }

    #[test]
    fn test_parse_gemini_chat_response_fallback_model() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "candidates": [{"content": {"parts": [{"text": "hello"}]}}],
                "model": "gemini-flash"
            }),
            protocol: "gemini-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        // Should fall back to "model" field if "modelVersion" not present
        assert_eq!(
            result.envelope.metadata.as_ref().unwrap()["model"],
            "gemini-flash"
        );
    }

    #[test]
    fn test_unknown_protocol_fails_fast() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "custom_field": "value"
            }),
            protocol: "custom-protocol".to_string(),
        };

        let result = parse_resp_format_envelope(input);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Unsupported response protocol"));
    }

    #[test]
    fn test_error_empty_json_input() {
        let result = parse_resp_format_envelope_json("".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Input JSON is empty"));
    }

    #[test]
    fn test_error_invalid_json_input() {
        let result = parse_resp_format_envelope_json("not valid json".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Failed to parse input JSON"));
    }

    #[test]
    fn test_payload_size_limit() {
        let small_payload = serde_json::json!({"test": "data"});
        assert!(validate_payload_size(&small_payload).is_ok());
    }

    // Critical path test: Missing model field (should not fail, just empty string)
    #[test]
    fn test_missing_model_field() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "resp_123",
                "output": []
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
        // Model should be empty string when not present
        assert_eq!(result.envelope.metadata.as_ref().unwrap()["model"], "");
    }

    #[test]
    fn test_openai_chat_tool_calls_object_is_normalized_to_array() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "resp_tool_calls_object_1",
                "object": "chat.completion",
                "model": "gpt-test",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": {
                            "id": "call_reasoning_stop_1",
                            "type": "function",
                            "function": {
                                "name": "reasoningStop",
                                "arguments": "{\"stopreason\":2,\"reason\":\"continue\"}"
                            }
                        }
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            protocol: "openai-chat".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        let tool_calls = result.envelope.payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .expect("tool_calls array");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0]["id"], "call_reasoning_stop_1");
        assert_eq!(tool_calls[0]["function"]["name"], "reasoningStop");
    }

    // Critical path test: Model field is not string type
    #[test]
    fn test_model_field_not_string() {
        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "resp_123",
                "model": 123
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        // Should handle gracefully with empty string
        assert_eq!(result.envelope.metadata.as_ref().unwrap()["model"], "");
    }

    // Critical path test: Large response payload
    #[test]
    fn test_large_response_payload() {
        let mut content_parts = Vec::new();
        for i in 0..100 {
            content_parts.push(serde_json::json!({
                "type": "text",
                "text": format!("Content block {} with some text", i)
            }));
        }

        let input = RespFormatParseInput {
            payload: serde_json::json!({
                "id": "resp_large",
                "model": "gpt-4",
                "output": content_parts
            }),
            protocol: "openai-responses".to_string(),
        };

        let result = parse_resp_format_envelope(input).unwrap();
        assert_eq!(result.envelope.format, "openai-responses");
    }
    // ─── Echo tests for napi bridge functions ───

    #[test]
    fn materialize_provider_response_sse_payload_json_echo_sse_body_text() {
        let input = r#"{
            "payload": {"sseStream": true, "trace": "echo-test"},
            "streamBodyText": "data: {\"id\":\"resp_1\"}\n\ndata: [DONE]\n\n"
        }"#;
        let result = materialize_provider_response_sse_payload_json(input.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["mode"], "sse");
        assert!(parsed["bodyText"].as_str().unwrap().contains("resp_1"));
        assert_eq!(parsed["trace"], "echo-test");
    }

    #[test]
    fn materialize_provider_response_sse_payload_json_echo_no_sse_passthrough() {
        let input = r#"{
            "payload": {"id":"resp_1","object":"response","status":"completed"},
            "streamBodyText": null
        }"#;
        let result = materialize_provider_response_sse_payload_json(input.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        // Not an SSE marker → passthrough
        assert_eq!(parsed["id"], "resp_1");
        assert!(
            parsed.get("mode").is_none(),
            "non-SSE payload should have no mode"
        );
    }

    #[test]
    fn materialize_provider_response_sse_payload_json_echo_raw_text() {
        let input = r#"{
            "payload": {"mode":"sse","raw":"event: completed\ndata: {}\n\n"},
            "streamBodyText": null
        }"#;
        let result = materialize_provider_response_sse_payload_json(input.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["mode"], "sse");
        assert_eq!(parsed["bodyText"], "event: completed\ndata: {}\n\n");
    }

    #[test]
    fn materialize_provider_response_sse_payload_json_echo_empty_input() {
        let result = materialize_provider_response_sse_payload_json("".to_string());
        assert!(result.is_err(), "empty input should fail");
    }

    #[test]
    fn build_provider_sse_stream_read_error_descriptor_json_echo() {
        let input = r#"{
            "message": "Stream read failed",
            "code": "SSE_READ_TIMEOUT",
            "upstream_code": "UPSTREAM_TIMEOUT"
        }"#;
        let result =
            build_provider_sse_stream_read_error_descriptor_json(input.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["code"], "SSE_DECODE_ERROR");
        assert_eq!(parsed["upstreamCode"], "SSE_READ_TIMEOUT");
        assert_eq!(parsed["statusCode"], 502);
        assert!(parsed["retryable"].as_bool().unwrap());
    }

    #[test]
    fn build_provider_sse_stream_read_error_descriptor_json_echo_empty() {
        let result = build_provider_sse_stream_read_error_descriptor_json("".to_string());
        assert!(result.is_err(), "empty input should fail");
    }
}
