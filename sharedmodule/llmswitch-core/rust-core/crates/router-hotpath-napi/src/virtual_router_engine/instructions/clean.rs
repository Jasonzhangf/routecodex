use regex::Regex;
use serde_json::{Map, Value};

fn clean_marker_text(text: &str, marker_re: &Regex) -> String {
    marker_re.replace_all(text, "").trim().to_string()
}

fn strip_malformed_marker_like_segments(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0usize;

    while cursor < text.len() {
        let remaining = &text[cursor..];
        if !remaining.starts_with("<**") {
            let mut chars = remaining.chars();
            if let Some(ch) = chars.next() {
                output.push(ch);
                cursor += ch.len_utf8();
                continue;
            }
            break;
        }

        let valid_close = remaining.find("**>");
        if let Some(close_idx) = valid_close {
            let inner = &remaining[3..close_idx];
            let is_malformed_star_only = inner.trim().is_empty()
                || inner
                    .chars()
                    .all(|ch| ch == '*' || ch.is_whitespace());
            if is_malformed_star_only {
                cursor += close_idx + 3;
                continue;
            }
            output.push_str(&remaining[..close_idx + 3]);
            cursor += close_idx + 3;
            continue;
        }

        if let Some(close_idx) = remaining.find('>') {
            cursor += close_idx + 1;
            continue;
        }

        break;
    }

    output.trim().to_string()
}

fn clean_malformed_marker_like_text(text: &str) -> String {
    strip_malformed_marker_like_segments(text)
}

fn clean_message_content_with<F>(value: &Value, cleaner: &F) -> Option<Value>
where
    F: Fn(&str) -> String,
{
    if let Some(text) = value.as_str() {
        let cleaned = cleaner(text);
        if cleaned.is_empty() {
            return None;
        }
        return Some(Value::String(cleaned));
    }
    if let Some(items) = value.as_array() {
        let mut next_parts: Vec<Value> = Vec::new();
        for part in items {
            if let Some(text) = part.as_str() {
                let cleaned = cleaner(text);
                if !cleaned.is_empty() {
                    next_parts.push(Value::String(cleaned));
                }
                continue;
            }
            if let Some(map) = part.as_object() {
                let mut next_map = map.clone();
                if let Some(text) = map.get("text").and_then(|v| v.as_str()) {
                    let cleaned = cleaner(text);
                    if cleaned.is_empty() {
                        continue;
                    }
                    next_map.insert("text".to_string(), Value::String(cleaned));
                    next_parts.push(Value::Object(next_map));
                    continue;
                }
                if let Some(text) = map.get("content").and_then(|v| v.as_str()) {
                    let cleaned = cleaner(text);
                    if cleaned.is_empty() {
                        continue;
                    }
                    next_map.insert("content".to_string(), Value::String(cleaned));
                    next_parts.push(Value::Object(next_map));
                    continue;
                }
                next_parts.push(Value::Object(next_map));
                continue;
            }
            next_parts.push(part.clone());
        }
        if next_parts.is_empty() {
            return None;
        }
        return Some(Value::Array(next_parts));
    }
    Some(value.clone())
}

fn clean_messages_with<F>(messages: &mut Vec<Value>, cleaner: &F)
where
    F: Fn(&str) -> String,
{
    let mut cleaned: Vec<Value> = Vec::new();
    for message in messages.iter() {
        let mut keep = true;
        if let Some(map) = message.as_object() {
            let role = map.get("role").and_then(|v| v.as_str()).unwrap_or("");
            if role == "user" {
                if let Some(content) = map.get("content") {
                    if let Some(cleaned_content) = clean_message_content_with(content, cleaner) {
                        let mut next_map = map.clone();
                        next_map.insert("content".to_string(), cleaned_content);
                        cleaned.push(Value::Object(next_map));
                        keep = false;
                    } else {
                        keep = false;
                    }
                }
            }
        }
        if keep {
            cleaned.push(message.clone());
        }
    }
    *messages = cleaned;
}

fn clean_responses_context_with<F>(context: &mut Map<String, Value>, cleaner: &F)
where
    F: Fn(&str) -> String,
{
    let input = match context.get_mut("input") {
        Some(Value::Array(items)) => items,
        _ => return,
    };
    let mut cleaned: Vec<Value> = Vec::new();
    for entry in input.iter() {
        let mut keep = true;
        if let Some(map) = entry.as_object() {
            let entry_type = map
                .get("type")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "message".to_string());
            let role = map
                .get("role")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "user".to_string());
            if entry_type == "message" && role == "user" {
                if let Some(content) = map.get("content") {
                    if let Some(cleaned_content) = clean_message_content_with(content, cleaner) {
                        let mut next_map = map.clone();
                        next_map.insert("content".to_string(), cleaned_content);
                        cleaned.push(Value::Object(next_map));
                        keep = false;
                    } else {
                        keep = false;
                    }
                }
            }
        }
        if keep {
            cleaned.push(entry.clone());
        }
    }
    *input = cleaned;
}

fn clean_responses_input_entry_with<F>(entry: &Value, cleaner: &F) -> Option<Value>
where
    F: Fn(&str) -> String,
{
    if let Some(map) = entry.as_object() {
        let entry_type = map
            .get("type")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "message".to_string());
        let role = map
            .get("role")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "user".to_string());
        if entry_type == "message" && role == "user" {
            if let Some(content) = map.get("content") {
                if let Some(cleaned_content) = clean_message_content_with(content, cleaner) {
                    let mut next_map = map.clone();
                    next_map.insert("content".to_string(), cleaned_content);
                    return Some(Value::Object(next_map));
                }
                return None;
            }
        }
        return Some(Value::Object(map.clone()));
    }
    if let Some(text) = entry.as_str() {
        let cleaned = cleaner(text);
        if cleaned.is_empty() {
            return None;
        }
        return Some(Value::String(cleaned));
    }
    Some(entry.clone())
}

fn clean_responses_input_with<F>(input: &mut Value, cleaner: &F)
where
    F: Fn(&str) -> String,
{
    match input {
        Value::Array(items) => {
            let mut cleaned: Vec<Value> = Vec::new();
            for entry in items.iter() {
                if let Some(next_entry) = clean_responses_input_entry_with(entry, cleaner) {
                    cleaned.push(next_entry);
                }
            }
            *items = cleaned;
        }
        Value::String(text) => {
            *text = cleaner(text);
        }
        Value::Object(_) => {
            if let Some(next_entry) = clean_responses_input_entry_with(input, cleaner) {
                *input = next_entry;
            } else {
                *input = Value::String(String::new());
            }
        }
        _ => {}
    }
}

fn clean_request_with<F>(request: &mut Value, cleaner: &F)
where
    F: Fn(&str) -> String,
{
    if let Some(input) = request.get_mut("input") {
        clean_responses_input_with(input, cleaner);
    }
    if let Some(messages) = request.get_mut("messages").and_then(|v| v.as_array_mut()) {
        clean_messages_with(messages, cleaner);
    }
    let semantics = match request.get_mut("semantics").and_then(|v| v.as_object_mut()) {
        Some(map) => map,
        None => return,
    };
    let responses = match semantics
        .get_mut("responses")
        .and_then(|v| v.as_object_mut())
    {
        Some(map) => map,
        None => return,
    };
    if let Some(context) = responses.get_mut("context").and_then(|v| v.as_object_mut()) {
        clean_responses_context_with(context, cleaner);
    }
}

pub(crate) fn clean_routing_instruction_markers(request: &mut Value) {
    let marker_re = Regex::new(r"<\*\*[\s\S]*?\*\*>").unwrap();
    clean_request_with(request, &|text| clean_marker_text(text, &marker_re));
}

pub(crate) fn clean_malformed_routing_instruction_markers(request: &mut Value) {
    clean_request_with(request, &clean_malformed_marker_like_text);
}

#[cfg(test)]
mod tests {
    use super::{clean_malformed_routing_instruction_markers, clean_routing_instruction_markers};
    use serde_json::json;

    #[test]
    fn strips_malformed_markers_before_router_but_keeps_valid_markers() {
        let mut request = json!({
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "<****> hello <**clear**> world <**broken> tail" }
                    ]
                }
            ]
        });
        clean_malformed_routing_instruction_markers(&mut request);
        let text = request["input"][0]["content"][0]["text"]
            .as_str()
            .unwrap_or_default();
        assert_eq!(text, "hello <**clear**> world  tail");
    }

    #[test]
    fn strips_valid_markers_after_router_parse() {
        let mut request = json!({
            "messages": [
                { "role": "user", "content": "<**clear**> continue" }
            ]
        });
        clean_routing_instruction_markers(&mut request);
        assert_eq!(
            request["messages"][0]["content"].as_str().unwrap_or_default(),
            "continue"
        );
    }
}
