use super::*;

pub(super) fn anthropic_tool_call_wire_name(name: &str, is_custom: bool) -> String {
    if is_custom {
        name.to_owned()
    } else {
        super::super::request_outbound_mcp_names::provider_function_name(name)
    }
}

pub(super) fn validate_anthropic_declared_tool_names(request: &Value) -> Result<(), String> {
    // The shared generic traversal owns the declaration identity recursion, the
    // `additional_tools` schema-refresh precedence, and the provider-name
    // collision check. Anthropic no longer keeps a second identity syntax.
    provider_compat_core::namespace_tools::validate_namespace_tool_dispatch_names(request)
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

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
        let wire = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
            .expect("two client tools receive unique Anthropic names");
        let tools = wire["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        assert_ne!(tools[0]["name"], tools[1]["name"]);
        assert!(tools.iter().any(|tool| tool["name"] == "functions__exec"));
    }

    #[test]
    fn anthropic_nested_namespace_and_flat_custom_use_distinct_provider_names() {
        // The nested namespace path is part of the Anthropic provider name, so a
        // nested `functions.mcp__mcpx.exec` and a flat `mcp__mcpx__exec` are two
        // distinct client tools and must not be reported as a collision.
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
            let projected = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
                .expect("distinct client tools must project to distinct provider names");
            let names = projected["tools"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>();
            assert!(names.contains(&"functions__mcp__mcpx__exec"), "{names:?}");
            assert!(names.contains(&"mcp__mcpx__exec"), "{names:?}");
        }
        let input = json!({"model":"glm-5.3","tools":[nested],"input":[
            {"type":"additional_tools","tools":[flat]},
            {"role":"user","content":"use a tool"}
        ]});
        let projected = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
            .expect("additional_tools distinct names must project");
        let names = projected["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(names.contains(&"functions__mcp__mcpx__exec"), "{names:?}");
        assert!(names.contains(&"mcp__mcpx__exec"), "{names:?}");
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
            let wire = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
                .expect("literal function/custom identities remain distinct");
            let tools = wire["tools"].as_array().unwrap();
            assert_eq!(tools.len(), 2);
            assert_ne!(tools[0]["name"], tools[1]["name"]);
        }
        let input = json!({"model":"glm-5.3","tools":[function],"input":[
            {"type":"additional_tools","tools":[custom]},
            {"role":"user","content":"use a tool"}
        ]});
        let wire = super::super::encode_v3_responses_semantic_as_anthropic_request(input)
            .expect("additional literal identities remain distinct");
        assert_eq!(wire["tools"].as_array().unwrap().len(), 2);
        assert_ne!(wire["tools"][0]["name"], wire["tools"][1]["name"]);
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
