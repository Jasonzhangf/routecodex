use super::*;
use serde_json::json;

fn build_v3_openai_chat_provider_payload_from_responses_payload(
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(payload)
}

#[test]
fn openai_chat_function_tool_redacted_schema_placeholders_remain_valid_json_schema() {
    let payload = json!({
        "model": "glm-5.2",
        "messages": [{"role": "user", "content": "continue the coding task"}],
        "tools": [{
            "type": "function",
            "function": {
                "name": "exec_command",
                "description": "Runs a command.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cmd": {"type": "string"},
                        "max_output_tokens": "[REDACTED]"
                    },
                    "required": ["cmd"],
                    "additionalProperties": false
                },
                "strict": false
            }
        }]
    });

    let provider = build_v3_openai_chat_standard_request_from_chat_canonical(&payload).unwrap();
    assert_eq!(
        provider["tools"][0]["function"]["parameters"]["properties"]["max_output_tokens"],
        json!(true),
        "OpenAI Chat JSON Schema positions may only contain an object or boolean; a client-side redaction placeholder must retain the property as an unconstrained boolean schema"
    );
    assert_eq!(
        provider["tools"][0]["function"]["parameters"]["properties"]["cmd"],
        json!({"type":"string"}),
        "valid sibling tool schema must stay byte-semantic-equivalent"
    );
    assert_eq!(
        provider["tools"][0]["function"]["strict"],
        json!(false),
        "tool strictness must be preserved"
    );
}

#[test]
fn openai_chat_stream_relay_requests_include_usage_when_client_does_not_set_stream_options() {
    let provider = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model": "glm-5.2",
        "input": "report usage",
        "stream": true
    }))
    .unwrap();

    assert_eq!(provider["stream"], json!(true));
    assert_eq!(
        provider["stream_options"],
        json!({"include_usage": true}),
        "OpenAI Chat streaming provider requests must ask upstream for final usage so V3 console usage is not unreported when the upstream supports streaming usage"
    );
}

#[test]
fn openai_chat_stream_relay_requests_preserve_explicit_stream_options() {
    let provider = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model": "glm-5.2",
        "messages": [{"role": "user", "content": "report usage"}],
        "stream": true,
        "stream_options": {"include_usage": false}
    }))
    .unwrap();

    assert_eq!(provider["stream_options"], json!({"include_usage": false}));
}

#[test]
fn openai_chat_provider_wire_does_not_forward_client_metadata() {
    let provider = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model": "glm-5.2",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "continue"}]
        }],
        "stream": true,
        "client_metadata": {
            "session_id": "client-session",
            "x-codex-turn-metadata": "{\"workspaces\":{\"/Volumes/extension/code\":{\"has_changes\":true}}}"
        }
    }))
    .unwrap();

    assert!(
        provider.get("client_metadata").is_none(),
        "OpenAI Chat provider wire must not forward Codex client_metadata: {provider}"
    );
}

#[test]
fn all_adjacent_builders_form_the_fixed_typed_topology() {
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        json!({"messages":[{"role":"user","content":"x"}]}),
        V3HubEntryProtocol::OpenAiChat,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
    let req03 = build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(
        req02,
        V3HubContinuationOwnership::New,
    );
    let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(req03);
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Direct,
    );
    let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
        req05,
        V3HubTargetResolution::Routed,
        routecodex_v3_target::V3TargetCandidate {
            provider_id: "provider".into(),
            provider_type: "openai_chat".into(),
            auth_alias: "primary".into(),
            model_id: "model".into(),
            wire_model: "wire-model".into(),
            model_capabilities: vec!["text".into(), "tools".into()],
            base_url: "http://127.0.0.1:1/v1".into(),
            responses_transport: routecodex_v3_config::V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            compatibility_profile: None,
            env_name: Some("V3_TEST_KEY".into()),
            token_file: None,
            required_capabilities: Vec::new(),
            pool_ids: vec!["test".into()],
            default_pool_member: false,
            path: vec!["provider".into()],
        },
    );
    let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        V3HubProviderWireProtocol::OpenAiChat,
    );
    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();
    let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
    let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);

    let resp01 = build_v3_provider_resp_inbound_01_raw(
        json!({"output":"x"}),
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::Responses,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Direct,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let resp_compat =
        build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01).unwrap();
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(resp_compat);
    let resp03 = build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(resp02);
    let resp04 = build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03(
        resp03,
        V3HubContinuationCommit::None,
    );
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
}

#[test]
fn direct_req_compat_keeps_selected_mode_passthrough() {
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        json!({"messages":[{"role":"user","content":"direct"}],"tools":[{"type":"tool_search","name":"tool_search"}]}),
        V3HubEntryProtocol::OpenAiChat,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
    let req03 = build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(
        req02,
        V3HubContinuationOwnership::New,
    );
    let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(req03);
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Direct,
    );
    let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
        req05,
        V3HubTargetResolution::Routed,
        routecodex_v3_target::V3TargetCandidate {
            provider_id: "provider".into(),
            provider_type: "responses".into(),
            auth_alias: "primary".into(),
            model_id: "model".into(),
            wire_model: "wire-model".into(),
            model_capabilities: vec!["text".into(), "tools".into()],
            base_url: "http://127.0.0.1:1/v1".into(),
            responses_transport: routecodex_v3_config::V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            compatibility_profile: None,
            env_name: Some("V3_TEST_KEY".into()),
            token_file: None,
            required_capabilities: Vec::new(),
            pool_ids: vec!["test".into()],
            default_pool_member: false,
            path: vec!["provider".into()],
        },
    );
    let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        V3HubProviderWireProtocol::Responses,
    );
    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();
    let payload = req_compat.provider_semantic_payload();
    assert!(
        payload
            .get("messages")
            .and_then(serde_json::Value::as_array)
            .is_some(),
        "direct selected mode must keep the selected payload passthrough: {payload}"
    );
    assert!(
        payload.get("input").is_none(),
        "direct selected mode must not run Relay Chat->Responses outbound conversion: {payload}"
    );
    assert_eq!(payload["tools"][0]["type"], "tool_search");
}

#[test]
fn provider_req_compat_loads_selected_target_profile() {
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        json!({
            "model": "MiniMax-M3",
            "input": [{"role": "user", "content": "hi"}]
        }),
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
    let req03 = build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(
        req02,
        V3HubContinuationOwnership::New,
    );
    let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(req03);
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
        req05,
        V3HubTargetResolution::Routed,
        routecodex_v3_target::V3TargetCandidate {
            provider_id: "minimax".into(),
            provider_type: "anthropic".into(),
            auth_alias: "key1".into(),
            model_id: "MiniMax-M3".into(),
            wire_model: "MiniMax-M3".into(),
            model_capabilities: vec!["text".into(), "tools".into()],
            base_url: "http://127.0.0.1:1/v1".into(),
            responses_transport: routecodex_v3_config::V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            compatibility_profile: Some("chat:minimax".into()),
            env_name: Some("V3_TEST_KEY".into()),
            token_file: None,
            required_capabilities: Vec::new(),
            pool_ids: vec!["test".into()],
            default_pool_member: false,
            path: vec!["provider".into()],
        },
    );
    let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        V3HubProviderWireProtocol::Responses,
    );
    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();
    assert_eq!(req_compat.profile().as_str(), "chat:minimax");
    let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
    let req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
    assert_eq!(req09.compat_profile_id(), "chat:minimax");
}

#[test]
fn four_branch_axes_are_independent_values() {
    let facts = (
        V3HubEntryProtocol::Responses,
        V3HubContinuationOwnership::RouteCodexLocalOwned,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
    );
    assert_eq!(facts.0, V3HubEntryProtocol::Responses);
    assert_eq!(facts.1, V3HubContinuationOwnership::RouteCodexLocalOwned);
    assert_eq!(facts.2, V3HubExecutionMode::Relay);
    assert_eq!(facts.3, V3HubProviderWireProtocol::Gemini);
}

#[test]
fn routecodex_control_and_payload_mirror_aliases_are_rejected_recursively() {
    for key in [
        "routecodexInternal",
        "routeHint",
        "metadataCenter",
        "__metadataCenter",
        "runtimeControl",
        "requestTruth",
        "providerRuntime",
        "continuationOwner",
        "routeSelection",
        "retryExclusionSet",
        "selectedTarget",
        "opaqueTarget",
        "resumeMeta",
        "servertoolState",
        "stoplessState",
        "errorChain",
        "nodeTrace",
        "capturedChatRequest",
        "entryOriginRequest",
        "requestSemantics",
        "responsesRequestContext",
        "__raw_request_body",
        "__rt",
        "__rccDryRunSerialized",
        "requestCapabilities",
        "requiredCapabilities",
        "modelCapabilities",
        "selectionPlan",
    ] {
        let payload = json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "keep"
                }],
                key: {"internal": true}
            }]
        });
        assert_eq!(
            find_v3_hub_side_channel_key(&payload),
            Some(key),
            "{key} must fail instead of being stripped or forwarded"
        );
    }
}

#[test]
fn protocol_data_fields_are_not_misclassified_as_routecodex_control() {
    let payload = json!({
        "metadata": {"client": "kept"},
        "client_metadata": {"session_id": "client-owned"},
        "x-codex-client-field": true,
        "tools": [{
            "type": "function",
            "name": "multi_agent_v1.spawn_agent",
            "namespace": "multi_agent_v1"
        }],
        "input": [{
            "type": "custom_tool_call",
            "call_id": "call_client_1",
            "name": "multi_agent_v1.spawn_agent",
            "namespace": "multi_agent_v1"
        }]
    });
    assert_eq!(find_v3_hub_side_channel_key(&payload), None);
}

#[test]
fn openai_chat_request_encoding_skips_replay_safe_reasoning_and_preserves_tool_context() {
    let request = build_v3_openai_chat_provider_payload_from_responses_payload(&json!({
        "model": "client-responses",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect the cwd"}]
            },
            {
                "type": "reasoning",
                "id": "reasoning-1",
                "summary": [{"type": "summary_text", "text": "Need to inspect cwd first."}],
                "encrypted_content": "opaque-reasoning"
            },
            {
                "type": "function_call",
                "id": "fc-1",
                "call_id": "call-1",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"pwd\"}"
            },
            {
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "/tmp"
            }
        ]
    }))
    .expect("replay-safe Responses reasoning must not make OpenAI Chat encoding fail");

    let messages = request["messages"]
        .as_array()
        .expect("OpenAI Chat request messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "inspect the cwd");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["tool_calls"][0]["id"], "call-1");
    assert_eq!(messages[2]["role"], "tool");
    assert_eq!(messages[2]["tool_call_id"], "call-1");
    assert_eq!(messages[2]["content"], "/tmp");
    let serialized = serde_json::to_string(&request).expect("OpenAI Chat request JSON");
    assert!(!serialized.contains("opaque-reasoning"));
    assert!(!serialized.contains("summary_text"));
}

#[test]
fn openai_chat_request_encoding_preserves_reasoning_content_on_assistant_tool_call() {
    let request = build_v3_openai_chat_provider_payload_from_responses_payload(&json!({
        "model": "client-responses",
        "input": [{
            "type": "function_call",
            "id": "fc-2",
            "call_id": "call-2",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"ls\"}",
            "reasoning_content": "Need to inspect the directory before answering."
        }]
    }))
    .expect("Responses function_call must encode into OpenAI Chat");

    assert_eq!(
        request["messages"][0]["reasoning_content"],
        "Need to inspect the directory before answering."
    );
    assert_eq!(request["messages"][0]["tool_calls"][0]["id"], "call-2");
}

#[test]
fn openai_chat_request_encoding_maps_assistant_reasoning_blocks_to_reasoning_content() {
    let request = build_v3_openai_chat_provider_payload_from_responses_payload(&json!({
        "model": "client-responses",
        "input": [{
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "reasoning_text",
                "text": "I should verify the result before returning."
            }]
        }]
    }))
    .expect("assistant Responses reasoning block must encode into OpenAI Chat");

    assert_eq!(request["messages"][0]["role"], "assistant");
    assert_eq!(request["messages"][0]["content"], "");
    assert_eq!(
        request["messages"][0]["reasoning_content"],
        "I should verify the result before returning."
    );
}

#[test]
fn local_continuation_context_preserves_request_history_tools_and_response_delta() {
    let canonical_request = json!({
        "input": [{"role": "user", "content": "original task"}],
        "tools": [{"type": "function", "name": "exec_command"}],
        "instructions": "base instructions with stopreason"
    });
    let finalized_response = json!({
        "status": "requires_action",
        "output": [{
            "type": "function_call",
            "call_id": "call_stopless_reasoning",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"routecodex hook run reasoningStop\"}"
        }]
    });
    let context = build_v3_relay_local_continuation_context_at_resp04(
        &canonical_request,
        &finalized_response,
    )
    .unwrap();
    assert_eq!(
        context["input"],
        json!([
            {"role": "user", "content": "original task"},
            {
                "type": "function_call",
                "call_id": "call_stopless_reasoning",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"routecodex hook run reasoningStop\"}"
            }
        ])
    );
    assert_eq!(context["tools"], canonical_request["tools"]);
    assert_eq!(context["instructions"], canonical_request["instructions"]);

    let mut current = json!({
        "input": [{
            "type": "function_call_output",
            "call_id": "call_stopless_reasoning",
            "output": ""
        }]
    });
    merge_v3_relay_restored_local_context_at_req04(&mut current, &context).unwrap();
    assert_eq!(
        current["input"],
        json!([
            {"role": "user", "content": "original task"},
            {
                "type": "function_call",
                "call_id": "call_stopless_reasoning",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"routecodex hook run reasoningStop\"}"
            },
            {
                "type": "function_call_output",
                "call_id": "call_stopless_reasoning",
                "output": ""
            }
        ])
    );
    assert_eq!(current["tools"], canonical_request["tools"]);
    assert_eq!(current["instructions"], canonical_request["instructions"]);
}

#[test]
fn local_continuation_context_never_carries_stopless_center_state() {
    let canonical_request = json!({
        "input": [{"role": "user", "content": "original task"}],
        "tools": [{"type": "function", "name": "exec_command"}],
        "instructions": "base instructions"
    });
    let finalized_response = json!({
        "status": "requires_action",
        "output": [{
            "type": "function_call",
            "call_id": "call_stopless_reasoning",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"routecodex hook run reasoningStop\"}"
        }]
    });
    let context = build_v3_relay_local_continuation_context_at_resp04(
        &canonical_request,
        &finalized_response,
    )
    .unwrap();
    let serialized = serde_json::to_string(&context).unwrap();
    for forbidden in [
        "__routecodex_stopless_center",
        "stopless_center",
        "stoplessCenter",
        "natural_stop_count",
        "max_natural_stops",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "relay local continuation context leaked stopless control field {forbidden}: {serialized}"
        );
    }
}
