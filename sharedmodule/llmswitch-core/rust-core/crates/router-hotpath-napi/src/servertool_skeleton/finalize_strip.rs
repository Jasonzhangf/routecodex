//! finalize_strip.rs — Patch 6: migrate filterOutExecutedServerToolCalls to Rust

use serde_json::{Map, Value};

fn read_string(record: &Map<String, Value>, key: &str) -> String {
    record
        .get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

fn collect_executed_servertool_call_ids(payload: &Value) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    let Some(obj) = payload.as_object() else {
        return ids;
    };
    let Some(tool_outputs) = obj.get("tool_outputs").and_then(|v| v.as_array()) else {
        return ids;
    };
    for entry in tool_outputs {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let name = read_string(row, "name");
        let tool_call_id = read_string(row, "tool_call_id");
        if !name.is_empty() && !tool_call_id.is_empty() {
            ids.insert(tool_call_id);
        }
    }
    ids
}

fn strip_tool_calls_in_message(
    message: &mut Map<String, Value>,
    executed_ids: &std::collections::HashSet<String>,
) {
    let Some(tool_calls) = message.get_mut("tool_calls").and_then(|v| v.as_array_mut()) else {
        return;
    };
    tool_calls.retain(|entry| {
        let Some(row) = entry.as_object() else {
            return true;
        };
        let id = read_string(row, "id");
        id.is_empty() || !executed_ids.contains(id.as_str())
    });
}

fn strip_from_choices(payload: &mut Value, executed_ids: &std::collections::HashSet<String>) {
    let Some(obj) = payload.as_object_mut() else {
        return;
    };
    let Some(choices) = obj.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for choice in choices.iter_mut() {
        let Some(choice_obj) = choice.as_object_mut() else {
            continue;
        };
        let Some(message) = choice_obj.get_mut("message").and_then(|v| v.as_object_mut()) else {
            continue;
        };
        strip_tool_calls_in_message(message, executed_ids);
        let has_tool_calls = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);
        if !has_tool_calls
            && choice_obj
                .get("finish_reason")
                .and_then(|v| v.as_str())
                .map(|v| v == "tool_calls")
                .unwrap_or(false)
        {
            choice_obj.insert("finish_reason".to_string(), Value::String("stop".to_string()));
        }
    }
}

fn strip_from_messages(payload: &mut Value, executed_ids: &std::collections::HashSet<String>) {
    let Some(obj) = payload.as_object_mut() else {
        return;
    };
    let Some(messages) = obj.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for msg in messages.iter_mut() {
        let Some(msg_obj) = msg.as_object_mut() else {
            continue;
        };
        let role = msg_obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(|v| v.trim())
            .unwrap_or("");
        if role == "assistant" {
            strip_tool_calls_in_message(msg_obj, executed_ids);
        }
    }
}

pub fn filter_out_executed_servertool_calls(
    finalized_payload: &Value,
    orchestration_payload: &Value,
) -> Value {
    let executed_ids = collect_executed_servertool_call_ids(orchestration_payload);
    if executed_ids.is_empty() {
        return finalized_payload.clone();
    }
    let mut cloned = finalized_payload.clone();
    strip_from_choices(&mut cloned, &executed_ids);
    strip_from_messages(&mut cloned, &executed_ids);
    cloned
}
