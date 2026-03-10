use serde_json::{json, Value};

use super::super::super::read_trimmed_string;

fn stringify_unknown(value: &Value) -> String {
    if let Some(raw) = value.as_str() {
        return raw.to_string();
    }
    if value.is_null() {
        return String::new();
    }
    serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
}

pub(super) fn normalize_content_to_text(content: &Value) -> String {
    if let Some(raw) = content.as_str() {
        return raw.trim().to_string();
    }
    if content.is_null() {
        return String::new();
    }
    let Some(parts) = content.as_array() else {
        return stringify_unknown(content);
    };
    let mut out: Vec<String> = Vec::new();
    for item in parts {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let normalized_type = read_trimmed_string(obj.get("type"))
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        if (normalized_type == "text"
            || normalized_type == "input_text"
            || normalized_type == "output_text")
            && read_trimmed_string(obj.get("text")).is_some()
        {
            out.push(read_trimmed_string(obj.get("text")).unwrap_or_default());
            continue;
        }
        if read_trimmed_string(obj.get("content")).is_some() {
            out.push(read_trimmed_string(obj.get("content")).unwrap_or_default());
            continue;
        }
        if normalized_type == "tool_result" && obj.get("content").is_some() {
            out.push(stringify_unknown(
                obj.get("content").unwrap_or(&Value::Null),
            ));
        }
    }
    out.join("\n").trim().to_string()
}

pub(super) fn normalize_tool_calls_as_text(tool_calls_raw: Option<&Value>) -> String {
    let Some(rows) = tool_calls_raw.and_then(|v| v.as_array()) else {
        return String::new();
    };
    if rows.is_empty() {
        return String::new();
    }
    let mut tool_calls: Vec<Value> = Vec::new();
    for item in rows {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let fn_obj = obj.get("function").and_then(|v| v.as_object());
        let name = read_trimmed_string(fn_obj.and_then(|f| f.get("name")));
        let Some(name) = name else {
            continue;
        };
        let args_raw = fn_obj.and_then(|f| f.get("arguments"));
        let input = if let Some(raw_args) = args_raw {
            if let Some(raw_text) = raw_args.as_str() {
                let trimmed = raw_text.trim();
                if trimmed.is_empty() {
                    json!({})
                } else {
                    serde_json::from_str::<Value>(trimmed)
                        .unwrap_or_else(|_| json!({ "_raw": trimmed }))
                }
            } else {
                raw_args.clone()
            }
        } else {
            json!({})
        };
        tool_calls.push(json!({
            "name": name,
            "input": input
        }));
    }
    if tool_calls.is_empty() {
        return String::new();
    }
    serde_json::to_string(&json!({ "tool_calls": tool_calls })).unwrap_or_default()
}
