use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{json, Map, Value};

const DEFAULT_MARKER: &str = "Tool-call output contract (STRICT)";

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn read_config_bool(config: Option<&Map<String, Value>>, key: &str, default: bool) -> bool {
    config
        .and_then(|row| row.get(key))
        .and_then(|value| match value {
            Value::Bool(flag) => Some(*flag),
            _ => None,
        })
        .unwrap_or(default)
}

fn collect_tool_names(tools_raw: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(items) = tools_raw.and_then(|v| v.as_array()) else {
        return out;
    };

    for item in items {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        let function_obj = item_obj
            .get("function")
            .and_then(|v| v.as_object())
            .unwrap_or(item_obj);
        let Some(name) = read_trimmed_string(function_obj.get("name")) else {
            continue;
        };
        if !out.iter().any(|entry| entry == &name) {
            out.push(name);
        }
    }

    out
}

fn is_tool_choice_required(root: &Map<String, Value>) -> bool {
    let Some(tool_choice) = root.get("tool_choice") else {
        return false;
    };

    if let Some(raw) = tool_choice.as_str() {
        let normalized = raw.trim().to_ascii_lowercase();
        if normalized == "required" {
            return true;
        }
        if normalized == "auto" || normalized == "none" {
            return false;
        }
    }

    tool_choice
        .as_object()
        .and_then(|row| read_trimmed_string(row.get("type")))
        .map(|value| value.eq_ignore_ascii_case("function"))
        .unwrap_or(false)
}

fn build_default_instruction(
    root: &Map<String, Value>,
    config: Option<&Map<String, Value>>,
) -> String {
    let tool_names = collect_tool_names(root.get("tools"));
    let include_tool_names = read_config_bool(config, "includeToolNames", true);
    let required = is_tool_choice_required(root);
    let marker = read_trimmed_string(config.and_then(|row| row.get("marker")))
        .unwrap_or_else(|| DEFAULT_MARKER.to_string());

    let mut lines = vec![
        format!("{}:", marker),
        "1) If calling tools, output exactly one JSON object: {\"tool_calls\":[{\"name\":\"tool_name\",\"input\":{...}}]}".to_string(),
        "2) Use only keys: `tool_calls` + each call `name` and `input`.".to_string(),
        "3) Do not output markdown fences, prose, or tool transcripts around JSON.".to_string(),
        "4) Do NOT output pseudo tool results in text (forbidden examples: {\"exec_command\":...}, <function_results>...</function_results>).".to_string(),
        "5) Do NOT use bracket pseudo-calls like `[调用 list_files] {...}` / `[call list_files] {...}` / `调用工具: list_files({...})`.".to_string(),
    ];

    if include_tool_names && !tool_names.is_empty() {
        lines.push(format!(
            "6) Allowed tool names this turn: {}",
            tool_names.join(", ")
        ));
    } else {
        lines.push("6) Tool name must match provided schema exactly.".to_string());
    }

    lines.push(if required {
        "7) tool_choice is required for this turn: return at least one tool call.".to_string()
    } else {
        "7) If no tool is needed, plain text is allowed.".to_string()
    });

    lines.join("\n")
}

fn content_to_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|part| {
                if let Some(text) = part.as_str() {
                    return Some(text.to_string());
                }
                let obj = part.as_object()?;
                read_trimmed_string(obj.get("text"))
                    .or_else(|| read_trimmed_string(obj.get("content")))
            })
            .collect::<Vec<String>>()
            .join("\n")
            .trim()
            .to_string(),
        Value::Object(row) => read_trimmed_string(row.get("text"))
            .or_else(|| read_trimmed_string(row.get("content")))
            .or_else(|| row.get("content").map(content_to_text))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn content_has_marker(content: Option<&Value>, marker: &str) -> bool {
    if marker.is_empty() {
        return false;
    }
    content
        .map(content_to_text)
        .map(|text| text.contains(marker))
        .unwrap_or(false)
}

fn append_instruction_to_content(content: Option<&Value>, instruction: &str) -> Value {
    match content {
        Some(Value::String(existing)) => {
            if existing.trim().is_empty() {
                Value::String(instruction.to_string())
            } else {
                Value::String(format!("{}\n\n{}", existing, instruction))
            }
        }
        Some(Value::Array(items)) => {
            let mut next = items.clone();
            next.push(json!({
                "type": "text",
                "text": if items.is_empty() {
                    instruction.to_string()
                } else {
                    format!("\n\n{}", instruction)
                }
            }));
            Value::Array(next)
        }
        Some(Value::Object(row)) => {
            let mut next = row.clone();
            if let Some(existing) = next.get("text").and_then(|value| value.as_str()) {
                next.insert(
                    "text".to_string(),
                    Value::String(if existing.trim().is_empty() {
                        instruction.to_string()
                    } else {
                        format!("{}\n\n{}", existing, instruction)
                    }),
                );
                return Value::Object(next);
            }
            if let Some(existing) = next.get("content").and_then(|value| value.as_str()) {
                next.insert(
                    "content".to_string(),
                    Value::String(if existing.trim().is_empty() {
                        instruction.to_string()
                    } else {
                        format!("{}\n\n{}", existing, instruction)
                    }),
                );
                return Value::Object(next);
            }
            if let Some(existing) = next.get("content") {
                if existing.is_array() {
                    let nested = append_instruction_to_content(Some(existing), instruction);
                    next.insert("content".to_string(), nested);
                    return Value::Object(next);
                }
            }
            Value::Array(vec![
                Value::Object(row.clone()),
                json!({ "type": "text", "text": instruction }),
            ])
        }
        _ => Value::String(instruction.to_string()),
    }
}

fn ensure_system_message(messages: &mut Vec<Value>) {
    let has_system = messages
        .first()
        .and_then(|value| value.as_object())
        .and_then(|row| read_trimmed_string(row.get("role")))
        .map(|role| role.eq_ignore_ascii_case("system"))
        .unwrap_or(false);

    if has_system {
        return;
    }

    messages.insert(
        0,
        Value::Object(Map::from_iter([
            ("role".to_string(), Value::String("system".to_string())),
            ("content".to_string(), Value::String(String::new())),
        ])),
    );
}

fn apply_tool_text_request_guidance(payload: &mut Value, config: Option<&Map<String, Value>>) {
    if !read_config_bool(config, "enabled", true) {
        return;
    }

    let Some(root) = payload.as_object_mut() else {
        return;
    };

    if read_config_bool(config, "requireTools", true) {
        let has_tools = root
            .get("tools")
            .and_then(|value| value.as_array())
            .map(|items| !items.is_empty())
            .unwrap_or(false);
        if !has_tools {
            return;
        }
    }

    let Some(original_messages) = root.get("messages").and_then(|value| value.as_array()) else {
        return;
    };

    let mut messages: Vec<Value> = original_messages
        .iter()
        .filter(|item| item.is_object())
        .cloned()
        .collect();
    if messages.is_empty() {
        return;
    }

    let instruction = read_trimmed_string(config.and_then(|row| row.get("instruction")))
        .unwrap_or_else(|| build_default_instruction(root, config));
    if instruction.is_empty() {
        return;
    }

    let marker = read_trimmed_string(config.and_then(|row| row.get("marker")))
        .unwrap_or_else(|| DEFAULT_MARKER.to_string());

    ensure_system_message(&mut messages);
    if let Some(system) = messages.first_mut().and_then(|value| value.as_object_mut()) {
        if !content_has_marker(system.get("content"), &marker) {
            let next_content = append_instruction_to_content(system.get("content"), &instruction);
            system.insert("content".to_string(), next_content);
        }
    }

    root.insert("messages".to_string(), Value::Array(messages));
}

pub(crate) fn apply_tool_text_request_guidance_json(
    payload_json: String,
    config_json: Option<String>,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let config: Option<Map<String, Value>> = match config_json {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str::<Value>(&raw)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?
            .as_object()
            .cloned(),
        _ => None,
    };

    apply_tool_text_request_guidance(&mut payload, config.as_ref());

    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn guidance_skips_when_tools_missing() {
        let mut payload = json!({
            "messages": [{ "role": "user", "content": "hi" }]
        });

        apply_tool_text_request_guidance(&mut payload, None);

        assert_eq!(payload["messages"][0]["role"], "user");
        assert_eq!(payload["messages"][0]["content"], "hi");
    }

    #[test]
    fn guidance_does_not_duplicate_marker() {
        let mut payload = json!({
            "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
            "messages": [{
                "role": "system",
                "content": "Tool-call output contract (STRICT):\nalready there"
            }]
        });

        apply_tool_text_request_guidance(&mut payload, None);

        let content = payload["messages"][0]["content"].as_str().unwrap_or("");
        assert_eq!(content.matches(DEFAULT_MARKER).count(), 1);
    }

    #[test]
    fn guidance_mentions_required_tool_choice() {
        let mut payload = json!({
            "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
            "tool_choice": "required",
            "messages": [{ "role": "user", "content": "hi" }]
        });

        apply_tool_text_request_guidance(&mut payload, None);

        let content = payload["messages"][0]["content"].as_str().unwrap_or("");
        assert!(content
            .contains("tool_choice is required for this turn: return at least one tool call."));
    }
}
