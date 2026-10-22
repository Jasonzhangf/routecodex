#[test]
fn openai_chat_wire_projects_responses_web_search_tool_to_options() {
    let payload = json!({
        "model":"gpt-test", "messages":[{"role":"user", "content":"search"}],
        "tools":[
            {"type":"function", "name":"read_file", "description":"Read one file",
             "parameters":{"type":"object", "properties":{}}},
            {"type":"web_search_preview", "search_context_size":"medium",
             "user_location":{"type":"approximate", "country":"CN", "city":"Shanghai"}},
            {"type":"tool_search", "execution":"client", "description":"Search deferred tools",
             "parameters":{"type":"object", "properties":{"query":{"type":"string"}},
                           "required":["query"], "additionalProperties":false}}
        ]
    });
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("Responses web search must project to Chat web_search_options");
    let tools = request["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 2);
    // Tool availability is keyed by name. Hosted declarations can precede
    // registry identities; neither position supplies dispatch authority.
    for (name, source) in [
        ("read_file", &payload["tools"][0]),
        ("tool_search", &payload["tools"][2]),
    ] {
        let tool = tools
            .iter()
            .find(|tool| tool["function"]["name"] == name)
            .unwrap();
        assert_eq!(tool["type"], "function");
        assert_eq!(tool["function"]["description"], source["description"]);
        assert_eq!(tool["function"]["parameters"], source["parameters"]);
    }
    assert_eq!(
        request["web_search_options"],
        json!({
            "search_context_size":"medium",
            "user_location":{"type":"approximate", "country":"CN", "city":"Shanghai"}
        })
    );
}

#[test]
fn responses_namespace_custom_tool_projects_to_chat_provider_function() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model":"gpt-5.6-luna",
                "input":[{"role":"user","content":"run pwd"}],
                "tools":[{"type":"namespace","name":"functions","tools":[
                    {"type":"custom","name":"exec","format":{"type":"text"}}
                ]}]
            }),
        )
        .expect("Responses namespace custom declaration must canonicalize");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("namespace custom declaration must project to Chat function wire");
    assert_eq!(request["tools"][0]["type"], "function");
    assert_eq!(request["tools"][0]["function"]["name"], "functions__exec");
    assert_eq!(
        request["tools"][0]["function"]["parameters"]["required"],
        json!(["input"])
    );
}

#[test]
fn responses_additional_tools_refreshes_same_namespace_tool_before_chat_projection() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model":"gpt-5.5",
                "input":[
                    {"type":"additional_tools","tools":[{"type":"namespace","name":"mcp__collab","tools":[
                        {"type":"function","name":"collab_context","description":"loaded tool","parameters":{"type":"object","properties":{"query":{"type":"string"}}}}
                    ]}]},
                    {"role":"user","content":"inspect current collaboration"}
                ],
                "tools":[{"type":"namespace","name":"mcp__collab","tools":[
                    {"type":"function","name":"collab_context","description":"deferred tool","parameters":{"type":"object","properties":{"placeholder":{"type":"string"}}}}
                ]}]
            }),
        )
        .expect("Responses tool declarations with one client identity must canonicalize");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("later additional_tools declaration must refresh the provider schema");
    assert_eq!(request["tools"].as_array().unwrap().len(), 1);
    assert_eq!(
        request["tools"][0]["function"]["name"],
        "mcp__collab__collab_context"
    );
    assert_eq!(
        request["tools"][0]["function"]["description"],
        "loaded tool"
    );
    assert_eq!(
        request["tools"][0]["function"]["parameters"]["properties"]["query"]["type"],
        "string"
    );
    assert!(request["tools"][0]["function"]["parameters"]["properties"]["placeholder"].is_null());
}

#[test]
fn responses_additional_tools_refreshes_nested_mcpx_alias_before_chat_projection() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model":"gpt-5.5",
                "input":[
                    {"type":"additional_tools","tools":[{
                        "type":"function","name":"mcp__mcpx__workspace__read",
                        "description":"current read schema","parameters":{"type":"object","properties":{"path":{"type":"string"}}}
                    }]},
                    {"role":"user","content":"read a file"}
                ],
                "tools":[{"type":"namespace","name":"mcp__mcpx","tools":[
                    {"type":"namespace","name":"workspace","tools":[
                        {"type":"function","name":"read","description":"deferred schema","parameters":{"type":"object","properties":{"placeholder":{"type":"string"}}}}
                    ]}
                ]}]
            }),
        )
        .expect("nested namespace and plain name remain distinct identities");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("additional plain declaration must not refresh the namespace schema");
    let tools = request["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 2);
    let current = tools
        .iter()
        .find(|tool| tool["function"]["description"] == "current read schema")
        .unwrap();
    let deferred = tools
        .iter()
        .find(|tool| tool["function"]["description"] == "deferred schema")
        .unwrap();
    assert_eq!(current["function"]["name"], "mcp__mcpx__workspace__read");
    assert_ne!(current["function"]["name"], deferred["function"]["name"]);
    assert_eq!(
        deferred["function"]["parameters"]["properties"]["placeholder"]["type"],
        "string"
    );
    assert_eq!(
        current["function"]["parameters"]["properties"]["path"]["type"],
        "string"
    );
    assert!(current["function"]["parameters"]["properties"]["placeholder"].is_null());
}

#[test]
fn responses_additional_tools_refreshes_functions_exec_shell_wrapper() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model":"gpt-5.5",
                "input":[
                    {"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[
                        {"type":"custom","name":"exec","description":"current shell tool","format":{"type":"text"}}
                    ]}]},
                    {"role":"user","content":"run pwd"}
                ],
                "tools":[{"type":"namespace","name":"functions","tools":[
                    {"type":"custom","name":"exec","description":"deferred shell tool","format":{"type":"text"}}
                ]}]
            }),
        )
        .expect("Responses shell tool declarations with one identity must canonicalize");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("repeated shell tool declaration must project as one Chat function");
    assert_eq!(request["tools"].as_array().unwrap().len(), 1);
    assert_eq!(request["tools"][0]["function"]["name"], "functions__exec");
    assert_eq!(
        request["tools"][0]["function"]["description"],
        "current shell tool"
    );
}

#[test]
fn responses_namespace_custom_history_uses_provider_name_on_followup() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model":"gpt-5.6-luna",
                "input":[
                    {"role":"user","content":"run pwd"},
                    {"type":"custom_tool_call","call_id":"call_exec","namespace":"functions","name":"exec","input":"pwd"},
                    {"type":"custom_tool_call_output","call_id":"call_exec","output":"/tmp"}
                ],
                "tools":[{"type":"namespace","name":"functions","tools":[
                    {"type":"custom","name":"exec","format":{"type":"text"}}
                ]}]
            }),
        )
        .expect("Responses custom tool followup must canonicalize");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("custom tool followup must project to Chat wire");
    assert_eq!(
        request["messages"][1]["tool_calls"][0]["function"]["name"],
        "functions__exec"
    );
    assert_eq!(
        request["messages"][1]["tool_calls"][0]["function"]["arguments"],
        "{\"input\":\"pwd\"}"
    );
}

#[test]
fn responses_nested_namespace_custom_history_uses_declared_provider_name() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model":"gpt-6-luna",
                "input":[
                    {"role":"user","content":"run pwd"},
                    {"type":"custom_tool_call","call_id":"call_nested","namespace":"functions.inner","name":"exec","input":"pwd"},
                    {"type":"custom_tool_call_output","call_id":"call_nested","output":"/tmp"}
                ],
                "tools":[{"type":"namespace","name":"functions","tools":[
                    {"type":"namespace","name":"inner","tools":[
                        {"type":"custom","name":"exec","format":{"type":"text"}}
                    ]}
                ]}]
            }),
        )
        .expect("nested custom tool followup must canonicalize");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("nested custom tool followup must project to Chat wire");
    assert_eq!(
        request["messages"][1]["tool_calls"][0]["function"]["name"],
        "functions__inner__exec"
    );
    assert_eq!(
        request["messages"][2]["tool_call_id"],
        request["messages"][1]["tool_calls"][0]["id"]
    );
}

#[test]
fn additional_tools_namespace_custom_history_uses_provider_name() {
    let mut request = json!({
        "messages":[{"role":"assistant","tool_calls":[{"id":"call_exec","function":{"name":"functions.exec","arguments":"{\"input\":\"pwd\"}"}}]}],
        "input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec","format":{"type":"text"}}]}]}]
    });
    super::super::request_outbound_mcp_names::rewrite_openai_chat_declared_namespace_history(
        &mut request,
    )
    .unwrap();
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        "functions__exec"
    );
}

#[test]
fn responses_namespace_custom_tool_choice_uses_declared_chat_provider_name() {
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &json!({
                "model":"gpt-5.6-luna", "input":"run pwd",
                "tool_choice":{"type":"function","name":"functions.exec"},
                "tools":[{"type":"namespace","name":"functions","tools":[
                    {"type":"custom","name":"exec","format":{"type":"text"}}
                ]}]
            }),
        ).expect("Responses tool choice must canonicalize");
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("namespace custom choice must project");
    assert_eq!(request["tools"][0]["function"]["name"], "functions__exec");
    assert_eq!(
        request["tool_choice"]["function"]["name"],
        "functions__exec"
    );
}

#[test]
fn openai_chat_provider_normalizes_dotted_mcp_history_content_names() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model":"glm-5.3","messages":[{"role":"tool","tool_call_id":"call_search","content":[{"type":"tool_result","name":"mcp__mcpx.workspace","content":"{}"}]}]
    })).expect("dotted MCP history names must be legal on provider wire");
    assert_eq!(
        request["messages"][0]["content"][0]["name"],
        "mcp__mcpx.workspace"
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
        "functions.mcp__codex_review__review_start"
    );
    assert_eq!(
        request["messages"][1]["content"][0]["name"],
        "functions.mcp__codex_review__review_start"
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
    let expected = json!("functions.mcp__codex_review__review_start");
    assert_eq!(request["tools"][0]["function"]["name"], expected);
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        expected
    );
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
        2,
        "distinct literal declarations must remain independently callable: {request}"
    );
    assert_eq!(
        tools[0]["function"]["name"],
        "functions.mcp__mcpx__workspace"
    );
    assert_eq!(tools[1]["function"]["name"], "mcp__mcpx.workspace");
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
fn openai_chat_provider_tools_reject_conflicting_same_source_mcp_identity() {
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
        .expect_err("same-source declarations with conflicting schemas are ambiguous");
    assert!(
        error.contains("ConflictingOutboundFields") && error.contains("mcp__mcpx__workspace"),
        "unexpected error: {error}"
    );
}

#[test]
fn openai_chat_aliases_distinct_custom_tools_with_same_provider_name() {
    let payload = json!({
        "model": "glm-5.3",
        "messages": [{"role":"assistant", "tool_calls":[
            {"id":"nested", "type":"function", "namespace":"functions",
             "function":{"name":"exec", "arguments":"{\"input\":\"pwd\"}"},
             "routecodex_chat_extension":{"responses_tool_call_type":"custom_tool_call"}},
            {"id":"plain", "type":"function",
             "function":{"name":"functions__exec", "arguments":"{\"input\":\"ls\"}"},
             "routecodex_chat_extension":{"responses_tool_call_type":"custom_tool_call"}}
        ]}],
        "tool_choice":{"type":"custom", "namespace":"functions", "name":"exec"},
        "tools": [
            {"type": "namespace", "name": "functions", "tools": [
                {"type": "custom", "name": "exec", "description":"nested", "format": {"type": "text"}}
            ]},
            {"type": "custom", "name": "functions__exec", "description":"plain", "format": {"type": "text"}}
        ]
    });
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("distinct declared identities must receive unique dispatch names");
    let tools = request["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 2);
    let nested = tools
        .iter()
        .find(|tool| tool["function"]["description"] == "nested")
        .unwrap();
    let plain = tools
        .iter()
        .find(|tool| tool["function"]["description"] == "plain")
        .unwrap();
    let alias = nested["function"]["name"].as_str().unwrap();
    assert_ne!(alias, "functions__exec");
    assert!(!alias.is_empty() && alias.len() <= 64);
    assert!(alias
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')));
    assert_eq!(plain["function"]["name"], "functions__exec");
    for tool in tools {
        assert_eq!(tool["type"], "function");
        assert_eq!(
            tool["function"]["parameters"],
            json!({"type":"object", "properties":{
                "input":{"type":"string", "description":"Raw free-form tool input."}
            }, "required":["input"], "additionalProperties":false})
        );
    }
    assert_eq!(
        request["tool_choice"],
        json!({"type":"function", "function":{"name":alias}})
    );
    let calls = request["messages"][0]["tool_calls"].as_array().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["id"], "nested");
    assert_eq!(calls[0]["function"]["name"], alias);
    assert_eq!(calls[0]["function"]["arguments"], r#"{"input":"pwd"}"#);
    assert_eq!(calls[1]["id"], "plain");
    assert_eq!(calls[1]["function"]["name"], "functions__exec");
    assert_eq!(calls[1]["function"]["arguments"], r#"{"input":"ls"}"#);
    let registry =
        provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry::from_request(
            &payload,
            "openai-chat",
        )
        .unwrap();
    let inverse = registry.identity_for_wire_name(alias).unwrap();
    assert_eq!(inverse.namespace_segments, vec!["functions"]);
    assert_eq!(inverse.leaf_name, "exec");
    assert_eq!(
        inverse.kind,
        provider_compat_core::namespace_tools::ToolKind::Custom
    );
    // An unchanged plain name has no inverse namespace authority.
    assert!(registry.identity_for_wire_name("functions__exec").is_none());
    let mut response = json!({"output":[
        {"type":"custom_tool_call", "call_id":"nested", "name":alias, "input":"pwd"},
        {"type":"custom_tool_call", "call_id":"plain", "name":"functions__exec", "input":"ls"}
    ]});
    super::super::request_outbound_mcp_names::restore_responses_mcp_tool_identities(
        &mut response,
        &registry.restore_identities(),
    );
    assert_eq!(
        response["output"],
        json!([
            {"type":"custom_tool_call", "call_id":"nested", "namespace":"functions", "name":"exec", "input":"pwd"},
            {"type":"custom_tool_call", "call_id":"plain", "name":"functions__exec", "input":"ls"}
        ])
    );
    assert_eq!(
        build_v3_openai_chat_standard_request_from_chat_canonical(&payload).unwrap(),
        request
    );
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
    assert_eq!(
        request["tools"][0]["function"]["name"],
        "functions.exec_command"
    );
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
        json!("session")
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
    })).expect("plain declaration spelling does not grant a leaf binding");
    assert_eq!(
        request["tools"][0]["function"]["name"],
        "functions.mcp__mcpx__session"
    );
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        "session"
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
    }))
    .expect("custom tool output names must remain exact");
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
        "functions.mcp__codex_review__review_start"
    );
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        "functions.mcp__codex_review__review_start"
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
        "functions.mcp__codex_review__review_start"
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
        request["tools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|tool| tool["type"] == "function"
                && tool["function"]["name"] == "mcp__mcpx__workspace")),
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
        request["tools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|tool| tool["type"] == "function"
                && tool["function"]["name"] == "mcp__mcpx__workspace")),
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
#[test]
fn responses_relay_selected_target_filters_hosted_search_only() {
    let payload = json!({
        "model": "test",
        "messages": [{"role": "user", "content": "hello"}],
        "tools": [
            {"type": "web_search"},
            {"type": "function", "name": "lookup", "parameters": {"type": "object"}}
        ],
        "tool_choice": {"type": "web_search"}
    });
    let default_wire =
        build_v3_openai_responses_standard_request_for_selected_target(&payload, false).unwrap();
    assert_eq!(default_wire["tools"].as_array().unwrap().len(), 1);
    assert_eq!(default_wire["tools"][0]["name"], "lookup");
    assert!(default_wire.get("tool_choice").is_none());
    let hosted_wire =
        build_v3_openai_responses_standard_request_for_selected_target(&payload, true).unwrap();
    assert_eq!(hosted_wire["tools"].as_array().unwrap().len(), 2);
    assert_eq!(hosted_wire["tool_choice"]["type"], "web_search");
}

#[test]
fn chat_default_target_drops_forced_hosted_search_choice() {
    let payload = json!({
        "model": "gpt-5.5",
        "messages": [{"role": "user", "content": "hello"}],
        "tools": [{"type": "web_search"}],
        "tool_choice": {"type": "web_search"}
    });
    let wire = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &payload,
        V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        false,
    )
    .unwrap();
    assert!(wire.get("tools").is_none());
    assert!(wire.get("tool_choice").is_none());
}

#[test]
fn chat_default_target_drops_anthropic_hosted_search_shape() {
    let payload = json!({
        "model": "gpt-5.5",
        "messages": [{"role": "user", "content": "hello"}],
        "tools": [{"type": "web_search_20250305", "name": "web_search"}],
        "tool_choice": {"type": "web_search_20250305"}
    });
    let wire = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &payload,
        V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        false,
    )
    .unwrap();
    assert!(wire.get("tools").is_none());
    assert!(wire.get("tool_choice").is_none());
}

#[test]
fn chat_native_remote_search_without_capability_drops_hosted_search() {
    let payload = json!({
        "model": "local-model",
        "messages": [{"role": "user", "content": "summarize"}],
        "tools": [
            {"type": "web_search"},
            {"type": "function", "function": {"name": "read_file"}}
        ],
        "tool_choice": {"type": "web_search"}
    });
    let wire = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &payload,
        V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        false,
    )
    .unwrap();
    assert_eq!(wire["tools"].as_array().unwrap().len(), 1);
    assert_eq!(wire["tools"][0]["function"]["name"], "read_file");
    assert!(wire.get("tool_choice").is_none());
}

#[test]
fn openai_chat_outbound_maps_developer_role_to_system() {
    let canonical = json!({
        "model": "gpt-5.5",
        "messages": [
            {"role": "developer", "content": "You are a helpful assistant."},
            {"role": "user", "content": "hello"},
        ],
    });
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("developer role must project to chat wire");
    assert_eq!(request["messages"][0]["role"], "system");
    assert_eq!(
        request["messages"][0]["content"],
        "You are a helpful assistant."
    );
    assert_eq!(request["messages"][1]["role"], "user");
}
