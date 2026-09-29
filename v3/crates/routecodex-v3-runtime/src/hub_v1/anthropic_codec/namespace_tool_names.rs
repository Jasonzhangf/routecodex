use super::*;

pub(super) fn anthropic_tool_call_wire_name(name: &str, is_custom: bool) -> String {
    if is_custom {
        name.to_owned()
    } else {
        super::super::request_outbound_mcp_names::provider_function_name(name)
    }
}

pub(super) fn anthropic_namespace_wire_name(namespace: &str, name: &str) -> String {
    format!(
        "{namespace}__{}",
        super::super::request_outbound_mcp_names::provider_function_name(name)
    )
}

pub(super) fn validate_anthropic_declared_tool_names(request: &Value) -> Result<(), String> {
    let mut identities = BTreeMap::<String, (String, String, Value, bool)>::new();
    collect_dispatch_identities(request.get("tools"), &mut identities, false)?;
    for item in request
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            collect_dispatch_identities(item.get("tools"), &mut identities, true)?;
        }
    }
    Ok(())
}

fn collect_dispatch_identities(
    tools: Option<&Value>,
    identities: &mut BTreeMap<String, (String, String, Value, bool)>,
    is_additional_tools: bool,
) -> Result<(), String> {
    for tool in tools.and_then(Value::as_array).into_iter().flatten() {
        let kind = tool.get("type").and_then(Value::as_str);
        if kind == Some("namespace") {
            let Some(name) = tool.get("name").and_then(Value::as_str) else {
                continue;
            };
            collect_namespace_dispatch_identities(
                tool,
                name,
                name,
                identities,
                is_additional_tools,
            )?;
        } else if matches!(kind, Some("function" | "custom")) {
            let name = tool
                .get("name")
                .or_else(|| {
                    tool.get("function")
                        .and_then(|function| function.get("name"))
                })
                .and_then(Value::as_str);
            if let Some(name) = name {
                let provider_name = if kind == Some("function") {
                    super::super::request_outbound_mcp_names::provider_function_name(name)
                } else {
                    name.to_string()
                };
                insert_dispatch_identity(
                    identities,
                    &provider_name,
                    &provider_compat_core::namespace_tools::normalize_client_tool_dispatch_name(
                        name,
                    ),
                    kind.unwrap_or_default(),
                    tool,
                    is_additional_tools,
                )?;
            }
        }
    }
    Ok(())
}

fn collect_namespace_dispatch_identities(
    namespace: &Value,
    client_namespace: &str,
    wire_namespace: &str,
    identities: &mut BTreeMap<String, (String, String, Value, bool)>,
    is_additional_tools: bool,
) -> Result<(), String> {
    for child in namespace
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name) = child
            .get("name")
            .or_else(|| {
                child
                    .get("function")
                    .and_then(|function| function.get("name"))
            })
            .and_then(Value::as_str)
        else {
            continue;
        };
        let client_name = format!("{client_namespace}.{name}");
        match child.get("type").and_then(Value::as_str) {
            Some("namespace") => collect_namespace_dispatch_identities(
                child,
                &client_name,
                name,
                identities,
                is_additional_tools,
            )?,
            Some(kind @ ("function" | "custom")) => insert_dispatch_identity(
                identities,
                &anthropic_namespace_wire_name(wire_namespace, name),
                &client_name,
                kind,
                child,
                is_additional_tools,
            )?,
            _ => {}
        }
    }
    Ok(())
}

fn insert_dispatch_identity(
    identities: &mut BTreeMap<String, (String, String, Value, bool)>,
    provider_name: &str,
    client_name: &str,
    kind: &str,
    declaration: &Value,
    is_additional_tools: bool,
) -> Result<(), String> {
    if let Some((existing, existing_kind, previous, previous_is_additional_tools)) =
        identities.get(provider_name)
    {
        if existing != client_name || existing_kind != kind {
            return Err(format!(
                "Anthropic provider tool name {provider_name} has conflicting declarations for {existing} and {client_name}"
            ));
        }
        if previous != declaration && (*previous_is_additional_tools || !is_additional_tools) {
            return Err(format!(
                "Anthropic provider tool name {provider_name} has conflicting schemas within the same declaration source"
            ));
        }
    }
    identities.insert(
        provider_name.to_string(),
        (
            client_name.to_string(),
            kind.to_string(),
            declaration.clone(),
            is_additional_tools,
        ),
    );
    Ok(())
}

pub(super) fn anthropic_declared_tool_names(
    request: &Value,
) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    let mut history = BTreeMap::new();
    let mut custom_reverse = BTreeMap::new();
    collect_declared_names(request.get("tools"), &mut history, &mut custom_reverse);
    for item in request
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            collect_declared_names(item.get("tools"), &mut history, &mut custom_reverse);
        }
    }
    (history, custom_reverse)
}

fn collect_declared_names(
    tools: Option<&Value>,
    history: &mut BTreeMap<String, String>,
    custom_reverse: &mut BTreeMap<String, String>,
) {
    for tool in tools.and_then(Value::as_array).into_iter().flatten() {
        match tool.get("type").and_then(Value::as_str) {
            Some("namespace") => {
                if let Some(namespace) = tool.get("name").and_then(Value::as_str) {
                    collect_namespace_names(tool, namespace, namespace, history, custom_reverse);
                }
            }
            Some("custom") => {
                if let Some(name) = tool.get("name").and_then(Value::as_str) {
                    custom_reverse.insert(name.to_string(), name.to_string());
                }
            }
            _ => {}
        }
    }
}

fn collect_namespace_names(
    namespace: &Value,
    client_namespace: &str,
    wire_namespace: &str,
    history: &mut BTreeMap<String, String>,
    custom_reverse: &mut BTreeMap<String, String>,
) {
    for child in namespace
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name) = child
            .get("name")
            .or_else(|| child.get("function").and_then(|f| f.get("name")))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let client_name = format!("{client_namespace}.{name}");
        match child.get("type").and_then(Value::as_str) {
            Some("namespace") => {
                collect_namespace_names(child, &client_name, name, history, custom_reverse)
            }
            Some("function" | "custom") => {
                let provider_name = anthropic_namespace_wire_name(wire_namespace, name);
                history.insert(client_name.clone(), provider_name.clone());
                if child.get("type").and_then(Value::as_str) == Some("custom") {
                    custom_reverse.insert(provider_name, client_name);
                }
            }
            _ => {}
        }
    }
}

pub(super) fn rewrite_anthropic_declared_tool_history(request: &mut Value) {
    let (names, _) = anthropic_declared_tool_names(request);
    if let Some(choice) = request
        .get_mut("tool_choice")
        .and_then(Value::as_object_mut)
    {
        if let Some(name) = choice
            .get("name")
            .and_then(Value::as_str)
            .and_then(|name| names.get(name))
        {
            choice.insert("name".to_string(), Value::String(name.clone()));
        }
        if let Some(function) = choice.get_mut("function").and_then(Value::as_object_mut) {
            if let Some(name) = function
                .get("name")
                .and_then(Value::as_str)
                .and_then(|name| names.get(name))
            {
                function.insert("name".to_string(), Value::String(name.clone()));
            }
        }
    }
    for message in request
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        for call in message
            .get_mut("tool_calls")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(function) = call.get_mut("function").and_then(Value::as_object_mut) {
                if let Some(name) = function
                    .get("name")
                    .and_then(Value::as_str)
                    .and_then(|name| names.get(name))
                {
                    function.insert("name".to_string(), Value::String(name.clone()));
                }
            }
        }
    }
    for item in request
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call" | "custom_tool_call" | "tool_call")
        ) {
            if let Some(name) = item
                .get("name")
                .and_then(Value::as_str)
                .and_then(|name| names.get(name))
                .cloned()
            {
                item["name"] = Value::String(name);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn anthropic_rejects_distinct_custom_tools_with_same_provider_name() {
        let input = json!({
            "model": "glm-5.3",
            "tools": [
                {"type": "namespace", "name": "functions", "tools": [
                    {"type": "custom", "name": "exec", "format": {"type": "text"}}
                ]},
                {"type": "custom", "name": "functions__exec", "format": {"type": "text"}}
            ],
            "messages": [{"role": "user", "content": "use a tool"}]
        });
        let error = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
            .expect_err("two client tools must not share one Anthropic dispatch name");
        assert!(error.to_string().contains("functions__exec"), "{error}");
    }

    #[test]
    fn anthropic_rejects_nested_namespace_collision_in_both_orders_and_additional_tools() {
        let nested = json!({"type":"namespace","name":"functions","tools":[
            {"type":"namespace","name":"mcp__mcpx","tools":[
                {"type":"custom","name":"exec","format":{"type":"text"}}
            ]}
        ]});
        let flat = json!({"type":"custom","name":"mcp__mcpx__exec","format":{"type":"text"}});
        for tools in [
            vec![nested.clone(), flat.clone()],
            vec![flat.clone(), nested.clone()],
        ] {
            let input = json!({"model":"glm-5.3","tools":tools,"messages":[{"role":"user","content":"use a tool"}]});
            let error = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
                .expect_err("distinct client tools must not share an Anthropic dispatch name");
            assert!(error.to_string().contains("mcp__mcpx__exec"), "{error}");
        }
        let input = json!({"model":"glm-5.3","tools":[nested],"input":[
            {"type":"additional_tools","tools":[flat]},
            {"role":"user","content":"use a tool"}
        ]});
        let error = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
            .expect_err("additional_tools must be checked against declared namespace tools");
        assert!(error.to_string().contains("mcp__mcpx__exec"), "{error}");
    }

    #[test]
    fn anthropic_rejects_normalized_function_custom_collision() {
        let function =
            json!({"type":"function","name":"mcp__mcpx.exec","parameters":{"type":"object"}});
        let custom = json!({"type":"custom","name":"mcp__mcpx__exec","format":{"type":"text"}});
        for tools in [
            vec![function.clone(), custom.clone()],
            vec![custom.clone(), function.clone()],
        ] {
            let input = json!({"model":"glm-5.3","tools":tools,"messages":[{"role":"user","content":"use a tool"}]});
            let error = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
                .expect_err("normalized provider names must be unique");
            assert!(error.to_string().contains("mcp__mcpx__exec"), "{error}");
        }
        let input = json!({"model":"glm-5.3","tools":[function],"input":[
            {"type":"additional_tools","tools":[custom]},
            {"role":"user","content":"use a tool"}
        ]});
        let error = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
            .expect_err("additional tools share the same provider dispatch space");
        assert!(error.to_string().contains("mcp__mcpx__exec"), "{error}");
    }

    #[test]
    fn anthropic_uses_latest_declaration_for_same_namespace_tool_identity() {
        let first = json!({"type":"namespace","name":"mcp__collab","tools":[
            {"type":"function","name":"collab_context","parameters":{"type":"object","properties":{"old":{"type":"string"}}}}
        ]});
        let second = json!({"type":"namespace","name":"mcp__collab","tools":[
            {"type":"function","name":"collab_context","parameters":{"type":"object","properties":{"query":{"type":"string"}}}}
        ]});
        let input = json!({"model":"glm-5.3","tools":[first],"input":[
            {"type":"additional_tools","tools":[second]},
            {"role":"user","content":"use a tool"}
        ]});
        let projected = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
            .expect("same namespace tool identity must not fail because its schema was refreshed");
        assert_eq!(projected["tools"].as_array().unwrap().len(), 1);
        assert_eq!(projected["tools"][0]["name"], "mcp__collab__collab_context");
        assert_eq!(
            projected["tools"][0]["input_schema"]["properties"]["query"]["type"],
            "string"
        );
    }

    #[test]
    fn anthropic_rejects_conflicting_schema_within_same_tools_declaration_source() {
        let input = json!({"tools":[
            {"type":"namespace","name":"mcp__collab","tools":[
                {"type":"function","name":"collab_context","description":"old","parameters":{"type":"object","properties":{"old":{"type":"string"}}}}
            ]},
            {"type":"namespace","name":"mcp__collab","tools":[
                {"type":"function","name":"collab_context","description":"new","parameters":{"type":"object","properties":{"new":{"type":"string"}}}}
            ]}
        ]});

        let error = super::validate_anthropic_declared_tool_names(&input)
            .expect_err("same-source schema conflicts must not select the later schema");

        assert!(error.contains("mcp__collab__collab_context"), "{error}");
        assert!(error.contains("same declaration source"), "{error}");
    }

    #[test]
    fn anthropic_allows_identical_repeated_declaration() {
        let tool = json!({"type":"namespace","name":"functions","tools":[
            {"type":"custom","name":"exec","format":{"type":"text"}}
        ]});
        let input = json!({"model":"glm-5.3","tools":[tool.clone()],"input":[
            {"type":"additional_tools","tools":[tool]},
            {"role":"user","content":"use a tool"}
        ]});
        let projected = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
            .expect("identical repeated declaration is one tool");
        assert_eq!(projected["tools"].as_array().unwrap().len(), 1);
    }
}
