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
    record.retain(|key, _| !key.starts_with("__rcc_"));
}

fn sanitize_tool_call_entry_owned(call: Value) -> Value {
    let Value::Object(mut call_obj) = call else {
        return call;
    };
    call_obj.remove("call_id");
    call_obj.remove("tool_call_id");
    Value::Object(call_obj)
}

fn sanitize_message_entry_owned(message: Value) -> Value {
    let Value::Object(mut msg_obj) = message else {
        return message;
    };
    if let Some(tool_calls) = msg_obj.remove("tool_calls") {
        let next_calls = match tool_calls {
            Value::Array(calls) => Value::Array(
                calls
                    .into_iter()
                    .map(sanitize_tool_call_entry_owned)
                    .collect(),
            ),
            other => other,
        };
        msg_obj.insert("tool_calls".to_string(), next_calls);
    }

    let role_is_tool = msg_obj.get("role").and_then(Value::as_str) == Some("tool");
    if role_is_tool {
        let tool_call_id = msg_obj
            .get("tool_call_id")
            .and_then(Value::as_str)
            .map(|v| v.to_string());
        let call_id = msg_obj
            .get("call_id")
            .and_then(Value::as_str)
            .map(|v| v.to_string());
        if tool_call_id.is_none() {
            if let Some(value) = call_id {
                msg_obj.insert("tool_call_id".to_string(), Value::String(value));
            }
        }
        msg_obj.remove("id");
    }
    msg_obj.remove("call_id");
    Value::Object(msg_obj)
}

// feature_id: conversion.openai_request_filter_payload_copy_budget
pub(crate) fn prune_chat_request_payload_owned(
    payload: Value,
    preserve_stream_field: bool,
) -> Value {
    let Value::Object(mut stripped) = payload else {
        return payload;
    };
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

    if let Some(messages) = stripped.remove("messages") {
        let next_messages = match messages {
            Value::Array(messages) => Value::Array(
                messages
                    .into_iter()
                    .map(sanitize_message_entry_owned)
                    .collect(),
            ),
            other => other,
        };
        stripped.insert("messages".to_string(), next_messages);
    }

    Value::Object(stripped)
}

#[napi_derive::napi]
pub fn prune_chat_request_payload_json(input_json: String) -> NapiResult<String> {
    let input: PruneChatRequestPayloadInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let preserve_stream = input.preserve_stream_field.unwrap_or(false);
    let output = prune_chat_request_payload_owned(input.payload, preserve_stream);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests;
