use crate::hub_bridge_actions::{build_bridge_history, BuildBridgeHistoryInput};
use crate::shared_json_utils::value_as_object_or_empty;
use crate::shared_response_compat::sanitize_chat_process_messages_value;
use serde_json::{Map, Value};

pub(crate) fn sync_responses_context_from_canonical_messages(
    request: &Value,
) -> Result<Value, String> {
    let mut next_request = value_as_object_or_empty(request);
    let messages = next_request
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let sanitized_messages = sanitize_chat_process_messages_value(&Value::Object({
        let mut envelope = Map::new();
        envelope.insert("messages".to_string(), Value::Array(messages));
        envelope
    }))
    .messages;
    let tools = next_request
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned();
    let semantics = match next_request.get_mut("semantics") {
        Some(v) if v.is_object() => v,
        _ => return Ok(Value::Object(next_request)),
    };
    let semantics_obj = match semantics.as_object_mut() {
        Some(v) => v,
        None => return Ok(Value::Object(next_request)),
    };
    let responses = match semantics_obj.get_mut("responses") {
        Some(v) if v.is_object() => v,
        _ => return Ok(Value::Object(next_request)),
    };
    let responses_obj = match responses.as_object_mut() {
        Some(v) => v,
        None => return Ok(Value::Object(next_request)),
    };
    let context = match responses_obj.get_mut("context") {
        Some(v) if v.is_object() => v,
        _ => return Ok(Value::Object(next_request)),
    };
    let context_obj = match context.as_object_mut() {
        Some(v) => v,
        None => return Ok(Value::Object(next_request)),
    };

    let bridge = build_bridge_history(BuildBridgeHistoryInput {
        messages: sanitized_messages,
        tools,
        allow_pending_terminal_tool_call: Some(true),
    })?;
    let bridge_input = serde_json::to_value(bridge.input).unwrap_or_else(|_| Value::Array(vec![]));
    let original_system_messages = serde_json::to_value(bridge.original_system_messages)
        .unwrap_or_else(|_| Value::Array(vec![]));

    context_obj.insert("input".to_string(), bridge_input);
    if let Some(tool_history) = bridge.tool_history {
        context_obj.insert(
            "toolHistory".to_string(),
            serde_json::to_value(tool_history).unwrap_or_else(|_| Value::Null),
        );
    }
    context_obj.insert(
        "originalSystemMessages".to_string(),
        original_system_messages,
    );
    Ok(Value::Object(next_request))
}
