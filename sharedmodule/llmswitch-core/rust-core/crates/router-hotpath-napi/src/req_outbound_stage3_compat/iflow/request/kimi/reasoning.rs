use serde_json::{json, Map, Value};

fn parse_disabled_type(raw: Option<&Value>) -> bool {
    let Some(token) = raw.and_then(|v| v.as_str()) else {
        return false;
    };
    let normalized = token.trim().to_ascii_lowercase();
    normalized == "disabled" || normalized == "off"
}

fn is_thinking_explicitly_disabled(thinking: Option<&Value>) -> bool {
    let Some(token) = thinking else {
        return false;
    };
    if token == &Value::Bool(false) {
        return true;
    }
    let Some(row) = token.as_object() else {
        return false;
    };
    if row.get("enabled") == Some(&Value::Bool(false)) {
        return true;
    }
    parse_disabled_type(row.get("type"))
}

pub(super) fn normalize_thinking_for_kimi(root: &mut Map<String, Value>) -> bool {
    let thinking = root.get("thinking");
    if thinking.is_none() || thinking == Some(&Value::Null) {
        root.insert("thinking".to_string(), json!({ "type": "enabled" }));
        return true;
    }
    if thinking == Some(&Value::Bool(true)) {
        root.insert("thinking".to_string(), json!({ "type": "enabled" }));
        return true;
    }
    if is_thinking_explicitly_disabled(thinking) {
        return false;
    }
    if let Some(row) = root.get_mut("thinking").and_then(|v| v.as_object_mut()) {
        let missing_type = row
            .get("type")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().is_empty())
            .unwrap_or(true);
        if missing_type {
            row.insert("type".to_string(), Value::String("enabled".to_string()));
        }
    }
    true
}

pub(super) fn fill_reasoning_content_for_tool_calls(root: &mut Map<String, Value>) {
    let Some(messages) = root.get_mut("messages").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for message in messages.iter_mut() {
        let Some(row) = message.as_object_mut() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role != "assistant" {
            continue;
        }
        let has_tool_calls = row
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|entries| !entries.is_empty())
            .unwrap_or(false);
        if !has_tool_calls {
            continue;
        }
        let missing_reasoning = row
            .get("reasoning_content")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().is_empty())
            .unwrap_or(true);
        if missing_reasoning {
            row.insert(
                "reasoning_content".to_string(),
                Value::String(".".to_string()),
            );
        }
    }
}
