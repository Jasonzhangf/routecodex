use regex::Regex;
use serde_json::{json, Map, Value};

use super::super::super::read_trimmed_string;
use super::tool_guidance::wrap_tool_calls_json;

fn stringify_unknown(value: &Value) -> String {
    if let Some(raw) = value.as_str() {
        return raw.to_string();
    }
    if value.is_null() {
        return String::new();
    }
    serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
}

fn read_trimmed_string_from_map(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn canonicalize_tool_input_for_prompt(name: &str, input: Value) -> Value {
    let normalized_name = name.trim().to_ascii_lowercase();
    if normalized_name != "exec_command" {
        return input;
    }
    let Some(obj) = input.as_object() else {
        return input;
    };

    let mut next = Map::new();
    if let Some(cmd) = read_trimmed_string_from_map(obj, "cmd")
        .or_else(|| read_trimmed_string_from_map(obj, "command"))
    {
        next.insert("cmd".to_string(), Value::String(cmd));
    }
    if let Some(justification) = read_trimmed_string_from_map(obj, "justification") {
        next.insert("justification".to_string(), Value::String(justification));
    }
    if next.is_empty() {
        Value::Object(obj.clone())
    } else {
        Value::Object(next)
    }
}

pub(super) fn strip_text_tool_wrapper_noise(raw: &str) -> String {
    let mut text = raw.to_string();
    let patterns = [
        r"(?is)<\|ChunkingError\|>[\s\S]*?(?:<｜end▁of▁thinking｜>|<\|end▁of▁thinking\|>|$)",
        r"(?is)<｜end▁of▁thinking｜>",
        r"(?i)<｜Assistant｜>",
        r"(?i)<｜User｜>",
        r"(?i)<｜end▁of▁sentence｜>",
        r"(?i)</turn_aborted>",
        r"(?i)<turn_aborted>",
        r"(?im)^\s*Tool\s+[A-Za-z0-9_.-]+\s+does\s+not\s+exists\.\s*$",
        r"(?im)^\s*I cannot access your local files\.?\s*$",
        r"(?im)^\s*当前环境是沙箱隔离.*$",
        r"(?im)^\s*\[Tool-call reminder\].*$",
    ];
    for pattern in patterns {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        text = re.replace_all(text.as_str(), "").to_string();
    }
    text.trim().to_string()
}

pub(super) fn normalize_content_to_text(content: &Value) -> String {
    if let Some(raw) = content.as_str() {
        return strip_text_tool_wrapper_noise(raw);
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
    strip_text_tool_wrapper_noise(out.join("\n").as_str())
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
            "input": canonicalize_tool_input_for_prompt(name.as_str(), input)
        }));
    }
    if tool_calls.is_empty() {
        return String::new();
    }
    let serialized =
        serde_json::to_string(&json!({ "tool_calls": tool_calls })).unwrap_or_default();
    wrap_tool_calls_json(serialized.as_str())
}
