use super::V3HubReqContinuation03Classified;
use crate::V3LocalContinuationError;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqChatProcess04Governed {
    pub(crate) previous: V3HubReqContinuation03Classified,
}

pub fn build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(
    input: V3HubReqContinuation03Classified,
) -> V3HubReqChatProcess04Governed {
    V3HubReqChatProcess04Governed { previous: input }
}

pub(crate) fn merge_v3_relay_restored_local_context_at_req04(
    current: &mut Value,
    restored: &Value,
) -> Result<(), V3LocalContinuationError> {
    let current_object =
        current
            .as_object_mut()
            .ok_or_else(|| V3LocalContinuationError::Codec {
                message: "Req04 provider semantic payload must be an object".to_string(),
            })?;
    if current_object
        .get("messages")
        .and_then(Value::as_array)
        .is_some()
    {
        let restored_messages = restored_context_messages_at_req04(restored)?;
        let current_messages = current_object
            .get_mut("messages")
            .and_then(Value::as_array_mut)
            .map(std::mem::take)
            .ok_or_else(|| V3LocalContinuationError::Codec {
                message: "Req04 provider semantic messages must be an array".to_string(),
            })?;
        let mut merged = restored_messages;
        merged.extend(current_messages);
        current_object.insert("messages".to_string(), Value::Array(merged));
        copy_restored_protocol_field_if_missing(current_object, restored, "tools");
        copy_restored_protocol_field_if_missing(current_object, restored, "tool_choice");
        copy_restored_protocol_field_if_missing(current_object, restored, "parallel_tool_calls");
        copy_restored_protocol_field_if_missing(current_object, restored, "instructions");
        return Ok(());
    }
    let restored_items = restored
        .get("input")
        .or_else(|| restored.get("output"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| V3LocalContinuationError::Codec {
            message: "restored local continuation input/output must be an array".to_string(),
        })?;
    let current_items = current_object
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .ok_or_else(|| V3LocalContinuationError::Codec {
            message: "Req04 provider semantic input must be an array".to_string(),
        })?;
    let mut merged = restored_items;
    let mut restored_keys = BTreeSet::new();
    for item in &merged {
        if let (Some(item_type), Some(call_id)) = (
            item.get("type").and_then(Value::as_str),
            item.get("call_id").and_then(Value::as_str),
        ) {
            restored_keys.insert((item_type.to_owned(), call_id.to_owned()));
        }
    }
    merged.extend(current_items.into_iter().filter(|item| {
        let current_call_id = item.get("call_id").and_then(Value::as_str);
        current_call_id.is_none_or(|call_id| {
            !restored_keys.iter().any(|(restored_type, restored_id)| {
                restored_id == call_id
                    && Some(restored_type.as_str()) == item.get("type").and_then(Value::as_str)
            })
        })
    }));
    current_object.insert("input".to_string(), Value::Array(merged));
    copy_restored_protocol_field_if_missing(current_object, restored, "tools");
    copy_restored_protocol_field_if_missing(current_object, restored, "tool_choice");
    copy_restored_protocol_field_if_missing(current_object, restored, "parallel_tool_calls");
    copy_restored_protocol_field_if_missing(current_object, restored, "instructions");
    Ok(())
}

pub(crate) fn restored_context_messages_at_req04(
    restored: &Value,
) -> Result<Vec<Value>, V3LocalContinuationError> {
    if let Some(messages) = restored.get("messages").and_then(Value::as_array) {
        return Ok(messages.clone());
    }
    let items = restored
        .get("input")
        .or_else(|| restored.get("output"))
        .and_then(Value::as_array)
        .ok_or_else(|| V3LocalContinuationError::Codec {
            message: "restored local continuation input/output/messages must be an array"
                .to_string(),
        })?;
    Ok(items
        .iter()
        .map(responses_like_item_to_chat_message_at_req04)
        .collect())
}

pub(crate) fn responses_like_item_to_chat_message_at_req04(item: &Value) -> Value {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    match item_type {
        "function_call" | "tool_call" | "custom_tool_call" => {
            let call_id = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = item
                .get("name")
                .or_else(|| item.pointer("/function/name"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = item
                .get("arguments")
                .or_else(|| item.pointer("/function/arguments"))
                .or_else(|| item.get("input"))
                .cloned()
                .unwrap_or_else(|| Value::String("{}".to_string()));
            let arguments = arguments.as_str().map(str::to_string).unwrap_or_else(|| {
                serde_json::to_string(&arguments).unwrap_or_else(|_| "{}".to_string())
            });
            json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": arguments}
                }]
            })
        }
        "function_call_output"
        | "tool_call_output"
        | "custom_tool_call_output"
        | "tool_result"
        | "tool_message" => {
            let call_id = item
                .get("tool_call_id")
                .or_else(|| item.get("call_id"))
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let content = item
                .get("output")
                .or_else(|| item.get("content"))
                .map(chat_content_text_at_req04)
                .unwrap_or_default();
            json!({"role": "tool", "tool_call_id": call_id, "content": content})
        }
        _ => {
            let role = item
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user")
                .to_string();
            let content = item
                .get("content")
                .map(chat_content_value_at_req04)
                .unwrap_or_else(|| Value::String(String::new()));
            json!({"role": role, "content": content})
        }
    }
}

fn chat_content_value_at_req04(value: &Value) -> Value {
    match value {
        Value::Array(items) => {
            let mut text = String::new();
            for item in items {
                let Some(segment) = item
                    .get("text")
                    .or_else(|| item.get("content"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                text.push_str(segment);
            }
            Value::String(text)
        }
        Value::String(text) => Value::String(text.clone()),
        other => Value::String(other.to_string()),
    }
}

fn chat_content_text_at_req04(value: &Value) -> String {
    match chat_content_value_at_req04(value) {
        Value::String(text) => text,
        other => other.to_string(),
    }
}

fn copy_restored_protocol_field_if_missing(
    current: &mut Map<String, Value>,
    restored: &Value,
    field: &'static str,
) {
    let current_missing = match current.get(field) {
        None | Some(Value::Null) => true,
        Some(Value::Array(items)) => items.is_empty(),
        Some(Value::String(text)) => text.trim().is_empty(),
        _ => false,
    };
    if !current_missing {
        return;
    }
    if let Some(value) = restored.get(field) {
        current.insert(field.to_string(), value.clone());
    }
}
