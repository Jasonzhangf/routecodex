use super::*;
use crate::req_outbound_stage3_compat::responses::apply_responses_instructions_to_input;
use crate::req_outbound_stage3_compat::shared_tool_text_guidance::build_tool_text_instruction;

#[test]
fn test_req_profile_responses_instructions_to_input_trims_html_and_lifts_system_message() {
    let mut payload = json!({
        "model": "gpt-4.1",
        "instructions": "  <b>System</b> instruction  ",
        "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]}]
    });
    let root = payload.as_object_mut().unwrap();
    apply_responses_instructions_to_input(root);
    assert!(payload.get("instructions").is_none());
    assert_eq!(payload["input"][0]["role"], "system");
    assert_eq!(payload["input"][0]["content"][0]["type"], "input_text");
    assert_eq!(
        payload["input"][0]["content"][0]["text"],
        "System instruction"
    );
}

#[test]
fn test_req_profile_responses_crs_normalizes_chat_style_function_tools_for_responses_wire() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gpt-5.5",
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "description": "Run a command",
                        "parameters": { "type": "object", "properties": { "cmd": { "type": "string" } } }
                    }
                },
                {
                    "type": "function",
                    "name": "apply_patch",
                    "parameters": "{\"type\":\"object\",\"properties\":{}}"
                }
            ],
            "input": [{
                "role": "user",
                "content": [{ "type": "input_text", "text": "patch" }]
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:crs".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_responses_crs_tool_schema_1".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile, Some("responses:crs".to_string()));
    let tools = result.payload["tools"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["type"], "function");
    assert_eq!(tools[0]["name"], "exec_command");
    assert_eq!(tools[0]["description"], "Run a command");
    assert!(tools[0]["parameters"].is_object());
    assert!(tools[0].get("function").is_none());
    assert_eq!(tools[1]["name"], "apply_patch");
    assert!(tools[1]["parameters"].is_object());
    assert!(tools[1].get("function").is_none());
}

#[test]
fn test_req_profile_responses_tool_parameters_normalizes_string_json_to_object() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gpt-5.5",
            "tools": [
                {
                    "type": "function",
                    "name": "apply_patch",
                    "parameters": "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}}"
                }
            ],
            "input": [{
                "role": "user",
                "content": [{ "type": "input_text", "text": "patch" }]
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:crs".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_responses_tool_params_json_string_1".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    let tools = result.payload["tools"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tools[0]["parameters"]["type"], "object");
    assert_eq!(
        tools[0]["parameters"]["properties"]["path"]["type"],
        "string"
    );
}

#[test]
fn test_req_profile_responses_tool_parameters_fallback_to_object_schema() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gpt-5.5",
            "tools": [
                {
                    "type": "function",
                    "name": "exec_command",
                    "parameters": 123
                }
            ],
            "input": [{
                "role": "user",
                "content": [{ "type": "input_text", "text": "run" }]
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:crs".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            request_id: Some("req_responses_tool_params_fallback_1".to_string()),
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
    let result = run_req_outbound_stage3_compat(input).unwrap();
    let tools = result.payload["tools"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tools[0]["parameters"]["type"], "object");
    assert!(tools[0]["parameters"]["properties"].is_object());
    assert_eq!(tools[0]["parameters"]["additionalProperties"], true);
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
    assert!(result.payload["messages"][1]
        .get("reasoning_content")
        .is_none());
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
    assert!(result.payload["messages"][1]
        .get("reasoning_content")
        .is_none());
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
        2
    );
    assert_eq!(
        result.payload["messages"][0]["content"][1]["text"],
        "[Image omitted]"
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
fn test_openai_chat_deepseek_v4_model_on_opencode_gets_tool_history_reasoning_content() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-flash-free",
            "messages": [
                {"role": "user", "content": "inspect cwd"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "type": "function",
                            "id": "call_1",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"pwd\"}"
                            }
                        }
                    ]
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "/workspace"},
                {"role": "user", "content": "继续"}
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {"type": "object", "properties": {}}
                    }
                }
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("compat:passthrough".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_opencode_deepseek_v4_history".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: Some("longcontext".to_string()),
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("deepseek-v4-flash-free".to_string()),
            client_model_id: Some("gpt-5.5".to_string()),
            original_model_id: None,
            provider_id: Some("opencode-zen-free".to_string()),
            provider_key: Some("opencode-zen-free.key1.deepseek-v4-flash-free".to_string()),
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: Some("compat:passthrough".to_string()),
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.payload["messages"][1]
        .get("reasoning_content")
        .is_none());
    assert_eq!(result.payload["messages"][1]["content"], "");
    assert!(result.payload["tools"][0]["function"]
        .get("strict")
        .is_none());
}

#[test]
fn test_protocol_field_contract_outbound_openai_chat_strips_anthropic_thinking_blocks() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-flash-free",
            "max_tokens": 8192,
            "parallel_tool_calls": false,
            "tool_choice": "auto",
            "messages": [
                {"role": "user", "content": "继续"},
                {
                    "role": "assistant",
                    "content": [{"type": "thinking", "thinking": "."}],
                    "reasoning_content": ".",
                    "tool_calls": [{
                        "type": "function",
                        "id": "call_53600d11d0e44eb098b193b8",
                        "function": {"name": "exec_command", "arguments": "{\"cmd\":\"git status --short\"}"}
                    }]
                },
                {"role": "tool", "tool_call_id": "call_53600d11d0e44eb098b193b8", "content": " M android-client/app/src/main/assets/mobile-shell.html"},
                {"role": "user", "content": "继续"}
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "parameters": {"type": "object", "properties": {}, "additionalProperties": false},
                    "strict": false
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("compat:passthrough".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("openai-responses-opencode-zen-free.key1-deepseek-v4-flash-free-20260529T195142010-234778-2089".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: Some("longcontext".to_string()),
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("deepseek-v4-flash-free".to_string()),
            client_model_id: Some("gpt-5.5".to_string()),
            original_model_id: None,
            provider_id: Some("opencode-zen-free".to_string()),
            provider_key: Some("opencode-zen-free.key1.deepseek-v4-flash-free".to_string()),
            runtime_key: None,
            client_request_id: Some("req_1780055502010_7e948008".to_string()),
            group_request_id: Some("req_1780055502010_7e948008".to_string()),
            session_id: Some("019e733b-8c4d-74c0-93c1-0a33a3f2bd91".to_string()),
            conversation_id: None,
        },
        explicit_profile: Some("compat:passthrough".to_string()),
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(result.payload["messages"][1]["reasoning_content"], ".");
    assert_eq!(result.payload["messages"][1]["content"], "");
    assert!(result.payload["tools"][0]["function"]
        .get("strict")
        .is_none());
}

#[test]
fn test_protocol_field_contract_outbound_deepseek_openai_chat_sanitizes_2095_tool_media_shape() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-flash-free",
            "max_tokens": 8192,
            "parallel_tool_calls": false,
            "tool_choice": "auto",
            "messages": [
                {"role": "user", "content": "检查截图"},
                {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": ".",
                    "tool_calls": [{
                        "type": "function",
                        "id": "call_view_image",
                        "function": {"name": "view_image", "arguments": "{\"path\":\"/tmp/a.png\"}"}
                    }]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_view_image",
                    "content": "[{\"detail\":\"high\",\"image_url\":\"data:image/png;base64,iVBORw0KGgo=\",\"type\":\"image_url\"}]"
                },
                {"role": "user", "content": "继续"}
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "view_image",
                    "parameters": {"type": "object", "properties": {}, "additionalProperties": false}
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("compat:passthrough".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("openai-responses-opencode-zen-free.key1-deepseek-v4-flash-free-20260529T203805347-234784-2095".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: Some("longcontext".to_string()),
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("deepseek-v4-flash-free".to_string()),
            client_model_id: Some("gpt-5.5".to_string()),
            original_model_id: None,
            provider_id: Some("opencode-zen-free".to_string()),
            provider_key: Some("opencode-zen-free.key1.deepseek-v4-flash-free".to_string()),
            runtime_key: None,
            client_request_id: Some("req_1780058285347_86caf831".to_string()),
            group_request_id: Some("req_1780058285347_86caf831".to_string()),
            session_id: Some("019e733b-8c4d-74c0-93c1-0a33a3f2bd91".to_string()),
            conversation_id: None,
        },
        explicit_profile: Some("compat:passthrough".to_string()),
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.payload.get("parallel_tool_calls").is_none());
    assert_eq!(result.payload["tool_choice"], "auto");
    assert_eq!(result.payload["messages"][1]["reasoning_content"], ".");
    assert_eq!(result.payload["messages"][2]["content"], "[Image omitted]");
}

#[test]
fn test_protocol_field_contract_outbound_deepseek_openai_chat_trailing_tool_has_real_reasoning_text(
) {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "deepseek-v4-flash-free",
            "messages": [
                {"role": "user", "content": "继续"},
                {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "Need to inspect cwd before running pwd.",
                    "tool_calls": [{
                        "type": "function",
                        "id": "call_tail",
                        "function": {"name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"}
                    }]
                },
                {"role": "tool", "tool_call_id": "call_tail", "content": "/tmp"}
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "parameters": {"type": "object", "properties": {}}
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("compat:passthrough".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("openai-responses-opencode-zen-free.key1-deepseek-v4-flash-free-20260529T214411604-234811-2122".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: Some("longcontext".to_string()),
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("deepseek-v4-flash-free".to_string()),
            client_model_id: Some("gpt-5.5".to_string()),
            original_model_id: None,
            provider_id: Some("opencode-zen-free".to_string()),
            provider_key: Some("opencode-zen-free.key1.deepseek-v4-flash-free".to_string()),
            runtime_key: None,
            client_request_id: Some("req_1780062251604_710613f4".to_string()),
            group_request_id: Some("req_1780062251604_710613f4".to_string()),
            session_id: Some("019e733b-8c4d-74c0-93c1-0a33a3f2bd91".to_string()),
            conversation_id: None,
        },
        explicit_profile: Some("compat:passthrough".to_string()),
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.payload["messages"][1]["reasoning_content"],
        "Need to inspect cwd before running pwd."
    );
}

#[test]
fn test_protocol_field_contract_outbound_openai_chat_always_strips_historical_media() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "generic-openai-chat-model",
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "old image"},
                    {"type": "image_url", "image_url": "data:image/png;base64,old"}
                ]},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": "current text"},
                {"role": "assistant", "content": "", "tool_calls": [{
                    "type": "function",
                    "id": "call_view_image",
                    "function": {"name": "view_image", "arguments": "{}"}
                }]},
                {"role": "tool", "tool_call_id": "call_view_image", "content": [{
                    "type": "image_url",
                    "image_url": "data:image/png;base64,tool"
                }]},
                {"role": "user", "content": [
                    {"type": "text", "text": "current image should remain for multimodal-capable targets"},
                    {"type": "image_url", "image_url": "data:image/png;base64,current"}
                ]}
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("compat:passthrough".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_generic_historical_media".to_string()),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: Some("longcontext".to_string()),
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("generic-openai-chat-model".to_string()),
            client_model_id: Some("gpt-5.5".to_string()),
            original_model_id: None,
            provider_id: Some("generic".to_string()),
            provider_key: Some("generic.key1.generic-openai-chat-model".to_string()),
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: Some("compat:passthrough".to_string()),
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.payload["messages"][0]["content"][1]["text"],
        "[Image omitted]"
    );
    assert_eq!(result.payload["messages"][4]["content"], "[Image omitted]");
    assert_eq!(
        result.payload["messages"][5]["content"][1]["image_url"],
        "data:image/png;base64,current"
    );
}

#[test]
fn test_protocol_field_contract_outbound_anthropic_messages_strips_stringified_historical_media() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "mimo-v2.5",
            "messages": [
                {"role": "user", "content": [{
                    "content": "[{\"detail\":\"high\",\"image_url\":\"data:image/png;base64,iVBORw0KGgo=\"}]"
                }]},
                {"role": "assistant", "content": [{"type": "text", "text": "seen"}]},
                {"role": "user", "content": "继续"}
            ]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("compat:removed-profile".to_string()),
            provider_protocol: Some("anthropic-messages".to_string()),
            request_id: Some(
                "openai-responses-mimo.key1-mimo-v2.5-20260529T213159512-234803-2114".to_string(),
            ),
            entry_endpoint: Some("/v1/responses".to_string()),
            route_id: Some("search".to_string()),
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: Some("mimo-v2.5".to_string()),
            client_model_id: Some("gpt-5.5".to_string()),
            original_model_id: None,
            provider_id: Some("mimo".to_string()),
            provider_key: Some("mimo.key1.mimo-v2.5".to_string()),
            runtime_key: None,
            client_request_id: Some("req_1780061519512_f3f0220a".to_string()),
            group_request_id: Some("req_1780061519512_f3f0220a".to_string()),
            session_id: Some("019e733b-8c4d-74c0-93c1-0a33a3f2bd91".to_string()),
            conversation_id: None,
        },
        explicit_profile: Some("compat:removed-profile".to_string()),
    };

    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.payload["messages"][0]["content"][0]["text"],
        "[Image omitted]"
    );
    assert!(
        !result.payload["messages"]
            .to_string()
            .contains("data:image"),
        "historical inline image payload must not reach Anthropic outbound"
    );
}
