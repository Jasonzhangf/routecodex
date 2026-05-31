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

    assert_eq!(output.get("success").and_then(|value| value.as_bool()), Some(true));
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
