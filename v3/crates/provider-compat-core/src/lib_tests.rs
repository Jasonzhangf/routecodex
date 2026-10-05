use super::*;

#[test]
fn goaichat_long_names_reserve_short_dispatch_and_round_trip_typed_inverse() {
    use goaichat_tool_names::GoaichatToolNameProjection;
    let long = "f".repeat(65);
    let sibling = format!("{}g", "f".repeat(64));
    let reserved = namespace_tools::provider_tool_wire_names_with_prefix(
        [long.clone()].into(),
        Default::default(),
        "tool_",
    )
    .remove(&long)
    .unwrap();
    let original = json!({"tools":[
        {"name":long,"input_schema":{"type":"object","properties":{"a":{"type":"integer"}}}},
        {"name":sibling,"input_schema":{"type":"object","properties":{"input":{"type":"string"}}}},
        {"name":reserved,"input_schema":{"type":"object","properties":{"reserved":{"type":"boolean"}}}}
    ],"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"paired","name":long,"input":{"a":19}}]}],
    "tool_choice":{"type":"tool","name":long}});
    let names = GoaichatToolNameProjection::for_request(
        Some("anthropic:goaichat"),
        "anthropic-messages",
        &original,
    );
    let input = ReqOutboundCompatInput {
        payload: original.clone(),
        adapter_context: AdapterContext {
            compatibility_profile: Some("anthropic:goaichat".into()),
            provider_protocol: Some("anthropic-messages".into()),
            goaichat_tool_names: names.clone(),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let wire = run_req_outbound_stage3_compat(input.clone())
        .unwrap()
        .payload;
    let tool_names: Vec<&str> = wire["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(tool_names.iter().all(|name| name.len() <= 64));
    assert_eq!(
        tool_names
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        3
    );
    assert_eq!(wire["tools"][2], original["tools"][2]);
    assert_eq!(
        wire["tools"][0]["input_schema"],
        original["tools"][0]["input_schema"]
    );
    assert_eq!(
        wire["tools"][0]["name"],
        wire["messages"][0]["content"][0]["name"]
    );
    assert_eq!(wire["tools"][0]["name"], wire["tool_choice"]["name"]);
    let response = json!({"content":[
        {"type":"tool_use","id":"paired","name":wire["tools"][0]["name"],"input":{"a":19}},
        {"type":"tool_use","id":"reserved","name":reserved,"input":{"reserved":true}}
    ]});
    let restored = run_resp_inbound_stage3_compat(ReqOutboundCompatInput {
        payload: response,
        ..input.clone()
    })
    .unwrap()
    .payload;
    assert_eq!(restored["content"][0]["name"], long);
    assert_eq!(restored["content"][0]["input"], json!({"a":19}));
    assert_eq!(restored["content"][1]["name"], reserved);
    let serialized = serde_json::to_value(input.adapter_context).unwrap();
    assert!(serialized.get("goaichatToolNames").is_none());
    let mut generic = original.clone();
    GoaichatToolNameProjection::for_request(Some("chat:glm"), "anthropic-messages", &original)
        .project_request(&mut generic);
    assert_eq!(generic, original);
}

#[test]
fn qiluyun_reasoning_content_is_request_profile_and_protocol_specific() {
    let payload = json!({"input":[
        {"type":"reasoning","id":"empty","content":null,"summary":[{"type":"summary_text","text":"preserve"}]},
        {"type":"reasoning","id":"present","content":[{"type":"reasoning_text","text":"preserve"}]},
        {"type":"reasoning","id":"absent"},
        {"type":"message","role":"assistant","content":null}
    ]});
    for (profile, protocol, projected) in [
        ("responses:qiluyun", "openai-responses", true),
        ("compat:passthrough", "openai-responses", false),
        ("responses:qiluyun", "openai-chat", false),
        ("responses:qiluyun", "anthropic-messages", false),
    ] {
        let input = ReqOutboundCompatInput {
            payload: payload.clone(),
            adapter_context: AdapterContext {
                compatibility_profile: Some(profile.into()),
                provider_protocol: Some(protocol.into()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let mut expected = payload.clone();
        if projected {
            expected["input"][0]["content"] = json!([]);
        }
        assert_eq!(
            run_req_outbound_stage3_compat(input.clone())
                .unwrap()
                .payload,
            expected
        );
        assert_eq!(
            run_resp_inbound_stage3_compat(input).unwrap().payload,
            payload
        );
    }
}

#[test]
fn goaichat_profile_preserves_existing_hosted_extensions_and_other_protocols() {
    let payload = json!({"tools":[
        {"type":"web_search_20250305","name":"web_search","max_uses":7,
            "function":{"name":"web_search","parameters":{"query":"provider-extension"}},
            "opaque":{"preserve":true}},
        {"type":"web_search_20990101","name":"web_search"},
        {"type":"web_search_20250305","name":"web_search","max_uses":3},
        {"name":"exec_command","input_schema":{"type":"object"}}
    ],"messages":[{"role":"user","content":"opaque history"}]});
    for protocol in ["anthropic-messages", "openai-chat", "openai-responses"] {
        let input = ReqOutboundCompatInput {
            payload: payload.clone(),
            adapter_context: AdapterContext {
                compatibility_profile: Some("anthropic:goaichat".into()),
                provider_protocol: Some(protocol.into()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        assert_eq!(
            run_req_outbound_stage3_compat(input.clone())
                .unwrap()
                .payload,
            payload
        );
        assert_eq!(
            run_resp_inbound_stage3_compat(input).unwrap().payload,
            payload
        );
    }
}

fn deepseek_max_input(payload: Value, provider_protocol: &str) -> ReqOutboundCompatInput {
    ReqOutboundCompatInput {
        payload,
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:deepseek-max".to_string()),
            provider_protocol: Some(provider_protocol.to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    }
}

#[test]
fn deepseek_max_request_profile_leaves_target_effort_projection_to_provider_req_compat() {
    let result = run_req_outbound_stage3_compat(deepseek_max_input(
        json!({"model":"deepseek-v4-flash","messages":[]}),
        "openai-chat",
    ))
    .expect("registered DeepSeek profile must accept an already-compatible request");

    assert_eq!(result.applied_profile.as_deref(), Some("chat:deepseek-max"));
    assert!(result.payload.get("reasoning_effort").is_none());

    let unknown = run_req_outbound_stage3_compat(deepseek_max_input(
        json!({
            "model":"deepseek-v4-flash",
            "messages":[],
            "reasoning_effort":"already-projected-by-provider-req-compat"
        }),
        "openai-chat",
    ))
    .expect("shared compat must not own target effort validation or projection");
    assert_eq!(
        unknown.payload["reasoning_effort"],
        "already-projected-by-provider-req-compat"
    );

    let untouched = run_req_outbound_stage3_compat(deepseek_max_input(
        json!({"model":"deepseek-v4-flash","messages":[]}),
        "anthropic-messages",
    ))
    .expect("profile must not mutate a different provider protocol");
    assert!(untouched.payload.get("reasoning_effort").is_none());
    assert!(untouched.applied_profile.is_none());
}

#[test]
fn minimax_response_profile_harvests_responses_function_calls_xml_without_text_leak() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "object": "response",
            "id": "resp_minimax_tool_text_1",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
                }],
                "output_text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
            }],
            "output_text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:minimax".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile.as_deref(), Some("chat:minimax"));
    assert_eq!(result.payload["output"][0]["type"], "function_call");
    assert_eq!(result.payload["output"][0]["name"], "exec_command");
    assert_eq!(
        result.payload["output"][0]["arguments"]
            .as_str()
            .unwrap_or(""),
        "{\"cmd\":\"pwd\"}"
    );
    let serialized = serde_json::to_string(&result.payload).unwrap();
    assert!(!serialized.contains("<function_calls>"));
}

#[test]
fn minimax_response_profile_harvests_invoke_xml_tool_call() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "object": "response",
            "id": "resp_minimax_invoke_tool_1",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "<tool_call><invoke name=\"exec\"><parameter name=\"cmd\">pwd</parameter></invoke></tool_call>"
                }]
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:minimax".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert_eq!(result.payload["output"][0]["type"], "function_call");
    assert_eq!(result.payload["output"][0]["name"], "exec_command");
    assert_eq!(
        result.payload["output"][0]["arguments"]
            .as_str()
            .unwrap_or(""),
        "{\"cmd\":\"pwd\"}"
    );
}

#[test]
fn minimax_response_profile_rejects_malformed_text_tool_envelope() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "object": "response",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "<get_goal></invoke></tool_call>"
                }]
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:minimax".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let error =
        run_resp_inbound_stage3_compat(input).expect_err("malformed tool syntax must fail fast");
    assert!(error.contains("malformed text tool-call envelope"));
}

#[test]
fn minimax_response_profile_strips_provider_sentinel_from_anthropic_text() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id": "msg_minimax_sentinel",
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "text",
                "text": "<think]<]minimax[>[\n<continue继续。检查所有 tshirt-heavy / polo-classic 依赖"
            }],
            "stop_reason": "end_turn"
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:minimax".to_string()),
            provider_protocol: Some("anthropic-messages".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert!(result.native_applied);
    assert_eq!(result.applied_profile.as_deref(), Some("chat:minimax"));
    assert_eq!(
        result.payload["content"][0]["text"],
        "继续。检查所有 tshirt-heavy / polo-classic 依赖"
    );
    let serialized = serde_json::to_string(&result.payload).unwrap();
    assert!(!serialized.contains("]<]minimax[>["));
}

#[test]
fn cc_response_profile_projects_known_diagnostic_text_to_empty_natural_stop() {
    let diagnostic = "检测到请求较复杂已自动路由到硬推理模型\nNoticing frequent 'deadlock detected' messages in the logs\nVerifying config.v3.toml provider configurationPlanning removal of inline provider";
    let input = ReqOutboundCompatInput {
        payload: json!({
            "object": "response",
            "id": "resp_cc_diagnostic_1",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": diagnostic}]
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:cc".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert_eq!(result.applied_profile.as_deref(), Some("responses:cc"));
    assert_eq!(result.payload["status"], "completed");
    assert_eq!(result.payload["finish_reason"], "stop");
    assert!(result.payload["output"].as_array().unwrap().is_empty());
    let serialized = serde_json::to_string(&result.payload).unwrap();
    assert!(!serialized.contains("deadlock detected"));
    assert!(!serialized.contains("Verifying config.v3.toml"));
}

#[test]
fn cc_response_profile_preserves_normal_text_and_passthrough_profile_preserves_diagnostic() {
    let normal = ReqOutboundCompatInput {
        payload: json!({
            "object": "response",
            "id": "resp_cc_normal_1",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "normal answer"}]
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:cc".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let normal_result = run_resp_inbound_stage3_compat(normal).unwrap();
    assert_eq!(normal_result.payload["output"][0]["type"], "message");
    assert_eq!(
        normal_result.payload["output"][0]["content"][0]["text"],
        "normal answer"
    );

    let near_match = ReqOutboundCompatInput {
        payload: json!({
            "object": "response",
            "id": "resp_cc_near_match_1",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Noticing frequent 'deadlock detected' messages in the logs"}]
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:cc".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let near_match_result = run_resp_inbound_stage3_compat(near_match).unwrap();
    assert_eq!(near_match_result.payload["output"][0]["type"], "message");

    let passthrough = ReqOutboundCompatInput {
        payload: json!({
            "object": "response",
            "id": "resp_passthrough_diagnostic_1",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Noticing frequent 'deadlock detected' messages in the logs"}]
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-responses".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let passthrough_result = run_resp_inbound_stage3_compat(passthrough).unwrap();
    assert_eq!(passthrough_result.applied_profile, None);
    assert_eq!(passthrough_result.payload["output"][0]["type"], "message");
}

#[test]
fn provider_compat_rejects_control_like_response_fields() {
    for field in ["semantics", "processed", "processingMetadata"] {
        let mut payload = json!({
            "object": "response",
            "output": [{"type": "message", "role": "assistant", "content": []}]
        });
        payload[field] = json!({"internal": true});
        let error = run_resp_inbound_stage3_compat(ReqOutboundCompatInput {
            payload,
            adapter_context: AdapterContext {
                provider_protocol: Some("openai-responses".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        })
        .expect_err("control-like top-level fields must fail at compat boundary");
        assert!(error.contains("ProviderCompatPayloadBoundaryViolation"));
        assert!(error.contains(field));
    }
}

#[test]
fn provider_compat_rejects_control_like_request_fields() {
    for field in ["semantics", "processed", "processingMetadata"] {
        let mut payload = json!({"messages": [{"role": "user", "content": "hi"}]});
        payload[field] = json!({"internal": true});
        let error = run_req_outbound_stage3_compat(ReqOutboundCompatInput {
            payload,
            adapter_context: AdapterContext {
                provider_protocol: Some("openai-responses".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        })
        .expect_err("control-like top-level fields must fail at compat boundary");
        assert!(error.contains("ProviderCompatPayloadBoundaryViolation"));
        assert!(error.contains(field));
    }
}

#[test]
fn provider_compat_preserves_registered_business_fields() {
    let payload = json!({
        "messages": [{"role": "user", "content": "hi"}],
        "business": {"processed": "literal business value"}
    });
    let result = run_req_outbound_stage3_compat(ReqOutboundCompatInput {
        payload: payload.clone(),
        adapter_context: AdapterContext {
            provider_protocol: Some("openai-responses".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    })
    .expect("ordinary business payload must pass");
    assert_eq!(result.payload, payload);
}

#[test]
fn responses_temperature_unsupported_profile_normalizes_tools_and_removes_temperature() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model": "gpt-5.5",
            "temperature": 0.2,
            "tools": [{
                "type": "function",
                "function": {
                    "name": "lookup",
                    "description": "Lookup",
                    "parameters": "{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}}}"
                }
            }],
            "input": [{"type":"reasoning","content":[{"type":"summary_text","text":"old"}]}]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("responses:temperature-unsupported".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.applied_profile.as_deref(),
        Some("responses:temperature-unsupported")
    );
    assert!(result.payload.get("temperature").is_none());
    assert_eq!(result.payload["tools"][0]["name"], "lookup");
    assert_eq!(
        result.payload["tools"][0]["parameters"]["properties"]["q"]["type"],
        "string"
    );
    // #3: 请求侧不再无条件剥离 reasoning content——reasoning 明文原样透传。
    assert_eq!(
        result.payload["input"][0]["content"][0]["text"], "old",
        "reasoning content must pass through verbatim (no unconditional strip)"
    );
}

#[test]
fn glm_unsupported_fields_profile_removes_unsupported_provider_fields() {
    for profile in [
        "chat:openai",
        "chat:glm",
        "chat:glm-unsupported-prompt-cache-key-verbosity",
    ] {
        for (provider_protocol, model) in [
            ("openai-responses", "glm-5.3-flash"),
            ("openai-chat", "deepseek-v4.1-flash"),
        ] {
            let input = ReqOutboundCompatInput {
                payload: json!({
                    "model": model,
                    "prompt_cache_key": "client-cache-1",
                    "verbosity": "high",
                    "messages": [{"role": "user", "content": "hello"}]
                }),
                adapter_context: AdapterContext {
                    compatibility_profile: Some(profile.to_string()),
                    provider_protocol: Some(provider_protocol.to_string()),
                    ..Default::default()
                },
                explicit_profile: None,
            };

            let result = run_req_outbound_stage3_compat(input).unwrap();
            assert_eq!(result.applied_profile.as_deref(), Some(profile));
            assert!(
                result.payload.get("prompt_cache_key").is_none(),
                "unsupported prompt_cache_key must not cross to provider: profile={profile} protocol={provider_protocol} model={model}"
            );
            assert!(
                result.payload.get("verbosity").is_none(),
                "unsupported verbosity must not cross to provider: profile={profile} protocol={provider_protocol} model={model}"
            );
        }
    }
}

#[test]
fn single_tool_call_history_profile_splits_parallel_assistant_messages() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "messages": [{
                "role":"assistant",
                "content":"prior",
                "tool_calls":[
                    {"id":"call_a","type":"function","function":{"name":"a","arguments":"{}"}},
                    {"id":"call_b","type":"function","function":{"name":"b","arguments":"{}"}}
                ]
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:single-tool-call-history".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(
        result.applied_profile.as_deref(),
        Some("chat:single-tool-call-history")
    );
    assert_eq!(result.payload["messages"].as_array().unwrap().len(), 2);
    assert_eq!(
        result.payload["messages"][0]["tool_calls"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(result.payload["messages"][1]["content"], Value::Null);
}

#[test]
fn gemini_profile_shallow_picks_and_adds_search_tools_on_search_route() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "model":"gemini-test",
            "contents":[{"role":"user","parts":[{"text":"search"}]}],
            "web_search":{"query":"x"},
            "metadata_center":{"must":"drop"}
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:gemini".to_string()),
            provider_protocol: Some("gemini-chat".to_string()),
            route_id: Some("web_search".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert_eq!(result.applied_profile.as_deref(), Some("chat:gemini"));
    assert!(result.payload.get("metadata_center").is_none());
    assert!(result.payload.get("web_search").is_none());
    assert!(result.payload["tools"][0].get("googleSearch").is_some());
}

#[test]
fn lmstudio_response_profile_adds_chat_defaults_and_harvests_qwen_tokens() {
    let input = ReqOutboundCompatInput {
        payload: json!({
            "choices":[{
                "index":0,
                "finish_reason":"stop",
                "message":{
                    "role":"assistant",
                    "content":"<|tool_calls_section_begin|><|tool_call_begin|>functions.exec_command<|tool_call_argument_begin|>{\"cmd\":\"pwd\"}<|tool_call_end|><|tool_calls_section_end|>"
                }
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:lmstudio".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_lmstudio_test".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };
    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert_eq!(result.applied_profile.as_deref(), Some("chat:lmstudio"));
    assert_eq!(result.payload["object"], "chat.completion");
    assert_eq!(
        result.payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
}

#[test]
fn minimax_response_profile_does_not_harvest_ordinary_anthropic_wrapper_text() {
    let wrapper = r#"{"name":"probe","arguments":"{\"cmd\":\"ping\",\"reason\":\"执行 ping 命令进行探测\"}"}"#;
    let input = ReqOutboundCompatInput {
        payload: json!({
            "id":"resp_ordinary_wrapper",
            "status":"completed",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":wrapper}]
            }]
        }),
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:minimax".to_string()),
            provider_protocol: Some("openai-responses".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    };

    let result = run_resp_inbound_stage3_compat(input).unwrap();
    assert_eq!(result.payload["output"][0]["type"], "message");
    assert_eq!(result.payload["output"][0]["content"][0]["text"], wrapper);
    assert!(result.payload["output"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| {
            !matches!(
                item["type"].as_str(),
                Some("function_call" | "custom_tool_call" | "tool_call")
            )
        }));
}
