use super::*;

#[test]
fn test_empty_input_error() {
    let result = run_req_outbound_stage3_compat_json("".to_string());
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Input JSON is empty"));
}

#[test]
fn test_invalid_json_error() {
    let result = run_req_outbound_stage3_compat_json("not valid json".to_string());
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Failed to parse input JSON"));
}

#[test]
fn test_no_profile_passthrough() {
    let input = ReqOutboundCompatInput {
        payload: json!({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]}),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_123".to_string()),
            entry_endpoint: Some("/v1/chat".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.applied_profile.is_none());
    assert!(result.native_applied);
    assert_eq!(result.payload["model"], "gpt-4");
}

#[test]
fn lmstudio_profile_preserves_openai_responses_structured_tool_input() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "MiniMax-M3",
            "input": [
                { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "exec_command", "arguments": { "cmd": "pwd" } },
                { "type": "function_call_output", "id": "fc_1", "call_id": "call_1", "output": "ok" }
            ],
            "tools": []
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("lmstudio".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_lmstudio_responses_tool_input".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();

    assert!(result.payload["input"].as_array().is_some());
    assert_eq!(result.payload["input"][0]["type"], json!("function_call"));
    assert_eq!(
        result.payload["input"][1]["type"],
        json!("function_call_output")
    );
}

#[test]
fn test_openai_responses_normalizes_chat_style_function_tools_without_profile() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gpt-5.5",
            "input": "use tool",
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "description": "run a command",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "cmd": {"type": "string"}
                            },
                            "required": ["cmd"]
                        }
                    }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_responses_tool_shape".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.applied_profile.is_none());
    assert!(result.native_applied);
    assert_eq!(result.payload["tools"][0]["type"], "function");
    assert_eq!(result.payload["tools"][0]["name"], "exec_command");
    assert_eq!(result.payload["tools"][0]["description"], "run a command");
    assert_eq!(result.payload["tools"][0]["parameters"]["type"], "object");
    assert!(result.payload["tools"][0].get("function").is_none());
}

#[test]
fn test_openai_responses_strips_historical_reasoning_content_without_profile() {
    let mut input_entries = Vec::new();
    for index in 0..22 {
        input_entries.push(json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": format!("history {}", index) }]
        }));
    }
    input_entries.push(json!({
        "type": "reasoning",
        "content": [{ "type": "reasoning_text", "text": "provider must not receive this" }],
        "encrypted_content": "opaque-reasoning-state"
    }));
    input_entries.push(json!({
        "type": "message",
        "role": "user",
        "content": [{ "type": "input_text", "text": "next" }]
    }));

    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gpt-5.5",
            "input": input_entries
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_responses_reasoning_content".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    let input = result.payload["input"].as_array().unwrap();
    assert_eq!(input[22]["type"], "reasoning");
    assert!(input[22].get("content").is_none());
    assert_eq!(
        input[22]["encrypted_content"].as_str(),
        Some("opaque-reasoning-state")
    );
    assert_eq!(input[23]["content"][0]["text"].as_str(), Some("next"));
}

#[test]
fn openai_chat_single_tool_call_history_profile_splits_parallel_assistant_tool_calls() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-pro",
            "messages": [
                {"role": "user", "content": "run both"},
                {
                    "role": "assistant",
                    "content": "I will run them.",
                    "tool_calls": [
                        {"id": "call_a", "type": "function", "function": {"name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"}},
                        {"id": "call_b", "type": "function", "function": {"name": "exec_command", "arguments": "{\"cmd\":\"date\"}"}}
                    ]
                },
                {"role": "tool", "tool_call_id": "call_a", "content": "/tmp"},
                {"role": "tool", "tool_call_id": "call_b", "content": "today"}
            ],
            "tools": [{"type": "function", "function": {"name": "exec_command", "parameters": {"type": "object"}}}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:single-tool-call-history".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_single_tool_history".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("tools".to_string()),
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("deepseek-v4-pro".to_string()),
            client_model_id: Some("gpt-5.4".to_string()),
            original_model_id: Some("gpt-5.4".to_string()),
            provider_id: Some("tokenrelay".to_string()),
            provider_key: Some("tokenrelay.key1.deepseek-v4-pro".to_string()),
            runtime_key: Some("tokenrelay.key1".to_string()),
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.applied_profile.as_deref(),
        Some("chat:single-tool-call-history")
    );
    let messages = result.payload["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 5);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"], "I will run them.");
    assert_eq!(messages[1]["tool_calls"].as_array().unwrap().len(), 1);
    assert_eq!(messages[1]["tool_calls"][0]["id"], "call_a");
    assert_eq!(messages[2]["role"], "assistant");
    assert!(messages[2]["content"].is_null());
    assert_eq!(messages[2]["tool_calls"].as_array().unwrap().len(), 1);
    assert_eq!(messages[2]["tool_calls"][0]["id"], "call_b");
    assert_eq!(messages[3]["tool_call_id"], "call_a");
    assert_eq!(messages[4]["tool_call_id"], "call_b");
}

#[test]
fn openai_chat_single_tool_call_history_profile_splits_history_and_latest_parallel_turns() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-pro",
            "messages": [
                {"role": "user", "content": "older request"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "hist_a", "type": "function", "function": {"name": "exec_command", "arguments": "{}"}},
                        {"id": "hist_b", "type": "function", "function": {"name": "exec_command", "arguments": "{}"}}
                    ]
                },
                {"role": "tool", "tool_call_id": "hist_a", "content": "older a"},
                {"role": "tool", "tool_call_id": "hist_b", "content": "older b"},
                {"role": "user", "content": "latest request"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "latest_a", "type": "function", "function": {"name": "exec_command", "arguments": "{}"}},
                        {"id": "latest_b", "type": "function", "function": {"name": "exec_command", "arguments": "{}"}},
                        {"id": "latest_c", "type": "function", "function": {"name": "exec_command", "arguments": "{}"}}
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:single-tool-call-history".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_history_and_latest".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("tools".to_string()),
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("deepseek-v4-pro".to_string()),
            client_model_id: Some("gpt-5.4".to_string()),
            original_model_id: Some("gpt-5.4".to_string()),
            provider_id: Some("tokenrelay".to_string()),
            provider_key: Some("tokenrelay.key1.deepseek-v4-pro".to_string()),
            runtime_key: Some("tokenrelay.key1".to_string()),
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    let messages = result.payload["messages"].as_array().unwrap();
    let assistant_tool_ids: Vec<String> = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .map(|message| {
            let calls = message["tool_calls"].as_array().expect("tool calls");
            assert_eq!(calls.len(), 1);
            calls[0]["id"].as_str().unwrap().to_string()
        })
        .collect();

    assert_eq!(
        assistant_tool_ids,
        vec!["hist_a", "hist_b", "latest_a", "latest_b", "latest_c"]
    );
}

#[test]
fn openai_chat_parallel_assistant_tool_calls_stay_unchanged_without_profile() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-pro",
            "messages": [
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {"id": "call_a", "type": "function", "function": {"name": "exec_command", "arguments": "{}"}},
                        {"id": "call_b", "type": "function", "function": {"name": "exec_command", "arguments": "{}"}}
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_parallel_no_profile".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("deepseek-v4-pro".to_string()),
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    let messages = result.payload["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["tool_calls"].as_array().unwrap().len(), 2);
    assert!(result.applied_profile.is_none());
}

#[test]
fn openai_chat_single_tool_call_history_profile_leaves_single_call_unchanged() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-pro",
            "messages": [
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {"id": "call_a", "type": "function", "function": {"name": "exec_command", "arguments": "{}"}}
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:single-tool-call-history".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_single_profile".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("deepseek-v4-pro".to_string()),
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    let messages = result.payload["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["tool_calls"].as_array().unwrap().len(), 1);
    assert_eq!(messages[0]["tool_calls"][0]["id"], "call_a");
    assert_eq!(
        result.applied_profile.as_deref(),
        Some("chat:single-tool-call-history")
    );
}

#[test]
fn test_profile_selection() {
    let input = ReqOutboundCompatInput {
        payload: json!({"model": "deepseek-chat"}),
        adapter_context: AdapterContext {
            compatibility_profile: Some("deepseek-compat".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_456".to_string()),
            entry_endpoint: Some("/v1/chat".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.applied_profile.is_none());
    assert!(result.native_applied);
}

#[test]
fn test_empty_profile_treated_as_none() {
    let input = ReqOutboundCompatInput {
        payload: json!({"model": "test"}),
        adapter_context: AdapterContext {
            compatibility_profile: Some("   ".to_string()),
            provider_protocol: None,
            request_id: None,
            entry_endpoint: None,
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.applied_profile.is_none());
    assert!(result.native_applied);
}

#[test]
fn req_outbound_compat_strips_visual_tool_use_without_tool_result() {
    let input = json!({
        "payload": {
            "model": "MiniMax-M3",
            "messages": [
                {"role":"assistant","content":[{"type":"tool_use","id":"call_img","name":"view_image","input":{"path":"/tmp/a.png"}}]},
                {"role":"user","content":[{"type":"text","text":"[Image omitted]"}]},
                {"role":"assistant","content":[{"type":"tool_use","id":"call_shell","name":"exec_command","input":{"cmd":"pwd"}}]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_shell","content":"ok"}]}
            ]
        },
        "adapterContext": {
            "providerProtocol": "anthropic-messages",
            "compatibilityProfile": "anthropic:claude-code"
        }
    });

    let output = run_req_outbound_stage3_compat_json(input.to_string()).unwrap();
    let result: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(
        result["payload"]["messages"][0]["content"],
        json!([{"type":"text","text":"[Image omitted]"}])
    );
    assert_eq!(
        result["payload"]["messages"][2]["content"][0]["type"].as_str(),
        Some("tool_use")
    );
}

#[test]
fn test_json_roundtrip() {
    let input_json = r#"{
        "payload": {"model": "gpt-4", "messages": [{"role": "user", "content": "hello"}]},
        "adapterContext": {
            "compatibilityProfile": "test-profile",
            "providerProtocol": "openai-chat",
            "requestId": "req_789",
            "entryEndpoint": "/v1/chat"
        }
    }"#;

    let result = run_req_outbound_stage3_compat_json(input_json.to_string()).unwrap();
    let output: CompatResult = serde_json::from_str(&result).unwrap();
    assert!(output.applied_profile.is_none());
    assert!(output.native_applied);
}

#[test]
fn test_explicit_profile_takes_priority() {
    let input = ReqOutboundCompatInput {
        payload: json!({"model": "deepseek-chat"}),
        adapter_context: AdapterContext {
            compatibility_profile: Some("context-profile".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_999".to_string()),
            entry_endpoint: Some("/v1/chat".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: Some("explicit-profile".to_string()),
    };
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.applied_profile.is_none());
    assert!(result.native_applied);
}

#[test]
fn test_pinned_alias_lookup_and_unpin_json_api() {
    let session_id = "sid-pinned-alias-test";
    let signature = "x".repeat(64);

    let adapter_context = AdapterContext {
        compatibility_profile: None,
        provider_protocol: Some("gemini-chat".to_string()),
        request_id: None,
        entry_endpoint: None,
        route_id: None,
        rt: None,
        captured_chat_request: None,
        deepseek: None,
        claude_code: None,
        anthropic_thinking: None,
        estimated_input_tokens: None,
        model_id: None,
        client_model_id: None,
        original_model_id: None,
        provider_id: Some("gemini".to_string()),
        provider_key: Some("gemini.demo.gemini-2.5-flash".to_string()),
        runtime_key: None,
        client_request_id: None,
        group_request_id: None,
        session_id: Some(session_id.to_string()),
        conversation_id: None,
    };
}

#[test]
fn test_preserve_latest_chat_media_when_target_is_not_multimodal() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "text-only",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "look"},
                        {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-chat".to_string()),
            request_id: None,
            entry_endpoint: None,
            route_id: None,
            rt: Some(json!({ "supportsMultimodal": false })),
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.payload["messages"][0]["content"][1]["image_url"]["url"],
        "https://example.com/a.png"
    );
}

#[test]
fn test_preserve_latest_responses_media_when_target_is_not_multimodal() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "text-only",
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "look"},
                        {"type": "input_image", "image_url": "https://example.com/a.png"}
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-responses".to_string()),
            request_id: None,
            entry_endpoint: None,
            route_id: None,
            rt: Some(json!({ "supportsMultimodal": false })),
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.payload["input"][0]["content"][1]["image_url"],
        "https://example.com/a.png"
    );
}

#[test]
fn test_preserve_latest_chat_media_when_target_supports_vision() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "vision-only",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "look"},
                        {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-chat".to_string()),
            request_id: None,
            entry_endpoint: None,
            route_id: Some("vision".to_string()),
            rt: Some(json!({ "supportsMultimodal": false, "supportsVision": true })),
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.payload["messages"][0]["content"][1]["image_url"]["url"],
        "https://example.com/a.png"
    );
}

#[test]
fn test_preserve_latest_responses_media_when_target_supports_vision() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "vision-only",
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "look"},
                        {"type": "input_image", "image_url": "https://example.com/a.png"}
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-responses".to_string()),
            request_id: None,
            entry_endpoint: None,
            route_id: Some("vision".to_string()),
            rt: Some(json!({ "supportsMultimodal": false, "supportsVision": true })),
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.payload["input"][0]["content"][1]["image_url"],
        "https://example.com/a.png"
    );
}
