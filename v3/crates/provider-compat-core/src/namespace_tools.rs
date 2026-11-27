use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};

pub use crate::namespace_identity::{
    NamespaceToolIdentity, NamespaceToolIdentityRegistry, ToolKind, NATIVE_TOOL_SEARCH_WIRE_NAME,
};

/// OpenAI Chat permits at most 64 characters. The current request declaration
/// supplies the inverse identity; other protocols keep their own representation.
pub fn openai_chat_namespace_wire_name(name: &str) -> String {
    if name.len() <= 64 {
        name.to_owned()
    } else {
        format!("{:x}", Sha256::digest(name.as_bytes()))
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

/// Replaces a prior provider declaration for a request-validated tool identity.
/// The caller must first validate that the provider name maps to one client path and tool kind.
pub fn replace_provider_function_tool(
    tools: &mut Vec<Value>,
    tool_indexes: &mut HashMap<String, usize>,
    tool: Value,
) {
    let Some(name) = provider_function_tool_name(&tool) else {
        tools.push(tool);
        return;
    };
    if let Some(existing_index) = tool_indexes.get(name).copied() {
        tools[existing_index] = tool;
    } else {
        tool_indexes.insert(name.to_string(), tools.len());
        tools.push(tool);
    }
}

/// Returns the reversible client namespace path -> provider function name map
/// for a namespace declaration. The same traversal rules as flattening are
/// used, so nested declarations cannot drift from their wire names.
pub fn namespace_tool_name_map(tool: &Value) -> Result<Option<HashMap<String, String>>, String> {
    if tool.get("type").and_then(Value::as_str) != Some("namespace") {
        return Ok(None);
    }
    let registry = NamespaceToolIdentityRegistry::from_tools(std::slice::from_ref(tool))?;
    Ok(Some(
        registry
            .identities()
            .filter(|identity| {
                registry
                    .identity_for_client_path(&identity.client_path())
                    .is_some()
            })
            .map(|identity| (identity.client_path(), identity.actual_wire_name.clone()))
            .collect(),
    ))
}

pub fn resolve_responses_tool_declarations(request: &Value) -> Result<Vec<Value>, String> {
    let registry = NamespaceToolIdentityRegistry::from_request(request, "openai-responses")?;
    Ok(registry.source_tools(
        request
            .get("tools")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default(),
    ))
}

/// A provider name must identify exactly one client declaration before tool
/// declarations are flattened or deduplicated on the provider wire.
pub fn validate_namespace_tool_dispatch_names(request: &Value) -> Result<BTreeSet<String>, String> {
    let original = NamespaceToolIdentityRegistry::from_tools(
        request
            .get("tools")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default(),
    )?;
    let current = NamespaceToolIdentityRegistry::from_request(request, "openai-responses")?;
    let mut refreshed_names = BTreeSet::new();
    for previous in original.identities() {
        if current.identities().any(|identity| {
            identity.namespace_segments == previous.namespace_segments
                && identity.leaf_name == previous.leaf_name
                && identity.kind == previous.kind
                && identity.source != previous.source
        }) {
            refreshed_names.insert(previous.actual_wire_name.clone());
        }
    }
    Ok(refreshed_names)
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
    let mut namespace_descriptions = Vec::new();
    if let Some(description) = namespace
        .get("description")
        .and_then(Value::as_str)
        .filter(|description| !description.is_empty())
    {
        namespace_descriptions.push(description.to_owned());
    }
    flatten_namespace_children(
        protocol,
        &namespace_name,
        &mut namespace_descriptions,
        children,
        &format!("provider namespace tool {namespace_name}"),
        &mut flattened,
    )?;
    Ok(Some(flattened))
}

fn flatten_namespace_children(
    protocol: &str,
    namespace_name: &str,
    namespace_descriptions: &mut Vec<String>,
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
                let nested_description = child
                    .get("description")
                    .and_then(Value::as_str)
                    .filter(|description| !description.is_empty());
                if let Some(description) = nested_description {
                    namespace_descriptions.push(description.to_owned());
                }
                flatten_namespace_children(
                    protocol,
                    &qualified_namespace,
                    namespace_descriptions,
                    nested_children,
                    &nested_path,
                    flattened,
                )?;
                if nested_description.is_some() {
                    namespace_descriptions.pop();
                }
            }
            Some("function") => {
                flatten_namespace_function(
                    protocol,
                    namespace_name,
                    namespace_descriptions,
                    child,
                    &format!("{path}.tools[{index}]"),
                    flattened,
                )?;
            }
            Some("custom") => {
                flatten_namespace_custom(
                    protocol,
                    namespace_name,
                    namespace_descriptions,
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
    namespace_descriptions: &[String],
    child: &Map<String, Value>,
    child_path: &str,
    flattened: &mut Vec<Value>,
) -> Result<(), String> {
    if protocol == "openai-responses" {
        let mut native = child.clone();
        let name = child
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{child_path} requires a custom tool name"))?;
        native.insert(
            "name".into(),
            Value::String(format!("{namespace_name}__{name}")),
        );
        let source_description = child.get("description").cloned();
        if source_description.as_ref().is_none_or(Value::is_string) {
            if let Some(description) =
                compose_namespace_description(namespace_descriptions, source_description)
            {
                native.insert("description".into(), description);
            }
        }
        flattened.push(Value::Object(native));
        return Ok(());
    }
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
    description = compose_namespace_description(namespace_descriptions, description);
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
    namespace_descriptions: &[String],
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
    let description = compose_namespace_description(namespace_descriptions, description);
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

fn compose_namespace_description(
    namespace_descriptions: &[String],
    leaf_description: Option<Value>,
) -> Option<Value> {
    let namespace_descriptions: Vec<&str> = namespace_descriptions
        .iter()
        .map(String::as_str)
        .filter(|description| !description.is_empty())
        .collect();
    if namespace_descriptions.is_empty() {
        return leaf_description;
    }
    let mut parts = namespace_descriptions;
    if let Some(leaf) = leaf_description
        .as_ref()
        .and_then(Value::as_str)
        .filter(|description| !description.is_empty())
    {
        parts.push(leaf);
    }
    Some(Value::String(parts.join("\n\n")))
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
    let qualified_name = format!("{namespace_name}__{name}");
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

    fn assert_distinct_bound_identities(request: &Value, count: usize) {
        let registry =
            NamespaceToolIdentityRegistry::from_request(request, "openai-responses").unwrap();
        assert_eq!(registry.identities().count(), count);
        assert_eq!(registry.declared_wire_names().len(), count);
        let tools = registry
            .project_tools("openai-responses", request["tools"].as_array().unwrap())
            .unwrap();
        assert_eq!(tools.len(), count);
        for identity in registry.identities() {
            let projected = tools
                .iter()
                .find(|tool| {
                    provider_function_tool_name(tool) == Some(identity.actual_wire_name.as_str())
                })
                .unwrap();
            assert_eq!(
                projected["type"],
                if identity.kind == ToolKind::Function {
                    "function"
                } else {
                    "custom"
                }
            );
            if identity.is_namespaced() {
                assert_eq!(
                    registry
                        .restore_identities()
                        .get(&identity.actual_wire_name),
                    Some(&(identity.client_namespace(), identity.leaf_name.clone()))
                );
            }
        }
    }

    #[test]
    fn dispatch_names_reject_flattened_collision_with_underscored_tool_leaf() {
        assert_distinct_bound_identities(
            &json!({
                "tools":[
                    {"type":"function","name":"mcp__mcpx.foo__bar","parameters":{"type":"object"}},
                    {"type":"namespace","name":"mcp__mcpx","tools":[
                        {"type":"namespace","name":"foo","tools":[
                            {"type":"function","name":"bar","parameters":{"type":"object"}}
                        ]}
                    ]}
                ]
            }),
            2,
        );
    }

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

        assert_distinct_bound_identities(
            &json!({
                "tools":[{"type":"namespace","name":"functions","tools":[
                    {"type":"custom","name":"exec","format":{"type":"text"}}
                ]}],
                "input":[{"type":"additional_tools","tools":[
                    {"type":"custom","name":"functions__exec","format":{"type":"text"}}
                ]}]
            }),
            2,
        );
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
        assert_distinct_bound_identities(
            &json!({"tools":[{
                "type":"namespace","name":"functions","tools":[
                    {"type":"function","name":"exec","parameters":openai_chat_freeform_custom_tool_parameters()},
                    {"type":"custom","name":"exec","format":{"type":"text"}}
                ]
            }]}),
            2,
        );
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
            assert_distinct_bound_identities(&json!({"tools":tools}), 2);
        }
        assert_distinct_bound_identities(
            &json!({
                "tools":[function],"input":[{"type":"additional_tools","tools":[custom]}]
            }),
            2,
        );
    }

    #[test]
    fn dispatch_names_allow_updated_declaration_for_same_namespace_tool_identity() {
        let first = json!({"type":"namespace","name":"mcp__collab","tools":[
            {"type":"function","name":"collab_context","description":"deferred","parameters":{"type":"object","properties":{"old":{"type":"string"}}}}
        ]});
        let current = json!({"type":"namespace","name":"mcp__collab","tools":[
            {"type":"function","name":"collab_context","description":"loaded","parameters":{"type":"object","properties":{"query":{"type":"string"}}}}
        ]});
        let refreshed = validate_namespace_tool_dispatch_names(&json!({
            "tools":[first],"input":[{"type":"additional_tools","tools":[current]}]
        }))
        .expect("a current declaration may refresh the same client tool identity");
        assert!(refreshed.contains("mcp__collab__collab_context"));
    }

    #[test]
    fn dispatch_names_refresh_nested_namespace_from_additional_tools() {
        let previous = json!({"type":"namespace","name":"mcp__mcpx","tools":[{
            "type":"namespace","name":"workspace","tools":[
                {"type":"function","name":"read","description":"old","parameters":{"type":"object"}}
            ]
        }]});
        let current_flat_alias = json!({
            "type":"function",
            "name":"mcp__mcpx__workspace__read",
            "description":"current",
            "parameters":{"type":"object"}
        });

        let refreshed = validate_namespace_tool_dispatch_names(&json!({
            "tools":[previous],
            "input":[{"type":"additional_tools","tools":[current_flat_alias]}]
        }))
        .expect("nested namespace path must retain one dispatch identity");

        assert!(
            refreshed.is_empty(),
            "a plain declaration must not refresh a namespaced identity"
        );
    }

    #[test]
    fn dispatch_names_reject_conflicting_declarations_within_same_source() {
        let error = validate_namespace_tool_dispatch_names(&json!({
            "tools":[
                {"type":"namespace","name":"mcp__collab","tools":[
                    {"type":"function","name":"collab_context","description":"old","parameters":{"type":"object"}}
                ]},
                {"type":"namespace","name":"mcp__collab","tools":[
                    {"type":"function","name":"collab_context","description":"new","parameters":{"type":"object"}}
                ]}
            ]
        }))
        .expect_err("same-source schema conflicts must not silently refresh");

        assert!(error.contains("mcp__collab__collab_context"), "{error}");
    }

    #[test]
    fn dispatch_names_still_reject_distinct_identities_with_same_provider_name() {
        let first_namespace = json!({"type":"namespace","name":"mcp__a","tools":[
            {"type":"function","name":"b__c","parameters":{"type":"object"}}
        ]});
        let second_namespace = json!({"type":"namespace","name":"mcp__a__b","tools":[
            {"type":"function","name":"c","parameters":{"type":"object"}}
        ]});
        assert_distinct_bound_identities(
            &json!({
                "tools":[first_namespace, second_namespace]
            }),
            2,
        );
    }

    #[test]
    fn dispatch_names_still_reject_function_and_custom_kind_collision() {
        let function = json!({"type":"function","name":"exec","parameters":openai_chat_freeform_custom_tool_parameters()});
        let custom = json!({"type":"custom","name":"exec","format":{"type":"text"}});
        assert_distinct_bound_identities(&json!({"tools":[function,custom]}), 2);
    }

    #[test]
    fn composes_namespace_and_leaf_descriptions_in_order() {
        let flattened = flatten_namespace_tool_for_provider("openai-chat", &json!({
            "type":"namespace",
            "name":"functions",
            "description":"Namespace docs.",
            "tools":[{"type":"function","name":"run","description":"Leaf docs.","parameters":{"type":"object"}}]
        }))
        .unwrap()
        .unwrap();
        assert_eq!(
            flattened[0]["function"]["description"],
            "Namespace docs.\n\nLeaf docs."
        );
    }

    #[test]
    fn nested_namespace_descriptions_survive_once_in_order() {
        let flattened = flatten_namespace_tool_for_provider("openai-chat", &json!({
            "type":"namespace",
            "name":"outer",
            "description":"Outer docs.",
            "tools":[{
                "type":"namespace",
                "name":"inner",
                "description":"Inner docs.",
                "tools":[{"type":"function","name":"run","description":"Leaf docs.","parameters":{"type":"object"}}]
            }]
        }))
        .unwrap()
        .unwrap();
        let description = flattened[0]["function"]["description"].as_str().unwrap();
        assert_eq!(description, "Outer docs.\n\nInner docs.\n\nLeaf docs.");
        assert_eq!(description.matches("docs.").count(), 3);
    }

    #[test]
    fn missing_namespace_description_preserves_leaf_description() {
        let flattened = flatten_namespace_tool_for_provider("openai-chat", &json!({
            "type":"namespace",
            "name":"functions",
            "tools":[{"type":"function","name":"run","description":"Leaf docs.","parameters":{"type":"object"}}]
        }))
        .unwrap()
        .unwrap();
        assert_eq!(flattened[0]["function"]["description"], "Leaf docs.");
    }

    #[test]
    fn missing_leaf_description_preserves_namespace_description() {
        let flattened = flatten_namespace_tool_for_provider(
            "openai-chat",
            &json!({
                "type":"namespace",
                "name":"functions",
                "description":"Namespace docs.",
                "tools":[{"type":"function","name":"run","parameters":{"type":"object"}}]
            }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(flattened[0]["function"]["description"], "Namespace docs.");
    }

    #[test]
    fn sibling_namespaces_compose_each_leaf_only_with_its_own_ancestors() {
        let flattened = flatten_namespace_tool_for_provider("openai-chat", &json!({
            "type":"namespace",
            "name":"outer",
            "description":"Outer docs.",
            "tools":[
                {
                    "type":"namespace",
                    "name":"left",
                    "description":"Left docs.",
                    "tools":[{"type":"function","name":"a","description":"A leaf.","parameters":{"type":"object"}}]
                },
                {
                    "type":"namespace",
                    "name":"right",
                    "description":"Right docs.",
                    "tools":[{"type":"function","name":"b","description":"B leaf.","parameters":{"type":"object"}}]
                }
            ]
        }))
        .unwrap()
        .unwrap();
        assert_eq!(flattened.len(), 2);
        let left = flattened
            .iter()
            .find(|tool| tool["function"]["name"] == "outer__left__a")
            .unwrap();
        let right = flattened
            .iter()
            .find(|tool| tool["function"]["name"] == "outer__right__b")
            .unwrap();
        assert_eq!(
            left["function"]["description"],
            "Outer docs.\n\nLeft docs.\n\nA leaf."
        );
        assert_eq!(
            right["function"]["description"],
            "Outer docs.\n\nRight docs.\n\nB leaf."
        );
    }

    #[test]
    fn custom_grammar_projection_keeps_documentation_and_compatibility_annotation() {
        let tools = flatten_namespace_tool_for_provider(
            "openai-chat",
            &json!({
                "type":"namespace",
                "name":"functions",
                "description":"Namespace docs.",
                "tools":[{
                    "type":"custom",
                    "name":"exec",
                    "description":"Leaf docs.",
                    "format":{"type":"grammar","syntax":"lark","definition":"start: WORD"}
                }]
            }),
        )
        .expect("registered Chat custom compatibility")
        .unwrap();
        assert_eq!(tools[0]["function"]["name"], "functions__exec");
        assert_eq!(
            tools[0]["function"]["parameters"],
            openai_chat_freeform_custom_tool_parameters()
        );
        assert_eq!(
            tools[0]["function"]["description"],
            "Namespace docs.\n\nLeaf docs.\nRouteCodex Chat custom-tool compatibility: source grammar syntax=lark definition=start: WORD; Chat function tools do not enforce this grammar. Put the exact raw string in input."
        );
    }

    #[test]
    fn responses_custom_namespace_keeps_documentation_and_format() {
        let flattened = flatten_namespace_tool_for_provider(
            "openai-responses",
            &json!({
                "type":"namespace",
                "name":"functions",
                "description":"Namespace docs.",
                "tools":[{
                    "type":"custom",
                    "name":"exec",
                    "description":"Leaf docs.",
                    "format":{"type":"text"}
                }]
            }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(flattened[0]["type"], "custom");
        assert_eq!(flattened[0]["name"], "functions__exec");
        assert_eq!(flattened[0]["description"], "Namespace docs.\n\nLeaf docs.");
        assert_eq!(flattened[0]["format"], json!({"type":"text"}));
    }
}
