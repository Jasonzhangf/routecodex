use serde_json::Value;

pub(super) fn flatten_content(content: &Value, depth: usize) -> String {
    if depth > 4 {
        return String::new();
    }
    match content {
        Value::String(text) => text.clone(),
        Value::Array(entries) => entries
            .iter()
            .map(|entry| flatten_content(entry, depth + 1))
            .collect::<Vec<_>>()
            .join(""),
        Value::Object(row) => {
            if let Some(text) = row.get("text").and_then(|v| v.as_str()) {
                return text.to_string();
            }
            if let Some(inner) = row.get("content") {
                return flatten_content(inner, depth + 1);
            }
            String::new()
        }
        _ => String::new(),
    }
}
