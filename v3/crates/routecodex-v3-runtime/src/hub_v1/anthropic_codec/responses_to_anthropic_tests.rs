use super::*;

#[test]
fn chat_canonical_redacted_reasoning_with_tool_history_restores_provider_block() {
    let canonical =
        crate::hub_v1::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model": "claude",
                "tools": [{
                    "type": "function",
                    "name": "lookup",
                    "parameters": {"type": "object"}
                }],
                "input": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "I will look that up."}]
                    },
                    {
                        "type": "reasoning",
                        "encrypted_content": "native-redacted-data",
                        "routecodex_chat_extension": {
                            "anthropic_reasoning": {
                                "type": "redacted_thinking",
                                "cache_control": {"type": "ephemeral"},
                                "opaque": {"nested": [1, {"leaf": "redacted"}]}
                            }
                        }
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_redacted_history",
                        "name": "lookup",
                        "arguments": "{\"query\":\"p0\"}"
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_redacted_history",
                        "output": "42"
                    }
                ]
            }),
        )
        .expect("redacted reasoning plus paired tool history must reach canonical Chat");

    let provider = encode_v3_responses_semantic_as_anthropic_request(canonical)
        .expect("canonical redacted reasoning must restore on the Anthropic wire");
    let content = provider["messages"][0]["content"]
        .as_array()
        .expect("assistant content");
    let redacted = content
        .iter()
        .find(|block| block["type"] == "redacted_thinking")
        .unwrap_or_else(|| {
            panic!("redacted reasoning block was dropped from canonical Chat replay: {provider}")
        });
    assert_eq!(
        redacted,
        &json!({
            "type": "redacted_thinking",
            "data": "native-redacted-data",
            "cache_control": {"type": "ephemeral"},
            "opaque": {"nested": [1, {"leaf": "redacted"}]}
        })
    );
    assert!(
        content
            .iter()
            .any(|block| block["type"] == "tool_use" && block["id"] == "call_redacted_history"),
        "paired tool call must stay adjacent to restored reasoning: {provider}"
    );
}

#[test]
fn anthropic_namespace_tools_expand_to_qualified_children() {
    let object = json!({
        "tools": [{
            "type": "namespace",
            "name": "mcp__mcpx",
            "tools": [{
                "type": "function",
                "name": "workspace",
                "parameters": {"type": "object"}
            }]
        }]
    });
    let tools = responses_tools_for_anthropic_wire(object.as_object().unwrap()).unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "mcp__mcpx__workspace");
    assert_ne!(tools[0]["name"], "mcp__mcpx");
}

#[test]
fn anthropic_empty_namespace_is_omitted_from_provider_tools() {
    let tools = responses_tools_for_anthropic_wire(
        json!({"tools": [{"type": "namespace", "name": "mcp__mcpx", "tools": []}]} )
            .as_object()
            .unwrap(),
    )
    .unwrap();
    assert!(tools.is_empty());
}

#[test]
fn anthropic_namespace_custom_child_is_projected_without_tools_shape_failure() {
    let object = json!({
        "tools": [{
            "type": "namespace",
            "name": "functions",
            "tools": [{
                "type": "namespace",
                "name": "mcp__mcpx",
                "tools": [{
                    "type": "function",
                    "name": "workspace",
                    "parameters": {"type": "object"}
                }]
            }]
        }]
    });
    let tools = responses_tools_for_anthropic_wire(object.as_object().unwrap())
        .expect("custom namespace child must have a legal Anthropic projection");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "functions__mcp__mcpx__workspace");
}

#[test]
fn anthropic_namespace_custom_history_uses_the_declared_provider_name() {
    let request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model": "glm-5.3",
        "messages": [
            {"role": "assistant", "tool_calls": [{"id": "call_exec", "type": "function", "function": {"name": "functions.exec", "arguments": "{\"input\":\"pwd\"}"}}]},
            {"role": "tool", "tool_call_id": "call_exec", "content": "/tmp"}
        ],
        "tools": [{"type": "namespace", "name": "functions", "tools": [
            {"type": "custom", "name": "exec", "format": {"type": "text"}}
        ]}]
    }))
    .expect("declared custom history must project to Anthropic");
    assert_eq!(request["tools"][0]["name"], "functions__exec");
    assert_eq!(
        request["messages"][0]["content"][0]["name"],
        "functions__exec"
    );
    assert_eq!(
        request["messages"][1]["content"][0]["tool_use_id"],
        "call_exec"
    );
}

#[test]
fn anthropic_nested_namespace_custom_history_matches_its_declaration() {
    let request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"glm-5.3",
        "messages":[{"role":"assistant","tool_calls":[{"id":"call_nested","function":{"name":"functions.mcp__mcpx.exec","arguments":"{\"input\":\"pwd\"}"}}]}],
        "tools":[{"type":"namespace","name":"functions","tools":[{"type":"namespace","name":"mcp__mcpx","tools":[{"type":"custom","name":"exec","format":{"type":"text"}}]}]}]
    })).expect("nested custom history must project");
    assert_eq!(request["tools"][0]["name"], "functions__mcp__mcpx__exec");
    assert_eq!(
        request["messages"][0]["content"][0]["name"],
        "functions__mcp__mcpx__exec"
    );
}

#[test]
fn anthropic_namespace_custom_choice_uses_declared_provider_name() {
    let request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"glm-5.3", "input":"run pwd",
        "tool_choice":{"type":"custom","name":"functions.exec"},
        "tools":[{"type":"namespace","name":"functions","tools":[
            {"type":"custom","name":"exec","format":{"type":"text"}}
        ]}]
    }))
    .expect("namespace custom choice must project to Anthropic");
    assert_eq!(request["tools"][0]["name"], "functions__exec");
    assert_eq!(request["tool_choice"]["name"], "functions__exec");
}

#[test]
fn anthropic_namespace_tool_call_history_uses_declared_provider_name() {
    let request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"glm-5.3",
        "input":[
            {"type":"tool_call","call_id":"call_exec","name":"functions.exec","arguments":"{\"input\":\"pwd\"}"},
            {"type":"tool_call_output","call_id":"call_exec","output":"/tmp"}
        ],
        "tools":[{"type":"namespace","name":"functions","tools":[
            {"type":"custom","name":"exec","format":{"type":"text"}}
        ]}]
    })).expect("tool_call history must project to Anthropic");
    assert_eq!(
        request["messages"][0]["content"][0]["name"],
        "functions__exec"
    );
}

#[test]
fn openai_chat_tool_call_malformed_arguments_project_reversible_anthropic_input() {
    let tool_use = openai_chat_tool_call_as_anthropic_tool_use(&json!({
        "id": "call_malformed_chat",
        "type": "function",
        "function": {
            "name": "exec_command",
            "arguments": "{\"cmd\":\"one\"}{\"cmd\":\"two\"}"
        }
    }))
    .expect("malformed historical Chat arguments project to legal Anthropic input");
    assert_eq!(
        tool_use["input"],
        json!({"input":"{\"cmd\":\"one\"}{\"cmd\":\"two\"}"})
    );
}

#[test]
fn anthropic_tool_use_normalizes_legacy_mcp_function_name() {
    let mut system_parts = Vec::new();
    let messages = chat_messages_as_anthropic_messages(
        &json!([{
            "role": "assistant",
            "tool_calls": [{
                "id": "call_review",
                "type": "function",
                "function": {
                    "name": "functions.mcp__codex_review__review_start",
                    "arguments": "{}"
                }
            }]
        }]),
        &mut system_parts,
    )
    .expect("Anthropic messages must use the provider-safe MCP name");
    assert_eq!(
        messages[0]["content"][0]["name"],
        "functions.mcp__codex_review__review_start"
    );
}

#[test]
fn anthropic_tool_declaration_normalizes_legacy_mcp_function_name() {
    let tools = responses_tools_for_anthropic_wire(
        json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "functions.mcp__codex_review__review_start",
                        "parameters": {"type": "object"}
                    }
                }]
            }
        )
        .as_object()
        .unwrap(),
    )
    .expect("Anthropic tools must use the provider-safe MCP name");
    assert_eq!(
        tools[0]["name"],
        "functions.mcp__codex_review__review_start"
    );
}

#[test]
fn responses_tool_history_normalizes_legacy_mcp_function_name() {
    let mut messages = Vec::new();
    responses_input_item_as_anthropic_messages(
        &json!({
            "type": "function_call",
            "call_id": "call_review",
            "name": "functions.mcp__codex_review__review_start",
            "arguments": "{}"
        }),
        &mut messages,
        &mut Vec::new(),
    )
    .expect("Responses tool history must use the provider-safe MCP name");
    assert_eq!(
        messages[0]["content"][0]["name"],
        "functions.mcp__codex_review__review_start"
    );
}

#[test]
fn responses_function_call_malformed_arguments_project_reversible_anthropic_input() {
    let mut object = Map::new();
    object.insert("type".to_string(), json!("function_call"));
    object.insert(
        "arguments".to_string(),
        json!("{\"cmd\":\"one\"}{\"cmd\":\"two\"}"),
    );
    let input = responses_function_call_input(&object)
        .expect("malformed historical Responses arguments project to legal Anthropic input");
    assert_eq!(input, json!({"input":"{\"cmd\":\"one\"}{\"cmd\":\"two\"}"}));
}

#[test]
fn websearch_function_tool_maps_to_anthropic_hosted_web_search_server_tool() {
    // chat 入口 client 声明 `{"type":"function","function":{"name":"websearch"}}`，
    // Anthropic wire 必须以官方 hosted server tool（web_search_20250305）编码，
    // 否则 MiniMax 等 provider 收不到搜索工具。
    let tool = json!({
        "type": "function",
        "function": {
            "name": "websearch",
            "description": "Search the web",
            "parameters": {"type":"object","properties":{"query":{"type":"string"}}}
        }
    });
    let anthropic =
        responses_tool_as_anthropic_tool(tool.as_object().unwrap()).expect("map must succeed");
    assert_eq!(anthropic["type"], "web_search_20250305");
    assert_eq!(anthropic["name"], "web_search");
    // 大小写不敏感：WebSearch / WEBSEARCH 同样映射。
    let upper = json!({"type":"function","function":{"name":"WEBSEARCH"}});
    let mapped =
        responses_tool_as_anthropic_tool(upper.as_object().unwrap()).expect("map must succeed");
    assert_eq!(mapped["name"], "web_search");
    // web_search 名（hosted 语义）保持官方 server tool。
    let hosted = json!({"type":"web_search"});
    let mapped =
        responses_tool_as_anthropic_tool(hosted.as_object().unwrap()).expect("map must succeed");
    assert_eq!(mapped["name"], "web_search");
    assert_eq!(mapped["type"], "web_search_20250305");
}

fn bug4beffbf_legal_anthropic_alias(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 128
        && !name.contains('.')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | ':' | ' '))
}

#[test]
fn bug4beffbf_anthropic_dotted_custom_declaration_choice_history_share_alias() {
    let request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"glm-5.3",
        "tools":[{"type":"custom","name":"functions.exec","format":{"type":"text"}}],
        "tool_choice":{"type":"custom","name":"functions.exec"},
        "messages":[
            {"role":"assistant","tool_calls":[{"id":"call_exec","type":"function","function":{"name":"functions.exec","arguments":"{\"input\":\"pwd\"}"}}]},
            {"role":"tool","tool_call_id":"call_exec","content":"/tmp"}
        ]
    }))
    .expect("dotted custom declaration must project to Anthropic");
    let alias = request["tools"][0]["name"].as_str().unwrap();
    assert!(bug4beffbf_legal_anthropic_alias(alias), "alias={alias}");
    assert_eq!(request["tool_choice"]["name"], alias);
    assert_eq!(
        request["messages"][0]["content"][0]["name"], alias,
        "history tool_use must use the same declared alias"
    );
    assert_eq!(
        request["messages"][1]["content"][0]["tool_use_id"],
        "call_exec"
    );

    let context =
        super::super::V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
            "model":"glm-5.3",
            "tools":[{"type":"custom","name":"functions.exec","format":{"type":"text"}}]
        }))
        .unwrap();
    assert_eq!(
        context.governed_custom_tool_client_name(alias),
        Some("functions.exec")
    );
    assert!(context.namespaced_custom_tool_identity(alias).is_none());
}

#[test]
fn bug4beffbf_anthropic_flat_custom_collision_projects_unique_legal_aliases() {
    let request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"glm-5.3",
        "tools":[
            {"type":"custom","name":"functions.exec","format":{"type":"text"}},
            {"type":"custom","name":"functions__exec","format":{"type":"text"}}
        ],
        "tool_choice":{"type":"custom","name":"functions.exec"},
        "messages":[{"role":"assistant","tool_calls":[{"id":"call_exec","type":"function","function":{"name":"functions.exec","arguments":"{\"input\":\"pwd\"}"}}]}]
    }))
    .expect("colliding flat custom tools must stay distinct on Anthropic");
    let tools = request["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 2);
    let names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(names
        .iter()
        .all(|name| bug4beffbf_legal_anthropic_alias(name)));
    assert_eq!(
        names
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        2,
        "colliding identities must receive unique aliases: {names:?}"
    );
    assert!(
        names.contains(&request["tool_choice"]["name"].as_str().unwrap()),
        "tool_choice must reference a declared alias: {request}"
    );
}

#[test]
fn bug4beffbf_anthropic_long_custom_name_is_bounded_to_128_chars() {
    let long_name = format!("{}{}", "a.", "b".repeat(140));
    let request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"glm-5.3",
        "tools":[{"type":"custom","name":long_name,"format":{"type":"text"}}],
        "input":[{"type":"message","role":"user","content":"use tool"}]
    }))
    .expect("overlong dotted custom name must be bounded, not rejected");
    let alias = request["tools"][0]["name"].as_str().unwrap();
    assert!(bug4beffbf_legal_anthropic_alias(alias), "alias={alias}");
    assert_eq!(alias.chars().count(), 128);
}
