use serde_json::{Map, Value};

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
        Some("custom" | "tool_search" | "web_search" | "web_search_preview") => Err(format!(
            "UnmappedOutboundFields target_protocol=openai_chat paths={path}.type"
        )),
        _ => Ok(tool.clone()),
    }
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
