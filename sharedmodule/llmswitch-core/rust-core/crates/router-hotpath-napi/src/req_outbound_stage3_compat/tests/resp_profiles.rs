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

#[test]
fn test_resp_profile_chat_glm_extracts_tool_calls_from_xlc_glm_marker_sample() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "chatcmpl-bba48e973d9964d5",
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "<|tool_calls_section_begin|> <|tool_call_begin|> call_1jDJHGWJY6IznXALCUX97FwV <|tool_call_argument_begin|> {\"cmd\": \"git status --short -- sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_sse_stream.rs sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/lmstudio/request.rs sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/instructions/state.rs\", \"login\": true, \"max_output_tokens\": 4000, \"tty\": false, \"workdir\": \"/Users/fanzhang/Documents/github/routecodex\"} <|tool_call_end|> <|tool_call_begin|> call_3JdTDcvj4Xtiom5gyXI2Boxl <|tool_call_argument_begin|> {\"cmd\": \"git status --short -- sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/mod.rs sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing_state_store.rs sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_stop_message_actions.rs\", \"login\": true, \"max_output_tokens\": 4000, \"tty\": false, \"workdir\": \"/Users/fanzhang/Documents/github/routecodex\"} <|tool_call_end|> <|tool_calls_section_end|>",
                    "tool_calls": []
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_1782198181237_a0f0169a".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("glm-5.2".to_string()),
            client_model_id: None,
            original_model_id: None,
            provider_id: Some("XLC".to_string()),
            provider_key: Some("XLC.key1.glm-5.2".to_string()),
            runtime_key: Some("XLC.key1".to_string()),
            client_request_id: Some("req_1782198181237_a0f0169a".to_string()),
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:glm".to_string()));
    let message = &result.payload["choices"][0]["message"];
    assert!(message["content"].is_null());
    assert!(message.get("reasoning_content").is_none());
    assert_eq!(message["tool_calls"].as_array().unwrap().len(), 2);
    assert_eq!(
        message["tool_calls"][0]["id"],
        "call_1jDJHGWJY6IznXALCUX97FwV"
    );
    assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
    assert_eq!(
        message["tool_calls"][1]["id"],
        "call_3JdTDcvj4Xtiom5gyXI2Boxl"
    );
    assert_eq!(message["tool_calls"][1]["function"]["name"], "exec_command");
    let args = message["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap_or("");
    assert!(args.contains("hub_resp_outbound_sse_stream.rs"));
}
