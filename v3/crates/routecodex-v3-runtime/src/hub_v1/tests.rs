use super::*;
use crate::operation_runner::{
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, V3RequestContextHandle,
};
use serde_json::json;

fn relay_request_handle(
    request_id: &str,
    entry_protocol: V3HubEntryProtocol,
    raw: serde_json::Value,
) -> (V3RequestContextHandle, serde_json::Value) {
    let entry_protocol_id = match entry_protocol {
        V3HubEntryProtocol::Responses => "responses",
        V3HubEntryProtocol::Anthropic => "anthropic",
        V3HubEntryProtocol::Gemini => "gemini",
        V3HubEntryProtocol::OpenAiChat => "openai_chat",
    };
    let handle = V3RequestContextHandle::new(request_id.to_string(), entry_protocol_id.to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-entry"),
        RequestOriginKind::ClientEntry,
    );
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(raw),
    )
    .expect("real SDK normalize must publish the original pair");
    let pair = handle
        .original_pair()
        .expect("real SDK normalize must publish the original pair");
    handle
        .publish_current_field_associations(
            crate::operation_runner::CurrentFieldAssociations::from_normalization(
                &pair.inverse_context,
            ),
        )
        .expect("fixture must publish current field associations");
    (handle, canonical)
}

fn governed_chain_from_canonical(
    entry_protocol: V3HubEntryProtocol,
    raw: serde_json::Value,
    canonical: serde_json::Value,
    execution_mode: V3HubExecutionMode,
) -> V3HubReqExecution05Planned {
    let req02 = build_v3_hub_req_inbound_02_from_canonical(
        build_v3_hub_req_inbound_01_client_raw(
            raw,
            entry_protocol,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        ),
        canonical,
    );
    let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02(req02);
    build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(req04, execution_mode)
}

fn build_v3_openai_chat_provider_payload_from_responses_payload(
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(payload)
}

#[test]
fn responses_reasoning_fields_decode_to_independent_chat_fields() {
    let chat = build_v3_openai_chat_provider_payload_from_responses_payload(&json!({
        "model": "gpt-test",
        "input": "reason",
        "reasoning": {
            "effort": "high",
            "summary": "concise",
            "context": "all_turns",
            "mode": "pro"
        },
        "metadata": {"user_id": "opaque-user"}
    }))
    .expect("declared Responses reasoning fields must decode into Chat semantics");

    assert_eq!(chat["reasoning_effort"], "high");
    assert_eq!(chat["reasoning_summary_policy"], "concise");
    assert_eq!(chat["reasoning_context_policy"], "all_turns");
    assert_eq!(chat["reasoning_mode"], "pro");
    assert_eq!(
        chat["routecodex_chat_extension"]["responses_request"]["metadata"],
        json!({"user_id":"opaque-user"})
    );
    assert!(chat.get("reasoning").is_none());
    assert!(chat.get("metadata").is_none());
}

#[test]
fn responses_deprecated_generate_summary_alias_requires_exact_match() {
    let chat = build_v3_openai_chat_provider_payload_from_responses_payload(&json!({
        "model": "gpt-test",
        "input": "reason",
        "reasoning": {"summary": "detailed", "generate_summary": "detailed"}
    }))
    .expect("matching deprecated summary alias must decode once");
    assert_eq!(chat["reasoning_summary_policy"], "detailed");

    let error = build_v3_openai_chat_provider_payload_from_responses_payload(&json!({
        "model": "gpt-test",
        "input": "reason",
        "reasoning": {"summary": "detailed", "generate_summary": "concise"}
    }))
    .expect_err("conflicting summary aliases must fail at inbound");
    assert!(error.contains("conflicts"), "{error}");
}

#[test]
fn responses_reasoning_rejects_anthropic_fields_in_openai_source_schema() {
    for reasoning in [
        json!({"budget_tokens": 2048}),
        json!({"thinking": {"type":"enabled", "budget_tokens":2048}}),
    ] {
        let error = build_v3_openai_chat_provider_payload_from_responses_payload(&json!({
            "model": "gpt-test",
            "input": "reason",
            "reasoning": reasoning
        }))
        .expect_err("undeclared Responses reasoning fields must fail at inbound");
        assert!(
            error.contains("Unsupported Responses reasoning field"),
            "{error}"
        );
    }
}

#[test]
fn openai_chat_function_tool_redacted_schema_placeholders_pass_through() {
    let payload = json!({
        "model": "glm-5.2",
        "messages": [{"role": "user", "content": "continue the coding task"}],
        "tools": [{
            "type": "function",
            "function": {
                "name": "exec_command",
                "parameters": {
                    "type": "object",
                    "properties": {"max_output_tokens": "[REDACTED]"}
                }
            }
        }]
    });

    let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("proxy must not process the client schema placeholder");
    assert_eq!(
        wire["tools"][0]["function"]["parameters"]["properties"]["max_output_tokens"],
        "[REDACTED]"
    );
}

#[test]
fn openai_responses_function_tool_redacted_schema_placeholders_pass_through() {
    let payload = json!({
        "model": "gpt-5.5",
        "messages": [{"role": "user", "content": "continue the coding task"}],
        "tools": [{
            "type": "function",
            "name": "create_goal",
            "parameters": {
                "type": "object",
                "properties": {"token_budget": "[REDACTED]"}
            }
        }]
    });

    let wire = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("proxy must not process the client schema placeholder");
    assert_eq!(
        wire["tools"][0]["parameters"]["properties"]["token_budget"],
        "[REDACTED]"
    );
}

#[test]
fn openai_chat_tool_search_rejects_unmapped_builtin_tool() {
    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model": "glm-5.2",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [{
            "type": "tool_search",
            "name": "tool_search",
            "parameters": "invalid"
        }]
    }))
    .expect_err("Responses builtin tool_search must not be emulated on OpenAI Chat wire");

    assert!(
        error.contains("UnmappedOutboundFields target_protocol=openai_chat paths=$.tools[0].name"),
        "{error}"
    );
}

#[test]
fn openai_chat_stream_relay_requests_include_usage_when_client_does_not_set_stream_options() {
    let provider = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model": "glm-5.2",
        "messages": [{"role": "user", "content": "report usage"}],
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
fn openai_chat_provider_wire_consumes_registered_codex_client_metadata_as_local_context() {
    let provider = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model": "glm-5.2",
        "messages": [{"role": "user", "content": "continue"}],
        "stream": true,
        "client_metadata": {
            "session_id": "client-session",
            "x-codex-turn-metadata": "{\"workspaces\":{\"/Volumes/extension/code\":{\"has_changes\":true}}}"
        }
    }))
    .expect("registered Codex client metadata is local request context");

    assert!(
        provider.get("client_metadata").is_none(),
        "OpenAI Chat wire must not forward client_metadata: {provider}"
    );
    assert!(provider.get("metadata").is_none(), "{provider}");
}

#[test]
fn openai_responses_provider_wire_maps_chat_token_and_logprob_pairs() {
    let provider = build_v3_openai_responses_standard_request_from_chat_canonical(&json!({
        "model": "responses-model",
        "messages": [{"role": "user", "content": "count tokens"}],
        "max_completion_tokens": 77,
        "max_tokens": 55,
        "logprobs": true,
        "top_logprobs": 4
    }))
    .unwrap();

    assert_eq!(provider["max_output_tokens"], json!(77));
    assert!(
        provider.get("max_completion_tokens").is_none(),
        "Responses provider wire must not emit Chat max_completion_tokens: {provider}"
    );
    assert!(
        provider.get("max_tokens").is_none(),
        "Responses provider wire must not emit non-spec max_tokens: {provider}"
    );
    assert_eq!(provider["top_logprobs"], json!(4));
    assert!(
        provider.get("logprobs").is_none(),
        "Responses provider wire has top_logprobs count but no Chat logprobs boolean: {provider}"
    );
}

#[test]
fn openai_responses_provider_wire_drops_top_logprobs_when_logprobs_disabled() {
    let provider = build_v3_openai_responses_standard_request_from_chat_canonical(&json!({
        "model": "responses-model",
        "messages": [{"role": "user", "content": "count tokens"}],
        "logprobs": false,
        "top_logprobs": 4
    }))
    .unwrap();

    assert!(
        provider.get("top_logprobs").is_none(),
        "disabled Chat logprobs must not emit Responses top_logprobs: {provider}"
    );
    assert!(
        provider.get("logprobs").is_none(),
        "Chat logprobs boolean is not a Responses provider wire field: {provider}"
    );
}

#[test]
fn all_adjacent_builders_form_the_fixed_typed_topology() {
    let raw = json!({"messages":[{"role":"user","content":"x"}]});
    let (handle, canonical) = relay_request_handle(
        "all-adjacent-builders",
        V3HubEntryProtocol::OpenAiChat,
        raw.clone(),
    );
    let req05 = governed_chain_from_canonical(
        V3HubEntryProtocol::OpenAiChat,
        raw,
        canonical.clone(),
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
            visible_model_ids: vec!["model".into()],
            model_capabilities: vec!["text".into(), "tools".into()],
            web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
            max_context_tokens: None,
            max_tokens: None,
            context_token_estimate_scale_bps: 10_000,
            base_url: "http://127.0.0.1:1/v1".into(),
            responses_process: None,
            responses_transport: routecodex_v3_config::V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            reasoning_effort: None,
            request_timeout_ms: 300_000,
            priority: 0,
            weight: 1,
            sse_first_frame_timeout_ms: None,
            initial_concurrency_budget: 8,
            concurrency_acquire_timeout_ms: 60_000,
            compatibility_profile: None,
            headers: Default::default(),
            env_name: Some("V3_TEST_KEY".into()),
            token_file: None,
            secret_file: None,
            secret_key: None,
            api_key: None,
            required_capabilities: Vec::new(),
            pool_ids: vec!["test".into()],
            default_pool_member: false,
            path: vec!["provider".into()],
        },
    );
    let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        &canonical,
        &handle,
        V3HubExecutionMode::Direct,
        "all-adjacent-builders-attempt",
        V3HubProviderWireProtocol::OpenAiChat,
    )
    .unwrap();
    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();
    let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat.node);
    let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);

    let resp01 = build_v3_provider_resp_inbound_01_raw(
        json!({"output":"x"}),
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::Responses,
        V3HubExecutionMode::Direct,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let resp_compat =
        build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01).unwrap();
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(resp_compat).unwrap();
    let resp03 = build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(resp02);
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03(resp03);
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
}

#[test]
fn cross_protocol_relay_projects_chat_to_selected_responses_provider() {
    let raw = json!({"messages":[{"role":"user","content":"direct"}],"tools":[{"type":"tool_search","name":"tool_search"}]});
    let (handle, canonical) = relay_request_handle(
        "direct-req-compat",
        V3HubEntryProtocol::OpenAiChat,
        raw.clone(),
    );
    let req05 = governed_chain_from_canonical(
        V3HubEntryProtocol::OpenAiChat,
        raw,
        canonical.clone(),
        V3HubExecutionMode::Relay,
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
            visible_model_ids: vec!["model".into()],
            model_capabilities: vec!["text".into(), "tools".into()],
            web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
            max_context_tokens: None,
            max_tokens: None,
            context_token_estimate_scale_bps: 10_000,
            base_url: "http://127.0.0.1:1/v1".into(),
            responses_process: None,
            responses_transport: routecodex_v3_config::V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            reasoning_effort: None,
            request_timeout_ms: 300_000,
            priority: 0,
            weight: 1,
            sse_first_frame_timeout_ms: None,
            initial_concurrency_budget: 8,
            concurrency_acquire_timeout_ms: 60_000,
            compatibility_profile: None,
            headers: Default::default(),
            env_name: Some("V3_TEST_KEY".into()),
            token_file: None,
            secret_file: None,
            secret_key: None,
            api_key: None,
            required_capabilities: Vec::new(),
            pool_ids: vec!["test".into()],
            default_pool_member: false,
            path: vec!["provider".into()],
        },
    );
    let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        &canonical,
        &handle,
        V3HubExecutionMode::Relay,
        "direct-req-compat-attempt",
        V3HubProviderWireProtocol::Responses,
    )
    .unwrap();
    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();
    let payload = req_compat.provider_semantic_payload();
    assert!(
        payload
            .get("input")
            .and_then(serde_json::Value::as_array)
            .is_some(),
        "cross-protocol Relay must project Chat payload to selected Responses provider protocol: {payload}"
    );
    assert!(
        payload.get("messages").is_none(),
        "cross-protocol Relay must not pass Chat payload into Responses provider wire: {payload}"
    );
    assert_eq!(payload["tools"][0]["type"], "tool_search");
}

#[test]
fn provider_req_compat_loads_selected_target_profile() {
    let raw = json!({
        "model": "MiniMax-M3",
        "input": [{"role": "user", "content": "hi"}]
    });
    let (handle, canonical) = relay_request_handle(
        "provider-req-compat-profile",
        V3HubEntryProtocol::Responses,
        raw.clone(),
    );
    let req05 = governed_chain_from_canonical(
        V3HubEntryProtocol::Responses,
        raw,
        canonical.clone(),
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
            visible_model_ids: vec!["MiniMax-M3".into()],
            model_capabilities: vec!["text".into(), "tools".into()],
            web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
            max_context_tokens: None,
            max_tokens: None,
            context_token_estimate_scale_bps: 10_000,
            base_url: "http://127.0.0.1:1/v1".into(),
            responses_process: None,
            responses_transport: routecodex_v3_config::V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            reasoning_effort: None,
            request_timeout_ms: 300_000,
            priority: 0,
            weight: 1,
            sse_first_frame_timeout_ms: None,
            initial_concurrency_budget: 8,
            concurrency_acquire_timeout_ms: 60_000,
            compatibility_profile: Some("chat:minimax".into()),
            headers: Default::default(),
            env_name: Some("V3_TEST_KEY".into()),
            token_file: None,
            secret_file: None,
            secret_key: None,
            api_key: None,
            required_capabilities: Vec::new(),
            pool_ids: vec!["test".into()],
            default_pool_member: false,
            path: vec!["provider".into()],
        },
    );
    let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        &canonical,
        &handle,
        V3HubExecutionMode::Relay,
        "provider-req-compat-profile-attempt",
        V3HubProviderWireProtocol::Responses,
    )
    .unwrap();
    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();
    assert_eq!(req_compat.profile().as_str(), "chat:minimax");
    let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat.node);
    let req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
    assert_eq!(req09.compat_profile_id(), "chat:minimax");
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
fn responses_inbound_preserves_reasoning_summary_and_tool_context_without_encrypted_content() {
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
    .expect("Responses reasoning must normalize into Chat without encrypted replay state");

    let messages = request["messages"]
        .as_array()
        .expect("OpenAI Chat request messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "inspect the cwd");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(
        messages[1]["reasoning_content"],
        "Need to inspect cwd first."
    );
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
fn openai_responses_request_encoding_preserves_assistant_reasoning_before_tool_call() {
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&json!({
        "model": "client-responses",
        "messages": [{
            "role": "assistant",
            "content": "",
            "reasoning_content": "Need lookup",
            "tool_calls": [{
                "id": "call-2",
                "type": "function",
                "function": {
                    "name": "lookup",
                    "arguments": "{\"q\":\"alpha\"}"
                }
            }]
        }]
    }))
    .expect("assistant reasoning plus tool call must encode into Responses wire");

    assert_eq!(request["input"][0]["type"], "reasoning");
    assert_eq!(
        request["input"][0]["summary"],
        json!([{"type":"summary_text","text":"Need lookup"}])
    );
    assert_eq!(request["input"][1]["type"], "function_call");
    assert_eq!(request["input"][1]["call_id"], "call-2");
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
fn live_5555_web_search_call_history_indexes_project_to_stable_tool_pairs() {
    let request = build_v3_openai_chat_provider_payload_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "prefix"}]
            },
            {
                "type": "web_search_call",
                "status": "failed",
                "action": {
                    "type": "search",
                    "query": "微信小程序 发布 流程 上传 审核 发布 官方 文档",
                    "queries": [
                        "微信小程序 发布 流程 上传 审核 发布 官方 文档",
                        "微信小程序 服务器域名 request合法域名 官方 文档"
                    ]
                }
            },
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "continue"}]
            },
            {
                "type": "web_search_call",
                "status": "failed",
                "action": {
                    "type": "search",
                    "query": "site:developers.weixin.qq.com miniprogram 发布 审核 上传"
                }
            }
        ]
    }))
    .expect("live 5555-like web_search_call history must project");

    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 6, "user + pair + user + pair: {request}");
    assert_eq!(
        messages[1]["tool_calls"][0]["id"],
        json!("call_routecodex_web_search_1")
    );
    assert_eq!(
        messages[2]["tool_call_id"],
        json!("call_routecodex_web_search_1")
    );
    assert_eq!(
        messages[4]["tool_calls"][0]["id"],
        json!("call_routecodex_web_search_3")
    );
    assert_eq!(
        messages[5]["tool_call_id"],
        json!("call_routecodex_web_search_3")
    );
    assert_eq!(
        messages[1]["tool_calls"][0]["function"]["name"],
        json!("web_search")
    );
    assert_eq!(
        messages[4]["tool_calls"][0]["function"]["name"],
        json!("web_search")
    );
}

#[test]
fn anthropic_outbound_strips_responses_only_reasoning_policy_fields_without_failing() {
    // Codex 10000 `/v1/responses` 入口命中 anthropic 兼容 provider（如 minimax_anthropic）
    // 时，responses_openai_codec 会把 Responses `reasoning.context/mode/include_thoughts`
    // 落到 chat canonical body。这些字段在 anthropic 出站白名单允许通过，但 anthropic
    // 出站 codec 二次硬护栏会把它们当 unmapped fail-fast。本测试要求改为：strip 字段、
    // 不报错、不进 provider wire、不进 response payload，只走一次 side-channel 诊断。
    let chat = json!({
        "model": "MiniMax-M3",
        "messages": [{"role": "user", "content": "hi"}],
        "reasoning_effort": "medium",
        "reasoning_context_policy": "all_turns",
        "reasoning_mode": "standard",
        "reasoning_include_thoughts": true,
    });

    let wire = encode_v3_responses_semantic_as_anthropic_request(chat)
        .expect("responses-only reasoning policy fields must be stripped, not failed");

    let wire_object = wire.as_object().expect("wire must be an object");
    assert!(
        !wire_object.contains_key("reasoning_context_policy"),
        "reasoning_context_policy must be stripped from anthropic wire: {wire}"
    );
    assert!(
        !wire_object.contains_key("reasoning_mode"),
        "reasoning_mode must be stripped from anthropic wire: {wire}"
    );
    assert!(
        !wire_object.contains_key("reasoning_include_thoughts"),
        "reasoning_include_thoughts must be stripped from anthropic wire: {wire}"
    );
    assert_eq!(wire_object["model"], json!("MiniMax-M3"));
    assert!(
        wire_object["messages"].is_array(),
        "messages must remain projected to anthropic wire"
    );
}

#[test]
fn responses_reasoning_summary_survives_chat_canonical_round_trip_before_tool_output() {
    // 复现 opencode-go/Console Go 400 `reasoning_text must be passed back`：
    // 客户端回传 reasoning item 只携带 summary（content=null、encrypted_content=null），
    // 后面紧跟 assistant 文本消息与 function_call。chat canonical 阶段必须把
    // summary 投影为 assistant message 的 reasoning_content，再从 Responses wire
    // 重建时原样带回 reasoning.summary，禁止变成空 reasoning。
    let input = json!([
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue"}]},
        {
            "type": "reasoning",
            "id": "item_rsn_1",
            "summary": [{"type": "summary_text", "text": "**Deciding skill activation and compliance**"}],
            "encrypted_content": null,
            "content": null
        },
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "I will read the skill first."}]
        },
        {
            "type": "function_call",
            "id": "item_fc_1",
            "call_id": "call_1",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"cat SKILL.md\"}"
        },
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "skill body"
        }
    ]);
    let canonical = build_v3_openai_chat_provider_payload_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": input,
        "reasoning": {"effort": "high", "summary": "detailed"}
    }))
    .expect("reasoning summary must canonicalize into Chat");
    let assistant = canonical["messages"]
        .as_array()
        .expect("canonical messages")
        .iter()
        .find(|message| message.get("tool_calls").is_some())
        .expect("assistant tool message must exist");
    assert_eq!(
        assistant["reasoning_content"], "**Deciding skill activation and compliance**",
        "summary must project into assistant reasoning_content before tool call"
    );

    let rebuilt = build_v3_openai_responses_standard_request_from_chat_canonical(&canonical)
        .expect("Chat canonical must rebuild into Responses wire");
    let rebuilt_reasoning = rebuilt["input"]
        .as_array()
        .expect("rebuilt input")
        .iter()
        .filter(|item| item.get("type") == Some(&json!("reasoning")))
        .collect::<Vec<_>>();
    assert_eq!(
        rebuilt_reasoning.len(),
        1,
        "rebuild must keep the reasoning item"
    );
    assert_eq!(
        rebuilt_reasoning[0]["summary"],
        json!([{"type": "summary_text", "text": "**Deciding skill activation and compliance**"}]),
        "rebuild must carry the full summary as plaintext for the next wire"
    );
}

fn v3_output_cap_test_candidate(
    provider_type: &'static str,
    entry_protocol: V3HubEntryProtocol,
    declared_max_tokens: Option<u64>,
) -> routecodex_v3_target::V3TargetCandidate {
    routecodex_v3_target::V3TargetCandidate {
        provider_id: "provider".into(),
        provider_type: provider_type.into(),
        auth_alias: "primary".into(),
        model_id: "model".into(),
        wire_model: "wire-model".into(),
        visible_model_ids: vec!["model".into()],
        model_capabilities: vec!["text".into(), "tools".into()],
        web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
        max_context_tokens: None,
        max_tokens: declared_max_tokens,
        context_token_estimate_scale_bps: 10_000,
        base_url: "http://127.0.0.1:1/v1".into(),
        responses_process: None,
        responses_transport: routecodex_v3_config::V3ResponsesTransportKind::Http,
        websocket_v2_url: None,
        provider_request_cleanup: Default::default(),
        reasoning_effort: None,
        request_timeout_ms: 300_000,
        priority: 0,
        weight: 1,
        sse_first_frame_timeout_ms: None,
        initial_concurrency_budget: 8,
        concurrency_acquire_timeout_ms: 60_000,
        compatibility_profile: None,
        headers: Default::default(),
        env_name: Some("V3_TEST_KEY".into()),
        token_file: None,
        secret_file: None,
        secret_key: None,
        api_key: None,
        required_capabilities: Vec::new(),
        pool_ids: vec!["test".into()],
        default_pool_member: false,
        path: vec!["provider".into()],
    }
}

fn project_v3_output_cap_wire(
    client_payload: serde_json::Value,
    entry_protocol: V3HubEntryProtocol,
    provider_protocol: V3HubProviderWireProtocol,
    declared_max_tokens: Option<u64>,
) -> serde_json::Value {
    let wire_model = match provider_protocol {
        V3HubProviderWireProtocol::OpenAiChat => "openai_chat",
        V3HubProviderWireProtocol::Responses => "responses",
        V3HubProviderWireProtocol::Anthropic => "anthropic",
        V3HubProviderWireProtocol::Gemini => "gemini",
    };
    let (handle, canonical) =
        relay_request_handle("output-cap-fixture", entry_protocol, client_payload.clone());
    let req05 = governed_chain_from_canonical(
        entry_protocol,
        client_payload,
        canonical.clone(),
        V3HubExecutionMode::Relay,
    );
    let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
        req05,
        V3HubTargetResolution::Routed,
        v3_output_cap_test_candidate(wire_model, entry_protocol, declared_max_tokens),
    );
    let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        &canonical,
        &handle,
        V3HubExecutionMode::Relay,
        "output-cap-attempt",
        provider_protocol,
    )
    .expect("standard outbound projection must succeed before provider output-cap compat");
    build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
        .expect("provider compat projection must succeed")
        .provider_semantic_payload()
        .clone()
}

#[test]
fn provider_req_compat_projects_declared_output_cap_when_client_sent_none() {
    let wire = project_v3_output_cap_wire(
        json!({"messages":[{"role":"user","content":"hi"}]}),
        V3HubEntryProtocol::OpenAiChat,
        V3HubProviderWireProtocol::Responses,
        Some(20_000),
    );
    assert_eq!(
        wire["max_output_tokens"],
        json!(20_000),
        "declared provider cap must be projected on the Responses wire: {wire}"
    );
    assert!(wire.get("max_completion_tokens").is_none());
    assert!(wire.get("max_tokens").is_none());

    let wire = project_v3_output_cap_wire(
        json!({"messages":[{"role":"user","content":"hi"}]}),
        V3HubEntryProtocol::OpenAiChat,
        V3HubProviderWireProtocol::OpenAiChat,
        Some(20_000),
    );
    assert_eq!(
        wire["max_completion_tokens"],
        json!(20_000),
        "declared provider cap must be projected on the OpenAI Chat wire: {wire}"
    );
    assert!(wire.get("max_tokens").is_none());
    assert!(wire.get("max_output_tokens").is_none());

    let wire = project_v3_output_cap_wire(
        json!({"messages":[{"role":"user","content":"hi"}]}),
        V3HubEntryProtocol::OpenAiChat,
        V3HubProviderWireProtocol::Anthropic,
        Some(20_000),
    );
    assert_eq!(
        wire["max_tokens"],
        json!(20_000),
        "declared provider cap must be projected on the Anthropic wire: {wire}"
    );

    let wire = project_v3_output_cap_wire(
        json!({"messages":[{"role":"user","content":"hi"}]}),
        V3HubEntryProtocol::OpenAiChat,
        V3HubProviderWireProtocol::Gemini,
        Some(20_000),
    );
    assert_eq!(
        wire["generationConfig"]["maxOutputTokens"],
        json!(20_000),
        "declared provider cap must be projected on the Gemini wire: {wire}"
    );
}

#[test]
fn provider_req_compat_keeps_client_output_cap_over_declared_cap() {
    // Every Responses alias a client can send must win over the declared cap and
    // must not be joined by a second alias.
    for alias in ["max_output_tokens", "max_completion_tokens", "max_tokens"] {
        let client_payload = serde_json::Map::new();
        let mut client_payload = json!({"messages":[{"role":"user","content":"hi"}]});
        client_payload[alias] = json!(64);
        let wire = project_v3_output_cap_wire(
            client_payload,
            V3HubEntryProtocol::OpenAiChat,
            V3HubProviderWireProtocol::Responses,
            Some(20_000),
        );
        assert_eq!(
            wire["max_output_tokens"],
            json!(64),
            "client Responses alias {alias} must win over the declared cap: {wire}"
        );
        assert!(
            wire.get("max_completion_tokens").is_none(),
            "a client Responses cap must not gain a second alias ({alias}): {wire}"
        );
        assert!(
            wire.get("max_tokens").is_none(),
            "a client Responses cap must not gain a second alias ({alias}): {wire}"
        );
    }

    let wire = project_v3_output_cap_wire(
        json!({"messages":[{"role":"user","content":"hi"}], "max_completion_tokens": 64}),
        V3HubEntryProtocol::OpenAiChat,
        V3HubProviderWireProtocol::OpenAiChat,
        Some(20_000),
    );
    assert_eq!(
        wire["max_completion_tokens"],
        json!(64),
        "client OpenAI Chat cap must win over the declared cap: {wire}"
    );

    let wire = project_v3_output_cap_wire(
        json!({"messages":[{"role":"user","content":"hi"}], "max_tokens": 64}),
        V3HubEntryProtocol::OpenAiChat,
        V3HubProviderWireProtocol::Anthropic,
        Some(20_000),
    );
    assert_eq!(
        wire["max_tokens"],
        json!(64),
        "client Anthropic cap must win over the declared cap: {wire}"
    );
}

#[test]
fn provider_req_compat_does_not_inject_output_cap_without_declaration() {
    for protocol in [
        (
            V3HubProviderWireProtocol::Responses,
            vec!["max_output_tokens", "max_completion_tokens", "max_tokens"],
        ),
        (
            V3HubProviderWireProtocol::OpenAiChat,
            vec!["max_completion_tokens", "max_tokens", "max_output_tokens"],
        ),
        (V3HubProviderWireProtocol::Anthropic, vec!["max_tokens"]),
        (V3HubProviderWireProtocol::Gemini, vec!["maxOutputTokens"]),
    ] {
        let wire = project_v3_output_cap_wire(
            json!({"messages":[{"role":"user","content":"hi"}]}),
            V3HubEntryProtocol::OpenAiChat,
            protocol.0,
            None,
        );
        for field in protocol.1 {
            assert!(
                wire.get(&field).is_none(),
                "no provider-declared cap means no injected {field} on {:?} wire: {wire}",
                protocol.0
            );
        }
    }
}

#[test]
fn provider_req_compat_leaves_existing_gemini_generation_config_untouched() {
    let mut payload = build_v3_openai_responses_standard_request_for_selected_target(
        &build_v3_openai_chat_standard_request_for_selected_web_search_mode(
            &json!({"messages":[{"role":"user","content":"hi"}]}),
            routecodex_v3_config::V3WebSearchExecutionMode::None,
            false,
        )
        .expect("chat canonical projection must succeed"),
        false,
    )
    .expect("responses projection must succeed");
    payload["generationConfig"] = json!({"maxOutputTokens": 123});
    let selected =
        v3_output_cap_test_candidate("gemini", V3HubEntryProtocol::OpenAiChat, Some(20_000));

    let wire = apply_v3_provider_req_compat_to_provider_payload(
        payload,
        &selected,
        V3HubProviderWireProtocol::Gemini,
        &V3ProviderCompatProfileId::Passthrough,
    )
    .expect("a pre-existing generationConfig must not make the provider request fail");

    assert_eq!(
        wire["generationConfig"]["maxOutputTokens"],
        json!(123),
        "a pre-existing generationConfig.maxOutputTokens must not be replaced by the declared cap: {wire}"
    );
}
