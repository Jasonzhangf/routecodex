#[test]
fn openai_chat_provider_normalizes_dotted_mcp_history_content_names() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model":"glm-5.3","messages":[{"role":"tool","tool_call_id":"call_search","content":[{"type":"tool_result","name":"mcp__mcpx.workspace","content":"{}"}]}]
    })).expect("dotted MCP history names must be legal on provider wire");
    assert_eq!(
        request["messages"][0]["content"][0]["name"],
        "mcp__mcpx__workspace"
    );
}

#[test]
fn openai_chat_provider_preserves_tool_search_control_history_names() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model":"glm-5.3","messages":[{"role":"assistant","tool_calls":[{"id":"search_1","type":"function","function":{"name":"mcp__mcpx.workspace","arguments":"{}"}}],"routecodex_chat_extension":{"responses_tool_call_type":"tool_search_call"}}]
    })).expect("tool_search history must remain projectable");
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        "mcp__mcpx.workspace"
    );
}

#[test]
fn responses_tool_search_output_promotes_namespace_to_openai_chat_provider_tools() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model": "gpt-5.5",
                "input": [
                    {
                        "type": "tool_search_call",
                        "call_id": "call_search",
                        "execution": "client",
                        "status": "completed",
                        "arguments": {"query": "MCPX workspace", "limit": 5}
                    },
                    {
                        "type": "tool_search_output",
                        "call_id": "call_search",
                        "execution": "client",
                        "status": "completed",
                        "tools": [{
                            "type": "namespace",
                            "name": "mcp__mcpx",
                            "tools": [{
                                "type": "function",
                                "name": "workspace",
                                "description": "List workspaces",
                                "parameters": {"type": "object"}
                            }]
                        }]
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "call the workspace tool"}]
                    }
                ]
            }),
        )
        .expect("Responses tool search history must canonicalize");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("discovered namespace tools must remain provider-visible");

    assert!(
        request["tools"].as_array().is_some_and(|tools| tools.iter().any(
            |tool| tool["type"] == "function"
                && tool["function"]["name"] == "mcp__mcpx__workspace"
        )),
        "provider tools must expose the discovered namespace child: {request}"
    );
}

#[test]
fn responses_provider_wire_preserves_promoted_namespace_for_wire_expansion() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model": "deepseek-v4-flash",
                "input": [
                    {
                        "type": "tool_search_call",
                        "call_id": "call_search",
                        "execution": "client",
                        "status": "completed",
                        "arguments": {"query": "MCPX workspace", "limit": 5}
                    },
                    {
                        "type": "tool_search_output",
                        "call_id": "call_search",
                        "execution": "client",
                        "status": "completed",
                        "tools": [{
                            "type": "namespace",
                            "name": "mcp__mcpx",
                            "tools": [{
                                "type": "function",
                                "name": "workspace",
                                "description": "List workspaces",
                                "parameters": {"type": "object"}
                            }]
                        }]
                    }
                ]
            }),
        )
        .expect("Responses tool search history must canonicalize");
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&canonical)
        .expect("discovered namespace tools must be legal on Responses provider wire");

    assert!(
        request["tools"].as_array().is_some_and(|tools| tools.iter().any(|tool| {
            tool["type"] == "namespace"
                && tool["name"] == "mcp__mcpx"
                && tool["tools"].as_array().is_some_and(|children| children.iter().any(
                    |child| child["type"] == "function" && child["name"] == "workspace"
                ))
        })),
        "Responses provider tools must keep namespace declarations so the provider wire layer can expand call names: {request}"
    );
}

#[test]
fn responses_direct_provider_projection_promotes_discovered_tools_for_wire_expansion() {
    let mut request = json!({
        "model": "deepseek-v4-flash",
        "input": [
            {
                "type": "tool_search_output",
                "call_id": "call_search",
                "tools": [{
                    "type": "namespace",
                    "name": "mcp__mcpx",
                    "tools": [{
                        "type": "function",
                        "name": "workspace",
                        "parameters": {"type": "object"}
                    }]
                }]
            },
            {
                "type": "tool_search_output",
                "call_id": "call_search_duplicate",
                "tools": [{
                    "type": "namespace",
                    "name": "mcp__mcpx",
                    "tools": [{
                        "type": "function",
                        "name": "workspace",
                        "parameters": {"type": "object"}
                    }]
                }]
            }
        ]
    });

    normalize_v3_openai_responses_provider_request_payload(&mut request)
        .expect("Responses direct projection must promote discovered namespace tools");

    let tools = request["tools"].as_array().expect("provider tools");
    assert_eq!(tools.len(), 1, "duplicate discovered tools must be removed");
    assert_eq!(tools[0]["type"], "namespace");
    assert_eq!(tools[0]["name"], "mcp__mcpx");
}

#[test]
fn responses_direct_provider_projection_without_discovered_tools_keeps_tools_unchanged() {
    let expected = json!([{
        "type": "function",
        "name": "exec_command",
        "parameters": {"type": "object"}
    }]);
    let mut request = json!({
        "model": "deepseek-v4-flash",
        "tools": expected,
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}]
        }]
    });

    normalize_v3_openai_responses_provider_request_payload(&mut request)
        .expect("Responses direct projection without deferred tools must succeed");

    assert_eq!(request["tools"], expected);
}
