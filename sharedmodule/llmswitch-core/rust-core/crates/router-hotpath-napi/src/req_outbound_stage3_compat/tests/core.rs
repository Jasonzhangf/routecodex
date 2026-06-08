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
fn test_strip_latest_chat_media_when_target_is_not_multimodal() {
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
        result.payload["messages"][0]["content"],
        json!([
            {"type": "text", "text": "look"},
            {"type": "text", "text": "[Image omitted]"}
        ])
    );
}

#[test]
fn test_strip_latest_responses_media_when_target_is_not_multimodal() {
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
        result.payload["input"][0]["content"],
        json!([
            {"type": "input_text", "text": "look"},
            {"type": "input_text", "text": "[Image omitted]"}
        ])
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
