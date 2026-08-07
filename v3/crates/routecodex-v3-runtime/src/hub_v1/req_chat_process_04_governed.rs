use super::V3HubReqContinuation03Classified;
use crate::V3LocalContinuationError;
use serde_json::{Map, Value};

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
) -> Result<usize, V3LocalContinuationError> {
    let current_object =
        current
            .as_object_mut()
            .ok_or_else(|| V3LocalContinuationError::Codec {
                message: "Req04 provider semantic payload must be an object".to_string(),
            })?;
    let restored_messages = restored
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| V3LocalContinuationError::Codec {
            message: "Req04 restored local continuation must contain Chat canonical messages"
                .to_string(),
        })?;
    let current_messages = current_object
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .ok_or_else(|| V3LocalContinuationError::Codec {
            message: "Req04 current request must contain Chat canonical messages".to_string(),
        })?;
    let restored_len = restored_messages.len();
    let mut merged = restored_messages;
    merged.extend(current_messages);
    current_object.insert("messages".to_string(), Value::Array(merged));
    copy_restored_protocol_field_if_missing(current_object, restored, "tools");
    copy_restored_protocol_field_if_missing(current_object, restored, "tool_choice");
    copy_restored_protocol_field_if_missing(current_object, restored, "parallel_tool_calls");
    copy_restored_protocol_field_if_missing(current_object, restored, "instructions");
    Ok(restored_len)
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
