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
        "gpt-4" | "gpt-4-turbo" | "gpt-4o" => "qwen3-coder-plus".to_string(),
        _ => model.to_string(),
    }
}

fn qwen_text_chunk(text: String) -> Value {
    let mut chunk = Map::new();
    chunk.insert("text".to_string(), Value::String(text));
    Value::Object(chunk)
}

fn normalize_qwen_content_chunk(chunk: &Value) -> Value {
    if let Some(text) = chunk.as_str() {
        return qwen_text_chunk(text.to_string());
    }
    if let Some(obj) = chunk.as_object() {
        if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
            return qwen_text_chunk(text.to_string());
        }
        return Value::Object(obj.clone());
    }
    qwen_text_chunk(coerce_text(chunk))
}

fn normalize_qwen_message_content(content: Option<&Value>) -> Vec<Value> {
    let Some(content_value) = content else {
        return vec![qwen_text_chunk(String::new())];
    };
    if content_value.is_null() {
        return vec![qwen_text_chunk(String::new())];
    }
    if let Some(text) = content_value.as_str() {
        return vec![qwen_text_chunk(text.to_string())];
    }
    if let Some(entries) = content_value.as_array() {
        return entries
            .iter()
            .map(normalize_qwen_content_chunk)
            .collect::<Vec<Value>>();
    }
    if let Some(obj) = content_value.as_object() {
        if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
            return vec![qwen_text_chunk(text.to_string())];
        }
    }
    let serialized = serde_json::to_string(content_value).unwrap_or_else(|_| String::new());
    vec![qwen_text_chunk(serialized)]
}

fn normalize_qwen_message(message: &Value) -> Option<Value> {
    let row = message.as_object()?;
    let role = row
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("user")
        .to_string();
    let content = normalize_qwen_message_content(row.get("content"));
    let mut out = Map::new();
    out.insert("role".to_string(), Value::String(role));
    out.insert("content".to_string(), Value::Array(content));
    Some(Value::Object(out))
}

fn extract_qwen_parameters(request: &Map<String, Value>) -> Option<Value> {
    let mut parameters = Map::new();
    let numeric_fields: [(&str, &str); 5] = [
        ("temperature", "temperature"),
        ("top_p", "top_p"),
        ("frequency_penalty", "frequency_penalty"),
        ("presence_penalty", "presence_penalty"),
        ("max_tokens", "max_output_tokens"),
    ];
    for (key, target) in numeric_fields {
        if let Some(value) = request.get(key) {
            if value.is_number() {
                parameters.insert(target.to_string(), value.clone());
            }
        }
    }

    if let Some(stop_value) = request.get("stop") {
        let mut sequences: Vec<Value> = Vec::new();
        if let Some(entries) = stop_value.as_array() {
            for entry in entries {
                if let Some(text) = entry.as_str() {
                    sequences.push(Value::String(text.to_string()));
                }
            }
        } else if let Some(text) = stop_value.as_str() {
            sequences.push(Value::String(text.to_string()));
        }
        if !sequences.is_empty() {
            parameters.insert("stop_sequences".to_string(), Value::Array(sequences));
        }
    }

    if let Some(debug) = request.get("debug").and_then(|v| v.as_bool()) {
        parameters.insert("debug".to_string(), Value::Bool(debug));
    }
    let reasoning_enabled = match request.get("reasoning") {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => !text.trim().eq_ignore_ascii_case("low"),
        Some(Value::Object(obj)) => obj
            .get("effort")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().eq_ignore_ascii_case("low"))
            .unwrap_or(true),
        Some(_) => true,
    };
    if reasoning_enabled {
        parameters.insert("reasoning".to_string(), Value::Bool(true));
    }

    if parameters.is_empty() {
        return None;
    }
    Some(Value::Object(parameters))
}

fn sanitize_qwen_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            let Some(tool_obj) = tool.as_object() else {
                return tool.clone();
            };
            let mut normalized = Map::new();
            if let Some(tool_type) = tool_obj.get("type").and_then(|v| v.as_str()) {
                normalized.insert("type".to_string(), Value::String(tool_type.to_string()));
            }
            if let Some(function_obj) = tool_obj.get("function").and_then(|v| v.as_object()) {
                normalized.insert("function".to_string(), Value::Object(function_obj.clone()));
            }
            if normalized.is_empty() {
                tool.clone()
            } else {
                Value::Object(normalized)
            }
        })
        .collect::<Vec<Value>>()
}

pub(crate) fn apply_qwen_request_compat(root: &Map<String, Value>) -> Value {
    let mut qwen_request = Map::new();
    if let Some(model) = root.get("model").and_then(|v| v.as_str()) {
        qwen_request.insert(
            "model".to_string(),
            Value::String(normalize_qwen_model_name(model)),
        );
    }
    if let Some(messages) = root.get("messages").and_then(|v| v.as_array()) {
        qwen_request.insert("messages".to_string(), Value::Array(messages.clone()));
        let normalized = messages
            .iter()
            .filter_map(normalize_qwen_message)
            .collect::<Vec<Value>>();
        if !normalized.is_empty() {
            qwen_request.insert("input".to_string(), Value::Array(normalized));
        }
    }
    if let Some(parameters) = extract_qwen_parameters(root) {
        qwen_request.insert("parameters".to_string(), parameters);
    }
    if let Some(stream) = root.get("stream").and_then(|v| v.as_bool()) {
        qwen_request.insert("stream".to_string(), Value::Bool(stream));
    }
    if let Some(response_format) = root.get("response_format").and_then(|v| v.as_object()) {
        qwen_request.insert(
            "response_format".to_string(),
            Value::Object(response_format.clone()),
        );
    }
    if let Some(user) = root.get("user").and_then(|v| v.as_str()) {
        qwen_request.insert("user".to_string(), Value::String(user.to_string()));
    }
    if let Some(tools) = root.get("tools").and_then(|v| v.as_array()) {
        qwen_request.insert(
            "tools".to_string(),
            Value::Array(sanitize_qwen_tools(tools)),
        );
    }
    if let Some(metadata) = root.get("metadata").and_then(|v| v.as_object()) {
        qwen_request.insert("metadata".to_string(), Value::Object(metadata.clone()));
    }
    Value::Object(qwen_request)
}
