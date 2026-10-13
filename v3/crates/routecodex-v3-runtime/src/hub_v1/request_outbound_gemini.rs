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
    project_gemini_chat_request(source)?;
    let Some(row) = source.as_object_mut() else {
        return Ok(());
    };
    consume_gemini_routecodex_chat_extension(row)?;
    if let Some(effort) = row.remove("reasoning_effort") {
        project_gemini_reasoning_effort(row, effort)?;
    }
    if let Some(tool_choice) = row.remove("tool_choice") {
        project_gemini_tool_choice(row, tool_choice)?;
    }
    Ok(())
}

fn project_gemini_chat_request(source: &mut Value) -> Result<(), String> {
    use provider_compat_core::namespace_tools::{NamespaceToolIdentityRegistry, ToolKind};
    // Native Gemini input is already in its standard shape.
    if source.get("messages").is_none() {
        return Ok(());
    }
    let registry = NamespaceToolIdentityRegistry::from_request(source, "gemini")?;
    registry.project_references(source);
    let mut tools: Vec<Value> = source
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|tool| {
            !matches!(
                tool.get("type").and_then(Value::as_str),
                Some("namespace" | "function" | "custom")
            )
        })
        .cloned()
        .collect();
    let mut declarations = Vec::new();
    for identity in registry.identities() {
        let definition = identity.source.get("function").unwrap_or(&identity.source);
        let mut declaration = serde_json::Map::new();
        declaration.insert("name".into(), json!(identity.actual_wire_name));
        if let Some(description) = definition.get("description") {
            declaration.insert("description".into(), description.clone());
        }
        let parameters = match identity.kind {
            ToolKind::Function => definition.get("parameters").cloned(),
            ToolKind::Custom => Some(
                json!({"type":"object","properties":{"input":{"type":"string"}},"required":["input"]}),
            ),
        };
        if let Some(parameters) = parameters {
            declaration.insert("parameters".into(), parameters);
        }
        declarations.push(Value::Object(declaration));
    }
    let row = source
        .as_object_mut()
        .ok_or("Gemini request must be an object")?;
    let messages = row.remove("messages").unwrap();
    let messages = messages
        .as_array()
        .ok_or("Chat messages must be an array")?;
    let mut contents = Vec::new();
    let mut system_parts = Vec::new();
    let mut call_names = std::collections::HashMap::<String, String>::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let mut parts = Vec::new();
        match message.get("content") {
            Some(Value::String(text)) if !text.is_empty() => parts.push(json!({"text":text})),
            Some(Value::Array(content)) => {
                for part in content {
                    match part.get("type").and_then(Value::as_str) {
                        Some("text" | "input_text" | "output_text") => {
                            let mut part = part.clone();
                            part.as_object_mut().unwrap().remove("type");
                            parts.push(part);
                        }
                        _ => parts.push(part.clone()),
                    }
                }
            }
            _ => {}
        }
        for call in message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let function = call.get("function").unwrap_or(call);
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .ok_or("Chat function call requires a name")?;
            let id = call.get("id").and_then(Value::as_str);
            if let Some(id) = id {
                call_names.insert(id.into(), name.into());
            }
            let args = match function.get("arguments") {
                Some(Value::String(text)) => {
                    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.clone()))
                }
                Some(value) => value.clone(),
                None => json!({}),
            };
            let mut native = json!({"name":name,"args":args});
            if let Some(id) = id {
                native["id"] = json!(id);
            }
            let mut part = json!({"functionCall":native});
            if let Some(signature) = call.get("thought_signature") {
                part["thoughtSignature"] = signature.clone();
            }
            parts.push(part);
        }
        if role == "tool" {
            let id = message.get("tool_call_id").and_then(Value::as_str);
            let name = id
                .and_then(|id| call_names.get(id).map(String::as_str))
                .or_else(|| message.get("name").and_then(Value::as_str))
                .ok_or("Gemini tool response requires its paired function call name")?;
            let content = message.get("content").cloned().unwrap_or(Value::Null);
            let mut native = json!({"name":name,"response":{"output":content}});
            if let Some(id) = id {
                native["id"] = json!(id);
            }
            parts = vec![json!({"functionResponse":native})];
        }
        if matches!(role, "system" | "developer") {
            system_parts.extend(parts);
        } else if !parts.is_empty() {
            contents
                .push(json!({"role":if role == "assistant" {"model"} else {"user"},"parts":parts}));
        }
    }
    row.insert("contents".into(), Value::Array(contents));
    if !system_parts.is_empty() {
        row.insert("systemInstruction".into(), json!({"parts":system_parts}));
    }
    if !declarations.is_empty() {
        tools.push(json!({"functionDeclarations":declarations}));
    }
    if !tools.is_empty() {
        row.insert("tools".into(), Value::Array(tools));
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
    let value = value
        .as_str()
        .map(str::trim)
        .ok_or_else(|| format!("MalformedOutboundField target_protocol=gemini path={path}"))?;
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

fn consume_gemini_routecodex_chat_extension(row: &mut Map<String, Value>) -> Result<(), String> {
    let Some(extension) = row.remove("routecodex_chat_extension") else {
        return Ok(());
    };
    let mut extension = extension.as_object().cloned().ok_or_else(|| {
        "MalformedOutboundField target_protocol=gemini path=$.routecodex_chat_extension".to_string()
    })?;
    let Some(responses_request) = extension.remove("responses_request") else {
        if extension.is_empty() {
            return Ok(());
        }
        return Err(format!(
            "UnmappedOutboundFields target_protocol=gemini paths={}",
            extension
                .keys()
                .map(|key| json_path_child("$.routecodex_chat_extension", key))
                .collect::<Vec<_>>()
                .join(",")
        ));
    };
    let mut responses_request = responses_request.as_object().cloned().ok_or_else(|| {
        "MalformedOutboundField target_protocol=gemini path=$.routecodex_chat_extension.responses_request"
            .to_string()
    })?;
    consume_gemini_responses_store(&mut responses_request)?;
    let mut unsupported: Vec<String> = responses_request
        .keys()
        .map(|key| json_path_child("$.routecodex_chat_extension.responses_request", key))
        .collect();
    unsupported.extend(
        extension
            .keys()
            .map(|key| json_path_child("$.routecodex_chat_extension", key)),
    );
    if !unsupported.is_empty() {
        return Err(format!(
            "UnmappedOutboundFields target_protocol=gemini paths={}",
            unsupported.join(",")
        ));
    }
    Ok(())
}

fn consume_gemini_responses_store(row: &mut Map<String, Value>) -> Result<(), String> {
    let Some(value) = row.remove("store") else {
        return Ok(());
    };
    match value.as_bool() {
        Some(false) => Ok(()),
        Some(true) => Err(
            "UnmappedOutboundFields target_protocol=gemini paths=$.routecodex_chat_extension.responses_request.store"
                .to_string(),
        ),
        None => Err(
            "MalformedOutboundField target_protocol=gemini path=$.routecodex_chat_extension.responses_request.store"
                .to_string(),
        ),
    }
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
                    collect_gemini_allowed_function_names(value, &format!("$.tool_choice.{key}"))
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
                names.push(gemini_nonempty_string(name, "$.tool_choice.function.name")?);
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
        return Err(
            "UnmappedOutboundFields target_protocol=gemini paths=$.tool_choice".to_string(),
        );
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
            "type"
                | "mode"
                | "allowed_function_names"
                | "allowedFunctionNames"
                | "name"
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

fn collect_gemini_allowed_function_names(value: &Value, path: &str) -> Result<Vec<String>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("MalformedOutboundField target_protocol=gemini path={path}"))?;
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
