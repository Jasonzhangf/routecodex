use super::*;

#[test]
fn pending_endpoint_uses_all_adjacent_typed_nodes() {
    let projected = project_v3_pending_endpoint_error(V3Debug01NodeEventRegistered {
        server_id: "srv".to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        node_id: "V3Debug01NodeEventRegistered",
    });
    assert_eq!(projected.status, 501);
    assert_eq!(projected.chain, V3_ERROR_CHAIN_NODE_IDS);
    assert_eq!(projected.body["error"]["code"], "not_implemented");
    assert!(projected.health_action.is_none());
}

#[test]
fn sse_closeout_client_disconnect_is_raised_at_client_frame_boundary() {
    let source = raise_v3_sse_client_disconnect();

    assert_eq!(source.source_kind, V3ErrorSourceKind::ClientDisconnect);
    assert_eq!(source.code, "client_disconnect");
    assert_eq!(source.source_stage, "V3ServerRespOutbound06ClientFrame");
}

#[test]
fn sse_closeout_provider_failure_is_raised_by_error_owner() {
    let source = raise_v3_sse_provider_failure("provider_response_sse_stream", "provider broke");

    assert_eq!(source.source_kind, V3ErrorSourceKind::ProviderFailure);
    assert_eq!(source.source_stage, "V3ProviderRespInbound01Raw");
    assert_eq!(source.code, "provider_response_sse_stream");
    assert_eq!(source.message, "provider broke");
}

#[test]
fn sse_runtime_failure_projects_through_the_complete_error_chain() {
    let projected = project_v3_post_commit_sse_source(
        raise_v3_sse_runtime_failure(
            "V3ServerRespOutbound05ClientFrame",
            "front_sse_response_empty",
            "empty response",
        ),
        599,
    );
    assert_eq!(projected.status, 599);
    assert_eq!(projected.chain, V3_ERROR_CHAIN_NODE_IDS);
    assert_eq!(projected.body["error"]["code"], "front_sse_response_empty");
}

#[test]
fn server_side_failures_are_raised_by_error_owner() {
    let debug = raise_v3_debug_artifact_failure("disk full");
    assert_eq!(debug.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert_eq!(debug.source_stage, "V3DebugArtifact");
    assert_eq!(debug.code, "codex_sample_persistence_failed");
    assert_eq!(
        debug
            .internal_error
            .as_ref()
            .map(|internal| internal.internal_code),
        Some("500-300")
    );

    let observability = raise_v3_runtime_observability_contract_failure("missing terminal");
    assert_eq!(observability.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert_eq!(observability.source_stage, "V3RuntimeObservability");
    assert_eq!(observability.code, "runtime_observability_contract");
}

#[test]
fn transient_stage_code_classifier_accepts_stream_and_header_hang_failures() {
    assert!(is_v3_retryable_transient_stage_code(
        "V3ProviderRespInbound01Raw",
        "provider_response_sse_stream"
    ));
    assert!(is_v3_retryable_transient_stage_code(
        "V3ProviderReqOutbound09TransportRequest",
        V3_TRANSIENT_TRANSPORT_HANG_CODE
    ));
}

#[test]
fn transient_stage_code_classifier_rejects_http_and_non_provider_failures() {
    assert!(!is_v3_retryable_transient_stage_code(
        "V3ProviderRespInbound01Raw",
        "provider_http_502"
    ));
    assert!(!is_v3_retryable_transient_stage_code(
        "V3ProviderReqOutbound09TransportRequest",
        "provider_connect_failed"
    ));
    assert!(!is_v3_retryable_transient_stage_code(
        "V3ServerRespOutbound06ClientFrame",
        "provider_response_sse_stream"
    ));
}

#[test]
fn post_commit_sse_recovery_only_allows_a_real_client_disconnect() {
    let transient =
        raise_v3_sse_provider_failure("provider_response_sse_stream", "provider stream ended");
    assert!(!is_v3_sse_recoverable_disconnect_source(&transient));

    let http = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_http_429",
        "rate limited",
    );
    assert!(!is_v3_sse_recoverable_disconnect_source(&http));
    assert_eq!(
        v3_sse_post_commit_disposition(&http),
        V3SsePostCommitDisposition::ProjectInternalTerminal
    );

    let disconnect = raise_v3_sse_client_disconnect();
    assert!(is_v3_sse_recoverable_disconnect_source(&disconnect));
}

#[test]
fn post_commit_provider_failure_always_projects_a_typed_terminal_on_the_affected_session() {
    // Regression 7a7f58e: an in-band provider failure after commit used to be
    // classified as a recoverable close. The server then ended the client body
    // at EOF with no protocol terminal, so the affected session never reached a
    // terminal state again while a brand new session still worked. A provider
    // error must project a typed terminal; only a real client disconnect may
    // close the stream.
    let in_band = raise_v3_sse_provider_failure(
        "provider_response_sse_stream",
        "provider stream ended without terminal",
    );
    assert_eq!(
        v3_sse_post_commit_disposition(&in_band),
        V3SsePostCommitDisposition::ProjectInternalTerminal
    );

    let provider_http = build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_http_400",
        "provider returned 400",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(400),
            code: Some("HTTP_400".to_string()),
            provider_id: Some("provider-a".to_string()),
            upstream_request_id: None,
            message: Some("context_length_exceeded".to_string()),
        },
    );
    assert_eq!(
        v3_sse_post_commit_disposition(&provider_http),
        V3SsePostCommitDisposition::ProjectInternalTerminal
    );

    // Control case: a genuine client disconnect still closes the stream without
    // fabricating a provider success or an internal failure terminal.
    let disconnect = raise_v3_sse_client_disconnect();
    assert_eq!(
        v3_sse_post_commit_disposition(&disconnect),
        V3SsePostCommitDisposition::CloseEof
    );
}

#[test]
fn post_commit_provider_failure_terminal_is_independent_per_session() {
    // Control case: the typed terminal of one affected session source must not
    // depend on, or leak into, an independent session's disposition.
    let affected = raise_v3_sse_provider_failure(
        "provider_response_sse_stream",
        "session a provider stream ended",
    );
    let independent = raise_v3_sse_runtime_failure(
        "V3ServerRespOutbound06ClientFrame",
        "internal_response_stream_error",
        "session b internal stream failed",
    );
    assert_eq!(
        v3_sse_post_commit_disposition(&affected),
        V3SsePostCommitDisposition::ProjectInternalTerminal
    );
    assert_eq!(
        v3_sse_post_commit_disposition(&independent),
        V3SsePostCommitDisposition::ProjectInternalTerminal
    );
}

fn provider_error_05(
    code: &str,
    stage: &'static str,
    same_retry: bool,
) -> V3Error05ExecutionDecision {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        stage,
        code,
        "provider failure",
    );
    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    let action = build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        V3ErrorActionScope::ProviderInstance {
            provider_id: "minimax".to_string(),
        },
        1,
    );
    let exhaustion = build_v3_error_04_target_exhaustion_decision_with_provider_availability(
        action, 1, false, same_retry,
    );
    let witness = V3Error05RecoveryAdmissionWitness::new(
        V3ProviderFailureSessionScope::new("server", "group", "session").expect("scope"),
        "minimax:key1:model",
        code,
        1,
    )
    .expect("witness");
    build_v3_error_05_execution_decision_from_v3_error_04(exhaustion, Some(witness))
}

#[test]
fn provider_http_errors_reselect_when_route_pool_remains() {
    for code in [
        "provider_http_401",
        "provider_http_429",
        "provider_http_502",
    ] {
        let decision = provider_error_05(code, "V3ProviderRespInbound01Raw", false);
        assert!(
            matches!(
                decision.action,
                V3Error05ExecutionAction::WaitThenReselect { .. }
            ),
            "{code} must reselect"
        );
    }
}

#[test]
fn transient_stream_failures_reselect_even_when_same_provider_budget_is_reported() {
    for (code, stage) in [
        ("provider_response_sse_stream", "V3ProviderRespInbound01Raw"),
        (
            V3_TRANSIENT_TRANSPORT_HANG_CODE,
            "V3ProviderReqOutbound09TransportRequest",
        ),
    ] {
        let decision = provider_error_05(code, stage, true);
        assert!(
            matches!(
                decision.action,
                V3Error05ExecutionAction::WaitThenReselect { .. }
            ),
            "{code} must switch candidates instead of retrying the same provider"
        );
    }
}
