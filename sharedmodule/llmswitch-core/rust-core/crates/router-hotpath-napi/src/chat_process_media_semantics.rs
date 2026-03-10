use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatProcessMediaAnalysisOutput {
    pub strip_indices: Vec<i64>,
    pub contains_current_turn_image: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatProcessMediaStripOutput {
    pub changed: bool,
    pub messages: Vec<Value>,
}

fn read_role(message: &Value) -> &str {
    message
        .as_object()
        .and_then(|obj| obj.get("role"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("")
}

fn read_message_entry_role(entry: &Value) -> &str {
    let obj = match entry.as_object() {
        Some(value) => value,
        None => return "",
    };

    // 首先检查是否有 role 字段（OpenAI Responses 协议的 user/assistant 消息没有 type 字段）
    let role = read_role(entry);
    if !role.is_empty() {
        return role;
    }

    // 否则检查 type 字段
    let entry_type = obj
        .get("type")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "message".to_string());
    if entry_type != "message" {
        return "";
    }
    read_role(entry)
}

fn part_type_contains_media(part: &Value) -> bool {
    let obj = match part.as_object() {
        Some(v) => v,
        None => return false,
    };
    let type_value = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if type_value.contains("image") || type_value.contains("video") {
        return true;
    }
    obj.contains_key("image_url") || obj.contains_key("video_url")
}

fn part_type_contains_image(part: &Value) -> bool {
    let obj = match part.as_object() {
        Some(v) => v,
        None => return false,
    };
    let type_value = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if type_value.contains("image") {
        return true;
    }
    obj.contains_key("image_url")
}

fn read_media_candidate(obj: &Map<String, Value>, key: &str) -> Option<String> {
    if let Some(value) = obj.get(key).and_then(|v| v.as_str()) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(nested) = obj.get(key).and_then(|v| v.as_object()) {
        for nested_key in ["url", "uri", "data", "base64"] {
            if let Some(value) = nested.get(nested_key).and_then(|v| v.as_str()) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

fn read_part_media_candidate(part: &Value) -> String {
    let obj = match part.as_object() {
        Some(v) => v,
        None => return String::new(),
    };
    if let Some(value) = read_media_candidate(obj, "image_url") {
        return value;
    }
    if let Some(value) = read_media_candidate(obj, "video_url") {
        return value;
    }
    for key in ["url", "uri", "data", "base64"] {
        if let Some(value) = obj.get(key).and_then(|v| v.as_str()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn message_has_media_parts(message: &Value) -> bool {
    let parts = match message
        .as_object()
        .and_then(|obj| obj.get("content"))
        .and_then(|v| v.as_array())
    {
        Some(v) => v,
        None => return false,
    };
    if parts.is_empty() {
        return false;
    }
    parts.iter().any(|part| {
        part_type_contains_media(part) && !read_part_media_candidate(part).trim().is_empty()
    })
}

fn contains_image_in_current_turn(messages: &[Value]) -> bool {
    let last = match messages.last() {
        Some(v) => v,
        None => return false,
    };
    if read_role(last) != "user" {
        return false;
    }
    let parts = match last
        .as_object()
        .and_then(|obj| obj.get("content"))
        .and_then(|v| v.as_array())
    {
        Some(v) => v,
        None => return false,
    };
    for part in parts {
        if !part_type_contains_image(part) {
            continue;
        }
        if !read_part_media_candidate(part).trim().is_empty() {
            return true;
        }
    }
    false
}

pub fn analyze_chat_process_media(messages: Vec<Value>) -> ChatProcessMediaAnalysisOutput {
    if messages.is_empty() {
        return ChatProcessMediaAnalysisOutput {
            strip_indices: Vec::new(),
            contains_current_turn_image: false,
        };
    }

    let is_new_user_turn = messages
        .last()
        .map(|v| read_role(v) == "user")
        .unwrap_or(false);

    let mut latest_user_index: i64 = -1;
    if is_new_user_turn {
        for idx in (0..messages.len()).rev() {
            if read_role(&messages[idx]) == "user" {
                latest_user_index = idx as i64;
                break;
            }
        }
        if latest_user_index < 0 {
            return ChatProcessMediaAnalysisOutput {
                strip_indices: Vec::new(),
                contains_current_turn_image: false,
            };
        }
    }

    let mut strip_indices = Vec::new();
    for (idx, message) in messages.iter().enumerate() {
        if is_new_user_turn && idx as i64 == latest_user_index {
            continue;
        }
        if read_role(message) != "user" {
            continue;
        }
        if message_has_media_parts(message) {
            strip_indices.push(idx as i64);
        }
    }

    ChatProcessMediaAnalysisOutput {
        strip_indices,
        contains_current_turn_image: contains_image_in_current_turn(&messages),
    }
}

fn placeholder_text_for_part(part: &Value, default_placeholder: &str) -> String {
    let obj = match part.as_object() {
        Some(v) => v,
        None => return default_placeholder.to_string(),
    };
    let type_value = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if type_value.contains("video") || obj.contains_key("video_url") {
        return "[Video omitted]".to_string();
    }
    default_placeholder.to_string()
}

pub fn strip_chat_process_historical_images(
    messages: Vec<Value>,
    placeholder_text: String,
) -> ChatProcessMediaStripOutput {
    if messages.is_empty() {
        return ChatProcessMediaStripOutput {
            changed: false,
            messages,
        };
    }

    let analysis = analyze_chat_process_media(messages.clone());
    if analysis.strip_indices.is_empty() {
        return ChatProcessMediaStripOutput {
            changed: false,
            messages,
        };
    }

    let mut next_messages = messages.clone();
    let mut changed = false;
    let placeholder = if placeholder_text.trim().is_empty() {
        "[Image omitted]".to_string()
    } else {
        placeholder_text
    };

    for idx_value in analysis.strip_indices {
        if idx_value < 0 {
            continue;
        }
        let idx = idx_value as usize;
        if idx >= next_messages.len() {
            continue;
        }

        let message = match next_messages[idx].as_object_mut() {
            Some(v) => v,
            None => continue,
        };
        let content_value = match message.get_mut("content") {
            Some(v) => v,
            None => continue,
        };
        let content_parts = match content_value.as_array_mut() {
            Some(v) => v,
            None => continue,
        };
        if content_parts.is_empty() {
            continue;
        }

        let mut removed = false;
        let mut filtered: Vec<Value> = Vec::with_capacity(content_parts.len());
        for part in content_parts.iter() {
            if part_type_contains_media(part) {
                removed = true;
                let mut replacement = serde_json::Map::new();
                replacement.insert("type".to_string(), Value::String("text".to_string()));
                replacement.insert(
                    "text".to_string(),
                    Value::String(placeholder_text_for_part(part, &placeholder)),
                );
                filtered.push(Value::Object(replacement));
            } else {
                filtered.push(part.clone());
            }
        }

        if removed {
            *content_parts = filtered;
            changed = true;
        }
    }

    if !changed {
        return ChatProcessMediaStripOutput {
            changed: false,
            messages,
        };
    }

    ChatProcessMediaStripOutput {
        changed: true,
        messages: next_messages,
    }
}

pub fn strip_responses_context_input_historical_media(
    input_entries: Vec<Value>,
    placeholder_text: String,
) -> ChatProcessMediaStripOutput {
    if input_entries.is_empty() {
        return ChatProcessMediaStripOutput {
            changed: false,
            messages: input_entries,
        };
    }

    let latest_message_index = input_entries.iter().rposition(|entry| {
        let role = read_message_entry_role(entry);
        role == "user" || role == "assistant" || role == "tool"
    });
    let latest_message_role = latest_message_index
        .and_then(|index| input_entries.get(index))
        .map(read_message_entry_role)
        .unwrap_or("");
    let is_new_user_turn = latest_message_role == "user";

    let latest_user_index = if is_new_user_turn {
        input_entries
            .iter()
            .rposition(|entry| read_message_entry_role(entry) == "user")
    } else {
        None
    };

    let mut next_entries = input_entries.clone();
    let mut changed = false;
    let placeholder = if placeholder_text.trim().is_empty() {
        "[Image omitted]".to_string()
    } else {
        placeholder_text
    };

    for (idx, entry) in next_entries.iter_mut().enumerate() {
        let role = read_message_entry_role(entry);
        if role != "user" {
            continue;
        }
        if is_new_user_turn && latest_user_index == Some(idx) {
            continue;
        }
        if !message_has_media_parts(entry) {
            continue;
        }
        let obj = match entry.as_object_mut() {
            Some(value) => value,
            None => continue,
        };
        let content = match obj.get_mut("content").and_then(|v| v.as_array_mut()) {
            Some(value) => value,
            None => continue,
        };
        let mut removed = false;
        let mut filtered: Vec<Value> = Vec::with_capacity(content.len());
        for part in content.iter() {
            if part_type_contains_media(part) {
                removed = true;
                let mut replacement = serde_json::Map::new();
                replacement.insert("type".to_string(), Value::String("input_text".to_string()));
                replacement.insert(
                    "text".to_string(),
                    Value::String(placeholder_text_for_part(part, &placeholder)),
                );
                filtered.push(Value::Object(replacement));
            } else {
                filtered.push(part.clone());
            }
        }
        if removed {
            *content = filtered;
            changed = true;
        }
    }

    ChatProcessMediaStripOutput {
        changed,
        messages: if changed { next_entries } else { input_entries },
    }
}
