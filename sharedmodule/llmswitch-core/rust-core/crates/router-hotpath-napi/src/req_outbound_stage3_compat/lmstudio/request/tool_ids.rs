fn normalize_tool_outputs_array(tool_outputs: &mut Value) {
    let Some(entries) = tool_outputs.as_array_mut() else {
        return;
    };
    for entry in entries {
        let Some(row) = entry.as_object_mut() else {
            continue;
        };
        let resolved = pick_trimmed_string_values(&[
            row.get("tool_call_id"),
            row.get("call_id"),
            row.get("id"),
        ]);
        if let Some(value) = resolved {
            row.insert("tool_call_id".to_string(), Value::String(value.clone()));
            row.insert("call_id".to_string(), Value::String(value));
        }
    }
}

fn normalize_chat_messages_tool_ids(messages: &mut Value) {
    let Some(rows) = messages.as_array_mut() else {
        return;
    };
    for message in rows {
        let Some(message_obj) = message.as_object_mut() else {
            continue;
        };
        normalize_message_tool_ids(message_obj);
    }
}

fn normalize_message_tool_ids(message_obj: &mut Map<String, Value>) {
    let resolved = pick_trimmed_string_values(&[
        message_obj.get("tool_call_id"),
        message_obj.get("call_id"),
    ]);
    if let Some(value) = resolved {
        message_obj.insert("tool_call_id".to_string(), Value::String(value.clone()));
        message_obj.insert("call_id".to_string(), Value::String(value));
    }
    let Some(tool_calls) = message_obj
        .get_mut("tool_calls")
        .and_then(|v| v.as_array_mut())
    else {
        return;
    };
    for tool_call in tool_calls {
        let Some(call_obj) = tool_call.as_object_mut() else {
            continue;
        };
        let id = pick_trimmed_string_values(&[call_obj.get("id")]);
        let call_id = pick_trimmed_string_values(&[call_obj.get("call_id")]);
        match (id, call_id) {
            (Some(id_value), None) => {
                call_obj.insert("call_id".to_string(), Value::String(id_value));
            }
            (None, Some(call_id_value)) => {
                call_obj.insert("id".to_string(), Value::String(call_id_value));
            }
            _ => {}
        }
    }
}

fn normalize_chat_choices_tool_ids(root: &mut Map<String, Value>) {
    let Some(choices) = root.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for choice in choices {
        let Some(choice_obj) = choice.as_object_mut() else {
            continue;
        };
        let Some(message_obj) = choice_obj.get_mut("message").and_then(|v| v.as_object_mut()) else {
            continue;
        };
        normalize_message_tool_ids(message_obj);
    }
}

pub(super) fn normalize_lmstudio_tool_call_ids(root: &mut Map<String, Value>) {
    if let Some(input) = root.get_mut("input") {
        if let Some(items) = input.as_array_mut() {
            for item in items {
                let Some(item_obj) = item.as_object_mut() else {
                    continue;
                };
                let item_type = item_obj
                    .get("type")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_ascii_lowercase())
                    .unwrap_or_default();
                if item_type == "function_call" {
                    let id = pick_trimmed_string_values(&[item_obj.get("id")]);
                    let call_id = pick_trimmed_string_values(&[item_obj.get("call_id")]);
                    match (id, call_id) {
                        (None, Some(call_id_value)) => {
                            item_obj.insert("id".to_string(), Value::String(call_id_value));
                        }
                        (Some(id_value), None) => {
                            item_obj.insert("call_id".to_string(), Value::String(id_value));
                        }
                        _ => {}
                    }
                } else if item_type == "function_call_output"
                    || item_type == "tool_result"
                    || item_type == "tool_message"
                {
                    let id = pick_trimmed_string_values(&[item_obj.get("id")]);
                    let call_id = pick_trimmed_string_values(&[item_obj.get("call_id")]);
                    let tool_call_id = pick_trimmed_string_values(&[item_obj.get("tool_call_id")]);
                    let resolved = call_id.clone().or(tool_call_id.clone()).or(id.clone());
                    if let Some(resolved_value) = resolved {
                        if item_obj.get("call_id").and_then(|v| v.as_str()).is_none() {
                            item_obj.insert(
                                "call_id".to_string(),
                                Value::String(resolved_value.clone()),
                            );
                        }
                        if item_obj
                            .get("tool_call_id")
                            .and_then(|v| v.as_str())
                            .is_none()
                        {
                            item_obj.insert(
                                "tool_call_id".to_string(),
                                Value::String(resolved_value.clone()),
                            );
                        }
                    }
                    if id.is_some() && call_id.is_none() && tool_call_id.is_none() {
                        let id_value = id.unwrap_or_default();
                        item_obj.insert("call_id".to_string(), Value::String(id_value.clone()));
                        item_obj.insert("tool_call_id".to_string(), Value::String(id_value));
                    }
                }
            }
        }
    }
    if let Some(tool_outputs) = root.get_mut("tool_outputs") {
        normalize_tool_outputs_array(tool_outputs);
    }
    if let Some(tool_outputs) = root.get_mut("toolOutputs") {
        normalize_tool_outputs_array(tool_outputs);
    }
    if let Some(output) = root.get_mut("output") {
        if let Some(items) = output.as_array_mut() {
            for item in items {
                let Some(item_obj) = item.as_object_mut() else {
                    continue;
                };
                let item_type = item_obj
                    .get("type")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_ascii_lowercase())
                    .unwrap_or_default();
                if item_type != "function_call" {
                    continue;
                }
                let id = pick_trimmed_string_values(&[item_obj.get("id"), item_obj.get("item_id")]);
                let call_id = pick_trimmed_string_values(&[item_obj.get("call_id")]);
                match (id, call_id) {
                    (None, Some(call_id_value)) => {
                        item_obj.insert("id".to_string(), Value::String(call_id_value));
                    }
                    (Some(id_value), None) => {
                        item_obj.insert("call_id".to_string(), Value::String(id_value));
                    }
                    _ => {}
                }
            }
        }
    }
    if let Some(messages) = root.get_mut("messages") {
        normalize_chat_messages_tool_ids(messages);
    }
    normalize_chat_choices_tool_ids(root);
}
