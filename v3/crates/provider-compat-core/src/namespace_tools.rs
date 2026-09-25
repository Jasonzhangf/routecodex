use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};

pub fn normalize_provider_function_name(name: &str) -> String {
    let name = name
        .strip_prefix("functions.mcp__")
        .map(|rest| format!("mcp__{rest}"))
        .unwrap_or_else(|| name.to_owned());
    if let Some(dot) = name.strip_prefix("mcp__").and_then(|value| value.find('.')) {
        let dot = dot + "mcp__".len();
        let mut normalized = name;
        normalized.replace_range(dot..=dot, "__");
        normalized
    } else {
        name
    }
}

pub fn provider_function_tool_name(tool: &Value) -> Option<&str> {
    tool.get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .or_else(|| tool.get("name").and_then(Value::as_str))
}

pub fn push_unique_provider_function_tool(
    tools: &mut Vec<Value>,
    tool_indexes: &mut HashMap<String, usize>,
    tool: Value,
    target_protocol: &str,
) -> Result<(), String> {
    let Some(name) = provider_function_tool_name(&tool) else {
        tools.push(tool);
        return Ok(());
    };
    if let Some(existing_index) = tool_indexes.get(name).copied() {
        if tools[existing_index] != tool {
            return Err(format!(
                "ConflictingOutboundFields target_protocol={target_protocol} paths=$.tools[].name duplicate provider tool name `{name}` must have identical provider declaration"
            ));
        }
        return Ok(());
    }
    tool_indexes.insert(name.to_string(), tools.len());
    tools.push(tool);
    Ok(())
}

/// Returns the reversible client namespace path -> provider function name map
/// for a namespace declaration. The same traversal rules as flattening are
/// used, so nested declarations cannot drift from their wire names.
pub fn namespace_tool_name_map(tool: &Value) -> Result<Option<HashMap<String, String>>, String> {
    Ok(namespace_tool_dispatch_map(tool)?.map(|entries| {
        entries
            .into_iter()
            .map(|(client, (provider, _))| (client, provider))
            .collect()
    }))
}

fn namespace_tool_dispatch_map(
    tool: &Value,
) -> Result<Option<HashMap<String, (String, Value)>>, String> {
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

/// A provider name must identify exactly one client declaration before tool
/// declarations are flattened or deduplicated on the provider wire.
pub fn validate_namespace_tool_dispatch_names(request: &Value) -> Result<(), String> {
    let mut identities = BTreeMap::<String, (String, Value)>::new();
    let tool_lists = request.get("tools").into_iter().chain(
        request
            .get("input")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("additional_tools"))
            .filter_map(|item| item.get("tools")),
    );
    for tools in tool_lists {
        for tool in tools.as_array().into_iter().flatten() {
            if let Some(names) = namespace_tool_dispatch_map(tool)? {
                for (client_name, (provider_name, declaration)) in names {
                    insert_dispatch_identity(
                        &mut identities,
                        &provider_name,
                        &client_name,
                        &declaration,
                    )?;
                }
            } else if matches!(
                tool.get("type").and_then(Value::as_str),
                Some("function" | "custom")
            ) {
                if let Some(name) = provider_function_tool_name(tool) {
                    let provider_name =
                        if tool.get("type").and_then(Value::as_str) == Some("function") {
                            normalize_provider_function_name(name)
                        } else {
                            name.to_string()
                        };
                    let mut declaration = tool.clone();
                    if let Some(function) = declaration
                        .get_mut("function")
                        .and_then(Value::as_object_mut)
                    {
                        function.insert("name".to_string(), Value::String(provider_name.clone()));
                    } else if let Some(row) = declaration.as_object_mut() {
                        row.insert("name".to_string(), Value::String(provider_name.clone()));
                    }
                    insert_dispatch_identity(
                        &mut identities,
                        &provider_name,
                        &provider_name,
                        &declaration,
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn insert_dispatch_identity(
    identities: &mut BTreeMap<String, (String, Value)>,
    provider_name: &str,
    client_name: &str,
    declaration: &Value,
) -> Result<(), String> {
    if let Some((existing, previous)) = identities.get(provider_name) {
        if existing != client_name || previous != declaration {
            return Err(format!(
                "ConflictingOutboundFields provider tool name `{provider_name}` has conflicting declarations for client tools `{existing}` and `{client_name}`"
            ));
        }
    } else {
        identities.insert(
            provider_name.to_owned(),
            (client_name.to_owned(), declaration.clone()),
        );
    }
    Ok(())
}

fn collect_namespace_tool_names(
    qualified_namespace: &str,
    client_namespace: &str,
    tools: &[Value],
    map: &mut HashMap<String, (String, Value)>,
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
            Some("function" | "custom") => {
                let function = object.get("function").and_then(Value::as_object);
                let child = function.and_then(|v| v.get("name"))
                    .or_else(|| object.get("name"))
                    .and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
                    .ok_or_else(|| format!("provider namespace tool {client_namespace}.tools[{index}] requires a non-empty tool name"))?;
                let client_path = format!("{client_namespace}.{child}");
                let provider_name = if child == qualified_namespace || child.starts_with(&format!("{qualified_namespace}__")) {
                    child.to_string()
                } else {
                    format!("{qualified_namespace}__{child}")
                };
                let mut declaration = Value::Object(object.clone());
                if let Some(function) = declaration.get_mut("function").and_then(Value::as_object_mut) {
                    function.insert("name".to_string(), Value::String(provider_name.clone()));
                } else if let Some(row) = declaration.as_object_mut() {
                    row.insert("name".to_string(), Value::String(provider_name.clone()));
                }
                if let Some(existing) = map.get(&client_path) {
                    if existing != &(provider_name.clone(), declaration.clone()) {
                        return Err(format!(
                            "provider namespace tool {client_path} has conflicting declarations"
                        ));
                    }
                } else {
                    map.insert(client_path, (provider_name, declaration));
                }
            }
            _ => return Err(format!("provider namespace tool {client_namespace}.tools[{index}].type must be namespace, function, or custom")),
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
            Some("custom") => {
                flatten_namespace_custom(
                    protocol,
                    namespace_name,
                    child,
                    &format!("{path}.tools[{index}]"),
                    flattened,
                )?;
            }
            _ => {
                return Err(format!(
                    "{path}.tools[{index}].type must be namespace, function, or custom"
                ));
            }
        }
    }
    Ok(())
}

fn flatten_namespace_custom(
    protocol: &str,
    namespace_name: &str,
    child: &Map<String, Value>,
    child_path: &str,
    flattened: &mut Vec<Value>,
) -> Result<(), String> {
    for key in child.keys() {
        if !matches!(key.as_str(), "type" | "name" | "description" | "format") {
            return Err(format!(
                "{child_path}.{key} cannot be projected as a custom tool"
            ));
        }
    }
    let name = child
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("{child_path} requires a non-empty custom tool name"))?;
    let mut description = child.get("description").cloned();
    if description.as_ref().is_some_and(|value| !value.is_string()) {
        return Err(format!("{child_path}.description must be a string"));
    }
    if let Some(format) = child.get("format") {
        match format.as_object() {
            Some(value)
                if value.len() == 1
                    && value.get("type").and_then(Value::as_str) == Some("text") => {}
            Some(value)
                if value.len() == 3
                    && value.get("type").and_then(Value::as_str) == Some("grammar") =>
            {
                let (Some(syntax), Some(definition)) = (
                    value.get("syntax").and_then(Value::as_str),
                    value.get("definition").and_then(Value::as_str),
                ) else {
                    return Err(format!(
                        "{child_path}.format grammar requires string syntax and definition"
                    ));
                };
                let source = description.as_ref().and_then(Value::as_str).unwrap_or("");
                description = Some(Value::String(format!(
                    "{source}\nRouteCodex Chat custom-tool compatibility: source grammar syntax={syntax} definition={definition}; Chat function tools do not enforce this grammar. Put the exact raw string in input."
                )));
            }
            _ => {
                return Err(format!(
                    "{child_path}.format cannot be projected as a Chat function"
                ))
            }
        }
    }
    flattened.push(build_provider_function_tool(
        protocol,
        namespace_name,
        name,
        description,
        Some(openai_chat_freeform_custom_tool_parameters()),
        None,
    ));
    Ok(())
}

pub fn openai_chat_freeform_custom_tool_parameters() -> Value {
    serde_json::json!({
        "type":"object",
        "properties":{"input":{"type":"string","description":"Raw free-form tool input."}},
        "required":["input"],
        "additionalProperties":false
    })
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
    fn flattens_namespace_custom_child_with_reversible_name_and_input_schema() {
        let declaration = json!({
            "type":"namespace",
            "name":"functions",
            "tools":[{"type":"custom","name":"exec","format":{"type":"text"}}]
        });
        let names = namespace_tool_name_map(&declaration).unwrap().unwrap();
        assert_eq!(names["functions.exec"], "functions__exec");
        let flattened = flatten_namespace_tool_for_provider("openai-chat", &declaration)
            .unwrap()
            .unwrap();
        assert_eq!(flattened[0]["type"], "function");
        assert_eq!(flattened[0]["function"]["name"], "functions__exec");
        assert_eq!(
            flattened[0]["function"]["parameters"]["required"],
            json!(["input"])
        );
    }

    #[test]
    fn projects_namespace_custom_grammar_with_explicit_chat_compatibility() {
        let tools = flatten_namespace_tool_for_provider("openai-chat", &json!({
            "type":"namespace", "name":"functions", "tools":[{
                "type":"custom", "name":"exec", "format":{"type":"grammar", "syntax":"lark", "definition":"start: WORD"}
            }]
        })).expect("registered Chat custom compatibility").unwrap();
        assert_eq!(tools[0]["function"]["name"], "functions__exec");
        assert_eq!(
            tools[0]["function"]["parameters"],
            openai_chat_freeform_custom_tool_parameters()
        );
        assert!(tools[0]["function"]["description"]
            .as_str()
            .unwrap()
            .contains("start: WORD"));
    }

    #[test]
    fn rejects_malformed_namespace_custom_grammar() {
        let error = flatten_namespace_tool_for_provider(
            "openai-chat",
            &json!({
                "type":"namespace", "name":"functions", "tools":[{
                    "type":"custom", "name":"exec", "format":{"type":"grammar", "syntax":"lark"}
                }]
            }),
        )
        .unwrap_err();
        assert!(error.contains("tools[0].format"));
    }

    #[test]
    fn rejects_malformed_namespace_child_instead_of_dropping_it() {
        let error = flatten_namespace_tool_for_provider(
            "openai-chat",
            &json!({
                "type":"namespace",
                "name":"multi_agent_v1",
                "tools":[{"type":"custom","name":"raw","parameters":{}}]
            }),
        )
        .unwrap_err();
        assert!(error.contains("tools[0].parameters"));
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

    #[test]
    fn dispatch_names_cover_additional_tools_without_rejecting_same_identity() {
        let namespace = json!({"type":"namespace","name":"functions","tools":[
            {"type":"custom","name":"exec","format":{"type":"text"}}
        ]});
        validate_namespace_tool_dispatch_names(&json!({
            "tools":[namespace.clone()],
            "input":[{"type":"additional_tools","tools":[namespace]}]
        }))
        .expect("repeating one client identity must remain valid");

        let error = validate_namespace_tool_dispatch_names(&json!({
            "tools":[{"type":"namespace","name":"functions","tools":[
                {"type":"custom","name":"exec","format":{"type":"text"}}
            ]}],
            "input":[{"type":"additional_tools","tools":[
                {"type":"custom","name":"functions__exec","format":{"type":"text"}}
            ]}]
        }))
        .expect_err("additional_tools collision must be rejected before provider send");
        assert!(error.contains("functions.exec"), "{error}");
        assert!(error.contains("functions__exec"), "{error}");
    }

    #[test]
    fn dispatch_names_compare_matching_children_not_unrelated_catalog_siblings() {
        let exec = json!({"type":"custom","name":"exec","format":{"type":"text"}});
        validate_namespace_tool_dispatch_names(&json!({
            "tools":[{"type":"namespace","name":"functions","tools":[
                exec.clone(), {"type":"custom","name":"apply_patch","format":{"type":"text"}}
            ]}],
            "input":[{"type":"additional_tools","tools":[
                {"type":"namespace","name":"functions","tools":[exec]}
            ]}]
        }))
        .expect("the same child dispatch remains valid when catalog siblings differ");
    }

    #[test]
    fn dispatch_names_reject_conflicting_children_inside_one_namespace() {
        let error = validate_namespace_tool_dispatch_names(&json!({"tools":[{
            "type":"namespace","name":"functions","tools":[
                {"type":"function","name":"exec","parameters":openai_chat_freeform_custom_tool_parameters()},
                {"type":"custom","name":"exec","format":{"type":"text"}}
            ]
        }]}))
        .expect_err("function and custom cannot share one client dispatch path");
        assert!(error.contains("functions.exec"), "{error}");
    }

    #[test]
    fn dispatch_names_reject_normalized_function_custom_collision() {
        let function =
            json!({"type":"function","name":"mcp__mcpx.exec","parameters":{"type":"object"}});
        let custom = json!({"type":"custom","name":"mcp__mcpx__exec","format":{"type":"text"}});
        for tools in [
            vec![function.clone(), custom.clone()],
            vec![custom.clone(), function.clone()],
        ] {
            let error = validate_namespace_tool_dispatch_names(&json!({"tools":tools}))
                .expect_err("different client names normalize to one provider name");
            assert!(error.contains("mcp__mcpx__exec"), "{error}");
        }
        let error = validate_namespace_tool_dispatch_names(&json!({
            "tools":[function],"input":[{"type":"additional_tools","tools":[custom]}]
        }))
        .expect_err("additional tools share the same provider dispatch space");
        assert!(error.contains("mcp__mcpx__exec"), "{error}");
    }

    #[test]
    fn dispatch_names_reject_conflicting_same_name_declarations() {
        let function = json!({"type":"function","name":"exec","parameters":openai_chat_freeform_custom_tool_parameters()});
        let custom = json!({"type":"custom","name":"exec","format":{"type":"text"}});
        for tools in [
            vec![function.clone(), custom.clone()],
            vec![custom.clone(), function.clone()],
        ] {
            let error = validate_namespace_tool_dispatch_names(&json!({"tools":tools}))
                .expect_err("same provider name cannot hide distinct client declarations");
            assert!(error.contains("exec"), "{error}");
        }
        let error = validate_namespace_tool_dispatch_names(&json!({
            "tools":[function],"input":[{"type":"additional_tools","tools":[custom]}]
        }))
        .expect_err("additional tools must not replace a different declaration");
        assert!(error.contains("exec"), "{error}");
    }
}
