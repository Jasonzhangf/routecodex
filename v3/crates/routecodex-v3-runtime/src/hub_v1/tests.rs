use super::*;
use serde_json::json;

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
            visible_model_ids: vec!["model".into()],
            model_capabilities: vec!["text".into(), "tools".into()],
            web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
            max_context_tokens: None,
            context_token_estimate_scale_bps: 10_000,
            base_url: "http://127.0.0.1:1/v1".into(),
            responses_process: None,
            responses_transport: routecodex_v3_config::V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            request_timeout_ms: 300_000,
            initial_concurrency_budget: 8,
            compatibility_profile: None,
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
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(resp_compat).unwrap();
    let resp03 = build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(resp02);
    let resp04 = build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03(
        resp03,
        V3HubContinuationCommit::None,
    );
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
}

#[test]
fn direct_req_compat_projects_chat_to_selected_provider_protocol() {
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
            visible_model_ids: vec!["model".into()],
            model_capabilities: vec!["text".into(), "tools".into()],
            web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
            max_context_tokens: None,
            context_token_estimate_scale_bps: 10_000,
            base_url: "http://127.0.0.1:1/v1".into(),
            responses_process: None,
            responses_transport: routecodex_v3_config::V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            request_timeout_ms: 300_000,
            initial_concurrency_budget: 8,
            compatibility_profile: None,
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
        V3HubProviderWireProtocol::Responses,
    );
    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();
    let payload = req_compat.provider_semantic_payload();
    assert!(
        payload
            .get("input")
            .and_then(serde_json::Value::as_array)
            .is_some(),
        "direct selected mode must project adjacent Chat payload to selected Responses provider protocol: {payload}"
    );
    assert!(
        payload.get("messages").is_none(),
        "direct selected mode must not cross-node pass Chat payload into Responses provider wire: {payload}"
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
            visible_model_ids: vec!["MiniMax-M3".into()],
            model_capabilities: vec!["text".into(), "tools".into()],
            web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
            max_context_tokens: None,
            context_token_estimate_scale_bps: 10_000,
            base_url: "http://127.0.0.1:1/v1".into(),
            responses_process: None,
            responses_transport: routecodex_v3_config::V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            request_timeout_ms: 300_000,
            initial_concurrency_budget: 8,
            compatibility_profile: Some("chat:minimax".into()),
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
        context["messages"],
        json!([
            {"role": "system", "content": "base instructions with stopreason"},
            {"role": "user", "content": "original task"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_stopless_reasoning",
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop\"}"
                    }
                }]
            }
        ])
    );
    assert_eq!(context["tools"], canonical_request["tools"]);
    assert!(context.get("instructions").is_none());

    let mut current = json!({
        "messages": [{
            "role": "tool",
            "tool_call_id": "call_stopless_reasoning",
            "content": "",
            "routecodex_chat_extension": {
                "responses_tool_output_type": "function_call_output"
            }
        }]
    });
    merge_v3_relay_restored_local_context_at_req04(&mut current, &context).unwrap();
    assert_eq!(
        current["messages"],
        json!([
            {"role": "system", "content": "base instructions with stopreason"},
            {"role": "user", "content": "original task"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_stopless_reasoning",
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop\"}"
                    }
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "call_stopless_reasoning",
                "content": "",
                "routecodex_chat_extension": {
                    "responses_tool_output_type": "function_call_output"
                }
            }
        ])
    );
    assert_eq!(current["tools"], canonical_request["tools"]);
    assert!(current.get("instructions").is_none());
}

#[test]
fn resp04_only_coalesces_the_latest_appended_response_suffix_and_keeps_history_immutable() {
    let mut historical_input = vec![
        json!({"type":"output_text","text":"historical visible text"}),
        json!({
            "type":"function_call",
            "call_id":"call_historical",
            "name":"historical_tool",
            "arguments":"{}"
        }),
        json!({
            "type":"function_call_output",
            "call_id":"call_historical",
            "output":"historical result"
        }),
    ];
    for index in 3..294 {
        historical_input.push(json!({
            "type":"message",
            "role":"user",
            "content":[{"type":"input_text","text":format!("history-{index}")}]
        }));
    }
    let canonical_request = json!({"input": historical_input});
    let historical_chat =
        build_v3_openai_chat_provider_payload_from_responses_payload(&canonical_request)
            .expect("historical request must canonicalize without rewriting its order");
    let historical_messages = historical_chat["messages"]
        .as_array()
        .expect("historical messages")
        .clone();
    assert_eq!(historical_messages.len(), 293);
    assert_eq!(historical_messages[0]["content"], "historical visible text");
    assert_eq!(
        historical_messages[0]["tool_calls"][0]["id"],
        "call_historical"
    );
    assert_eq!(historical_messages[1]["tool_call_id"], "call_historical");

    let finalized_response = json!({
        "status":"requires_action",
        "output":[
            {"type":"reasoning","summary":[{"type":"summary_text","text":"latest thought"}]},
            {"type":"output_text","text":"latest visible text"},
            {
                "type":"function_call",
                "call_id":"call_latest",
                "name":"latest_tool",
                "arguments":"{\"path\":\"/tmp\"}"
            }
        ]
    });
    let context = build_v3_relay_local_continuation_context_at_resp04(
        &canonical_request,
        &finalized_response,
    )
    .expect("Resp04 must append and normalize only the current response delta");
    let messages = context["messages"]
        .as_array()
        .expect("continuation messages");

    assert_eq!(
        &messages[..293],
        historical_messages.as_slice(),
        "the complete historical prefix must remain byte-for-byte JSON equivalent"
    );
    assert!(messages.len() > 293);
    let latest_suffix = &messages[293..];
    assert!(latest_suffix.iter().any(|item| {
        item.get("content") == Some(&json!("latest visible text"))
            || item
                .get("reasoning_content")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|text| text == "latest thought")
    }));
    assert!(latest_suffix.iter().any(|item| {
        item.get("tool_calls")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .any(|call| call.get("id") == Some(&json!("call_latest")))
    }));
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

#[test]
fn req04_rejects_responses_shaped_continuation_instead_of_rebuilding_chat() {
    let mut current = json!({
        "messages": [{"role":"tool","tool_call_id":"call_old","content":"ok"}]
    });
    let restored = json!({
        "input": [{"type":"function_call","call_id":"call_old","name":"lookup","arguments":"{}"}],
        "output": []
    });

    let error = merge_v3_relay_restored_local_context_at_req04(&mut current, &restored)
        .expect_err("Req04 must not rebuild Chat from a stored Responses payload");

    assert!(error.to_string().contains("Chat canonical messages"));
}

#[test]
fn req04_restore_preserves_saved_and_current_request_images() {
    let mut current = json!({
        "messages": [{
            "role": "user",
            "content": [{
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,CURRENT"}
            }]
        }]
    });
    let restored = json!({
        "messages": [{
            "role": "user",
            "content": [{
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,SAVED"}
            }]
        }]
    });

    let current_payload_start =
        merge_v3_relay_restored_local_context_at_req04(&mut current, &restored)
            .expect("Req04 must merge restored Chat continuation");

    assert_eq!(current_payload_start, 1);
    assert_eq!(
        current["messages"][0]["content"][0]["image_url"]["url"],
        "data:image/png;base64,SAVED"
    );
    assert_eq!(
        current["messages"][1]["content"][0]["image_url"]["url"],
        "data:image/png;base64,CURRENT"
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
