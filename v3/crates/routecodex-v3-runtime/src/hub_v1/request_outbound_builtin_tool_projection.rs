use serde_json::{Map, Value};

pub(super) fn project_openai_chat_provider_tools(payload: &mut Value) -> Result<(), String> {
    let Some(root) = payload.as_object_mut() else {
        return Ok(());
    };
    let Some(tools) = root.remove("tools") else {
        return Ok(());
    };
    let tools = tools.as_array().ok_or_else(|| {
        "MalformedOutboundField target_protocol=openai_chat path=$.tools".to_string()
    })?;
    let mut normalized_tools = Vec::new();
    let mut web_search_options = Map::new();
    let mut has_web_search = false;
    for (index, tool) in tools.iter().enumerate() {
        let tool_type = tool.get("type").and_then(Value::as_str);
        if matches!(tool_type, Some("web_search" | "web_search_preview")) {
            has_web_search = true;
            merge_openai_chat_web_search_options(
                &mut web_search_options,
                tool,
                &format!("$.tools[{index}]"),
            )?;
        } else {
            normalized_tools.push(normalize_openai_chat_provider_tool(tool, index)?);
        }
    }
    if !normalized_tools.is_empty() {
        root.insert("tools".to_string(), Value::Array(normalized_tools));
    }
    if has_web_search {
        let projected = Value::Object(web_search_options);
        if root
            .get("web_search_options")
            .is_some_and(|existing| existing != &projected)
        {
            return Err("ConflictingOutboundFields target_protocol=openai_chat paths=$.web_search_options,$.tools[].type".to_string());
        }
        root.insert("web_search_options".to_string(), projected);
    }
    Ok(())
}

fn merge_openai_chat_web_search_options(
    output: &mut Map<String, Value>,
    tool: &Value,
    path: &str,
) -> Result<(), String> {
    let row = tool
        .as_object()
        .ok_or_else(|| format!("MalformedOutboundField target_protocol=openai_chat path={path}"))?;
    for key in row.keys() {
        if !matches!(
            key.as_str(),
            "type"
                | "search_context_size"
                | "user_location"
                | "external_web_access"
                | "search_content_types"
        ) {
            return Err(format!(
                "UnmappedOutboundFields target_protocol=openai_chat paths={path}.{key}"
            ));
        }
    }
    if row
        .get("external_web_access")
        .is_some_and(|value| value != true)
    {
        return Err(format!(
            "UnmappedOutboundFields target_protocol=openai_chat paths={path}.external_web_access"
        ));
    }
    if let Some(search_content_types) = row.get("search_content_types") {
        let values = search_content_types.as_array().ok_or_else(|| {
            format!(
                "MalformedOutboundField target_protocol=openai_chat path={path}.search_content_types"
            )
        })?;
        if values.as_slice() != [Value::String("text".to_string())] {
            return Err(format!(
                "UnmappedOutboundFields target_protocol=openai_chat paths={path}.search_content_types"
            ));
        }
    }
    for key in ["search_context_size", "user_location"] {
        let Some(value) = row.get(key) else {
            continue;
        };
        if output.get(key).is_some_and(|existing| existing != value) {
            return Err(format!(
                "ConflictingOutboundFields target_protocol=openai_chat paths={path}.{key}"
            ));
        }
        output.insert(key.to_string(), value.clone());
    }
    Ok(())
}

pub(super) fn normalize_openai_chat_provider_tool(
    tool: &Value,
    index: usize,
) -> Result<Value, String> {
    let Some(row) = tool.as_object() else {
        return Ok(tool.clone());
    };
    let path = format!("$.tools[{index}]");
    match row.get("type").and_then(Value::as_str) {
        Some("function") => normalize_openai_chat_function_tool(row, &path),
        Some("tool_search") => normalize_openai_chat_tool_search(row, &path),
        Some("custom") => normalize_openai_chat_custom_tool(row, &path),
        _ => Ok(tool.clone()),
    }
}

fn normalize_openai_chat_custom_tool(
    row: &Map<String, Value>,
    path: &str,
) -> Result<Value, String> {
    for key in row.keys() {
        if !matches!(key.as_str(), "type" | "name" | "description" | "format") {
            return Err(format!(
                "UnmappedOutboundFields target_protocol=openai_chat paths={path}.{key}"
            ));
        }
    }
    let name = row
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("MalformedOutboundField target_protocol=openai_chat path={path}.name")
        })?;
    let mut custom = Map::from_iter([("name".to_string(), Value::String(name.to_string()))]);
    if let Some(description) = row.get("description") {
        if !description.is_string() {
            return Err(format!(
                "MalformedOutboundField target_protocol=openai_chat path={path}.description"
            ));
        }
        custom.insert("description".to_string(), description.clone());
    }
    if let Some(format) = row.get("format") {
        let format = format.as_object().ok_or_else(|| {
            format!("MalformedOutboundField target_protocol=openai_chat path={path}.format")
        })?;
        let format_type = format.get("type").and_then(Value::as_str).ok_or_else(|| {
            format!("MalformedOutboundField target_protocol=openai_chat path={path}.format.type")
        })?;
        let projected_format = match format_type {
            "text" => {
                if format.len() != 1 {
                    return Err(format!(
                        "UnmappedOutboundFields target_protocol=openai_chat paths={path}.format"
                    ));
                }
                serde_json::json!({"type":"text"})
            }
            "grammar" => {
                let syntax = format.get("syntax").and_then(Value::as_str).ok_or_else(|| {
                    format!("MalformedOutboundField target_protocol=openai_chat path={path}.format.syntax")
                })?;
                let definition = format
                    .get("definition")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        format!("MalformedOutboundField target_protocol=openai_chat path={path}.format.definition")
                    })?;
                if !matches!(syntax, "lark" | "regex") || format.len() != 3 {
                    return Err(format!(
                        "UnmappedOutboundFields target_protocol=openai_chat paths={path}.format"
                    ));
                }
                serde_json::json!({"type":"grammar","grammar":{"syntax":syntax,"definition":definition}})
            }
            _ => {
                return Err(format!(
                    "UnmappedOutboundFields target_protocol=openai_chat paths={path}.format.type"
                ));
            }
        };
        custom.insert("format".to_string(), projected_format);
    }
    Ok(Value::Object(Map::from_iter([
        ("type".to_string(), Value::String("custom".to_string())),
        ("custom".to_string(), Value::Object(custom)),
    ])))
}

fn normalize_openai_chat_tool_search(
    row: &Map<String, Value>,
    path: &str,
) -> Result<Value, String> {
    for key in row.keys() {
        if !matches!(
            key.as_str(),
            "type" | "execution" | "description" | "parameters"
        ) {
            return Err(format!(
                "UnmappedOutboundFields target_protocol=openai_chat paths={path}.{key}"
            ));
        }
    }
    if row
        .get("execution")
        .is_some_and(|value| value.as_str() != Some("client"))
    {
        return Err(format!(
            "UnmappedOutboundFields target_protocol=openai_chat paths={path}.execution"
        ));
    }
    let mut function_row = Map::new();
    function_row.insert("type".to_string(), Value::String("function".to_string()));
    function_row.insert("name".to_string(), Value::String("tool_search".to_string()));
    for key in ["description", "parameters"] {
        if let Some(value) = row.get(key) {
            function_row.insert(key.to_string(), value.clone());
        }
    }
    normalize_openai_chat_function_tool(&function_row, path)
}

fn normalize_openai_chat_function_tool(
    row: &Map<String, Value>,
    path: &str,
) -> Result<Value, String> {
    if row.get("function").and_then(Value::as_object).is_some() {
        let mut normalized = row.clone();
        if let Some(function) = normalized
            .get_mut("function")
            .and_then(Value::as_object_mut)
        {
            normalize_function_tool_schema_object(function, &format!("{path}.function"))?;
        }
        return Ok(Value::Object(normalized));
    }
    let mut function = Map::new();
    for key in ["name", "description", "parameters", "strict"] {
        if let Some(value) = row.get(key) {
            function.insert(key.to_string(), value.clone());
        }
    }
    normalize_function_tool_schema_object(&mut function, path)?;
    Ok(Value::Object(Map::from_iter([
        ("type".to_string(), Value::String("function".to_string())),
        ("function".to_string(), Value::Object(function)),
    ])))
}

fn normalize_function_tool_schema_object(
    function: &mut Map<String, Value>,
    path: &str,
) -> Result<(), String> {
    if let Some(parameters) = function.get_mut("parameters") {
        normalize_json_schema_redaction_placeholders(
            parameters,
            true,
            &format!("{path}.parameters"),
        )?;
    }
    Ok(())
}

pub(super) fn normalize_json_schema_redaction_placeholders(
    value: &mut Value,
    schema_position: bool,
    path: &str,
) -> Result<(), String> {
    match value {
        Value::String(text) if schema_position && text == "[REDACTED]" => Err(format!(
            "MalformedOutboundField path={path} reason=redacted_schema_placeholder"
        )),
        Value::Object(map) if schema_position => {
            for (key, child) in map {
                normalize_json_schema_redaction_object_member(
                    key,
                    child,
                    &format!("{path}.{key}"),
                )?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn normalize_json_schema_redaction_object_member(
    key: &str,
    value: &mut Value,
    path: &str,
) -> Result<(), String> {
    match key {
        "$defs" | "definitions" | "properties" | "patternProperties" | "dependentSchemas" => {
            let Some(map) = value.as_object_mut() else {
                return Ok(());
            };
            for (property, schema) in map {
                normalize_json_schema_redaction_placeholders(
                    schema,
                    true,
                    &format!("{path}.{property}"),
                )?;
            }
            Ok(())
        }
        "items"
        | "additionalProperties"
        | "additionalItems"
        | "contains"
        | "propertyNames"
        | "not"
        | "if"
        | "then"
        | "else"
        | "unevaluatedItems"
        | "unevaluatedProperties" => {
            normalize_json_schema_redaction_placeholders(value, true, path)
        }
        "oneOf" | "anyOf" | "allOf" | "prefixItems" => {
            let Some(items) = value.as_array_mut() else {
                return Ok(());
            };
            for (index, schema) in items.iter_mut().enumerate() {
                normalize_json_schema_redaction_placeholders(
                    schema,
                    true,
                    &format!("{path}[{index}]"),
                )?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
