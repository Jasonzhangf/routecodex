use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

fn read_i64(raw: f64) -> i64 {
    if raw.is_finite() {
        return raw.floor() as i64;
    }
    0
}

fn now_unix_millis() -> i64 {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    i64::try_from(dur.as_millis()).unwrap_or(i64::MAX)
}

fn build_context_metadata(metadata: Value) -> Value {
    metadata
        .as_object()
        .and_then(|obj| obj.get("capturedContext"))
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(Value::Null)
}

fn build_processed_descriptor(timestamp_ms: f64, streaming_enabled: bool) -> Value {
    let mut processed = Map::new();
    processed.insert("timestamp".to_string(), Value::from(read_i64(timestamp_ms)));
    processed.insert(
        "appliedRules".to_string(),
        Value::Array(vec![Value::String("tool-governance".to_string())]),
    );
    processed.insert("status".to_string(), Value::String("success".to_string()));

    let mut streaming = Map::new();
    streaming.insert("enabled".to_string(), Value::Bool(streaming_enabled));
    streaming.insert("chunkCount".to_string(), Value::from(0));

    let mut processing_metadata = Map::new();
    processing_metadata.insert("streaming".to_string(), Value::Object(streaming));

    let mut out = Map::new();
    out.insert("processed".to_string(), Value::Object(processed));
    out.insert(
        "processingMetadata".to_string(),
        Value::Object(processing_metadata),
    );
    Value::Object(out)
}

fn build_node_result_metadata(
    start_time_ms: f64,
    end_time_ms: f64,
    messages_count: i64,
    tools_count: i64,
    include_data_processed: bool,
) -> Value {
    let start_time = read_i64(start_time_ms);
    let end_time = read_i64(end_time_ms);
    let execution_time = (end_time - start_time).max(0);

    let mut metadata = Map::new();
    metadata.insert(
        "node".to_string(),
        Value::String("hub-chat-process".to_string()),
    );
    metadata.insert("executionTime".to_string(), Value::from(execution_time));
    metadata.insert("startTime".to_string(), Value::from(start_time));
    metadata.insert("endTime".to_string(), Value::from(end_time));

    if include_data_processed {
        let mut data_processed = Map::new();
        data_processed.insert("messages".to_string(), Value::from(messages_count.max(0)));
        data_processed.insert("tools".to_string(), Value::from(tools_count.max(0)));
        metadata.insert("dataProcessed".to_string(), Value::Object(data_processed));
    }

    Value::Object(metadata)
}

fn apply_chat_processed_request(request: Value, timestamp_ms: f64) -> Value {
    let mut request_obj = request.as_object().cloned().unwrap_or_else(Map::new);

    let streaming_enabled = request_obj
        .get("parameters")
        .and_then(|v| v.as_object())
        .and_then(|params| params.get("stream"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let descriptor = build_processed_descriptor(timestamp_ms, streaming_enabled);
    let descriptor_obj = descriptor.as_object().cloned().unwrap_or_else(Map::new);

    if let Some(processed) = descriptor_obj.get("processed") {
        request_obj.insert("processed".to_string(), processed.clone());
    }

    let context =
        build_context_metadata(request_obj.get("metadata").cloned().unwrap_or(Value::Null));
    let mut processing_metadata = descriptor_obj
        .get("processingMetadata")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_else(Map::new);
    if context.is_object() {
        processing_metadata.insert("context".to_string(), context);
    }
    request_obj.insert(
        "processingMetadata".to_string(),
        Value::Object(processing_metadata),
    );

    Value::Object(request_obj)
}

fn extract_message_content(message: Option<&Map<String, Value>>) -> String {
    let Some(message) = message else {
        return String::new();
    };
    let Some(content) = message.get("content") else {
        return String::new();
    };
    if let Some(raw) = content.as_str() {
        return raw.to_string();
    }
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    let mut texts: Vec<String> = Vec::new();
    for part in parts {
        if let Some(raw) = part.as_str() {
            if !raw.is_empty() {
                texts.push(raw.to_string());
            }
            continue;
        }
        let Some(row) = part.as_object() else {
            continue;
        };
        if let Some(text) = row.get("text").and_then(Value::as_str) {
            if !text.is_empty() {
                texts.push(text.to_string());
            }
            continue;
        }
        if let Some(text) = row.get("content").and_then(Value::as_str) {
            if !text.is_empty() {
                texts.push(text.to_string());
            }
        }
    }
    texts.join("\n")
}

fn map_tool_calls(message: Option<&Map<String, Value>>) -> Option<Value> {
    let tool_calls = message
        .and_then(|row| row.get("tool_calls"))
        .and_then(Value::as_array)?;
    let mut mapped: Vec<Value> = Vec::new();
    for (index, entry) in tool_calls.iter().enumerate() {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let function_row = row
            .get("function")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let Some(name_raw) = function_row.get("name").and_then(Value::as_str) else {
            continue;
        };
        let name = name_raw.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let arguments_value = function_row
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        let arguments = if let Some(raw) = arguments_value.as_str() {
            raw.to_string()
        } else {
            serde_json::to_string(&arguments_value).unwrap_or_else(|_| "{}".to_string())
        };
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| format!("call_{}", index + 1));

        let mut out_function = Map::new();
        out_function.insert("name".to_string(), Value::String(name));
        out_function.insert("arguments".to_string(), Value::String(arguments));

        let mut out_row = Map::new();
        out_row.insert("id".to_string(), Value::String(id));
        out_row.insert("type".to_string(), Value::String("function".to_string()));
        out_row.insert("function".to_string(), Value::Object(out_function));
        mapped.push(Value::Object(out_row));
    }
    if mapped.is_empty() {
        return None;
    }
    Some(Value::Array(mapped))
}

fn build_processed_request_from_chat_response(chat_response: Value, stream_enabled: bool) -> Value {
    let response_row = chat_response.as_object().cloned().unwrap_or_default();
    let choices = response_row
        .get("choices")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let first_choice = choices
        .first()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let message = first_choice.get("message").and_then(Value::as_object);
    let content = extract_message_content(message);
    let tool_calls = map_tool_calls(message);

    let mut assistant_message = Map::new();
    assistant_message.insert("role".to_string(), Value::String("assistant".to_string()));
    assistant_message.insert("content".to_string(), Value::String(content));
    if let Some(tool_calls) = tool_calls {
        assistant_message.insert("tool_calls".to_string(), tool_calls);
    }

    let model = response_row
        .get("model")
        .and_then(Value::as_str)
        .map(|v| v.to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let completion_tokens = response_row
        .get("usage")
        .and_then(Value::as_object)
        .and_then(|usage| usage.get("completion_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let mut metadata = Map::new();
    metadata.insert(
        "originalEndpoint".to_string(),
        Value::String("openai-chat".to_string()),
    );
    if stream_enabled {
        metadata.insert("stream".to_string(), Value::Bool(true));
    }

    let mut processed = Map::new();
    processed.insert("timestamp".to_string(), Value::from(now_unix_millis()));
    processed.insert(
        "appliedRules".to_string(),
        Value::Array(vec![Value::String("response-pipeline".to_string())]),
    );
    processed.insert("status".to_string(), Value::String("success".to_string()));

    let mut streaming = Map::new();
    streaming.insert("enabled".to_string(), Value::Bool(stream_enabled));
    streaming.insert("chunkCount".to_string(), Value::from(0));
    streaming.insert(
        "totalTokens".to_string(),
        Value::from(completion_tokens.max(0)),
    );

    let mut processing_metadata = Map::new();
    processing_metadata.insert("streaming".to_string(), Value::Object(streaming));
    processing_metadata.insert("context".to_string(), Value::Object(Map::new()));

    let mut out = Map::new();
    out.insert("model".to_string(), Value::String(model));
    out.insert(
        "messages".to_string(),
        Value::Array(vec![Value::Object(assistant_message)]),
    );
    out.insert("parameters".to_string(), Value::Object(Map::new()));
    out.insert("metadata".to_string(), Value::Object(metadata));
    out.insert("processed".to_string(), Value::Object(processed));
    out.insert(
        "processingMetadata".to_string(),
        Value::Object(processing_metadata),
    );
    Value::Object(out)
}

#[napi]
pub fn build_chat_process_context_metadata_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_context_metadata(metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_chat_processed_descriptor_json(
    timestamp_ms: f64,
    streaming_enabled: bool,
) -> NapiResult<String> {
    let output = build_processed_descriptor(timestamp_ms, streaming_enabled);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_chat_node_result_metadata_json(
    start_time_ms: f64,
    end_time_ms: f64,
    messages_count: i64,
    tools_count: i64,
    include_data_processed: bool,
) -> NapiResult<String> {
    let output = build_node_result_metadata(
        start_time_ms,
        end_time_ms,
        messages_count,
        tools_count,
        include_data_processed,
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn apply_chat_processed_request_json(
    request_json: String,
    timestamp_ms: f64,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = apply_chat_processed_request(request, timestamp_ms);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_processed_request_from_chat_response_json(
    chat_response_json: String,
    stream_enabled: bool,
) -> NapiResult<String> {
    let chat_response: Value = serde_json::from_str(&chat_response_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_processed_request_from_chat_response(chat_response, stream_enabled);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
