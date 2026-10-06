// Gemini wire projection for Chat semantics that have a native equivalent.
//
// The gemini top-level whitelist is Gemini-shaped, while the inbound payload
// carries Chat semantics. Only fields with an exact Gemini equivalent are
// consumed here; the declared target whitelist owns unsupported fields.

pub(crate) fn build_v3_gemini_standard_request_from_chat_canonical_with_declarations(
    canonical: &Value,
    inverse: &crate::operation_runner::RequestInverseContext,
    current: &crate::operation_runner::CurrentFieldAssociations,
    model_capabilities: &[String],
) -> Result<(Value, Vec<V3ProjectionDropRecord>, Vec<crate::operation_runner::ToolMappingReference>), String> {
    use provider_compat_core::namespace_tools::{
        flatten_namespace_tool_for_provider_with_sources, namespace_tool_name_map,
    };
    let sources = provider_tool_declaration_sources(canonical)?;
    let hosted_emissions =
        crate::operation_runner::project_hosted_history_emissions(canonical, inverse, current)?;
    let mut hosted_by_message = std::collections::BTreeMap::new();
    for emission in hosted_emissions {
        hosted_by_message.insert(emission.canonical_message_index, emission);
    }
    let mut observer = StandardOutboundDeclarationObserver::new(inverse, current);
    let mut declarations = Vec::new();
    let mut names = std::collections::HashMap::new();
    let native_tools = crate::operation_runner::project_registered_native_gemini_tools(canonical, inverse, current)?;
    for (source_path, tool) in sources.into_iter().filter(|_| native_tools.is_none()) {
        if let Some(namespace_names) = namespace_tool_name_map(&tool)? {
            names.extend(namespace_names);
        }
        if let Some(projection) = flatten_namespace_tool_for_provider_with_sources("gemini", &tool)? {
            for (emission, flattened) in projection.sources.iter().zip(projection.tools) {
                let mut path = source_path.clone();
                for index in &emission.source_child_indices {
                    path.push_str(&format!(".tools[{index}]"));
                }
                emit_gemini_declaration(&flattened, &path, &mut declarations, &mut observer, canonical, inverse, current)?;
            }
        } else {
            emit_gemini_declaration(&tool, &source_path, &mut declarations, &mut observer, canonical, inverse, current)?;
        }
    }
    let mut source = crate::operation_runner::project_canonical_standard_view(canonical)?;
    let row = source.as_object_mut().ok_or("Gemini standard projection requires an object")?;
    if let Some(native) = row.get_mut("routecodex_chat_extension")
        .and_then(Value::as_object_mut).and_then(|extension| extension.remove("gemini_request")) {
        let native = native.as_object().ok_or("Gemini native extension requires an object")?;
        row.extend(native.iter().map(|(key, value)| (key.clone(), value.clone())));
    }
    let messages = row.remove("messages").ok_or("Gemini standard projection requires Chat messages")?;
    let messages = messages.as_array().ok_or("Gemini standard projection requires a message array")?;
    let mut contents = Vec::new();
    let mut system_parts = Vec::new();
    let mut calls = std::collections::HashMap::new();
    for message in messages {
        if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in tool_calls {
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    let function = call.get("function").or_else(|| call.get("custom"))
                        .ok_or("Gemini tool call requires a function or custom representation")?;
                    calls.insert(id.to_owned(), gemini_emitted_call_name(function, call, &names)?);
                }
            }
        }
    }
    for (message_index, message) in messages.iter().enumerate() {
        if matches!(message.get("type").and_then(Value::as_str), Some("additional_tools" | "tool_search_output")) {
            continue;
        }
        if let Some(emission) = hosted_by_message.get(&message_index) {
            let Some(name) = emission
                .chat_assistant
                .pointer("/tool_calls/0/function/name")
                .and_then(Value::as_str)
            else {
                continue;
            };
            let mut call = json!({"name": name, "args": emission.arguments});
            if !emission.identity.is_empty() {
                call["id"] = json!(emission.identity);
            }
            contents.push(json!({"role":"model","parts":[{"functionCall":call}]}));
            let mut response = json!({"name": name, "response": emission.event});
            if !emission.identity.is_empty() {
                response["id"] = json!(emission.identity);
            }
            contents.push(json!({"role":"user","parts":[{"functionResponse":response}]}));
            continue;
        }
        let role = message.get("role").and_then(Value::as_str).unwrap_or("user");
        let mut parts = Vec::new();
        if role == "tool" {
            let id = message.get("tool_call_id").and_then(Value::as_str);
            let name = id.and_then(|id| calls.get(id).cloned())
                .or_else(|| message.get("name").and_then(Value::as_str).map(str::to_owned))
                .ok_or("Gemini functionResponse requires its paired function name")?;
            let mut response = json!({"name":name,"response":message.get("content").cloned().unwrap_or(Value::Null)});
            if let Some(id) = id { response["id"] = json!(id); }
            let mut part = json!({"functionResponse":response});
            if inverse.entry_protocol == "gemini" {
                crate::operation_runner::restore_standard_projection_siblings(
                    &mut part, canonical, inverse, current,
                    &format!("chat.messages[{message_index}].tool_call_id"), 2,
                    &["functionResponse.id", "functionResponse.name", "functionResponse.response"],
                )?;
            }
            parts.push(part);
        } else {
            if let Some(content) = message.get("content").filter(|content| !content.is_null()) {
                let content_parts = gemini_standard_content_parts(content)?;
                for (part_index, mut part) in content_parts.into_iter().enumerate() {
                    let current_path = if content.is_string() {
                        format!("chat.messages[{message_index}].content")
                    } else {
                        format!("chat.messages[{message_index}].content[{part_index}]")
                    };
                    if matches!(role, "system" | "developer") && content.as_array()
                        .is_some_and(|parts| crate::operation_runner::is_unchanged_native_instruction_separator(
                            inverse, current, &current_path, &parts[part_index])) {
                        continue;
                    }
                    if inverse.entry_protocol == "gemini" {
                        crate::operation_runner::restore_standard_projection_siblings(
                            &mut part, canonical, inverse, current, &current_path, usize::from(content.is_string()),
                            &["text", "inlineData.data", "inlineData.mimeType", "fileData.fileUri", "fileData.mimeType"],
                        )?;
                    }
                    parts.push(part);
                }
            }
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for (call_index, call) in tool_calls.iter().enumerate() {
                    let function = call.get("function").or_else(|| call.get("custom"))
                        .ok_or("Gemini tool call requires a function or custom representation")?;
                    let name = gemini_emitted_call_name(function, call, &names)?;
                    let args = if call.get("type").and_then(Value::as_str) == Some("custom") {
                        json!({"input":function.get("input").cloned().unwrap_or(Value::Null)})
                    } else {
                        match function.get("arguments") {
                            Some(Value::String(arguments)) => serde_json::from_str(arguments)
                                .map_err(|error| format!("Gemini functionCall JSON arguments: {error}"))?,
                            Some(arguments) => arguments.clone(),
                            None => json!({}),
                        }
                    };
                    let mut projected = json!({"name":name,"args":args});
                    if let Some(id) = call.get("id").filter(|id| !id.is_null()) { projected["id"] = id.clone(); }
                    let mut part = json!({"functionCall":projected});
                    if inverse.entry_protocol == "gemini" {
                        crate::operation_runner::restore_standard_projection_siblings(
                            &mut part, canonical, inverse, current,
                            &format!("chat.messages[{message_index}].tool_calls[{call_index}].function.name"), 2,
                            &["functionCall.id", "functionCall.name", "functionCall.args"],
                        )?;
                    }
                    parts.push(part);
                }
            }
        }
        if matches!(role, "system" | "developer") {
            system_parts.extend(parts);
        } else if !parts.is_empty() {
            let mut content = json!({"role":if role == "assistant" {"model"} else {"user"},"parts":parts});
            if inverse.entry_protocol == "gemini" {
                crate::operation_runner::restore_standard_projection_siblings(
                    &mut content, canonical, inverse, current,
                    &format!("chat.messages[{message_index}]"), 0, &["role", "parts"],
                )?;
            }
            contents.push(content);
        }
    }
    row.insert("contents".into(), Value::Array(contents));
    if !system_parts.is_empty() {
        let mut instruction = json!({"parts":system_parts});
        crate::operation_runner::restore_standard_transform_siblings(
            &mut instruction, canonical, inverse, current,
            "v3.gemini_system_instruction_to_chat_system.v1", &["parts"],
        )?;
        row.insert("systemInstruction".into(), instruction);
    }
    row.remove("tools");
    let native_mappings = if let Some((tools, mappings)) = native_tools {
        row.insert("tools".into(), tools);
        Some(mappings)
    } else {
        if !declarations.is_empty() { row.insert("tools".into(), json!([{"functionDeclarations":declarations}])); }
        None
    };
    for (chat_field, gemini_field) in [
        ("temperature", "temperature"), ("top_p", "topP"), ("top_k", "topK"),
        ("max_tokens", "maxOutputTokens"), ("max_completion_tokens", "maxOutputTokens"),
        ("stop", "stopSequences"), ("seed", "seed"), ("n", "candidateCount"),
    ] {
        if let Some(mut value) = row.remove(chat_field) {
            if chat_field == "stop" && value.is_string() { value = json!([value]); }
            let config = row.entry("generationConfig").or_insert_with(|| json!({}))
                .as_object_mut().ok_or("Gemini generationConfig requires an object")?;
            config.insert(gemini_field.into(), value);
            if inverse.entry_protocol == "gemini" {
                crate::operation_runner::restore_standard_projection_siblings(
                    row.get_mut("generationConfig").expect("generation config just emitted"),
                    canonical, inverse, current, &format!("chat.{chat_field}"), 1,
                    &["temperature", "topP", "topK", "maxOutputTokens", "stopSequences", "seed", "candidateCount", "thinkingConfig"],
                )?;
            }
        }
    }
    // Gemini's selected wire model is carried by the transport URL.
    row.remove("model");
    let (payload, drops) = project_outbound_payload_for_selected_target_protocol_with_drops(
        &source, V3OutboundTargetProtocol::Gemini, model_capabilities,
    )?;
    Ok((payload, drops, native_mappings.unwrap_or_else(|| observer.into_mappings())))
}

fn emit_gemini_declaration(
    tool: &Value,
    source_path: &str,
    declarations: &mut Vec<Value>,
    observer: &mut StandardOutboundDeclarationObserver<'_>,
    canonical: &Value,
    inverse: &crate::operation_runner::RequestInverseContext,
    current: &crate::operation_runner::CurrentFieldAssociations,
) -> Result<(), String> {
    let function = tool.get("function").unwrap_or(tool);
    let Some(name) = function.get("name").and_then(Value::as_str) else {
        return Err(format!("Gemini function declaration has no name at {source_path}"));
    };
    let mut declaration = Map::new();
    declaration.insert("name".into(), json!(provider_compat_core::namespace_tools::normalize_provider_function_name(name)));
    for key in ["description", "parameters", "response", "responseJsonSchema", "behavior"] {
        if let Some(value) = function.get(key) { declaration.insert(key.into(), value.clone()); }
    }
    if tool.get("type").and_then(Value::as_str) == Some("custom") {
        declaration.insert("parameters".into(), provider_compat_core::namespace_tools::openai_chat_freeform_custom_tool_parameters());
    }
    let mut declaration = Value::Object(declaration);
    if inverse.entry_protocol == "gemini" {
        crate::operation_runner::restore_standard_projection_siblings(
            &mut declaration, canonical, inverse, current, source_path, 0,
            &["name", "description", "parameters", "parametersJsonSchema", "response", "responseJsonSchema", "behavior"],
        )?;
    }
    let destination = format!("tools[0].functionDeclarations[{}]", declarations.len());
    declarations.push(declaration.clone());
    observer.note_emitted_at(&destination, source_path, &declaration, None);
    Ok(())
}

fn gemini_emitted_call_name(
    function: &Value,
    call: &Value,
    names: &std::collections::HashMap<String, String>,
) -> Result<String, String> {
    let name = function.get("name").and_then(Value::as_str).ok_or("Gemini tool call requires a name")?;
    let namespace = call.get("namespace").or_else(|| function.get("namespace")).and_then(Value::as_str);
    let qualified = namespace.map(|namespace| format!("{namespace}.{name}")).unwrap_or_else(|| name.to_owned());
    Ok(names.get(&qualified).or_else(|| names.get(name)).cloned()
        .unwrap_or_else(|| provider_compat_core::namespace_tools::normalize_provider_function_name(&qualified)))
}

fn gemini_standard_content_parts(content: &Value) -> Result<Vec<Value>, String> {
    if let Some(text) = content.as_str() { return Ok(vec![json!({"text":text})]); }
    let parts = content.as_array().ok_or("Gemini message content requires text or parts")?;
    parts.iter().map(|part| {
        match part.get("type").and_then(Value::as_str) {
            Some("text" | "input_text" | "output_text") => Ok(json!({"text":part["text"]})),
            Some("media") => {
                let mut inline = json!({"data":part["media"]["inline_data"]});
                if let Some(mime) = part.pointer("/media/mime_type") { inline["mimeType"] = mime.clone(); }
                Ok(json!({"inlineData":inline}))
            }
            Some("image_url" | "input_image") => {
                let image = &part["image_url"];
                let url = image.as_str().or_else(|| image.get("url").and_then(Value::as_str))
                    .ok_or("Gemini image requires a URL")?;
                if let Some(data) = url.strip_prefix("data:") {
                    let (header, bytes) = data.split_once(',').ok_or("Gemini image data URL requires a comma")?;
                    let mime = header.strip_suffix(";base64").ok_or("Gemini inline image requires base64 data")?;
                    Ok(json!({"inlineData":{"mimeType":mime,"data":bytes}}))
                } else { Ok(json!({"fileData":{"fileUri":url}})) }
            }
            Some("file") => Ok(json!({"fileData":{"fileUri":part["file"]["file_url"],"mimeType":part["file"]["mime_type"]}})),
            _ => Ok(part.clone()),
        }
    }).collect()
}

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

fn consume_gemini_routecodex_chat_extension(row: &mut Map<String, Value>) -> Result<(), String> {
    let Some(extension) = row.remove("routecodex_chat_extension") else {
        return Ok(());
    };
    let mut extension = extension.as_object().cloned().ok_or_else(|| {
        "MalformedOutboundField target_protocol=gemini path=$.routecodex_chat_extension"
            .to_string()
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
