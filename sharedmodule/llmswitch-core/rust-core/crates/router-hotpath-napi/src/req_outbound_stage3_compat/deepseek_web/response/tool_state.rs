use serde_json::Value;

use super::super::{read_trimmed_string, AdapterContext};

fn read_optional_boolean(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(v)) => Some(*v),
        Some(Value::String(raw)) => {
            let normalized = raw.trim().to_ascii_lowercase();
            if ["true", "1", "yes", "on"].contains(&normalized.as_str()) {
                return Some(true);
            }
            if ["false", "0", "no", "off"].contains(&normalized.as_str()) {
                return Some(false);
            }
            None
        }
        _ => None,
    }
}

fn read_boolean(value: Option<&Value>, fallback: bool) -> bool {
    read_optional_boolean(value).unwrap_or(fallback)
}

pub(super) fn count_tool_calls_from_choices(payload: &Value) -> i64 {
    let Some(choices) = payload
        .as_object()
        .and_then(|v| v.get("choices"))
        .and_then(|v| v.as_array())
    else {
        return 0;
    };
    let mut count = 0i64;
    for choice in choices {
        let Some(message) = choice
            .as_object()
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_object())
        else {
            continue;
        };
        let item_count = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|v| v.len() as i64)
            .unwrap_or(0);
        count += item_count;
    }
    count
}

pub(super) fn resolve_tool_choice_required(adapter_context: &AdapterContext) -> bool {
    let Some(captured) = adapter_context
        .captured_chat_request
        .as_ref()
        .and_then(|v| v.as_object())
    else {
        return false;
    };
    let Some(tool_choice) = captured.get("tool_choice") else {
        return false;
    };

    if let Some(raw) = tool_choice.as_str() {
        let normalized = raw.trim().to_ascii_lowercase();
        if normalized == "required" {
            return true;
        }
        if normalized == "none" || normalized == "auto" {
            return false;
        }
    }

    if let Some(row) = tool_choice.as_object() {
        let kind = read_trimmed_string(row.get("type"))
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        if kind == "function" {
            return true;
        }
    }
    false
}

pub(super) fn resolve_deepseek_options(adapter_context: &AdapterContext) -> (bool, bool) {
    let Some(deepseek) = adapter_context
        .deepseek
        .as_ref()
        .and_then(|v| v.as_object())
    else {
        return (true, true);
    };
    (
        read_boolean(deepseek.get("strictToolRequired"), true),
        read_boolean(deepseek.get("textToolFallback"), true),
    )
}
