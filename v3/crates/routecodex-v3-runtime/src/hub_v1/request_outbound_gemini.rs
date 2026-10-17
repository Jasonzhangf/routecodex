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
    let native_request = take_gemini_native_request_record(source)?;
    let governed_tools = source.get("tools").cloned();
    project_gemini_chat_request_with_governed_tools(source)?;
    let Some(row) = source.as_object_mut() else {
        return Ok(());
    };
    if let Some(effort) = row.remove("reasoning_effort") {
        project_gemini_reasoning_effort(row, effort)?;
    }
    if let Some(tool_choice) = row.remove("tool_choice") {
        project_gemini_tool_choice(row, tool_choice)?;
    }
    if let Some(native_request) = native_request {
        restore_gemini_native_request(row, native_request, governed_tools.as_ref())?;
    }
    consume_gemini_routecodex_chat_extension(row)?;
    Ok(())
}

fn take_gemini_native_request_record(source: &mut Value) -> Result<Option<Value>, String> {
    let Some(row) = source.as_object_mut() else {
        return Ok(None);
    };
    let Some(extension) = row
        .get_mut("routecodex_chat_extension")
        .and_then(Value::as_object_mut)
    else {
        return Ok(None);
    };
    let Some(records) = extension.remove("gemini_native_fields") else {
        return Ok(None);
    };
    if extension.is_empty() {
        row.remove("routecodex_chat_extension");
    }
    let records = records.as_array().ok_or_else(|| {
        "MalformedOutboundField target_protocol=gemini path=$.routecodex_chat_extension.gemini_native_fields"
            .to_string()
    })?;
    let mut request_record = None;
    for record in records {
        if record.get("kind").and_then(Value::as_str) == Some("request") {
            request_record = Some(record.clone());
        }
    }
    Ok(request_record)
}

fn project_gemini_chat_request(source: &mut Value) -> Result<(), String> {
    project_gemini_chat_request_with_governed_tools(source)
}

fn project_gemini_chat_request_with_governed_tools(source: &mut Value) -> Result<(), String> {
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
    if messages.iter().any(gemini_message_has_native_association) {
        project_gemini_native_messages(messages, &mut contents, &mut system_parts)?;
    } else {
        project_gemini_generic_messages(messages, &mut contents, &mut system_parts)?;
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

fn gemini_message_has_native_association(message: &Value) -> bool {
    if message
        .pointer("/routecodex_chat_extension/gemini_native_fields")
        .and_then(Value::as_array)
        .is_some_and(|records| !records.is_empty())
    {
        return true;
    }
    let content_has_record = message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|part| {
            part.pointer("/routecodex_chat_extension/gemini_native_fields")
                .and_then(Value::as_array)
                .is_some_and(|records| !records.is_empty())
        });
    content_has_record
        || message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|call| {
                call.pointer("/routecodex_chat_extension/gemini_native_fields")
                    .and_then(Value::as_array)
                    .is_some_and(|records| !records.is_empty())
            })
}

#[derive(Default)]
struct GeminiNativeContent {
    content_index: usize,
    role: String,
    role_present: bool,
    fields: Map<String, Value>,
    parts: Vec<(usize, Value)>,
}

fn project_gemini_native_messages(
    messages: &[Value],
    contents: &mut Vec<Value>,
    system_parts: &mut Vec<Value>,
) -> Result<(), String> {
    let mut call_names = std::collections::HashMap::<String, String>::new();
    for message in messages {
        for call in message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let function = call.get("function").unwrap_or(call);
            if let (Some(id), Some(name)) = (
                call.get("id").and_then(Value::as_str),
                function.get("name").and_then(Value::as_str),
            ) {
                call_names.insert(id.to_string(), name.to_string());
            }
        }
    }

    let mut native_contents = Vec::<GeminiNativeContent>::new();
    for (message_index, message) in messages.iter().enumerate() {
        let Some(mut message_row) = message.as_object().cloned() else {
            return Err("Chat message must be an object".to_string());
        };
        let role = message_row
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user").to_owned();
        let mut records = take_gemini_native_records(&mut message_row)?;
        let container = records
            .iter()
            .position(|record| record.get("part_index").is_none())
            .map(|index| records.remove(index));
        let content_index = container
            .as_ref()
            .and_then(|record| record.get("content_index"))
            .and_then(Value::as_u64)
            .map(|index| index as usize)
            .unwrap_or(message_index);
        let native_role = if role == "assistant" { "model" } else { "user" };

        if role == "tool" {
            let (part_index, function_response) = project_gemini_native_function_response(
                &message_row,
                content_index,
                &records,
                &call_names,
            )?;
            add_gemini_native_content_part(
                &mut native_contents,
                content_index,
                native_role,
                container.as_ref().and_then(|record| record.get("role_present")).and_then(Value::as_bool).unwrap_or(false),
                container.as_ref().and_then(|record| record.get("fields")).and_then(Value::as_object).cloned().unwrap_or_default(),
                (part_index, function_response),
            );
            continue;
        }

        let mut parts = Vec::<(usize, Value)>::new();
        if let Some(content) = message_row.get("content").and_then(Value::as_array) {
            for (part_index, part) in content.iter().enumerate() {
                let mut part = part.clone();
                let record = take_gemini_native_record(&mut part)?;
                let (source_index, native_part) = match record {
                    Some(record) => {
                        let source_index = record
                            .get("part_index")
                            .and_then(Value::as_u64)
                            .map(|index| index as usize)
                            .unwrap_or(part_index);
                        (source_index, project_gemini_native_part(&part, &record)?)
                    }
                    None => (part_index, project_gemini_generic_part(&part)?),
                };
                parts.push((source_index, native_part));
            }
        } else if let Some(text) = message_row.get("content").and_then(Value::as_str) {
            if !text.is_empty() {
                parts.push((0, json!({"text": text})));
            }
        }
        for (call_index, call) in message_row
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let mut call = call.clone();
            let record = take_gemini_native_record(&mut call)?;
            let (source_index, native_part) = match record {
                Some(record) => {
                    let source_index = record
                        .get("part_index")
                        .and_then(Value::as_u64)
                        .map(|index| index as usize)
                        .unwrap_or(call_index);
                    (source_index, project_gemini_native_part(&call, &record)?)
                }
                None => (call_index, project_gemini_generic_tool_call(&call)?),
            };
            parts.push((source_index, native_part));
        }
        for record in records {
            let source_index = record
                .get("part_index")
                .and_then(Value::as_u64)
                .map(|index| index as usize)
                .unwrap_or(parts.len());
            let fields = record
                .get("fields")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            parts.push((source_index, Value::Object(fields)));
        }
        parts.sort_by_key(|(index, _)| *index);

        let (role_present, fields) = container
            .as_ref()
            .map(|record| {
                (
                    record
                        .get("role_present")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    record
                        .get("fields")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default(),
                )
            })
            .unwrap_or((true, Map::new()));
        if matches!(role.as_str(), "system" | "developer") {
            system_parts.extend(parts.into_iter().map(|(_, part)| part));
        } else if !parts.is_empty() {
            let content = add_gemini_native_content(
                &mut native_contents,
                content_index,
                native_role,
                role_present,
                fields,
            );
            content.parts.extend(parts);
        }
    }

    native_contents.sort_by_key(|content| content.content_index);
    for mut content in native_contents {
        content.parts.sort_by_key(|(index, _)| *index);
        let mut wire = content.fields;
        if content.role_present {
            wire.insert("role".to_string(), Value::String(content.role));
        }
        wire.insert(
            "parts".to_string(),
            Value::Array(content.parts.into_iter().map(|(_, part)| part).collect()),
        );
        contents.push(Value::Object(wire));
    }
    Ok(())
}

fn add_gemini_native_content_part(
    contents: &mut Vec<GeminiNativeContent>,
    content_index: usize,
    role: &str,
    role_present: bool,
    fields: Map<String, Value>,
    part: (usize, Value),
) {
    add_gemini_native_content(contents, content_index, role, role_present, fields)
        .parts
        .push(part);
}

fn add_gemini_native_content<'a>(
    contents: &'a mut Vec<GeminiNativeContent>,
    content_index: usize,
    role: &str,
    role_present: bool,
    fields: Map<String, Value>,
) -> &'a mut GeminiNativeContent {
    if let Some(index) = contents
        .iter()
        .position(|content| content.content_index == content_index)
    {
        return &mut contents[index];
    }
    contents.push(GeminiNativeContent {
        content_index,
        role: role.to_string(),
        role_present,
        fields,
        parts: Vec::new(),
    });
    contents.last_mut().expect("native content was just inserted")
}

fn project_gemini_native_function_response(
    message: &Map<String, Value>,
    content_index: usize,
    records: &[Value],
    call_names: &std::collections::HashMap<String, String>,
) -> Result<(usize, Value), String> {
    let record = records
        .iter()
        .find(|record| {
            record
                .get("fields")
                .and_then(|fields| fields.get("functionResponse"))
                .is_some()
        })
        .ok_or_else(|| "Gemini tool response requires a native association".to_string())?;
    let part_index = record
        .get("part_index")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let mut part = record
        .get("fields")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    apply_gemini_part_bindings(&mut part, &Value::Object(message.clone()), record)?;
    let function_response = part
        .entry("functionResponse".to_string())
        .or_insert_with(|| json!({}));
    let function_response = function_response
        .as_object_mut()
        .ok_or_else(|| "Gemini functionResponse must be an object".to_string())?;
    if function_response.get("name").is_none() {
        if let Some(name) = message
            .get("tool_call_id")
            .and_then(Value::as_str)
            .and_then(|id| call_names.get(id))
        {
            function_response.insert("name".to_string(), Value::String(name.clone()));
        }
    }
    let mut nested = Vec::<(usize, Value)>::new();
    if let Some(content) = message.get("content").and_then(Value::as_array) {
        for part in content {
            let mut part = part.clone();
            let Some(record) = take_gemini_native_record(&mut part)? else {
                continue;
            };
            let Some(nested_index) = record.get("nested_part_index").and_then(Value::as_u64) else {
                continue;
            };
            nested.push((
                nested_index as usize,
                project_gemini_native_part(&part, &record)?,
            ));
        }
    }
    if !nested.is_empty() {
        nested.sort_by_key(|(index, _)| *index);
        function_response.insert(
            "parts".to_string(),
            Value::Array(nested.into_iter().map(|(_, part)| part).collect()),
        );
    } else if record
        .get("containers")
        .and_then(Value::as_array)
        .is_some_and(|containers| {
            containers.iter().any(|container| {
                container.get("source_path")
                    == Some(&json!(["functionResponse", "parts"]))
                    && container.get("empty").and_then(Value::as_bool) == Some(true)
            })
        })
    {
        function_response.insert("parts".to_string(), json!([]));
    }
    Ok((part_index, Value::Object(part)))
}

fn project_gemini_native_part(canonical: &Value, record: &Value) -> Result<Value, String> {
    let mut part = record
        .get("fields")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    apply_gemini_part_bindings(&mut part, canonical, record)?;
    Ok(Value::Object(part))
}

fn project_gemini_generic_part(part: &Value) -> Result<Value, String> {
    let mut part = part
        .as_object()
        .cloned()
        .ok_or_else(|| "Gemini canonical content part must be an object".to_string())?;
    part.remove("type");
    part.remove("routecodex_chat_extension");
    Ok(Value::Object(part))
}

fn project_gemini_generic_tool_call(call: &Value) -> Result<Value, String> {
    let function = call.get("function").unwrap_or(call);
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .ok_or("Chat function call requires a name")?;
    let id = call.get("id").and_then(Value::as_str);
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
    Ok(part)
}

fn project_gemini_generic_messages(
    messages: &[Value],
    contents: &mut Vec<Value>,
    system_parts: &mut Vec<Value>,
) -> Result<(), String> {
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
                    parts.push(project_gemini_generic_part(part)?);
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
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                call_names.insert(id.into(), name.into());
            }
            parts.push(project_gemini_generic_tool_call(call)?);
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
    Ok(())
}

fn take_gemini_native_records(row: &mut Map<String, Value>) -> Result<Vec<Value>, String> {
    let Some(extension) = row
        .get_mut("routecodex_chat_extension")
        .and_then(Value::as_object_mut)
    else {
        return Ok(Vec::new());
    };
    let records = extension
        .remove("gemini_native_fields")
        .and_then(|records| records.as_array().cloned())
        .unwrap_or_default();
    if extension.is_empty() {
        row.remove("routecodex_chat_extension");
    }
    Ok(records)
}

fn take_gemini_native_record(row: &mut Value) -> Result<Option<Value>, String> {
    let Some(row) = row.as_object_mut() else {
        return Ok(None);
    };
    Ok(take_gemini_native_records(row)?.into_iter().next())
}

fn restore_gemini_native_request(
    row: &mut Map<String, Value>,
    record: Value,
    governed_tools: Option<&Value>,
) -> Result<(), String> {
    let record = record.as_object().ok_or_else(|| {
        "MalformedOutboundField target_protocol=gemini path=$.routecodex_chat_extension.gemini_native_fields[0]"
            .to_string()
    })?;
    if let Some(fields) = record.get("fields").and_then(Value::as_object) {
        for (key, value) in fields {
            if matches!(key.as_str(), "tools" | "toolConfig" | "generationConfig") {
                continue;
            }
            let target = row.entry(key.clone()).or_insert_with(|| value.clone());
            merge_gemini_missing(target, value);
        }
    }

    let request_fields = record.get("fields").and_then(Value::as_object);
    if let Some(tools) = request_fields
        .and_then(|fields| fields.get("tools"))
        .and_then(Value::as_array)
    {
        let projected_tools = governed_tools
            .or_else(|| row.get("tools"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut restored_tools = Vec::new();
        for association in tools {
            let Some(association) = association.as_object() else {
                continue;
            };
            let canonical_index = association
                .get("canonical_index")
                .and_then(Value::as_u64)
                .map(|index| index as usize);
            let projected = canonical_index
                .and_then(|index| projected_tools.get(index))
                .or_else(|| association.get("native"));
            if let Some(projected) = projected {
                let mut declaration = projected.clone();
                apply_gemini_native_bindings(&mut declaration, association)?;
                if association
                    .get("parameters_json_schema_present")
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    if let Some(parameters) = declaration.pointer("/function/parameters").cloned() {
                        if let Some(function) = declaration.get_mut("function").and_then(Value::as_object_mut) {
                            function.insert("parametersJsonSchema".to_string(), parameters);
                            function.remove("parameters");
                        }
                    }
                }
                if let Some(declaration_index) = association.get("declaration_index") {
                    let declaration_index = declaration_index.as_u64().unwrap_or(0) as usize;
                    let function = declaration.get("function").cloned().unwrap_or(declaration);
                    let mut entry = function;
                    if let Some(fields) = association.get("fields").and_then(Value::as_object) {
                        let Some(entry) = entry.as_object_mut() else { continue };
                        for (key, value) in fields {
                            entry.entry(key.clone()).or_insert_with(|| value.clone());
                        }
                    }
                    let tool_index = association.get("tool_index").and_then(Value::as_u64).unwrap_or(0) as usize;
                    while restored_tools.len() <= tool_index {
                        restored_tools.push(json!({}));
                    }
                    if let Some(tool_fields) = association.get("tool_fields").and_then(Value::as_object) {
                        let tool = restored_tools[tool_index].as_object_mut().unwrap();
                        for (key, value) in tool_fields {
                            if key != "functionDeclarations" {
                                tool.entry(key.clone()).or_insert_with(|| value.clone());
                            }
                        }
                    }
                    let tool = restored_tools[tool_index].as_object_mut().unwrap();
                    let declarations = tool.entry("functionDeclarations").or_insert_with(|| json!([]));
                    let declarations = declarations.as_array_mut().unwrap();
                    while declarations.len() <= declaration_index {
                        declarations.push(Value::Null);
                    }
                    declarations[declaration_index] = entry;
                }
            }
        }
        if !restored_tools.is_empty() {
            row.insert("tools".to_string(), Value::Array(restored_tools));
        }
    }

    if let Some(tool_config) = request_fields.and_then(|fields| fields.get("toolConfig")) {
        let target = row
            .entry("toolConfig".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        merge_gemini_missing(target, tool_config);
    }
    if let Some(generation) = request_fields
        .and_then(|fields| fields.get("generationConfig"))
        .and_then(Value::as_object)
    {
        let mut mapped = Map::new();
        for (canonical, native) in [
            ("temperature", "temperature"),
            ("top_p", "topP"),
            ("top_k", "topK"),
            ("max_completion_tokens", "maxOutputTokens"),
            ("stop", "stopSequences"),
            ("frequency_penalty", "frequencyPenalty"),
            ("presence_penalty", "presencePenalty"),
            ("logprobs", "responseLogprobs"),
            ("top_logprobs", "logprobs"),
            ("seed", "seed"),
        ] {
            if let Some(value) = row.remove(canonical) {
                mapped.insert(native.to_string(), value);
            }
        }
        let mut thinking = Map::new();
        for (canonical, native) in [
            ("reasoning_include_thoughts", "includeThoughts"),
            ("reasoning_budget_tokens", "thinkingBudget"),
            ("reasoning_effort", "thinkingLevel"),
        ] {
            if let Some(value) = row.remove(canonical) {
                thinking.insert(native.to_string(), value);
            }
        }
        row.remove("reasoning_thinking_mode");
        let generation_config = row
            .entry("generationConfig".to_string())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or("Gemini generationConfig must remain an object")?;
        generation_config.extend(mapped);
        for (key, value) in generation {
            match key.as_str() {
                "thinkingConfig" => {
                    let residual = value.as_object().ok_or(
                        "MalformedOutboundField target_protocol=gemini path=$.generationConfig.thinkingConfig",
                    )?;
                    let thinking_config = generation_config
                        .entry("thinkingConfig".to_string())
                        .or_insert_with(|| Value::Object(Map::new()))
                        .as_object_mut()
                        .ok_or(
                            "MalformedOutboundField target_protocol=gemini path=$.generationConfig.thinkingConfig",
                        )?;
                    for (residual_key, residual_value) in residual {
                        thinking_config
                            .entry(residual_key.clone())
                            .or_insert_with(|| residual_value.clone());
                    }
                }
                _ => {
                    generation_config
                        .entry(key.clone())
                        .or_insert_with(|| value.clone());
                }
            }
        }
        if !thinking.is_empty() {
            let thinking_config = generation_config
                .entry("thinkingConfig".to_string())
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or(
                    "MalformedOutboundField target_protocol=gemini path=$.generationConfig.thinkingConfig",
                )?;
            for (key, value) in thinking {
                thinking_config.insert(key, value);
            }
        }
    }
    Ok(())
}

fn merge_gemini_missing(target: &mut Value, residual: &Value) {
    let (Some(target), Some(residual)) = (target.as_object_mut(), residual.as_object()) else {
        return;
    };
    for (key, value) in residual {
        if let Some(existing) = target.get_mut(key) {
            merge_gemini_missing(existing, value);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn apply_gemini_native_bindings(
    target: &mut Value,
    association: &Map<String, Value>,
) -> Result<(), String> {
    let Some(bindings) = association.get("bindings").and_then(Value::as_array) else {
        return Ok(());
    };
    for binding in bindings {
        let Some(source) = binding.get("source_path").and_then(Value::as_array) else {
            continue;
        };
        let Some(canonical) = binding.get("canonical_path").and_then(Value::as_array) else {
            continue;
        };
        let source: Vec<&str> = source.iter().filter_map(Value::as_str).collect();
        let canonical: Vec<&str> = canonical.iter().filter_map(Value::as_str).collect();
        let Some(value) = value_at_path(target, &canonical) else {
            continue;
        };
        insert_at_path(target, &source, value.clone());
    }
    Ok(())
}

fn apply_gemini_part_bindings(
    target: &mut Map<String, Value>,
    canonical: &Value,
    record: &Value,
) -> Result<(), String> {
    let mut restored = Value::Object(std::mem::take(target));
    for binding in record.get("bindings").and_then(Value::as_array).into_iter().flatten() {
        let source: Vec<&str> = binding.get("source_path").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        let path: Vec<&str> = binding.get("canonical_path").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        let Some(value) = value_at_path(canonical, &path) else { continue };
        let value = match binding.get("encoding").and_then(Value::as_str) {
            Some("json_text") => match value {
                Value::String(text) => serde_json::from_str(text).unwrap_or_else(|_| value.clone()),
                _ => value.clone(),
            },
            Some("inline_data_uri" | "file_data_uri") => {
                let uri = value.as_str().ok_or("canonical media URI must be a string")?;
                let (mime, data) = uri.strip_prefix("data:").and_then(|uri| uri.split_once(";base64,")).ok_or("canonical inline media URI is not representable")?;
                if source.last() == Some(&"mimeType") { json!(mime) } else { json!(data) }
            }
            _ => value.clone(),
        };
        insert_at_path(&mut restored, &source, value);
    }
    *target = restored.as_object_mut().map(std::mem::take).ok_or("native part must remain an object")?;
    Ok(())
}

fn value_at_path<'a>(target: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = target;
    for segment in path {
        current = match segment.parse::<usize>() {
            Ok(index) => current.get(index)?,
            Err(_) => current.get(*segment)?,
        };
    }
    Some(current)
}

fn insert_at_path(target: &mut Value, path: &[&str], value: Value) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut current = target;
    for segment in parents {
        let next = current
            .as_object_mut()
            .map(|object| object.entry((*segment).to_string()).or_insert_with(|| json!({})))
            .expect("native binding parent must be an object");
        current = next;
    }
    if let Some(object) = current.as_object_mut() {
        object.insert((*last).to_string(), value);
    }
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
