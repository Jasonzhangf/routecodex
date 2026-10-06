use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// OpenAI Chat permits at most 64 characters. The current request declaration
/// supplies the inverse identity; other protocols keep their own representation.
pub fn openai_chat_namespace_wire_name(name: &str) -> String {
    if name.len() <= 64 {
        name.to_owned()
    } else {
        format!("{:x}", Sha256::digest(name.as_bytes()))
    }
}

/// Allocate aliases against every current declaration, including plain tools.
pub fn openai_chat_namespace_wire_names(
    namespace_names: BTreeSet<String>,
    mut used: BTreeSet<String>,
) -> HashMap<String, String> {
    let mut aliases = HashMap::new();
    for name in namespace_names.into_iter().filter(|name| name.len() > 64) {
        let base = openai_chat_namespace_wire_name(&name);
        let mut alias = base.clone();
        let mut collision = 0;
        while !used.insert(alias.clone()) {
            collision += 1;
            let suffix = format!("_{collision}");
            alias = format!("{}{}", &base[..64 - suffix.len()], suffix);
        }
        // The emitter emits the hashed wire form for over-length names, so key
        // the alias by that wire form. The unhashed `name` only selects the
        // length threshold and the alias suffix.
        aliases.insert(base, alias);
    }
    aliases
}

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

/// Canonical client dispatch identity used to compare Responses declarations
/// that encode the same MCP tool with a namespace object or a flattened alias.
pub fn normalize_client_tool_dispatch_name(name: &str) -> String {
    let client_name = name
        .strip_prefix("functions.mcp__")
        .map(|rest| format!("mcp__{rest}"))
        .unwrap_or_else(|| name.to_owned());
    if client_name
        .strip_prefix("mcp__")
        .is_some_and(|rest| rest.contains('.'))
    {
        return client_name;
    }
    let normalized = normalize_provider_function_name(&client_name);
    let Some(rest) = normalized.strip_prefix("mcp__") else {
        return normalized;
    };
    let Some((namespace, tool)) = rest.rsplit_once("__") else {
        return normalized;
    };
    if namespace.is_empty() || tool.is_empty() {
        return normalized;
    }
    format!("mcp__{}", rest.replace("__", "."))
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

/// Remove declarations superseded by a later Responses `additional_tools`
/// declaration while the original source precedence is still available.
pub fn remove_refreshed_provider_tools(
    tools: &mut Vec<Value>,
    refreshed_provider_tool_names: &BTreeSet<String>,
) {
    tools.retain_mut(|tool| {
        if tool.get("type").and_then(Value::as_str) == Some("namespace") {
            retain_unshadowed_namespace_children(tool, refreshed_provider_tool_names);
            tool.get("tools")
                .and_then(Value::as_array)
                .is_some_and(|children| !children.is_empty())
        } else {
            !provider_function_tool_name(tool).is_some_and(|name| {
                refreshed_provider_tool_names.contains(&normalize_provider_function_name(name))
            })
        }
    });
}

pub fn resolve_responses_tool_declarations(request: &Value) -> Result<Vec<Value>, String> {
    let mut tools = request
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let refreshed_provider_tool_names = validate_namespace_tool_dispatch_names(request)?;
    remove_refreshed_provider_tools(&mut tools, &refreshed_provider_tool_names);
    Ok(tools)
}

fn retain_unshadowed_namespace_children(
    namespace: &mut Value,
    refreshed_provider_tool_names: &BTreeSet<String>,
) {
    let Some(object) = namespace.as_object_mut() else {
        return;
    };
    let Some(namespace_name) = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
    else {
        return;
    };
    let Some(children) = object.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    retain_unshadowed_namespace_tool_list(&namespace_name, children, refreshed_provider_tool_names);
}

fn retain_unshadowed_namespace_tool_list(
    namespace_name: &str,
    children: &mut Vec<Value>,
    refreshed_provider_tool_names: &BTreeSet<String>,
) {
    children.retain_mut(|child| {
        let Some(child_object) = child.as_object() else {
            return true;
        };
        match child_object.get("type").and_then(Value::as_str) {
            Some("namespace") => {
                let nested_namespace = child_object
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(|name| format!("{namespace_name}__{name}"));
                let Some(nested_namespace) = nested_namespace else {
                    return true;
                };
                let Some(nested_tools) = child.get_mut("tools").and_then(Value::as_array_mut)
                else {
                    return true;
                };
                retain_unshadowed_namespace_tool_list(
                    &nested_namespace,
                    nested_tools,
                    refreshed_provider_tool_names,
                );
                !nested_tools.is_empty()
            }
            Some("function" | "custom") => {
                let child_name = child_object
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("name"))
                    .or_else(|| child_object.get("name"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty());
                let Some(child_name) = child_name else {
                    return true;
                };
                let provider_name = if child_name == namespace_name
                    || child_name.starts_with(&format!("{namespace_name}__"))
                {
                    child_name.to_string()
                } else {
                    format!("{namespace_name}__{child_name}")
                };
                !refreshed_provider_tool_names.contains(&provider_name)
            }
            _ => true,
        }
    });
}

/// A provider name must identify exactly one client declaration before tool
/// declarations are flattened or deduplicated on the provider wire.
pub fn validate_namespace_tool_dispatch_names(request: &Value) -> Result<BTreeSet<String>, String> {
    let mut identities = BTreeMap::<String, (String, String, Value, bool)>::new();
    let mut refreshed_names = BTreeSet::new();
    let mut tool_lists = Vec::new();
    if let Some(tools) = request.get("tools") {
        tool_lists.push((tools, false));
    }
    for item in request
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("additional_tools"))
    {
        if let Some(tools) = item.get("tools") {
            tool_lists.push((tools, true));
        }
    }
    for (tools, is_additional_tools) in tool_lists {
        for tool in tools.as_array().into_iter().flatten() {
            if let Some(names) = namespace_tool_dispatch_map(tool)? {
                for (client_name, (provider_name, declaration)) in names {
                    insert_dispatch_identity(
                        &mut identities,
                        &mut refreshed_names,
                        &provider_name,
                        &client_name,
                        tool_dispatch_kind(&declaration),
                        &declaration,
                        is_additional_tools,
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
                        &mut refreshed_names,
                        &provider_name,
                        &normalize_client_tool_dispatch_name(name),
                        tool_dispatch_kind(&declaration),
                        &declaration,
                        is_additional_tools,
                    )?;
                }
            }
        }
    }
    Ok(refreshed_names)
}

fn tool_dispatch_kind(declaration: &Value) -> String {
    declaration
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn insert_dispatch_identity(
    identities: &mut BTreeMap<String, (String, String, Value, bool)>,
    refreshed_names: &mut BTreeSet<String>,
    provider_name: &str,
    client_name: &str,
    kind: String,
    declaration: &Value,
    is_additional_tools: bool,
) -> Result<(), String> {
    if let Some((existing, existing_kind, previous, existing_is_additional_tools)) =
        identities.get(provider_name)
    {
        if existing != client_name || existing_kind != &kind {
            return Err(format!(
                "ConflictingOutboundFields provider tool name `{provider_name}` has conflicting declarations for client tools `{existing}` and `{client_name}`"
            ));
        }
        if previous != declaration {
            if *existing_is_additional_tools || !is_additional_tools {
                return Err(format!(
                    "ConflictingOutboundFields provider tool name `{provider_name}` has conflicting schemas within the same declaration source"
                ));
            }
            refreshed_names.insert(provider_name.to_string());
        }
        identities.insert(
            provider_name.to_owned(),
            (
                client_name.to_owned(),
                kind,
                declaration.clone(),
                is_additional_tools,
            ),
        );
    } else {
        identities.insert(
            provider_name.to_owned(),
            (
                client_name.to_owned(),
                kind,
                declaration.clone(),
                is_additional_tools,
            ),
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

/// One flattened provider tool together with the index path of the namespace
/// child that produced it. `source_child_indices` is accumulated explicitly
/// during the recursive traversal, so a nested namespace child carries every
/// child index from the outer namespace down to the emitting leaf. These are
/// structural indices only; the emitted tool value is never modified.
#[derive(Clone, Debug, PartialEq)]
pub struct NamespaceToolEmission {
    pub source_child_indices: Vec<usize>,
    pub destination_index: usize,
}

/// Flattening result: the unchanged provider tools plus, for each of them, the
/// namespace child that emitted it.
#[derive(Clone, Debug, PartialEq)]
pub struct NamespaceToolProjection {
    pub tools: Vec<Value>,
    pub sources: Vec<NamespaceToolEmission>,
}

pub fn flatten_namespace_tool_for_provider(
    protocol: &str,
    tool: &Value,
) -> Result<Option<Vec<Value>>, String> {
    Ok(
        flatten_namespace_tool_for_provider_with_sources(protocol, tool)?
            .map(|projection| projection.tools),
    )
}

pub fn flatten_namespace_tool_for_provider_with_sources(
    protocol: &str,
    tool: &Value,
) -> Result<Option<NamespaceToolProjection>, String> {
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

    let mut projection = NamespaceToolProjection {
        tools: Vec::with_capacity(children.len()),
        sources: Vec::new(),
    };
    let mut child_index_path = Vec::new();
    flatten_namespace_children(
        protocol,
        &namespace_name,
        children,
        &format!("provider namespace tool {namespace_name}"),
        &mut projection,
        &mut child_index_path,
    )?;
    Ok(Some(projection))
}

fn push_flattened_namespace_tool(
    projection: &mut NamespaceToolProjection,
    source_child_indices: &[usize],
    tool: Value,
) {
    let destination_index = projection.tools.len();
    projection.tools.push(tool);
    projection.sources.push(NamespaceToolEmission {
        source_child_indices: source_child_indices.to_vec(),
        destination_index,
    });
}

fn flatten_namespace_children(
    protocol: &str,
    namespace_name: &str,
    children: &[Value],
    path: &str,
    projection: &mut NamespaceToolProjection,
    child_index_path: &mut Vec<usize>,
) -> Result<(), String> {
    for (index, child) in children.iter().enumerate() {
        let child = child
            .as_object()
            .ok_or_else(|| format!("{path}.tools[{index}] must be an object"))?;
        child_index_path.push(index);
        let result = match child.get("type").and_then(Value::as_str) {
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
                    projection,
                    child_index_path,
                )
            }
            Some("function") => flatten_namespace_function(
                protocol,
                namespace_name,
                child,
                &format!("{path}.tools[{index}]"),
                projection,
                child_index_path,
            ),
            Some("custom") => flatten_namespace_custom(
                protocol,
                namespace_name,
                child,
                &format!("{path}.tools[{index}]"),
                projection,
                child_index_path,
            ),
            _ => Err(format!(
                "{path}.tools[{index}].type must be namespace, function, or custom"
            )),
        };
        child_index_path.pop();
        result?;
    }
    Ok(())
}

fn flatten_namespace_custom(
    protocol: &str,
    namespace_name: &str,
    child: &Map<String, Value>,
    child_path: &str,
    projection: &mut NamespaceToolProjection,
    child_index_path: &mut Vec<usize>,
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
    push_flattened_namespace_tool(
        projection,
        child_index_path,
        build_provider_function_tool(
            protocol,
            namespace_name,
            name,
            description,
            Some(openai_chat_freeform_custom_tool_parameters()),
            None,
        ),
    );
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
    projection: &mut NamespaceToolProjection,
    child_index_path: &mut Vec<usize>,
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
    push_flattened_namespace_tool(
        projection,
        child_index_path,
        build_provider_function_tool(
            protocol,
            namespace_name,
            child_name,
            description,
            parameters,
            strict,
        ),
    );
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
    let qualified_name = if protocol == "openai-chat" {
        openai_chat_namespace_wire_name(&qualified_name)
    } else {
        qualified_name
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

    provider_function_tool_envelope(protocol, function)
}

/// The single owner of the flat-vs-nested provider function-tool rule: the
/// Responses wire declares a function tool flat, every other protocol nests the
/// function members under `function`.
fn provider_function_tool_envelope(protocol: &str, function: Map<String, Value>) -> Value {
    let mut output = Map::new();
    output.insert("type".to_string(), Value::String("function".to_string()));
    if protocol == "openai-responses" {
        output.extend(function);
    } else {
        output.insert("function".to_string(), Value::Object(function));
    }
    Value::Object(output)
}

/// Projects a canonical Chat function tool (`{"type":"function","function":{...}}`)
/// into the target protocol's declared function-tool shape. The canonical
/// extension slot and any function member that is not a declared function-tool
/// field stay out of the provider declaration. Returns `None` when the value is
/// not a canonical Chat function tool, so hosted and custom declarations keep
/// their own representation and a repeated call is a no-op.
pub fn provider_function_tool_from_canonical(protocol: &str, tool: &Value) -> Option<Value> {
    let function = tool.get("function").and_then(Value::as_object)?;
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    let mut declared = Map::new();
    declared.insert("name".to_string(), Value::String(name.to_string()));
    for key in ["description", "parameters", "strict"] {
        if let Some(value) = function.get(key) {
            declared.insert(key.to_string(), value.clone());
        }
    }
    Some(provider_function_tool_envelope(protocol, declared))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn client_dispatch_identity_unifies_flat_mcp_aliases() {
        assert_eq!(
            normalize_client_tool_dispatch_name("functions.mcp__mcpx__workspace"),
            "mcp__mcpx.workspace"
        );
        assert_eq!(
            normalize_client_tool_dispatch_name("mcp__mcpx.workspace"),
            "mcp__mcpx.workspace"
        );
        assert_eq!(
            normalize_client_tool_dispatch_name("mcp__mcpx__workspace__read"),
            "mcp__mcpx.workspace.read"
        );
        assert_eq!(
            normalize_client_tool_dispatch_name("mcp__mcpx.foo__bar"),
            "mcp__mcpx.foo__bar"
        );
        assert_eq!(
            normalize_client_tool_dispatch_name("functions.mcp__mcpx.foo__bar"),
            "mcp__mcpx.foo__bar"
        );
    }

    #[test]
    fn dispatch_names_reject_flattened_collision_with_underscored_tool_leaf() {
        let error = validate_namespace_tool_dispatch_names(&json!({
            "tools":[
                {"type":"function","name":"mcp__mcpx.foo__bar","parameters":{"type":"object"}},
                {"type":"namespace","name":"mcp__mcpx","tools":[
                    {"type":"namespace","name":"foo","tools":[
                        {"type":"function","name":"bar","parameters":{"type":"object"}}
                    ]}
                ]}
            ]
        }))
        .expect_err("one flattened provider name cannot identify two client paths");

        assert!(error.contains("mcp__mcpx__foo__bar"), "{error}");
        assert!(error.contains("mcp__mcpx.foo__bar"), "{error}");
        assert!(error.contains("mcp__mcpx.foo.bar"), "{error}");
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
    fn projects_canonical_function_tool_into_the_provider_envelope() {
        let canonical = json!({
            "type": "function",
            "function": {
                "name": "lookup",
                "description": "Lookup docs",
                "parameters": {"type": "object"}
            },
            "extension": {"raw_declaration": {"name": "lookup"}}
        });

        let responses =
            provider_function_tool_from_canonical("openai-responses", &canonical).unwrap();
        assert_eq!(responses["type"], "function");
        assert_eq!(responses["name"], "lookup");
        assert_eq!(responses["description"], "Lookup docs");
        assert_eq!(responses["parameters"]["type"], "object");
        assert!(responses.get("function").is_none());
        assert!(responses.get("extension").is_none());

        let chat = provider_function_tool_from_canonical("openai-chat", &canonical).unwrap();
        assert_eq!(chat["type"], "function");
        assert_eq!(chat["function"]["name"], "lookup");
        assert!(chat.get("name").is_none());
    }

    #[test]
    fn canonical_function_tool_projection_leaves_other_declarations_untouched() {
        // Hosted and custom declarations keep their own provider representation,
        // and an already projected tool is not a canonical Chat function tool.
        // The projection therefore cannot run twice on the same wire value.
        let hosted = json!({"type": "web_search"});
        assert!(provider_function_tool_from_canonical("openai-responses", &hosted).is_none());

        let custom = json!({"type": "custom", "name": "apply_patch", "format": {"type": "text"}});
        assert!(provider_function_tool_from_canonical("openai-responses", &custom).is_none());

        let flat = json!({"type": "function", "name": "lookup", "parameters": {"type": "object"}});
        assert!(provider_function_tool_from_canonical("openai-responses", &flat).is_none());
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

        assert!(refreshed.contains("mcp__mcpx__workspace__read"));
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
        let error = validate_namespace_tool_dispatch_names(&json!({
            "tools":[first_namespace, second_namespace]
        }))
        .expect_err("different client dispatch identities remain ambiguous");
        assert!(error.contains("mcp__a__b__c"), "{error}");
    }

    #[test]
    fn dispatch_names_still_reject_function_and_custom_kind_collision() {
        let function = json!({"type":"function","name":"exec","parameters":openai_chat_freeform_custom_tool_parameters()});
        let custom = json!({"type":"custom","name":"exec","format":{"type":"text"}});
        let error = validate_namespace_tool_dispatch_names(&json!({"tools":[function,custom]}))
            .expect_err("different tool kinds cannot share one provider dispatch name");
        assert!(error.contains("exec"), "{error}");
    }
}
