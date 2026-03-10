use napi::bindgen_prelude::Result as NapiResult;
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PruneChatRequestPayloadInput {
    payload: Value,
    preserve_stream_field: Option<bool>,
}

fn strip_sentinel_keys(record: &mut Map<String, Value>) {
    let keys: Vec<String> = record
        .keys()
        .filter(|key| key.starts_with("__rcc_"))
        .cloned()
        .collect();
    for key in keys {
        record.remove(&key);
    }
}

fn sanitize_tool_call_entry(call: &Value) -> Value {
    let Some(call_obj) = call.as_object() else {
        return call.clone();
    };
    let mut clone = call_obj.clone();
    clone.remove("call_id");
    clone.remove("tool_call_id");
    if let Some(Value::Object(fn_obj)) = clone.get("function") {
        clone.insert("function".to_string(), Value::Object(fn_obj.clone()));
    }
    Value::Object(clone)
}

fn sanitize_message_entry(message: &Value) -> Value {
    let Some(msg_obj) = message.as_object() else {
        return message.clone();
    };
    let mut clone = msg_obj.clone();
    if let Some(Value::Array(tool_calls)) = clone.get("tool_calls") {
        let next_calls: Vec<Value> = tool_calls.iter().map(sanitize_tool_call_entry).collect();
        clone.insert("tool_calls".to_string(), Value::Array(next_calls));
    }
    let role = clone.get("role").and_then(Value::as_str).unwrap_or("");
    if role == "tool" {
        let tool_call_id = clone
            .get("tool_call_id")
            .and_then(Value::as_str)
            .map(|v| v.to_string());
        let call_id = clone
            .get("call_id")
            .and_then(Value::as_str)
            .map(|v| v.to_string());
        if tool_call_id.is_none() {
            if let Some(value) = call_id {
                clone.insert("tool_call_id".to_string(), Value::String(value));
            }
        }
        clone.remove("id");
    }
    clone.remove("call_id");
    Value::Object(clone)
}

fn prune_chat_request_payload_impl(payload: &Value, preserve_stream_field: bool) -> Value {
    let Some(obj) = payload.as_object() else {
        return payload.clone();
    };
    let mut stripped = obj.clone();
    strip_sentinel_keys(&mut stripped);

    stripped.remove("originalStream");
    stripped.remove("_originalStreamOptions");
    stripped.remove("metadata");

    if !preserve_stream_field {
        if let Some(Value::Bool(stream)) = stripped.get("stream") {
            if !*stream {
                stripped.remove("stream");
            }
        }
    }

    if let Some(Value::Array(messages)) = stripped.get("messages") {
        let next_messages: Vec<Value> = messages.iter().map(sanitize_message_entry).collect();
        stripped.insert("messages".to_string(), Value::Array(next_messages));
    }

    Value::Object(stripped)
}

#[napi_derive::napi]
pub fn prune_chat_request_payload_json(input_json: String) -> NapiResult<String> {
    let input: PruneChatRequestPayloadInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let preserve_stream = input.preserve_stream_field.unwrap_or(false);
    let output = prune_chat_request_payload_impl(&input.payload, preserve_stream);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests;
