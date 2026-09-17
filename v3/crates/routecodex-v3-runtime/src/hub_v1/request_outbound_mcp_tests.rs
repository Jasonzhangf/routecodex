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
fn openai_chat_provider_strips_functions_prefix_from_history_names() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model": "glm-5.3",
        "messages": [
            {
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_search",
                    "type": "function",
                    "function": {
                        "name": "functions.mcp__codex_review__review_start",
                        "arguments": "{}"
                    }
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "call_search",
                "content": [{
                    "type": "tool_result",
                    "name": "functions.mcp__codex_review__review_start",
                    "content": "{}"
                }]
            }
        ]
    }))
    .expect("functions-prefixed MCP history names must be legal on provider wire");
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        "mcp__codex_review__review_start"
    );
    assert_eq!(
        request["messages"][1]["content"][0]["name"],
        "mcp__codex_review__review_start"
    );
}

#[test]
fn openai_chat_provider_normalizes_mcp_declaration_and_history_names_consistently() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model": "glm-5.3",
        "tools": [{
            "type": "function",
            "function": {
                "name": "functions.mcp__codex_review__review_start",
                "description": "Start review",
                "parameters": {"type": "object"}
            }
        }],
        "messages": [
            {
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_review",
                    "type": "function",
                    "function": {
                        "name": "functions.mcp__codex_review__review_start",
                        "arguments": "{}"
                    }
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "call_review",
                "content": [{
                    "type": "tool_result",
                    "name": "functions.mcp__codex_review__review_start",
                    "content": "{}"
                }]
            }
        ]
    }))
    .expect("MCP declaration and history names must share the provider identity");
    let expected = json!("mcp__codex_review__review_start");
    assert_eq!(request["tools"][0]["function"]["name"], expected);
    assert_eq!(request["messages"][0]["tool_calls"][0]["function"]["name"], expected);
    assert_eq!(request["messages"][1]["content"][0]["name"], expected);
}

#[test]
fn openai_chat_provider_deduplicates_legacy_and_dotted_mcp_tools_after_normalization() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model": "deepseek-v4.1-flash",
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "functions.mcp__mcpx__workspace",
                    "description": "List workspaces",
                    "parameters": {"type": "object"}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "mcp__mcpx.workspace",
                    "description": "List workspaces",
                    "parameters": {"type": "object"}
                }
            }
        ],
        "messages": [{"role": "user", "content": "list workspaces"}]
    }))
    .expect("equivalent MCP declarations must project to one provider identity");

    let tools = request["tools"].as_array().expect("provider tools");
    assert_eq!(
        tools.len(),
        1,
        "legacy and dotted MCP aliases must not reach the provider as duplicate names: {request}"
    );
    assert_eq!(tools[0]["function"]["name"], "mcp__mcpx__workspace");
}

#[test]
fn responses_tool_search_output_dedupes_same_flattened_provider_tool_name() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model": "gpt-5.5",
                "input": [
                    {
                        "type": "tool_search_call",
                        "call_id": "call_search_one",
                        "execution": "client",
                        "status": "completed",
                        "arguments": {"query": "MCPX workspace"}
                    },
                    {
                        "type": "tool_search_output",
                        "call_id": "call_search_one",
                        "tools": [{
                            "type": "namespace",
                            "name": "mcp__mcpx",
                            "description": "first catalog",
                            "tools": [{
                                "type": "function",
                                "name": "workspace",
                                "description": "List workspaces",
                                "parameters": {"type": "object"}
                            }]
                        }]
                    },
                    {
                        "type": "tool_search_call",
                        "call_id": "call_search_two",
                        "execution": "client",
                        "status": "completed",
                        "arguments": {"query": "MCPX workspace"}
                    },
                    {
                        "type": "tool_search_output",
                        "call_id": "call_search_two",
                        "tools": [{
                            "type": "namespace",
                            "name": "mcp__mcpx",
                            "description": "second catalog",
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
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("duplicate discovered provider tools must remain projectable");

    let tools = request["tools"].as_array().expect("provider tools");
    let workspace_tools = tools
        .iter()
        .filter(|tool| tool["function"]["name"] == "mcp__mcpx__workspace")
        .count();
    assert_eq!(
        workspace_tools, 1,
        "OpenAI Chat provider tools must contain one declaration per function name: {request}"
    );
}

#[test]
fn openai_chat_provider_tools_reject_conflicting_duplicate_function_names() {
    let payload = json!({
        "model": "gpt-5.5",
        "messages": [{"role": "user", "content": "use workspace"}],
        "tools": [
            {
                "type": "function",
                "name": "mcp__mcpx__workspace",
                "description": "first declaration",
                "parameters": {"type": "object"}
            },
            {
                "type": "function",
                "name": "mcp__mcpx__workspace",
                "description": "conflicting declaration",
                "parameters": {"type": "object", "properties": {"scope": {"type": "string"}}}
            }
        ]
    });
    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("conflicting provider tool declarations must fail explicitly");
    assert!(error.contains("ConflictingOutboundFields"), "{error}");
    assert!(error.contains("mcp__mcpx__workspace"), "{error}");
}

#[test]
fn openai_chat_provider_preserves_non_mcp_functions_prefix() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model": "glm-5.3",
        "tools": [{
            "type": "function",
            "function": {
                "name": "functions.exec_command",
                "parameters": {"type": "object"}
            }
        }],
        "messages": [{
            "role": "assistant",
            "tool_calls": [{
                "id": "call_exec",
                "type": "function",
                "function": {"name": "functions.exec_command", "arguments": "{}"}
            }]
        }]
    }))
    .expect("non-MCP function names must not use the MCP legacy rewrite");
    assert_eq!(request["tools"][0]["function"]["name"], "functions.exec_command");
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        "functions.exec_command"
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
fn responses_function_call_history_keeps_mcp_namespace_on_openai_chat_provider_wire() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model": "gpt-5.5",
                "input": [
                    {
                        "type": "function_call",
                        "id": "fc_mcpx_session",
                        "call_id": "call_mcpx_session",
                        "name": "session",
                        "namespace": "mcp__mcpx",
                        "arguments": r#"{"action":"list","workspace":"routecodex"}"#
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_mcpx_session",
                        "output": "{}"
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "continue"}]
                    }
                ]
            }),
        )
        .expect("Responses MCP namespace history must canonicalize");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("canonical MCP namespace history must project to OpenAI Chat");

    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        json!("mcp__mcpx__session")
    );
}

#[test]
fn responses_function_call_history_without_namespace_is_qualified_from_provider_tools() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model": "gpt-5.5",
                "tools": [{
                    "type": "namespace",
                    "name": "mcp__mcpx",
                    "tools": [{
                        "type": "function",
                        "name": "session",
                        "parameters": {"type": "object"}
                    }]
                }],
                "input": [
                    {
                        "type": "function_call",
                        "id": "fc_mcpx_session",
                        "call_id": "call_mcpx_session",
                        "name": "session",
                        "arguments": r#"{"action":"list","workspace":"routecodex"}"#
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_mcpx_session",
                        "output": "{}"
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "continue"}]
                    }
                ]
            }),
        )
        .expect("Responses MCP namespace-less history must canonicalize");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("canonical MCP namespace-less history must project to OpenAI Chat");

    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        json!("mcp__mcpx__session")
    );
}

#[test]
fn legacy_mcp_declaration_qualifies_namespace_less_continuation_history() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model":"gpt-5.5",
        "tools":[{"type":"function","name":"functions.mcp__mcpx__session","parameters":{"type":"object"}}],
        "messages":[{"role":"assistant","tool_calls":[{
            "id":"call_session",
            "type":"function",
            "function":{"name":"session","arguments":"{}"},
            "routecodex_chat_extension":{"responses_item_id":"fc_session"}
        }]}]
    })).expect("legacy MCP declarations must qualify continuation history");
    assert_eq!(
        request["tools"][0]["function"]["name"],
        "mcp__mcpx__session"
    );
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        "mcp__mcpx__session"
    );
}

#[test]
fn openai_chat_history_does_not_qualify_same_leaf_name_without_responses_origin() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model": "glm-5.3",
        "tools": [{
            "type": "namespace",
            "name": "mcp__mcpx",
            "tools": [{
                "type": "function",
                "name": "session",
                "parameters": {"type": "object"}
            }]
        }],
        "messages": [{
            "role": "assistant",
            "tool_calls": [{
                "id": "call_native_session",
                "type": "function",
                "function": {"name": "session", "arguments": "{}"}
            }]
        }]
    }))
    .expect("OpenAI Chat history must remain projectable");

    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        json!("session")
    );
}

#[test]
fn responses_custom_tool_call_does_not_borrow_colliding_mcp_leaf_name() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model": "gpt-5.5",
                "tools": [{
                    "type": "namespace",
                    "name": "mcp__mcpx",
                    "tools": [{
                        "type": "function",
                        "name": "session",
                        "parameters": {"type": "object"}
                    }]
                }],
                "input": [
                    {
                        "type": "custom_tool_call",
                        "id": "ctc_custom_session",
                        "call_id": "call_custom_session",
                        "name": "functions.custom.render",
                        "input": "custom payload"
                    },
                    {
                        "type": "custom_tool_call_output",
                        "call_id": "call_custom_session",
                        "output": "{}"
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "continue"}]
                    }
                ]
            }),
        )
        .expect("Responses custom tool history must canonicalize");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("canonical custom tool history must project to OpenAI Chat");

    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        json!("functions.custom.render")
    );
}

#[test]
fn openai_chat_provider_preserves_custom_tool_output_names() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model":"gpt-5.5","messages":[{
            "role":"tool",
            "tool_call_id":"call_custom",
            "content":[{"type":"tool_result","name":"functions.custom.render","content":"{}"}],
            "routecodex_chat_extension":{"responses_tool_output_type":"custom_tool_call_output"}
        }]
    })).expect("custom tool output names must remain exact");
    assert_eq!(
        request["messages"][0]["content"][0]["name"],
        json!("functions.custom.render")
    );
}

#[test]
fn responses_native_function_does_not_borrow_colliding_mcp_leaf_name() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model": "gpt-5.5",
                "tools": [
                    {
                        "type": "namespace",
                        "name": "mcp__mcpx",
                        "tools": [{
                            "type": "function",
                            "name": "session",
                            "parameters": {"type": "object"}
                        }]
                    },
                    {
                        "type": "function",
                        "name": "session",
                        "parameters": {"type": "object"}
                    }
                ],
                "input": [
                    {
                        "type": "function_call",
                        "id": "fc_native_session",
                        "call_id": "call_native_session",
                        "name": "session",
                        "arguments": "{}"
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_native_session",
                        "output": "{}"
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "continue"}]
                    }
                ]
            }),
        )
        .expect("Responses native function history must canonicalize");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("canonical native function history must project to OpenAI Chat");

    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        json!("session")
    );
}

#[test]
fn openai_chat_tool_search_history_strips_legacy_functions_mcp_prefix() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model":"glm-5.3",
        "messages":[{
            "role":"assistant",
            "content":[{"type":"tool_use","name":"functions.mcp__codex_review__review_start","input":{}}],
            "tool_calls":[{"id":"review_1","type":"function","function":{"name":"functions.mcp__codex_review__review_start","arguments":"{}"}}],
            "routecodex_chat_extension":{"responses_tool_call_type":"tool_search_call"}
        }]
    })).expect("tool_search history must strip the legacy functions MCP prefix");
    assert_eq!(
        request["messages"][0]["content"][0]["name"],
        "mcp__codex_review__review_start"
    );
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        "mcp__codex_review__review_start"
    );
}

#[test]
fn openai_responses_provider_strips_functions_prefix_from_history_names() {
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&json!({
        "model": "deepseek-v4.1-flash",
        "messages": [{
            "role": "assistant",
            "tool_calls": [{
                "id": "review_1",
                "type": "function",
                "function": {
                    "name": "functions.mcp__codex_review__review_start",
                    "arguments": "{}"
                }
            }]
        }]
    }))
    .expect("Responses provider history names must be legal on provider wire");
    assert_eq!(
        request["input"][0]["name"],
        "mcp__codex_review__review_start"
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
fn responses_tool_search_output_promotes_namespace_before_chat_projection_strips_extension() {
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
                        "arguments": {"query": "MCPX workspace"}
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
    assert_eq!(
        canonical["messages"][1]["routecodex_chat_extension"]["responses_tool_output_type"],
        "tool_search_output",
        "canonical history must carry the tool_search_output marker"
    );

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("discovered namespace tools must survive Chat provider projection");

    assert!(
        request["tools"].as_array().is_some_and(|tools| tools.iter().any(
            |tool| tool["type"] == "function"
                && tool["function"]["name"] == "mcp__mcpx__workspace"
        )),
        "provider tools must expose the discovered namespace child after projection: {request}"
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
