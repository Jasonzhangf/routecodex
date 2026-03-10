use regex::Regex;
use serde_json::{Map, Value};

use super::read_trimmed_string;

fn normalize_function_results_markup_text(value: &str) -> (String, bool) {
    let re = match Regex::new(r"(?is)<function_results>\s*([\s\S]*?)\s*</function_results>") {
        Ok(v) => v,
        Err(_) => return (value.to_string(), false),
    };
    let mut changed = false;
    let replaced = re
        .replace_all(value, |caps: &regex::Captures| {
            changed = true;
            let payload = caps
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            if payload.is_empty() {
                String::new()
            } else {
                format!("\n```json\n{}\n```\n", payload)
            }
        })
        .to_string();
    if !changed {
        return (value.to_string(), false);
    }
    let collapsed = Regex::new(r"\n{3,}")
        .ok()
        .map(|re| re.replace_all(&replaced, "\n\n").to_string())
        .unwrap_or(replaced);
    (collapsed.trim().to_string(), true)
}

fn normalize_commentary_markup_text(value: &str) -> (String, bool) {
    let re = match Regex::new(r"(?is)<\s*commentary\s*>([\s\S]*?)<\s*/\s*commentary\s*>") {
        Ok(v) => v,
        Err(_) => return (value.to_string(), false),
    };
    let mut changed = false;
    let mut captured: Vec<String> = Vec::new();
    let stripped = re
        .replace_all(value, |caps: &regex::Captures| {
            changed = true;
            let text = caps
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            if !text.is_empty() {
                captured.push(text);
            }
            String::new()
        })
        .to_string();
    if !changed {
        return (value.to_string(), false);
    }
    let collapsed = Regex::new(r"\n{3,}")
        .ok()
        .map(|re| re.replace_all(&stripped, "\n\n").to_string())
        .unwrap_or(stripped);
    let trimmed = collapsed.trim().to_string();
    if !trimmed.is_empty() {
        return (trimmed, true);
    }
    (captured.join("\n\n").trim().to_string(), true)
}

fn normalize_text_markup(value: &str) -> (String, bool, bool) {
    let (function_results_text, function_results_changed) =
        normalize_function_results_markup_text(value);
    let (commentary_text, commentary_changed) =
        normalize_commentary_markup_text(&function_results_text);
    (
        commentary_text,
        function_results_changed,
        function_results_changed || commentary_changed,
    )
}

pub(super) fn harvest_function_results_markup(payload: &mut Value) -> bool {
    let Some(choices) = payload
        .as_object_mut()
        .and_then(|row| row.get_mut("choices"))
        .and_then(|v| v.as_array_mut())
    else {
        return false;
    };

    let mut harvested = false;
    for choice in choices {
        let Some(message) = choice
            .as_object_mut()
            .and_then(|row| row.get_mut("message"))
            .and_then(|v| v.as_object_mut())
        else {
            continue;
        };

        if let Some(content) = message.get_mut("content") {
            if let Some(raw) = content.as_str() {
                let (next, function_results_changed, changed) = normalize_text_markup(raw);
                if changed {
                    *content = Value::String(next);
                }
                if function_results_changed {
                    harvested = true;
                }
            } else if let Some(parts) = content.as_array_mut() {
                for part in parts {
                    let Some(part_obj) = part.as_object_mut() else {
                        continue;
                    };
                    for key in ["text", "content"] {
                        let Some(raw) = part_obj.get(key).and_then(|v| v.as_str()) else {
                            continue;
                        };
                        let (next, function_results_changed, changed) = normalize_text_markup(raw);
                        if changed {
                            part_obj.insert(key.to_string(), Value::String(next));
                        }
                        if function_results_changed {
                            harvested = true;
                        }
                    }
                }
            }
        }

        for key in ["reasoning", "reasoning_content"] {
            let Some(raw) = message.get(key).and_then(|v| v.as_str()) else {
                continue;
            };
            let (next, function_results_changed, changed) = normalize_text_markup(raw);
            if changed {
                message.insert(key.to_string(), Value::String(next));
            }
            if function_results_changed {
                harvested = true;
            }
        }
    }

    harvested
}

pub(super) fn mark_function_results_harvested(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    let metadata_value = root
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !metadata_value.is_object() {
        *metadata_value = Value::Object(Map::new());
    }
    let Some(metadata) = metadata_value.as_object_mut() else {
        return;
    };
    let deepseek_value = metadata
        .entry("deepseek".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !deepseek_value.is_object() {
        *deepseek_value = Value::Object(Map::new());
    }
    let Some(deepseek) = deepseek_value.as_object_mut() else {
        return;
    };
    deepseek.insert(
        "functionResultsTextHarvested".to_string(),
        Value::Bool(true),
    );
}

pub(super) fn ensure_finish_reason_tool_calls(payload: &mut Value) {
    let Some(choices) = payload
        .as_object_mut()
        .and_then(|row| row.get_mut("choices"))
        .and_then(|v| v.as_array_mut())
    else {
        return;
    };

    for choice in choices {
        let Some(choice_obj) = choice.as_object_mut() else {
            continue;
        };
        let has_tool_calls = choice_obj
            .get("message")
            .and_then(|v| v.as_object())
            .and_then(|msg| msg.get("tool_calls"))
            .and_then(|v| v.as_array())
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
        if !has_tool_calls {
            continue;
        }
        let finish_reason = read_trimmed_string(choice_obj.get("finish_reason"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if finish_reason.is_empty() || finish_reason == "stop" {
            choice_obj.insert(
                "finish_reason".to_string(),
                Value::String("tool_calls".to_string()),
            );
        }
    }
}

pub(super) fn write_deepseek_tool_state(payload: &mut Value, state: &str, source: &str) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };

    let metadata_value = root
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !metadata_value.is_object() {
        *metadata_value = Value::Object(Map::new());
    }
    let Some(metadata) = metadata_value.as_object_mut() else {
        return;
    };

    let deepseek_value = metadata
        .entry("deepseek".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !deepseek_value.is_object() {
        *deepseek_value = Value::Object(Map::new());
    }
    let Some(deepseek) = deepseek_value.as_object_mut() else {
        return;
    };
    deepseek.insert(
        "toolCallState".to_string(),
        Value::String(state.to_string()),
    );
    deepseek.insert(
        "toolCallSource".to_string(),
        Value::String(source.to_string()),
    );
}
