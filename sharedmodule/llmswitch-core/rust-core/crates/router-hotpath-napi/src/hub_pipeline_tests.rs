use super::*;
use crate::hub_pipeline_blocks::adapter_context::*;
use crate::hub_pipeline_blocks::metadata::*;
use crate::hub_pipeline_blocks::nodes::*;
use crate::hub_pipeline_blocks::passthrough::*;
use crate::hub_pipeline_blocks::policy::*;
use crate::hub_pipeline_blocks::process_mode::*;
use crate::hub_pipeline_blocks::protocol::*;
use crate::hub_pipeline_blocks::responses_context::*;
use crate::hub_pipeline_blocks::responses_resume::*;
use crate::hub_pipeline_blocks::router_metadata_input::*;
use crate::hub_pipeline_blocks::runtime_metadata::*;
use crate::hub_pipeline_blocks::standardized_request::*;
use crate::hub_pipeline_blocks::web_search::*;
use serde_json::{json, Value};

#[test]
fn test_empty_input_error() {
    let result = run_hub_pipeline_json("".to_string());
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Input JSON is empty"));
}

#[test]
fn test_invalid_json_error() {
    let result = run_hub_pipeline_json("not valid json".to_string());
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Failed to parse input JSON"));
}

#[test]
fn test_basic_pipeline_success() {
    let input = HubPipelineInput {
        request_id: "req_123".to_string(),
        endpoint: "/v1/chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        provider_protocol: "openai-chat".to_string(),
        payload: json!({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]}),
        metadata: json!({"source": "test"}),
        stream: false,
        process_mode: "chat".to_string(),
        direction: "request".to_string(),
        stage: "inbound".to_string(),
    };

    let result = run_hub_pipeline(input).unwrap();
    assert!(result.success);
    assert_eq!(result.request_id, "req_123");
    assert!(result.payload.is_some());
    assert!(result.metadata.is_some());
}

#[test]
fn test_run_hub_pipeline_sets_orchestration_metadata_fields() {
    let input = HubPipelineInput {
        request_id: "req_orchestration".to_string(),
        endpoint: "v1/chat/completions".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        provider_protocol: "chat".to_string(),
        payload: json!({
            "model": "gpt-4",
            "messages": [{
                "role": "user",
                "content": "<**sticky:tabglm.key1.glm-5:passthrough**>"
            }],
            "stream": true
        }),
        metadata: json!({
            "routeHint": "  tools  "
        }),
        stream: false,
        process_mode: "chat".to_string(),
        direction: "request".to_string(),
        stage: "inbound".to_string(),
    };

    let result = run_hub_pipeline(input).expect("hub pipeline");
    let metadata = result
        .metadata
        .and_then(|v| v.as_object().cloned())
        .expect("metadata object");

    assert_eq!(
        metadata.get("entryEndpoint").and_then(|v| v.as_str()),
        Some("/v1/chat/completions")
    );
    assert_eq!(
        metadata.get("providerProtocol").and_then(|v| v.as_str()),
        Some("openai-chat")
    );
    assert_eq!(
        metadata.get("processMode").and_then(|v| v.as_str()),
        Some("passthrough")
    );
    assert_eq!(
        metadata.get("direction").and_then(|v| v.as_str()),
        Some("request")
    );
    assert_eq!(
        metadata.get("stage").and_then(|v| v.as_str()),
        Some("inbound")
    );
    assert_eq!(metadata.get("stream").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        metadata.get("routeHint").and_then(|v| v.as_str()),
        Some("tools")
    );
}

#[test]
fn test_run_hub_pipeline_extracts_apply_patch_mode_from_tools() {
    let input = HubPipelineInput {
        request_id: "req_apply_patch".to_string(),
        endpoint: "/v1/chat/completions".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        provider_protocol: "openai-chat".to_string(),
        payload: json!({
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "apply_patch",
                    "format": "schema"
                }
            }]
        }),
        metadata: json!({}),
        stream: false,
        process_mode: "chat".to_string(),
        direction: "request".to_string(),
        stage: "inbound".to_string(),
    };
    let result = run_hub_pipeline(input).expect("hub pipeline");
    let metadata = result.metadata.expect("metadata value");
    assert!(metadata
        .get("runtime")
        .and_then(|v| v.get("applyPatchToolMode"))
        .is_none());
}

#[test]
fn test_run_hub_pipeline_does_not_extract_hashline_mode_when_filepath_declared() {
    let input = HubPipelineInput {
        request_id: "req_apply_patch_hashline".to_string(),
        endpoint: "/v1/chat/completions".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        provider_protocol: "openai-chat".to_string(),
        payload: json!({
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "apply_patch",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "patch": {"type": "string"},
                            "filePath": {"type": "string"}
                        }
                    }
                }
            }]
        }),
        metadata: json!({}),
        stream: false,
        process_mode: "chat".to_string(),
        direction: "request".to_string(),
        stage: "inbound".to_string(),
    };
    let result = run_hub_pipeline(input).expect("hub pipeline");
    let metadata = result.metadata.expect("metadata value");
    assert!(metadata
        .get("runtime")
        .and_then(|v| v.get("applyPatchToolMode"))
        .is_none());
}

#[test]
fn test_run_hub_pipeline_merges_stop_message_tmux_aliases() {
    let input = HubPipelineInput {
        request_id: "req_stop_msg".to_string(),
        endpoint: "/v1/chat/completions".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        provider_protocol: "openai-chat".to_string(),
        payload: json!({
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "hello"}]
        }),
        metadata: json!({
            "client_tmux_session_id": "tmux-session-123"
        }),
        stream: false,
        process_mode: "chat".to_string(),
        direction: "request".to_string(),
        stage: "inbound".to_string(),
    };
    let result = run_hub_pipeline(input).expect("hub pipeline");
    let metadata = result.metadata.expect("metadata value");
    assert_eq!(
        metadata.get("clientTmuxSessionId").and_then(|v| v.as_str()),
        Some("tmux-session-123")
    );
    assert_eq!(
        metadata.get("tmuxSessionId").and_then(|v| v.as_str()),
        Some("tmux-session-123")
    );
}

#[test]
fn test_protocol_resolution_aliases() {
    let test_cases = vec![
        ("openai", "openai-chat"),
        ("chat", "openai-chat"),
        ("responses", "openai-responses"),
        ("anthropic", "anthropic-messages"),
        ("gemini", "gemini-chat"),
    ];

    for (input, expected) in test_cases {
        let result = resolve_provider_protocol(input).unwrap();
        assert_eq!(
            result, expected,
            "Protocol alias {} should resolve to {}",
            input, expected
        );
    }
}

#[test]
fn test_invalid_protocol_error() {
    let result = resolve_provider_protocol("invalid-protocol");
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Unsupported"));
}

#[test]
fn test_resolve_hub_client_protocol() {
    assert_eq!(
        resolve_hub_client_protocol("/v1/responses"),
        "openai-responses"
    );
    assert_eq!(
        resolve_hub_client_protocol("/v1/messages"),
        "anthropic-messages"
    );
    assert_eq!(
        resolve_hub_client_protocol("/v1/chat/completions"),
        "openai-chat"
    );
}

#[test]
fn test_extract_model_hint_from_metadata_prefers_top_level_model() {
    let metadata = json!({
        "model": "  gpt-4.1  ",
        "provider": {
            "model": "provider-model"
        }
    });
    let output = extract_model_hint_from_metadata(&metadata);
    assert_eq!(output.as_deref(), Some("gpt-4.1"));
}

#[test]
fn test_extract_model_hint_from_metadata_falls_back_to_provider_keys() {
    let metadata = json!({
        "provider": {
            "modelId": "  claude-3-7-sonnet  "
        }
    });
    let output = extract_model_hint_from_metadata(&metadata);
    assert_eq!(output.as_deref(), Some("claude-3-7-sonnet"));
}

#[test]
fn test_extract_model_hint_from_metadata_ignores_blank_values() {
    let metadata = json!({
        "model": "   ",
        "provider": {
            "defaultModel": "   "
        }
    });
    let output = extract_model_hint_from_metadata(&metadata);
    assert!(output.is_none());
}

#[test]
fn test_resolve_sse_protocol_prefers_explicit_metadata() {
    let metadata = json!({
        "sseProtocol": "anthropic"
    });
    let output = resolve_sse_protocol(&metadata, "openai-responses");
    assert_eq!(output, "anthropic-messages");
}

#[test]
fn test_resolve_sse_protocol_uses_provider_protocol() {
    let metadata = json!({});
    let output = resolve_sse_protocol(&metadata, "openai-responses");
    assert_eq!(output, "openai-responses");
}

#[test]
fn test_resolve_outbound_stream_intent() {
    assert_eq!(resolve_outbound_stream_intent(&json!("always")), Some(true));
    assert_eq!(resolve_outbound_stream_intent(&json!("never")), Some(false));
    assert_eq!(resolve_outbound_stream_intent(&json!("auto")), None);
}

#[test]
fn test_apply_outbound_stream_preference_sets_and_unsets_stream_fields() {
    let request = json!({
        "parameters": { "temperature": 0.2 },
        "metadata": { "x": 1 }
    });
    let with_stream = apply_outbound_stream_preference(&request, Some(true), Some("chat"));
    assert_eq!(
        with_stream
            .get("parameters")
            .and_then(|v| v.get("stream"))
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        with_stream
            .get("metadata")
            .and_then(|v| v.get("outboundStream"))
            .and_then(|v| v.as_bool()),
        Some(true)
    );

    let unset_stream = apply_outbound_stream_preference(&with_stream, None, Some("chat"));
    assert!(unset_stream
        .get("parameters")
        .and_then(|v| v.get("stream"))
        .is_none());
    assert!(unset_stream
        .get("metadata")
        .and_then(|v| v.get("outboundStream"))
        .is_none());
}

#[test]
fn test_apply_outbound_stream_preference_passthrough_keeps_request_when_stream_undefined() {
    let request = json!({
        "parameters": { "temperature": 0.2 },
        "metadata": { "x": 1 }
    });
    let output = apply_outbound_stream_preference(&request, None, Some("passthrough"));
    assert_eq!(output, request);
}

#[test]
fn test_null_payload_error() {
    let result = run_req_inbound_pipeline(Value::Null, "openai-chat", "/v1/chat");
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("cannot be null"));
}

#[test]
fn test_empty_messages_error() {
    let envelope = ChatEnvelope {
        messages: vec![],
        semantics: None,
        metadata: None,
    };
    let routing = RoutingDecision {
        provider_key: "openai.default".to_string(),
        target_endpoint: "/v1/chat".to_string(),
        metadata: None,
    };

    let result = run_req_process_pipeline(envelope, routing);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("at least one message"));
}

#[test]
fn test_req_inbound_pipeline_success() {
    let payload = json!({"model": "gpt-4"});
    let result = run_req_inbound_pipeline(payload, "openai-chat", "/v1/chat").unwrap();
    assert_eq!(result.protocol, "openai-chat");
    assert!(result.metadata.is_some());
}

#[test]
fn test_req_process_pipeline_success() {
    let envelope = ChatEnvelope {
        messages: vec![json!({"role": "user", "content": "hello"})],
        semantics: Some(json!({})),
        metadata: Some(json!({"test": true})),
    };
    let routing = RoutingDecision {
        provider_key: "openai.default".to_string(),
        target_endpoint: "/v1/chat".to_string(),
        metadata: Some(json!({"region": "us"})),
    };

    let result = run_req_process_pipeline(envelope, routing).unwrap();
    assert!(result.request.get("messages").is_some());
    assert_eq!(result.routing.provider_key, "openai.default");
}

#[test]
fn test_resp_outbound_pipeline_success() {
    let payload = json!({"choices": [{"message": {"role": "assistant", "content": "Hello"}}]});
    let result = run_resp_outbound_pipeline(payload, "openai-chat").unwrap();
    assert_eq!(result.protocol, "openai-chat");
    assert!(result.payload.get("choices").is_some());
}

#[test]
fn test_normalize_endpoint() {
    assert_eq!(normalize_endpoint(""), "/v1/chat/completions");
    assert_eq!(normalize_endpoint("/v1/chat"), "/v1/chat");
    assert_eq!(normalize_endpoint("v1/chat"), "/v1/chat");
}

#[test]
fn test_json_roundtrip() {
    let input_json = json!({
        "requestId": "req_456",
        "endpoint": "/v1/chat",
        "entryEndpoint": "/v1/chat",
        "providerProtocol": "anthropic-messages",
        "payload": {"model": "claude-3", "messages": []},
        "metadata": {"test": true},
        "stream": true,
        "processMode": "chat",
        "direction": "request",
        "stage": "inbound"
    })
    .to_string();

    let result = run_hub_pipeline_json(input_json).unwrap();
    let output: HubPipelineOutput = serde_json::from_str(&result).unwrap();
    assert!(output.success);
    assert_eq!(output.request_id, "req_456");
}

#[test]
fn test_resolve_stop_message_router_metadata_prefers_client_tmux_and_sets_aliases() {
    let metadata = json!({
        "stopMessageClientInjectSessionScope": "  scope-123  ",
        "stopMessageClientInjectScope": " tmux:abc ",
        "clientTmuxSessionId": " client-tmux-1 ",
        "tmuxSessionId": "fallback-tmux"
    });
    let output = resolve_stop_message_router_metadata(&metadata);
    let row = output.as_object().expect("object output");
    assert_eq!(
        row.get("stopMessageClientInjectSessionScope")
            .and_then(|v| v.as_str()),
        Some("scope-123")
    );
    assert_eq!(
        row.get("stopMessageClientInjectScope")
            .and_then(|v| v.as_str()),
        Some("tmux:abc")
    );
    assert_eq!(
        row.get("clientTmuxSessionId").and_then(|v| v.as_str()),
        Some("client-tmux-1")
    );
    assert_eq!(
        row.get("client_tmux_session_id").and_then(|v| v.as_str()),
        Some("client-tmux-1")
    );
    assert_eq!(
        row.get("tmuxSessionId").and_then(|v| v.as_str()),
        Some("client-tmux-1")
    );
    assert_eq!(
        row.get("tmux_session_id").and_then(|v| v.as_str()),
        Some("client-tmux-1")
    );
}

#[test]
fn test_resolve_stop_message_router_metadata_empty_input_returns_empty_object() {
    let output = resolve_stop_message_router_metadata(&json!(null));
    let row = output.as_object().expect("object output");
    assert!(row.is_empty());
}

#[test]
fn test_resolve_router_metadata_runtime_flags_extracts_values() {
    let metadata = json!({
        "__rt": {
            "disableStickyRoutes": true
        },
        "estimatedInputTokens": 1234
    });
    let output = resolve_router_metadata_runtime_flags(&metadata);
    let row = output.as_object().expect("object output");
    assert_eq!(
        row.get("disableStickyRoutes").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        row.get("estimatedInputTokens").and_then(|v| v.as_f64()),
        Some(1234.0)
    );
}

#[test]
fn test_resolve_router_metadata_runtime_flags_ignores_false_or_non_numeric() {
    let metadata = json!({
        "__rt": {
            "disableStickyRoutes": false
        },
        "estimatedInputTokens": "1234"
    });
    let output = resolve_router_metadata_runtime_flags(&metadata);
    let row = output.as_object().expect("object output");
    assert!(!row.contains_key("disableStickyRoutes"));
    assert!(!row.contains_key("estimatedInputTokens"));
}

#[test]
fn test_build_router_metadata_input_extracts_runtime_flags_and_stop_message_fields() {
    let input = json!({
        "requestId": "req-1",
        "entryEndpoint": "/v1/responses",
        "processMode": "passthrough",
        "stream": true,
        "direction": "request",
        "providerProtocol": "openai-responses",
        "routeHint": "tools",
        "stage": "inbound",
        "responsesResume": { "response_id": "resp_123" },
        "serverToolRequired": true,
        "sessionId": "sess-1",
        "conversationId": "conv-1",
        "includeEstimatedInputTokens": true,
        "metadata": {
            "__rt": { "disableStickyRoutes": true },
            "estimatedInputTokens": 88,
            "stopMessageClientInjectScope": " tmux:abc "
        }
    });
    let output = build_router_metadata_input(&input).expect("router metadata input");
    let row = output.as_object().expect("output object");
    assert_eq!(row.get("requestId").and_then(|v| v.as_str()), Some("req-1"));
    assert_eq!(
        row.get("providerProtocol").and_then(|v| v.as_str()),
        Some("openai-responses")
    );
    assert!(row.get("responsesResume").is_none());
    assert_eq!(
        row.get("continuation")
            .and_then(|v| v.get("resumeFrom"))
            .and_then(|v| v.get("protocol"))
            .and_then(|v| v.as_str()),
        Some("openai-responses")
    );
    assert_eq!(
        row.get("stopMessageClientInjectScope")
            .and_then(|v| v.as_str()),
        Some("tmux:abc")
    );
    assert_eq!(
        row.get("disableStickyRoutes").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        row.get("estimatedInputTokens").and_then(|v| v.as_f64()),
        Some(88.0)
    );
}

#[test]
fn test_build_router_metadata_input_hides_estimated_tokens_when_not_requested() {
    let input = json!({
        "requestId": "req-2",
        "metadata": {
            "__rt": { "disableStickyRoutes": true },
            "estimatedInputTokens": 123
        }
    });
    let output = build_router_metadata_input(&input).expect("router metadata input");
    let row = output.as_object().expect("output object");
    assert_eq!(
        row.get("disableStickyRoutes").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert!(!row.contains_key("estimatedInputTokens"));
}

#[test]
fn test_build_router_metadata_input_preserves_forced_provider_and_disabled_aliases() {
    let input = json!({
        "requestId": "req-3",
        "metadata": {
            "__shadowCompareForcedProviderKey": " ali-coding-plan.key1.kimi-k2.5 ",
            "disabledProviderKeyAliases": [
                " qwen.1 ",
                "",
                null,
                "qwen.2"
            ]
        }
    });
    let output = build_router_metadata_input(&input).expect("router metadata input");
    let row = output.as_object().expect("output object");
    assert_eq!(
        row.get("__shadowCompareForcedProviderKey")
            .and_then(|v| v.as_str()),
        Some("ali-coding-plan.key1.kimi-k2.5")
    );
    assert_eq!(
        row.get("disabledProviderKeyAliases")
            .and_then(|v| v.as_array())
            .map(|items| items
                .iter()
                .filter_map(|entry| entry.as_str())
                .collect::<Vec<_>>()),
        Some(vec!["qwen.1", "qwen.2"])
    );
}

#[test]
fn test_build_router_metadata_input_preserves_routecodex_port_routing_metadata() {
    let input = json!({
        "requestId": "req-4",
        "metadata": {
            "routecodexRoutingPolicyGroup": "gateway_priority_5555",
            "routecodexLocalPort": 5555,
            "routecodexPortMode": "router",
            "routecodexPortBinding": "dbittai-gpt.key1.gpt-5.3-codex",
            "allowedProviders": [
                "dbittai-gpt.key1.gpt-5.3-codex",
                "mini27",
                "",
                null
            ]
        }
    });
    let output = build_router_metadata_input(&input).expect("router metadata input");
    let row = output.as_object().expect("output object");
    assert_eq!(
        row.get("routecodexRoutingPolicyGroup")
            .and_then(|v| v.as_str()),
        Some("gateway_priority_5555")
    );
    assert_eq!(
        row.get("routecodexLocalPort").and_then(|v| v.as_i64()),
        Some(5555)
    );
    assert_eq!(
        row.get("routecodexPortMode").and_then(|v| v.as_str()),
        Some("router")
    );
    assert_eq!(
        row.get("routecodexPortBinding").and_then(|v| v.as_str()),
        Some("dbittai-gpt.key1.gpt-5.3-codex")
    );
    assert_eq!(
        row.get("allowedProviders")
            .and_then(|v| v.as_array())
            .map(|items| items
                .iter()
                .filter_map(|entry| entry.as_str())
                .collect::<Vec<_>>()),
        Some(vec!["dbittai-gpt.key1.gpt-5.3-codex", "mini27"])
    );
}

#[test]
fn test_build_hub_pipeline_result_metadata_applies_shadow_compare() {
    let input = json!({
        "normalized": {
            "metadata": { "existing": true },
            "entryEndpoint": "/v1/responses",
            "stream": true,
            "processMode": "passthrough",
            "routeHint": "tools"
        },
        "outboundProtocol": "anthropic-messages",
        "target": { "providerKey": "tab.key1.glm-5" },
        "outboundStream": false,
        "capturedChatRequest": { "model": "glm-5" },
        "passthroughAudit": { "mode": "passthrough" },
        "shadowCompareBaselineMode": "observe",
        "effectivePolicy": { "mode": "enforce" },
        "shadowBaselineProviderPayload": { "messages": [] }
    });
    let output =
        build_hub_pipeline_result_metadata(&input).expect("hub pipeline result metadata");
    let row = output.as_object().expect("output object");
    assert_eq!(row.get("existing").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        row.get("providerProtocol").and_then(|v| v.as_str()),
        Some("anthropic-messages")
    );
    assert_eq!(
        row.get("providerStream").and_then(|v| v.as_bool()),
        Some(false)
    );
    assert_eq!(
        row.get("passthroughAudit")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.get("mode"))
            .and_then(|v| v.as_str()),
        Some("passthrough")
    );
    assert_eq!(
        row.get("hubShadowCompare")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.get("baselineMode"))
            .and_then(|v| v.as_str()),
        Some("observe")
    );
    assert_eq!(
        row.get("hubShadowCompare")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.get("candidateMode"))
            .and_then(|v| v.as_str()),
        Some("enforce")
    );
}

#[test]
fn test_build_hub_pipeline_result_metadata_defaults_candidate_mode_off() {
    let input = json!({
        "normalized": {
            "metadata": {},
            "entryEndpoint": "/v1/chat/completions",
            "stream": false,
            "processMode": "chat"
        },
        "outboundProtocol": "openai-chat",
        "capturedChatRequest": { "messages": [] },
        "shadowCompareBaselineMode": "bad-mode",
        "effectivePolicy": { "mode": "bad-mode" },
        "shadowBaselineProviderPayload": { "x": 1 }
    });
    let output =
        build_hub_pipeline_result_metadata(&input).expect("hub pipeline result metadata");
    let row = output.as_object().expect("output object");
    assert_eq!(
        row.get("hubShadowCompare")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.get("baselineMode"))
            .and_then(|v| v.as_str()),
        Some("off")
    );
    assert_eq!(
        row.get("hubShadowCompare")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.get("candidateMode"))
            .and_then(|v| v.as_str()),
        Some("off")
    );
}

#[test]
fn test_build_req_outbound_node_result_builds_expected_shape() {
    let input = json!({
        "outboundStart": 1000,
        "outboundEnd": 1255,
        "messages": 7,
        "tools": 2
    });
    let output = build_req_outbound_node_result(&input).expect("req outbound node result");
    let row = output.as_object().expect("output object");
    assert_eq!(row.get("id").and_then(|v| v.as_str()), Some("req_outbound"));
    assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(true));
    let metadata = row
        .get("metadata")
        .and_then(|v| v.as_object())
        .expect("metadata object");
    assert_eq!(
        metadata.get("node").and_then(|v| v.as_str()),
        Some("req_outbound")
    );
    assert_eq!(
        metadata.get("executionTime").and_then(|v| v.as_i64()),
        Some(255)
    );
    assert_eq!(
        metadata.get("startTime").and_then(|v| v.as_i64()),
        Some(1000)
    );
    assert_eq!(metadata.get("endTime").and_then(|v| v.as_i64()), Some(1255));
    assert_eq!(
        metadata
            .get("dataProcessed")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.get("messages"))
            .and_then(|v| v.as_i64()),
        Some(7)
    );
    assert_eq!(
        metadata
            .get("dataProcessed")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.get("tools"))
            .and_then(|v| v.as_i64()),
        Some(2)
    );
}

#[test]
fn test_build_req_outbound_node_result_defaults_counts_to_zero() {
    let input = json!({
        "outboundStart": 10,
        "outboundEnd": 12
    });
    let output = build_req_outbound_node_result(&input).expect("req outbound node result");
    let metadata = output
        .as_object()
        .and_then(|v| v.get("metadata"))
        .and_then(|v| v.as_object())
        .expect("metadata object");
    assert_eq!(
        metadata
            .get("dataProcessed")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.get("messages"))
            .and_then(|v| v.as_i64()),
        Some(0)
    );
    assert_eq!(
        metadata
            .get("dataProcessed")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.get("tools"))
            .and_then(|v| v.as_i64()),
        Some(0)
    );
}

#[test]
fn test_build_req_inbound_node_result_builds_expected_shape() {
    let input = json!({
        "inboundStart": 100,
        "inboundEnd": 180,
        "messages": 3,
        "tools": 1
    });
    let output = build_req_inbound_node_result(&input).expect("req inbound node result");
    let row = output.as_object().expect("output object");
    assert_eq!(row.get("id").and_then(|v| v.as_str()), Some("req_inbound"));
    assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        row.get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("executionTime"))
            .and_then(|v| v.as_i64()),
        Some(80)
    );
    assert_eq!(
        row.get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("dataProcessed"))
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("messages"))
            .and_then(|v| v.as_i64()),
        Some(3)
    );
    assert_eq!(
        row.get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("dataProcessed"))
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("tools"))
            .and_then(|v| v.as_i64()),
        Some(1)
    );
}

#[test]
fn test_build_req_inbound_skipped_node_defaults_reason() {
    let input = json!({});
    let output = build_req_inbound_skipped_node(&input).expect("req inbound skipped node");
    let row = output.as_object().expect("output object");
    assert_eq!(row.get("id").and_then(|v| v.as_str()), Some("req_inbound"));
    assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        row.get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("skipped"))
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        row.get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("reason"))
            .and_then(|v| v.as_str()),
        Some("stage=outbound")
    );
    assert_eq!(
        row.get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("dataProcessed"))
            .and_then(|v| v.as_object())
            .map(|v| v.len()),
        Some(0)
    );
}

#[test]
fn test_build_captured_chat_request_snapshot_preserves_shape() {
    let input = json!({
        "model": "glm-5",
        "messages": [{ "role": "user", "content": "hi" }],
        "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }],
        "tools": [{ "type": "function", "function": { "name": "x" } }],
        "tool_choice": { "type": "function", "function": { "name": "x" } },
        "semantics": {
            "continuation": {
                "chainId": "req_chain_snapshot_1",
                "toolContinuation": {
                    "mode": "submit_tool_outputs",
                    "submittedToolCallIds": ["call_snapshot_1"]
                }
            }
        },
        "parameters": { "temperature": 0.2 }
    });
    let output =
        build_captured_chat_request_snapshot(&input).expect("captured chat request snapshot");
    let row = output.as_object().expect("output object");
    assert_eq!(row.get("model").and_then(|v| v.as_str()), Some("glm-5"));
    assert_eq!(
        row.get("messages")
            .and_then(|v| v.as_array())
            .map(|v| v.len()),
        Some(1)
    );
    assert_eq!(
        row.get("input").and_then(|v| v.as_array()).map(|v| v.len()),
        Some(1)
    );
    assert_eq!(
        row.get("tools").and_then(|v| v.as_array()).map(|v| v.len()),
        Some(1)
    );
    assert_eq!(
        row.get("tool_choice")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("type"))
            .and_then(|v| v.as_str()),
        Some("function")
    );
    assert_eq!(
        row.get("semantics")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("continuation"))
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("chainId"))
            .and_then(|v| v.as_str()),
        Some("req_chain_snapshot_1")
    );
    assert_eq!(
        row.get("parameters")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("temperature"))
            .and_then(|v| v.as_f64()),
        Some(0.2)
    );
}

#[test]
fn test_build_captured_chat_request_snapshot_fills_nulls_for_missing_optional_fields() {
    let input = json!({
        "model": "glm-5",
        "messages": []
    });
    let output =
        build_captured_chat_request_snapshot(&input).expect("captured chat request snapshot");
    let row = output.as_object().expect("output object");
    assert!(row.get("tools").is_some_and(Value::is_null));
    assert!(row.get("tool_choice").is_some_and(Value::is_null));
    assert!(row.get("semantics").is_some_and(Value::is_null));
    assert!(row.get("parameters").is_some_and(Value::is_null));
}

#[test]
fn test_coerce_standardized_request_from_payload_builds_expected_shape() {
    let input = json!({
        "payload": {
            "model": "  glm-5  ",
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
            "parameters": { "temperature": 0.2 },
            "metadata": { "requestId": "stale-id", "x": 1 },
            "semantics": { "tools": { "existing": true } }
        },
        "normalized": {
            "id": "req-123",
            "entryEndpoint": "/v1/responses",
            "stream": true,
            "processMode": "passthrough",
            "routeHint": "tools"
        }
    });
    let output = coerce_standardized_request_from_payload(&input)
        .expect("coerce standardized request output");
    let row = output.as_object().expect("output object");
    let standardized = row
        .get("standardizedRequest")
        .and_then(|v| v.as_object())
        .expect("standardizedRequest object");
    let raw_payload = row
        .get("rawPayload")
        .and_then(|v| v.as_object())
        .expect("rawPayload object");

    assert_eq!(
        standardized.get("model").and_then(|v| v.as_str()),
        Some("glm-5")
    );
    assert_eq!(
        standardized
            .get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("requestId"))
            .and_then(|v| v.as_str()),
        Some("req-123")
    );
    assert_eq!(
        standardized
            .get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("originalEndpoint"))
            .and_then(|v| v.as_str()),
        Some("/v1/responses")
    );
    assert_eq!(
        standardized
            .get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("routeHint"))
            .and_then(|v| v.as_str()),
        Some("tools")
    );
    assert_eq!(
        standardized
            .get("semantics")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("tools"))
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("existing"))
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        standardized
            .get("semantics")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("tools"))
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("clientToolsRaw"))
            .and_then(|v| v.as_array())
            .map(|v| v.len()),
        Some(1)
    );
    assert_eq!(
        raw_payload
            .get("parameters")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("temperature"))
            .and_then(|v| v.as_f64()),
        Some(0.2)
    );
}

#[test]
fn test_coerce_standardized_request_from_payload_defaults_semantics_tools_and_raw_parameters() {
    let input = json!({
        "payload": {
            "model": "glm-5",
            "messages": [],
            "parameters": [],
            "semantics": { "tools": "invalid" }
        },
        "normalized": {
            "id": "req-2",
            "entryEndpoint": "/v1/chat/completions",
            "stream": false,
            "processMode": "chat"
        }
    });
    let output = coerce_standardized_request_from_payload(&input)
        .expect("coerce standardized request output");
    let row = output.as_object().expect("output object");
    let standardized = row
        .get("standardizedRequest")
        .and_then(|v| v.as_object())
        .expect("standardizedRequest object");
    let raw_payload = row
        .get("rawPayload")
        .and_then(|v| v.as_object())
        .expect("rawPayload object");

    assert_eq!(
        standardized
            .get("parameters")
            .and_then(|v| v.as_object())
            .map(|v| v.len()),
        Some(0)
    );
    assert_eq!(
        standardized
            .get("semantics")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("tools"))
            .and_then(|v| v.as_object())
            .map(|v| v.len()),
        Some(0)
    );
    assert!(!raw_payload.contains_key("parameters"));
}

#[test]
fn test_coerce_standardized_request_from_payload_accepts_responses_input_shape() {
    let input = json!({
        "payload": {
            "model": "deepseek-v4-pro",
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "继续执行" }
                    ]
                }
            ],
            "tools": [
                { "type": "function", "function": { "name": "exec_command" } }
            ],
            "parameters": {}
        },
        "normalized": {
            "id": "req-responses-input",
            "entryEndpoint": "/v1/responses",
            "stream": false,
            "processMode": "chat",
            "routeHint": "coding"
        }
    });

    let output = coerce_standardized_request_from_payload(&input)
        .expect("coerce standardized request output");
    let row = output.as_object().expect("output object");
    let standardized = row
        .get("standardizedRequest")
        .and_then(|v| v.as_object())
        .expect("standardizedRequest object");
    let raw_payload = row
        .get("rawPayload")
        .and_then(|v| v.as_object())
        .expect("rawPayload object");

    assert_eq!(
        standardized
            .get("messages")
            .and_then(|v| v.as_array())
            .map(|v| v.len()),
        Some(1)
    );
    assert_eq!(
        standardized
            .get("messages")
            .and_then(|v| v.as_array())
            .and_then(|v| v.first())
            .and_then(|v| v.get("role"))
            .and_then(|v| v.as_str()),
        Some("user")
    );
    assert_eq!(
        raw_payload
            .get("messages")
            .and_then(|v| v.as_array())
            .and_then(|v| v.first())
            .and_then(|v| v.get("content"))
            .and_then(|v| v.as_str()),
        Some("继续执行")
    );
}

#[test]
fn test_coerce_standardized_request_from_payload_normalizes_exec_command_and_apply_patch_shapes(
) {
    let input = json!({
        "payload": {
            "model": "glm-5",
            "messages": [
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_exec",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"args\":{\"command\":\"pwd\"},\"cwd\":\"/repo\"}"
                            }
                        },
                        {
                            "id": "call_patch",
                            "type": "function",
                            "function": {
                                "name": "apply_patch",
                                "arguments": "{\"input\":\"*** Begin Patch\\n*** Add File: note.txt\\n+hello\\n*** End Patch\\n\"}"
                            }
                        }
                    ]
                }
            ],
            "tools": [
                { "type": "function", "function": { "name": "exec_command" } },
                { "type": "function", "function": { "name": "apply_patch" } }
            ],
            "parameters": {}
        },
        "normalized": {
            "id": "req-shape",
            "entryEndpoint": "/v1/chat/completions",
            "stream": false,
            "processMode": "chat"
        }
    });

    let output = coerce_standardized_request_from_payload(&input)
        .expect("coerce standardized request output");
    let row = output.as_object().expect("output object");
    let standardized = row
        .get("standardizedRequest")
        .and_then(|v| v.as_object())
        .expect("standardizedRequest object");
    let messages = standardized
        .get("messages")
        .and_then(|v| v.as_array())
        .expect("messages");
    let tool_calls = messages[0]
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .expect("tool calls");

    let exec_args_text = tool_calls[0]["function"]["arguments"]
        .as_str()
        .expect("exec args");
    let exec_args: Value = serde_json::from_str(exec_args_text).expect("exec args json");
    assert_eq!(exec_args["cmd"], "pwd");
    assert!(exec_args.get("command").is_none());
    assert_eq!(exec_args["workdir"], "/repo");

    let patch_args_text = tool_calls[1]["function"]["arguments"]
        .as_str()
        .expect("patch args");
    let patch_args: Value = serde_json::from_str(patch_args_text).expect("patch args json");
    // Hub coerce only owns envelope standardization. apply_patch call arguments
    // are governed later by req/resp chat-process, not normalized here.
    let patch_input = patch_args["input"].as_str().expect("patch input");
    assert!(patch_input.starts_with("*** Begin Patch"));
    assert!(patch_input.contains("*** Add File: note.txt"));
    assert!(patch_args.get("patch").is_none());
}

#[test]
fn test_prepare_runtime_metadata_for_servertools_injects_runtime_configs() {
    let input = json!({
        "metadata": {
            "requestId": "req-1",
            "__rt": { "existing": true }
        },
        "webSearchConfig": { "enabled": true },
        "execCommandGuard": { "mode": "strict" },
        "clockConfig": { "tickMs": 60000 },
        "applyPatchConfig": { "mode": "servertool" }
    });
    let output = prepare_runtime_metadata_for_servertools(&input)
        .expect("prepare runtime metadata for servertools");
    let row = output.as_object().expect("output object");
    assert_eq!(row.get("requestId").and_then(|v| v.as_str()), Some("req-1"));
    let rt = row
        .get("__rt")
        .and_then(|v| v.as_object())
        .expect("__rt object");
    assert_eq!(rt.get("existing").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        rt.get("webSearch")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("enabled"))
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        rt.get("execCommandGuard")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("mode"))
            .and_then(|v| v.as_str()),
        Some("strict")
    );
    assert_eq!(
        rt.get("clock")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("tickMs"))
            .and_then(|v| v.as_i64()),
        Some(60000)
    );
    assert_eq!(
        rt.get("applyPatch")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("mode"))
            .and_then(|v| v.as_str()),
        Some("servertool")
    );
}

#[test]
fn test_prepare_runtime_metadata_for_servertools_normalizes_missing_or_invalid_rt() {
    let input = json!({
        "metadata": {
            "foo": "bar",
            "__rt": "invalid"
        },
        "webSearchConfig": null,
        "clockConfig": 1
    });
    let output = prepare_runtime_metadata_for_servertools(&input)
        .expect("prepare runtime metadata for servertools");
    let row = output.as_object().expect("output object");
    assert_eq!(row.get("foo").and_then(|v| v.as_str()), Some("bar"));
    let rt = row
        .get("__rt")
        .and_then(|v| v.as_object())
        .expect("__rt object");
    assert!(!rt.contains_key("webSearch"));
    assert!(!rt.contains_key("clock"));
}

#[test]
fn test_apply_has_image_attachment_flag_adds_and_removes_flag() {
    let add_input = json!({
        "metadata": { "requestId": "req-1" },
        "hasImageAttachment": true
    });
    let add_output =
        apply_has_image_attachment_flag(&add_input).expect("apply has-image-attachment flag");
    let add_row = add_output.as_object().expect("object output");
    assert_eq!(
        add_row.get("hasImageAttachment").and_then(|v| v.as_bool()),
        Some(true)
    );

    let remove_input = json!({
        "metadata": {
            "requestId": "req-1",
            "hasImageAttachment": true
        },
        "hasImageAttachment": false
    });
    let remove_output = apply_has_image_attachment_flag(&remove_input)
        .expect("apply has-image-attachment flag");
    let remove_row = remove_output.as_object().expect("object output");
    assert!(!remove_row.contains_key("hasImageAttachment"));
    assert_eq!(
        remove_row.get("requestId").and_then(|v| v.as_str()),
        Some("req-1")
    );
}

#[test]
fn test_apply_has_image_attachment_flag_normalizes_invalid_metadata() {
    let input = json!({
        "metadata": "invalid",
        "hasImageAttachment": true
    });
    let output =
        apply_has_image_attachment_flag(&input).expect("apply has-image-attachment flag");
    let row = output.as_object().expect("object output");
    assert_eq!(
        row.get("hasImageAttachment").and_then(|v| v.as_bool()),
        Some(true)
    );
}

#[test]
fn test_sync_session_identifiers_to_metadata_injects_trimmed_values() {
    let input = json!({
        "metadata": { "existing": true },
        "sessionId": "  session-1  ",
        "conversationId": " conv-1 "
    });
    let output = sync_session_identifiers_to_metadata(&input)
        .expect("sync session identifiers to metadata");
    let row = output.as_object().expect("object output");
    assert_eq!(row.get("existing").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        row.get("sessionId").and_then(|v| v.as_str()),
        Some("session-1")
    );
    assert_eq!(
        row.get("conversationId").and_then(|v| v.as_str()),
        Some("conv-1")
    );
}

#[test]
fn test_sync_session_identifiers_to_metadata_ignores_blank_or_missing_values() {
    let input = json!({
        "metadata": {
            "sessionId": "existing-session",
            "conversationId": "existing-conv"
        },
        "sessionId": "   ",
        "conversationId": null
    });
    let output = sync_session_identifiers_to_metadata(&input)
        .expect("sync session identifiers to metadata");
    let row = output.as_object().expect("object output");
    assert_eq!(
        row.get("sessionId").and_then(|v| v.as_str()),
        Some("existing-session")
    );
    assert_eq!(
        row.get("conversationId").and_then(|v| v.as_str()),
        Some("existing-conv")
    );
}

#[test]
fn test_merge_clock_reservation_into_metadata_merges_object_reservation() {
    let input = json!({
        "metadata": { "existing": true },
        "processedRequest": {
            "metadata": {
                "__clockReservation": {
                    "reservationId": "r1",
                    "taskIds": ["a", "b"]
                }
            }
        }
    });
    let output = merge_clock_reservation_into_metadata(&input)
        .expect("merge clock reservation into metadata");
    let row = output.as_object().expect("output object");
    assert_eq!(row.get("existing").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        row.get("__clockReservation")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("reservationId"))
            .and_then(|v| v.as_str()),
        Some("r1")
    );
}

#[test]
fn test_merge_clock_reservation_into_metadata_ignores_non_object_reservation() {
    let input = json!({
        "metadata": { "existing": true },
        "processedRequest": {
            "metadata": {
                "__clockReservation": "invalid"
            }
        }
    });
    let output = merge_clock_reservation_into_metadata(&input)
        .expect("merge clock reservation into metadata");
    let row = output.as_object().expect("output object");
    assert_eq!(row.get("existing").and_then(|v| v.as_bool()), Some(true));
    assert!(!row.contains_key("__clockReservation"));
}

#[test]
fn test_build_tool_governance_node_result_builds_expected_shape() {
    let input = json!({
        "success": true,
        "metadata": {
            "node": "chat_process.req.stage4.tool_governance",
            "foo": "bar"
        },
        "error": {
            "message": "bad request",
            "details": { "x": 1 }
        }
    });
    let output =
        build_tool_governance_node_result(&input).expect("build tool governance node result");
    let row = output.as_object().expect("output object");
    assert_eq!(
        row.get("id").and_then(|v| v.as_str()),
        Some("chat_process.req.stage4.tool_governance")
    );
    assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        row.get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("foo"))
            .and_then(|v| v.as_str()),
        Some("bar")
    );
    assert_eq!(
        row.get("error")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("code"))
            .and_then(|v| v.as_str()),
        Some("hub_chat_process_error")
    );
    assert_eq!(
        row.get("error")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_str()),
        Some("bad request")
    );
    assert_eq!(
        row.get("error")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("details"))
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("x"))
            .and_then(|v| v.as_i64()),
        Some(1)
    );
}

#[test]
fn test_build_tool_governance_node_result_coerces_invalid_metadata_to_object() {
    let input = json!({
        "success": false,
        "metadata": "invalid"
    });
    let output =
        build_tool_governance_node_result(&input).expect("build tool governance node result");
    let row = output.as_object().expect("output object");
    assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(
        row.get("metadata")
            .and_then(|v| v.as_object())
            .map(|v| v.len()),
        Some(0)
    );
    assert!(!row.contains_key("error"));
}

#[test]
fn test_build_passthrough_governance_skipped_node_shape() {
    let output = build_passthrough_governance_skipped_node();
    let row = output.as_object().expect("output object");
    assert_eq!(
        row.get("id").and_then(|v| v.as_str()),
        Some("chat_process.req.stage4.tool_governance")
    );
    assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        row.get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("skipped"))
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        row.get("metadata")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("reason"))
            .and_then(|v| v.as_str()),
        Some("process_mode_passthrough_parse_record_only")
    );
}

#[test]
fn test_extract_adapter_context_metadata_fields_trims_strings_and_keeps_booleans() {
    let metadata = json!({
        "clockDaemonId": "  daemon-1 ",
        "clientInjectReady": true,
        "workdir": "   ",
        "ignored": 123
    });
    let keys = json!([
        "clockDaemonId",
        "clientInjectReady",
        "workdir",
        "missing",
        1
    ]);
    let output = extract_adapter_context_metadata_fields(&metadata, &keys);
    let row = output.as_object().expect("object output");
    assert_eq!(
        row.get("clockDaemonId").and_then(|v| v.as_str()),
        Some("daemon-1")
    );
    assert_eq!(
        row.get("clientInjectReady").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert!(!row.contains_key("workdir"));
    assert!(!row.contains_key("missing"));
}

#[test]
fn test_resolve_adapter_context_metadata_signals_extracts_expected_fields() {
    let metadata = json!({
        "clientRequestId": " req-1 ",
        "groupRequestId": " group-1 ",
        "originalModelId": "",
        "clientModelId": "client-model",
        "assignedModelId": "assigned-model",
        "estimated_tokens": " 12.6 ",
        "sessionId": " sid-1 ",
        "conversationId": " cid-1 ",
        "ignored": true
    });
    let output = resolve_adapter_context_metadata_signals(&metadata);
    let row = output.as_object().expect("object output");
    assert_eq!(
        row.get("clientRequestId").and_then(|v| v.as_str()),
        Some("req-1")
    );
    assert_eq!(
        row.get("groupRequestId").and_then(|v| v.as_str()),
        Some("group-1")
    );
    assert_eq!(
        row.get("originalModelId").and_then(|v| v.as_str()),
        Some("")
    );
    assert_eq!(
        row.get("clientModelId").and_then(|v| v.as_str()),
        Some("client-model")
    );
    assert_eq!(
        row.get("modelId").and_then(|v| v.as_str()),
        Some("assigned-model")
    );
    assert_eq!(
        row.get("estimatedInputTokens").and_then(|v| v.as_f64()),
        Some(13.0)
    );
    assert_eq!(row.get("sessionId").and_then(|v| v.as_str()), Some("sid-1"));
    assert_eq!(
        row.get("conversationId").and_then(|v| v.as_str()),
        Some("cid-1")
    );
    assert!(!row.contains_key("ignored"));
}

#[test]
fn test_resolve_adapter_context_metadata_signals_omits_invalid_entries() {
    let metadata = json!({
        "clientRequestId": "   ",
        "groupRequestId": 123,
        "estimatedInputTokens": 0,
        "sessionId": "\t",
        "conversationId": null,
        "assignedModelId": ["bad"]
    });
    let output = resolve_adapter_context_metadata_signals(&metadata);
    let row = output.as_object().expect("object output");
    assert!(!row.contains_key("clientRequestId"));
    assert!(!row.contains_key("groupRequestId"));
    assert!(!row.contains_key("estimatedInputTokens"));
    assert!(!row.contains_key("sessionId"));
    assert!(!row.contains_key("conversationId"));
    assert!(!row.contains_key("modelId"));
}

#[test]
fn test_resolve_adapter_context_object_carriers_keeps_object_values() {
    let metadata = json!({
        "runtime": {
            "clock": { "enabled": true }
        },
        "capturedChatRequest": {
            "model": "gpt-5",
            "messages": []
        },
        "clientConnectionState": {
            "disconnected": false
        }
    });
    let output = resolve_adapter_context_object_carriers(&metadata);
    let row = output.as_object().expect("object output");
    assert!(row.get("runtime").and_then(|v| v.as_object()).is_some());
    assert!(row
        .get("capturedChatRequest")
        .and_then(|v| v.as_object())
        .is_some());
    assert!(row
        .get("clientConnectionState")
        .and_then(|v| v.as_object())
        .is_some());
    assert_eq!(
        row.get("clientDisconnected").and_then(|v| v.as_bool()),
        Some(false)
    );
}

#[test]
fn test_resolve_adapter_context_object_carriers_omits_non_objects() {
    let metadata = json!({
        "runtime": [],
        "capturedChatRequest": "bad",
        "clientConnectionState": true
    });
    let output = resolve_adapter_context_object_carriers(&metadata);
    let row = output.as_object().expect("object output");
    assert!(!row.contains_key("runtime"));
    assert!(!row.contains_key("capturedChatRequest"));
    assert!(!row.contains_key("clientConnectionState"));
}

#[test]
fn test_resolve_adapter_context_object_carriers_merges_client_disconnected_signal() {
    let metadata = json!({
        "clientConnectionState": {
            "disconnected": false
        },
        "clientDisconnected": " true "
    });
    let output = resolve_adapter_context_object_carriers(&metadata);
    let row = output.as_object().expect("object output");
    assert_eq!(
        row.get("clientDisconnected").and_then(|v| v.as_bool()),
        Some(true)
    );
}

#[test]
fn test_resolve_adapter_context_client_connection_state_prefers_explicit_true() {
    let metadata = json!({
        "clientConnectionState": {
            "disconnected": false
        },
        "clientDisconnected": " true "
    });
    let output = resolve_adapter_context_client_connection_state(&metadata);
    let row = output.as_object().expect("object output");
    assert_eq!(
        row.get("clientDisconnected").and_then(|v| v.as_bool()),
        Some(true)
    );
}

#[test]
fn test_resolve_adapter_context_client_connection_state_reads_state_flag() {
    let metadata = json!({
        "clientConnectionState": {
            "disconnected": false
        }
    });
    let output = resolve_adapter_context_client_connection_state(&metadata);
    let row = output.as_object().expect("object output");
    assert_eq!(
        row.get("clientDisconnected").and_then(|v| v.as_bool()),
        Some(false)
    );
}

#[test]
fn test_resolve_adapter_context_client_connection_state_omits_when_unavailable() {
    let metadata = json!({
        "clientConnectionState": {
            "disconnected": "unknown"
        },
        "clientDisconnected": false
    });
    let output = resolve_adapter_context_client_connection_state(&metadata);
    let row = output.as_object().expect("object output");
    assert!(!row.contains_key("clientDisconnected"));
}

#[test]
fn test_resolve_hub_policy_override_valid() {
    let metadata = json!({
        "__hubPolicyOverride": {
            "mode": " Observe ",
            "sampleRate": 0.5
        }
    });
    let output = resolve_hub_policy_override(&metadata).expect("policy override");
    let row = output.as_object().expect("object output");
    assert_eq!(row.get("mode").and_then(|v| v.as_str()), Some("observe"));
    assert_eq!(row.get("sampleRate").and_then(|v| v.as_f64()), Some(0.5));
}

#[test]
fn test_resolve_hub_policy_override_invalid_mode_returns_none() {
    let metadata = json!({
        "__hubPolicyOverride": {
            "mode": "invalid"
        }
    });
    let output = resolve_hub_policy_override(&metadata);
    assert!(output.is_none());
}

#[test]
fn test_resolve_hub_shadow_compare_mode_fallback() {
    let metadata = json!({
        "__hubShadowCompare": {
            "mode": " enforce "
        }
    });
    let output = resolve_hub_shadow_compare_config(&metadata).expect("shadow compare");
    let row = output.as_object().expect("object output");
    assert_eq!(
        row.get("baselineMode").and_then(|v| v.as_str()),
        Some("enforce")
    );
}

#[test]
fn test_resolve_hub_shadow_compare_invalid_returns_none() {
    let metadata = json!({
        "__hubShadowCompare": {
            "baselineMode": "x"
        }
    });
    let output = resolve_hub_shadow_compare_config(&metadata);
    assert!(output.is_none());
}

#[test]
fn test_is_search_route_id_true_for_web_search_prefix() {
    let route_id = json!(" web_search_tools ");
    assert!(is_search_route_id(&route_id));
}

#[test]
fn test_is_search_route_id_false_for_non_search_route() {
    let route_id = json!("default");
    assert!(!is_search_route_id(&route_id));
}

#[test]
fn test_is_canonical_web_search_tool_definition_true_for_builtin_type() {
    let tool = json!({
        "type": "web_search_20250305",
        "name": "web_search"
    });
    assert!(is_canonical_web_search_tool_definition(&tool));
}

#[test]
fn test_is_canonical_web_search_tool_definition_true_for_function_alias() {
    let tool = json!({
        "type": "function",
        "function": { "name": "web-search" }
    });
    assert!(is_canonical_web_search_tool_definition(&tool));
}

#[test]
fn test_is_canonical_web_search_tool_definition_false_for_non_search_tool() {
    let tool = json!({
        "type": "function",
        "function": { "name": "exec_command" }
    });
    assert!(!is_canonical_web_search_tool_definition(&tool));
}

#[test]
fn test_apply_direct_builtin_web_search_tool_replaces_canonical_entry() {
    let provider_payload = json!({
        "model": "claude-3-7-sonnet",
        "tools": [
            {
                "type": "function",
                "function": { "name": "web_search" }
            },
            {
                "type": "function",
                "function": { "name": "exec_command" }
            }
        ]
    });
    let runtime_metadata = json!({
        "webSearch": {
            "engines": [
                {
                    "executionMode": "direct",
                    "directActivation": "builtin",
                    "modelId": "claude-3-7-sonnet",
                    "maxUses": "3"
                }
            ]
        }
    });
    let output = apply_direct_builtin_web_search_tool(
        &provider_payload,
        "anthropic-messages",
        &json!("web_search.default"),
        &runtime_metadata,
    );
    let tools = output
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    assert_eq!(tools.len(), 2);
    assert_eq!(
        tools
            .first()
            .and_then(|v| v.get("type"))
            .and_then(|v| v.as_str()),
        Some("web_search_20250305")
    );
    assert_eq!(
        tools
            .first()
            .and_then(|v| v.get("max_uses"))
            .and_then(|v| v.as_i64()),
        Some(3)
    );
    assert_eq!(
        tools
            .get(1)
            .and_then(|v| v.get("function"))
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str()),
        Some("exec_command")
    );
}

#[test]
fn test_apply_direct_builtin_web_search_tool_inserts_when_missing() {
    let provider_payload = json!({
        "model": "claude-3-7-sonnet",
        "tools": [
            {
                "type": "function",
                "function": { "name": "exec_command" }
            }
        ]
    });
    let runtime_metadata = json!({
        "webSearch": {
            "engines": [
                {
                    "executionMode": "direct",
                    "directActivation": "builtin",
                    "providerKey": "tabglm.key1.claude-3-7-sonnet"
                }
            ]
        }
    });
    let output = apply_direct_builtin_web_search_tool(
        &provider_payload,
        "anthropic-messages",
        &json!("search.route"),
        &runtime_metadata,
    );
    let tools = output
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    assert_eq!(tools.len(), 2);
    assert_eq!(
        tools
            .first()
            .and_then(|v| v.get("type"))
            .and_then(|v| v.as_str()),
        Some("web_search_20250305")
    );
    assert_eq!(
        tools
            .first()
            .and_then(|v| v.get("max_uses"))
            .and_then(|v| v.as_i64()),
        Some(2)
    );
}

#[test]
fn test_apply_direct_builtin_web_search_tool_noop_for_non_matching_engine() {
    let provider_payload = json!({
        "model": "claude-3-7-sonnet",
        "tools": [
            {
                "type": "web_search"
            },
            {
                "type": "function",
                "function": { "name": "exec_command" }
            }
        ]
    });
    let runtime_metadata = json!({
        "webSearch": {
            "engines": [
                {
                    "executionMode": "proxy",
                    "directActivation": "builtin",
                    "modelId": "claude-3-7-sonnet"
                }
            ]
        }
    });
    let output = apply_direct_builtin_web_search_tool(
        &provider_payload,
        "anthropic-messages",
        &json!("web_search.default"),
        &runtime_metadata,
    );
    assert_eq!(output["tools"], provider_payload["tools"]);
}

#[test]
fn test_apply_direct_builtin_web_search_tool_preserves_tools_for_non_search_route() {
    let provider_payload = json!({
        "model": "deepseek-v4-pro",
        "tools": [
            {
                "type": "web_search"
            },
            {
                "type": "function",
                "function": { "name": "exec_command" }
            }
        ]
    });
    let output = apply_direct_builtin_web_search_tool(
        &provider_payload,
        "openai-responses",
        &json!("thinking.default"),
        &json!({}),
    );
    assert_eq!(output["tools"], provider_payload["tools"]);
}

#[test]
fn test_lift_responses_resume_into_semantics_injects_when_missing_and_clears_metadata() {
    let request = json!({
        "messages": [],
        "semantics": {}
    });
    let metadata = json!({
        "responsesResume": {
            "response_id": "resp_1"
        },
        "other": true
    });
    let output = lift_responses_resume_into_semantics(&request, &metadata);
    assert_eq!(
        output
            .get("request")
            .and_then(|v| v.get("semantics"))
            .and_then(|v| v.get("responses"))
            .and_then(|v| v.get("resume"))
            .and_then(|v| v.get("response_id"))
            .and_then(|v| v.as_str()),
        Some("resp_1")
    );
    assert_eq!(
        output
            .get("metadata")
            .and_then(|v| v.get("responsesResume"))
            .is_some(),
        false
    );
    assert_eq!(
        output
            .get("metadata")
            .and_then(|v| v.get("other"))
            .and_then(|v| v.as_bool()),
        Some(true)
    );
}

#[test]
fn test_lift_responses_resume_into_semantics_preserves_existing_resume() {
    let request = json!({
        "messages": [],
        "semantics": {
            "responses": {
                "resume": {
                    "response_id": "existing"
                }
            }
        }
    });
    let metadata = json!({
        "responsesResume": {
            "response_id": "new"
        }
    });
    let output = lift_responses_resume_into_semantics(&request, &metadata);
    assert_eq!(
        output
            .get("request")
            .and_then(|v| v.get("semantics"))
            .and_then(|v| v.get("responses"))
            .and_then(|v| v.get("resume"))
            .and_then(|v| v.get("response_id"))
            .and_then(|v| v.as_str()),
        Some("existing")
    );
    assert_eq!(
        output
            .get("metadata")
            .and_then(|v| v.get("responsesResume"))
            .is_some(),
        false
    );
}

#[test]
fn test_sync_responses_context_from_canonical_messages_updates_context_fields() {
    let request = json!({
        "messages": [
            { "role": "system", "content": "system keep" },
            { "role": "user", "content": "hello" }
        ],
        "tools": [
            {
                "type": "function",
                "function": { "name": "exec_command", "parameters": { "type": "object" } }
            }
        ],
        "semantics": {
            "responses": {
                "context": {
                    "existing": true
                }
            }
        }
    });
    let output = sync_responses_context_from_canonical_messages(&request).unwrap();
    assert_eq!(
        output
            .get("semantics")
            .and_then(|v| v.get("responses"))
            .and_then(|v| v.get("context"))
            .and_then(|v| v.get("existing"))
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        output
            .get("semantics")
            .and_then(|v| v.get("responses"))
            .and_then(|v| v.get("context"))
            .and_then(|v| v.get("input"))
            .and_then(|v| v.as_array())
            .is_some(),
        true
    );
    assert_eq!(
        output
            .get("semantics")
            .and_then(|v| v.get("responses"))
            .and_then(|v| v.get("context"))
            .and_then(|v| v.get("originalSystemMessages"))
            .and_then(|v| v.as_array())
            .is_some(),
        true
    );
}

#[test]
fn test_sync_responses_context_from_canonical_messages_no_context_noop() {
    let request = json!({
        "messages": [{ "role": "user", "content": "hello" }],
        "semantics": {
            "responses": {}
        }
    });
    let output = sync_responses_context_from_canonical_messages(&request).unwrap();
    assert_eq!(output, request);
}

#[test]
fn test_sync_responses_context_from_canonical_messages_allows_terminal_pending_tool_call() {
    let request = json!({
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_keep_me",
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"pwd\"}"
                        }
                    }
                ]
            }
        ],
        "tools": [
            {
                "type": "function",
                "function": { "name": "exec_command", "parameters": { "type": "object" } }
            }
        ],
        "semantics": {
            "responses": {
                "context": {
                    "existing": true
                }
            }
        }
    });
    let output = sync_responses_context_from_canonical_messages(&request).unwrap();
    let input = output
        .get("semantics")
        .and_then(|v| v.get("responses"))
        .and_then(|v| v.get("context"))
        .and_then(|v| v.get("input"))
        .and_then(|v| v.as_array())
        .expect("responses context input");
    assert_eq!(input.len(), 1);
    assert_eq!(input[0]["type"], "function_call");
    assert_eq!(input[0]["call_id"], "call_keep_me");
}

#[test]
fn test_sync_responses_context_from_canonical_messages_strips_historical_goal_turns() {
    let request = json!({
        "messages": [
            { "role": "user", "content": "继续执行" },
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_goal_old",
                        "type": "function",
                        "function": {
                            "name": "get_goal",
                            "arguments": "{}"
                        }
                    }
                ]
            },
            {
                "role": "tool",
                "tool_call_id": "call_goal_old",
                "name": "get_goal",
                "content": "{\"goal\":{\"status\":\"paused\",\"threadId\":\"t1\"}}"
            },
            { "role": "assistant", "content": "Jason，目标处于 paused 状态。" },
            { "role": "user", "content": "继续执行" }
        ],
        "tools": [
            { "type": "function", "function": { "name": "get_goal", "parameters": { "type": "object" } } },
            { "type": "function", "function": { "name": "exec_command", "parameters": { "type": "object" } } }
        ],
        "semantics": {
            "responses": {
                "context": {
                    "existing": true
                }
            }
        }
    });
    let output = sync_responses_context_from_canonical_messages(&request).unwrap();
    let input = output
        .get("semantics")
        .and_then(|v| v.get("responses"))
        .and_then(|v| v.get("context"))
        .and_then(|v| v.get("input"))
        .and_then(|v| v.as_array())
        .expect("responses context input");
    let serialized = serde_json::to_string(input).expect("serialize input");
    assert!(!serialized.contains("get_goal"));
    assert!(!serialized.contains("call_goal_old"));
    assert!(serialized.contains("继续执行"));
}

#[test]
fn test_read_responses_resume_from_metadata_returns_object() {
    let metadata = json!({
        "responsesResume": {
            "response_id": "resp_123",
            "tool_outputs": [{"tool_call_id": "call_1", "output": "ok"}]
        }
    });
    let output = read_responses_resume_from_metadata(&metadata).expect("resume object");
    assert_eq!(
        output.get("response_id").and_then(|v| v.as_str()),
        Some("resp_123")
    );
}

#[test]
fn test_read_responses_resume_from_metadata_ignores_non_object() {
    let metadata = json!({
        "responsesResume": "resp_123"
    });
    let output = read_responses_resume_from_metadata(&metadata);
    assert!(output.is_none());
}

#[test]
fn test_read_responses_resume_from_request_semantics_returns_object() {
    let request = json!({
        "messages": [],
        "semantics": {
            "responses": {
                "resume": {
                    "response_id": "resp_456"
                }
            }
        }
    });
    let output = read_responses_resume_from_request_semantics(&request).expect("resume object");
    assert_eq!(
        output.get("response_id").and_then(|v| v.as_str()),
        Some("resp_456")
    );
}

#[test]
fn test_read_responses_resume_from_request_semantics_missing_returns_none() {
    let request = json!({
        "messages": [],
        "semantics": {
            "responses": {
                "resume": null
            }
        }
    });
    let output = read_responses_resume_from_request_semantics(&request);
    assert!(output.is_none());
}

#[test]
fn test_resolve_has_instruction_requested_passthrough_true_for_named_target() {
    let messages = json!([
        {
            "role": "user",
            "content": "<**sticky:tabglm.key1.glm-5:passthrough**>"
        }
    ]);
    assert!(resolve_has_instruction_requested_passthrough(&messages));
}

#[test]
fn test_resolve_has_instruction_requested_passthrough_ignores_historical_user_message() {
    let messages = json!([
        {
            "role": "user",
            "content": "<**sticky:tabglm.key1.glm-5:passthrough**>"
        },
        {
            "role": "assistant",
            "content": "ack"
        }
    ]);
    assert!(!resolve_has_instruction_requested_passthrough(&messages));
}

#[test]
fn test_resolve_has_instruction_requested_passthrough_ignores_code_block_marker() {
    let messages = json!([
        {
            "role": "user",
            "content": "```txt\n<**sticky:tabglm.key1.glm-5:passthrough**>\n```"
        }
    ]);
    assert!(!resolve_has_instruction_requested_passthrough(&messages));
}

#[test]
fn test_resolve_active_process_mode_prefers_passthrough_base_mode() {
    let messages = json!([
        {
            "role": "user",
            "content": "normal text"
        }
    ]);
    assert_eq!(
        resolve_active_process_mode("passthrough", &messages),
        "passthrough"
    );
}

#[test]
fn test_resolve_active_process_mode_activates_passthrough_from_instruction() {
    let messages = json!([
        {
            "role": "user",
            "content": "<**sticky:tabglm.key1.glm-5:passthrough**>"
        }
    ]);
    assert_eq!(
        resolve_active_process_mode("chat", &messages),
        "passthrough"
    );
}

#[test]
fn test_find_mappable_semantics_keys_collects_only_present_keys() {
    let metadata = json!({
        "responses_resume": [],
        "extraFields": {"x": 1},
        "safe": true
    });
    let keys = find_mappable_semantics_keys(&metadata);
    assert_eq!(
        keys,
        vec!["responses_resume".to_string(), "extraFields".to_string()]
    );
}

#[test]
fn test_build_passthrough_audit_collects_non_canonical_keys_sorted() {
    let raw = json!({
        "messages": [],
        "model": "m",
        "zeta": true,
        "alpha": 1
    });
    let output = build_passthrough_audit(&raw, "openai-chat");
    let keys = output
        .get("todo")
        .and_then(|v| v.get("inbound"))
        .and_then(|v| v.get("unmappedTopLevelKeys"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    assert_eq!(keys, vec![json!("alpha"), json!("zeta")]);
}

#[test]
fn test_annotate_passthrough_governance_skip_sets_governance_marker() {
    let audit = json!({ "raw": { "inbound": {} } });
    let output = annotate_passthrough_governance_skip(&audit);
    assert_eq!(
        output
            .get("todo")
            .and_then(|v| v.get("governance"))
            .and_then(|v| v.get("skipped"))
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        output
            .get("todo")
            .and_then(|v| v.get("governance"))
            .and_then(|v| v.get("reason"))
            .and_then(|v| v.as_str()),
        Some("process_mode_passthrough")
    );
}

#[test]
fn test_attach_passthrough_provider_input_audit_sets_provider_input_and_outbound_todo() {
    let audit = json!({
        "raw": { "inbound": { "messages": [] } },
        "todo": { "inbound": { "unmappedTopLevelKeys": [] } }
    });
    let provider_payload = json!({
        "messages": [],
        "custom_field": "x"
    });
    let output = attach_passthrough_provider_input_audit(
        &audit,
        &provider_payload,
        "anthropic-messages",
    );
    assert_eq!(
        output
            .get("raw")
            .and_then(|v| v.get("providerInput"))
            .and_then(|v| v.get("custom_field"))
            .and_then(|v| v.as_str()),
        Some("x")
    );
    let outbound_keys = output
        .get("todo")
        .and_then(|v| v.get("outbound"))
        .and_then(|v| v.get("unmappedTopLevelKeys"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    assert_eq!(outbound_keys, vec![json!("custom_field")]);
    assert_eq!(
        output
            .get("todo")
            .and_then(|v| v.get("outbound"))
            .and_then(|v| v.get("providerProtocol"))
            .and_then(|v| v.as_str()),
        Some("anthropic-messages")
    );
}

#[test]
fn test_error_output_structure() {
    let result = run_hub_pipeline_json("not json".to_string());
    assert!(result.is_err());
}

#[test]
fn test_run_hub_pipeline_json_matches_core_shape() {
    let input = HubPipelineInput {
        request_id: "req_equiv_hub".to_string(),
        endpoint: "/v1/responses".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        provider_protocol: "responses".to_string(),
        payload: json!({"model":"gpt-test","input":[{"role":"user","content":"hi"}],"stream":true}),
        metadata: json!({"routeHint":" tools "}),
        stream: false,
        process_mode: "chat".to_string(),
        direction: "request".to_string(),
        stage: "inbound".to_string(),
    };
    let core = serde_json::to_value(run_hub_pipeline(input.clone()).expect("core")).unwrap();
    let json_out: serde_json::Value = serde_json::from_str(
        &run_hub_pipeline_json(serde_json::to_string(&input).unwrap()).expect("json")
    ).unwrap();
    assert_eq!(json_out["requestId"], core["requestId"]);
    assert_eq!(json_out["success"], core["success"]);
    assert_eq!(json_out["payload"], core["payload"]);
    assert_eq!(json_out["metadata"]["entryEndpoint"], core["metadata"]["entryEndpoint"]);
    assert_eq!(json_out["metadata"]["providerProtocol"], core["metadata"]["providerProtocol"]);
    assert_eq!(json_out["metadata"]["routeHint"], core["metadata"]["routeHint"]);
}
