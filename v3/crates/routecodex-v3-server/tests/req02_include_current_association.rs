use routecodex_v3_config::{
    V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
};
use routecodex_v3_runtime::hub_v1::{
    build_provider_req_compat_06_from_v3_hub_req_outbound_07, V3HubExecutionMode,
    V3HubProviderWireProtocol,
};
use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_direct_request,
    project_canonical_request, CanonicalFieldEdit, CurrentFieldAssociations,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind, V3RequestContextHandle,
    V3TargetCandidate,
};
use routecodex_v3_runtime::{
    build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02,
    build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04,
    build_v3_hub_req_inbound_01_client_raw, build_v3_hub_req_inbound_02_from_request_invocation,
    build_v3_hub_req_outbound_07_from_v3_hub_req_target_06,
    build_v3_hub_req_target_06_from_v3_hub_req_execution_05,
    build_v3_provider_req_outbound_08_from_provider_req_compat_06,
    build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08,
    govern_v3_operation_runner_current_request_fields, V3HubEntryProtocol, V3HubInvocationSource,
    V3HubTargetResolution, V3HubTransportIntent,
};
use serde_json::{json, Value};

fn target(protocol: V3HubProviderWireProtocol) -> V3TargetCandidate {
    let provider_type = match protocol {
        V3HubProviderWireProtocol::Responses => "responses",
        V3HubProviderWireProtocol::OpenAiChat => "openai_chat",
        V3HubProviderWireProtocol::Anthropic => "anthropic",
        V3HubProviderWireProtocol::Gemini => "gemini",
    };
    V3TargetCandidate {
        provider_id: format!("req02-include-{provider_type}"),
        provider_type: provider_type.to_string(),
        auth_alias: "primary".to_string(),
        model_id: "req02-include-model".to_string(),
        wire_model: "req02-include-wire-model".to_string(),
        visible_model_ids: vec!["client-route-alias".to_string()],
        model_capabilities: vec!["text".to_string()],
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
        env_name: Some("REQ02_INCLUDE_KEY".to_string()),
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

fn normalize(
    request_id: &str,
    raw: Value,
) -> (
    V3RequestContextHandle,
    Value,
    routecodex_v3_runtime::operation_runner::RequestScopedContextPair,
) {
    let handle = V3RequestContextHandle::new(request_id.to_string(), "responses".to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    let captured =
        execute_v3_operation_runner_request_capture_client_json(raw).expect("public capture entry");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public normalize entry");
    let pair = handle.original_pair().expect("original inverse pair");
    (handle, canonical, pair)
}

fn project(
    canonical: &Value,
    pair: &routecodex_v3_runtime::operation_runner::RequestScopedContextPair,
    current: &CurrentFieldAssociations,
    provider_protocol: V3HubProviderWireProtocol,
) -> Result<Value, String> {
    project_canonical_request(
        canonical,
        &pair.inverse_context,
        current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        provider_protocol,
        &target(provider_protocol),
        "req02-include-attempt",
    )
    .map(|projection| projection.payload)
}

fn include_request() -> Value {
    json!({
        "model": "client-route-alias",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}]
        }],
        "include": ["reasoning.encrypted_content"],
        "stream": false
    })
}

#[test]
fn current_include_value_replaces_registered_source_without_touching_canonical_or_pair() {
    let (handle, canonical, pair) = normalize("req02-include-current", include_request());
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let original_canonical = canonical.clone();
    let original_pair = pair.clone();
    let (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Replace {
            path: "chat.routecodex_chat_extension.responses_request.include".to_string(),
            value: json!(["reasoning.encrypted_content", "client.updated"]),
        },
    )
    .expect("current include replacement is a supported canonical edit");
    let current_canonical = canonical.clone();

    let responses = project(
        &canonical,
        &pair,
        &current,
        V3HubProviderWireProtocol::Responses,
    )
    .expect("Responses projection");
    assert_eq!(
        responses["include"],
        json!(["reasoning.encrypted_content", "client.updated"])
    );
    assert_eq!(
        canonical, current_canonical,
        "standard projection must not mutate the current canonical"
    );

    let chat = project(
        &canonical,
        &pair,
        &current,
        V3HubProviderWireProtocol::OpenAiChat,
    )
    .expect("Chat projection must omit the selector, not reject it");
    assert!(chat.get("include").is_none(), "{chat}");
    assert_eq!(
        canonical, current_canonical,
        "omitting include downstream must not mutate the current canonical"
    );

    assert_eq!(handle.original_pair().unwrap(), original_pair);
    assert_ne!(current_canonical, original_canonical);
    assert_eq!(
        original_canonical["routecodex_chat_extension"]["responses_request"]["include"],
        json!(["reasoning.encrypted_content"])
    );
    assert_eq!(
        canonical["routecodex_chat_extension"]["responses_request"]["include"],
        json!(["reasoning.encrypted_content", "client.updated"])
    );
}

#[test]
fn removed_include_is_not_revived_and_unrelated_extension_siblings_survive() {
    let (_, canonical, pair) = normalize(
        "req02-include-remove",
        json!({
            "model": "client-route-alias",
            "input": [{"role": "user", "content": "hello"}],
            "include": ["reasoning.encrypted_content"],
            "store": true,
            "stream": false
        }),
    );
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.routecodex_chat_extension.responses_request.include".to_string(),
        },
    )
    .expect("current include removal is a supported canonical edit");
    assert!(canonical["routecodex_chat_extension"]["responses_request"]
        .get("include")
        .is_none());

    let responses = project(
        &canonical,
        &pair,
        &current,
        V3HubProviderWireProtocol::Responses,
    )
    .expect("Responses projection after removal");
    assert!(responses.get("include").is_none(), "{responses}");
    assert_eq!(responses["store"], true, "{responses}");
}

#[test]
fn no_include_baseline_keeps_existing_standard_wire_output() {
    let (_, with_include, pair) = normalize("req02-include-baseline", include_request());
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let mut without_include = with_include.clone();
    without_include["routecodex_chat_extension"]["responses_request"]
        .as_object_mut()
        .unwrap()
        .remove("include");

    let baseline = project(
        &without_include,
        &pair,
        &current,
        V3HubProviderWireProtocol::Responses,
    )
    .expect("Responses projection without include");
    assert!(
        baseline.get("include").is_none(),
        "no-include baseline gained a selector: {baseline}"
    );
    assert_eq!(baseline["input"][0]["content"][0]["text"], "hello");
}

#[test]
fn direct_inverse_still_restores_original_include() {
    let (_, canonical, pair) = normalize("req02-include-direct", include_request());
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let direct = project_canonical_direct_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
    )
    .expect("Direct inverse projection");
    assert_eq!(
        direct.payload["include"],
        json!(["reasoning.encrypted_content"])
    );
}

#[test]
fn public_drop_record_accounts_for_unsupported_include_at_standard_outbound() {
    let (_, canonical, pair) = normalize("req02-include-drop", include_request());
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let projection = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::OpenAiChat,
        &target(V3HubProviderWireProtocol::OpenAiChat),
        "req02-include-drop-attempt",
    )
    .expect("Chat standard projection");
    assert!(projection.payload.get("include").is_none());
    assert!(
        projection
            .drops
            .iter()
            .any(|drop| drop.json_path == "$.include"),
        "typed projection drops must account for include: {:?}",
        projection.drops
    );

    let handle = V3RequestContextHandle::new(
        "req02-include-public-pipeline".to_string(),
        "responses".to_string(),
    );
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "req02-include-public-pipeline-invocation".to_string(),
        "req02-include-public-pipeline-attempt".to_string(),
        RequestOriginKind::ClientEntry,
    );
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        include_request(),
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let req02 = build_v3_hub_req_inbound_02_from_request_invocation(req01, &invocation)
        .expect("public inbound boundary");
    let canonical =
        govern_v3_operation_runner_current_request_fields(req02.payload(), &invocation, &[])
            .expect("public current-field governance");
    let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02(req02);
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
        req05,
        V3HubTargetResolution::Routed,
        target(V3HubProviderWireProtocol::OpenAiChat),
    );
    let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        &canonical,
        &handle,
        V3HubExecutionMode::Relay,
        "req02-include-public-attempt",
        V3HubProviderWireProtocol::OpenAiChat,
    )
    .expect("public Req07 boundary");
    assert!(req07.standard_payload().get("include").is_none());
    let compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
        .expect("public provider compat boundary");
    let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(compat.node);
    let req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
    assert!(!req09.compat_profile_id().is_empty());
}
