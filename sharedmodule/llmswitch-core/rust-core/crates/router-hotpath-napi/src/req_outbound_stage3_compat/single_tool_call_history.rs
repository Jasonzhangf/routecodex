use serde_json::Value;

// feature_id: openai_chat.single_tool_call_history_compat
pub(super) fn split_parallel_tool_call_assistant_history(
    root: &mut serde_json::Map<String, Value>,
) -> bool {
    let Some(messages) = root.get("messages").and_then(Value::as_array) else {
        return false;
    };

    let mut changed = false;
    let mut next_messages = Vec::with_capacity(messages.len());

    for message in messages {
        let Some(message_obj) = message.as_object() else {
            next_messages.push(message.clone());
            continue;
        };
        if message_obj.get("role").and_then(Value::as_str) != Some("assistant") {
            next_messages.push(message.clone());
            continue;
        }
        let Some(tool_calls) = message_obj.get("tool_calls").and_then(Value::as_array) else {
            next_messages.push(message.clone());
            continue;
        };
        if tool_calls.len() <= 1 {
            next_messages.push(message.clone());
            continue;
        }

        changed = true;
        for (index, tool_call) in tool_calls.iter().enumerate() {
            let mut split_message = message_obj.clone();
            split_message.insert(
                "tool_calls".to_string(),
                Value::Array(vec![tool_call.clone()]),
            );
            if index > 0 && message_obj.contains_key("content") {
                split_message.insert("content".to_string(), Value::Null);
            }
            next_messages.push(Value::Object(split_message));
        }
    }

    if changed {
        root.insert("messages".to_string(), Value::Array(next_messages));
    }
    changed
}
