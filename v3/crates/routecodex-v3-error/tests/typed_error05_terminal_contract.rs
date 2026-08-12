use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_06_client_projected_from_v3_error_05,
    V3Error05ExecutionAction, V3Error05RecoveryAdmissionWitness, V3ErrorActionScope,
    V3ErrorHandlingCenter, V3ErrorHandlingCenterInput, V3ErrorSourceKind,
    V3ProviderFailureSessionScope,
};

fn provider_failure() -> routecodex_v3_error::V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_malformed_sse",
        "provider stream is malformed",
    )
}

fn recovery_witness() -> V3Error05RecoveryAdmissionWitness {
    V3Error05RecoveryAdmissionWitness::new(
        V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
            .expect("valid provider failure session scope"),
        "provider-a:key-a:model-a",
        "provider_malformed_sse",
        1,
    )
    .expect("valid Error05 recovery witness")
}

#[test]
fn provider_failure_with_route_capacity_is_typed_nonterminal_error05() {
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: provider_failure(),
            action_scope: V3ErrorActionScope::ProviderInstance {
                provider_id: "provider-a".to_string(),
            },
            candidates_remaining: 1,
            source_status: Some(502),
        },
        false,
        false,
        Some(recovery_witness()),
    );

    assert!(matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenReselect { .. }
    ));
    assert!(
        decision.try_into_terminal().is_err(),
        "nonterminal Error05 must be structurally rejected by the Error06 boundary"
    );
}

#[test]
fn provider_failure_with_same_provider_budget_is_typed_retry_same() {
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: provider_failure(),
            action_scope: V3ErrorActionScope::CanonicalModel {
                provider_id: "provider-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 0,
            source_status: Some(502),
        },
        true,
        true,
        Some(recovery_witness()),
    );

    assert!(matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenRetrySame { .. }
    ));
    assert!(decision.try_into_terminal().is_err());
}

#[test]
fn provider_failure_projects_only_with_route_and_default_exhaustion_proof() {
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: provider_failure(),
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

    assert!(matches!(
        decision.action,
        V3Error05ExecutionAction::ProjectTerminal
    ));
    let terminal = decision
        .try_into_terminal()
        .expect("route and default exhaustion is terminal");
    let projected = build_v3_error_06_client_projected_from_v3_error_05(terminal);
    assert_eq!(projected.status, 502);
    assert_eq!(projected.body["error"]["code"], "provider_malformed_sse");
    assert_eq!(
        projected.body["error"]["message"],
        "provider stream is malformed"
    );
    assert!(
        projected.body["error"].get("route_pool_remaining_after_exclusion").is_none()
            && projected.body["error"].get("default_pool_available").is_none()
            && projected.body["error"].get("target_exhausted").is_none()
            && projected.body["error"].get("candidates_remaining").is_none()
            && projected.body["error"].get("stage").is_none()
            && projected.body["error"].get("class").is_none()
            && projected.body["error"].get("decision").is_none()
            && projected.body["error"].get("error_node").is_none(),
        "Error06 body must not carry control-plane fields: {}",
        projected.body["error"]
    );
}

#[test]
fn provider_failure_cannot_use_generic_error_center_to_fabricate_exhaustion() {
    let result = std::panic::catch_unwind(|| {
        V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
            source: provider_failure(),
            action_scope: V3ErrorActionScope::ProviderInstance {
                provider_id: "provider-a".to_string(),
            },
            candidates_remaining: 0,
            source_status: Some(502),
        })
    });
    assert!(result.is_err());
}
