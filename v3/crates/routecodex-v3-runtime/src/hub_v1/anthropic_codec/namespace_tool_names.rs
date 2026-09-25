use super::*;

pub(super) fn anthropic_namespace_wire_name(namespace: &str, name: &str) -> String {
    format!(
        "{namespace}__{}",
        super::super::request_outbound_mcp_names::provider_function_name(name)
    )
}

pub(super) fn validate_anthropic_declared_tool_names(request: &Value) -> Result<(), String> {
    let mut identities = BTreeMap::<String, (String, Value)>::new();
    collect_dispatch_identities(request.get("tools"), &mut identities)?;
    for item in request
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            collect_dispatch_identities(item.get("tools"), &mut identities)?;
        }
    }
    Ok(())
}

fn collect_dispatch_identities(
    tools: Option<&Value>,
    identities: &mut BTreeMap<String, (String, Value)>,
) -> Result<(), String> {
    for tool in tools.and_then(Value::as_array).into_iter().flatten() {
        let kind = tool.get("type").and_then(Value::as_str);
        if kind == Some("namespace") {
            let Some(name) = tool.get("name").and_then(Value::as_str) else {
                continue;
            };
            collect_namespace_dispatch_identities(tool, name, name, identities)?;
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
                insert_dispatch_identity(identities, &provider_name, name, tool)?;
            }
        }
    }
    Ok(())
}

fn collect_namespace_dispatch_identities(
    namespace: &Value,
    client_namespace: &str,
    wire_namespace: &str,
    identities: &mut BTreeMap<String, (String, Value)>,
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
            Some("namespace") => {
                collect_namespace_dispatch_identities(child, &client_name, name, identities)?
            }
            Some("function" | "custom") => insert_dispatch_identity(
                identities,
                &anthropic_namespace_wire_name(wire_namespace, name),
                &client_name,
                child,
            )?,
            _ => {}
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
                "Anthropic provider tool name {provider_name} has conflicting declarations for {existing} and {client_name}"
            ));
        }
    }
    identities.insert(
        provider_name.to_string(),
        (client_name.to_string(), declaration.clone()),
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
    fn anthropic_rejects_conflicting_same_name_declarations_across_tool_lists() {
        let first = json!({"type":"namespace","name":"functions","tools":[
            {"type":"custom","name":"exec","format":{"type":"grammar","syntax":"lark","definition":"start: \"pwd\""}}
        ]});
        let second = json!({"type":"namespace","name":"functions","tools":[
            {"type":"custom","name":"exec","format":{"type":"grammar","syntax":"lark","definition":"start: \"ls\""}}
        ]});
        for (tools, additional) in [(first.clone(), second.clone()), (second, first)] {
            let input = json!({"model":"glm-5.3","tools":[tools],"input":[
                {"type":"additional_tools","tools":[additional]},
                {"role":"user","content":"use a tool"}
            ]});
            let error = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
                .expect_err("conflicting declarations must not be deduplicated");
            assert!(error.to_string().contains("functions__exec"), "{error}");
        }
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
