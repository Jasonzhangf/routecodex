use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    build_v3_error_01_source_raised_internal, build_v3_error_02_classified_from_v3_error_01,
    build_v3_error_03_target_local_action_from_v3_error_02,
    build_v3_error_04_target_exhaustion_decision_with_provider_availability,
    build_v3_error_05_execution_decision_from_v3_error_04,
    build_v3_error_06_client_projected_from_v3_error_05, V3Error05ExecutionAction,
    V3Error05RecoveryAdmissionWitness, V3ErrorActionScope, V3ErrorHandlingCenter,
    V3ErrorHandlingCenterInput, V3ErrorSourceKind, V3ExternalErrorKind, V3ExternalErrorLink,
    V3HttpBoundaryErrorKind, V3InternalErrorCode, V3ProviderFailureSessionScope,
};

fn recovery_witness() -> V3Error05RecoveryAdmissionWitness {
    V3Error05RecoveryAdmissionWitness::new(
        V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
            .expect("valid provider failure session scope"),
        "provider-a:key-a:model-a",
        "provider_failure",
        1,
    )
    .expect("valid Error05 recovery witness")
}

fn project_exhausted_provider(
    source: routecodex_v3_error::V3Error01SourceRaised,
    action_scope: V3ErrorActionScope,
    source_status: Option<u16>,
) -> routecodex_v3_error::V3Error06ClientProjected {
    build_v3_error_06_client_projected_from_v3_error_05(
        V3ErrorHandlingCenter::decide_provider(
            V3ErrorHandlingCenterInput {
                source,
                action_scope,
                candidates_remaining: 0,
                source_status,
            },
            false,
            false,
            None,
        )
        .try_into_terminal()
        .expect("explicit route/default exhaustion proof must yield terminal Error05"),
    )
}

#[test]
fn error_handling_center_owns_error01_06_and_preserves_provider_error_status() {
    let source = build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        "rate_limit_error",
        "controlled rate limit",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(429),
            code: Some("rate_limit_error".to_string()),
            provider_id: Some("controlled".to_string()),
            upstream_request_id: None,
            message: Some("controlled rate limit".to_string()),
        },
    );
    let projected = project_exhausted_provider(
        source,
        V3ErrorActionScope::ProviderInstance {
            provider_id: "controlled".to_string(),
        },
        Some(429),
    );

    assert_eq!(projected.status, 429);
    assert_eq!(projected.body["error"]["code"], "rate_limit_error");
    assert!(
        projected.body["error"].get("error_node").is_none()
            && projected.body["error"].get("stage").is_none()
            && projected.body["error"].get("class").is_none()
            && projected.body["error"].get("decision").is_none()
            && projected.body["error"].get("target_exhausted").is_none()
            && projected.body["error"]
                .get("candidates_remaining")
                .is_none()
            && projected.body["error"]
                .get("route_pool_remaining_after_exclusion")
                .is_none()
            && projected.body["error"]
                .get("default_pool_available")
                .is_none()
            && projected.body["error"].get("external_error").is_none()
            && projected.body["error"].get("internal_code").is_none(),
        "Error06 body must not carry control-plane fields: {}",
        projected.body["error"]
    );
    assert_eq!(projected.chain.len(), 6);
}

#[test]
fn error_handling_center_never_projects_an_error_as_http_success() {
    let source = build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        "provider_business_error",
        "provider returned an error envelope with HTTP 200",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(200),
            code: Some("provider_business_error".to_string()),
            provider_id: Some("controlled".to_string()),
            upstream_request_id: None,
            message: Some("provider returned an error envelope with HTTP 200".to_string()),
        },
    );
    let projected = project_exhausted_provider(
        source,
        V3ErrorActionScope::ProviderInstance {
            provider_id: "controlled".to_string(),
        },
        Some(200),
    );

    assert_eq!(projected.status, 502);
    assert!(projected.status >= 400);
    assert_eq!(projected.body["error"]["code"], "provider_business_error");
    assert!(
        projected.body["error"].get("decision").is_none(),
        "Error06 body must not carry the execution decision: {}",
        projected.body["error"]
    );
}

#[test]
fn request_in_flight_projects_standard_error_chain_with_http_conflict() {
    let projected = routecodex_v3_error::project_v3_http_boundary_error(
        V3HttpBoundaryErrorKind::RequestInFlight,
        "controlled active Responses request",
    );

    assert_eq!(projected.status, 409);
    assert_eq!(projected.body["error"]["code"], "request_in_flight");
    assert!(
        projected.body["error"].get("error_node").is_none(),
        "Error06 body must not carry the error node identity: {}",
        projected.body["error"]
    );
    assert_eq!(projected.chain.len(), 6);
}

#[test]
fn provider_failure_builds_adjacent_action_and_keeps_error_polarity() {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_http_503",
        "upstream unavailable",
    );
    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    let action = build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        V3ErrorActionScope::ProviderInstance {
            provider_id: "cc".to_string(),
        },
        2,
    );
    assert!(action.action.retry_eligible);
    assert!(action.action.health_affecting);
    let exhaustion = build_v3_error_04_target_exhaustion_decision_with_provider_availability(
        action, 1, false, false,
    );
    assert!(!exhaustion.target_exhausted);
    let execution =
        build_v3_error_05_execution_decision_from_v3_error_04(exhaustion, Some(recovery_witness()));
    assert!(matches!(
        execution.action,
        V3Error05ExecutionAction::WaitThenReselect { .. }
    ));
    assert!(
        execution.try_into_terminal().is_err(),
        "retryable provider failure must not enter Error06"
    );
}

#[test]
fn client_disconnect_is_health_neutral_and_terminal_projection_is_not_success() {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ClientDisconnect,
        "V3Server03HttpRequestRaw",
        "client_disconnect",
        "client closed connection",
    );
    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    let action = build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        V3ErrorActionScope::None,
        0,
    );
    assert!(!action.action.health_affecting);
    assert!(!action.action.retry_eligible);
    let exhaustion = build_v3_error_04_target_exhaustion_decision_with_provider_availability(
        action, 0, false, false,
    );
    let execution = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion, None);
    assert_eq!(
        execution.action,
        V3Error05ExecutionAction::ClientDisconnected
    );
    let projected = build_v3_error_06_client_projected_from_v3_error_05(
        execution
            .try_into_terminal()
            .expect("disconnect is terminal"),
    );
    assert_eq!(projected.status, 499);
    assert!(projected.body.get("ok").is_none());
}

#[test]
fn provider_failure_projects_only_after_selected_target_is_fully_exhausted() {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_http_429",
        "quota exhausted",
    );
    let classified = build_v3_error_02_classified_from_v3_error_01(source);
    let action = build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        V3ErrorActionScope::CanonicalModel {
            provider_id: "cc".to_string(),
            model_id: "gpt-5.5".to_string(),
        },
        0,
    );
    assert!(!action.action.retry_eligible);
    let exhaustion = build_v3_error_04_target_exhaustion_decision_with_provider_availability(
        action, 0, false, false,
    );
    assert!(exhaustion.target_exhausted);
    let execution = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion, None);
    assert_eq!(execution.action, V3Error05ExecutionAction::ProjectTerminal);
    let projected = build_v3_error_06_client_projected_from_v3_error_05(
        execution
            .try_into_terminal()
            .expect("exhausted provider failure is terminal"),
    );
    assert_eq!(projected.status, 502);
    assert_eq!(projected.body["error"]["code"], "provider_http_429");
    assert!(
        projected.body["error"].get("target_exhausted").is_none(),
        "Error06 body must not carry exhaustion state: {}",
        projected.body["error"]
    );
}

#[test]
fn external_provider_429_projects_external_link_without_internal_code() {
    let source = build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3Transport13ResponsesHttpRequest",
        "provider_http_429",
        "provider returned HTTP 429",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(429),
            code: Some("HTTP_429".to_string()),
            provider_id: Some("asxs-grok".to_string()),
            upstream_request_id: None,
            message: Some("provider returned HTTP 429".to_string()),
        },
    );
    let projected = project_exhausted_provider(
        source,
        V3ErrorActionScope::ProviderInstance {
            provider_id: "asxs-grok".to_string(),
        },
        None,
    );

    assert_eq!(projected.status, 429);
    assert_eq!(projected.body["error"]["code"], "provider_http_429");
    assert!(
        projected.body["error"].get("external_error").is_none(),
        "Error06 body must not carry the external provider link: {}",
        projected.body["error"]
    );
    assert!(projected.body["error"].get("internal_code").is_none());
    assert!(projected.body["error"].get("internal_node").is_none());
}

#[test]
fn internal_runtime_failure_projects_numbered_internal_code_without_external_link() {
    let source = build_v3_error_01_source_raised_internal(
        V3ErrorSourceKind::RuntimeFailure,
        "V3Provider12ResponsesWirePayload",
        "provider_auth_handle_missing",
        "selected provider has no auth handle",
        V3InternalErrorCode::V3Provider12ResponsesWirePayload,
    );
    let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::None,
        candidates_remaining: 0,
        source_status: None,
    });

    assert_eq!(projected.status, 500);
    assert_eq!(
        projected.body["error"]["code"],
        "provider_auth_handle_missing"
    );
    assert!(
        projected.body["error"].get("internal_code").is_none()
            && projected.body["error"].get("internal_node").is_none()
            && projected.body["error"]
                .get("internal_owner_feature_id")
                .is_none()
            && projected.body["error"]
                .get("internal_module_block")
                .is_none(),
        "Error06 body must not carry internal error identity: {}",
        projected.body["error"]
    );
    assert!(projected.body["error"].get("external_error").is_none());
}

#[test]
#[should_panic(expected = "ProviderFailure cannot carry a RouteCodex internal error code")]
fn provider_failure_cannot_be_wrapped_as_internal_error() {
    let _ = build_v3_error_01_source_raised_internal(
        V3ErrorSourceKind::ProviderFailure,
        "V3Transport13ResponsesHttpRequest",
        "provider_http_429",
        "provider returned HTTP 429",
        V3InternalErrorCode::V3Transport13ResponsesHttpRequest,
    );
}

#[test]
fn malformed_client_request_has_no_internal_or_external_identity() {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::InvalidRequest,
        "V3Provider12ResponsesWirePayload",
        "invalid_provider_request_payload",
        "invalid data:image payload",
    );
    let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::None,
        candidates_remaining: 0,
        source_status: None,
    });

    assert_eq!(projected.status, 400);
    assert!(projected.body["error"].get("internal_code").is_none());
    assert!(projected.body["error"].get("external_error").is_none());
}

#[test]
fn already_terminal_target_exhaustion_and_success_control_never_become_success() {
    for (kind, code, expected_status) in [
        (
            V3ErrorSourceKind::TargetPoolExhausted,
            "target_pool_exhausted",
            503,
        ),
        (
            V3ErrorSourceKind::SuccessControl,
            "success_entered_error_chain",
            500,
        ),
    ] {
        let source = build_v3_error_01_source_raised(kind, "test", code, "terminal");
        let classified = build_v3_error_02_classified_from_v3_error_01(source);
        let action = build_v3_error_03_target_local_action_from_v3_error_02(
            classified,
            V3ErrorActionScope::None,
            0,
        );
        let exhaustion = build_v3_error_04_target_exhaustion_decision_with_provider_availability(
            action, 0, false, false,
        );
        let execution = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion, None);
        assert_eq!(
            execution.action,
            V3Error05ExecutionAction::RejectNonProviderError
        );
        let projected = build_v3_error_06_client_projected_from_v3_error_05(
            execution
                .try_into_terminal()
                .expect("already-terminal non-provider error"),
        );
        assert_eq!(projected.status, expected_status);
        assert!(projected.body.get("ok").is_none());
        assert!(projected.status >= 400);
    }
}
