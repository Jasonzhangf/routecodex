use super::*;
use crate::req_outbound_stage3_compat::gemini_cli::reset_antigravity_signature_caches_for_bridge;

#[test]
fn test_req_profile_without_request_stage_native_passthrough() {
    let input = ReqOutboundCompatInput {
        payload: json!({"model": "gpt-4.1", "messages": [{"role": "user", "content": "hi"}]}),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:output2choices-test".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_no_stage_1".to_string()),
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
}

#[test]
fn test_req_profile_responses_c4m_native_applied() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gpt-4.1",
            "max_tokens": 200,
            "maxTokens": 300,
            "max_output_tokens": 400,
            "maxOutputTokens": 500,
            "instructions": "<b>System</b> instruction",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:c4m".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_c4m_1".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("responses:c4m".to_string()));
    assert!(result.payload.get("max_tokens").is_none());
    assert!(result.payload.get("maxTokens").is_none());
    assert!(result.payload.get("max_output_tokens").is_none());
    assert!(result.payload.get("maxOutputTokens").is_none());
    assert!(result.payload.get("instructions").is_none());
    assert_eq!(result.payload["input"][0]["role"], "system");
    assert_eq!(
        result.payload["input"][0]["content"][0]["text"],
        "System instruction"
    );
    assert_eq!(result.payload["input"][1]["role"], "user");
}

#[test]
fn test_req_profile_responses_c4m_protocol_mismatch_native_noop() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "instructions": "keep-me",
            "max_tokens": 100
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:c4m".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_c4m_2".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert!(result.applied_profile.is_none());
    assert_eq!(result.payload["max_tokens"], 100);
    assert_eq!(result.payload["instructions"], "keep-me");
}

#[test]
fn test_req_profile_responses_crs_strips_temperature() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gpt-5.2-codex",
            "temperature": 1,
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:crs".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_crs_1".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("responses:crs".to_string()));
    assert!(result.payload.get("temperature").is_none());
}

#[test]
fn test_req_profile_chat_claude_code_native_applied() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "glm-4.7",
            "system": [{"type": "text", "text": "Legacy system prompt"}],
            "messages": [{"role": "user", "content": "hello"}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:claude-code".to_string()),
            provider_protocol: Some("anthropic-messages".to_string()),
            request_id: Some("req_claude_1".to_string()),
            entry_endpoint: Some("/v1/messages".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:claude-code".to_string()));
    assert_eq!(result.payload["system"][0]["type"], "text");
    assert_eq!(result.payload["system"][0]["text"], DEFAULT_SYSTEM_TEXT);
    assert_eq!(result.payload["thinking"]["type"], "adaptive");
    assert_eq!(result.payload["output_config"]["effort"], "medium");
    assert!(result
        .payload
        .get("metadata")
        .and_then(|v| v.as_object())
        .is_some());
    let user_id = result.payload["metadata"]["user_id"].as_str();
    assert!(is_claude_code_user_id(user_id));
    assert_eq!(
        result.payload["messages"][0]["content"],
        "Legacy system prompt\n\nhello"
    );
}

#[test]
fn test_req_profile_chat_claude_code_glm5_effort_high() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "glm-5",
            "system": "Legacy system prompt",
            "messages": [{"role": "user", "content": "hello"}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:claude-code".to_string()),
            provider_protocol: Some("anthropic-messages".to_string()),
            request_id: Some("req_claude_glm5".to_string()),
            entry_endpoint: Some("/v1/messages".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:claude-code".to_string()));
    assert_eq!(result.payload["thinking"]["type"], "adaptive");
    assert_eq!(result.payload["output_config"]["effort"], "high");
}

#[test]
fn test_req_profile_chat_claude_code_honors_context_config() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "glm-5-air",
            "system": "Legacy system prompt",
            "messages": [{"role": "user", "content": "hello"}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:claude-code".to_string()),
            provider_protocol: Some("anthropic-messages".to_string()),
            request_id: Some("req_claude_cfg".to_string()),
            entry_endpoint: Some("/v1/messages".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: Some(json!({
                "systemText": "Custom Claude Code system",
                "preserveExistingSystemAsUserMessage": false
            })),
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
    assert_eq!(result.applied_profile, Some("chat:claude-code".to_string()));
    assert_eq!(
        result.payload["system"][0]["text"],
        "Custom Claude Code system"
    );
    assert_eq!(result.payload["messages"][0]["content"], "hello");
    assert_eq!(result.payload["output_config"]["effort"], "high");
}

#[test]
fn test_req_profile_anthropic_claude_code_protocol_mismatch_native_noop() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "system": "unchanged"
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("anthropic:claude-code".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_claude_2".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert!(result.applied_profile.is_none());
    assert_eq!(result.payload["system"], "unchanged");
}

#[test]
fn test_req_profile_chat_qwen_native_applied() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gpt-4",
            "messages": [
                {"role": "user", "content": "hello qwen"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"pwd\"}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "name": "exec_command",
                    "content": "ok"
                }
            ],
            "reasoning": {
                "effort": "high",
                "summary": "auto"
            },
            "stream": true,
            "max_tokens": 256,
            "stop": ["END"],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "description": "run shell",
                        "parameters": {"type": "object"}
                    },
                    "extra": true
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwen".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwen_1".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:qwen".to_string()));
    assert_eq!(result.payload["model"], "qwen3-coder-plus");
    assert_eq!(result.payload["messages"][0]["role"], "user");
    assert_eq!(result.payload["messages"][0]["content"], "hello qwen");
    assert_eq!(
        result.payload["messages"][1]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    assert_eq!(result.payload["messages"][2]["tool_call_id"], "call_1");
    assert_eq!(result.payload["max_tokens"], 256);
    assert_eq!(result.payload["stop"][0], "END");
    assert_eq!(result.payload["reasoning"]["effort"], "high");
    assert_eq!(result.payload["reasoning"]["summary"], "auto");
    assert_eq!(
        result.payload["tools"][0]["function"]["name"],
        "exec_command"
    );
    assert_eq!(result.payload["tools"][0]["extra"], true);
}

#[test]
fn test_req_profile_chat_qwen_normalizes_responses_input_content_types() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "qwen3.6-plus",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "hello"},
                        {"type": "input_image", "image_url": {"url": "https://example.com/a.png"}},
                        {"type": "input_video", "video_url": "https://example.com/a.mp4"}
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwen".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwen_types_1".to_string()),
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

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:qwen".to_string()));

    let content = &result.payload["messages"][0]["content"];
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[0]["text"], "hello");
    assert_eq!(content[1]["type"], "image_url");
    assert_eq!(
        content[1]["image_url"]["url"],
        "https://example.com/a.png"
    );
    assert_eq!(content[2]["type"], "video_url");
    assert_eq!(
        content[2]["video_url"]["url"],
        "https://example.com/a.mp4"
    );

    let serialized = serde_json::to_string(&result.payload).unwrap();
    assert!(!serialized.contains("\"input_text\""));
    assert!(!serialized.contains("\"input_image\""));
    assert!(!serialized.contains("\"input_video\""));
    assert!(result.payload.get("input").is_none());
}

#[test]
fn test_req_profile_chat_qwen_preserves_tool_choice() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "qwen3.6-plus",
            "messages": [
                {"role": "user", "content": "call echo"}
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "echo",
                        "description": "Echo text",
                        "parameters": {
                            "type": "object",
                            "properties": { "text": { "type": "string" } },
                            "required": ["text"]
                        }
                    }
                }
            ],
            "tool_choice": { "type": "function", "name": "echo" }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwen".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwen_tool_choice_1".to_string()),
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

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:qwen".to_string()));
    assert_eq!(result.payload["tool_choice"]["type"], "function");
    assert_eq!(result.payload["tool_choice"]["function"]["name"], "echo");
}

#[test]
fn test_req_profile_chat_qwen_preserves_historical_reasoning_content() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "qwen3.6-plus",
            "messages": [
                { "role": "user", "content": "run pwd" },
                {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "先确认当前工作目录，再继续执行工具调用。",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": { "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "name": "exec_command",
                    "content": "ok"
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwen".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwen_reasoning_history_1".to_string()),
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

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:qwen".to_string()));
    assert_eq!(
        result.payload["messages"][1]["reasoning_content"],
        "先确认当前工作目录，再继续执行工具调用。"
    );
    assert_eq!(
        result.payload["messages"][1]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
}

#[test]
fn test_req_profile_chat_lmstudio_native_applied() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gpt-4.1",
            "tool_choice": {"type": "function", "function": {"name": "exec_command"}},
            "input": [
                {
                    "type": "function_call",
                    "call_id": "shell#1",
                    "name": "exec_command",
                    "arguments": {"cmd": "pwd"}
                },
                {
                    "type": "function_call_output",
                    "id": "result-item-1",
                    "output": "ok"
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:lmstudio".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_lmstudio_1".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:lmstudio".to_string()));
    assert_eq!(result.payload["tool_choice"], serde_json::Value::Null);
    assert_eq!(result.payload["input"][0]["call_id"], "call_shell_1");
    assert_eq!(result.payload["input"][0]["id"], "fc_shell_1");
    assert_eq!(result.payload["input"][1]["call_id"], "call_result-item-1");
    assert_eq!(result.payload["input"][1]["id"], "fc_result-item-1");
}

#[test]
fn test_req_profile_chat_lmstudio_sanitizes_tools_for_responses_schema() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gemma-4-31b-it",
            "tool_choice": { "type": "function", "function": { "name": "exec_command" } },
            "tools": [
                {
                    "type": "function",
                    "function": { "name": "exec_command", "parameters": { "type": "object", "properties": { "cmd": { "type": "string" } } } }
                },
                {
                    "type": "web_search_preview",
                    "name": "web_search"
                },
                {
                    "type": { "unexpected": true },
                    "function": { "name": "update_plan", "parameters": "{\"type\":\"object\",\"properties\":{}}" }
                },
                {
                    "name": "write_stdin",
                    "parameters": { "type": "object", "properties": { "session_id": { "type": "number" } } }
                }
            ],
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "run tool test" }
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:lmstudio".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_lmstudio_tool_schema_1".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:lmstudio".to_string()));
    assert_eq!(result.payload["tool_choice"], "required");
    let tools = result.payload["tools"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tools.len(), 2);
    for tool in tools {
        assert_eq!(tool["type"], "function");
        assert!(tool["name"].as_str().unwrap_or("").len() > 0);
        assert!(tool["parameters"].is_object());
        assert!(tool.get("function").is_none());
    }
}

#[test]
fn test_req_profile_chat_iflow_normalizes_thinking_and_reasoning() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "kimi-k2.5",
            "messages": [
                {"role": "user", "content": "run"},
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"}
                        }
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:iflow".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_iflow_1".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:iflow".to_string()));
    assert_eq!(result.payload["thinking"]["type"], "enabled");
    assert_eq!(result.payload["temperature"], 1.0);
    assert_eq!(result.payload["messages"][1]["reasoning_content"], ".");
}

#[test]
fn test_req_profile_chat_iflow_respects_explicit_thinking_disabled() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "kimi-k2.5",
            "thinking": false,
            "messages": [
                {"role": "assistant", "tool_calls": [{"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{}"}}]}
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:iflow".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_iflow_2".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.payload["temperature"], 0.6);
    assert!(result.payload["messages"][0]["reasoning_content"].is_null());
}

#[test]
fn test_req_profile_chat_iflow_replaces_historical_inline_media() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "kimi-k2.5",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "older turn"},
                        {"type": "input_image", "image_url": "data:image/png;base64,AAA"},
                        {"type": "input_video", "video_url": "data:video/mp4;base64,BBB"}
                    ]
                },
                {"role": "assistant", "content": "ok"},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "latest turn"},
                        {"type": "input_image", "image_url": "data:image/png;base64,CCC"}
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:iflow".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_iflow_media_1".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    let history_content = result.payload["messages"][0]["content"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(history_content
        .iter()
        .any(|part| part["type"] == "text" && part["text"] == "[history_image_base64_omitted]"));
    assert!(history_content
        .iter()
        .any(|part| part["type"] == "text" && part["text"] == "[history_video_base64_omitted]"));
    assert_eq!(
        result.payload["messages"][2]["content"][1]["image_url"],
        "data:image/png;base64,CCC"
    );
}

#[test]
fn test_req_profile_chat_iflow_search_route_builds_web_search_tool() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "kimi-k2.5",
            "web_search": {
                "query": "routecodex latest build",
                "recency": "day",
                "count": 5
            },
            "messages": [
                {"role": "user", "content": "find latest routecodex updates"}
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:iflow".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_iflow_search_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("search-primary".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:iflow".to_string()));
    assert!(result.payload.get("web_search").is_none());
    assert_eq!(result.payload["tools"][0]["type"], "function");
    assert_eq!(result.payload["tools"][0]["function"]["name"], "web_search");
    assert_eq!(
        result.payload["tools"][0]["function"]["parameters"]["required"][0],
        "query"
    );
}

#[test]
fn test_req_profile_chat_iflow_search_route_drops_empty_web_search_helper() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "kimi-k2.5",
            "web_search": {
                "query": "   "
            },
            "messages": [
                {"role": "user", "content": "search"}
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:iflow".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_iflow_search_2".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("web_search-main".to_string()),
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
    assert!(result.native_applied);
    assert!(result.payload.get("web_search").is_none());
    assert!(result.payload.get("tools").is_none());
}

#[test]
fn test_req_profile_chat_glm_web_search_transform() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "glm-5",
            "web_search": {
                "query": "routecodex release notes",
                "recency": "week",
                "count": 7
            },
            "messages": [
                {"role": "user", "content": "search latest release notes"}
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_web_search_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("search-primary".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:glm".to_string()));
    assert!(result.payload.get("web_search").is_none());
    assert_eq!(result.payload["tools"][0]["type"], "web_search");
    assert_eq!(
        result.payload["tools"][0]["web_search"]["search_engine"],
        "search_std"
    );
    assert_eq!(
        result.payload["tools"][0]["web_search"]["search_query"],
        "routecodex release notes"
    );
    assert_eq!(
        result.payload["tools"][0]["web_search"]["search_recency_filter"],
        "week"
    );
    assert_eq!(result.payload["tools"][0]["web_search"]["count"], 7);
}

#[test]
fn test_req_profile_chat_glm_drops_empty_web_search_helper() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "glm-5",
            "web_search": {
                "query": "   "
            },
            "messages": [
                {"role": "user", "content": "search"}
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_web_search_2".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("search-primary".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:glm".to_string()));
    assert!(result.payload.get("web_search").is_none());
    assert!(result.payload.get("tools").is_none());
}

#[test]
fn test_req_profile_chat_glm_image_content_normalizes_image_parts() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "glm-4.7",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        { "type": "image", "url": "https://example.com/a.png" },
                        { "type": "image_url", "image_url": { "url": "https://example.com/b.png", "detail": "high" } }
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_image_content_1".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    let content = result.payload["messages"][0]["content"].as_array().unwrap();
    assert_eq!(content[0]["type"], "image_url");
    assert_eq!(content[0]["image_url"]["url"], "https://example.com/a.png");
    assert_eq!(content[1]["image_url"]["detail"], "high");
}

#[test]
fn test_req_profile_chat_glm_history_image_trim_drops_old_inline_images() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "glm-4.7",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "older turn" },
                        { "type": "input_image", "image_url": { "url": "data:image/png;base64,AAA" } }
                    ]
                },
                { "role": "assistant", "content": "ok" },
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "latest turn" },
                        { "type": "input_image", "image_url": { "url": "data:image/png;base64,BBB" } }
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_history_trim_1".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.payload["messages"][0]["content"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        result.payload["messages"][2]["content"][1]["image_url"]["url"],
        "data:image/png;base64,BBB"
    );
}

#[test]
fn test_req_profile_chat_glm_vision_prompt_rewrites_latest_image_turn() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "glm-4.6v",
            "max_tokens": 9000,
            "messages": [
                { "role": "system", "content": "legacy system" },
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "please inspect this" },
                        { "type": "input_image", "image_url": { "url": "https://example.com/shot.png" } }
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_vision_prompt_1".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(result.payload["messages"].as_array().unwrap().len(), 2);
    assert_eq!(result.payload["messages"][0]["role"], "system");
    assert!(result.payload["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("截图理解子系统"));
    assert_eq!(
        result.payload["messages"][1]["content"][0]["text"],
        "please inspect this"
    );
    assert_eq!(
        result.payload["messages"][1]["content"][1]["image_url"]["url"],
        "https://example.com/shot.png"
    );
    assert_eq!(result.payload["max_tokens"], 4096);
}

#[test]
fn test_req_profile_chat_glm_auto_thinking_injects_enabled_block() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "glm-4.7-air",
            "messages": [
                { "role": "user", "content": "hello" }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_auto_thinking_1".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(result.payload["thinking"]["type"], "enabled");
}

#[test]
fn test_req_profile_chat_glm_auto_thinking_skips_glm_4_6v() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "glm-4.6v",
            "messages": [
                { "role": "user", "content": "hello" }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:glm".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_glm_auto_thinking_2".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.payload.get("thinking").is_none());
}

#[test]
fn test_req_profile_chat_deepseek_web_native_applied() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-chat",
            "chat_session_id": "sess_1",
            "messages": [
                {"role": "system", "content": "follow contract"},
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": {"name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"}
                        }
                    ]
                },
                {"role": "user", "content": "run"}
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "description": "run shell",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_web_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("search-primary".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(
        result.applied_profile,
        Some("chat:deepseek-web".to_string())
    );
    assert_eq!(result.payload["chat_session_id"], "sess_1");
    assert!(result.payload["parent_message_id"].is_null());
    assert_eq!(result.payload["thinking_enabled"], false);
    assert_eq!(result.payload["search_enabled"], true);
    assert_eq!(
        result.payload["metadata"]["deepseek"]["strictToolRequired"],
        true
    );
    assert_eq!(
        result.payload["metadata"]["deepseek"]["textToolFallback"],
        true
    );
    let prompt = result.payload["prompt"].as_str().unwrap_or("");
    assert!(prompt.contains("Tool-call output contract (STRICT)"));
    assert!(prompt.contains("\"tool_calls\""));
    assert!(prompt.contains("[调用 list_files]"));
}

#[test]
fn test_req_profile_chat_deepseek_web_protocol_mismatch_native_noop() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-chat",
            "messages": [{"role": "user", "content": "keep"}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_deepseek_web_2".to_string()),
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
    assert!(result.native_applied);
    assert!(result.applied_profile.is_none());
    assert_eq!(result.payload["model"], "deepseek-chat");
}

#[test]
fn test_req_profile_chat_gemini_search_route_filters_tools() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "requestId": "gemini_req_1",
            "web_search": { "enabled": true },
            "tools": [
                {
                    "functionDeclarations": [
                        { "name": "web_search", "description": "search web" },
                        { "name": "exec_command", "description": "run shell" }
                    ]
                },
                {
                    "functionDeclarations": [
                        { "name": "exec_command", "description": "run shell" }
                    ]
                },
                {
                    "googleSearch": { "dynamicRetrievalConfig": { "mode": "MODE_DYNAMIC" } }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some("req_gemini_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("search-primary".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:gemini".to_string()));
    assert!(result.payload.get("web_search").is_none());
    assert_eq!(
        result.payload["tools"][0]["functionDeclarations"][0]["name"],
        "web_search"
    );
    assert_eq!(
        result.payload["tools"][1]["googleSearch"]["dynamicRetrievalConfig"]["mode"],
        "MODE_DYNAMIC"
    );
}

#[test]
fn test_req_profile_chat_gemini_search_route_injects_google_search_when_no_tools() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "requestId": "gemini_req_2"
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some("req_gemini_2".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("web_search-main".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:gemini".to_string()));
    assert_eq!(result.payload["tools"][0]["googleSearch"], json!({}));
}

#[test]
fn test_req_profile_chat_gemini_claude_schema_and_shallow_pick() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "claude-3-7-sonnet",
            "requestId": "gemini_req_claude_1",
            "userAgent": "antigravity",
            "foo": "drop_me",
            "tools": [
                {
                    "functionDeclarations": [
                        {
                            "name": "exec_command",
                            "strict": true,
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "cmd": { "type": "string" }
                                }
                            }
                        }
                    ]
                },
                {
                    "googleSearch": { "dynamicRetrievalConfig": { "mode": "MODE_DYNAMIC" } }
                }
            ],
            "unknownTopLevel": { "x": 1 }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some("req_gemini_claude_1".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:gemini".to_string()));
    assert!(result.payload.get("foo").is_none());
    assert!(result.payload.get("unknownTopLevel").is_none());
    assert_eq!(result.payload["model"], "claude-3-7-sonnet");
    assert_eq!(result.payload["requestId"], "gemini_req_claude_1");
    assert_eq!(
        result.payload["tools"][0]["functionDeclarations"][0]["parameters"],
        json!({
            "type": "object",
            "properties": {},
            "additionalProperties": true
        })
    );
    assert!(result.payload["tools"][0]["functionDeclarations"][0]
        .get("strict")
        .is_none());
    assert_eq!(
        result.payload["tools"][1]["googleSearch"]["dynamicRetrievalConfig"]["mode"],
        "MODE_DYNAMIC"
    );
}

#[test]
fn test_req_profile_chat_gemini_injects_cached_signature_after_response_cache() {
    let _guard = super::signature_cache_test_guard();
    reset_antigravity_signature_caches_for_bridge();
    let req_id = "req_gemini_sig_1";
    let alias = "antigravity.g1x";
    let signature = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

    let req_input = ReqOutboundCompatInput {
        payload: json!({
            "requestId": "agent-gemini-1",
            "userAgent": "antigravity",
            "request": {
                "contents": [
                    { "role": "user", "parts": [{ "text": "compile project sigcache gemini 1" }] },
                    {
                        "role": "assistant",
                        "parts": [
                            { "functionCall": { "name": "exec_command", "args": { "cmd": "pwd" } } }
                        ]
                    }
                ]
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some(req_id.to_string()),
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
            provider_key: Some(format!("{}.gemini-2.5", alias)),
            runtime_key: Some(alias.to_string()),
            client_request_id: Some("client_req_gemini_1".to_string()),
            group_request_id: Some("group_req_gemini_1".to_string()),
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let first_req = run_req_outbound_stage3_compat(req_input).unwrap();
    assert_eq!(first_req.applied_profile, Some("chat:gemini".to_string()));
    assert!(first_req.payload["request"]["contents"][1]["parts"][0]
        .get("thoughtSignature")
        .is_none());

    let resp_input = ReqOutboundCompatInput {
        payload: json!({
            "request_id": req_id,
            "candidates": [
                {
                    "content": {
                        "parts": [{ "thoughtSignature": signature }]
                    }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some(req_id.to_string()),
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
            provider_key: Some(format!("{}.gemini-2.5", alias)),
            runtime_key: Some(alias.to_string()),
            client_request_id: Some("client_req_gemini_1".to_string()),
            group_request_id: Some("group_req_gemini_1".to_string()),
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let cached = run_resp_inbound_stage3_compat(resp_input).unwrap();
    assert_eq!(cached.applied_profile, Some("chat:gemini".to_string()));

    let req_input_2 = ReqOutboundCompatInput {
        payload: json!({
            "requestId": "agent-gemini-2",
            "userAgent": "antigravity",
            "request": {
                "contents": [
                    { "role": "user", "parts": [{ "text": "compile project sigcache gemini 1" }] },
                    {
                        "role": "assistant",
                        "parts": [
                            { "functionCall": { "name": "exec_command", "args": { "cmd": "pwd" } } }
                        ]
                    }
                ]
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some("req_gemini_sig_2".to_string()),
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
            provider_key: Some(format!("{}.gemini-2.5", alias)),
            runtime_key: Some(alias.to_string()),
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let second_req = run_req_outbound_stage3_compat(req_input_2).unwrap();
    assert_eq!(second_req.applied_profile, Some("chat:gemini".to_string()));
    assert_eq!(
        second_req.payload["request"]["contents"][1]["parts"][0]["thoughtSignature"],
        signature
    );
}

#[test]
fn test_req_profile_chat_gemini_cli_wraps_and_normalizes_request() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gemini-2.5-pro",
            "requestId": "agent-123",
            "userAgent": "antigravity",
            "metadata": { "x": 1 },
            "stream": true,
            "sessionId": "sess_1",
            "web_search": { "enabled": true },
            "tools": [
                {
                    "functionDeclarations": [
                        {
                            "name": "exec_command",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "cmd": { "type": "string", "description": "cmd desc" },
                                    "workdir": { "type": "string" }
                                }
                            }
                        },
                        {
                            "name": "view_image",
                            "parameters": { "type": "object" }
                        }
                    ]
                },
                {
                    "name": "web_search_legacy"
                }
            ],
            "contents": [
                {
                    "parts": [
                        {
                            "functionCall": {
                                "name": "mcp__context7__query-docs",
                                "args": { "libraryId": "/x/y", "query": "hello" }
                            }
                        },
                        {
                            "functionCall": {
                                "name": "exec_command",
                                "args": { "cmd": "pwd" }
                            }
                        },
                        {
                            "functionCall": {
                                "name": "write_stdin",
                                "args": { "session_id": 1, "text": "abc" }
                            }
                        }
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some("req_gemini_cli_1".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:gemini-cli".to_string()));
    assert!(result.payload.get("tools").is_none());
    assert!(result.payload.get("contents").is_none());
    assert!(result.payload.get("metadata").is_none());
    assert!(result.payload.get("stream").is_none());
    assert!(result.payload.get("sessionId").is_none());

    let req = result.payload["request"]
        .as_object()
        .expect("request object");
    assert!(req.get("model").is_none());
    assert!(req.get("requestId").is_none());
    assert!(req.get("userAgent").is_none());
    assert!(req.get("metadata").is_none());
    assert!(req.get("stream").is_none());
    assert!(req.get("sessionId").is_none());
    assert!(req.get("web_search").is_none());
    assert_eq!(
        req["tools"][0]["functionDeclarations"][0]["name"],
        "exec_command"
    );
    assert_eq!(
        req["tools"][0]["functionDeclarations"][0]["parameters"]["type"],
        "OBJECT"
    );
    assert_eq!(
        req["contents"][0]["parts"][0]["functionCall"]["name"],
        "mcp__context7__query_docs"
    );
    assert_eq!(
        req["contents"][0]["parts"][1]["functionCall"]["args"]["command"],
        "pwd"
    );
    assert!(req["contents"][0]["parts"][1]["functionCall"]["args"]
        .get("cmd")
        .is_none());
    assert_eq!(
        req["contents"][0]["parts"][2]["functionCall"]["args"]["chars"],
        "abc"
    );
}

#[test]
fn test_req_profile_chat_gemini_cli_claude_schema_compat() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "claude-3-7-sonnet",
            "requestId": "agent-claude-cli-1",
            "tools": [
                {
                    "functionDeclarations": [
                        {
                            "name": "exec_command",
                            "strict": true,
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "cmd": { "type": "string" }
                                }
                            }
                        }
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some("req_gemini_cli_claude_1".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:gemini-cli".to_string()));
    assert_eq!(result.payload["model"], "claude-3-7-sonnet");
    assert_eq!(
        result.payload["request"]["tools"][0]["functionDeclarations"][0]["parameters"],
        json!({
            "type": "object",
            "properties": {},
            "additionalProperties": true
        })
    );
    assert!(
        result.payload["request"]["tools"][0]["functionDeclarations"][0]
            .get("strict")
            .is_none()
    );
}

#[test]
fn test_req_profile_chat_gemini_cli_shallow_pick_top_level_keys() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gemini-2.5-pro",
            "requestId": "agent-gemini-cli-pick-1",
            "userAgent": "antigravity",
            "action": "run",
            "requestType": "chat",
            "project": "demo",
            "unknownTopLevel": { "k": "v" },
            "metadata": { "x": 1 },
            "tools": [
                {
                    "functionDeclarations": [
                        { "name": "exec_command", "parameters": { "type": "object", "properties": {} } }
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some("req_gemini_cli_pick_1".to_string()),
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
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:gemini-cli".to_string()));
    assert!(result.payload.get("unknownTopLevel").is_none());
    assert!(result.payload.get("metadata").is_none());
    assert_eq!(result.payload["model"], "gemini-2.5-pro");
    assert_eq!(result.payload["requestId"], "agent-gemini-cli-pick-1");
    assert_eq!(result.payload["userAgent"], "antigravity");
    assert_eq!(result.payload["action"], "run");
    assert_eq!(result.payload["requestType"], "chat");
    assert_eq!(result.payload["project"], "demo");
    assert!(result.payload.get("request").is_some());
}

#[test]
fn test_req_profile_chat_gemini_cli_protocol_mismatch_native_noop() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "request": {
                "contents": [{ "parts": [{ "text": "keep" }] }]
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_gemini_cli_2".to_string()),
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
    assert!(result.native_applied);
    assert!(result.applied_profile.is_none());
    assert_eq!(
        result.payload["request"]["contents"][0]["parts"][0]["text"],
        "keep"
    );
}

#[test]
fn test_req_profile_chat_gemini_cli_injects_cached_signature_after_response_cache() {
    let _guard = super::signature_cache_test_guard();
    reset_antigravity_signature_caches_for_bridge();
    let req_id = "req_gemini_cli_sig_1";
    let alias = "antigravity.alpha2";
    let signature = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    let req_payload = json!({
        "requestId": "agent-777",
        "userAgent": "antigravity",
        "contents": [
            {
                "role": "user",
                "parts": [{ "text": "compile project sigcache gemini cli 1" }]
            },
            {
                "role": "assistant",
                "parts": [
                    {
                        "functionCall": {
                            "name": "exec_command",
                            "args": { "cmd": "pwd" }
                        }
                    }
                ]
            }
        ]
    });

    let req_input = ReqOutboundCompatInput {
        payload: req_payload,
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some(req_id.to_string()),
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
            provider_key: Some(format!("{}.gemini-2.5", alias)),
            runtime_key: Some(alias.to_string()),
            client_request_id: Some("client_req_1".to_string()),
            group_request_id: Some("group_req_1".to_string()),
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let first_req = run_req_outbound_stage3_compat(req_input).unwrap();
    assert_eq!(
        first_req.applied_profile,
        Some("chat:gemini-cli".to_string())
    );
    assert!(first_req.payload["request"]["contents"][1]["parts"][0]
        .get("thoughtSignature")
        .is_none());

    let resp_input = ReqOutboundCompatInput {
        payload: json!({
            "request_id": req_id,
            "candidates": [
                {
                    "content": {
                        "parts": [
                            { "thoughtSignature": signature }
                        ]
                    }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some(req_id.to_string()),
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
            provider_key: Some(format!("{}.gemini-2.5", alias)),
            runtime_key: Some(alias.to_string()),
            client_request_id: Some("client_req_1".to_string()),
            group_request_id: Some("group_req_1".to_string()),
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let cached = run_resp_inbound_stage3_compat(resp_input).unwrap();
    assert_eq!(cached.applied_profile, Some("chat:gemini-cli".to_string()));

    let req_input_2 = ReqOutboundCompatInput {
        payload: json!({
            "requestId": "agent-888",
            "userAgent": "antigravity",
            "contents": [
                {
                    "role": "user",
                    "parts": [{ "text": "compile project sigcache gemini cli 1" }]
                },
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "functionCall": {
                                "name": "exec_command",
                                "args": { "cmd": "pwd" }
                            }
                        }
                    ]
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some("req_gemini_cli_sig_2".to_string()),
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
            provider_key: Some(format!("{}.gemini-2.5", alias)),
            runtime_key: Some(alias.to_string()),
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let second_req = run_req_outbound_stage3_compat(req_input_2).unwrap();
    assert_eq!(
        second_req.applied_profile,
        Some("chat:gemini-cli".to_string())
    );
    assert_eq!(
        second_req.payload["request"]["contents"][1]["parts"][0]["thoughtSignature"],
        signature
    );
}

#[test]
fn test_req_profile_chat_gemini_cli_leases_latest_signature_session_for_alias() {
    let _guard = super::signature_cache_test_guard();
    reset_antigravity_signature_caches_for_bridge();
    let req_id = "req_gemini_cli_lease_1";
    let alias = "antigravity.lease";
    let signature = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    let req_input = ReqOutboundCompatInput {
        payload: json!({
            "requestId": "agent-lease-1",
            "userAgent": "antigravity",
            "contents": [
                { "role": "user", "parts": [{ "text": "compile project" }] },
                { "role": "assistant", "parts": [{ "functionCall": { "name": "exec_command", "args": { "cmd": "pwd" } } }] }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some(req_id.to_string()),
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
            provider_key: Some("antigravity.lease.gemini-2.5".to_string()),
            runtime_key: Some(alias.to_string()),
            client_request_id: Some("client_req_lease_1".to_string()),
            group_request_id: Some("group_req_lease_1".to_string()),
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let first_req = run_req_outbound_stage3_compat(req_input).unwrap();
    assert_eq!(
        first_req.applied_profile,
        Some("chat:gemini-cli".to_string())
    );
    assert!(first_req.payload["request"]["contents"][1]["parts"][0]
        .get("thoughtSignature")
        .is_none());

    let resp_input = ReqOutboundCompatInput {
        payload: json!({
            "request_id": req_id,
            "candidates": [
                {
                    "content": {
                        "parts": [{ "thoughtSignature": signature }]
                    }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some(req_id.to_string()),
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
            provider_key: Some("antigravity.lease.gemini-2.5".to_string()),
            runtime_key: Some(alias.to_string()),
            client_request_id: Some("client_req_lease_1".to_string()),
            group_request_id: Some("group_req_lease_1".to_string()),
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let cached = run_resp_inbound_stage3_compat(resp_input).unwrap();
    assert_eq!(cached.applied_profile, Some("chat:gemini-cli".to_string()));

    let leased_req_input = ReqOutboundCompatInput {
        payload: json!({
            "requestId": "agent-lease-2",
            "userAgent": "antigravity",
            "contents": [
                { "role": "user", "parts": [{ "text": "fix tests now" }] },
                { "role": "assistant", "parts": [{ "functionCall": { "name": "exec_command", "args": { "cmd": "ls" } } }] }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some("req_gemini_cli_lease_2".to_string()),
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
            provider_key: Some("antigravity.lease.gemini-2.5".to_string()),
            runtime_key: Some(alias.to_string()),
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let leased_req = run_req_outbound_stage3_compat(leased_req_input).unwrap();
    assert_eq!(
        leased_req.applied_profile,
        Some("chat:gemini-cli".to_string())
    );
    assert_eq!(
        leased_req.payload["request"]["contents"][1]["parts"][0]["thoughtSignature"],
        signature
    );
}

#[test]
fn test_req_profile_chat_gemini_cli_rewind_clears_and_blocks_signature_injection() {
    let _guard = super::signature_cache_test_guard();
    let req_id = "req_gemini_cli_rewind_1";
    let alias = "antigravity.rewind";
    let signature = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    let first_req_input = ReqOutboundCompatInput {
        payload: json!({
            "requestId": "agent-rewind-1",
            "userAgent": "antigravity",
            "contents": [
                { "role": "user", "parts": [{ "text": "run checks" }] },
                { "role": "assistant", "parts": [{ "functionCall": { "name": "exec_command", "args": { "cmd": "pwd" } } }] },
                { "role": "assistant", "parts": [{ "text": "done" }] }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some(req_id.to_string()),
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
            provider_key: Some("antigravity.rewind.gemini-2.5".to_string()),
            runtime_key: Some(alias.to_string()),
            client_request_id: Some("client_req_rewind_1".to_string()),
            group_request_id: Some("group_req_rewind_1".to_string()),
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let first_req = run_req_outbound_stage3_compat(first_req_input).unwrap();
    assert!(first_req.payload["request"]["contents"][1]["parts"][0]
        .get("thoughtSignature")
        .is_none());

    let resp_input = ReqOutboundCompatInput {
        payload: json!({
            "request_id": req_id,
            "candidates": [
                {
                    "content": {
                        "parts": [{ "thoughtSignature": signature }]
                    }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some(req_id.to_string()),
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
            provider_key: Some("antigravity.rewind.gemini-2.5".to_string()),
            runtime_key: Some(alias.to_string()),
            client_request_id: Some("client_req_rewind_1".to_string()),
            group_request_id: Some("group_req_rewind_1".to_string()),
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let cached = run_resp_inbound_stage3_compat(resp_input).unwrap();
    assert_eq!(cached.applied_profile, Some("chat:gemini-cli".to_string()));

    let rewind_req_input = ReqOutboundCompatInput {
        payload: json!({
            "requestId": "agent-rewind-2",
            "userAgent": "antigravity",
            "contents": [
                { "role": "user", "parts": [{ "text": "run checks" }] },
                { "role": "assistant", "parts": [{ "functionCall": { "name": "exec_command", "args": { "cmd": "pwd" } } }] }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini-cli".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            request_id: Some("req_gemini_cli_rewind_2".to_string()),
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
            provider_key: Some("antigravity.rewind.gemini-2.5".to_string()),
            runtime_key: Some(alias.to_string()),
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let rewind_req = run_req_outbound_stage3_compat(rewind_req_input).unwrap();
    assert_eq!(
        rewind_req.applied_profile,
        Some("chat:gemini-cli".to_string())
    );
    assert!(rewind_req.payload["request"]["contents"][1]["parts"][0]
        .get("thoughtSignature")
        .is_none());
}
