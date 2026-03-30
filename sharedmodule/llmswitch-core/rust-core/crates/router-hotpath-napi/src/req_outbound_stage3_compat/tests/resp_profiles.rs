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
                        "content": "<function_calls>{\"tool_calls\":[{\"id\":\"call_deepseek_1\",\"type\":\"function\",\"function\":{\"name\":\"shell_command\",\"arguments\":{\"command\":\"pwd\",\"cwd\":\"/tmp\"}}}]}</function_calls>"
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
fn test_resp_profile_chat_deepseek_web_harvests_markdown_bullet_and_repairs_cmd_quotes() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "tool_calls": [],
                    "content": "我先创建 epic，再把子任务挂进去。\n\n• {\"tool_calls\":[{\"input\":{\"cmd\":\"bd --no-db create \"Mailbox 统一消息与心跳优先级改造\" --type epic --description \"统一 mailbox 消息三段式格式，定义优先级\"\"},\"name\":\"exec_command\"}]}"
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
    assert!(
        parsed["cmd"]
            .as_str()
            .unwrap_or("")
            .contains("Mailbox 统一消息与心跳优先级改造")
    );
}

#[test]
fn test_resp_profile_chat_deepseek_web_harvests_quote_wrapped_tool_calls() {
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
