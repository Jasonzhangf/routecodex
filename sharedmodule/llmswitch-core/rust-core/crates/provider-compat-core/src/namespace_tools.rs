use serde_json::{Map, Value};

pub fn flatten_namespace_tool_for_provider(
    protocol: &str,
    tool: &Value,
) -> Result<Option<Vec<Value>>, String> {
    let Some(namespace) = tool.as_object() else {
        return Ok(None);
    };
    if namespace.get("type").and_then(Value::as_str) != Some("namespace") {
        return Ok(None);
    }
    let namespace_name = namespace
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "provider namespace tool requires a non-empty name".to_string())?;
    let children = namespace
        .get("tools")
        .and_then(Value::as_array)
        .filter(|children| !children.is_empty())
        .ok_or_else(|| {
            format!("provider namespace tool {namespace_name} requires non-empty tools")
        })?;

    let mut flattened = Vec::with_capacity(children.len());
    for (index, child) in children.iter().enumerate() {
        let child = child.as_object().ok_or_else(|| {
            format!("provider namespace tool {namespace_name}.tools[{index}] must be an object")
        })?;
        if child.get("type").and_then(Value::as_str) != Some("function") {
            return Err(format!(
                "provider namespace tool {namespace_name}.tools[{index}].type must be function"
            ));
        }
        let function = match child.get("function") {
            Some(Value::Object(function)) => Some(function),
            Some(_) => {
                return Err(format!(
                    "provider namespace tool {namespace_name}.tools[{index}].function must be an object"
                ));
            }
            None => None,
        };
        let child_name = function
            .and_then(|row| row.get("name"))
            .or_else(|| child.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                format!(
                    "provider namespace tool {namespace_name}.tools[{index}] requires a non-empty function name"
                )
            })?;
        let child_path = format!("provider namespace tool {namespace_name}.tools[{index}]");
        let description = read_optional_namespace_child_field(
            &child_path,
            child,
            function,
            "description",
            "a string",
            Value::is_string,
        )?;
        let parameters = read_optional_namespace_child_field(
            &child_path,
            child,
            function,
            "parameters",
            "an object",
            Value::is_object,
        )?;
        let strict = read_optional_namespace_child_field(
            &child_path,
            child,
            function,
            "strict",
            "a boolean",
            Value::is_boolean,
        )?;
        flattened.push(build_provider_function_tool(
            protocol,
            child_name,
            description,
            parameters,
            strict,
        ));
    }
    Ok(Some(flattened))
}

fn read_optional_namespace_child_field(
    child_path: &str,
    child: &Map<String, Value>,
    function: Option<&Map<String, Value>>,
    field: &str,
    expected_type: &str,
    accepts: impl Fn(&Value) -> bool,
) -> Result<Option<Value>, String> {
    let child_value = child.get(field);
    let function_value = function.and_then(|row| row.get(field));
    for (value, path) in [
        (child_value, field.to_string()),
        (function_value, format!("function.{field}")),
    ] {
        if value.is_some_and(|value| !accepts(value)) {
            return Err(format!("{child_path}.{path} must be {expected_type}"));
        }
    }
    Ok(function_value.or(child_value).cloned())
}

fn build_provider_function_tool(
    protocol: &str,
    name: &str,
    description: Option<Value>,
    parameters: Option<Value>,
    strict: Option<Value>,
) -> Value {
    let mut function = Map::new();
    function.insert("name".to_string(), Value::String(name.to_string()));
    if let Some(description) = description {
        function.insert("description".to_string(), description);
    }
    if let Some(parameters) = parameters {
        function.insert("parameters".to_string(), parameters);
    }
    if let Some(strict) = strict {
        function.insert("strict".to_string(), strict);
    }

    let mut output = Map::new();
    output.insert("type".to_string(), Value::String("function".to_string()));
    if protocol == "openai-responses" {
        output.extend(function);
    } else {
        output.insert("function".to_string(), Value::Object(function));
    }
    Value::Object(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flattens_valid_namespace_children_for_openai_chat() {
        let flattened = flatten_namespace_tool_for_provider(
            "openai-chat",
            &json!({
                "type":"namespace",
                "name":"multi_agent_v1",
                "tools":[
                    {"type":"function","name":"spawn_agent","parameters":{"type":"object"},"strict":false},
                    {"type":"function","name":"wait_agent","parameters":{"type":"object"}}
                ]
            }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(flattened.len(), 2);
        assert_eq!(flattened[0]["type"], "function");
        assert_eq!(flattened[0]["function"]["name"], "spawn_agent");
        assert_eq!(flattened[0]["function"]["strict"], false);
        assert_eq!(flattened[1]["function"]["name"], "wait_agent");
    }

    #[test]
    fn rejects_malformed_namespace_child_instead_of_dropping_it() {
        let error = flatten_namespace_tool_for_provider(
            "openai-chat",
            &json!({
                "type":"namespace",
                "name":"multi_agent_v1",
                "tools":[{"type":"custom","name":"raw"}]
            }),
        )
        .unwrap_err();
        assert!(error.contains("tools[0].type must be function"));
    }

    #[test]
    fn rejects_malformed_namespace_child_schema_fields() {
        for (field, value, expected) in [
            (
                "description",
                json!(17),
                "tools[0].description must be a string",
            ),
            (
                "parameters",
                json!("bad"),
                "tools[0].parameters must be an object",
            ),
            ("strict", json!("yes"), "tools[0].strict must be a boolean"),
        ] {
            let mut child = json!({"type":"function","name":"spawn_agent"});
            child[field] = value;
            let error = flatten_namespace_tool_for_provider(
                "openai-chat",
                &json!({
                    "type":"namespace",
                    "name":"multi_agent_v1",
                    "tools":[child]
                }),
            )
            .unwrap_err();
            assert!(error.contains(expected), "unexpected error: {error}");
        }
    }

    #[test]
    fn rejects_malformed_nested_function_shape() {
        let error = flatten_namespace_tool_for_provider(
            "openai-chat",
            &json!({
                "type":"namespace",
                "name":"multi_agent_v1",
                "tools":[{
                    "type":"function",
                    "name":"spawn_agent",
                    "function":"bad"
                }]
            }),
        )
        .unwrap_err();
        assert!(error.contains("tools[0].function must be an object"));

        let error = flatten_namespace_tool_for_provider(
            "openai-chat",
            &json!({
                "type":"namespace",
                "name":"multi_agent_v1",
                "tools":[{
                    "type":"function",
                    "name":"spawn_agent",
                    "parameters":{"type":"object"},
                    "function":{
                        "name":"spawn_agent",
                        "parameters":"bad"
                    }
                }]
            }),
        )
        .unwrap_err();
        assert!(error.contains("tools[0].function.parameters must be an object"));
    }
}
