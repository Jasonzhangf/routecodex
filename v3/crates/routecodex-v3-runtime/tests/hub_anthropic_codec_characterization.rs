use routecodex_v3_runtime::{
    characterize_v3_anthropic_client_input_to_hub_semantic,
    characterize_v3_anthropic_hub_response_semantic_to_client_projection,
    characterize_v3_anthropic_hub_semantic_to_provider_wire,
    characterize_v3_anthropic_provider_raw_to_hub_response_semantic,
    encode_v3_responses_semantic_as_anthropic_request,
    project_v3_anthropic_message_as_responses_response, V3AnthropicCodecError,
    V3AnthropicCodecStage, V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent,
};
use serde_json::json;

#[test]
fn request_characterization_preserves_anthropic_json_tool_result_and_reasoning_shape() {
    let client = json!({
        "model": "claude-sonnet",
        "system": [{"type":"text","text":"be exact"}],
        "messages": [
            {"role":"user","content":[{"type":"text","text":"hi"}]},
            {"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"lookup","input":{"q":"x"}}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}
        ],
        "tools": [{"name":"lookup","input_schema":{"type":"object"}}],
        "thinking": {"type":"enabled","budget_tokens":1024},
        "stream": false
    });
    let semantic = characterize_v3_anthropic_client_input_to_hub_semantic(
        client.clone(),
        V3HubEntryProtocol::Anthropic,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &client);
    assert_eq!(
        semantic.trace().stage,
        V3AnthropicCodecStage::ClientInputToHubSemantic
    );

    let wire = characterize_v3_anthropic_hub_semantic_to_provider_wire(semantic).unwrap();
    assert_eq!(wire.payload(), &client);
    assert_eq!(wire.payload()["messages"], client["messages"]);
    assert_eq!(wire.payload()["tools"], client["tools"]);
    assert_eq!(wire.payload()["thinking"], client["thinking"]);
    assert!(wire.payload().get("anthropic_version").is_none());
    assert_eq!(
        wire.trace().stage,
        V3AnthropicCodecStage::HubSemanticToProviderWire
    );
}

#[test]
fn responses_custom_tool_call_raw_input_encodes_as_anthropic_tool_use_object() {
    let raw_patch = "*** Begin Patch\n*** Update File: project.private.config.json\n@@\n-}\n+}\n*** End Patch\n";
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"apply patch"}]
            },
            {
                "type":"custom_tool_call",
                "call_id":"call_patch",
                "name":"apply_patch",
                "input": raw_patch
            },
            {
                "type":"custom_tool_call_output",
                "call_id":"call_patch",
                "output":"Success"
            }
        ]
    }))
    .unwrap();

    assert_eq!(
        provider_request["messages"][1]["content"][0],
        json!({
            "type":"tool_use",
            "id":"call_patch",
            "name":"apply_patch",
            "input":{"input": raw_patch}
        })
    );
}

#[test]
fn responses_replay_safe_reasoning_null_content_does_not_enter_anthropic_messages() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"inspect the cwd"}]
            },
            {
                "type":"reasoning",
                "content": null,
                "summary":[{"type":"summary_text","text":"Need to inspect cwd first."}],
                "encrypted_content":"opaque-openai-reasoning"
            },
            {
                "type":"function_call",
                "call_id":"call_pwd",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"pwd\"}"
            },
            {
                "type":"function_call_output",
                "call_id":"call_pwd",
                "output":"/tmp"
            }
        ]
    }))
    .expect("Responses replay-safe reasoning with null content must not fail Anthropic encoding");

    let messages = provider_request["messages"]
        .as_array()
        .expect("Anthropic request messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"][0]["type"], "tool_use");
    assert_eq!(messages[2]["role"], "user");
    assert_eq!(messages[2]["content"][0]["type"], "tool_result");
    let serialized = serde_json::to_string(&provider_request).expect("Anthropic request JSON");
    assert!(!serialized.contains("opaque-openai-reasoning"));
    assert!(!serialized.contains("summary_text"));
}

#[test]
fn responses_developer_messages_project_to_anthropic_system_not_message_role() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "instructions":"top instruction",
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"hello"}]
            },
            {
                "type":"message",
                "role":"developer",
                "content":[
                    {"type":"input_text","text":"developer rule one"},
                    {"type":"input_text","text":"developer rule two"}
                ]
            },
            {
                "type":"message",
                "role":"system",
                "content":[{"type":"input_text","text":"system replay rule"}]
            },
            {
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"ok"}]
            }
        ]
    }))
    .expect("Responses developer/system instruction items must be valid Anthropic wire");

    let messages = provider_request["messages"]
        .as_array()
        .expect("Anthropic request messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
    assert!(messages
        .iter()
        .all(|message| matches!(message["role"].as_str(), Some("user" | "assistant"))));
    let system = provider_request["system"]
        .as_str()
        .expect("Anthropic top-level system");
    assert!(system.contains("top instruction"));
    assert!(system.contains("developer rule one"));
    assert!(system.contains("developer rule two"));
    assert!(system.contains("system replay rule"));
}

#[test]
fn responses_builtin_tool_types_encode_with_anthropic_names_and_object_tool_choice() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "tool_choice": "auto",
        "input": "Use search if needed.",
        "tools": [
            {
                "type":"tool_search",
                "description":"Discover deferred tools.",
                "parameters":{
                    "type":"object",
                    "properties":{"query":{"type":"string"}},
                    "required":["query"]
                }
            },
            {
                "type":"web_search",
                "external_web_access": true,
                "search_content_types":["text","image"]
            }
        ]
    }))
    .expect("Responses builtin tools must encode as valid Anthropic tools");

    assert_eq!(provider_request["tool_choice"], json!({"type":"auto"}));
    let tools = provider_request["tools"]
        .as_array()
        .expect("Anthropic tools array");
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["name"], json!("tool_search"));
    assert_eq!(tools[0]["description"], json!("Discover deferred tools."));
    assert_eq!(tools[0]["input_schema"]["required"], json!(["query"]));
    assert!(tools[0].get("type").is_none());
    assert!(tools[0].get("parameters").is_none());
    assert_eq!(tools[1]["name"], json!("web_search"));
    assert_eq!(tools[1]["input_schema"], json!({"type":"object"}));
    assert!(tools[1].get("external_web_access").is_none());
    assert!(tools[1].get("search_content_types").is_none());
}

#[test]
fn responses_unknown_nameless_tool_fails_before_provider_wire() {
    let err = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": "hi",
        "tools": [{"type":"deferred_unknown","parameters":{"type":"object"}}]
    }))
    .expect_err("unknown nameless tools must not produce Anthropic tools[].name = null");

    assert!(matches!(
        err,
        V3AnthropicCodecError::MalformedField {
            field: "tools[].name"
        }
    ));
}

#[test]
fn responses_consecutive_tool_calls_group_before_results_for_anthropic_order() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"inspect files"}]
            },
            {
                "type":"reasoning",
                "content": null,
                "encrypted_content":"opaque"
            },
            {
                "type":"function_call",
                "call_id":"call_one",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"pwd\"}"
            },
            {
                "type":"custom_tool_call",
                "call_id":"call_two",
                "name":"apply_patch",
                "input":"*** Begin Patch\n*** End Patch\n"
            },
            {
                "type":"function_call_output",
                "call_id":"call_one",
                "output":"/tmp"
            },
            {
                "type":"custom_tool_call_output",
                "call_id":"call_two",
                "output":"Success"
            }
        ]
    }))
    .expect("consecutive Responses tool calls/results must become Anthropic-adjacent blocks");

    let messages = provider_request["messages"]
        .as_array()
        .expect("Anthropic request messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["role"], json!("assistant"));
    assert_eq!(messages[1]["content"][0]["type"], json!("tool_use"));
    assert_eq!(messages[1]["content"][0]["id"], json!("call_one"));
    assert_eq!(messages[1]["content"][1]["type"], json!("tool_use"));
    assert_eq!(messages[1]["content"][1]["id"], json!("call_two"));
    assert_eq!(messages[2]["role"], json!("user"));
    assert_eq!(messages[2]["content"][0]["type"], json!("tool_result"));
    assert_eq!(messages[2]["content"][0]["tool_use_id"], json!("call_one"));
    assert_eq!(messages[2]["content"][1]["type"], json!("tool_result"));
    assert_eq!(messages[2]["content"][1]["tool_use_id"], json!("call_two"));
    let serialized = serde_json::to_string(&provider_request).expect("Anthropic request JSON");
    assert!(!serialized.contains("opaque"));
}

#[test]
fn responses_tool_output_without_immediate_call_group_fails_before_provider_wire() {
    let err = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": [
            {
                "type":"function_call",
                "call_id":"call_one",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"pwd\"}"
            },
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"break the tool adjacency"}]
            },
            {
                "type":"function_call_output",
                "call_id":"call_one",
                "output":"/tmp"
            }
        ]
    }))
    .expect_err("tool outputs must directly follow their Responses call group");

    assert!(matches!(
        err,
        V3AnthropicCodecError::MalformedField {
            field: "function_call_output"
        }
    ));
}

#[test]
fn responses_assistant_text_between_tool_call_and_output_preserves_anthropic_adjacency() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"push and check health"}]
            },
            {
                "type":"function_call",
                "call_id":"call_push",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"git push origin main\"}"
            },
            {
                "type":"function_call",
                "call_id":"call_health",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"curl -fsS https://example.test/health\"}"
            },
            {
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"I will push first, then verify health."}]
            },
            {
                "type":"function_call_output",
                "call_id":"call_push",
                "output":"main -> main"
            },
            {
                "type":"function_call_output",
                "call_id":"call_health",
                "output":"{\"ok\":true}"
            }
        ]
    }))
    .expect("assistant text between Responses calls and outputs must not break Anthropic tool_result adjacency");

    let messages = provider_request["messages"]
        .as_array()
        .expect("Anthropic messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["role"], json!("assistant"));
    let assistant_content = messages[1]["content"]
        .as_array()
        .expect("assistant content");
    assert_eq!(assistant_content[0]["type"], json!("tool_use"));
    assert_eq!(assistant_content[0]["id"], json!("call_push"));
    assert_eq!(assistant_content[1]["type"], json!("tool_use"));
    assert_eq!(assistant_content[1]["id"], json!("call_health"));
    assert_eq!(assistant_content[2]["type"], json!("text"));
    assert_eq!(
        assistant_content[2]["text"],
        json!("I will push first, then verify health.")
    );
    assert_eq!(messages[2]["role"], json!("user"));
    assert_eq!(messages[2]["content"][0]["type"], json!("tool_result"));
    assert_eq!(messages[2]["content"][0]["tool_use_id"], json!("call_push"));
    assert_eq!(messages[2]["content"][1]["type"], json!("tool_result"));
    assert_eq!(
        messages[2]["content"][1]["tool_use_id"],
        json!("call_health")
    );
}

#[test]
fn response_characterization_preserves_anthropic_json_tool_use_reasoning_and_client_projection() {
    let raw = json!({
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "stop_reason": "tool_use",
        "content": [
            {"type":"thinking","thinking":"short trace"},
            {"type":"text","text":"calling tool"},
            {"type":"tool_use","id":"toolu_2","name":"lookup","input":{"q":"y"}}
        ]
    });
    let semantic = characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
        raw.clone(),
        V3HubProviderWireProtocol::Anthropic,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &raw);
    assert_eq!(
        semantic.trace().transport_intent,
        V3HubTransportIntent::Json
    );
    assert_eq!(
        semantic.trace().stage,
        V3AnthropicCodecStage::ProviderRawToHubResponseSemantic
    );

    let client =
        characterize_v3_anthropic_hub_response_semantic_to_client_projection(semantic).unwrap();
    assert_eq!(client.payload(), &raw);
    assert_eq!(
        client.trace().stage,
        V3AnthropicCodecStage::HubResponseSemanticToClientProjection
    );
}

#[test]
fn response_characterization_preserves_anthropic_redacted_reasoning_as_encrypted_content() {
    let response = project_v3_anthropic_message_as_responses_response(&json!({
        "id":"msg_redacted_reasoning",
        "type":"message",
        "role":"assistant",
        "content":[
            {"type":"redacted_thinking","data":"redacted-sig-1"},
            {"type":"thinking","thinking":"visible thought","signature":"thinking-sig-1"},
            {"type":"text","text":"visible answer"}
        ],
        "stop_reason":"end_turn"
    }))
    .expect(
        "Anthropic redacted/thinking signatures must project to replay-safe Responses reasoning",
    );

    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(response["output"][0]["encrypted_content"], "redacted-sig-1");
    assert!(response["output"][0].get("summary").is_none());
    assert_eq!(response["output"][1]["type"], "reasoning");
    assert_eq!(
        response["output"][1]["summary"][0]["text"],
        "visible thought"
    );
    assert_eq!(response["output"][1]["encrypted_content"], "thinking-sig-1");
    assert_eq!(
        response["output"][2]["content"][0]["text"],
        "visible answer"
    );
    assert!(!response.to_string().contains("redacted_thinking"));
}

#[test]
fn sse_characterization_preserves_individual_reasoning_and_tool_events_without_materialization() {
    let events = [
        json!({
            "type":"content_block_start",
            "index":0,
            "content_block":{"type":"thinking","thinking":""}
        }),
        json!({
            "type":"content_block_delta",
            "index":0,
            "delta":{"type":"thinking_delta","thinking":"trace"}
        }),
        json!({
            "type":"content_block_start",
            "index":1,
            "content_block":{"type":"tool_use","id":"toolu_sse","name":"lookup","input":{}}
        }),
        json!({
            "type":"content_block_delta",
            "index":1,
            "delta":{"type":"input_json_delta","partial_json":r#"{"q":"z"}"#}
        }),
        json!({"type":"message_stop"}),
    ];
    for event in events {
        let semantic = characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            event.clone(),
            V3HubProviderWireProtocol::Anthropic,
            V3HubTransportIntent::Sse,
        )
        .unwrap();
        assert_eq!(semantic.payload(), &event);
        assert_eq!(semantic.trace().transport_intent, V3HubTransportIntent::Sse);
        let client =
            characterize_v3_anthropic_hub_response_semantic_to_client_projection(semantic).unwrap();
        assert_eq!(client.payload(), &event);
    }
}

#[test]
fn provider_error_characterization_is_explicit_and_protocol_bound() {
    let error = json!({
        "type": "error",
        "error": {"type": "invalid_request_error", "message": "bad tool result"}
    });
    let semantic = characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
        error.clone(),
        V3HubProviderWireProtocol::Anthropic,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    let client =
        characterize_v3_anthropic_hub_response_semantic_to_client_projection(semantic).unwrap();
    assert_eq!(client.payload(), &error);

    assert!(matches!(
        characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            json!({"error":{"type":"invalid_request_error"}}),
            V3HubProviderWireProtocol::Anthropic,
            V3HubTransportIntent::Json,
        ),
        Err(V3AnthropicCodecError::MalformedProviderError)
    ));
    assert!(matches!(
        characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            error,
            V3HubProviderWireProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3AnthropicCodecError::ProviderProtocolNotAnthropic)
    ));
    assert!(matches!(
        characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            json!({"type":"invented_event"}),
            V3HubProviderWireProtocol::Anthropic,
            V3HubTransportIntent::Sse,
        ),
        Err(V3AnthropicCodecError::MalformedSseEvent)
    ));
}

#[test]
fn side_channel_and_protocol_fields_cannot_enter_anthropic_payloads() {
    for leaked in [
        "routecodex_internal",
        "metadata_center",
        "debug_snapshot",
        "provider_protocol",
        "resource_handle",
    ] {
        let mut payload = json!({"messages":[]});
        payload
            .as_object_mut()
            .unwrap()
            .insert(leaked.to_string(), json!({"leak":true}));
        assert!(matches!(
            characterize_v3_anthropic_client_input_to_hub_semantic(
                payload,
                V3HubEntryProtocol::Anthropic,
                V3HubTransportIntent::Json,
            ),
            Err(V3AnthropicCodecError::SideChannelLeaked { .. })
        ));
    }
    assert!(matches!(
        characterize_v3_anthropic_client_input_to_hub_semantic(
            json!({"messages":[]}),
            V3HubEntryProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3AnthropicCodecError::EntryProtocolNotAnthropic)
    ));
}
