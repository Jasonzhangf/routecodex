use serde_json::{Map, Value};
use std::collections::HashMap;

/// Returns the reversible client namespace path -> provider function name map
/// for a namespace declaration. The same traversal rules as flattening are
/// used, so nested declarations cannot drift from their wire names.
pub fn namespace_tool_name_map(tool: &Value) -> Result<Option<HashMap<String, String>>, String> {
    let Some(namespace) = tool.as_object() else {
        return Ok(None);
    };
    if namespace.get("type").and_then(Value::as_str) != Some("namespace") {
        return Ok(None);
    }
    let name = namespace
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "provider namespace tool requires a non-empty name".to_string())?;
    let tools = namespace
        .get("tools")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| format!("provider namespace tool {name} requires non-empty tools"))?;
    let mut map = HashMap::new();
    collect_namespace_tool_names(name, name, tools, &mut map)?;
    Ok(Some(map))
}

fn collect_namespace_tool_names(
    qualified_namespace: &str,
    client_namespace: &str,
    tools: &[Value],
    map: &mut HashMap<String, String>,
) -> Result<(), String> {
    for (index, tool) in tools.iter().enumerate() {
        let object = tool.as_object().ok_or_else(|| {
            format!("provider namespace tool {client_namespace}.tools[{index}] must be an object")
        })?;
        match object.get("type").and_then(Value::as_str) {
            Some("namespace") => {
                let child = object.get("name").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
                    .ok_or_else(|| format!("provider namespace tool {client_namespace}.tools[{index}] requires a non-empty namespace name"))?;
                let nested = object.get("tools").and_then(Value::as_array).filter(|v| !v.is_empty())
                    .ok_or_else(|| format!("provider namespace tool {client_namespace}.tools[{index}] requires non-empty tools"))?;
                collect_namespace_tool_names(
                    &format!("{qualified_namespace}__{child}"),
                    &format!("{client_namespace}.{child}"),
                    nested,
                    map,
                )?;
            }
            Some("function") => {
                let function = object.get("function").and_then(Value::as_object);
                let child = function.and_then(|v| v.get("name"))
                    .or_else(|| object.get("name"))
                    .and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
                    .ok_or_else(|| format!("provider namespace tool {client_namespace}.tools[{index}] requires a non-empty function name"))?;
                let client_path = format!("{client_namespace}.{child}");
                let provider_name = if child == qualified_namespace || child.starts_with(&format!("{qualified_namespace}__")) {
                    child.to_string()
                } else {
                    format!("{qualified_namespace}__{child}")
                };
                map.insert(client_path, provider_name);
            }
            _ => return Err(format!("provider namespace tool {client_namespace}.tools[{index}].type must be namespace or function")),
        }
    }
    Ok(())
}

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
    flatten_namespace_children(
        protocol,
        &namespace_name,
        children,
        &format!("provider namespace tool {namespace_name}"),
        &mut flattened,
    )?;
    Ok(Some(flattened))
}

fn flatten_namespace_children(
    protocol: &str,
    namespace_name: &str,
    children: &[Value],
    path: &str,
    flattened: &mut Vec<Value>,
) -> Result<(), String> {
    for (index, child) in children.iter().enumerate() {
        let child = child
            .as_object()
            .ok_or_else(|| format!("{path}.tools[{index}] must be an object"))?;
        match child.get("type").and_then(Value::as_str) {
            Some("namespace") => {
                let nested_name = child
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        format!("{path}.tools[{index}] requires a non-empty namespace name")
                    })?;
                let nested_children = child
                    .get("tools")
                    .and_then(Value::as_array)
                    .filter(|items| !items.is_empty())
                    .ok_or_else(|| format!("{path}.tools[{index}] requires non-empty tools"))?;
                let nested_path = format!("{path}.tools[{index}]");
                let qualified_namespace = format!("{namespace_name}__{nested_name}");
                flatten_namespace_children(
                    protocol,
                    &qualified_namespace,
                    nested_children,
                    &nested_path,
                    flattened,
                )?;
            }
            Some("function") => {
                flatten_namespace_function(
                    protocol,
                    namespace_name,
                    child,
                    &format!("{path}.tools[{index}]"),
                    flattened,
                )?;
            }
            _ => {
                return Err(format!(
                    "{path}.tools[{index}].type must be namespace or function"
                ));
            }
        }
    }
    Ok(())
}

fn flatten_namespace_function(
    protocol: &str,
    namespace_name: &str,
    child: &Map<String, Value>,
    child_path: &str,
    flattened: &mut Vec<Value>,
) -> Result<(), String> {
    let function = match child.get("function") {
        Some(Value::Object(function)) => Some(function),
        Some(_) => {
            return Err(format!("{child_path}.function must be an object"));
        }
        None => None,
    };
    let child_name = function
        .and_then(|row| row.get("name"))
        .or_else(|| child.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{child_path} requires a non-empty function name"))?;
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
        namespace_name,
        child_name,
        description,
        parameters,
        strict,
    ));
    Ok(())
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
    namespace_name: &str,
    name: &str,
    description: Option<Value>,
    parameters: Option<Value>,
    strict: Option<Value>,
) -> Value {
    let mut function = Map::new();
    let qualified_name =
        if name == namespace_name || name.starts_with(&format!("{namespace_name}__")) {
            name.to_string()
        } else {
            format!("{namespace_name}__{name}")
        };
    function.insert("name".to_string(), Value::String(qualified_name));
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
        assert_eq!(
            flattened[0]["function"]["name"],
            "multi_agent_v1__spawn_agent"
        );
        assert_eq!(flattened[0]["function"]["strict"], false);
        assert_eq!(
            flattened[1]["function"]["name"],
            "multi_agent_v1__wait_agent"
        );
    }

    #[test]
    fn qualifies_mcpx_namespace_children_without_parent_function() {
        let flattened = flatten_namespace_tool_for_provider(
            "openai-chat",
            &json!({
                "type":"namespace",
                "name":"mcp__mcpx",
                "tools":[{"type":"function","name":"workspace","parameters":{"type":"object"}}]
            }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(flattened.len(), 1);
        assert_eq!(flattened[0]["function"]["name"], "mcp__mcpx__workspace");
        assert!(flattened
            .iter()
            .all(|tool| tool["function"]["name"] != "mcp__mcpx"));
    }

    #[test]
    fn recursively_flattens_nested_mcpx_namespace_children() {
        let flattened = flatten_namespace_tool_for_provider(
            "openai-chat",
            &json!({
                "type":"namespace",
                "name":"mcp__mcpx",
                "tools":[{
                    "type":"namespace",
                    "name":"workspace",
                    "tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]
                }]
            }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(flattened.len(), 1);
        assert_eq!(flattened[0]["type"], "function");
        assert_eq!(
            flattened[0]["function"]["name"],
            "mcp__mcpx__workspace__read"
        );
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
        assert!(error.contains("tools[0].type must be namespace or function"));
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
