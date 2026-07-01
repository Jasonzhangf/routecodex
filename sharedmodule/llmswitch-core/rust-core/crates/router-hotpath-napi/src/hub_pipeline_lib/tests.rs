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
            metadata_center_snapshot: json!(null),
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
            metadata_center_snapshot: json!(null),
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
fn execute_hub_pipeline_json_fails_without_preselected_route_and_retry_exclusions() {
    let input = json!({
        "config": {
            "virtualRouter": {
                "providers": {
                    "openai.key1.gpt-5.5": {
                        "providerKey": "openai.key1.gpt-5.5",
                        "providerType": "openai",
                        "runtimeKey": "openai.key1",
                        "modelId": "gpt-5.5",
                        "endpoint": "mock://openai-1",
                        "auth": { "type": "apikey", "apiKey": "openai-key-1" }
                    }
                },
                "routing": {
                    "default": [{
                        "id": "default-priority",
                        "mode": "priority",
                        "targets": ["openai.key1.gpt-5.5"]
                    }]
                }
            }
        },
        "request": {
            "requestId": "req-missing-preselected-route",
            "endpoint": "/v1/responses",
            "entryEndpoint": "/v1/responses",
            "providerProtocol": "openai-responses",
            "payload": {
                "model": "gpt-5.5",
                "input": [{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "ping" }] }]
            },
            "metadata": {},
            "processMode": "chat",
            "direction": "request",
            "stage": "inbound"
        }
    });

    let error = execute_hub_pipeline_json(input.to_string()).unwrap_err();
    assert_eq!(error.code, "hub_pipeline_missing_preselected_route");
}

#[test]
fn execute_hub_pipeline_json_uses_explicit_retry_exclusions_without_preselected_route() {
    let input = json!({
        "config": {
            "virtualRouter": {
                "providers": {
                    "openai.key1.gpt-5.5": {
                        "providerKey": "openai.key1.gpt-5.5",
                        "providerType": "openai",
                        "runtimeKey": "openai.key1",
                        "modelId": "gpt-5.5",
                        "endpoint": "mock://openai-1",
                        "auth": { "type": "apikey", "apiKey": "openai-key-1" }
                    },
                    "openai.key2.gpt-5.5": {
                        "providerKey": "openai.key2.gpt-5.5",
                        "providerType": "openai",
                        "runtimeKey": "openai.key2",
                        "modelId": "gpt-5.5",
                        "endpoint": "mock://openai-2",
                        "auth": { "type": "apikey", "apiKey": "openai-key-2" }
                    }
                },
                "routing": {
                    "default": [{
                        "id": "default-priority",
                        "mode": "priority",
                        "targets": [
                            "openai.key1.gpt-5.5",
                            "openai.key2.gpt-5.5"
                        ]
                    }]
                }
            }
        },
        "request": {
            "requestId": "req-explicit-retry-route",
            "endpoint": "/v1/responses",
            "entryEndpoint": "/v1/responses",
            "providerProtocol": "openai-responses",
            "payload": {
                "model": "gpt-5.5",
                "input": [{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "ping" }] }]
            },
            "metadata": {
                "excludedProviderKeys": [
                    "openai.key1.gpt-5.5"
                ]
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
            .pointer("/metadata/target/providerKey")
            .and_then(|value| value.as_str()),
        Some("openai.key2.gpt-5.5")
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
                "runtime_control": {
                    "preselectedRoute": {
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
                "runtime_control": {
                    "preselectedRoute": {
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
fn execute_hub_pipeline_json_preserves_stopless_instructions_for_anthropic_provider_payload() {
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
            "requestId": "req-responses-stopless-to-anthropic-system",
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
                "stream": false
            },
            "metadata": {
                "runtime_control": {
                    "preselectedRoute": {
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
                }
            },
            "metadataCenterSnapshot": {
                "requestTruth": {
                    "requestId": "req-responses-stopless-to-anthropic-system",
                    "sessionId": "sess-responses-stopless-to-anthropic-system"
                },
                "runtimeControl": {
                    "stopMessage": {
                        "enabled": true
                    },
                    "preselectedRoute": {
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
    assert!(
        output
            .pointer("/payload/system")
            .map(|value| value.to_string())
            .unwrap_or_default()
            .contains("stopreason 取值：0=finished，1=blocked，2=continue_needed"),
        "unexpected output: {}",
        output
    );
    assert!(output.pointer("/payload/instructions").is_none());
}

#[test]
fn execute_hub_pipeline_json_restores_stopless_cli_result_as_reasoning_stop_pair_and_guidance() {
    let stopless_cli_output = json!({
        "ok": true,
        "kind": "stop_message_auto",
        "tool": "stop_message_auto",
        "toolName": "stop_message_auto",
        "flowId": "stop_message_flow",
        "summary": "stopless continuation ready",
        "repeatCount": 1,
        "maxRepeats": 3,
        "continuationPrompt": "继续推进当前任务。",
        "schemaFeedback": {
            "reasonCode": "stop_schema_missing",
            "missingFields": ["stopreason", "reason", "next_step"]
        },
        "schemaGuidance": {
            "requiredFields": ["stopreason", "reason", "next_step"],
            "stopreasonValues": {
                "finished": 0,
                "blocked": 1,
                "continueNeeded": 2
            },
            "triggerHint": "no_schema"
        },
        "input": {
            "flowId": "stop_message_flow",
            "repeatCount": 1,
            "maxRepeats": 3,
            "triggerHint": "no_schema"
        }
    });
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
                    "thinking": [{
                        "id": "thinking-priority",
                        "mode": "priority",
                        "targets": ["mimo.key2.mimo-v2.5"]
                    }]
                }
            }
        },
        "request": {
            "requestId": "req-stopless-cli-feedback-provider-guidance",
            "endpoint": "/v1/responses",
            "entryEndpoint": "/v1/responses",
            "providerProtocol": "openai-responses",
            "payload": {
                "model": "mimo-v2.5",
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "继续执行" }]
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_stopless_cli_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}'\"}"
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_stopless_cli_1",
                        "output": stopless_cli_output.to_string()
                    }
                ],
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
                "tool_choice": "auto",
                "stream": false
            },
            "metadata": {},
            "metadataCenterSnapshot": {
                "requestTruth": {
                    "requestId": "req-stopless-cli-feedback-provider-guidance",
                    "sessionId": "sess-stopless-cli-feedback-provider-guidance"
                },
                "runtimeControl": {
                    "stopMessage": {
                        "enabled": true
                    },
                    "stopless": {
                        "active": true,
                        "flowId": "stop_message_flow",
                        "repeatCount": 1,
                        "maxRepeats": 3,
                        "triggerHint": "no_schema",
                        "continuationPrompt": "继续推进当前任务。",
                        "schemaFeedback": {
                            "reasonCode": "stop_schema_missing",
                            "missingFields": ["stopreason", "reason", "next_step"]
                        }
                    },
                    "preselectedRoute": {
                        "target": {
                            "providerKey": "mimo.key2.mimo-v2.5",
                            "providerType": "anthropic",
                            "runtimeKey": "mimo.key2",
                            "modelId": "mimo-v2.5",
                            "outboundProfile": "anthropic-messages"
                        },
                        "decision": { "routeName": "thinking" },
                        "diagnostics": {}
                    }
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
        Some(true),
        "unexpected output: {}",
        output
    );
    let serialized = serde_json::to_string(&output["payload"]).unwrap();
    assert!(
        serialized.contains("上一轮执行结果：repeatCount=1/3")
            && serialized.contains("reasonCode=stop_schema_missing")
            && serialized.contains("missingFields=stopreason, reason, next_step"),
        "provider payload must carry exact CLI feedback, got: {}",
        serialized
    );
    assert!(
        serialized.contains("stopreason 取值：0=finished，1=blocked，2=continue_needed"),
        "provider payload must carry stop schema contract, got: {}",
        serialized
    );
    assert_eq!(
        output["metadata"]["runtime_control"]["stopless"]["repeatCount"],
        json!(1),
        "request ChatProcess metadata must expose current stopless used count for MetadataCenter sync: {}",
        output["metadata"]
    );
    assert_eq!(
        output["metadata"]["runtime_control"]["stopless"]["maxRepeats"],
        json!(3),
        "request ChatProcess metadata must expose current stopless max repeats: {}",
        output["metadata"]
    );
    assert_eq!(
        output["metadata"]["runtime_control"]["stopless"]["schemaFeedback"]["reasonCode"],
        json!("stop_schema_missing"),
        "request ChatProcess metadata must preserve stopless schema feedback: {}",
        output["metadata"]
    );
    assert!(
        serialized.contains("如果任务已经完成，就按下面 schema 补齐")
            && serialized.contains("stopreason, reason, next_step"),
        "provider payload must explain missing fields naturally, got: {}",
        serialized
    );
    let messages = output["payload"]["messages"]
        .as_array()
        .expect("anthropic provider messages");
    assert!(
        messages.len() >= 3,
        "provider payload must keep restored stopless pair adjacent to guidance, got: {}",
        output["payload"]
    );
    assert!(
        messages[1]["content"][0]["type"] == json!("tool_use"),
        "provider payload must restore internal tool-call semantics, got: {}",
        output["payload"]
    );
    assert_eq!(
        messages[1]["content"][0]["name"],
        json!("reasoningStop"),
        "provider payload must restore reasoningStop instead of replaying raw exec_command history"
    );
    assert_eq!(
        messages[2]["content"][0]["type"],
        json!("tool_result"),
        "provider payload must restore paired tool result, got: {}",
        output["payload"]
    );
    assert_eq!(
        messages[2]["content"][0]["tool_use_id"], messages[1]["content"][0]["id"],
        "provider payload must pair restored reasoningStop call/result on the same id"
    );
    assert!(
        !serde_json::to_string(&messages[2]["content"][0])
            .unwrap_or_default()
            .contains("stop_message_auto"),
        "provider payload must not expose raw stop_message_auto CLI identity: {}",
        output["payload"]
    );
    assert!(
        output["payload"]["tools"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .any(|tool| tool.get("name").and_then(|value| value.as_str()) == Some("exec_command")),
        "provider payload must keep client tool availability: {}",
        output
    );
    assert!(
        output["payload"]["tools"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .any(|tool| tool.get("name").and_then(|value| value.as_str()) == Some("reasoningStop")),
        "provider payload must keep reasoningStop tool contract on the next round: {}",
        output
    );
}

#[test]
fn execute_hub_pipeline_json_applies_target_compatibility_profile_for_anthropic_relay() {
    let input = json!({
        "config": {
            "virtualRouter": {
                "providers": {
                    "minimax.key1.MiniMax-M3": {
                        "providerKey": "minimax.key1.MiniMax-M3",
                        "providerType": "anthropic",
                        "runtimeKey": "minimax.key1",
                        "modelId": "MiniMax-M3",
                        "endpoint": "mock://minimax",
                        "auth": { "type": "apikey", "apiKey": "minimax-key" },
                        "outboundProfile": "anthropic-messages",
                        "compatibilityProfile": "compat:passthrough"
                    }
                },
                "routing": {
                    "thinking": [{
                        "id": "thinking-priority",
                        "mode": "priority",
                        "targets": ["minimax.key1.MiniMax-M3"]
                    }]
                }
            }
        },
        "request": {
            "requestId": "req-responses-to-minimax-compat",
            "endpoint": "/v1/responses",
            "entryEndpoint": "/v1/responses",
            "providerProtocol": "openai-responses",
            "payload": {
                "model": "gpt-5.5",
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
                "runtime_control": {
                    "preselectedRoute": {
                        "target": {
                            "providerKey": "minimax.key1.MiniMax-M3",
                            "providerType": "anthropic",
                            "runtimeKey": "minimax.key1",
                            "modelId": "MiniMax-M3",
                            "outboundProfile": "anthropic-messages",
                            "compatibilityProfile": "compat:passthrough"
                        },
                        "decision": { "routeName": "thinking" },
                        "diagnostics": {}
                    }
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
    assert!(output.pointer("/payload/system").is_none());
    assert!(output.pointer("/payload/thinking").is_none());
    assert!(output.pointer("/payload/output_config").is_none());
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
            metadata_center_snapshot: json!(null),
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
fn response_path_projects_responses_required_action_reasoning_stop_to_exec_command() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-responses-required-action-stopless".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-responses".to_string(),
            payload: json!({
                "id": "resp_required_action_stopless",
                "object": "response",
                "status": "requires_action",
                "model": "gpt-5.5",
                "output": [
                    {
                        "id": "reasoning_1",
                        "type": "reasoning",
                        "encrypted_content": "opaque"
                    },
                    {
                        "id": "fc_call_stopless_1",
                        "type": "function_call",
                        "call_id": "call_stopless_1",
                        "name": "reasoningStop",
                        "arguments": "{\"stopreason\":2,\"reason\":\"not done\",\"next_step\":\"run next check\",\"has_evidence\":1,\"evidence\":\"partial\",\"needs_user_input\":false}"
                    }
                ],
                "required_action": {
                    "type": "submit_tool_outputs",
                    "submit_tool_outputs": {
                        "tool_calls": [{
                            "id": "call_stopless_1",
                            "type": "function",
                            "name": "reasoningStop",
                            "tool_call_id": "call_stopless_1",
                            "function": {
                                "name": "reasoningStop",
                                "arguments": "{\"stopreason\":2,\"reason\":\"not done\",\"next_step\":\"run next check\",\"has_evidence\":1,\"evidence\":\"partial\",\"needs_user_input\":false}"
                            }
                        }]
                    }
                }
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses",
                "stream": false
            }),
            metadata_center_snapshot: json!({
                "requestTruth": {
                    "requestId": "req-responses-required-action-stopless",
                    "sessionId": "sess-responses-required-action-stopless"
                },
                "runtimeControl": {
                    "stopless": {
                        "active": true,
                        "flowId": "stop_message_flow",
                        "repeatCount": 1,
                        "maxRepeats": 3
                    }
                }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    assert!(output.success);
    let payload = output.payload.expect("projected response payload");
    let serialized = payload.to_string();
    assert!(
        serialized.contains("routecodex hook run reasoningStop"),
        "client-visible response must contain CLI projection: {}",
        serialized
    );
    assert!(
        serialized.contains("\"name\":\"exec_command\""),
        "client-visible response must expose exec_command: {}",
        serialized
    );
    assert!(
        !serialized.contains("\"name\":\"reasoningStop\""),
        "client-visible response must not leak internal reasoningStop: {}",
        serialized
    );
    assert_eq!(
        payload
            .pointer("/required_action/submit_tool_outputs/tool_calls/0/function/name")
            .and_then(|value| value.as_str()),
        Some("exec_command"),
        "required_action must expose the CLI shell tool, not the internal tool: {}",
        payload
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
                "entryEndpoint": "/v1/responses",
                "providerProtocol": "openai-chat"
            }),
            metadata_center_snapshot: json!(null),
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
fn openai_chat_response_remaps_to_openai_responses_client_payload() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-openai-chat-responses-remap".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "id": "chatcmpl_responses_remap_1",
                "object": "chat.completion",
                "model": "deepseek-v4-pro",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "chat response ok" },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6 }
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses"
            }),
            metadata_center_snapshot: json!(null),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let payload = output.payload.unwrap();
    assert_eq!(payload["object"], json!("response"));
    assert_eq!(payload["status"], json!("completed"));
    assert_eq!(payload["model"], json!("deepseek-v4-pro"));
    assert!(payload.to_string().contains("chat response ok"));
    assert!(payload.get("choices").is_none());
}

#[test]
fn response_path_missing_provider_protocol_fails_fast() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let error = engine
        .execute(HubPipelineRequest {
            request_id: "req-missing-provider-protocol".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: String::new(),
            payload: json!({
                "id": "chatcmpl_missing_protocol",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "ok" },
                    "finish_reason": "stop"
                }]
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses"
            }),
            metadata_center_snapshot: json!(null),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap_err();

    assert_eq!(error.code, "hub_pipeline_missing_provider_protocol");
    assert!(error.message.contains("requires providerProtocol"));
}

#[test]
fn response_path_reads_provider_protocol_from_runtime_control_snapshot() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-provider-protocol-runtime-control".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: String::new(),
            payload: json!({
                "id": "chatcmpl_runtime_control_protocol",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "ok" },
                    "finish_reason": "stop"
                }]
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses"
            }),
            metadata_center_snapshot: json!({
                "runtimeControl": {
                    "providerProtocol": "openai-chat"
                }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    assert!(output.success);
    assert!(
        output
            .payload
            .as_ref()
            .and_then(|payload| payload.get("id"))
            .and_then(|value| value.as_str())
            .is_some_and(|id| id.starts_with("resp_")),
        "response path should project provider chat payload to client Responses shape: {:?}",
        output.payload
    );
}

#[test]
fn response_chat_stop_schema_projects_stopless_cli_before_responses_outbound() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-stopless-live-schema-round2".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "id": "chatcmpl_stopless_live_round2",
                "object": "chat.completion",
                "model": "glm-5.2",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "{\"stopreason\":2,\"reason\":\"第二轮还没做完\",\"next_step\":\"基于第二轮工具结果继续最终核对\"}",
                        "reasoning_content": "reasoning"
                    },
                    "finish_reason": "stop"
                }]
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses"
            }),
            metadata_center_snapshot: json!({
                "requestTruth": {
                    "sessionId": "stopless-live-test-session",
                    "conversationId": "stopless-live-test-session"
                },
                "continuationContext": {
                    "responsesResume": {
                        "continuationOwner": "relay",
                        "entryKind": "responses",
                        "toolOutputsDetailed": [{
                            "callId": "call_stopless_round1",
                            "originalId": "call_stopless_round1",
                            "outputText": "{\"ok\":true,\"kind\":\"stop_message_auto\",\"tool\":\"stop_message_auto\",\"summary\":\"stopless continuation ready\",\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3,\"sessionId\":\"stopless-live-test-session\",\"input\":{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1,\"triggerHint\":\"non_terminal_schema\"}}"
                        }]
                    }
                },
                "runtimeControl": {
                    "stopless": {
                        "active": true,
                        "flowId": "stop_message_flow",
                        "repeatCount": 1,
                        "maxRepeats": 3,
                        "triggerHint": "non_terminal_schema",
                        "continuationPrompt": "继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。",
                        "schemaFeedback": {
                            "reasonCode": "non_terminal_schema",
                            "missingFields": []
                        }
                    }
                }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    assert!(output.success);
    let payload = output.payload.as_ref().expect("payload");
    assert_eq!(payload["status"], json!("requires_action"));
    assert_eq!(
        payload["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]["name"],
        json!("exec_command")
    );
    let args = payload["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .expect("exec args");
    assert!(
        args.contains("routecodex hook run reasoningStop"),
        "stopless must be projected as client-visible reasoningStop CLI, got: {args}"
    );
    assert!(
        args.contains("\\\"repeatCount\\\":2") || args.contains("\"repeatCount\":2"),
        "round 2 stop schema must project repeatCount=2, got: {args}"
    );
    assert!(output.effect_plan.effects.iter().any(|effect| {
        serde_json::to_value(&effect.kind).unwrap() == json!("stoplessMetadataCenterWrite")
    }));
    assert!(!output.effect_plan.effects.iter().any(|effect| {
        serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
            && effect.payload["action"] == json!("requireResponseHookRuntime")
    }));
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
            metadata_center_snapshot: json!({
                "requestTruth": { "sessionId": "sess-anthropic-stopless-chatprocess" },
                "runtimeControl": {
                    "stopless": {
                        "flowId": "stop_message_flow",
                        "repeatCount": 0,
                        "maxRepeats": 3,
                        "active": true
                    }
                }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    assert!(output.success);
    let payload = output.payload.as_ref().expect("payload");
    assert_eq!(payload["status"], json!("requires_action"));
    assert_eq!(
        payload["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]["name"],
        json!("exec_command")
    );
    let args = payload["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .expect("exec args");
    assert!(args.contains("routecodex hook run reasoningStop"));
    assert!(args.contains("triggerHint"));
    assert!(output.effect_plan.effects.iter().any(|effect| {
        serde_json::to_value(&effect.kind).unwrap() == json!("stoplessMetadataCenterWrite")
    }));
    assert!(!output.effect_plan.effects.iter().any(|effect| {
        serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
            && effect.payload["action"] == json!("requireResponseHookRuntime")
    }));
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
            metadata_center_snapshot: json!({
                "requestTruth": { "sessionId": "sess-anthropic-empty-stopless-chatprocess" },
                "runtimeControl": {
                    "stopless": {
                        "flowId": "stop_message_flow",
                        "repeatCount": 0,
                        "maxRepeats": 3,
                        "active": true
                    }
                }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    assert!(output.success);
    let payload = output.payload.as_ref().expect("payload");
    assert_eq!(payload["status"], json!("requires_action"));
    let args = payload["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .expect("exec args");
    assert!(args.contains("routecodex hook run reasoningStop"));
    assert!(args.contains("triggerHint"));
    assert!(output.effect_plan.effects.iter().any(|effect| {
        serde_json::to_value(&effect.kind).unwrap() == json!("stoplessMetadataCenterWrite")
    }));
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
            metadata_center_snapshot: json!({
                "requestTruth": { "sessionId": "sess-anthropic-wrapped-empty-stopless-chatprocess" },
                "runtimeControl": {
                    "stopless": {
                        "flowId": "stop_message_flow",
                        "repeatCount": 0,
                        "maxRepeats": 3,
                        "active": true
                    }
                }
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    assert!(output.success);
    let payload = output.payload.as_ref().expect("payload");
    assert_eq!(payload["status"], json!("requires_action"));
    let args = payload["required_action"]["submit_tool_outputs"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .expect("exec args");
    assert!(args.contains("routecodex hook run reasoningStop"));
    assert!(args.contains("triggerHint"));
    assert!(output.effect_plan.effects.iter().any(|effect| {
        serde_json::to_value(&effect.kind).unwrap() == json!("stoplessMetadataCenterWrite")
    }));
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
            metadata_center_snapshot: json!(null),
            stream: true,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let stream_pipe_count = output
        .effect_plan
        .effects
        .iter()
        .filter(|effect| serde_json::to_value(&effect.kind).unwrap() == json!("streamPipe"))
        .count();
    let runtime_state_write_count = output
        .effect_plan
        .effects
        .iter()
        .filter(|effect| serde_json::to_value(&effect.kind).unwrap() == json!("runtimeStateWrite"))
        .count();
    let servertool_runtime_action_count = output
        .effect_plan
        .effects
        .iter()
        .filter(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
        })
        .count();
    assert_eq!(stream_pipe_count, 1);
    assert_eq!(runtime_state_write_count, 1);
    assert_eq!(servertool_runtime_action_count, 0);
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
    assert!(
        effect.payload["payload"]["created"]
            .as_i64()
            .is_some_and(|created| created > 0),
        "Rust streamPipe payload must be directly encodable by openai-chat SSE codec"
    );
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
fn response_stream_stop_with_runtime_callbacks_returns_stream_and_servertool_effects() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-stream-servertool-effect-1".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-responses".to_string(),
            payload: json!({
                "id": "resp_stream_servertool_effect",
                "object": "response",
                "status": "completed",
                "model": "gpt-test",
                "output": [{
                    "id": "msg_stream_servertool_effect",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{ "type": "output_text", "text": "done" }]
                }]
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses",
                "stream": true,
                "stopMessageEnabled": true,
                "routecodexPortStopMessageEnabled": true,
                "runtimeEffects": { "clientInjectDispatch": true }
            }),
            metadata_center_snapshot: json!(null),
            stream: true,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let stream_effect = output
        .effect_plan
        .effects
        .iter()
        .find(|effect| serde_json::to_value(&effect.kind).unwrap() == json!("streamPipe"))
        .unwrap();
    assert_eq!(stream_effect.payload["codec"], json!("openai-responses"));
    assert_eq!(
        stream_effect.payload["requestId"],
        json!("req-stream-servertool-effect-1")
    );
    let servertool_effect = output
        .effect_plan
        .effects
        .iter()
        .find(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
                && effect.payload["action"] == json!("requireResponseHookRuntime")
        })
        .unwrap();
    assert_eq!(
        servertool_effect.payload["reason"],
        json!("stop_eligible_followup")
    );
    assert_eq!(
        servertool_effect.payload["requestId"],
        json!("req-stream-servertool-effect-1")
    );
}

#[test]
fn anthropic_sse_end_turn_stream_stop_returns_servertool_effect() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let body_text = [
        "event: message_start\n",
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse_stopless\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"MiniMax-M3\",\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n",
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Jason，继续执行。{\\\"stopreason\\\":2,\\\"reason\\\":\\\"未完成\\\",\\\"has_evidence\\\":0,\\\"next_step\\\":\\\"运行 smoke\\\"}\"}}\n\n",
        "event: content_block_stop\n",
        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":3,\"output_tokens\":12}}\n\n",
        "event: message_stop\n",
        "data: {\"type\":\"message_stop\"}\n\n",
    ]
    .join("");
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-anthropic-sse-stream-stopless".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "anthropic-messages".to_string(),
            payload: json!({
                "mode": "sse",
                "bodyText": body_text
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses",
                "stream": true,
                "runtimeEffects": { "clientInjectDispatch": true }
            }),
            metadata_center_snapshot: json!(null),
            stream: true,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let servertool_effect = output
        .effect_plan
        .effects
        .iter()
        .find(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
                && effect.payload["reason"] == json!("stop_eligible_followup")
        })
        .expect("Anthropic SSE end_turn must enter stopless runtime action");
    assert_eq!(
        servertool_effect.payload["payload"]["choices"][0]["finish_reason"],
        json!("stop")
    );
    assert_eq!(
        servertool_effect.payload["stopGateway"]["reason"],
        json!("finish_reason_stop")
    );
    assert!(
        servertool_effect.payload["payload"]["choices"][0]["message"]["content"]
            .as_str()
            .unwrap()
            .contains("\"stopreason\":2")
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
            metadata_center_snapshot: json!(null),
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
    assert_eq!(
        effect.payload["action"],
        json!("requireResponseHookRuntime")
    );
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
            metadata_center_snapshot: json!(null),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    assert!(!output.effect_plan.effects.iter().any(|effect| {
        serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
    }));
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
            metadata_center_snapshot: json!(null),
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

#[test]
fn responses_reasoning_stop_tool_call_emits_only_stop_runtime_action() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-responses-reasoning-stop-runtime-action".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "id": "chatcmpl_responses_reasoning_stop_effect",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_reasoning_stop_1",
                            "type": "function",
                            "function": {
                                "name": "reasoningStop",
                                "arguments": "{\"reason\":\"missing schema\",\"stopreason\":2}"
                            }
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
            metadata_center_snapshot: json!(null),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let servertool_effects: Vec<_> = output
        .effect_plan
        .effects
        .iter()
        .filter(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
        })
        .collect();
    assert_eq!(servertool_effects.len(), 1);
    assert_eq!(
        servertool_effects[0].payload["reason"],
        json!("stop_eligible_followup")
    );
}

#[test]
fn responses_reasoning_stop_tool_call_survives_requested_client_tool_filter() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-responses-reasoning-stop-requested-exec-only".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "__rcc_tool_governance": {
                    "requestedToolNames": ["exec_command"]
                },
                "id": "chatcmpl_responses_reasoning_stop_requested_exec_only",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "我直接调用 stop hook 收尾。",
                        "tool_calls": [{
                            "id": "call_reasoning_stop_requested_exec_only",
                            "type": "function",
                            "function": {
                                "name": "reasoningStop",
                                "arguments": "{\"stopreason\":0,\"reason\":\"已完成\",\"has_evidence\":1,\"evidence\":\"verified\",\"issue_cause\":\"none\",\"excluded_factors\":\"none\",\"diagnostic_order\":\"1. inspect 2. verify\",\"done_steps\":\"confirmed response path\",\"next_step\":\"无\",\"next_suggested_path\":\"无\",\"needs_user_input\":false,\"learned\":\"reasoningStop must survive requested-tool filtering\"}"
                            }
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
            metadata_center_snapshot: json!(null),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let servertool_effects: Vec<_> = output
        .effect_plan
        .effects
        .iter()
        .filter(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
        })
        .collect();
    assert_eq!(servertool_effects.len(), 1);
    assert_eq!(
        servertool_effects[0].payload["reason"],
        json!("stop_eligible_followup")
    );
}

#[test]
fn responses_openai_chat_reasoning_stop_terminal_schema_projects_normal_stop() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-responses-reasoning-stop-terminal-schema".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "id": "chatcmpl_responses_reasoning_stop_terminal_schema",
                "object": "chat.completion",
                "model": "glm-5.2",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_reasoning_stop_terminal_schema",
                            "type": "function",
                            "function": {
                                "name": "reasoningStop",
                                "arguments": "{\"stopreason\":0,\"reason\":\"已完成真实 provider terminal schema 验证\",\"has_evidence\":1,\"evidence\":\"provider returned terminal schema\",\"issue_cause\":\"none\",\"excluded_factors\":\"none\",\"diagnostic_order\":\"provider response -> chat process -> responses outbound\",\"done_steps\":\"verified terminal schema path\",\"next_step\":\"\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"terminal schema must become normal stop before Responses outbound\"}"
                            }
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
            metadata_center_snapshot: json!(null),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let payload = output.payload.expect("responses payload");
    assert_eq!(payload["object"], json!("response"));
    assert_eq!(payload["status"], json!("completed"));
    assert!(
        payload["output"]
            .as_array()
            .map(|items| !items.is_empty())
            .unwrap_or(false),
        "terminal reasoningStop must not project to empty Responses output: {}",
        payload
    );
    let payload_json = payload.to_string();
    assert!(payload_json.contains("已完成真实 provider terminal schema 验证"));
    assert!(!payload_json.contains("reasoningStop"));
    assert!(!payload_json.contains("tool_calls"));
    assert!(!payload_json.contains("submit_tool_outputs"));
}

#[test]
fn responses_anthropic_reasoning_stop_terminal_schema_uses_same_chatprocess_mapping() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-responses-anthropic-reasoning-stop-terminal-schema".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "anthropic-messages".to_string(),
            payload: json!({
                "id": "msg_responses_anthropic_reasoning_stop_terminal_schema",
                "type": "message",
                "role": "assistant",
                "model": "MiniMax-M3",
                "content": [{
                    "type": "tool_use",
                    "id": "call_anthropic_reasoning_stop_terminal_schema",
                    "name": "reasoningStop",
                    "input": {
                        "stopreason": 0,
                        "reason": "已完成 Anthropic provider terminal schema 验证",
                        "has_evidence": 1,
                        "evidence": "provider returned Anthropic terminal schema",
                        "issue_cause": "none",
                        "excluded_factors": "none",
                        "diagnostic_order": "provider response -> canonical chat inbound -> chat process -> responses outbound",
                        "done_steps": "verified shared terminal schema path",
                        "next_step": "",
                        "next_suggested_path": "",
                        "needs_user_input": false,
                        "learned": "Anthropic and OpenAI stop tool responses must share chat-process mapping"
                    }
                }],
                "stop_reason": "tool_use"
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses",
                "runtimeEffects": { "providerInvoker": true }
            }),
            metadata_center_snapshot: json!(null),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let payload = output.payload.expect("responses payload");
    assert_eq!(payload["object"], json!("response"));
    assert_eq!(payload["status"], json!("completed"));
    assert!(
        payload["output"]
            .as_array()
            .map(|items| !items.is_empty())
            .unwrap_or(false),
        "Anthropic terminal reasoningStop must share OpenAI Chat stop projection: {}",
        payload
    );
    let payload_json = payload.to_string();
    assert!(payload_json.contains("已完成 Anthropic provider terminal schema 验证"));
    assert!(!payload_json.contains("reasoningStop"));
    assert!(!payload_json.contains("tool_use"));
    assert!(!payload_json.contains("submit_tool_outputs"));
}

#[test]
fn responses_reasoning_stop_tool_call_emits_stop_runtime_action_without_runtime_callbacks() {
    let mut engine = HubPipelineEngine::new(HubPipelineConfig::default()).unwrap();
    let output = engine
        .execute(HubPipelineRequest {
            request_id: "req-responses-reasoning-stop-no-runtime-callbacks".to_string(),
            endpoint: "/v1/responses".to_string(),
            entry_endpoint: "/v1/responses".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "id": "chatcmpl_responses_reasoning_stop_no_runtime_callbacks",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_reasoning_stop_2",
                            "type": "function",
                            "function": {
                                "name": "reasoningStop",
                                "arguments": "{\"reason\":\"missing schema\",\"stopreason\":2}"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            metadata: json!({
                "clientProtocol": "openai-responses",
                "entryEndpoint": "/v1/responses",
                "runtimeEffects": {
                    "providerInvoker": false,
                    "reenterPipeline": false,
                    "clientInjectDispatch": false
                }
            }),
            metadata_center_snapshot: json!(null),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "response".to_string(),
            stage: "outbound".to_string(),
        })
        .unwrap();

    let servertool_effects: Vec<_> = output
        .effect_plan
        .effects
        .iter()
        .filter(|effect| {
            serde_json::to_value(&effect.kind).unwrap() == json!("servertoolRuntimeAction")
        })
        .collect();
    assert_eq!(servertool_effects.len(), 1);
    assert_eq!(
        servertool_effects[0].payload["reason"],
        json!("stop_eligible_followup")
    );
}
