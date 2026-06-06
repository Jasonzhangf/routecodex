use serde_json::json;

use super::{execute_hub_pipeline_json, HubPipelineConfig, HubPipelineEngine, HubPipelineRequest};

#[test]
fn engine_execute_normalizes_request_and_returns_empty_effect_plan() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig {
        virtual_router: json!({
            "target": {
                "providerKey": "openai.m",
                "runtimeKey": "openai",
                "modelId": "m"
            },
            "routeName": "default"
        }),
        ..HubPipelineConfig::default()
    })
    .unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-1".to_string(),
            endpoint: "/v1/chat/completions".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({ "model": "m", "messages": [{ "role": "user", "content": "hi" }] }),
            metadata: json!({}),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "request".to_string(),
            stage: "inbound".to_string(),
        })
        .unwrap();

    assert_eq!(output.request_id, "req-1");
    assert!(output.success);
    assert_eq!(output.effect_plan.effects.len(), 0);
    assert!(output
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("providerProtocol"))
        .and_then(|value| value.as_str())
        .is_some_and(|protocol| protocol == "openai-chat"));
}

#[test]
fn request_live_path_keeps_inline_metadata_out_of_typed_normal_payload() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig {
        virtual_router: json!({
            "target": {
                "providerKey": "openai.m",
                "runtimeKey": "openai",
                "modelId": "m"
            },
            "routeName": "default"
        }),
        ..HubPipelineConfig::default()
    })
    .unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-inline-metadata-normal-boundary".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-responses".to_string(),
            payload: json!({
                "model": "m",
                "input": [{ "role": "user", "content": "hi" }],
                "metadata": { "routeHint": "tools" }
            }),
            metadata: json!({
                "entryEndpoint": "/v1/responses",
                "routeHint": "tools"
            }),
            stream: true,
            process_mode: "chat".to_string(),
            direction: "request".to_string(),
            stage: "inbound".to_string(),
        })
        .unwrap();

    assert!(output.success);
    let payload = output.payload.unwrap();
    assert!(payload.get("metadata").is_none());
    assert_eq!(payload["model"], json!("m"));
}

#[test]
fn execute_hub_pipeline_json_fails_fast_on_empty_input() {
    let error = execute_hub_pipeline_json("   ".to_string()).unwrap_err();
    assert_eq!(error.code, "hub_pipeline_empty_input");
}

#[test]
fn execute_hub_pipeline_json_uses_total_entry_contract() {
    let input = json!({
        "config": {
            "virtualRouter": {
                "target": {
                    "providerKey": "openai.m",
                    "runtimeKey": "openai",
                    "modelId": "m"
                },
                "routeName": "default"
            }
        },
        "request": {
            "requestId": "req-2",
            "endpoint": "/v1/chat/completions",
            "entryEndpoint": "/v1/chat/completions",
            "providerProtocol": "openai-chat",
            "payload": { "messages": [{ "role": "user", "content": "hi" }] },
            "metadata": {},
            "processMode": "chat",
            "direction": "request",
            "stage": "inbound"
        }
    });
    let output: serde_json::Value =
        serde_json::from_str(&execute_hub_pipeline_json(input.to_string()).unwrap()).unwrap();
    assert_eq!(
        output.get("requestId").and_then(|value| value.as_str()),
        Some("req-2")
    );
    assert_eq!(
        output
            .pointer("/effectPlan/effects")
            .and_then(|value| value.as_array())
            .map(|items| items.len()),
        Some(0)
    );
}

#[test]
fn execute_hub_pipeline_json_uses_preselected_route_outbound_profile_for_responses_to_chat() {
    let input = json!({
        "config": {
            "virtualRouter": {
                "providers": {
                    "primary.key1.gpt-test": {
                        "providerKey": "primary.key1.gpt-test",
                        "providerType": "responses",
                        "runtimeKey": "primary.key1",
                        "modelId": "gpt-test",
                        "endpoint": "mock://primary",
                        "auth": { "type": "apikey", "apiKey": "primary-key" },
                        "outboundProfile": "openai-chat"
                    }
                },
                "routing": {
                    "default": [{
                        "id": "default-priority",
                        "mode": "priority",
                        "targets": ["primary.key1.gpt-test"]
                    }]
                }
            }
        },
        "request": {
            "requestId": "req-bootstrap-vr-no-env",
            "endpoint": "/v1/responses",
            "entryEndpoint": "/v1/responses",
            "providerProtocol": "openai-responses",
            "payload": {
                "model": "gpt-test",
                "input": "hi",
                "tools": [{
                    "type": "function",
                    "name": "exec_command",
                    "description": "execute command",
                    "parameters": {
                        "type": "object",
                        "properties": { "cmd": { "type": "string" } },
                        "required": ["cmd"]
                    }
                }],
                "tool_choice": "auto"
            },
            "metadata": {
                "__routecodexPreselectedRoute": {
                    "target": {
                        "providerKey": "primary.key1.gpt-test",
                        "providerType": "responses",
                        "runtimeKey": "primary.key1",
                        "modelId": "gpt-test",
                        "outboundProfile": "openai-chat"
                    },
                    "decision": { "routeName": "default" },
                    "diagnostics": {}
                }
            },
            "processMode": "chat",
            "direction": "request",
            "stage": "inbound"
        }
    });
    let output: serde_json::Value =
        serde_json::from_str(&execute_hub_pipeline_json(input.to_string()).unwrap()).unwrap();
    assert_eq!(
        output.get("success").and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        output
            .pointer("/payload/messages/0/role")
            .and_then(|value| value.as_str()),
        Some("user")
    );
    assert_eq!(
        output
            .pointer("/payload/messages/0/content")
            .and_then(|value| value.as_str()),
        Some("hi")
    );
    assert_eq!(
        output
            .pointer("/payload/tools/0/function/name")
            .and_then(|value| value.as_str()),
        Some("exec_command")
    );
    assert_eq!(
        output
            .pointer("/payload/tool_choice")
            .and_then(|value| value.as_str()),
        Some("auto")
    );
}

#[test]
fn execute_hub_pipeline_json_builds_non_empty_anthropic_messages_from_responses_input() {
    let input = json!({
        "config": {
            "virtualRouter": {
                "providers": {
                    "mimo.key2.mimo-v2.5": {
                        "providerKey": "mimo.key2.mimo-v2.5",
                        "providerType": "anthropic",
                        "runtimeKey": "mimo.key2",
                        "modelId": "mimo-v2.5",
                        "endpoint": "mock://mimo",
                        "auth": { "type": "apikey", "apiKey": "mimo-key" },
                        "outboundProfile": "anthropic-messages"
                    }
                },
                "routing": {
                    "tools": [{
                        "id": "tools-priority",
                        "mode": "priority",
                        "targets": ["mimo.key2.mimo-v2.5"]
                    }]
                }
            }
        },
        "request": {
            "requestId": "req-responses-to-anthropic-tools",
            "endpoint": "/v1/responses",
            "entryEndpoint": "/v1/responses",
            "providerProtocol": "openai-responses",
            "payload": {
                "model": "mimo-v2.5",
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "read files" }]
                }],
                "tools": [{
                    "type": "function",
                    "name": "exec_command",
                    "description": "execute command",
                    "parameters": {
                        "type": "object",
                        "properties": { "cmd": { "type": "string" } },
                        "required": ["cmd"]
                    }
                }],
                "tool_choice": "auto"
            },
            "metadata": {
                "__routecodexPreselectedRoute": {
                    "target": {
                        "providerKey": "mimo.key2.mimo-v2.5",
                        "providerType": "anthropic",
                        "runtimeKey": "mimo.key2",
                        "modelId": "mimo-v2.5",
                        "outboundProfile": "anthropic-messages"
                    },
                    "decision": { "routeName": "tools" },
                    "diagnostics": {}
                }
            },
            "processMode": "chat",
            "direction": "request",
            "stage": "inbound"
        }
    });
    let output: serde_json::Value =
        serde_json::from_str(&execute_hub_pipeline_json(input.to_string()).unwrap()).unwrap();

    assert_eq!(
        output.get("success").and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        output
            .pointer("/payload/messages/0/role")
            .and_then(|value| value.as_str()),
        Some("user")
    );
    assert_eq!(
        output
            .pointer("/payload/messages/0/content/0/text")
            .and_then(|value| value.as_str()),
        Some("read files")
    );
    assert_eq!(
        output
            .pointer("/payload/tools/0/name")
            .and_then(|value| value.as_str()),
        Some("exec_command")
    );
}

#[test]
fn execute_request_path_preserves_client_tool_surface() {
    let input = json!({
        "config": {
            "virtualRouter": {
                "target": {
                    "providerKey": "openai.m",
                    "runtimeKey": "openai",
                    "modelId": "m"
                },
                "routeName": "tools"
            }
        },
        "request": {
            "requestId": "req-tools-preserve",
            "endpoint": "/v1/chat/completions",
            "entryEndpoint": "/v1/chat/completions",
            "providerProtocol": "openai-chat",
            "payload": {
                "model": "m",
                "messages": [{ "role": "user", "content": "read files" }],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "description": "Run shell commands",
                        "parameters": {
                            "type": "object",
                            "properties": { "cmd": { "type": "string" } },
                            "required": ["cmd"]
                        }
                    }
                }],
                "tool_choice": "auto"
            },
            "metadata": {},
            "processMode": "chat",
            "direction": "request",
            "stage": "inbound"
        }
    });

    let output: serde_json::Value =
        serde_json::from_str(&execute_hub_pipeline_json(input.to_string()).unwrap()).unwrap();

    assert_eq!(
        output.get("success").and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        output
            .pointer("/payload/tools/0/function/name")
            .and_then(|value| value.as_str()),
        Some("exec_command")
    );
    assert_eq!(
        output
            .pointer("/payload/tool_choice")
            .and_then(|value| value.as_str()),
        Some("auto")
    );
}

#[test]
fn execute_hub_pipeline_json_serializes_response_path_errors() {
    let input = json!({
        "config": {},
        "request": {
            "requestId": "req-invalid-response",
            "endpoint": "/v1/chat/completions",
            "entryEndpoint": "/v1/chat/completions",
            "providerProtocol": "openai-chat",
            "payload": { "id": "raw_unobservable_shape" },
            "metadata": {
                "clientProtocol": "openai-chat",
                "entryEndpoint": "/v1/chat/completions"
            },
            "processMode": "chat",
            "direction": "response",
            "stage": "outbound"
        }
    });
    let output: serde_json::Value =
        serde_json::from_str(&execute_hub_pipeline_json(input.to_string()).unwrap()).unwrap();

    assert_eq!(
        output.get("success").and_then(|value| value.as_bool()),
        Some(false)
    );
    assert_eq!(
        output
            .pointer("/error/code")
            .and_then(|value| value.as_str()),
        Some("hub_pipeline_error")
    );
    assert!(output
        .pointer("/error/message")
        .and_then(|value| value.as_str())
        .is_some_and(|message| message.contains("choices array")));
}

#[test]
fn response_path_moves_provider_top_level_metadata_out_of_normal_payload() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-responses-provider-metadata".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-responses".to_string(),
            payload: json!({
                "id": "resp_provider_metadata",
                "object": "response",
                "status": "completed",
                "metadata": {
                    "turn_id": "provider-turn-1"
                },
                "output": [{
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "pong"
                    }]
                }]
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses",
                "stream": false
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .expect("response path should accept provider metadata via Meta carrier");

    assert!(output.success);
    assert_eq!(
        output
            .payload
            .as_ref()
            .and_then(|payload| payload.get("metadata")),
        None
    );
    assert_eq!(
        output
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.pointer("/providerResponseMetadata/turn_id"))
            .and_then(|value| value.as_str()),
        Some("provider-turn-1")
    );
}

#[test]
fn anthropic_response_remaps_to_openai_responses_client_payload() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-anthropic-responses-remap".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "anthropic-messages".to_string(),
            payload: json!({
                "id": "msg_anthropic_remap_1",
                "type": "message",
                "role": "assistant",
                "model": "mimo-v2.5",
                "content": [{ "type": "text", "text": "anthropic response ok" }],
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 7, "output_tokens": 3 }
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses"
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let payload = output.payload.unwrap();
    assert_eq!(payload["object"], json!("response"));
    assert_eq!(payload["status"], json!("completed"));
    assert_eq!(payload["model"], json!("mimo-v2.5"));
    assert!(payload.to_string().contains("anthropic response ok"));
}

#[test]
fn anthropic_end_turn_stopless_effect_uses_chatprocess_payload() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-anthropic-stopless-chatprocess".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "anthropic-messages".to_string(),
            payload: json!({
                "id": "msg_anthropic_stopless_1",
                "type": "message",
                "role": "assistant",
                "model": "MiniMax-M3",
                "content": [{ "type": "text", "text": "Jason，继续。先核 coder2 工具。" }],
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 7, "output_tokens": 3 }
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses",
                "runtimeEffects": { "providerInvoker": true }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let effect = output
        .effect_plan
        .effects
        .iter()
        .find(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
                && effect.payload["reason"] == json!("stop_eligible_followup")
        })
        .unwrap();
    assert_eq!(effect.payload["stopGateway"]["source"], json!("chat"));
    assert_eq!(
        effect.payload["stopGateway"]["reason"],
        json!("finish_reason_stop")
    );
    assert_eq!(
        effect.payload["payload"]["choices"][0]["finish_reason"],
        json!("stop")
    );
    assert_eq!(
        effect.payload["payload"]["choices"][0]["message"]["content"],
        json!("Jason，继续。先核 coder2 工具。")
    );
}

#[test]
fn anthropic_empty_end_turn_stopless_effect_uses_chatprocess_payload() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-anthropic-empty-stopless-chatprocess".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "anthropic-messages".to_string(),
            payload: json!({
                "id": "msg_anthropic_empty_stopless_1",
                "type": "message",
                "role": "assistant",
                "model": "MiniMax-M2.7",
                "content": [{ "type": "text", "text": "" }],
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 0, "output_tokens": 0 }
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses",
                "runtimeEffects": { "providerInvoker": true }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let effect = output
        .effect_plan
        .effects
        .iter()
        .find(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
                && effect.payload["reason"] == json!("stop_eligible_followup")
        })
        .unwrap();
    assert_eq!(effect.payload["stopGateway"]["source"], json!("chat"));
    assert_eq!(
        effect.payload["stopGateway"]["reason"],
        json!("finish_reason_stop")
    );
    assert_eq!(
        effect.payload["payload"]["choices"][0]["finish_reason"],
        json!("stop")
    );
    assert_eq!(
        effect.payload["payload"]["choices"][0]["message"]["content"],
        json!("")
    );
}

#[test]
fn anthropic_wrapped_empty_end_turn_stopless_effect_uses_body_data() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-anthropic-wrapped-empty-stopless-chatprocess".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "anthropic-messages".to_string(),
            payload: json!({
                "body": {
                    "status": 200,
                    "headers": { "content-type": "text/event-stream" },
                    "data": {
                        "id": "msg_anthropic_wrapped_empty_stopless_1",
                        "type": "message",
                        "role": "assistant",
                        "model": "MiniMax-M2.7",
                        "content": [{ "type": "text", "text": "" }],
                        "stop_reason": "end_turn",
                        "usage": { "input_tokens": 0, "output_tokens": 0 }
                    }
                }
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses",
                "runtimeEffects": { "providerInvoker": true }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let effect = output
        .effect_plan
        .effects
        .iter()
        .find(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
                && effect.payload["reason"] == json!("stop_eligible_followup")
        })
        .unwrap();
    assert_eq!(
        effect.payload["stopGateway"]["reason"],
        json!("finish_reason_stop")
    );
    assert_eq!(
        effect.payload["payload"]["choices"][0]["message"]["content"],
        json!("")
    );
}

#[test]
fn response_stream_path_returns_stream_pipe_effect_plan() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-stream-1".to_string(),
            endpoint: "/v1/chat/completions".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "id": "chatcmpl_stream",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "hi" },
                    "finish_reason": "stop"
                }]
            }),
            metadata: json!({
                "clientProtocol": "openai-chat",
                "entryEndpoint": "/v1/chat/completions",
                "stream": true
            }),
            stream: true,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    assert_eq!(output.effect_plan.effects.len(), 2);
    let effect = output
        .effect_plan
        .effects
        .iter()
        .find(|effect| serde_json::to_value(&effect.kind).unwrap() == json!("streamPipe"))
        .unwrap();
    assert_eq!(
        serde_json::to_value(&effect.kind).unwrap(),
        json!("streamPipe")
    );
    assert_eq!(effect.payload["codec"], json!("openai-chat"));
    assert_eq!(effect.payload["requestId"], json!("req-stream-1"));
    let payload = output.payload.unwrap();
    assert_eq!(effect.payload["payload"], payload);
    let runtime_effect = output
        .effect_plan
        .effects
        .iter()
        .find(|effect| serde_json::to_value(&effect.kind).unwrap() == json!("runtimeStateWrite"))
        .unwrap();
    assert_eq!(runtime_effect.payload["requestId"], json!("req-stream-1"));
    assert_eq!(runtime_effect.payload["payload"], payload);
    assert_eq!(
        runtime_effect.payload["keepForSubmitToolOutputs"],
        json!(false)
    );
}

#[test]
fn response_stop_with_runtime_callbacks_returns_servertool_effect_plan() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-servertool-effect-1".to_string(),
            endpoint: "/v1/chat/completions".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "id": "chatcmpl_servertool_effect",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "done" },
                    "finish_reason": "stop"
                }]
            }),
            metadata: json!({
                "clientProtocol": "openai-chat",
                "entryEndpoint": "/v1/chat/completions",
                "runtimeEffects": { "providerInvoker": true }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let effect = output
        .effect_plan
        .effects
        .iter()
        .find(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
        })
        .unwrap();
    assert_eq!(effect.payload["action"], json!("requireRuntimeExecutor"));
    assert_eq!(effect.payload["reason"], json!("stop_eligible_followup"));
    assert_eq!(
        effect.payload["payload"]["choices"][0]["finish_reason"],
        json!("stop")
    );
    assert_eq!(
        effect.payload["payload"]["choices"][0]["message"]["content"],
        json!("done")
    );
    assert_eq!(effect.payload["stopGateway"]["source"], json!("chat"));
    assert_eq!(
        effect.payload["requestId"],
        json!("req-servertool-effect-1")
    );
}

#[test]
fn response_tool_call_with_runtime_callbacks_returns_servertool_executor_effect_plan() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-servertool-tool-call-effect-1".to_string(),
            endpoint: "/v1/chat/completions".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "id": "chatcmpl_servertool_tool_call_effect",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_servertool_apply_patch_1",
                            "type": "function",
                            "function": { "name": "apply_patch", "arguments": "{}" }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            metadata: json!({
                "clientProtocol": "openai-chat",
                "entryEndpoint": "/v1/chat/completions",
                "runtimeEffects": { "providerInvoker": true }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let effect = output
        .effect_plan
        .effects
        .iter()
        .find(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
                && effect.payload["action"] == json!("requireRuntimeExecutor")
        })
        .unwrap();
    assert_eq!(effect.payload["reason"], json!("tool_call_dispatch"));
    assert_eq!(
        effect.payload["requestId"],
        json!("req-servertool-tool-call-effect-1")
    );
}

#[test]
fn responses_tool_call_servertool_effect_uses_resp_chatprocess_payload_not_client_projection() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-responses-chatprocess-tool-call-effect".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "id": "chatcmpl_responses_servertool_tool_call_effect",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_noop_1",
                            "type": "function",
                            "function": { "name": "noop_check", "arguments": "{}" }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses",
                "runtimeEffects": { "providerInvoker": true }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let effect = output
        .effect_plan
        .effects
        .iter()
        .find(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
                && effect.payload["reason"] == json!("tool_call_dispatch")
        })
        .unwrap();
    assert!(effect.payload["payload"].get("choices").is_some());
    assert!(effect.payload["payload"].get("required_action").is_none());
    assert_eq!(
        effect.payload["payload"]["choices"][0]["finish_reason"],
        json!("tool_calls")
    );
    assert_eq!(
        output.payload.unwrap()["required_action"]["type"],
        json!("submit_tool_outputs")
    );
}
