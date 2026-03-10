use serde_json::Value;

pub(crate) fn extract_message_text(message: &Value) -> String {
    if let Some(content) = message.get("content") {
        if let Some(text) = content.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Some(items) = content.as_array() {
            let mut parts: Vec<String> = Vec::new();
            for entry in items {
                if let Some(text) = entry.as_str() {
                    if !text.trim().is_empty() {
                        parts.push(text.trim().to_string());
                    }
                    continue;
                }
                if let Some(map) = entry.as_object() {
                    if let Some(text) = map.get("text").and_then(|v| v.as_str()) {
                        if !text.trim().is_empty() {
                            parts.push(text.trim().to_string());
                            continue;
                        }
                    }
                    if let Some(text) = map.get("content").and_then(|v| v.as_str()) {
                        if !text.trim().is_empty() {
                            parts.push(text.trim().to_string());
                        }
                    }
                }
            }
            let joined = parts.join("\n").trim().to_string();
            if !joined.is_empty() {
                return joined;
            }
        }
    }
    "".to_string()
}

pub(crate) fn get_latest_message_role(messages: &[Value]) -> Option<String> {
    messages
        .last()
        .and_then(|msg| msg.get("role"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
}
