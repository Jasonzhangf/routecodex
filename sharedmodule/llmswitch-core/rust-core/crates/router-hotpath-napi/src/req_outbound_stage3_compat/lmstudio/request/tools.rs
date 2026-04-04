fn normalize_lmstudio_tool_parameters(raw: Option<&Value>) -> Value {
    let mut candidate = raw.cloned().unwrap_or(Value::Null);
    if let Value::String(text) = &candidate {
        candidate = serde_json::from_str::<Value>(text)
            .ok()
            .unwrap_or_else(|| Value::Object(Map::new()));
    }
    if let Value::Object(_) = candidate {
        return candidate;
    }
    let mut fallback = Map::new();
    fallback.insert("type".to_string(), Value::String("object".to_string()));
    fallback.insert("properties".to_string(), Value::Object(Map::new()));
    fallback.insert("additionalProperties".to_string(), Value::Bool(true));
    Value::Object(fallback)
}

fn sanitize_lmstudio_tools(root: &mut Map<String, Value>) -> usize {
    let Some(raw_tools) = root.get("tools").and_then(|v| v.as_array()) else {
        return 0;
    };
    let mut normalized: Vec<Value> = Vec::new();
    for entry in raw_tools {
        let Some(tool_obj) = entry.as_object() else {
            continue;
        };
        let function_obj = tool_obj.get("function").and_then(|v| v.as_object());
        // LM Studio /v1/responses currently only accepts function tools.
        // - type missing: allow (legacy shorthand)
        // - type == "function": allow
        // - any other type OR non-string type: drop
        let allow_type = match tool_obj.get("type") {
            None => true,
            Some(value) => value
                .as_str()
                .map(|token| token.trim().eq_ignore_ascii_case("function"))
                .unwrap_or(false),
        };
        if !allow_type {
            continue;
        }
        let name = function_obj
            .and_then(|row| row.get("name"))
            .and_then(|v| v.as_str())
            .or_else(|| tool_obj.get("name").and_then(|v| v.as_str()))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let Some(name) = name else {
            continue;
        };

        let description = function_obj
            .and_then(|row| row.get("description"))
            .and_then(|v| v.as_str())
            .or_else(|| tool_obj.get("description").and_then(|v| v.as_str()))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let parameters = normalize_lmstudio_tool_parameters(
            function_obj
                .and_then(|row| row.get("parameters"))
                .or_else(|| tool_obj.get("parameters")),
        );
        let mut normalized_tool = Map::new();
        // NOTE:
        // LM Studio /v1/responses expects OpenAI Responses tool schema:
        //   { "type":"function", "name":"...", "parameters":{...}, "description":"..."? }
        // It rejects nested chat-style shape:
        //   { "type":"function", "function": { "name":"...", ... } }
        // with `tools.0.type invalid_string`.
        normalized_tool.insert("type".to_string(), Value::String("function".to_string()));
        normalized_tool.insert("name".to_string(), Value::String(name));
        if let Some(desc) = description {
            normalized_tool.insert("description".to_string(), Value::String(desc));
        }
        normalized_tool.insert("parameters".to_string(), parameters);
        normalized.push(Value::Object(normalized_tool));
    }
    if normalized.is_empty() {
        root.remove("tools");
        return 0;
    }
    root.insert("tools".to_string(), Value::Array(normalized));
    root.get("tools")
        .and_then(|v| v.as_array())
        .map(|v| v.len())
        .unwrap_or(0)
}

fn normalize_lmstudio_tool_choice(root: &mut Map<String, Value>) {
    let has_tools = root
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    if !has_tools {
        root.remove("tool_choice");
        return;
    }
    let Some(choice_value) = root.get("tool_choice").cloned() else {
        return;
    };
    if choice_value.is_object() {
        root.insert(
            "tool_choice".to_string(),
            Value::String("required".to_string()),
        );
        return;
    }
    if let Some(choice_str) = choice_value.as_str() {
        let lowered = choice_str.trim().to_ascii_lowercase();
        if lowered.is_empty() {
            root.insert("tool_choice".to_string(), Value::String("auto".to_string()));
            return;
        }
        root.insert("tool_choice".to_string(), Value::String(lowered));
    }
}
