use crate::hub_bridge_actions::{build_bridge_history, BuildBridgeHistoryInput};
use crate::shared_json_utils::value_as_object_or_empty;
use crate::shared_response_compat::sanitize_chat_process_messages_value;
use serde_json::{Map, Value};

fn read_semantic_previous_response_id(request: &Map<String, Value>) -> Option<String> {
    let semantics = request.get("semantics")?.as_object()?;
    let continuation = semantics.get("continuation").and_then(Value::as_object);
    let resume_from = continuation
        .and_then(|row| row.get("resumeFrom"))
        .and_then(Value::as_object);
    let responses_resume = semantics
        .get("responses")
        .and_then(Value::as_object)
        .and_then(|row| row.get("resume"))
        .and_then(Value::as_object);

    let candidates = [
        resume_from.and_then(|row| row.get("previousResponseId")),
        responses_resume.and_then(|row| row.get("restoredFromResponseId")),
        resume_from.and_then(|row| row.get("responseId")),
    ];
    for candidate in candidates {
        if let Some(raw) = candidate.and_then(Value::as_str) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn is_output_only_tool_resume_batch(messages: &[Value]) -> bool {
    let mut has_tool_message = false;
    for message in messages {
        let Some(row) = message.as_object() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role == "system" {
            continue;
        }
        if role == "tool" {
            has_tool_message = true;
            continue;
        }
        if role == "assistant" {
            if row
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(|calls| !calls.is_empty())
                .unwrap_or(false)
            {
                return false;
            }
        }
        if role == "user" {
            return false;
        }
    }
    has_tool_message
}

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
    let allow_orphan_tool_result_by_shape =
        is_output_only_tool_resume_batch(sanitized_messages.as_slice());
    let previous_response_id = next_request
        .get("previous_response_id")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| read_semantic_previous_response_id(&next_request));
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
        allow_orphan_tool_result: Some(
            previous_response_id.is_some() || allow_orphan_tool_result_by_shape,
        ),
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
