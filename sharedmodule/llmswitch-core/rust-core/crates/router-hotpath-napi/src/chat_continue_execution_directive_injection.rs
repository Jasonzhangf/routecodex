use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContinueExecutionDirectiveInjectionOutput {
    changed: bool,
    messages: Value,
}

fn message_content_contains_token(content: &Value, token: &str) -> bool {
    if token.trim().is_empty() {
        return false;
    }
    if let Some(raw) = content.as_str() {
        return raw.contains(token);
    }
    let parts = match content.as_array() {
        Some(v) => v,
        None => return false,
    };
    for part in parts {
        let obj = match part.as_object() {
            Some(v) => v,
            None => continue,
        };
        if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
            if text.contains(token) {
                return true;
            }
        }
    }
    false
}

fn has_continue_execution_directive(messages: &[Value], marker: &str, target_text: &str) -> bool {
    for message in messages {
        let obj = match message.as_object() {
            Some(v) => v,
            None => continue,
        };
        if obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(|v| v == "user")
            .unwrap_or(false)
            == false
        {
            continue;
        }
        let content = match obj.get("content") {
            Some(v) => v,
            None => continue,
        };
        if message_content_contains_token(content, marker)
            || message_content_contains_token(content, target_text)
        {
            return true;
        }
    }
    false
}

fn build_continue_execution_directive(marker: &str, target_text: &str) -> String {
    let marker = marker.trim();
    let target_text = target_text.trim();
    if marker.is_empty() {
        return target_text.to_string();
    }
    if target_text.is_empty() {
        return marker.to_string();
    }
    format!("{}\n{}", marker, target_text)
}

fn inject_continue_execution_directive(
    messages: Value,
    marker: String,
    target_text: String,
) -> ContinueExecutionDirectiveInjectionOutput {
    let marker = marker.trim().to_string();
    let target_text = target_text.trim().to_string();
    let directive = build_continue_execution_directive(marker.as_str(), target_text.as_str());
    if directive.is_empty() {
        return ContinueExecutionDirectiveInjectionOutput {
            changed: false,
            messages,
        };
    }

    let mut rows = match messages {
        Value::Array(values) => values,
        other => {
            return ContinueExecutionDirectiveInjectionOutput {
                changed: false,
                messages: other,
            }
        }
    };
    if rows.is_empty()
        || has_continue_execution_directive(rows.as_slice(), marker.as_str(), target_text.as_str())
    {
        return ContinueExecutionDirectiveInjectionOutput {
            changed: false,
            messages: Value::Array(rows),
        };
    }

    let last_user_index = rows.iter().enumerate().rev().find_map(|(idx, message)| {
        message
            .as_object()
            .and_then(|obj| obj.get("role"))
            .and_then(|v| v.as_str())
            .filter(|v| *v == "user")
            .map(|_| idx)
    });
    let last_user_index = match last_user_index {
        Some(v) => v,
        None => {
            return ContinueExecutionDirectiveInjectionOutput {
                changed: false,
                messages: Value::Array(rows),
            }
        }
    };

    let message = match rows.get_mut(last_user_index) {
        Some(v) => v,
        None => {
            return ContinueExecutionDirectiveInjectionOutput {
                changed: false,
                messages: Value::Array(rows),
            }
        }
    };
    let row = match message.as_object_mut() {
        Some(v) => v,
        None => {
            return ContinueExecutionDirectiveInjectionOutput {
                changed: false,
                messages: Value::Array(rows),
            }
        }
    };

    match row.get("content") {
        Some(Value::String(text)) => {
            let base = text.trim_end().to_string();
            let next = if base.is_empty() {
                directive
            } else {
                format!("{}\n\n{}", base, directive)
            };
            row.insert("content".to_string(), Value::String(next));
        }
        Some(Value::Array(parts)) => {
            let mut next_parts = parts.clone();
            let mut updated = false;
            for idx in (0..next_parts.len()).rev() {
                let part = match next_parts.get_mut(idx) {
                    Some(v) => v,
                    None => continue,
                };
                let part_obj = match part.as_object_mut() {
                    Some(v) => v,
                    None => continue,
                };
                let text = match part_obj.get("text").and_then(|v| v.as_str()) {
                    Some(v) => v,
                    None => continue,
                };
                let base = text.trim_end().to_string();
                let next_text = if base.is_empty() {
                    directive.clone()
                } else {
                    format!("{}\n\n{}", base, directive)
                };
                part_obj.insert("text".to_string(), Value::String(next_text));
                updated = true;
                break;
            }
            if !updated {
                let mut part_obj = Map::new();
                part_obj.insert("type".to_string(), Value::String("input_text".to_string()));
                part_obj.insert("text".to_string(), Value::String(directive));
                next_parts.push(Value::Object(part_obj));
            }
            row.insert("content".to_string(), Value::Array(next_parts));
        }
        _ => {
            row.insert("content".to_string(), Value::String(directive));
        }
    }

    ContinueExecutionDirectiveInjectionOutput {
        changed: true,
        messages: Value::Array(rows),
    }
}

#[napi]
pub fn inject_continue_execution_directive_json(
    messages_json: String,
    marker: String,
    target_text: String,
) -> NapiResult<String> {
    let messages: Value = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = inject_continue_execution_directive(messages, marker, target_text);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
