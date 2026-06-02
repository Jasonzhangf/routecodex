use super::*;

#[test]
fn test_resp_inbound_no_profile_passthrough() {
    let input = ReqOutboundCompatInput {
        payload: json!({"id": "resp_1", "output": []}),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_resp_1".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.applied_profile.is_none());
    assert!(result.native_applied);
    assert_eq!(result.payload["id"], "resp_1");
}

#[test]
fn test_resp_profile_chat_lmstudio_native_applied() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
                },
                "finish_reason": "stop"
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:lmstudio".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_resp_lmstudio_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:lmstudio".to_string()));
    assert_eq!(result.payload["object"], "chat.completion");
    assert_eq!(result.payload["model"], "unknown");
    assert!(result.payload["id"]
        .as_str()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false));
    assert!(result.payload["created"].as_i64().unwrap_or_default() > 0);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let call_id = result.payload["choices"][0]["message"]["tool_calls"][0]["call_id"]
        .as_str()
        .unwrap_or("");
    let id = result.payload["choices"][0]["message"]["tool_calls"][0]["id"]
        .as_str()
        .unwrap_or("");
    assert!(!call_id.is_empty());
    assert_eq!(call_id, id);
}

#[test]
fn test_resp_profile_chat_lmstudio_harvests_responses_output_tool_tokens() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "object": "response",
            "id": "resp_lmstudio_1",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "• waiting...\n<|tool_calls_section_begin|>\n<|tool_call_begin|> functions.exec_command:66 <|tool_call_argument_begin|> {\"cmd\":\"pwd\"} <|tool_call_end|>\n<|tool_calls_section_end|>\n"
                        }
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:lmstudio".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_resp_lmstudio_output_1".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:lmstudio".to_string()));
    assert_eq!(result.payload["output"][0]["type"], "function_call");
    assert_eq!(result.payload["output"][0]["name"], "exec_command");
    assert_eq!(result.payload["output"][0]["call_id"], "call_1");
    assert_eq!(result.payload["output"][0]["id"], "fc_1");
}

#[test]
fn test_resp_profile_chat_deepseek_web_harvests_real_sample_with_extra_trailing_closer() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "data: {\"v\":{\"response\":{\"message_id\":2,\"status\":\"WIP\",\"content\":\"\"}}}\n\n",
                    "data: {\"p\":\"response/content\",\"v\":\"<|DSML|tool_calls>\\n\"}\n\n",
                    "data: {\"o\":\"APPEND\",\"v\":\"{\\\"name\\\":\\\"exec_command\\\",\\\"arguments\\\":{\\\"cmd\\\":\\\"bash -lc 'curl -s -o /dev/null -w \\\\\\\"%{http_code}\\\\\\\" http://127.0.0.1:4040/'\\\"},\\\"id\\\":\\\"check_webdebug\\\",\\\"justification\\\":\\\"验证 fin web-debug 是否运行\\\"}}\"}\n\n",
                    "data: {\"v\":\"\\n</|DSML|tool_calls>\"}\n\n",
                    "data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n"
                )
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_resp_deepseek_web_realshape_1".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: Some("coding/coding-long-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "cmd": { "type": "string" }
                                },
                                "required": ["cmd"]
                            }
                        }
                    }
                ]
            })),
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
    let result = run_resp_inbound_stage3_compat(input).expect("deepseek-web compat");
    assert!(result.native_applied);
    assert_eq!(
        result.applied_profile,
        Some("chat:deepseek-web".to_string())
    );
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["id"],
        "check_webdebug"
    );
}

#[test]
fn test_resp_profile_chat_claude_code_protocol_mismatch_native_noop() {
    let input = ReqOutboundCompatInput {
        payload: json!({"id": "resp_3", "output": []}),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:claude-code".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_resp_3".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.applied_profile.is_none());
    assert!(result.native_applied);
}

#[test]
fn test_resp_profile_output2choices_native_applied() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "resp_4",
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {"type": "output_text", "text": "hello"}
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:output2choices-test".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_resp_4".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(
        result.applied_profile,
        Some("responses:output2choices-test".to_string())
    );
    assert_eq!(result.payload["choices"][0]["message"]["content"], "hello");
    assert_eq!(result.payload["choices"][0]["finish_reason"], "stop");
    assert_eq!(result.payload["request_id"], "req_resp_4");
}

#[test]
fn test_resp_profile_output2choices_converts_tool_calls() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "resp_5",
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_call",
                            "id": "call_abc",
                            "function": {"name": "exec_command", "arguments": {"cmd": "pwd"}}
                        }
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:output2choices-test".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_resp_5".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
        "{\"cmd\":\"pwd\"}"
    );
}

#[test]
fn test_resp_profile_output2choices_protocol_mismatch_native_noop() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "resp_6",
            "output": [{"type": "message", "role": "assistant", "content": []}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:output2choices-test".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_resp_6".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert!(result.applied_profile.is_none());
}

#[test]
fn test_resp_profile_responses_c4m_protocol_match_native_applied() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "resp_7",
            "output_text": "ok"
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:c4m".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_resp_7".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("responses:c4m".to_string()));
    assert!(result.rate_limit_detected.is_none());
}

#[test]
fn test_resp_profile_responses_c4m_detects_rate_limit_text() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "resp_8",
            "output_text": "The Codex-For.ME service is available, but you have reached the request limit"
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:c4m".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_resp_8".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("responses:c4m".to_string()));
    assert_eq!(result.rate_limit_detected, Some(true));
}

#[test]
fn test_resp_profile_chat_qwen_native_applied() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "data": {
                "id": "qwen_resp_1",
                "created": 1730000000,
                "model": "qwen3-plus",
                "choices": [
                    {
                        "index": 1,
                        "message": {
                            "role": "assistant",
                            "content": "done",
                            "reasoning_content": "thinking...",
                            "tool_calls": [
                                {
                                    "id": "call_qwen_1",
                                    "function": {
                                        "name": "exec_command",
                                        "arguments": {"cmd": "pwd"}
                                    }
                                }
                            ]
                        },
                        "finish_reason": "tool_calls"
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 6,
                    "total_tokens": 16
                }
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwen".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwen_resp_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:qwen".to_string()));
    assert_eq!(result.payload["id"], "qwen_resp_1");
    assert_eq!(result.payload["object"], "chat.completion");
    assert_eq!(result.payload["choices"][0]["message"]["content"], "done");
    assert_eq!(
        result.payload["choices"][0]["message"]["reasoning_content"],
        "thinking..."
    );
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
        "{\"cmd\":\"pwd\"}"
    );
}

#[test]
fn test_resp_profile_chat_qwen_harvests_marker_tool_calls_in_compat_layer() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "data": {
                "id": "qwen_resp_marker_1",
                "created": 1730000001,
                "model": "qwen3-plus",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "继续\n<|tool_calls_section_begin|>\n<|tool_call_begin|> functions.exec_command:66 <|tool_call_argument_begin|> {\"cmd\":\"pwd\",\"workdir\":\"/tmp\"} <|tool_call_end|>\n<|tool_calls_section_end|>\n"
                    },
                    "finish_reason": "stop"
                }]
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwen".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwen_marker_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:qwen".to_string()));
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(result.payload["choices"][0]["message"]["content"], "继续");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args_str = result.payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("{}");
    let args_json: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
    assert_eq!(args_json["cmd"], "pwd");
    assert_eq!(args_json["workdir"], "/tmp");
}

#[test]
fn test_resp_profile_chat_qwen_harvests_marker_tool_calls_from_thinking_content() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "data": {
                "id": "qwen_resp_marker_2",
                "created": 1730000002,
                "model": "qwen3-plus",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": [{
                            "type": "thinking",
                            "thinking": "<|tool_calls_section_begin|>\n<|tool_call_begin|> functions.exec_command:13 <|tool_call_argument_begin|> {\"cmd\":\"pwd\",\"workdir\":\"/tmp\"} <|tool_call_end|>\n<|tool_calls_section_end|>"
                        }]
                    },
                    "finish_reason": "stop"
                }]
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwen".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwen_marker_2".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    assert!(result.payload["choices"][0]["message"]
        .get("reasoning_content")
        .is_none());
    assert_eq!(result.payload["choices"][0]["message"]["content"], "");
}

#[test]
fn test_resp_profile_chat_qwen_repairs_newline_inside_marker_json_and_split_tokens() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "data": {
                "id": "qwen_resp_marker_3",
                "created": 1730000003,
                "model": "qwen3-plus",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "The push command is running.\n<|tool_calls_section_begin|> <|\n  tool_call_begin|> functions.write_stdin:69 <|tool_call_argument_begin|> {} <|\n  tool_call_end|> <|tool_calls_section_end|>\n继续\n<|tool_calls_section_begin|>\n<|tool_call_begin|> functions.exec_command:45 <|tool_call_argument_begin|> {\"command\":\"head -70 /tmp/a.py\nmore.py\"} <|tool_call_end|>\n<|tool_calls_section_end|>\n"
                    },
                    "finish_reason": "stop"
                }]
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwen".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwen_marker_3".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    let tool_calls = result.payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tool_calls.len(), 2);
    assert_eq!(tool_calls[0]["function"]["name"], "write_stdin");
    assert_eq!(tool_calls[1]["function"]["name"], "exec_command");
    let args_str = tool_calls[1]["function"]["arguments"]
        .as_str()
        .unwrap_or("{}");
    let args_json: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
    let command = args_json["command"].as_str().unwrap_or("");
    assert!(command.contains("head -70 /tmp/a.py"));
    assert!(command.contains("more.py"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_unwraps_envelope_and_harvests_tool_calls() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "code": 0,
            "msg": "",
            "data": {
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "tool_calls": [],
                        "content": "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"id\":\"call_deepseek_1\",\"name\":\"exec_command\",\"input\":{\"cmd\":\"bash -lc 'pwd'\"}}]}\nRCC_TOOL_CALLS_JSON"
                    }
                }]
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(
        result.applied_profile,
        Some("chat:deepseek-web".to_string())
    );
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    assert_eq!(
        result.payload["metadata"]["deepseek"]["toolCallState"],
        "text_tool_calls"
    );
    assert_eq!(
        result.payload["metadata"]["deepseek"]["toolCallSource"],
        "fallback"
    );
}

#[test]
fn test_resp_profile_chat_deepseek_web_harvests_function_results_markup() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "先看结果\n<function_results>{\"exec_command\":{\"stdout\":\"ok\"}}</function_results>"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_4".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    let content = result.payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(!content.contains("<function_results>"));
    assert!(!content.contains("</function_results>"));
    assert!(content.contains("```json"));
    assert_eq!(
        result.payload["metadata"]["deepseek"]["functionResultsTextHarvested"],
        true
    );
}

#[test]
fn test_resp_profile_chat_deepseek_web_preserves_empty_reasoning_content_from_thinking_only_sse() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "event: ready\n",
                    "data: {\"request_message_id\":1,\"response_message_id\":2}\n\n",
                    "data: {\"v\":{\"response\":{\"message_id\":2,\"status\":\"WIP\",\"thinking_content\":\"\"}}}\n\n",
                    "data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n"
                )
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_empty_reasoning_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(
        result.applied_profile,
        Some("chat:deepseek-web".to_string())
    );
    assert_eq!(result.payload["choices"][0]["message"]["content"], "");
    assert_eq!(
        result.payload["choices"][0]["message"]["reasoning_content"],
        ""
    );
    assert_eq!(result.payload["choices"][0]["finish_reason"], "stop");
}

#[test]
fn test_resp_profile_chat_deepseek_web_harvests_tool_calls_from_rcc_container_only() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "tool_calls": [],
                    "content": "准备执行。\n<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"bash -lc 'bd --no-db create \\\"Mailbox 统一消息与心跳优先级改造\\\" --type epic'\"}}]}\nRCC_TOOL_CALLS_JSON\n容器外文本不参与解析。"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_shape_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args = result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap_or("{}");
    let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert!(parsed["cmd"]
        .as_str()
        .unwrap_or("")
        .contains("Mailbox 统一消息与心跳优先级改造"));
    let content = result.payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(content.contains("准备执行"));
    assert!(content.contains("容器外文本不参与解析"));
    assert!(!content.contains("RCC_TOOL_CALLS_JSON"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_does_not_harvest_quote_wrapped_tool_calls_outside_wrapper() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "tool_calls": [],
                    "content": "原文是：<quote>{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"git status\"}}]}</quote>"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_quote_harvest_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto"
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "stop");
    assert!(result.payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .map(|rows| rows.is_empty())
        .unwrap_or(true));
}

#[test]
fn test_resp_profile_chat_deepseek_web_rejects_truncated_rcc_container_without_closing_boundary() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "tool_calls": [],
                    "content": "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_container_boundary_repair_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "required"
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let error = run_resp_inbound_stage3_compat(input).unwrap_err();
    assert!(error.contains("declared tools present"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_does_not_harvest_container_external_patch_text() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "tool_calls": [],
                    "content": "*** Begin Patch\n*** Update File: demo.txt\n@@\n-old\n+new\n*** End Patch"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_no_patch_harvest_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "parameters": {
                            "type": "object",
                            "properties": {"patch": {"type": "string"}},
                            "required": ["patch"]
                        }
                    }
                }]
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "stop");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"],
        json!([])
    );
}

#[test]
fn test_resp_profile_chat_deepseek_web_strips_commentary_markup() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "primary text\n<commentary>内部注释</commentary>"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_5".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    let content = result.payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(content.contains("primary text"));
    assert!(!content.contains("<commentary>"));
    assert!(!content.contains("</commentary>"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_strips_meta_leakage_when_tool_call_exists() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "<We are in a tool-call block. We output only RCC_TOOL_CALLS_JSON. See the system prompt for exact format.>\n<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"bash -lc 'pwd'\"}}]}\nRCC_TOOL_CALLS_JSON",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_strip_meta_leakage".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "required"
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    let message = &result.payload["choices"][0]["message"];
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
    assert_eq!(message["content"], Value::Null);
}

#[test]
fn test_resp_profile_chat_deepseek_web_harvests_sse_fenced_tool_call_wrappers() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "event: ready\n",
                    "data: {\"request_message_id\":7,\"response_message_id\":8,\"model_type\":\"default\"}\n\n",
                    "data: {\"v\":{\"response\":{\"message_id\":8,\"status\":\"WIP\",\"content\":\"\"}}}\n\n",
                    "data: {\"p\":\"response/content\",\"o\":\"APPEND\",\"v\":\"```\"}\n\n",
                    "data: {\"v\":\"json\"}\n\n",
                    "data: {\"v\":\"\\n\"}\n\n",
                    "data: {\"v\":\"<\"}\n\n",
                    "data: {\"v\":\"tool\"}\n\n",
                    "data: {\"v\":\"_call\"}\n\n",
                    "data: {\"v\":\">\\n\"}\n\n",
                    "data: {\"v\":\"{\\\"name\\\":\\\"update_plan\\\",\\\"arguments\\\":{\\\"plan\\\":[{\\\"step\\\":\\\"修改 scheduler.rs\\\",\\\"status\\\":\\\"completed\\\"}]}}\\n\"}\n\n",
                    "data: {\"v\":\"</\"}\n\n",
                    "data: {\"v\":\"tool\"}\n\n",
                    "data: {\"v\":\"_call\"}\n\n",
                    "data: {\"v\":\">\\n\"}\n\n",
                    "data: {\"v\":\"```\\n\"}\n\n",
                    "data: {\"v\":\"```\"}\n\n",
                    "data: {\"v\":\"json\"}\n\n",
                    "data: {\"v\":\"\\n\"}\n\n",
                    "data: {\"v\":\"<\"}\n\n",
                    "data: {\"v\":\"tool\"}\n\n",
                    "data: {\"v\":\"_call\"}\n\n",
                    "data: {\"v\":\">\\n\"}\n\n",
                    "data: {\"v\":\"{\\\"name\\\":\\\"exec_command\\\",\\\"arguments\\\":{\\\"cmd\\\":\\\"bash -lc 'echo ok'\\\"}}\\n\"}\n\n",
                    "data: {\"v\":\"</\"}\n\n",
                    "data: {\"v\":\"tool\"}\n\n",
                    "data: {\"v\":\"_call\"}\n\n",
                    "data: {\"v\":\">\\n\"}\n\n",
                    "data: {\"v\":\"```\"}\n\n",
                    "data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n"
                )
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_sse_fenced_wrappers".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "update_plan",
                        "parameters": {
                            "type": "object",
                            "properties": {"plan": {"type": "array"}},
                            "required": ["plan"]
                        }
                    }
                },{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto"
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    let tool_calls = result.payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tool_calls.len(), 2);
    assert_eq!(tool_calls[0]["function"]["name"], "update_plan");
    assert_eq!(tool_calls[1]["function"]["name"], "exec_command");
    let exec_args: Value = serde_json::from_str(
        tool_calls[1]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(exec_args["cmd"], "bash -lc 'echo ok'");
}

#[test]
fn test_resp_profile_chat_deepseek_web_rejects_hidden_transport_markup_without_valid_tool_call() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "Looking at your question about absolute line numbers causing buffer mis-rendering in Android, I need to examine the rendering logic.\n<use_mcp_tool>\n<server_name>computer_use</server_name>\n<tool_name>find</tool_name>\n<arguments>{\"path\":\"/Volumes/extension/code/zterm/android\",\"pattern\":\"*.{kt,java}\",\"content_pattern\":\"render|buffer|line\",\"max_results\":30}</arguments>\n</use_mcp_tool>",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_hidden_transport".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto"
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let error = run_resp_inbound_stage3_compat(input).unwrap_err();
    assert!(error.contains("forbidden hidden tool transport markup"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_backfills_usage_from_estimate() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "hello from deepseek usage estimation"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_usage_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: Some(42.0),
            model_id: Some("deepseek-chat".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    let usage = result.payload["usage"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let prompt = usage
        .get("prompt_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    let completion = usage
        .get("completion_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    let total = usage
        .get("total_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    assert_eq!(prompt, 42);
    assert!(completion > 0);
    assert_eq!(total, prompt + completion);
    assert_eq!(
        usage.get("input_tokens").and_then(|v| v.as_i64()),
        Some(prompt)
    );
    assert_eq!(
        usage.get("output_tokens").and_then(|v| v.as_i64()),
        Some(completion)
    );
}

#[test]
fn test_resp_profile_chat_deepseek_web_preserves_upstream_usage() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 7,
                "total_tokens": 17
            },
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "ok"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_usage_2".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: Some(999.0),
            model_id: Some("deepseek-chat".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["usage"]["prompt_tokens"], 10);
    assert_eq!(result.payload["usage"]["completion_tokens"], 7);
    assert_eq!(result.payload["usage"]["total_tokens"], 17);
}

#[test]
fn test_resp_profile_chat_deepseek_web_business_error_propagates() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "code": 500,
            "msg": "当前找我聊的人太多了，可以晚点再来问我哦。",
            "data": {
                "biz_code": 3,
                "biz_msg": "当前找我聊的人太多了，可以晚点再来问我哦。"
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_2".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let error = run_resp_inbound_stage3_compat(input).unwrap_err();
    assert!(error.contains("[deepseek-web] upstream business error"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_required_tool_missing_returns_error() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "任务已完成。",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_3".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: Some(json!({
                "tool_choice": "required"
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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
    let error = run_resp_inbound_stage3_compat(input).unwrap_err();
    assert!(error.contains("declared tools present"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_declared_tools_missing_returns_error_without_tool_choice() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "我先分析一下。",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_declared_tools_missing".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }]
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let error = run_resp_inbound_stage3_compat(input)
        .expect_err("strict declared tools should fail without tool call");
    assert!(error.contains("DeepSeek declared tools present but no valid tool call was produced"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_declared_tools_auto_without_tool_choice_allows_plain_text() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "当前目录是 /Users/fanzhang/Documents/github/routecodex。",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_declared_tools_auto_text_ok".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto",
                "messages": [
                    {
                        "role": "user",
                        "content": "先调用 exec_command 工具执行 pwd。拿到工具结果后，用一句中文返回当前目录，不要再次调用工具。"
                    },
                    {
                        "role": "tool",
                        "content": "/Users/fanzhang/Documents/github/routecodex"
                    }
                ]
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.payload["choices"][0]["message"]["content"],
        Value::String("当前目录是 /Users/fanzhang/Documents/github/routecodex。".to_string())
    );
    assert_eq!(
        result.payload["metadata"]["deepseek"]["toolCallState"],
        Value::String("no_tool_calls".to_string())
    );
}

#[test]
fn test_resp_profile_chat_deepseek_web_coding_route_plain_text_final_requires_tool_call() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "我已经完成检查，根因在 response 侧 declared tools 判定过严，需要对齐 request 侧路由语义。",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_coding_plain_text_final".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("coding-long-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto",
                "messages": [{
                    "role": "user",
                    "content": "继续"
                }]
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert_eq!(result.payload["choices"][0]["finish_reason"], "stop");
    assert_eq!(
        result.payload["choices"][0]["message"]["content"],
        "我已经完成检查，根因在 response 侧 declared tools 判定过严，需要对齐 request 侧路由语义。"
    );
    assert_eq!(
        result.payload["metadata"]["deepseek"]["toolCallState"],
        Value::String("no_tool_calls".to_string())
    );
}

#[test]
fn test_resp_profile_chat_deepseek_web_coding_route_auto_without_tool_choice_allows_plain_text() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "我已经完成检查，根因在 response 侧 declared tools 判定过严。",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_coding_auto_text_ok".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("coding-long-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto",
                "messages": [{
                    "role": "user",
                    "content": "继续"
                }]
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let error = run_resp_inbound_stage3_compat(input)
        .expect_err("coding route with declared tools should fail fast when tool call is missing");
    assert!(error.contains("DeepSeek declared tools present but no valid tool call was produced"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_narrative_tool_intent_is_rejected_without_wrapper() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "好的，我尝试通过 claw 作为跳板连接到 coder1。\n\n## 步骤 1：检查 claw 上是否有 coder1 的 SSH 密钥或认证方式\nssh -i ~/.ssh/claw.pem root@159.75.134.56",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_narrative_tool_intent".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }]
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let error = run_resp_inbound_stage3_compat(input).unwrap_err();
    assert!(error.contains("narrative tool intent"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_harvests_tool_call_from_reasoning_content_tail() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "我们上次修改了 scheduler.rs，使 running 状态不再阻塞 dispatch_ready_task。\n\n让我先查看 fin-cli 的帮助，看看有哪些命令可以创建持久会话。\n<|DSML|tool_calls>\n{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"bash -lc '~/.cargo/bin/fin-cli --help'\"}}\n</|DSML|tool_calls>",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_reasoning_tail_tool_call".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-long-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "model": "deepseek-reasoner",
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "messages": [{
                    "role": "user",
                    "content": "继续"
                }]
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: Some(23.0),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args: Value = serde_json::from_str(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "bash -lc '~/.cargo/bin/fin-cli --help'");
    let prompt = result.payload["usage"]["prompt_tokens"]
        .as_i64()
        .unwrap_or_default();
    let completion = result.payload["usage"]["completion_tokens"]
        .as_i64()
        .unwrap_or_default();
    let total = result.payload["usage"]["total_tokens"]
        .as_i64()
        .unwrap_or_default();
    assert_eq!(prompt, 23);
    assert!(completion > 0);
    assert_eq!(total, prompt + completion);
    assert_eq!(result.payload["usage"]["input_tokens"], Value::from(prompt));
    assert_eq!(
        result.payload["usage"]["output_tokens"],
        Value::from(completion)
    );
}

#[test]
fn test_resp_profile_chat_deepseek_web_rejects_dsml_interrupt_wrapper_as_hidden_transport() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "<|DSML|interrupt|reason>No recent actions to report; waiting for user continuation.</|DSML|interrupt|reason>",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_dsml_interrupt".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("search/search-deepseek-web-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto"
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let error = run_resp_inbound_stage3_compat(input).unwrap_err();
    assert!(error.contains("forbidden hidden tool transport markup"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_strips_final_wrapper_transparently() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "<final>\n\nJason，先确认 SSH 链路恢复，再继续后续配置检查。\n</final>"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_final_wrapper".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking/thinking-deepseek-web-primary".to_string()),
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

    let result = run_resp_inbound_stage3_compat(input).expect("deepseek-web final wrapper strip");
    assert_eq!(
        result.payload["choices"][0]["message"]["content"],
        "Jason，先确认 SSH 链路恢复，再继续后续配置检查。"
    );
}

#[test]
fn test_resp_profile_chat_deepseek_web_responses_shape_reasoning_tail_harvests_tool_call() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "object": "response",
            "id": "resp_deepseek_live_same_shape",
            "created_at": 1778459296,
            "status": "completed",
            "model": "gpt-5.4",
            "output": [
                {
                    "id": "reasoning_req_live_1",
                    "type": "reasoning",
                    "status": "completed",
                    "content": [{
                        "type": "reasoning_text",
                        "text": "我们先检查当前目录，确认工作区位置。\n<|DSML|tool_calls>\n<|DSML|invoke name=\"exec_command\">\n<|DSML|parameter name=\"cmd\"><![CDATA[bash -lc 'pwd']]></|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>"
                    }],
                    "summary": [{
                        "type": "summary_text",
                        "text": "我们先检查当前目录。"
                    }]
                },
                {
                    "id": "message_req_live_1",
                    "role": "assistant",
                    "status": "completed",
                    "type": "message",
                    "content": []
                }
            ],
            "usage": {
                "input_tokens": 81,
                "output_tokens": 32,
                "total_tokens": 113
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_live_same_shape".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: Some("coding/coding-deepseek-web-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "model": "gpt-5.4",
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "required",
                "messages": [{
                    "role": "user",
                    "content": "继续"
                }]
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["metadata"]["deepseek"]["toolCallState"],
        "text_tool_calls"
    );
    assert_eq!(
        result.payload["metadata"]["deepseek"]["toolCallSource"],
        "fallback"
    );
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args: Value = serde_json::from_str(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "bash -lc 'pwd'");
}

#[test]
fn test_resp_profile_chat_deepseek_web_sse_patch_without_append_harvests_reasoning_tool_call() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "event: ready\n",
                    "data: {\"request_message_id\":1,\"response_message_id\":2,\"model_type\":\"default\"}\n\n",
                    "data: {\"v\":{\"response\":{\"message_id\":2,\"status\":\"WIP\",\"content\":\"\",\"thinking_content\":null}}}\n\n",
                    "data: {\"p\":\"response/thinking_content\",\"v\":\"让我先查看 fin-cli 的帮助。\\n\"}\n\n",
                    "data: {\"v\":\"<|DSML|tool_calls>\\n\"}\n\n",
                    "data: {\"v\":\"{\\\"name\\\":\\\"exec_command\\\",\\\"arguments\\\":{\\\"cmd\\\":\\\"bash -lc '~/.cargo/bin/fin-cli --help'\\\"}}\\n\"}\n\n",
                    "data: {\"v\":\"</|DSML|tool_calls>\"}\n\n",
                    "data: {\"p\":\"response/accumulated_token_usage\",\"o\":\"SET\",\"v\":123}\n\n",
                    "data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n",
                    "event: finish\n",
                    "data: {}\n\n"
                )
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_sse_patch_without_append".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-long-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "model": "deepseek-reasoner",
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "messages": [{
                    "role": "user",
                    "content": "继续"
                }]
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args: Value = serde_json::from_str(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "bash -lc '~/.cargo/bin/fin-cli --help'");
}

#[test]
fn test_resp_profile_chat_deepseek_web_harvests_invalid_backslash_escaped_shell_payload() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "data: {\"p\":\"response/content\",\"o\":\"APPEND\",\"v\":\"<|DSML|tool_calls>\\n\"}\n\n",
                    "data: {\"v\":\"{\\\"arguments\\\":{\\\"cmd\\\":\\\"bash -lc 'cat > /tmp/a.ts << \\\\\\\"EOF\\\\\\\"\\\\nwith open\\\\('x'\\\\) as f:\\\\n    content = f.read\\\\(\\\\)\\\\nEOF'\\\",\\\"justification\\\":\\\"repair sample\\\"},\\\"id\\\":\\\"call_invalid_escape_1\\\",\\\"name\\\":\\\"exec_command\\\"}\"}\n\n",
                    "data: {\"v\":\"\\n</|DSML|tool_calls>\"}\n\n",
                    "data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n"
                )
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_invalid_backslash_escape_1".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: Some("coding/coding-deepseek-web-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "required"
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args: Value = serde_json::from_str(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    let cmd = args["cmd"].as_str().unwrap_or("");
    assert!(cmd.contains("with open\\('x'\\) as f:"));
    assert!(cmd.contains("content = f.read\\(\\)"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_sse_fragment_dsml_invoke_parameter_cdata_harvests_tool_call()
{
    let input = ReqOutboundCompatInput {
        payload: json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "event: ready\n",
                    "data: {\"request_message_id\":1,\"response_message_id\":2,\"model_type\":\"expert\"}\n\n",
                    "data: {\"updated_at\":1778402528.5027158}\n\n",
                    "data: {\"v\":{\"response\":{\"message_id\":2,\"parent_id\":1,\"model\":\"\",\"role\":\"ASSISTANT\",\"thinking_enabled\":true,\"status\":\"WIP\",\"accumulated_token_usage\":0,\"fragments\":[{\"id\":2,\"type\":\"THINK\",\"content\":\"The\",\"elapsed_secs\":null,\"references\":[],\"stage_id\":1}]}}}\n\n",
                    "data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\" user wants tool call.\"}\n\n",
                    "data: {\"p\":\"response/fragments\",\"o\":\"APPEND\",\"v\":[{\"id\":3,\"type\":\"RESPONSE\",\"content\":\"<\",\"references\":[],\"stage_id\":1}]}\n\n",
                    "data: {\"p\":\"response/fragments/-1/content\",\"v\":\"|DSML|tool_calls>\\n\"}\n\n",
                    "data: {\"v\":\" <|DSML|invoke name=\\\"exec_command\\\">\\n\"}\n\n",
                    "data: {\"v\":\"   <|DSML|parameter name=\\\"cmd\\\"><![CDATA[bash -lc 'pwd']]></|DSML|parameter>\\n\"}\n\n",
                    "data: {\"v\":\" </|DSML|invoke>\\n\"}\n\n",
                    "data: {\"v\":\"</|DSML|tool_calls>\"}\n\n",
                    "data: {\"p\":\"response\",\"o\":\"BATCH\",\"v\":[{\"p\":\"accumulated_token_usage\",\"v\":2222},{\"p\":\"quasi_status\",\"v\":\"FINISHED\"}]}\n\n",
                    "data: {\"p\":\"response/status\",\"o\":\"SET\",\"v\":\"FINISHED\"}\n\n",
                    "event: close\n",
                    "data: {\"click_behavior\":\"none\",\"auto_resume\":false}\n\n"
                )
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_sse_fragment_dsml_cdata".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: Some("thinking/thinking-deepseek-web-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "required"
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["metadata"]["deepseek"]["toolCallState"],
        "text_tool_calls"
    );
    assert_eq!(
        result.payload["metadata"]["deepseek"]["toolCallSource"],
        "fallback"
    );
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args: Value = serde_json::from_str(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "bash -lc 'pwd'");
}

#[test]
fn test_resp_profile_chat_deepseek_web_does_not_harvest_generic_command_wrappers_without_whitelist_container(
) {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "tool_calls": [],
                    "content": r#"根据你的描述，system agent 重启后无法向 project agent 派发任务，问题出在 agent 注册表在重启后未重建。
让我定位具体代码：
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && grep -n "agentRegistry\|registerAgent\|getAgent" src/orchestration/message-hub.ts | head -30
  </grep_command>
</command>
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && grep -n "resolveTargetModule\|moduleLookup" src/blocks/agent-runtime-block/index.ts | head -30
  </grep_command>
</command>
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && ls -la src/agents/finger-system-agent/registry.ts
  </grep_command>
</command>"#
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_real_failed_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}, "workdir": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto"
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "stop");
    assert!(result.payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .map(|rows| rows.is_empty())
        .unwrap_or(true));
}

#[test]
fn test_resp_profile_chat_deepseek_web_rejects_top_level_exec_command_object_without_wrapper() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "• {\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"bash -lc \\\"pwd\\\"\",\"workdir\":\"/Users/fanzhang/Documents/github/routecodex\"}}\n\"tool_call\"}",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_top_level_tail_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "tool_choice": "required",
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }]
            })),
            deepseek: Some(json!({
                "strictToolRequired": true,
                "textToolFallback": true
            })),
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

    let error = run_resp_inbound_stage3_compat(input).unwrap_err();
    assert!(error.contains("declared tools present"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_does_not_harvest_live_single_command_wrapper_without_whitelist_container(
) {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "tool_calls": [],
                    "content": r#"现在我看到问题了。让我查看 message-hub 如何查找 target agent：

<command>
<grep_command>
cd /Volumes/extension/code/finger && grep -n "hasModule\|getModule" src/orchestration/message-hub.ts | head -30
</grep_command>
</command>

<command>
<grep_command>
cd /Volumes/extension/code/finger && grep -n "resolveAgentToModule" src/orchestration/message-hub.ts
</grep_command>
</command>

<command>
<grep_command>
cd /Volumes/extension/code/finger && grep -n "moduleRegistry\|agentRegistry" src/orchestration/message-hub.ts | head -30
</grep_command>
</command>FINISHED"#
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_live_single_wrapper_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto"
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "stop");
    assert!(result.payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .map(|rows| rows.is_empty())
        .unwrap_or(true));
}

#[test]
fn test_resp_profile_chat_qwenchat_web_harvests_real_failed_command_wrappers() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "tool_calls": [],
                    "content": r#"根据你的描述，system agent 重启后无法向 project agent 派发任务，问题出在 agent 注册表在重启后未重建。
让我定位具体代码：
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && grep -n "agentRegistry\|registerAgent\|getAgent" src/orchestration/message-hub.ts | head -30
  </grep_command>
</command>
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && grep -n "resolveTargetModule\|moduleLookup" src/blocks/agent-runtime-block/index.ts | head -30
  </grep_command>
</command>
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && ls -la src/agents/finger-system-agent/registry.ts
  </grep_command>
</command>"#
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwenchat-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwenchat_resp_real_failed_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}, "workdir": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto"
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(
        result.applied_profile,
        Some("chat:qwenchat-web".to_string())
    );
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["metadata"]["deepseek"]["toolCallState"],
        "text_tool_calls"
    );
    assert_eq!(
        result.payload["metadata"]["deepseek"]["toolCallSource"],
        "fallback"
    );

    let tool_calls = result.payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tool_calls.len(), 3);
    for entry in &tool_calls {
        assert_eq!(entry["function"]["name"], "exec_command");
    }
    let args0: Value = serde_json::from_str(
        tool_calls[0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    let args1: Value = serde_json::from_str(
        tool_calls[1]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    let args2: Value = serde_json::from_str(
        tool_calls[2]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(
        args0["cmd"],
        r#"cd /Volumes/extension/code/finger && grep -n "agentRegistry\|registerAgent\|getAgent" src/orchestration/message-hub.ts | head -30"#
    );
    assert_eq!(
        args1["cmd"],
        r#"cd /Volumes/extension/code/finger && grep -n "resolveTargetModule\|moduleLookup" src/blocks/agent-runtime-block/index.ts | head -30"#
    );
    assert_eq!(
        args2["cmd"],
        "cd /Volumes/extension/code/finger && ls -la src/agents/finger-system-agent/registry.ts"
    );
    let content = result.payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(content.contains("system agent 重启后无法向 project agent 派发任务"));
    assert!(content.contains("让我定位具体代码"));
    assert!(!content.contains("<command>"));
    assert!(!content.contains("<grep_command>"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_does_not_guess_exec_command_from_command_line_prose() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "tool_calls": [],
                    "content": "<command-line><command-line>继续</command-line></command-line>FINISHED"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_command_line_prose_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }, {
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "parameters": {
                            "type": "object",
                            "properties": {"patch": {"type": "string"}},
                            "required": ["patch"]
                        }
                    }
                }],
                "tool_choice": "auto"
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "stop");
    assert!(result.payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .map(|rows| rows.is_empty())
        .unwrap_or(true));
}

#[test]
fn test_resp_profile_chat_deepseek_web_does_not_harvest_compact_exec_command_json_outside_wrapper()
{
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "tool_calls": [],
                    "content": format!(
                        "{{\"tool_calls\":[\
                            {{\"name\":\"exec_command\",\"input\":{{\"cmd\":\"catdocs/design/project-dispatch-operation-architecture.md\"}}}},\
                            {{\"name\":\"exec_command\",\"input\":{{\"cmd\":\"ls -la /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md2>&1 &&head -200 /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md\"}}}}\
                        ]}}"
                    )
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_resp_compact_exec_repair_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}, "workdir": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto"
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "stop");
    assert!(result.payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .map(|rows| rows.is_empty())
        .unwrap_or(true));
}

#[test]
fn test_resp_profile_chat_qwenchat_web_harvests_execute_command_masked_args_sample() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "tool_calls": [],
                    "content": "现在我需要查看关键的项目管理文件。\n让我先检查项目根目录是否有 HEARTBEAT.md 和 DELIVERY.md：\n<execute_command>\n<command>ls -la /Volumes/extension/code/finger/HEARTBEAT.md /Volumes/extension/code/finger/DELIVERY.md /Volumes/extension/code/finger/MEMORY.md /Volumes/extension/code/finger/CACHE.md 2>&1</command>\n<workdir>/Volumes/extension/code/finger</workdir>\n</execute_command>"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwenchat-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwenchat_resp_real_failed_2".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}, "workdir": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }]
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args = result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap_or("{}");
    let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert_eq!(
        parsed["cmd"],
        "ls -la /Volumes/extension/code/finger/HEARTBEAT.md /Volumes/extension/code/finger/DELIVERY.md /Volumes/extension/code/finger/MEMORY.md /Volumes/extension/code/finger/CACHE.md 2>&1"
    );
    assert_eq!(parsed["workdir"], "/Volumes/extension/code/finger");
    let content = result.payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(content.contains("现在我需要查看关键的项目管理文件"));
    assert!(!content.contains("<execute_command>"));
}

#[test]
fn test_resp_profile_chat_qwenchat_web_normalizes_legacy_function_call_into_tool_calls() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": "",
                    "function_call": {
                        "id": "call_qwenchat_legacy_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"bash -lc 'pwd'\",\"workdir\":\"/Volumes/extension/code/finger\"}"
                    }
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwenchat-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwenchat_legacy_function_call_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: Some(json!({
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}, "workdir": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto"
            })),
            deepseek: Some(json!({
                "strictToolRequired": false,
                "textToolFallback": true
            })),
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

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(
        result.applied_profile,
        Some("chat:qwenchat-web".to_string())
    );
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    assert!(result.payload["choices"][0]["message"]
        .get("function_call")
        .is_none());
    let args = result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap_or("{}");
    let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert_eq!(parsed["cmd"], "bash -lc 'pwd'");
    assert_eq!(parsed["workdir"], "/Volumes/extension/code/finger");
}

#[test]
fn test_resp_profile_chat_glm_extracts_tool_calls_from_reasoning_markup() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "glm_resp_1",
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "exec_command<arg_key>cmd</arg_key><arg_value>node scripts/start-headful.mjs --profile weibo_fresh</arg_value><arg_key>yield_time_ms</arg_key><arg_value>30000</arg_value></|DSML|tool_calls>"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_resp_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:glm".to_string()));
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args = result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap_or("");
    assert!(args.contains("start-headful.mjs"));
    assert!(args.contains("weibo_fresh"));
}

#[test]
fn test_resp_profile_chat_glm_extracts_tool_calls_from_fenced_json() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "glm_resp_2",
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "reasoning_content": "```tool\n{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}\n```"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_resp_2".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:glm".to_string()));
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
}

#[test]
fn test_resp_profile_chat_glm_extracts_tool_calls_from_bracketed_block() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "glm_resp_3",
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "reasoning_content": "[tool_call name=\"exec_command\"]{\"arguments\":{\"cmd\":\"ls\"}}[/tool_call]"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_resp_3".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
}

#[test]
fn test_resp_profile_chat_glm_preserves_bracketed_exec_command_without_canonical_cmd() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "glm_resp_invalid_exec_bracket_1",
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "reasoning_content": "[tool_call name=\"exec_command\"]{\"arguments\":{\"command\":\"pwd\"}}[/tool_call]"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_resp_invalid_exec_bracket_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert!(result.payload["choices"][0]["message"]["tool_calls"].is_null());
    assert_eq!(
        result.payload["choices"][0]["message"]["reasoning_content"],
        "[tool_call name=\"exec_command\"]{\"arguments\":{\"command\":\"pwd\"}}[/tool_call]"
    );
}

#[test]
fn test_resp_profile_chat_glm_preserves_fenced_exec_command_with_missing_cmd() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "glm_resp_invalid_exec_fence_1",
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "reasoning_content": "```tool\n{\"name\":\"exec_command\",\"arguments\":{}}\n```"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_resp_invalid_exec_fence_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert!(result.payload["choices"][0]["message"]["tool_calls"].is_null());
    assert_eq!(
        result.payload["choices"][0]["message"]["reasoning_content"],
        "```tool\n{\"name\":\"exec_command\",\"arguments\":{}}\n```"
    );
}

#[test]
fn test_resp_profile_chat_glm_preserves_tagged_exec_command_with_blank_cmd() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "glm_resp_invalid_exec_tagged_1",
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "reasoning_content": "exec_command<arg_key>cmd</arg_key><arg_value></arg_value></|DSML|tool_calls>"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_resp_invalid_exec_tagged_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert!(result.payload["choices"][0]["message"]["tool_calls"].is_null());
    assert_eq!(
        result.payload["choices"][0]["message"]["reasoning_content"],
        "exec_command<arg_key>cmd</arg_key><arg_value></arg_value></|DSML|tool_calls>"
    );
}

#[test]
fn test_resp_profile_chat_glm_extracts_tool_calls_from_inline_marker() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "glm_resp_4",
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "reasoning_content": "tool_call: {\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"echo ok\"}}"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_resp_4".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
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
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    let args = result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap_or("");
    assert!(args.contains("echo ok"));
}
