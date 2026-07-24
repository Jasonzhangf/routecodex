use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_02_classified_from_v3_error_01,
    build_v3_error_03_target_local_action_from_v3_error_02,
    build_v3_error_04_target_exhaustion_decision_from_v3_error_03,
    build_v3_error_05_execution_decision_from_v3_error_04,
    build_v3_error_06_client_projected_from_v3_error_05, V3ErrorActionScope, V3ErrorHandlingCenter,
    V3ErrorHandlingCenterInput, V3ErrorSourceKind,
};

#[test]
fn error_handling_center_owns_error01_06_and_preserves_provider_error_status() {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        "rate_limit_error",
        "controlled rate limit",
    );
    let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::ProviderInstance {
            provider_id: "controlled".to_string(),
        },
        candidates_remaining: 0,
        source_status: Some(429),
    });

    assert_eq!(projected.status, 429);
    assert_eq!(projected.body["error"]["code"], "rate_limit_error");
    assert_eq!(
        projected.body["error"]["error_node"],
        "V3Error06ClientProjected"
    );
    assert_eq!(projected.chain.len(), 6);
}

#[test]
fn error_handling_center_never_projects_an_error_as_http_success() {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        "provider_business_error",
        "provider returned an error envelope with HTTP 200",
    );
    let projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::ProviderInstance {
            provider_id: "controlled".to_string(),
        },
        candidates_remaining: 0,
        source_status: Some(200),
    });

    assert_eq!(projected.status, 502);
    assert!(projected.status >= 400);
    assert_eq!(projected.body["error"]["decision"], "project_client_error");
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
    let exhaustion = build_v3_error_04_target_exhaustion_decision_from_v3_error_03(action, 1);
    assert!(!exhaustion.target_exhausted);
    let execution = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion);
    assert_eq!(execution.decision, "target_local_reselect");
    let projected = build_v3_error_06_client_projected_from_v3_error_05(execution);
    assert_eq!(projected.status, 502);
    assert_eq!(projected.body["error"]["code"], "provider_http_503");
    assert_eq!(projected.chain[0], "V3Error01SourceRaised");
    assert_eq!(projected.chain[5], "V3Error06ClientProjected");
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
    let exhaustion = build_v3_error_04_target_exhaustion_decision_from_v3_error_03(action, 0);
    let execution = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion);
    let projected = build_v3_error_06_client_projected_from_v3_error_05(execution);
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
    let exhaustion = build_v3_error_04_target_exhaustion_decision_from_v3_error_03(action, 0);
    assert!(exhaustion.target_exhausted);
    let execution = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion);
    assert_eq!(execution.decision, "project_client_error");
    let projected = build_v3_error_06_client_projected_from_v3_error_05(execution);
    assert_eq!(projected.status, 502);
    assert_eq!(projected.body["error"]["target_exhausted"], true);
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
        let exhaustion = build_v3_error_04_target_exhaustion_decision_from_v3_error_03(action, 0);
        let execution = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion);
        let projected = build_v3_error_06_client_projected_from_v3_error_05(execution);
        assert_eq!(projected.status, expected_status);
        assert!(projected.body.get("ok").is_none());
        assert!(projected.status >= 400);
    }
}
