use super::*;
use serde_json::Value;

pub(crate) async fn execute_v3_responses_relay_dry_run_runtime(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_relay_dry_run_runtime_inner(manifest, input, None, None, None)
        .await
        .into_foundation()
}

pub async fn execute_v3_responses_relay_dry_run_runtime_with_server_tool_state(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    server_tool_state: &V3ResponsesRelayServerToolState,
    scope: V3ResponsesRelayServerToolScope,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_relay_dry_run_runtime_inner(
        manifest,
        input,
        Some(V3ResponsesRelayServerToolExecution {
            control: server_tool_state,
            scope,
            commit_effects: false,
        }),
        None,
        None,
    )
    .await
    .into_foundation()
}

pub(crate) async fn execute_v3_responses_relay_dry_run_runtime_with_server_tool_state_and_initial_target(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    server_tool_state: &V3ResponsesRelayServerToolState,
    scope: V3ResponsesRelayServerToolScope,
    initial_selected_target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    initial_expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_relay_dry_run_runtime_inner(
        manifest,
        input,
        Some(V3ResponsesRelayServerToolExecution {
            control: server_tool_state,
            scope,
            commit_effects: false,
        }),
        Some(initial_selected_target),
        Some(initial_expanded),
    )
    .await
    .into_foundation()
}

pub async fn execute_v3_responses_relay_dry_run_orchestration_outcome_with_server_tool_state(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    server_tool_state: &V3ResponsesRelayServerToolState,
    scope: V3ResponsesRelayServerToolScope,
) -> V3ResponsesRelayDryRunOutcome {
    execute_v3_responses_relay_dry_run_runtime_inner(
        manifest,
        input,
        Some(V3ResponsesRelayServerToolExecution {
            control: server_tool_state,
            scope,
            commit_effects: false,
        }),
        None,
        None,
    )
    .await
}

pub(crate) async fn execute_v3_responses_relay_dry_run_runtime_inner(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    server_tool_state: Option<V3ResponsesRelayServerToolExecution<'_>>,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
) -> V3ResponsesRelayDryRunOutcome {
    let captured_provider_request = Arc::new(Mutex::new(None));
    let transport = V3ProviderRequestDryRunNoNetworkTransport::new(
        json!({
            "object": "routecodex.provider_request_dry_run_terminal",
            "terminal_effect": "no_network_send",
            "provider_network_send": false,
            "message": "routecodex provider-request dry-run stopped before provider send"
        }),
        Arc::clone(&captured_provider_request),
    );
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(manifest);
    let initial_selected_target_for_failure = initial_selected_target.clone();
    let mut output = match execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        &transport,
        server_tool_state,
        provider_health.runtime_health(),
        V3ResponsesRelayRetryPolicy::from_manifest(manifest),
        false,
        None,
        None,
        initial_selected_target.clone(),
        initial_expanded,
        BTreeSet::new(),
        V3ResponsesRelayRuntimeSeeds::default(),
    )
    .await
    {
        Ok(output) => output,
        Err(error) => project_v3_responses_relay_runtime_failure(
            error,
            initial_selected_target_for_failure.as_ref().map(|target| {
                super::relay_runtime_shared::build_v3_relay_observability(
                    "responses",
                    target,
                    "json",
                )
            }),
        ),
    };
    if let Some(handoff) = output.protocol_direct_handoff.take() {
        return V3ResponsesRelayDryRunOutcome::DirectHandoff(handoff);
    }
    if let Some(index) = output
        .node_trace
        .iter()
        .position(|node| *node == "V3ProviderReqOutbound09TransportRequest")
    {
        output
            .node_trace
            .insert(index + 1, "V3DryRunNoNetworkTerminalEffect");
    }
    output.node_trace.push("V3Server16HttpFrame");
    let provider_request = captured_provider_request
        .lock()
        .ok()
        .and_then(|captured| captured.clone())
        .unwrap_or(Value::Null);
    let dry_run_status = if provider_request.is_null() {
        output.status
    } else {
        200
    };
    let response_payload = json!({
        "object": "routecodex.provider_request_dry_run_terminal",
        "terminal_effect": "no_network_send",
        "provider_network_send": false,
        "message": "routecodex provider-request dry-run stopped before provider send"
    });
    V3ResponsesRelayDryRunOutcome::Foundation(crate::V3FoundationRuntimeOutput {
        status: dry_run_status,
        body: json!({
            "object": "routecodex.pipeline_dry_run",
            "kind": "provider_request",
            "dryRun": true,
            "evidence": {
                "stoppedBeforeProviderSend": true,
                "providerNetworkSend": false,
                "stoppedBeforeNetworkSend": true,
                "providerRequestCaptured": !provider_request.is_null()
            },
            "providerRequest": provider_request,
            "dry_run": {
                "fixture_id": "responses_relay_provider_request",
                "server_id": "responses_relay",
                "method": "POST",
                "path": "/v1/responses",
                "terminal_effect": "no_network_send",
                "provider_pipeline_executed": true,
                "provider_network_send": false,
                "stopped_before_network_send": true,
                "stopped_before_provider_send": true,
                "provider_request": provider_request,
                "node_ids": output.node_trace,
                "snapshots": [],
                "response_payload": response_payload
            }
        }),
        debug_node: "V3DryRunNoNetworkTerminalEffect",
        error_node: output
            .error_chain
            .as_ref()
            .map_or("none", |_| "V3Error06ClientProjected"),
        error_chain: output.error_chain.unwrap_or_default(),
        node_trace: output.node_trace,
        stopped_before_provider_send: true,
        diagnostic_source: output.diagnostic_source,
        diagnostic_cause: output.diagnostic_cause,
    })
}

pub fn project_v3_responses_relay_runtime_failure(
    error: V3ResponsesRelayRuntimeError,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesRelayRuntimeOutput {
    match error {
        error => {
            let (source, status, terminal_disposition) = match error {
                V3ResponsesRelayRuntimeError::ProviderPoolExhausted {
                    attempted_candidates,
                } => (
                    provider_pool_exhausted_source(
                        "V3Target10ConcreteProviderSelected",
                        &attempted_candidates,
                    ),
                    502,
                    Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse),
                ),
                V3ResponsesRelayRuntimeError::Target(message) => (
                    crate::shared::direct_plain_error(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3HubRuntime",
                        "responses_relay_runtime_error",
                        message,
                    ),
                    500,
                    None,
                ),
                V3ResponsesRelayRuntimeError::ClientInboundCanonical(message) => (
                    crate::shared::direct_plain_error(
                        V3ErrorSourceKind::InvalidRequest,
                        "V3HubReqInbound02Normalized",
                        "invalid_responses_request",
                        message,
                    ),
                    400,
                    None,
                ),
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(message) => (
                    crate::shared::direct_internal_error(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3ProviderResp14Raw",
                        "provider_response_sse_event_invalid",
                        message,
                        routecodex_v3_error::V3InternalErrorCode::V3ProviderResp14Raw,
                    ),
                    599,
                    None,
                ),
                V3ResponsesRelayRuntimeError::ExecutionControlResponse(message) => (
                    crate::shared::direct_plain_error(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3ServerRespOutbound06ClientFrame",
                        "responses_relay_response_execution_control_error",
                        message,
                    ),
                    599,
                    None,
                ),
                V3ResponsesRelayRuntimeError::WebSearchSidecarFailed {
                    call_id,
                    code,
                    message,
                    retryable: _,
                } => (
                    super::web_search_sidecar::web_search_sidecar_failure_source(
                        &call_id, code, &message,
                    ),
                    599,
                    None,
                ),
                error => {
                    let message = error.to_string();
                    (
                        crate::shared::direct_plain_error(
                            V3ErrorSourceKind::RuntimeFailure,
                            "V3HubRuntime",
                            "responses_relay_runtime_error",
                            message,
                        ),
                        500,
                        None,
                    )
                }
            };
            let mut output = match source {
                Ok(source) => error_output(source, status, "none", Vec::new(), observability, 0),
                Err(fault) => {
                    let mut output =
                        super::responses_relay_failures::local_error_output_from_projection(
                            Err(fault),
                            Vec::new(),
                            observability,
                        );
                    if let Some(terminal_disposition) = terminal_disposition {
                        output.terminal_disposition = Some(terminal_disposition);
                    }
                    return output;
                }
            };
            if let Some(terminal_disposition) = terminal_disposition {
                output.terminal_disposition = Some(terminal_disposition);
            }
            output
        }
    }
}
