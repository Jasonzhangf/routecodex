fn extract_lmstudio_text_parts(content: &Value) -> Vec<String> {
    if let Some(text) = content.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return vec![trimmed.to_string()];
        }
        return Vec::new();
    }
    let Some(parts) = content.as_array() else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for part in parts {
        let Some(part_obj) = part.as_object() else {
            continue;
        };
        let part_type = part_obj
            .get("type")
            .and_then(|v| v.as_str())
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        let text = part_obj
            .get("text")
            .and_then(|v| v.as_str())
            .or_else(|| part_obj.get("content").and_then(|v| v.as_str()));
        if let Some(text_value) = text {
            let trimmed = text_value.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
                continue;
            }
        }
        if (part_type == "input_text" || part_type == "output_text")
            && part_obj.get("text").and_then(|v| v.as_str()).is_some()
        {
            let txt = part_obj
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let trimmed = txt.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
        }
    }
    out
}

fn stringify_lmstudio_input_items(input: &[Value]) -> String {
    let mut chunks: Vec<String> = Vec::new();
    for item in input {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        let item_type = item_obj
            .get("type")
            .and_then(|v| v.as_str())
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        let role_candidate = item_obj
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let message_obj = item_obj.get("message").and_then(|v| v.as_object());
        let nested_role = message_obj
            .and_then(|row| row.get("role"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if item_type == "message"
            || (item_type.is_empty() && (!role_candidate.is_empty() || !nested_role.is_empty()))
        {
            let role = if !role_candidate.is_empty() {
                role_candidate
            } else if !nested_role.is_empty() {
                nested_role
            } else {
                "user".to_string()
            };
            let content_node = item_obj
                .get("content")
                .or_else(|| message_obj.and_then(|row| row.get("content")))
                .cloned()
                .unwrap_or(Value::Null);
            let parts = extract_lmstudio_text_parts(&content_node);
            if !parts.is_empty() {
                chunks.push(format!("{}: {}", role, parts.join("\n")));
            }
            continue;
        }
        if item_type == "function_call" {
            let name = item_obj
                .get("name")
                .and_then(|v| v.as_str())
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .unwrap_or("tool")
                .to_string();
            let args = match item_obj.get("arguments") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => serde_json::to_string(other).unwrap_or_else(|_| String::new()),
                None => "null".to_string(),
            };
            chunks.push(format!("assistant tool_call {}: {}", name, args));
            continue;
        }
        if item_type == "function_call_output" {
            let output = match item_obj.get("output") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => serde_json::to_string(other).unwrap_or_else(|_| String::new()),
                None => "null".to_string(),
            };
            chunks.push(format!("tool_output: {}", output));
        }
    }
    chunks.join("\n\n")
}

fn apply_lmstudio_responses_input_stringify(
    root: &mut Map<String, Value>,
    adapter_context: &AdapterContext,
) {
    if !lmstudio_stringify_input_enabled(adapter_context) {
        return;
    }
    if !provider_protocol_matches(adapter_context.provider_protocol.as_ref(), "openai-responses") {
        return;
    }
    let Some(input_array) = root.get("input").and_then(|v| v.as_array()).cloned() else {
        return;
    };
    let flattened = stringify_lmstudio_input_items(&input_array);
    let instructions = root
        .get("instructions")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let final_text = if let Some(instruction_text) = instructions {
        format!("{}\n\n{}", instruction_text, flattened)
            .trim()
            .to_string()
    } else {
        flattened
    };
    root.insert("input".to_string(), Value::String(final_text));
}
