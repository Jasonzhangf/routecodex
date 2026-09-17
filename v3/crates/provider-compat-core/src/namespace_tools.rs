use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// Normalize the provider-facing function name used in call history.
///
/// Codex may expose MCP calls in history as `functions.mcp__server.tool`,
/// while provider function names only allow ASCII letters, digits, `_`, and
/// `-`. MCP path separators are flattened to the namespace convention.
/// Unrelated names are preserved exactly.
pub fn canonical_provider_function_name(name: &str) -> String {
    let name = name
        .strip_prefix("functions.")
        .filter(|value| value.starts_with("mcp__"))
        .unwrap_or(name);
    if let Some(rest) = name.strip_prefix("mcp__") {
        if rest.contains('.') && rest.split('.').all(is_provider_function_name_component) {
            return format!("mcp__{}", rest.replace('.', "__"));
        }
    }
    if let Some((namespace, child)) = name.split_once('.') {
        if !child.is_empty()
            && !child.contains('.')
            && is_provider_function_name_component(namespace)
            && is_provider_function_name_component(child)
            && matches!(namespace, "servertool" | "mcp" | "native")
        {
            return format!("{namespace}__{child}");
        }
    }
    name.to_owned()
}

/// Apply the provider-facing function-name convention to every call-history
/// shape that can cross a provider wire.
///
/// This is the final wire projection, not a protocol codec. It normalizes
/// `function_call`, `custom_tool_call`, `tool_call`, `tool_use`, nested Chat
/// `function.name`, and Chat tool-result content part names while preserving
/// every unrelated field byte-for-byte. `tool_search` control history is
/// deliberately excluded because it carries client control semantics rather
/// than a provider function declaration.
pub fn normalize_provider_wire_function_names(body: &mut Value) {
    let Some(root) = body.as_object_mut() else {
        return;
    };
    if let Some(input) = root.get_mut("input").and_then(Value::as_array_mut) {
        for item in input {
            normalize_provider_wire_history_item(item);
        }
    }
    if let Some(messages) = root.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            normalize_provider_wire_message(message);
        }
    }
}

/// Qualify namespace-less Responses-origin MCP history from the current
/// provider tool declaration set.
///
/// The mapping is applied only when a provider tool set exposes exactly one
/// MCP tool with the same leaf name and no ordinary function with that name.
/// Custom calls, unrelated native functions, and ambiguous leaves remain
/// unchanged.
pub fn qualify_openai_chat_missing_mcp_tool_call_names(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    let Some(tools) = root.get("tools").and_then(Value::as_array).cloned() else {
        return;
    };
    let Some(messages) = root.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let mut qualified_by_leaf = HashMap::<String, Option<String>>::new();
    let mut ordinary_callable_names = HashSet::new();
    for tool in &tools {
        if let Ok(Some(children)) = flatten_namespace_tool_for_provider("openai-chat", tool) {
            for child in children {
                if let Some(name) = provider_function_tool_name(&child) {
                    insert_provider_mcp_name(&mut qualified_by_leaf, name);
                }
            }
            continue;
        }
        if let Some(name) = provider_function_tool_name(tool) {
            if mcp_tool_leaf_name(name).is_some() {
                insert_provider_mcp_name(&mut qualified_by_leaf, name);
            } else {
                ordinary_callable_names.insert(name.to_owned());
            }
        }
    }
    for name in ordinary_callable_names {
        if qualified_by_leaf.contains_key(&name) {
            qualified_by_leaf.insert(name, None);
        }
    }
    if qualified_by_leaf.is_empty() {
        return;
    }
    for message in messages {
        let Some(message_row) = message.as_object_mut() else {
            continue;
        };
        let Some(tool_calls) = message_row
            .get_mut("tool_calls")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for tool_call in tool_calls {
            let Some(tool_call_row) = tool_call.as_object_mut() else {
                continue;
            };
            if is_custom_tool_call(tool_call_row) || !has_responses_item_id(tool_call_row) {
                continue;
            }
            let Some(name) = tool_call_row
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            if name.starts_with("mcp__") {
                continue;
            }
            let Some(qualified) = qualified_by_leaf.get(&name).and_then(Option::as_ref) else {
                continue;
            };
            if let Some(function) = tool_call_row
                .get_mut("function")
                .and_then(Value::as_object_mut)
            {
                function.insert("name".to_string(), Value::String(qualified.clone()));
            }
        }
    }
}

/// Restore a flattened provider MCP function name into the reversible
/// Responses client shape (`namespace` + leaf `name`).
pub fn restore_responses_mcp_namespace(object: &mut Map<String, Value>) -> bool {
    if object.get("namespace").is_some() {
        return false;
    }
    let Some(name) = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return false;
    };
    let Some(rest) = name.strip_prefix("mcp__") else {
        return false;
    };
    // Provider wire flattens a client namespace path into
    // `mcp__<server>[__<nested>...]__<tool>`: the tool is the last segment and
    // every earlier segment is namespace path. Using the last separator keeps
    // nested declarations (mcp__mcpx__workspace__read) reversible to
    // namespace `mcp__mcpx__workspace` + name `read` instead of gluing the
    // remaining path onto the tool name.
    let Some((namespace, tool)) = rest.rsplit_once("__") else {
        return false;
    };
    if namespace.is_empty() || tool.is_empty() {
        return false;
    }
    object.insert(
        "namespace".to_owned(),
        Value::String(format!("mcp__{namespace}")),
    );
    object.insert("name".to_owned(), Value::String(tool.to_owned()));
    true
}

fn is_custom_tool_call(tool_call: &Map<String, Value>) -> bool {
    tool_call
        .get("routecodex_chat_extension")
        .and_then(Value::as_object)
        .and_then(|extension| extension.get("responses_tool_call_type"))
        .and_then(Value::as_str)
        == Some("custom_tool_call")
}

fn has_responses_item_id(tool_call: &Map<String, Value>) -> bool {
    tool_call
        .get("routecodex_chat_extension")
        .and_then(Value::as_object)
        .and_then(|extension| extension.get("responses_item_id"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn provider_function_tool_name(tool: &Value) -> Option<&str> {
    tool.get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .or_else(|| tool.get("name").and_then(Value::as_str))
}

fn insert_provider_mcp_name(map: &mut HashMap<String, Option<String>>, name: &str) {
    let Some(leaf) = mcp_tool_leaf_name(name) else {
        return;
    };
    match map.get(leaf) {
        Some(Some(existing)) if existing != name => {
            map.insert(leaf.to_string(), None);
        }
        None => {
            map.insert(leaf.to_string(), Some(name.to_string()));
        }
        _ => {}
    }
}

fn mcp_tool_leaf_name(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("mcp__")?;
    let (_, tool) = rest.rsplit_once("__")?;
    (!tool.is_empty()).then_some(tool)
}

fn normalize_provider_wire_history_item(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                normalize_provider_wire_history_item(item);
            }
        }
        Value::Object(object) => {
            let kind = object
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if matches!(
                kind.as_deref(),
                Some("tool_search_call" | "tool_search_output")
            ) {
                return;
            }
            if matches!(
                kind.as_deref(),
                Some("function_call" | "custom_tool_call" | "tool_call" | "tool_use")
            ) {
                normalize_provider_wire_name_field(object, "name");
            }
            if matches!(kind.as_deref(), Some("tool_result")) {
                normalize_provider_wire_name_field(object, "name");
            }
            if let Some(content) = object.get_mut("content") {
                normalize_provider_wire_history_item(content);
            }
        }
        _ => {}
    }
}

fn normalize_provider_wire_message(value: &mut Value) {
    let Some(message) = value.as_object_mut() else {
        return;
    };
    let tool_search_control = message
        .get("routecodex_chat_extension")
        .and_then(Value::as_object)
        .is_some_and(|extension| {
            extension
                .get("responses_tool_call_type")
                .and_then(Value::as_str)
                .is_some_and(|kind| matches!(kind, "tool_search_call" | "tool_search_output"))
                || extension
                    .get("responses_tool_output_type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind == "tool_search_output")
        });
    if tool_search_control {
        return;
    }
    if let Some(tool_calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) {
        for tool_call in tool_calls {
            let Some(tool_call) = tool_call.as_object_mut() else {
                continue;
            };
            if let Some(function) = tool_call.get_mut("function").and_then(Value::as_object_mut) {
                normalize_provider_wire_name_field(function, "name");
            }
        }
    }
    if let Some(content) = message.get_mut("content") {
        normalize_provider_wire_history_item(content);
    }
}

fn normalize_provider_wire_name_field(object: &mut Map<String, Value>, field: &str) {
    let Some(name) = object.get(field).and_then(Value::as_str) else {
        return;
    };
    let normalized = canonical_provider_function_name(name);
    if normalized != name {
        object.insert(field.to_string(), Value::String(normalized));
    }
}

fn is_provider_function_name_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

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
    fn canonical_provider_function_name_normalizes_codex_mcp_history() {
        assert_eq!(
            canonical_provider_function_name("functions.mcp__codex_review__review_start"),
            "mcp__codex_review__review_start"
        );
        assert_eq!(
            canonical_provider_function_name("mcp__mcpx.workspace.read"),
            "mcp__mcpx__workspace__read"
        );
        assert_eq!(
            canonical_provider_function_name("servertool.search"),
            "servertool__search"
        );
    }

    #[test]
    fn canonical_provider_function_name_preserves_unrelated_names() {
        assert_eq!(
            canonical_provider_function_name("functions.lookup"),
            "functions.lookup"
        );
        assert_eq!(canonical_provider_function_name("lookup"), "lookup");
        assert_eq!(
            canonical_provider_function_name("mcp__bad.name!"),
            "mcp__bad.name!"
        );
    }

    #[test]
    fn provider_wire_normalization_covers_call_history_shapes() {
        let mut body = json!({
            "input": [
                {"type":"function_call","name":"functions.mcp__codex_review__review_start"},
                {"type":"custom_tool_call","name":"mcp__mcpx.workspace.read"},
                {"type":"tool_use","name":"servertool.search"}
            ],
            "messages": [{
                "role":"assistant",
                "tool_calls": [{
                    "type":"function",
                    "function":{"name":"functions.mcp__codex_review__review_start"}
                }],
                "content":[{"type":"tool_result","name":"mcp__mcpx.workspace.read"}]
            }]
        });
        normalize_provider_wire_function_names(&mut body);
        assert_eq!(body["input"][0]["name"], "mcp__codex_review__review_start");
        assert_eq!(body["input"][1]["name"], "mcp__mcpx__workspace__read");
        assert_eq!(body["input"][2]["name"], "servertool__search");
        assert_eq!(
            body["messages"][0]["tool_calls"][0]["function"]["name"],
            "mcp__codex_review__review_start"
        );
        assert_eq!(
            body["messages"][0]["content"][0]["name"],
            "mcp__mcpx__workspace__read"
        );
    }

    #[test]
    fn provider_wire_normalization_preserves_tool_search_control_history() {
        let mut body = json!({
            "input": [{
                "type":"tool_search_call",
                "name":"mcp__mcpx.workspace",
                "tools": [{
                    "type":"function",
                    "name":"functions.mcp__codex_review__review_start"
                }]
            }, {
                "type":"tool_search_output",
                "tools": [{
                    "type":"function",
                    "name":"functions.mcp__codex_review__review_start"
                }]
            }]
        });
        normalize_provider_wire_function_names(&mut body);
        assert_eq!(body["input"][0]["name"], "mcp__mcpx.workspace");
        assert_eq!(
            body["input"][0]["tools"][0]["name"],
            "functions.mcp__codex_review__review_start"
        );
        assert_eq!(
            body["input"][1]["tools"][0]["name"],
            "functions.mcp__codex_review__review_start"
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
