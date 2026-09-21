// Gemini wire projection for Chat semantics that have a native equivalent.
//
// The gemini top-level whitelist is Gemini-shaped, while the inbound payload
// carries Chat semantics. Fields with an exact Gemini equivalent are projected
// into generationConfig/toolConfig; fields with no exact equivalent are
// consumed here instead of failing the whole otherwise-valid request.

fn project_gemini_compatible_fields(source: &mut Value) -> Result<(), String> {
    let Some(row) = source.as_object_mut() else {
        return Ok(());
    };
    if let Some(effort) = row.remove("reasoning_effort") {
        project_gemini_reasoning_effort(row, effort);
    }
    if let Some(tool_choice) = row.remove("tool_choice") {
        project_gemini_tool_choice(row, tool_choice);
    }
    row.remove("parallel_tool_calls");
    row.remove("reasoning_summary_policy");
    row.remove("routecodex_chat_extension");
    Ok(())
}

fn project_gemini_reasoning_effort(row: &mut Map<String, Value>, effort: Value) {
    let Some(level) = effort
        .as_str()
        .map(str::trim)
        .filter(|value| matches!(*value, "minimal" | "low" | "medium" | "high"))
        .map(|value| value.to_ascii_uppercase())
    else {
        return;
    };
    let Some(generation_config) = row
        .entry("generationConfig".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return;
    };
    let Some(thinking_config) = generation_config
        .entry("thinkingConfig".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return;
    };
    thinking_config
        .entry("thinkingLevel".to_string())
        .or_insert(Value::String(level));
}

fn project_gemini_tool_choice(row: &mut Map<String, Value>, tool_choice: Value) {
    let (mode, allowed_names) = match tool_choice {
        Value::String(value) => (gemini_tool_choice_mode(&value), Vec::new()),
        Value::Object(object) => {
            let mode = object
                .get("type")
                .and_then(Value::as_str)
                .or_else(|| object.get("mode").and_then(Value::as_str))
                .and_then(gemini_tool_choice_mode);
            let mut names = object
                .get("allowed_function_names")
                .or_else(|| object.get("allowedFunctionNames"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if let Some(name) = object
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| {
                    object
                        .get("function")
                        .and_then(Value::as_object)
                        .and_then(|function| function.get("name"))
                        .and_then(Value::as_str)
                })
            {
                names.push(name.to_owned());
            }
            (mode, names)
        }
        _ => (None, Vec::new()),
    };
    let Some(mode) = mode else {
        return;
    };
    let Some(tool_config) = row
        .entry("toolConfig".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return;
    };
    let Some(function_calling_config) = tool_config
        .entry("functionCallingConfig".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return;
    };
    function_calling_config.insert("mode".to_string(), Value::String(mode));
    if !allowed_names.is_empty() {
        function_calling_config.insert(
            "allowedFunctionNames".to_string(),
            Value::Array(allowed_names.into_iter().map(Value::String).collect()),
        );
    }
}

fn gemini_tool_choice_mode(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "auto" => Some("AUTO".to_string()),
        "none" => Some("NONE".to_string()),
        "required" | "any" | "tool" | "function" => Some("ANY".to_string()),
        _ => None,
    }
}
