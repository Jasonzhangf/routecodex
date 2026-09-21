// Gemini wire projection for Chat semantics that have a native equivalent.
//
// The gemini top-level whitelist is Gemini-shaped, while the inbound payload
// carries Chat semantics. Only fields with an exact Gemini equivalent are
// consumed here; target-unsupported semantics fail before provider wire build.

fn project_gemini_compatible_fields(source: &mut Value) -> Result<(), String> {
    project_gemini_compatible_fields_inner(source)
}

fn project_gemini_compatible_fields_for_selected_target(
    source: &mut Value,
    model_capabilities: &[String],
) -> Result<(), String> {
    validate_gemini_thinking_config_for_selected_target(source, model_capabilities)?;
    project_gemini_compatible_fields_inner(source)
}

fn project_gemini_compatible_fields_inner(source: &mut Value) -> Result<(), String> {
    let extension_paths = collect_gemini_routecodex_chat_extension_paths(source)?;
    let Some(row) = source.as_object_mut() else {
        return Ok(());
    };
    let mut unsupported = Vec::new();
    if row.contains_key("parallel_tool_calls") {
        unsupported.push("$.parallel_tool_calls".to_string());
    }
    if row.contains_key("reasoning_summary_policy") {
        unsupported.push("$.reasoning_summary_policy".to_string());
    }
    unsupported.extend(extension_paths);
    if !unsupported.is_empty() {
        return Err(format!(
            "UnmappedOutboundFields target_protocol=gemini paths={}",
            unsupported.join(",")
        ));
    }
    row.remove("routecodex_chat_extension");
    if let Some(effort) = row.remove("reasoning_effort") {
        project_gemini_reasoning_effort(row, effort)?;
    }
    if let Some(tool_choice) = row.remove("tool_choice") {
        project_gemini_tool_choice(row, tool_choice)?;
    }
    Ok(())
}

fn validate_gemini_thinking_config_for_selected_target(
    source: &Value,
    model_capabilities: &[String],
) -> Result<(), String> {
    let mut requested_paths = Vec::new();
    if source.get("reasoning_effort").is_some() {
        requested_paths.push("$.reasoning_effort".to_string());
    }
    if let Some(level) = source.pointer("/generationConfig/thinkingConfig/thinkingLevel") {
        validate_gemini_thinking_level_value(
            level,
            "$.generationConfig.thinkingConfig.thinkingLevel",
        )?;
        requested_paths.push("$.generationConfig.thinkingConfig.thinkingLevel".to_string());
    }
    if let Some(budget) = source.pointer("/generationConfig/thinkingConfig/thinkingBudget") {
        if budget.as_u64().is_none() {
            return Err(
                "MalformedOutboundField target_protocol=gemini path=$.generationConfig.thinkingConfig.thinkingBudget"
                    .to_string(),
            );
        }
        requested_paths.push("$.generationConfig.thinkingConfig.thinkingBudget".to_string());
    }
    if requested_paths.is_empty() || gemini_selected_target_supports_reasoning(model_capabilities) {
        return Ok(());
    }
    Err(format!(
        "UnmappedOutboundFields target_protocol=gemini paths={} missing_capability=reasoning",
        requested_paths.join(",")
    ))
}

fn validate_gemini_thinking_level_value(value: &Value, path: &str) -> Result<(), String> {
    let value = value.as_str().map(str::trim).ok_or_else(|| {
        format!("MalformedOutboundField target_protocol=gemini path={path}")
    })?;
    match value.to_ascii_lowercase().as_str() {
        "minimal" | "low" | "medium" | "high" => Ok(()),
        _ => Err(format!(
            "UnmappedOutboundFields target_protocol=gemini paths={path}"
        )),
    }
}

fn gemini_selected_target_supports_reasoning(model_capabilities: &[String]) -> bool {
    model_capabilities
        .iter()
        .map(|capability| capability.trim())
        .any(|capability| capability == "reasoning" || capability == "thinking")
}

fn collect_gemini_routecodex_chat_extension_paths(source: &Value) -> Result<Vec<String>, String> {
    let Some(extension) = source
        .as_object()
        .and_then(|row| row.get("routecodex_chat_extension"))
    else {
        return Ok(Vec::new());
    };
    gemini_chat_extension_unmapped_paths(extension, "$.routecodex_chat_extension")
}

fn gemini_chat_extension_unmapped_paths(
    extension: &Value,
    path: &str,
) -> Result<Vec<String>, String> {
    let extension = extension.as_object().ok_or_else(|| {
        format!("MalformedOutboundField target_protocol=gemini path={path}")
    })?;
    let mut paths = Vec::new();
    for (key, value) in extension {
        let child_path = json_path_child(path, key);
        if key == "responses_request" {
            let responses_request = value.as_object().ok_or_else(|| {
                format!("MalformedOutboundField target_protocol=gemini path={child_path}")
            })?;
            paths.extend(
                responses_request
                    .keys()
                    .map(|key| json_path_child(&child_path, key)),
            );
        } else {
            paths.push(child_path);
        }
    }
    Ok(paths)
}

fn project_gemini_reasoning_effort(
    row: &mut Map<String, Value>,
    effort: Value,
) -> Result<(), String> {
    let value = effort.as_str().map(str::trim).ok_or_else(|| {
        "MalformedOutboundField target_protocol=gemini path=$.reasoning_effort".to_string()
    })?;
    let level = match value {
        "minimal" | "low" | "medium" | "high" => value.to_ascii_uppercase(),
        _ => {
            return Err(
                "UnmappedOutboundFields target_protocol=gemini paths=$.reasoning_effort"
                    .to_string(),
            );
        }
    };
    let Some(generation_config) = row
        .entry("generationConfig".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return Err(
            "MalformedOutboundField target_protocol=gemini path=$.generationConfig".to_string(),
        );
    };
    let Some(thinking_config) = generation_config
        .entry("thinkingConfig".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return Err(
            "MalformedOutboundField target_protocol=gemini path=$.generationConfig.thinkingConfig"
                .to_string(),
        );
    };
    thinking_config.insert("thinkingLevel".to_string(), Value::String(level));
    Ok(())
}

fn project_gemini_tool_choice(
    row: &mut Map<String, Value>,
    tool_choice: Value,
) -> Result<(), String> {
    let (mode, allowed_names) = match tool_choice {
        Value::String(value) => (gemini_tool_choice_mode(&value), Vec::new()),
        Value::Object(object) => {
            validate_gemini_tool_choice_object_shape(&object)?;
            let mode = object
                .get("type")
                .and_then(Value::as_str)
                .or_else(|| object.get("mode").and_then(Value::as_str))
                .and_then(gemini_tool_choice_mode);
            let allowed_names = object
                .get("allowed_function_names")
                .map(|value| ("allowed_function_names", value))
                .or_else(|| {
                    object
                        .get("allowedFunctionNames")
                        .map(|value| ("allowedFunctionNames", value))
                });
            let mut names = allowed_names
                .map(|(key, value)| {
                    collect_gemini_allowed_function_names(
                        value,
                        &format!("$.tool_choice.{key}"),
                    )
                })
                .transpose()?
                .unwrap_or_default();
            if let Some(name) = object.get("name") {
                names.push(gemini_nonempty_string(name, "$.tool_choice.name")?);
            } else if let Some(function) = object.get("function") {
                let function = function.as_object().ok_or_else(|| {
                    "MalformedOutboundField target_protocol=gemini path=$.tool_choice.function"
                        .to_string()
                })?;
                let name = function.get("name").ok_or_else(|| {
                    "MalformedOutboundField target_protocol=gemini path=$.tool_choice.function.name"
                        .to_string()
                })?;
                names.push(gemini_nonempty_string(
                    name,
                    "$.tool_choice.function.name",
                )?);
            }
            (mode, names)
        }
        _ => {
            return Err(
                "MalformedOutboundField target_protocol=gemini path=$.tool_choice".to_string(),
            );
        }
    };
    let Some(mode) = mode else {
        return Err("UnmappedOutboundFields target_protocol=gemini paths=$.tool_choice".to_string());
    };
    let Some(tool_config) = row
        .entry("toolConfig".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return Err("MalformedOutboundField target_protocol=gemini path=$.toolConfig".to_string());
    };
    let Some(function_calling_config) = tool_config
        .entry("functionCallingConfig".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return Err(
            "MalformedOutboundField target_protocol=gemini path=$.toolConfig.functionCallingConfig"
                .to_string(),
        );
    };
    function_calling_config.insert("mode".to_string(), Value::String(mode));
    if !allowed_names.is_empty() {
        function_calling_config.insert(
            "allowedFunctionNames".to_string(),
            Value::Array(allowed_names.into_iter().map(Value::String).collect()),
        );
    }
    Ok(())
}

fn validate_gemini_tool_choice_object_shape(object: &Map<String, Value>) -> Result<(), String> {
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "type" | "mode" | "allowed_function_names" | "allowedFunctionNames" | "name"
                | "function"
        ) {
            return Err(format!(
                "UnmappedOutboundFields target_protocol=gemini paths=$.tool_choice.{key}"
            ));
        }
    }
    if let Some(function) = object.get("function").and_then(Value::as_object) {
        for key in function.keys() {
            if key != "name" {
                return Err(format!(
                    "UnmappedOutboundFields target_protocol=gemini paths=$.tool_choice.function.{key}"
                ));
            }
        }
    }
    Ok(())
}

fn collect_gemini_allowed_function_names(
    value: &Value,
    path: &str,
) -> Result<Vec<String>, String> {
    let values = value.as_array().ok_or_else(|| {
        format!("MalformedOutboundField target_protocol=gemini path={path}")
    })?;
    values
        .iter()
        .enumerate()
        .map(|(index, value)| gemini_nonempty_string(value, &format!("{path}[{index}]")))
        .collect()
}

fn gemini_nonempty_string(value: &Value, path: &str) -> Result<String, String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("MalformedOutboundField target_protocol=gemini path={path}"))
}

fn gemini_tool_choice_mode(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "auto" => Some("AUTO".to_string()),
        "none" => Some("NONE".to_string()),
        "required" | "any" | "tool" | "function" => Some("ANY".to_string()),
        _ => None,
    }
}
