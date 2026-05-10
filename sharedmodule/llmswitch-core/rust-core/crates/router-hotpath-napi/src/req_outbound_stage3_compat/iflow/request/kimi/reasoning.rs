use serde_json::{json, Map, Value};

use crate::req_outbound_stage3_compat::thinking_history;

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
    thinking_history::fill_reasoning_content_for_tool_calls(root);
}
