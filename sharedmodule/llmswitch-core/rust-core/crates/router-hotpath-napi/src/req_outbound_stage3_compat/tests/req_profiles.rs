use super::*;
use crate::req_outbound_stage3_compat::shared_tool_text_guidance::build_tool_text_instruction;

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
    assert_eq!(result.payload["model"], "coder-model");
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
    assert_eq!(content[1]["image_url"]["url"], "https://example.com/a.png");
    assert_eq!(content[2]["type"], "video_url");
    assert_eq!(content[2]["video_url"]["url"], "https://example.com/a.mp4");

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
fn test_req_profile_chat_local_deepseek_thinking_history_injects_reasoning_content() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "DeepSeek-V4-Flash-mxfp8",
            "messages": [
                { "role": "user", "content": "review then commit" },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": { "name": "exec_command", "arguments": "{\"cmd\":\"git status\"}" }
                        }
                    ]
                },
                {
                    "role": "assistant",
                    "content": "The user asked me to review and then commit the code. Let me review the code first."
                },
                {
                    "role": "assistant",
                    "content": "已提交 ✅"
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_local_deepseek_history_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("DeepSeek-V4-Flash-mxfp8".to_string()),
            client_model_id: None,
            original_model_id: None,
            provider_id: Some("omlx".to_string()),
            provider_key: Some("omlx.key1.DeepSeek-V4-Flash-mxfp8".to_string()),
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
    assert_eq!(result.payload["messages"][1]["reasoning_content"], ".");
    assert_eq!(
        result.payload["messages"][2]["reasoning_content"],
        "The user asked me to review and then commit the code. Let me review the code first."
    );
    assert_eq!(result.payload["messages"][2]["content"], "");
    assert_eq!(
        result.payload["messages"][3]["reasoning_content"],
        "已提交 ✅"
    );
    assert_eq!(result.payload["messages"][3]["content"], "");
}

#[test]
fn test_req_profile_chat_local_deepseek_thinking_history_does_not_touch_other_openai_providers() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "DeepSeek-V4-Flash-mxfp8",
            "messages": [
                {
                    "role": "assistant",
                    "content": "plain assistant history"
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_local_deepseek_history_control_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("DeepSeek-V4-Flash-mxfp8".to_string()),
            client_model_id: None,
            original_model_id: None,
            provider_id: Some("openai".to_string()),
            provider_key: Some("openai.key1.DeepSeek-V4-Flash-mxfp8".to_string()),
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.payload["messages"][0]["reasoning_content"].is_null());
    assert_eq!(
        result.payload["messages"][0]["content"],
        "plain assistant history"
    );
}

#[test]
fn test_req_profile_chat_local_deepseek_thinking_history_still_applies_under_unknown_request_stage_profile(
) {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "DeepSeek-V4-Flash-mxfp8",
            "messages": [
                { "role": "user", "content": "继续" },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": { "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                        }
                    ]
                },
                {
                    "role": "assistant",
                    "content": "Jason，我已通读整个项目。以下是 `/goal` 提示词设计。"
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("search/omlx-search".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_local_deepseek_history_profile_1".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("DeepSeek-V4-Flash-mxfp8".to_string()),
            client_model_id: None,
            original_model_id: None,
            provider_id: Some("omlx".to_string()),
            provider_key: Some("omlx.key1.DeepSeek-V4-Flash-mxfp8".to_string()),
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
    assert_eq!(result.payload["messages"][1]["reasoning_content"], ".");
    assert_eq!(
        result.payload["messages"][2]["reasoning_content"],
        "Jason，我已通读整个项目。以下是 `/goal` 提示词设计。"
    );
    assert_eq!(result.payload["messages"][2]["content"], "");
}

#[test]
fn test_req_profile_chat_local_deepseek_keeps_pre_last_user_assistant_content_visible() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "DeepSeek-V4-Flash-mxfp8",
            "messages": [
                { "role": "user", "content": "先做第一步" },
                { "role": "assistant", "content": "这是上一轮已展示给用户的结论。" },
                { "role": "user", "content": "继续下一步" },
                { "role": "assistant", "content": "好，开始系统执行重构检查。先从 A1 开始。" }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("thinking/omlx-thinking".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_local_deepseek_history_last_user_boundary_1".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("DeepSeek-V4-Flash-mxfp8".to_string()),
            client_model_id: None,
            original_model_id: None,
            provider_id: Some("omlx".to_string()),
            provider_key: Some("omlx.key1.DeepSeek-V4-Flash-mxfp8".to_string()),
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
        result.payload["messages"][1]["content"],
        "这是上一轮已展示给用户的结论。"
    );
    assert_eq!(
        result.payload["messages"][1]["reasoning_content"],
        "这是上一轮已展示给用户的结论。"
    );
    assert_eq!(result.payload["messages"][3]["content"], "");
    assert_eq!(
        result.payload["messages"][3]["reasoning_content"],
        "好，开始系统执行重构检查。先从 A1 开始。"
    );
}

#[test]
fn test_req_profile_anthropic_thinking_history_injects_reasoning_content() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "thinking": { "type": "enabled", "budget_tokens": 1024 },
            "messages": [
                { "role": "user", "content": "继续分析" },
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "call_1",
                            "name": "exec_command",
                            "input": { "cmd": "pwd" }
                        }
                    ]
                },
                {
                    "role": "assistant",
                    "content": "继续分析。我先理清从 session 创建到第一次建立 WebSocket 连接的完整链路。"
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_1",
                            "content": "ok"
                        }
                    ]
                },
                {
                    "role": "assistant",
                    "content": "最终结论：问题在 session 状态恢复链。"
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("anthropic-messages".to_string()),
            request_id: Some("req_anthropic_history_1".to_string()),
            entry_endpoint: Some("/v1/messages".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: Some("high".to_string()),
            estimated_input_tokens: None,
            model_id: Some("mimo-v2.5-pro".to_string()),
            client_model_id: None,
            original_model_id: None,
            provider_id: Some("mimo".to_string()),
            provider_key: Some("mimo.key1.mimo-v2.5-pro".to_string()),
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(result.payload["messages"][1]["reasoning_content"], ".");
    assert_eq!(
        result.payload["messages"][2]["reasoning_content"],
        "继续分析。我先理清从 session 创建到第一次建立 WebSocket 连接的完整链路。"
    );
    assert_eq!(
        result.payload["messages"][2]["content"],
        "继续分析。我先理清从 session 创建到第一次建立 WebSocket 连接的完整链路。"
    );
    assert_eq!(
        result.payload["messages"][4]["reasoning_content"],
        "最终结论：问题在 session 状态恢复链。"
    );
    assert_eq!(result.payload["messages"][4]["content"], "");
}

#[test]
fn test_req_profile_anthropic_claude_code_preserves_thinking_history_reasoning_content() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "thinking": { "type": "enabled", "budget_tokens": 1024 },
            "messages": [
                { "role": "user", "content": "继续分析" },
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "call_1",
                            "name": "exec_command",
                            "input": { "cmd": "pwd" }
                        }
                    ]
                },
                {
                    "role": "assistant",
                    "content": "继续分析。我先理清从 session 创建到第一次建立 WebSocket 连接的完整链路。"
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "call_1",
                            "content": "ok"
                        }
                    ]
                },
                {
                    "role": "assistant",
                    "content": "最终结论：问题在 session 状态恢复链。"
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("anthropic:claude-code".to_string()),
            provider_protocol: Some("anthropic-messages".to_string()),
            request_id: Some("req_anthropic_claude_code_history_1".to_string()),
            entry_endpoint: Some("/v1/messages".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: Some("high".to_string()),
            estimated_input_tokens: None,
            model_id: Some("mimo-v2.5-pro".to_string()),
            client_model_id: None,
            original_model_id: None,
            provider_id: Some("mimo".to_string()),
            provider_key: Some("mimo.key1.mimo-v2.5-pro".to_string()),
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
        result.applied_profile,
        Some("anthropic:claude-code".to_string())
    );
    assert_eq!(result.payload["messages"][1]["reasoning_content"], ".");
    assert_eq!(
        result.payload["messages"][2]["reasoning_content"],
        "继续分析。我先理清从 session 创建到第一次建立 WebSocket 连接的完整链路。"
    );
    assert_eq!(
        result.payload["messages"][2]["content"],
        "继续分析。我先理清从 session 创建到第一次建立 WebSocket 连接的完整链路。"
    );
    assert_eq!(
        result.payload["messages"][4]["reasoning_content"],
        "最终结论：问题在 session 状态恢复链。"
    );
    assert_eq!(result.payload["messages"][4]["content"], "");
}

#[test]
fn test_req_profile_anthropic_thinking_history_respects_disabled_thinking() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "thinking": { "type": "disabled" },
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "call_1",
                            "name": "exec_command",
                            "input": { "cmd": "pwd" }
                        }
                    ]
                },
                {
                    "role": "assistant",
                    "content": "plain assistant history"
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("anthropic-messages".to_string()),
            request_id: Some("req_anthropic_history_disabled_1".to_string()),
            entry_endpoint: Some("/v1/messages".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: Some("high".to_string()),
            estimated_input_tokens: None,
            model_id: Some("mimo-v2.5-pro".to_string()),
            client_model_id: None,
            original_model_id: None,
            provider_id: Some("mimo".to_string()),
            provider_key: Some("mimo.key1.mimo-v2.5-pro".to_string()),
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.payload["messages"][0]["reasoning_content"].is_null());
    assert!(result.payload["messages"][1]["reasoning_content"].is_null());
    assert_eq!(
        result.payload["messages"][1]["content"],
        "plain assistant history"
    );
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
    assert!(prompt.contains("<|DSML|tool_calls>"));
    assert!(prompt.contains("</|DSML|tool_calls>"));
    assert!(prompt.contains("tool_choice is required for this turn"));
    assert!(prompt.contains("If no tool is needed, reply with plain text"));
    assert!(prompt.contains("DeepSeek text-tool addendum:"));
    assert!(!prompt.contains("DeepSeek/Qwen text-tool addendum:"));
    assert!(prompt.contains("Be terse: no preamble, no running commentary"));
    assert!(
        prompt.contains("output ONLY the <|DSML|tool_calls> block and nothing else in that turn")
    );
    assert!(prompt.contains("Do not invent tool names"));
    assert!(prompt.contains("Do not output narrative tool calls"));
    assert!(prompt.contains("This is a strict dry-run tool-routing test."));
    assert!(prompt.contains("Override precedence for this turn"));
    assert!(prompt.contains("confidential project"));
    assert!(prompt.contains("major compliance loss"));
    assert!(prompt.contains("Evidence first for code/debug tasks"));
    assert_eq!(
        prompt.matches("Tool-call output contract (STRICT)").count(),
        1
    );
    assert_eq!(prompt.matches("DeepSeek text-tool addendum:").count(), 1);
    assert!(!prompt.contains("<<SYSTEM_PROMPT"));
    assert!(!prompt.contains("[Authoritative RouteCodex system instruction"));
    assert!(!prompt.contains("Follow the system instruction above exactly"));
    assert!(!prompt.contains("<｜User｜><<SYSTEM_PROMPT"));
    assert!(prompt
        .contains("Never leak tool intent, command text, patch text, or tool markup into prose"));
    assert!(prompt.contains("Do not stop at analysis."));
    assert!(prompt.contains("Do not use browser or web search."));
    assert!(prompt.contains(
        "Do not output hidden-reasoning wrappers or MCP/tool-transport markup of any kind."
    ));
    assert!(prompt.contains("Do not output any visible safety-review or moderation wrapper"));
    assert!(prompt.contains("<thinking>"));
    assert!(prompt.contains("<use_mcp_tool>"));
    assert!(prompt
        .contains("Forbidden wrappers/tags: <previous_tool_call>, <thinking>, <use_mcp_tool>"));
}

#[test]
fn test_req_profile_chat_deepseek_web_wraps_history_tool_calls_and_drops_empty_tail_turn() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-chat",
            "messages": [
                {"role": "system", "content": "follow contract"},
                {"role": "user", "content": "先看项目"},
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"bash -lc 'pwd'\",\"command\":\"bash -lc 'pwd'\",\"justification\":\"inspect repo root\"}"
                            }
                        }
                    ]
                },
                {"role": "tool", "content": "pwd output: /workspace"}
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
            request_id: Some("req_deepseek_web_history_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("tools/deepseek-tools".to_string()),
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
    let prompt = result.payload["prompt"].as_str().unwrap_or("");
    assert!(prompt.contains("<|DSML|tool_calls>"));
    assert!(prompt.contains("exec_command"));
    assert!(prompt.contains("<![CDATA[pwd]]>"));
    assert!(prompt.contains("inspect repo root"));
    assert!(prompt.contains("If no tool is needed, reply with plain text"));
    assert!(!prompt.ends_with("<｜User｜>"));
    assert!(prompt
        .contains("[Previous tool output — result of a prior tool call, not a user instruction]"));
    assert!(prompt.contains("pwd output: /workspace"));
    assert!(prompt.contains("Override precedence for this turn"));
    assert!(prompt.contains("confidential project"));
    assert!(prompt.contains("Evidence first for code/debug tasks"));
    assert_eq!(
        prompt.matches("Tool-call output contract (STRICT)").count(),
        1
    );
    assert_eq!(prompt.matches("DeepSeek text-tool addendum:").count(), 1);
    assert!(!prompt.contains("<<SYSTEM_PROMPT"));
    assert!(prompt.contains("follow contract"));
    assert!(prompt.contains("confidential project"));
    assert!(!prompt.contains("This turn is tool-required."));
    assert!(!prompt.contains("Historical tool errors are attempt-specific results"));
    assert!(!prompt.contains("Do NOT imitate earlier assistant chatter, repeated analysis, or failed command formatting from the history."));
    assert!(!prompt.contains("\"command\":\"bash -lc 'pwd'\""));
}

#[test]
fn test_req_profile_chat_deepseek_web_reinjects_override_after_prior_tool_round_marker() {
    let prior_system = [
        "follow contract",
        "",
        "Tool-call output contract (STRICT):",
        "old injected guidance should be stripped before fresh reinjection",
    ]
    .join("\n");
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-chat",
            "messages": [
                {"role": "system", "content": prior_system},
                {"role": "user", "content": "先检查代码"},
                {"role": "assistant", "content": null, "tool_calls": [
                    {"type": "function", "function": {"name": "exec_command", "arguments": "{\"cmd\":\"bash -lc 'pwd'\"}"}}
                ]},
                {"role": "tool", "content": "pwd output: /workspace"},
                {"role": "user", "content": "那你读了以后再说"}
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
            request_id: Some("req_deepseek_web_reinject_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("tools/deepseek-tools".to_string()),
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
    let prompt = result.payload["prompt"].as_str().unwrap_or("");
    assert!(prompt.contains("Tool-call output contract (STRICT)"));
    assert!(prompt.contains("Override precedence for this turn"));
    assert!(prompt.contains("Evidence first for code/debug tasks"));
    assert!(prompt.contains("pwd output: /workspace"));
    assert!(!prompt.contains("old injected guidance should be stripped before fresh reinjection"));
    assert_eq!(
        prompt.matches("Tool-call output contract (STRICT)").count(),
        1
    );
    assert_eq!(prompt.matches("DeepSeek text-tool addendum:").count(), 1);
    assert!(!prompt.contains("<<SYSTEM_PROMPT"));
    assert!(!prompt.contains("Follow the system instruction above exactly"));
}

#[test]
fn test_req_profile_chat_deepseek_web_preserves_assistant_failure_history() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-chat",
            "tool_choice": "required",
            "messages": [
                {"role": "system", "content": "follow contract"},
                {
                    "role": "assistant",
                    "content": "<|ChunkingError|>我无法继续。我输出工具调用的格式可能有问题。<｜end▁of▁thinking｜>",
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"command\":\"bash -lc 'pwd'\",\"justification\":\"inspect repo root\"}"
                            }
                        }
                    ],
                    "reasoning_content": "<|ChunkingError|>我无法输出工具调用。<｜end▁of▁thinking｜>"
                },
                {"role": "user", "content": "pwd output: /workspace"}
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "description": "run shell",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "cmd": {"type": "string"},
                                "justification": {"type": "string"}
                            },
                            "required": ["cmd"]
                        }
                    }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_web_strip_chunking".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("tools/deepseek-tools".to_string()),
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
    let prompt = result.payload["prompt"].as_str().unwrap_or("");
    assert!(prompt.contains("<|DSML|tool_calls>"));
    assert!(prompt.contains("exec_command"));
    assert!(prompt.contains("<![CDATA[pwd]]>"));
    assert!(prompt.contains("inspect repo root"));
    assert!(!prompt.contains("\"command\":\"bash -lc 'pwd'\""));
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
fn test_req_profile_chat_deepseek_web_preserves_explicit_thinking_and_search_flags() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-chat",
            "thinking_enabled": true,
            "search_enabled": true,
            "messages": [{"role": "user", "content": "force both flags"}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_web_explicit_flags".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-primary".to_string()),
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
    assert_eq!(result.payload["thinking_enabled"], true);
    assert_eq!(result.payload["search_enabled"], true);
}

#[test]
fn test_req_profile_chat_deepseek_web_v4_aliases_map_to_expected_flags() {
    let thinking_input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-pro",
            "messages": [{"role": "user", "content": "think hard"}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_web_v4_pro".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-primary".to_string()),
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
    let thinking_result = run_req_outbound_stage3_compat(thinking_input).unwrap();
    assert_eq!(thinking_result.payload["thinking_enabled"], true);
    assert_eq!(thinking_result.payload["search_enabled"], false);

    let search_input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "search the web"}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_web_v4_flash".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("web_search-primary".to_string()),
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
    let search_result = run_req_outbound_stage3_compat(search_input).unwrap();
    assert_eq!(search_result.payload["thinking_enabled"], false);
    assert_eq!(search_result.payload["search_enabled"], true);
}

#[test]
fn test_req_profile_chat_deepseek_web_thinking_route_with_tools_forces_tool_required_prompt() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-chat",
            "messages": [{"role": "user", "content": "请直接调用 exec_command"}],
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
            request_id: Some("req_deepseek_web_thinking_tools".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("thinking-primary".to_string()),
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
    let prompt = result.payload["prompt"].as_str().unwrap_or("");
    assert!(prompt.contains("tool_choice is required for this turn"));
    assert!(!prompt.contains("<<SYSTEM_PROMPT"));
    assert_eq!(
        prompt.matches("Tool-call output contract (STRICT)").count(),
        1
    );
    assert!(prompt.contains("This turn is tool-required."));
    assert!(prompt.contains("Allowed tool names this turn: exec_command."));
    assert!(prompt.contains("prefer one focused inspection call at a time"));
    assert!(prompt.contains("One successful read is not enough."));
    assert!(prompt.contains("<read_file>, <file_read>, <execute_command>, <previous_tool_call>"));
    assert!(prompt
        .contains("Do not invent read_file, file_read, shell_command, command, cwd, or workdir."));
    assert!(prompt.contains("请直接调用 exec_command"));
}

#[test]
fn test_req_profile_chat_deepseek_web_coding_route_with_tools_forces_tool_required_prompt() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-pro",
            "messages": [{"role": "user", "content": "先检查项目结构，然后继续"}],
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
            request_id: Some("req_deepseek_web_coding_tools".to_string()),
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
    let prompt = result.payload["prompt"].as_str().unwrap_or("");
    assert!(prompt.contains("tool_choice is required for this turn"));
    assert!(prompt.contains("This turn is tool-required."));
    assert!(prompt.contains("Allowed tool names this turn: exec_command."));
    assert!(prompt.contains("先检查项目结构，然后继续"));
}

#[test]
fn test_req_profile_chat_deepseek_web_continuation_prompt_preserves_dsml_guidance_and_tool_required_tail(
) {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-pro",
            "messages": [
                {"role": "system", "content": "follow contract"},
                {"role": "user", "content": "请继续处理"},
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"bash -lc 'pwd'\"}"
                            }
                        }
                    ]
                },
                {"role": "tool", "content": "pwd output: /workspace"},
                {"role": "user", "content": "继续下一步"}
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
            ],
            "metadata": {
                "deepseek": {
                    "contextFileEnabled": true
                }
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_web_continuation_tools".to_string()),
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
    let prompt = result.payload["prompt"].as_str().unwrap_or("");
    assert!(prompt.contains("follow contract"));
    assert!(prompt.contains("Tool-call output contract (STRICT)"));
    assert!(prompt.contains("DeepSeek text-tool addendum:"));
    assert!(prompt.contains("<|DSML|tool_calls>"));
    assert!(prompt.contains("This turn is tool-required."));
    assert!(prompt.contains("Allowed tool names this turn: exec_command."));
    assert!(prompt.contains("Continue from the latest state in the attached context."));
    assert_eq!(
        prompt.matches("Tool-call output contract (STRICT)").count(),
        1
    );
    assert_eq!(prompt.matches("DeepSeek text-tool addendum:").count(), 1);
    let context_file = result.payload["metadata"]["deepseek"]["contextFile"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(context_file.contains("# context"));
    assert!(context_file.contains("=== 1. SYSTEM ===\nfollow contract"));
    assert!(context_file.contains("=== 2. USER ===\n请继续处理"));
    assert!(context_file.contains("=== 3. ASSISTANT ==="));
    assert!(context_file.contains("<|DSML|tool_calls>"));
    assert!(context_file.contains("=== 4. TOOL ==="));
    assert!(context_file.contains("pwd output: /workspace"));
    assert!(context_file.contains("=== 5. USER ===\n继续下一步"));
    assert!(!context_file.contains("Tool-call output contract (STRICT)"));
    assert!(!context_file.contains("DeepSeek text-tool addendum:"));
    assert!(!context_file.contains("This turn is tool-required."));
    assert!(!context_file.contains("Allowed tool names this turn: exec_command."));
}

#[test]
fn test_req_profile_chat_deepseek_web_submit_tool_outputs_continuation_prompt_marks_prior_tool_as_completed(
) {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-pro",
            "messages": [
                {"role": "user", "content": "调用 exec_command 工具执行 pwd，然后返回工具调用，不要直接回答。"},
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "type": "function",
                            "id": "call_1",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"bash -lc 'pwd'\"}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "name": "exec_command",
                    "content": "/Users/fanzhang/Documents/github/routecodex"
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }
            ],
            "semantics": {
                "continuation": {
                    "chainId": "req_chain_1",
                    "continuationScope": "request_chain",
                    "stateOrigin": "openai-responses",
                    "restored": true,
                    "toolContinuation": {
                        "mode": "submit_tool_outputs",
                        "submittedToolCallIds": ["call_1"],
                        "resumeOutputs": ["/Users/fanzhang/Documents/github/routecodex"]
                    }
                }
            },
            "metadata": {
                "deepseek": {
                    "contextFileEnabled": true
                }
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_web_submit_continuation".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("tools-deepseek-web-primary".to_string()),
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
    let prompt = result.payload["prompt"].as_str().unwrap_or("");
    assert!(prompt.contains("The latest tool result has already been submitted."));
    assert!(prompt.contains("Do not repeat the same tool call"));
    assert!(prompt.contains("Tool call ids already completed in this continuation: call_1."));
    let context_file = result.payload["metadata"]["deepseek"]["contextFile"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(context_file.contains("tool_call_id: call_1"));
    assert!(context_file.contains("/Users/fanzhang/Documents/github/routecodex"));
}

#[test]
fn test_req_profile_chat_deepseek_web_reads_submit_tool_outputs_continuation_from_captured_chat_request(
) {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-pro",
            "messages": [
                {"role": "user", "content": "调用 exec_command 工具执行 pwd，然后返回工具调用，不要直接回答。"},
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "type": "function",
                            "id": "call_1",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"bash -lc 'pwd'\"}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "name": "exec_command",
                    "content": "/Users/fanzhang/Documents/github/routecodex"
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}},
                            "required": ["cmd"]
                        }
                    }
                }
            ],
            "metadata": {
                "deepseek": {
                    "contextFileEnabled": true
                }
            }
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_web_submit_continuation_captured".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("tools-deepseek-web-primary".to_string()),
            rt: None,
            captured_chat_request: Some(json!({
                "model": "deepseek-v4-pro",
                "messages": [],
                "tools": [],
                "tool_choice": null,
                "parameters": null,
                "semantics": {
                    "continuation": {
                        "chainId": "req_chain_1",
                        "continuationScope": "request_chain",
                        "stateOrigin": "openai-responses",
                        "restored": true,
                        "toolContinuation": {
                            "mode": "submit_tool_outputs",
                            "submittedToolCallIds": ["call_1"],
                            "resumeOutputs": ["/Users/fanzhang/Documents/github/routecodex"]
                        }
                    }
                }
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

    let result = run_req_outbound_stage3_compat(input).unwrap();
    let prompt = result.payload["prompt"].as_str().unwrap_or("");
    assert!(prompt.contains("The latest tool result has already been submitted."));
    assert!(prompt.contains("Tool call ids already completed in this continuation: call_1."));
}

#[test]
fn test_req_profile_chat_deepseek_web_preserves_text_delta_and_tool_use_content_items() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-chat",
            "messages": [
                {"role": "system", "content": "follow contract"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text_delta", "text": "先检查环境"},
                        {"type": "tool_use", "name": "exec_command", "input": {"command": "pwd", "justification": "inspect cwd"}}
                    ]
                },
                {"role": "user", "content": "继续"}
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
            request_id: Some("req_deepseek_web_content_items".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("tools/deepseek-tools".to_string()),
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
    let prompt = result.payload["prompt"].as_str().unwrap_or("");
    assert!(prompt.contains("先检查环境"));
    assert!(prompt.contains("exec_command"));
    assert!(prompt.contains("pwd"));
    assert!(prompt.contains("inspect cwd"));
}

#[test]
fn test_req_profile_chat_deepseek_web_preserves_explicit_empty_reasoning_content_for_assistant_tool_call_history(
) {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-chat",
            "messages": [
                {"role": "system", "content": "follow contract"},
                {"role": "user", "content": "继续"},
                {
                    "role": "assistant",
                    "content": null,
                    "reasoning_content": "",
                    "tool_calls": [
                        {
                            "type": "function",
                            "id": "call_1",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"bash -lc 'pwd'\"}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "name": "exec_command",
                    "content": "pwd output: /workspace"
                },
                {"role": "user", "content": "继续"}
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
            request_id: Some("req_deepseek_web_empty_reasoning_tool_history".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("tools/deepseek-tools".to_string()),
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
    let prompt = result.payload["prompt"].as_str().unwrap_or("");
    assert!(prompt.contains("<|DSML|tool_calls>"));
    assert!(prompt.contains("exec_command"));
    assert!(prompt.contains("<![CDATA[pwd]]>"));
    assert!(prompt.contains("reasoning_content: \"\""));
    assert!(prompt.contains("pwd output: /workspace"));
}

#[test]
fn test_req_profile_chat_qwen_only_normalizes_tool_definitions_and_keeps_messages() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "qwen3.6-plus",
            "messages": [
                {"role": "system", "content": "follow existing system"},
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
                },
                {
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "description": "apply diff",
                        "parameters": {
                            "type": "object",
                            "properties": {"patch": {"type": "string"}},
                            "required": ["patch"]
                        }
                    }
                },
                {
                    "type": "function",
                    "function": {
                        "name": "update_plan",
                        "description": "update task plan",
                        "parameters": {
                            "type": "object",
                            "properties": {"plan": {"type": "array"}},
                            "required": ["plan"]
                        }
                    }
                },
                {
                    "type": "function",
                    "function": {
                        "name": "write_stdin",
                        "description": "write input",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "session_id": {"type": "integer"},
                                "chars": {"type": "string"}
                            },
                            "required": ["session_id"]
                        }
                    }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwen".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwen_tool_defs_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("tools-primary".to_string()),
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

    let expected_messages = input.payload["messages"].clone();
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("chat:qwen".to_string()));
    assert_eq!(result.payload["messages"], expected_messages);
    let tools = result.payload["tools"].as_array().unwrap();
    let exec_desc = tools[0]["function"]["description"].as_str().unwrap_or("");
    assert!(exec_desc.contains("Use only `cmd` as one shell-command string."));
    assert!(exec_desc.contains("Call the tool directly instead of narrating a plan."));
    let cmd_desc = tools[0]["function"]["parameters"]["properties"]["cmd"]["description"]
        .as_str()
        .unwrap_or("");
    assert!(cmd_desc.contains("Single command string only."));
    let patch_desc = tools[1]["function"]["description"].as_str().unwrap_or("");
    assert!(patch_desc.contains("Use the exact tool name"));
    assert!(patch_desc.contains("Call the tool directly when needed."));
    assert!(!patch_desc.contains("Author exactly one canonical patch body in `patch`"));
    assert!(!patch_desc.contains("hashline-first"));
    assert!(!patch_desc.contains("filePath"));
    assert!(!patch_desc.contains("fileContent"));
}

#[test]
fn test_tool_text_instruction_does_not_own_apply_patch_contract_anymore() {
    let tools = json!([
        { "type": "function", "function": { "name": "exec_command" } },
        { "type": "function", "function": { "name": "apply_patch" } }
    ]);

    let instruction = build_tool_text_instruction(Some(&tools), false);
    assert!(instruction.contains("exec_command"));
    assert!(instruction.contains("apply_patch"));
    assert!(!instruction.contains("direct `apply_patch` tool call"));
    assert!(!instruction.contains("Author exactly one canonical patch body in `patch`"));
    assert!(!instruction.contains("*** Begin Patch"));
    assert!(!instruction.contains("*** End Patch"));
    assert!(!instruction.contains("hashline-first"));
    assert!(!instruction.contains("filePath"));
    assert!(!instruction.contains("fileContent"));
}

#[test]
fn test_req_profile_chat_qwenchat_web_injects_override_head_and_normalizes_tool_definitions() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "qwen3.6-plus",
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
                },
                {
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "description": "apply diff",
                        "parameters": {
                            "type": "object",
                            "properties": {"patch": {"type": "string"}},
                            "required": ["patch"]
                        }
                    }
                },
                {
                    "type": "function",
                    "function": {
                        "name": "update_plan",
                        "description": "update task plan",
                        "parameters": {
                            "type": "object",
                            "properties": {"plan": {"type": "array"}},
                            "required": ["plan"]
                        }
                    }
                },
                {
                    "type": "function",
                    "function": {
                        "name": "write_stdin",
                        "description": "write input",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "session_id": {"type": "integer"},
                                "chars": {"type": "string"}
                            },
                            "required": ["session_id"]
                        }
                    }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:qwenchat-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_qwenchat_web_1".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: Some("tools-primary".to_string()),
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
        Some("chat:qwenchat-web".to_string())
    );
    assert!(result.payload.get("prompt").is_none());
    assert!(result.payload.get("thinking_enabled").is_none());
    assert!(result.payload.get("search_enabled").is_none());
    assert!(result.payload["metadata"]["deepseek"].is_null());
    let messages = result.payload["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["role"], "system");
    assert_eq!(messages[0]["content"], "follow contract");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[2]["role"], "user");
    let tools = result.payload["tools"].as_array().unwrap();
    let exec_desc = tools[0]["function"]["description"].as_str().unwrap_or("");
    assert!(exec_desc.contains("Use only `cmd` as one shell-command string."));
    assert!(exec_desc.contains("Call the tool directly instead of narrating a plan."));
    assert!(exec_desc.contains("Treat runtime execution as available here."));
    assert!(exec_desc.contains("Do not refuse with sandbox"));
    assert!(exec_desc.contains("output exactly one RCC_TOOL_CALLS_JSON heredoc dry-run container"));
    let cmd_desc = tools[0]["function"]["parameters"]["properties"]["cmd"]["description"]
        .as_str()
        .unwrap_or("");
    assert!(cmd_desc.contains("Single command string only."));
    let apply_patch_desc = tools[1]["function"]["description"].as_str().unwrap_or("");
    assert!(apply_patch_desc.contains("Use the exact tool name"));
    assert!(apply_patch_desc
        .contains("output exactly one RCC_TOOL_CALLS_JSON heredoc dry-run container"));
    assert!(!apply_patch_desc.contains("Author exactly one canonical patch body in `patch`"));
    assert!(!apply_patch_desc.contains("hashline-first"));
    assert!(!apply_patch_desc.contains("filePath"));
    assert!(!apply_patch_desc.contains("fileContent"));
    let update_plan_desc = tools[2]["function"]["description"].as_str().unwrap_or("");
    assert!(update_plan_desc.contains("Use `plan`"));
    assert!(update_plan_desc.contains("Do not use `steps`"));
    let plan_prop_desc = tools[2]["function"]["parameters"]["properties"]["plan"]["description"]
        .as_str()
        .unwrap_or("");
    assert!(plan_prop_desc.contains("Do not rename this field to `steps`"));
    let write_stdin_desc = tools[3]["function"]["description"].as_str().unwrap_or("");
    assert!(write_stdin_desc.contains("Use `session_id` as a number"));
    assert!(write_stdin_desc.contains("Keep the field names exact"));
    let session_prop_desc = tools[3]["function"]["parameters"]["properties"]["session_id"]
        ["description"]
        .as_str()
        .unwrap_or("");
    assert!(session_prop_desc.contains("Numeric exec session id only"));
    let chars_prop_desc = tools[3]["function"]["parameters"]["properties"]["chars"]["description"]
        .as_str()
        .unwrap_or("");
    assert!(chars_prop_desc.contains("Optional stdin text string only"));
    let dryrun_hint = tools[0]["function"]["parameters"]["x-routecodex-qwenchat-dryrun-hint"]
        .as_str()
        .unwrap_or("");
    assert!(
        dryrun_hint.contains("output exactly one RCC_TOOL_CALLS_JSON heredoc dry-run container")
    );
    assert!(dryrun_hint.contains("do not output sandbox/path refusal prose"));
    assert!(result.payload.get("prompt").is_none());
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
            "userAgent": "gemini",
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
