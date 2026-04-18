use super::tool_definitions::normalize_qwen_family_tool_definitions;
use serde_json::{Map, Value};

fn coerce_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(num) => num.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(entries) => entries.iter().map(coerce_text).collect::<Vec<_>>().join(""),
        Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn normalize_qwen_model_name(model: &str) -> String {
    match model {
        "gpt-3.5-turbo" => "qwen-turbo".to_string(),
        "gpt-4" | "gpt-4-turbo" | "gpt-4o" => "coder-model".to_string(),
        _ => model.to_string(),
    }
}

fn qwen_text_chunk(text: String) -> Value {
    let mut chunk = Map::new();
    chunk.insert("type".to_string(), Value::String("text".to_string()));
    chunk.insert("text".to_string(), Value::String(text));
    Value::Object(chunk)
}

fn qwen_media_chunk(media_type: &str, url: String) -> Value {
    let mut media = Map::new();
    media.insert("url".to_string(), Value::String(url));
    let mut chunk = Map::new();
    chunk.insert("type".to_string(), Value::String(media_type.to_string()));
    chunk.insert(media_type.to_string(), Value::Object(media));
    Value::Object(chunk)
}

fn read_media_url(obj: &Map<String, Value>, key: &str) -> Option<String> {
    if let Some(raw) = obj.get(key) {
        if let Some(text) = raw.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Some(node) = raw.as_object() {
            for candidate in ["url", "data"] {
                if let Some(text) = node.get(candidate).and_then(|v| v.as_str()) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
    }
    None
}

fn normalize_qwen_content_chunk(chunk: &Value) -> Value {
    if let Some(text) = chunk.as_str() {
        return qwen_text_chunk(text.to_string());
    }
    if let Some(obj) = chunk.as_object() {
        if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
            // Responses API uses input_text/output_text/text/commentary types
            // Qwen API only accepts: text, image_url, video_url, video (no type field)
            let raw_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if matches!(
                raw_type.to_ascii_lowercase().as_str(),
                "input_text" | "output_text" | "text" | "commentary"
            ) {
                return qwen_text_chunk(text.to_string());
            }
        }
        let raw_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match raw_type.to_ascii_lowercase().as_str() {
            "input_image" | "image" | "image_url" => {
                if let Some(url) = read_media_url(obj, "image_url")
                    .or_else(|| read_media_url(obj, "url"))
                    .or_else(|| read_media_url(obj, "image"))
                {
                    return qwen_media_chunk("image_url", url);
                }
            }
            "input_video" | "video" | "video_url" => {
                if let Some(url) = read_media_url(obj, "video_url")
                    .or_else(|| read_media_url(obj, "url"))
                    .or_else(|| read_media_url(obj, "video"))
                {
                    return qwen_media_chunk("video_url", url);
                }
            }
            _ => {}
        }
        return Value::Object(obj.clone());
    }
    qwen_text_chunk(coerce_text(chunk))
}

fn normalize_qwen_message_content(content: Option<&Value>) -> Value {
    let Some(content_value) = content else {
        return Value::Null;
    };
    match content_value {
        Value::Array(entries) => Value::Array(
            entries
                .iter()
                .map(normalize_qwen_content_chunk)
                .collect::<Vec<Value>>(),
        ),
        _ => content_value.clone(),
    }
}

fn normalize_qwen_message(message: &Value) -> Option<Value> {
    let row = message.as_object()?;
    let mut out = row.clone();
    if row.contains_key("content") {
        out.insert(
            "content".to_string(),
            normalize_qwen_message_content(row.get("content")),
        );
    }
    Some(Value::Object(out))
}

fn normalize_qwen_tool_choice(tool_choice: &Value) -> Value {
    let Some(choice_obj) = tool_choice.as_object() else {
        return tool_choice.clone();
    };
    let choice_type = choice_obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if choice_type != "function" {
        return tool_choice.clone();
    }

    if choice_obj
        .get("function")
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get("name"))
        .and_then(|v| v.as_str())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return tool_choice.clone();
    }

    let Some(name) = choice_obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    else {
        return tool_choice.clone();
    };

    let mut function = Map::new();
    function.insert("name".to_string(), Value::String(name.to_string()));

    let mut out = choice_obj.clone();
    out.remove("name");
    out.insert("function".to_string(), Value::Object(function));
    Value::Object(out)
}

pub(crate) fn apply_qwen_request_compat(root: &Map<String, Value>) -> Value {
    let mut qwen_request = root.clone();
    if let Some(model) = root.get("model").and_then(|v| v.as_str()) {
        qwen_request.insert(
            "model".to_string(),
            Value::String(normalize_qwen_model_name(model)),
        );
    }
    if let Some(messages) = root.get("messages").and_then(|v| v.as_array()) {
        let normalized = messages
            .iter()
            .filter_map(normalize_qwen_message)
            .collect::<Vec<Value>>();
        if !normalized.is_empty() {
            qwen_request.insert("messages".to_string(), Value::Array(normalized));
        }
    }
    if let Some(tool_choice) = root.get("tool_choice") {
        qwen_request.insert(
            "tool_choice".to_string(),
            normalize_qwen_tool_choice(tool_choice),
        );
    }
    if let Some(normalized_tools) = normalize_qwen_family_tool_definitions(root) {
        qwen_request.insert("tools".to_string(), normalized_tools);
    }
    Value::Object(qwen_request)
}
