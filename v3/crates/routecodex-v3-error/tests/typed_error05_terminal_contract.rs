use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_internal,
    build_v3_error_06_client_projected_from_v3_error_05, V3Error05ExecutionAction,
    V3Error05RecoveryAdmissionWitness, V3ErrorActionScope, V3ErrorHandlingCenter,
    V3ErrorHandlingCenterInput, V3ErrorSourceKind, V3InternalErrorCode,
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

fn unharvestable_tool_markup_response_source() -> routecodex_v3_error::V3Error01SourceRaised {
    build_v3_error_01_source_raised_internal(
        V3ErrorSourceKind::RuntimeFailure,
        "V3DirectResp14ProviderProjectionPrepared",
        "direct_tool_markup_unharvestable",
        "recognized tool markup could not be harvested",
        V3InternalErrorCode::V3DirectResp14UnharvestableToolMarkup,
    )
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
fn provider_failure_never_uses_same_provider_budget() {
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: provider_failure(),
            action_scope: V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
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
        V3Error05ExecutionAction::WaitThenReselect { .. }
    ));
    assert!(decision.try_into_terminal().is_err());
}

#[test]
fn provider_failure_projects_only_with_route_and_default_exhaustion_proof() {
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: provider_failure(),
            action_scope: V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
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
    assert_eq!(projected.body["error"]["code"], "network_error");
    assert_eq!(projected.body["error"]["message"], "network error");
    assert!(
        projected.body["error"]
            .get("route_pool_remaining_after_exclusion")
            .is_none()
            && projected.body["error"]
                .get("default_pool_available")
                .is_none()
            && projected.body["error"].get("target_exhausted").is_none()
            && projected.body["error"]
                .get("candidates_remaining")
                .is_none()
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

#[test]
fn recoverable_response_processing_runtime_failure_with_capacity_is_nonterminal_and_rejects_fabricated_terminal(
) {
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: unharvestable_tool_markup_response_source(),
            action_scope: V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 1,
            source_status: Some(200),
        },
        false,
        false,
        Some(recovery_witness()),
    );

    assert!(matches!(
        decision.action,
        V3Error05ExecutionAction::WaitThenReselect { .. }
    ));
    assert!(decision.try_into_terminal().is_err());

    let mut fabricated_terminal = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: unharvestable_tool_markup_response_source(),
            action_scope: V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 1,
            source_status: Some(200),
        },
        false,
        false,
        Some(recovery_witness()),
    );
    fabricated_terminal.action = V3Error05ExecutionAction::ProjectTerminal;
    assert!(
        fabricated_terminal.try_into_terminal().is_err(),
        "an eligible alternative must invalidate a fabricated terminal decision"
    );
}

#[test]
fn exhausted_unharvestable_tool_markup_runtime_failure_is_502_terminal() {
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: unharvestable_tool_markup_response_source(),
            action_scope: V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 0,
            source_status: Some(200),
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
    assert_eq!(
        projected.body["error"]["code"],
        "direct_tool_markup_unharvestable"
    );
    assert_eq!(
        projected.diagnostic_source.source_kind,
        V3ErrorSourceKind::RuntimeFailure
    );
    assert_eq!(
        projected
            .diagnostic_source
            .internal_error
            .as_ref()
            .expect("typed internal error")
            .internal_code,
        "500-211"
    );
    assert!(projected.health_action.is_none());
}

#[test]
fn recoverable_response_processing_runtime_failure_terminal_proof_rejects_same_provider_retry() {
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: unharvestable_tool_markup_response_source(),
            action_scope: V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
                model_id: "model-a".to_string(),
            },
            candidates_remaining: 0,
            source_status: Some(200),
        },
        false,
        true,
        None,
    );

    assert!(matches!(
        decision.action,
        V3Error05ExecutionAction::ProjectTerminal
    ));
    assert!(decision.try_into_terminal().is_err());
}
