use routecodex_v3_config::{
    V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
};
use routecodex_v3_runtime::hub_v1::{
    build_provider_req_compat_06_from_v3_hub_req_outbound_07,
    build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02,
    build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04,
    build_v3_hub_req_inbound_01_client_raw, build_v3_hub_req_inbound_02_from_request_invocation,
    build_v3_hub_req_outbound_07_from_v3_hub_req_target_06,
    build_v3_hub_req_target_06_from_v3_hub_req_execution_05,
    build_v3_provider_req_outbound_08_from_provider_req_compat_06,
    build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08,
    govern_v3_operation_runner_current_request_fields, V3HubEntryProtocol, V3HubExecutionMode,
    V3HubInvocationSource, V3HubProviderWireProtocol, V3HubReqOutbound07ProviderSemantic,
    V3HubTargetResolution, V3HubTransportIntent,
};
use routecodex_v3_runtime::operation_runner::{
    RequestInvocationContext, RequestOriginKind, V3RequestContextHandle, V3TargetCandidate,
};
use serde_json::{json, Value};

fn selected_candidate(provider_protocol: V3HubProviderWireProtocol) -> V3TargetCandidate {
    let provider_type = match provider_protocol {
        V3HubProviderWireProtocol::OpenAiChat => "openai_chat",
        V3HubProviderWireProtocol::Responses => "responses",
        V3HubProviderWireProtocol::Anthropic => "anthropic",
        V3HubProviderWireProtocol::Gemini => "gemini",
    };
    V3TargetCandidate {
        provider_id: format!("req02-{provider_type}"),
        provider_type: provider_type.to_string(),
        auth_alias: "primary".to_string(),
        model_id: "req02-standard-model".to_string(),
        wire_model: "req02-wire-model".to_string(),
        visible_model_ids: vec!["client-route-alias".to_string()],
        model_capabilities: vec!["text".to_string(), "tools".to_string()],
        web_search_execution_mode: V3WebSearchExecutionMode::None,
        max_context_tokens: None,
        max_tokens: None,
        context_token_estimate_scale_bps: 10_000,
        base_url: "https://provider.invalid/v1".to_string(),
        responses_process: None,
        responses_transport: V3ResponsesTransportKind::Http,
        websocket_v2_url: None,
        provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
        request_timeout_ms: 300_000,
        priority: 0,
        weight: 1,
        sse_first_frame_timeout_ms: None,
        initial_concurrency_budget: 8,
        concurrency_acquire_timeout_ms: 60_000,
        compatibility_profile: None,
        headers: Default::default(),
        env_name: Some("REQ02_STANDARD_OUTBOUND_KEY".to_string()),
        token_file: None,
        secret_file: None,
        secret_key: None,
        api_key: None,
        required_capabilities: Vec::new(),
        pool_ids: vec!["default".to_string()],
        default_pool_member: true,
        path: vec![provider_type.to_string()],
    }
}

fn build_req07(
    entry_protocol: V3HubEntryProtocol,
    raw: Value,
    provider_protocol: V3HubProviderWireProtocol,
    mutate_selected: impl FnOnce(&mut V3TargetCandidate),
) -> Result<V3HubReqOutbound07ProviderSemantic, String> {
    let protocol_id = match entry_protocol {
        V3HubEntryProtocol::OpenAiChat => "openai_chat",
        V3HubEntryProtocol::Responses => "responses",
        V3HubEntryProtocol::Anthropic => "anthropic",
        V3HubEntryProtocol::Gemini => "gemini",
    };
    let handle =
        V3RequestContextHandle::new("standard-outbound-consumer".into(), protocol_id.into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "standard-outbound-invocation".into(),
        "standard-outbound-entry".into(),
        RequestOriginKind::ClientEntry,
    );
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        raw,
        entry_protocol,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let req02 = build_v3_hub_req_inbound_02_from_request_invocation(req01, &invocation)?;
    let canonical =
        govern_v3_operation_runner_current_request_fields(req02.payload(), &invocation, &[])?;
    let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02(req02);
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    let mut selected = selected_candidate(provider_protocol);
    mutate_selected(&mut selected);
    let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
        req05,
        V3HubTargetResolution::Routed,
        selected,
    );
    build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        &canonical,
        &handle,
        V3HubExecutionMode::Relay,
        "standard-outbound-attempt",
        provider_protocol,
    )
}

fn complete_public_wire_pipeline(req07: V3HubReqOutbound07ProviderSemantic) {
    let compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
        .expect("Req07 standard payload must enter provider compat");
    let profile = compat.profile().as_str().to_string();
    let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(compat.node);
    let req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
    assert_eq!(req09.compat_profile_id(), profile);
}

#[test]
fn req02_standard_outbound_boundary_public_consumer_covers_standard_shapes() {
    let long_exec = "E".repeat(70_000);
    let long_patch =
        "*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-old\n+new\n*** End Patch\n";
    let long_mcp = "M".repeat(70_000);
    let chat_raw = json!({
        "model": "client-route-alias",
        "messages": [{"role": "user", "content": "hello"}],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "description": long_exec,
                    "parameters": {"type": "object"}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "apply_patch",
                    "description": long_patch,
                    "parameters": {"type": "object"}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "mcp.search__find",
                    "description": long_mcp,
                    "parameters": {"type": "object"}
                }
            }
        ],
        "stream": false
    });
    let req07 = build_req07(
        V3HubEntryProtocol::OpenAiChat,
        chat_raw,
        V3HubProviderWireProtocol::OpenAiChat,
        |selected| {
            selected.web_search_execution_mode =
                V3WebSearchExecutionMode::MetadataCenterLocalSearch;
            selected.model_capabilities.push("web_search".to_string());
        },
    )
    .expect("standard OpenAI Chat projection must be constructible");
    let standard = req07.standard_payload();
    assert_eq!(standard["model"], "req02-wire-model");
    assert_eq!(standard["messages"][0]["role"], "user");
    let tools = standard["tools"].to_string();
    assert!(tools.contains("exec_command"), "{tools}");
    assert!(tools.contains("apply_patch"), "{tools}");
    assert!(tools.contains("mcp.search__find"), "{tools}");
    assert!(tools.contains(&long_exec), "exec bytes must survive");
    assert!(
        tools.contains(&long_patch.replace('\n', "\\n")),
        "patch bytes must survive"
    );
    assert!(tools.contains(&long_mcp), "MCP bytes must survive");
    complete_public_wire_pipeline(req07);

    let responses_raw = json!({
        "model": "client-route-alias",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}]
        }],
        "stream": false
    });
    let responses_req07 = build_req07(
        V3HubEntryProtocol::Responses,
        responses_raw,
        V3HubProviderWireProtocol::Responses,
        |_selected| {},
    )
    .expect("standard Responses projection must be constructible");
    let responses_standard = responses_req07.standard_payload();
    assert_eq!(responses_standard["model"], "req02-wire-model");
    assert!(
        responses_standard["input"].is_array(),
        "{responses_standard}"
    );
    assert!(responses_standard.get("messages").is_none());
    complete_public_wire_pipeline(responses_req07);

    let anthropic_raw = json!({
        "model": "client-route-alias",
        "messages": [{"role": "user", "content": "hello"}],
        "stream": false
    });
    let anthropic_req07 = build_req07(
        V3HubEntryProtocol::Anthropic,
        anthropic_raw,
        V3HubProviderWireProtocol::Anthropic,
        |_selected| {},
    )
    .expect("standard Anthropic projection must be constructible");
    let anthropic_standard = anthropic_req07.standard_payload();
    assert_eq!(anthropic_standard["model"], "req02-wire-model");
    assert_eq!(anthropic_standard["messages"][0]["role"], "user");
    complete_public_wire_pipeline(anthropic_req07);

    let gemini_raw = json!({
        "model": "client-route-alias",
        "messages": [{"role": "user", "content": "hello"}],
        "reasoning_effort": "high",
        "stream": false
    });
    let gemini_req07 = build_req07(
        V3HubEntryProtocol::OpenAiChat,
        gemini_raw,
        V3HubProviderWireProtocol::Gemini,
        |selected| {
            selected.model_capabilities.push("reasoning".to_string());
        },
    )
    .expect("native-compatible Gemini projection must be constructible");
    let gemini_standard = gemini_req07.standard_payload();
    assert!(gemini_standard.get("model").is_none());
    assert_eq!(
        gemini_req07.attempt_context().projection.provider_model,
        "req02-standard-model"
    );
    assert_eq!(
        gemini_standard["contents"],
        json!([{"role":"user","parts":[{"text":"hello"}]}])
    );
    assert_eq!(
        gemini_standard["generationConfig"]["thinkingConfig"]["thinkingLevel"],
        "HIGH"
    );
    assert!(gemini_standard.get("stream").is_none());
    complete_public_wire_pipeline(gemini_req07);
}

#[test]
fn req02_standard_outbound_boundary_reports_projection_failure_before_compat() {
    let error = build_req07(
        V3HubEntryProtocol::OpenAiChat,
        json!({
            "model": "client-route-alias",
            "messages": [{"role": "user", "content": "think"}],
            "reasoning_effort": "high",
            "stream": false
        }),
        V3HubProviderWireProtocol::Gemini,
        |_selected| {},
    )
    .expect_err("Gemini target without reasoning capability must fail during Req07 projection");

    assert!(
        error.contains("missing_capability=reasoning"),
        "projection error must remain explicit: {error}"
    );
}
