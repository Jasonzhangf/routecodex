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
fn provider_header_timeout_reason_is_canonical_health_neutral_hang() {
    let reason = format!(
        "{} (30000ms)",
        V3_PROVIDER_RESPONSE_HEADER_TIMEOUT_REASON_PREFIX
    );
    assert!(is_v3_provider_response_header_timeout_reason(&reason));
    assert!(!is_v3_provider_response_header_timeout_reason(
        "connection reset by peer"
    ));
    for stage in [
        "V3Transport13ResponsesHttpRequest",
        "V3ProviderReqOutbound09TransportRequest",
    ] {
        assert!(is_v3_retryable_transient_stage_code(
            stage,
            V3_TRANSIENT_TRANSPORT_HANG_CODE
        ));
    }
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
fn post_commit_sse_recovery_only_allows_declared_transient_sources() {
    let transient =
        raise_v3_sse_provider_failure("provider_response_sse_stream", "provider stream ended");
    assert!(is_v3_sse_recoverable_disconnect_source(&transient));

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

fn exhausted_provider_error_05(code: &str) -> V3Error05TerminalDecision {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        code,
        "provider failure",
    );
    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    let action = build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        V3ErrorActionScope::None,
        0,
    );
    let exhaustion = build_v3_error_04_target_exhaustion_decision_with_provider_availability(
        action, 0, false, false,
    );
    build_v3_error_05_execution_decision_from_v3_error_04(exhaustion, None)
        .try_into_terminal()
        .expect("terminal provider failure")
}

#[test]
fn provider_terminal_keeps_real_429_evidence_internal() {
    let body = br#"{"error":{"type":"rate_limit_error","message":"retry"}}"#.to_vec();
    let witness = V3ExternalHttpWitness::new(
        429,
        vec![("retry-after".to_string(), b"7".to_vec())],
        body.clone(),
    );
    assert_eq!(
        V3ErrorHandlingCenter::provider_terminal_disposition(
            exhausted_provider_error_05("provider_transport_failed"),
            Some(witness),
        ),
        V3ProviderTerminalDisposition::ExternalHttp(V3ExternalHttpWitness::new(
            429,
            vec![("retry-after".to_string(), b"7".to_vec())],
            body,
        ))
    );
}

#[test]
fn provider_terminal_without_real_http_response_is_no_response() {
    assert_eq!(
        V3ErrorHandlingCenter::provider_terminal_disposition(
            exhausted_provider_error_05("provider_transport_failed"),
            None,
        ),
        V3ProviderTerminalDisposition::NoResponse
    );
}

#[test]
fn exhausted_semantic_failure_never_projects_an_error_to_the_client() {
    // A provider that returned HTTP 2xx but whose payload cannot be represented
    // is a provider-attempt failure: it reselects a candidate while attempts
    // remain, and on exhaustion it terminates the client boundary without a
    // fabricated error. The client never receives the provider-derived Error06.
    assert_eq!(
        V3ErrorHandlingCenter::provider_terminal_disposition(
            exhausted_provider_error_05("provider_response_semantic_failure"),
            None,
        ),
        V3ProviderTerminalDisposition::NoResponse
    );
}

#[test]
fn real_upstream_502_and_2xx_are_recorded_as_evidence_without_client_projection() {
    // Bug `705d624` keeps an upstream 502 out of any client response, and a 2xx
    // terminal is still a provider-attempt failure. Neither changes the fact
    // that a real upstream response was received: the witness records it
    // losslessly, and the disposition carries it as provider-private evidence.
    // Client projection is decided at the boundary, not by discarding evidence.
    let upstream_502 = V3ExternalHttpWitness::new(502, vec![], b"bad gateway".to_vec());
    assert_eq!(upstream_502.status(), 502);
    assert_eq!(upstream_502.body(), b"bad gateway");
    let terminal_2xx = V3ExternalHttpWitness::new(200, vec![], b"ok".to_vec());
    assert_eq!(terminal_2xx.status(), 200);
    assert_eq!(terminal_2xx.body(), b"ok");
    assert_eq!(terminal_2xx.body_read_failure(), None);
}

#[test]
fn body_read_failure_keeps_status_headers_and_records_the_failure() {
    // The response head is real even when the body read fails. Reporting this as
    // "no response" would assert an absence that did not happen and would drop
    // the status and headers that were actually received.
    let witness = V3ExternalHttpWitness::new(
        400,
        vec![("x-upstream".to_string(), b"1".to_vec())],
        Vec::new(),
    )
    .with_body_read_failure("truncated body");
    assert_eq!(witness.status(), 400);
    assert_eq!(witness.headers()[0].1, b"1");
    assert_eq!(witness.body_read_failure(), Some("truncated body"));
}

#[test]
fn provider_terminal_keeps_raw_header_bytes_without_utf8_projection() {
    let witness = V3ExternalHttpWitness::new(
        429,
        vec![("x-upstream".to_string(), vec![0x61, 0xff])],
        vec![],
    );
    assert_eq!(witness.headers()[0].1, vec![0x61, 0xff]);
    assert_eq!(witness.status(), 429);
    assert!(witness.body().is_empty());
}
