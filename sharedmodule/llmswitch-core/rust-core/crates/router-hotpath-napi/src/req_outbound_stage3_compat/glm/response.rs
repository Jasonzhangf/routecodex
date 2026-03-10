mod content;
mod parser;

use serde_json::Value;

use content::flatten_content;
use parser::extract_tool_calls_from_text;

pub(crate) fn apply_glm_response_compat(payload: Value) -> Value {
    let mut payload = payload;
    let Some(root) = payload.as_object_mut() else {
        return payload;
    };
    let Some(choices) = root.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return payload;
    };

    for (idx, choice) in choices.iter_mut().enumerate() {
        let Some(choice_row) = choice.as_object_mut() else {
            continue;
        };
        let Some(message) = choice_row
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
        else {
            continue;
        };
        let content_text = if message.contains_key("content") {
            flatten_content(message.get("content").unwrap_or(&Value::Null), 0)
        } else {
            String::new()
        };
        let source_text = if !content_text.trim().is_empty() {
            content_text
        } else {
            message
                .get("reasoning_content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        if source_text.trim().is_empty() {
            continue;
        }
        let Some((tool_calls, reasoning)) = extract_tool_calls_from_text(&source_text, idx + 1)
        else {
            continue;
        };
        if !tool_calls.is_empty() {
            message.insert("tool_calls".to_string(), Value::Array(tool_calls));
            if message.contains_key("content") {
                message.insert("content".to_string(), Value::Null);
            }
        }
        if let Some(reasoning_text) = reasoning {
            message.insert(
                "reasoning_content".to_string(),
                Value::String(reasoning_text),
            );
        } else {
            message.remove("reasoning_content");
        }
    }
    payload
}
