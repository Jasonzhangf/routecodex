use super::*;
use serde_json::Value;

pub(crate) async fn execute_v3_responses_relay_dry_run_runtime(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
) -> crate::V3FoundationRuntimeOutput {
    execute_v3_responses_relay_dry_run_runtime_inner(manifest, input, None, None, None, None)
        .await
        .into_foundation()
}

pub async fn execute_v3_responses_relay_dry_run_runtime_with_local_continuation(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    state: &V3ResponsesRelayLocalContinuationState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> crate::V3FoundationRuntimeOutput {
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let stopless_scope = V3ResponsesRelayStoplessControlScope::from(&scope);
    execute_v3_responses_relay_dry_run_runtime_inner(
        manifest,
        input,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
            commit_resp04_effects: false,
        }),
        Some(V3ResponsesRelayStoplessControlExecution {
            control: &stopless_control,
            scope: stopless_scope,
            commit_effects: false,
        }),
        None,
        None,
    )
    .await
    .into_foundation()
}

pub async fn execute_v3_responses_relay_dry_run_runtime_with_local_continuation_and_stopless_control(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    state: &V3ResponsesRelayLocalContinuationState,
    stopless_control: &V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> crate::V3FoundationRuntimeOutput {
    let stopless_scope = V3ResponsesRelayStoplessControlScope::from(&scope);
    execute_v3_responses_relay_dry_run_runtime_inner(
        manifest,
        input,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
            commit_resp04_effects: false,
        }),
        Some(V3ResponsesRelayStoplessControlExecution {
            control: stopless_control,
            scope: stopless_scope,
            commit_effects: false,
        }),
        None,
        None,
    )
    .await
    .into_foundation()
}

pub(crate) async fn execute_v3_responses_relay_dry_run_runtime_with_local_continuation_stopless_control_and_initial_target(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    state: &V3ResponsesRelayLocalContinuationState,
    stopless_control: &V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
    initial_selected_target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    initial_expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
) -> crate::V3FoundationRuntimeOutput {
    let stopless_scope = V3ResponsesRelayStoplessControlScope::from(&scope);
    execute_v3_responses_relay_dry_run_runtime_inner(
        manifest,
        input,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
            commit_resp04_effects: false,
        }),
        Some(V3ResponsesRelayStoplessControlExecution {
            control: stopless_control,
            scope: stopless_scope,
            commit_effects: false,
        }),
        Some(initial_selected_target),
        Some(initial_expanded),
    )
    .await
    .into_foundation()
}

pub async fn execute_v3_responses_relay_dry_run_orchestration_outcome_with_local_continuation_and_stopless_control(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
    state: &V3ResponsesRelayLocalContinuationState,
    stopless_control: &V3ResponsesRelayStoplessControlState,
    scope: V3ResponsesRelayLocalContinuationScope,
    now_epoch_ms: u64,
) -> V3ResponsesRelayDryRunOutcome {
    let stopless_scope = V3ResponsesRelayStoplessControlScope::from(&scope);
    execute_v3_responses_relay_dry_run_runtime_inner(
        manifest,
        input,
        Some(V3ResponsesRelayLocalContinuationExecution {
            state,
            scope,
            now_epoch_ms,
            commit_resp04_effects: false,
        }),
        Some(V3ResponsesRelayStoplessControlExecution {
            control: stopless_control,
            scope: stopless_scope,
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
    local: Option<V3ResponsesRelayLocalContinuationExecution<'_>>,
    stopless_control: Option<V3ResponsesRelayStoplessControlExecution<'_>>,
    initial_selected_target: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected>,
    initial_expanded: Option<routecodex_v3_target::V3Target09CandidateSetExpanded>,
) -> V3ResponsesRelayDryRunOutcome {
    let captured_provider_request = Arc::new(Mutex::new(None));
    let transport = V3ProviderRequestDryRunNoNetworkTransport::new(
        json!({
            "object": "routecodex.provider_request_dry_run_terminal",
            "terminal_effect": "no_network_send",
            "provider_network_send": false,
            "continuation": {
                "owner": "none",
                "continuable": false
            },
            "message": "routecodex provider-request dry-run stopped before provider send"
        }),
        Arc::clone(&captured_provider_request),
    );
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(manifest);
    let mut output = match execute_v3_responses_relay_runtime_inner(
        manifest,
        input,
        &transport,
        local,
        stopless_control,
        provider_health.runtime_health(),
        V3ResponsesRelayRetryPolicy::from_manifest(manifest),
        None,
        None,
        initial_selected_target,
        initial_expanded,
        BTreeSet::new(),
        None,
    )
    .await
    {
        Ok(output) => output,
        Err(error) => project_v3_responses_relay_runtime_failure(error),
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
        "continuation": {
            "owner": "none",
            "continuable": false
        },
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
    })
}

pub fn project_v3_responses_relay_runtime_failure(
    error: V3ResponsesRelayRuntimeError,
) -> V3ResponsesRelayRuntimeOutput {
    match error {
        V3ResponsesRelayRuntimeError::InboundCanonical(message) => {
            let source = build_v3_error_01_source_raised(
                V3ErrorSourceKind::InvalidRequest,
                "V3HubReqInbound02Normalized",
                "invalid_responses_request",
                V3ResponsesRelayRuntimeError::InboundCanonical(message).to_string(),
            );
            let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
                source: source.clone(),
                action_scope: V3ErrorActionScope::None,
                candidates_remaining: 0,
                source_status: None,
            });
            error_output(source, projected.status, "none", Vec::new(), None, 0)
        }
        V3ResponsesRelayRuntimeError::ModelNotFound(message) => {
            let source = build_v3_error_01_source_raised(
                V3ErrorSourceKind::ModelNotFound,
                "V3Target10ConcreteProviderSelected",
                "direct_model_not_found",
                message,
            );
            let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
                source: source.clone(),
                action_scope: V3ErrorActionScope::None,
                candidates_remaining: 0,
                source_status: None,
            });
            return V3ResponsesRelayRuntimeOutput {
                status: projected.status,
                client_body: V3ResponsesRelayClientBody::Json(projected.body),
                node_trace: vec!["V3Error06ClientProjected"],
                error_chain: Some(vec![
                    "V3Error01SourceRaised",
                    "V3Error02Classified",
                    "V3Error03TargetLocalAction",
                    "V3Error04TargetExhaustionDecision",
                    "V3Error05ExecutionDecision",
                    "V3Error06ClientProjected",
                ]),
                observability: None,
                stream_observation: None,
                finalized_response: None,
                provider_snapshots: None,
                protocol_direct_handoff: None,
            };
        }
        V3ResponsesRelayRuntimeError::Target(message) => {
            let source = build_v3_error_01_source_raised(
                V3ErrorSourceKind::TargetPoolExhausted,
                "V3Target10ConcreteProviderSelected",
                "selected_target_exhausted",
                message,
            );
            let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
                source: source.clone(),
                action_scope: V3ErrorActionScope::None,
                candidates_remaining: 0,
                source_status: None,
            });
            error_output(source, projected.status, "none", Vec::new(), None, 0)
        }
        error => {
            let message = error.to_string();
            let source = build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3HubRuntime",
                "responses_relay_runtime_error",
                message.clone(),
            );
            error_output(source, 500, "none", Vec::new(), None, 0)
        }
    }
}
