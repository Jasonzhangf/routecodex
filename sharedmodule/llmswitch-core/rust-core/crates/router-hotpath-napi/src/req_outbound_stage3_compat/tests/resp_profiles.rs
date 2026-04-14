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
fn test_resp_inbound_iflow_protocol_mismatch_native_noop() {
    let input = ReqOutboundCompatInput {
        payload: json!({"id": "resp_2", "output": []}),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:iflow".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_resp_2".to_string()),
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
fn test_resp_profile_chat_gemini_cli_native_applied() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "request_id": "req_resp_gemini_cli_1",
            "candidates": [
                {
                    "content": {
                        "parts": [
                            { "thoughtSignature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }
                        ]
                    }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some("req_resp_gemini_cli_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("coding-primary".to_string()),
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: Some("antigravity".to_string()),
            provider_key: Some("antigravity.alpha.gemini-2.5".to_string()),
            runtime_key: Some("antigravity.alpha".to_string()),
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:gemini-cli".to_string()));
    assert_eq!(result.payload["request_id"], "req_resp_gemini_cli_1");
}

#[test]
fn test_resp_profile_chat_iflow_unwraps_body_and_harvests_tool_calls() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "status": 200,
            "msg": "ok",
            "body": {
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "tool_calls": [],
                        "content": "<function_calls>{\"tool_calls\":[{\"id\":\"call_iflow_1\",\"type\":\"function\",\"function\":{\"name\":\"shell_command\",\"arguments\":{\"command\":\"pwd\",\"cwd\":\"/tmp\"}}}]}</function_calls>"
                    }
                }]
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:iflow".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_iflow_resp_1".to_string()),
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
    assert_eq!(result.applied_profile, Some("chat:iflow".to_string()));
    assert!(result.payload.get("status").is_none());
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
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
fn test_resp_profile_chat_deepseek_web_harvests_quote_wrapped_tool_calls_via_global_text_harvest() {
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
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
}

#[test]
fn test_resp_profile_chat_deepseek_web_harvests_truncated_rcc_container_by_boundary_repair_only() {
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
    assert!(error.contains("tool_choice=required"));
}

#[test]
fn test_resp_profile_chat_deepseek_web_harvests_real_failed_command_wrappers() {
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
    assert_eq!(
        result.applied_profile,
        Some("chat:deepseek-web".to_string())
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
fn test_resp_profile_chat_deepseek_web_harvests_live_single_command_wrapper() {
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
        r#"cd /Volumes/extension/code/finger && grep -n "hasModule\|getModule" src/orchestration/message-hub.ts | head -30"#
    );
    assert_eq!(
        args1["cmd"],
        r#"cd /Volumes/extension/code/finger && grep -n "resolveAgentToModule" src/orchestration/message-hub.ts"#
    );
    assert_eq!(
        args2["cmd"],
        r#"cd /Volumes/extension/code/finger && grep -n "moduleRegistry\|agentRegistry" src/orchestration/message-hub.ts | head -30"#
    );
    let content = result.payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(content.contains("让我查看 message-hub 如何查找 target agent"));
    assert!(!content.contains("<command>"));
    assert!(!content.contains("<grep_command>"));
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
    assert!(
        result.payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .map(|rows| rows.is_empty())
            .unwrap_or(true)
    );
}

#[test]
fn test_resp_profile_chat_deepseek_web_preserves_compact_exec_command_arguments() {
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
    assert_eq!(
        result.applied_profile,
        Some("chat:deepseek-web".to_string())
    );
    assert_eq!(result.payload["choices"][0]["finish_reason"], "tool_calls");

    let tool_calls = result.payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tool_calls.len(), 2);

    let args0: Value = serde_json::from_str(
        tool_calls[0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(
        args0["cmd"],
        "catdocs/design/project-dispatch-operation-architecture.md"
    );
    assert!(args0.get("workdir").is_none());

    let args1: Value = serde_json::from_str(
        tool_calls[1]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(
        args1["cmd"],
        "ls -la /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md2>&1 &&head -200 /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md"
    );
    assert_eq!(
        result.payload["metadata"]["deepseek"]["toolCallState"],
        "text_tool_calls"
    );
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
    assert!(
        result.payload["choices"][0]["message"]
            .get("function_call")
            .is_none()
    );
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
                    "reasoning_content": "exec_command<arg_key>cmd</arg_key><arg_value>node scripts/start-headful.mjs --profile weibo_fresh</arg_value><arg_key>yield_time_ms</arg_key><arg_value>30000</arg_value></tool_call>"
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
