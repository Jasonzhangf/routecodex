use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    build_v3_error_01_source_raised_internal, build_v3_error_02_classified_from_v3_error_01,
    build_v3_error_06_client_projected_from_v3_error_05,
    build_v3_provider_failure_action_from_v3_error_02, is_v3_sse_recoverable_disconnect_source,
    v3_sse_post_commit_disposition, V3Error05ExecutionAction, V3Error05RecoveryAdmissionWitness,
    V3ErrorActionScope, V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ExternalErrorKind, V3ExternalErrorLink, V3ExternalHttpWitness, V3InternalErrorCode,
    V3ProviderFailureSessionScope, V3ProviderHealthScope, V3ProviderRecoveryKind,
    V3ProviderTerminalDisposition, V3SsePostCommitDisposition,
};

fn local_source() -> routecodex_v3_error::V3Error01SourceRaised {
    build_v3_error_01_source_raised_internal(
        V3ErrorSourceKind::ProviderLocalFailure,
        "V3Transport13ResponsesHttpRequest",
        "invalid_base_url",
        "selected provider base URL is invalid",
        V3InternalErrorCode::V3Transport13ResponsesHttpRequest,
    )
}

fn recovery_witness() -> V3Error05RecoveryAdmissionWitness {
    V3Error05RecoveryAdmissionWitness::new(
        V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
            .expect("valid provider failure session scope"),
        "provider-a:key-a:model-a",
        "invalid_base_url",
        7,
    )
    .expect("valid Error05 recovery witness")
}

#[test]
fn provider_local_failure_uses_internal_identity_and_forbids_external_link() {
    let source = local_source();
    assert_eq!(source.source_kind, V3ErrorSourceKind::ProviderLocalFailure);
    assert_eq!(
        source
            .internal_error
            .as_ref()
            .map(|internal| internal.internal_code),
        Some("500-160")
    );
    assert!(source.external_error.is_none());

    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    assert_eq!(classified.class, "provider_local_failure");
    assert_eq!(
        classified.terminal_state,
        "non_terminal_if_candidates_remain"
    );
    assert_eq!(
        classified.source.source_kind,
        V3ErrorSourceKind::ProviderLocalFailure
    );
    assert!(classified.source.external_error.is_none());

    let external_result = std::panic::catch_unwind(|| {
        build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderLocalFailure,
            "V3Transport13ResponsesHttpRequest",
            "invalid_base_url",
            "selected provider base URL is invalid",
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(502),
                code: Some("invalid_base_url".to_string()),
                provider_id: Some("provider-a".to_string()),
                upstream_request_id: None,
                message: Some("selected provider base URL is invalid".to_string()),
            },
        )
    });
    assert!(
        external_result.is_err(),
        "ProviderLocalFailure must never carry an external provider link"
    );
}

#[test]
fn provider_local_failure_uses_existing_provider_health_action_classifier() {
    let classified = build_v3_error_02_classified_from_v3_error_01(local_source());
    let action = build_v3_provider_failure_action_from_v3_error_02(&classified);

    assert_eq!(action.class_code, "invalid_base_url");
    assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
    assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
    assert_eq!(action.score_delta_milli, -5);
    assert_eq!(action.failure_threshold, 1);
    assert_eq!(action.cooldown_ms, 5_000);
}

#[test]
fn provider_local_failure_reselects_with_real_witness_and_keeps_source() {
    let source = local_source();
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: source.clone(),
            action_scope: V3ErrorActionScope::CanonicalModel {
                provider_id: "provider-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 2,
            source_status: None,
        },
        false,
        false,
        Some(recovery_witness()),
    );

    let recovery = decision
        .action
        .recovery_witness()
        .expect("remaining candidate must return a recovery witness");
    assert!(matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenReselect { .. }
    ));
    assert_eq!(
        recovery.provider_runtime_identity(),
        "provider-a:key-a:model-a"
    );
    assert_eq!(recovery.normalized_error_family(), "invalid_base_url");
    assert_eq!(recovery.generation(), 7);
    assert_eq!(decision.exhaustion.route_pool_remaining_after_exclusion, 2);
    assert!(!decision.exhaustion.target_exhausted);
    assert_eq!(
        decision
            .exhaustion
            .local_action
            .classified
            .source
            .source_kind,
        V3ErrorSourceKind::ProviderLocalFailure
    );
    assert_eq!(
        decision.exhaustion.local_action.classified.source, source,
        "the exact typed source must stay unchanged across Error02-Error05"
    );
}

#[test]
fn provider_local_failure_exhaustion_is_terminal_598_without_network_error_substitution() {
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: local_source(),
            action_scope: V3ErrorActionScope::CanonicalModel {
                provider_id: "provider-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 0,
            source_status: None,
        },
        false,
        false,
        None,
    );

    assert!(matches!(
        decision.action,
        V3Error05ExecutionAction::ProjectTerminal
    ));
    assert!(decision.exhaustion.target_exhausted);
    let terminal = decision
        .try_into_terminal()
        .expect("actual route and default exhaustion is terminal");
    let projected = build_v3_error_06_client_projected_from_v3_error_05(terminal);

    assert_eq!(projected.status, 598);
    assert!(!projected.pool_exhausted);
    assert_eq!(projected.body["error"]["code"], "invalid_base_url");
    assert_eq!(
        projected.body["error"]["message"],
        "selected provider base URL is invalid"
    );
    assert_ne!(projected.body["error"]["code"], "network_error");
    assert_ne!(projected.body["error"]["message"], "network error");
}

#[test]
fn provider_local_failure_terminal_guard_refuses_missing_exhaustion_facts() {
    let mut decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: local_source(),
            action_scope: V3ErrorActionScope::CanonicalModel {
                provider_id: "provider-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 1,
            source_status: None,
        },
        false,
        false,
        Some(recovery_witness()),
    );
    decision.action = V3Error05ExecutionAction::ProjectTerminal;

    assert!(
        decision.clone().try_into_terminal().is_err(),
        "a local terminal with remaining candidates must be rejected"
    );

    let mut default_available = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: local_source(),
            action_scope: V3ErrorActionScope::CanonicalModel {
                provider_id: "provider-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 0,
            source_status: None,
        },
        true,
        false,
        Some(recovery_witness()),
    );
    default_available.action = V3Error05ExecutionAction::ProjectTerminal;
    assert!(
        default_available.try_into_terminal().is_err(),
        "a local terminal with a default pool candidate must be rejected"
    );
}

#[test]
fn provider_local_failure_terminal_disposition_has_no_external_witness() {
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: local_source(),
            action_scope: V3ErrorActionScope::CanonicalModel {
                provider_id: "provider-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 0,
            source_status: None,
        },
        false,
        false,
        None,
    );
    let terminal = decision
        .clone()
        .try_into_terminal()
        .expect("actual exhaustion is terminal");

    assert_eq!(
        V3ErrorHandlingCenter::provider_terminal_disposition(terminal, None),
        V3ProviderTerminalDisposition::NoResponse
    );

    let terminal = decision
        .try_into_terminal()
        .expect("actual exhaustion is terminal");
    let result = std::panic::catch_unwind(|| {
        V3ErrorHandlingCenter::provider_terminal_disposition(
            terminal,
            Some(V3ExternalHttpWitness::new(
                502,
                Vec::new(),
                b"not local".to_vec(),
            )),
        )
    });
    assert!(
        result.is_err(),
        "ProviderLocalFailure must reject a fabricated external witness"
    );
}

#[test]
fn provider_local_failure_cannot_use_generic_handle_to_bypass_availability_proof() {
    let result = std::panic::catch_unwind(|| {
        V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
            source: local_source(),
            action_scope: V3ErrorActionScope::CanonicalModel {
                provider_id: "provider-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 0,
            source_status: None,
        })
    });

    assert!(result.is_err());
}

#[test]
fn provider_local_failure_post_commit_projection_keeps_internal_598_and_original_code() {
    let source = local_source();
    assert_eq!(
        v3_sse_post_commit_disposition(&source),
        V3SsePostCommitDisposition::ProjectInternalTerminal
    );
    assert!(!is_v3_sse_recoverable_disconnect_source(&source));
    let projected = routecodex_v3_error::project_v3_post_commit_sse_source(source, 598);

    assert_eq!(projected.status, 598);
    assert_eq!(projected.body["error"]["code"], "invalid_base_url");
    assert_ne!(projected.body["error"]["code"], "network_error");
}

#[test]
fn actual_provider_failure_remains_external_and_pool_exhausted() {
    let source = build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_http_502",
        "upstream failed",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(502),
            code: Some("provider_http_502".to_string()),
            provider_id: Some("provider-a".to_string()),
            upstream_request_id: None,
            message: Some("upstream failed".to_string()),
        },
    );
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source,
            action_scope: V3ErrorActionScope::CanonicalModel {
                provider_id: "provider-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 0,
            source_status: Some(502),
        },
        false,
        false,
        None,
    );
    let terminal = decision
        .try_into_terminal()
        .expect("provider failure exhaustion remains terminal");
    let projected = build_v3_error_06_client_projected_from_v3_error_05(terminal);

    assert_eq!(projected.status, 502);
    assert!(projected.pool_exhausted);
    assert_eq!(projected.body["error"]["code"], "network_error");
    assert_eq!(projected.body["error"]["message"], "network error");
}

#[test]
fn runtime_failure_and_client_disconnect_keep_their_terminal_behavior() {
    let runtime = build_v3_error_01_source_raised_internal(
        V3ErrorSourceKind::RuntimeFailure,
        "V3Transport13ResponsesHttpRequest",
        "runtime_infrastructure_failure",
        "runtime infrastructure failed",
        V3InternalErrorCode::V3Transport13ResponsesHttpRequest,
    );
    let runtime_decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: runtime,
            action_scope: V3ErrorActionScope::None,
            candidates_remaining: 0,
            source_status: None,
        },
        false,
        false,
        None,
    );
    assert!(matches!(
        runtime_decision.action,
        V3Error05ExecutionAction::RejectNonProviderError
    ));
    let runtime_terminal = runtime_decision
        .try_into_terminal()
        .expect("RuntimeFailure remains terminal");
    let runtime_projected = build_v3_error_06_client_projected_from_v3_error_05(runtime_terminal);
    assert_eq!(runtime_projected.status, 598);
    assert_eq!(
        runtime_projected.body["error"]["code"],
        "runtime_infrastructure_failure"
    );

    let client_disconnect = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ClientDisconnect,
        "V3ServerRespOutbound06ClientFrame",
        "client_disconnect",
        "client disconnected",
    );
    let disconnect_decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: client_disconnect,
            action_scope: V3ErrorActionScope::None,
            candidates_remaining: 0,
            source_status: Some(499),
        },
        false,
        false,
        None,
    );
    assert!(matches!(
        disconnect_decision.action,
        V3Error05ExecutionAction::ClientDisconnected
    ));
    let disconnect_terminal = disconnect_decision
        .try_into_terminal()
        .expect("ClientDisconnect remains terminal");
    let disconnect_projected =
        build_v3_error_06_client_projected_from_v3_error_05(disconnect_terminal);
    assert_eq!(disconnect_projected.status, 499);
}
