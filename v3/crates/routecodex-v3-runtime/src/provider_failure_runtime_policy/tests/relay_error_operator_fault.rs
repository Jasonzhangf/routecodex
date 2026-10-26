use super::*;
use crate::operation_runner::{
    run_v3_err01_source_raised_operator, run_v3_error_02_to_05_decision_operators,
    OperationRunnerError, V3Err01SourceInput,
};
use routecodex_v3_error::{
    build_v3_internal_error_envelope, V3ErrorActionScope, V3ErrorSourceKind, V3ExternalErrorKind,
    V3ExternalErrorLink, V3InternalErrorCode,
};
use serde_json::json;

fn real_client_disconnect_source() -> (serde_json::Value, V3Error01SourceRaised) {
    run_v3_err01_source_raised_operator(
        V3ErrorSourceKind::ClientDisconnect,
        "V3ProviderReqOutbound09TransportRequest",
        "client_disconnect",
        "client disconnected while the provider request was in flight",
        V3Err01SourceInput::Plain,
    )
    .expect("real Error01 SDK must raise the source")
}

fn real_provider_failure_source() -> (serde_json::Value, V3Error01SourceRaised) {
    raise_v3_source_via_err01(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_unavailable",
        "provider unavailable",
        V3Err01SourceInput::External(V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(503),
            code: Some("provider_unavailable".to_string()),
            provider_id: Some("provider-a".to_string()),
            upstream_request_id: Some("request-a".to_string()),
            message: Some("provider unavailable".to_string()),
        }),
    )
    .expect("real Error01 SDK must raise the provider failure source")
}

#[test]
fn source_helper_preserves_real_sdk_output_for_plain_internal_and_external() {
    let (plain_projection, plain_source) = raise_v3_source_via_err01(
        V3ErrorSourceKind::InvalidRequest,
        "",
        "",
        "",
        V3Err01SourceInput::Plain,
    )
    .expect("the real SDK must accept empty Plain source fields");
    assert_eq!(
        plain_projection,
        serde_json::to_value(&plain_source).unwrap()
    );
    assert_eq!(plain_source.source_kind, V3ErrorSourceKind::InvalidRequest);
    assert_eq!(plain_source.source_stage, "");
    assert_eq!(plain_source.code, "");
    assert_eq!(plain_source.message, "");
    assert!(plain_source.internal_error.is_none());
    assert!(plain_source.external_error.is_none());

    let internal_code = V3InternalErrorCode::V3Provider12ResponsesWirePayload;
    let internal_stage = "V3Provider12ResponsesWirePayload";
    let (internal_projection, internal_source) = raise_v3_source_via_err01(
        V3ErrorSourceKind::RuntimeFailure,
        internal_stage,
        "provider_wire_projection_failed",
        "wire projection failed",
        V3Err01SourceInput::Internal(internal_code),
    )
    .expect("the real SDK must raise an Internal source");
    assert_eq!(
        internal_projection,
        serde_json::to_value(&internal_source).unwrap()
    );
    assert_eq!(
        internal_source.internal_error.as_deref(),
        Some(&build_v3_internal_error_envelope(
            internal_code,
            internal_stage
        ))
    );
    assert!(internal_source.external_error.is_none());

    let external_error = V3ExternalErrorLink {
        kind: V3ExternalErrorKind::Provider,
        status: Some(503),
        code: Some("provider_unavailable".to_string()),
        provider_id: Some("provider-a".to_string()),
        upstream_request_id: Some("request-a".to_string()),
        message: Some("provider unavailable".to_string()),
    };
    let (external_projection, external_source) = raise_v3_source_via_err01(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_unavailable",
        "provider unavailable",
        V3Err01SourceInput::External(external_error.clone()),
    )
    .expect("the real SDK must raise an External source");
    assert_eq!(
        external_projection,
        serde_json::to_value(&external_source).unwrap()
    );
    assert_eq!(
        external_source.external_error.as_deref(),
        Some(&external_error)
    );
    assert!(external_source.internal_error.is_none());
}

#[test]
fn source_fault_converter_preserves_complete_typed_origins() {
    let (_, plain_source) = raise_v3_source_via_err01(
        V3ErrorSourceKind::InvalidRequest,
        "V3Server03HttpRequestRaw",
        "malformed_json",
        "request body is not JSON",
        V3Err01SourceInput::Plain,
    )
    .unwrap();
    let internal_code = V3InternalErrorCode::V3Provider12ResponsesWirePayload;
    let internal_stage = "V3Provider12ResponsesWirePayload";
    let (_, internal_source) = raise_v3_source_via_err01(
        V3ErrorSourceKind::RuntimeFailure,
        internal_stage,
        "provider_wire_projection_failed",
        "wire projection failed",
        V3Err01SourceInput::Internal(internal_code),
    )
    .unwrap();
    let external_error = V3ExternalErrorLink {
        kind: V3ExternalErrorKind::Provider,
        status: Some(429),
        code: Some("rate_limit_exceeded".to_string()),
        provider_id: Some("provider-a".to_string()),
        upstream_request_id: Some("request-a".to_string()),
        message: Some("retry later".to_string()),
    };
    let (_, external_source) = raise_v3_source_via_err01(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_rate_limited",
        "provider rate limited",
        V3Err01SourceInput::External(external_error),
    )
    .unwrap();
    let runner_error = OperationRunnerError {
        message: "synthetic Source01 SDK carrier failure".to_string(),
    };

    for original_source in [plain_source, internal_source, external_source] {
        let fault = relay_error_operator_fault_from_err01_source(
            original_source.source_stage,
            original_source.clone(),
            runner_error.clone(),
        );

        assert_eq!(fault.original_source.as_deref(), Some(&original_source));
        assert_eq!(
            fault.policy_failure.source_kind,
            V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(fault.policy_failure.source_stage, "V3Error01SourceRaised");
        assert_eq!(
            fault.policy_failure.code,
            "err01_source_operator_sdk_failure"
        );
        assert!(fault.policy_failure.message.contains(&runner_error.message));
        assert!(fault
            .policy_failure
            .message
            .contains(original_source.source_stage));
        assert!(fault.policy_failure.message.contains(&original_source.code));
        assert!(fault.policy_failure.internal_error.is_none());
        assert!(fault.policy_failure.external_error.is_none());
    }
}

#[test]
fn project_v3_relay_error_source_succeeds_with_real_err01_projection() {
    let (source_projection, source) = real_client_disconnect_source();

    let projected = project_v3_relay_error_source(
        source.clone(),
        V3ErrorActionScope::ProviderInstance {
            provider_id: "provider-a".to_string(),
        },
        0,
        None,
    )
    .expect("real Error01 source must finish through the Relay error SDK chain");

    assert_eq!(projected.status, 499);
    assert_eq!(
        source_projection,
        serde_json::to_value(&source).expect("Source serialization")
    );
    assert_eq!(projected.diagnostic_source, source);
    assert_eq!(projected.body["error"]["code"], "client_disconnect");
}

#[test]
fn project_v3_relay_error_source_keeps_real_sdk_rejection_as_fault() {
    let (_, source) = real_client_disconnect_source();
    let scope = V3ErrorActionScope::ProviderInstance {
        provider_id: "provider-a".to_string(),
    };
    let runner_error = run_v3_error_02_to_05_decision_operators(
        json!(null),
        source.clone(),
        scope.clone(),
        0,
        false,
        false,
        None,
    )
    .expect_err("the real Error02 SDK must reject a non-object source projection");
    let fault =
        project_v3_relay_error_source_with_projection(source.clone(), json!(null), scope, 0, None)
            .expect_err("the real Error02 SDK must reject a non-object source projection");

    assert_eq!(
        fault.policy_failure.source_kind,
        V3ErrorSourceKind::RuntimeFailure
    );
    assert_eq!(
        fault.policy_failure.code,
        "relay_error_operator_sdk_failure"
    );
    assert_eq!(fault.original_source.as_deref(), Some(&source));
    assert_eq!(fault.policy_failure.message, runner_error.message);
}

#[test]
fn project_v3_relay_error_source_keeps_provider_failure_status_path() {
    let (_, source) = run_v3_err01_source_raised_operator(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_transport_failure",
        "provider transport failed",
        V3Err01SourceInput::External(V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(503),
            code: Some("provider_transport_failure".to_string()),
            provider_id: Some("provider-a".to_string()),
            upstream_request_id: None,
            message: Some("provider transport failed".to_string()),
        }),
    )
    .expect("real Error01 SDK must raise the provider failure source");
    let scope = V3ErrorActionScope::ProviderKeyModel {
        provider_id: "provider-a".to_string(),
        auth_alias: "key-a".to_string(),
        model_id: "model-a".to_string(),
    };

    let overridden = project_v3_relay_error_source(source.clone(), scope, 0, Some(429))
        .expect("source status must finish through the Relay error SDK chain");
    assert_eq!(overridden.status, 429);
    assert_eq!(overridden.diagnostic_source, source);
}

#[test]
fn project_v3_client_disconnect_returns_real_client_disconnect_error06() {
    let source_stage = "V3ProviderReqOutbound09TransportRequest";
    let projected = project_v3_client_disconnect("provider-a", source_stage, "client disconnected")
        .expect("real disconnect projection must return Error06");

    assert_eq!(
        projected.diagnostic_source.source_kind,
        V3ErrorSourceKind::ClientDisconnect
    );
    assert_eq!(projected.diagnostic_source.source_stage, source_stage);
    assert_eq!(projected.diagnostic_source.code, "client_disconnect");
    assert_eq!(projected.diagnostic_source.message, "client disconnected");
    assert!(projected.health_action.is_none());
    assert_eq!(projected.body["error"]["code"], "client_disconnect");
}

#[test]
fn sdk_error_keeps_original_source_and_runner_message() {
    let (_, source) = real_client_disconnect_source();
    let runner_error = run_v3_error_02_to_05_decision_operators(
        json!(null),
        source.clone(),
        V3ErrorActionScope::ProviderInstance {
            provider_id: "provider-a".to_string(),
        },
        0,
        false,
        false,
        None,
    )
    .expect_err("the real Error02 SDK must reject a non-object projection");
    let fault = finish_v3_relay_error_projection(source.clone(), Err(runner_error.clone()))
        .expect_err("an SDK error cannot be converted into a fake Error06");

    assert_eq!(
        fault.policy_failure.source_kind,
        V3ErrorSourceKind::RuntimeFailure
    );
    assert_eq!(
        fault.policy_failure.code,
        "relay_error_operator_sdk_failure"
    );
    assert!(fault.policy_failure.message.contains(&runner_error.message));
    assert_eq!(fault.original_source.as_deref(), Some(&source));
}
#[test]
fn omitted_terminal_projection_is_a_typed_contract_fault() {
    let (_, source) = real_client_disconnect_source();
    let fault = finish_v3_relay_error_projection(source.clone(), Ok(None))
        .expect_err("Ok(None) must not be represented as a successful Error06");

    assert_eq!(
        fault.policy_failure.source_kind,
        V3ErrorSourceKind::RuntimeFailure
    );
    assert_eq!(
        fault.policy_failure.code,
        "relay_error_projection_nonterminal"
    );
    assert_eq!(fault.original_source.as_deref(), Some(&source));
}

#[test]
fn health_error02_sdk_rejection_preserves_external_source_witness() {
    let (_, source) = real_provider_failure_source();
    let fault = classify_v3_provider_health_source_via_err02(json!(null), source.clone())
        .expect_err("the real Error02 SDK must reject a non-object source projection");

    assert_eq!(
        fault.policy_failure.code,
        "relay_error_operator_sdk_failure"
    );
    assert_eq!(fault.original_source.as_deref(), Some(&source));
    assert_eq!(
        fault
            .original_source
            .as_ref()
            .and_then(|source| source.external_error.as_ref())
            .and_then(|error| error.status),
        Some(503)
    );
}

#[test]
fn policy_error02_to_05_sdk_rejection_preserves_original_source() {
    let scope = "h2_policy_error02_to_05_rejection";
    let manifest = target_resolution_manifest(scope);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the provider"),
    };
    let (_, source) = real_provider_failure_source();
    let fault = build_v3_relay_provider_error_05_decision(
        &selected,
        json!(null),
        source.clone(),
        0,
        false,
        false,
        None,
    )
    .expect_err("the real Error02..05 SDK chain must reject a non-object source projection");

    assert_eq!(
        fault.policy_failure.code,
        "relay_error_operator_sdk_failure"
    );
    assert_eq!(fault.original_source.as_deref(), Some(&source));
}

#[test]
fn terminal_error06_rejection_preserves_decision_source_and_nonterminal_stays_none() {
    let scope = "h2_terminal_error06_rejection";
    let manifest = target_resolution_manifest(scope);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the provider"),
    };
    let (source_projection, source) = real_provider_failure_source();
    let recovery = V3Error05RecoveryAdmissionWitness::new(
        test_provider_failure_scope(scope, scope, "session-h2-terminal")
            .expect("test failure session scope"),
        v3_relay_provider_candidate_key(&selected.candidate),
        "provider_unavailable",
        1,
    )
    .expect("test recovery witness");
    let (decision_projection, decision) = build_v3_relay_provider_error_05_decision(
        &selected,
        source_projection.clone(),
        source.clone(),
        1,
        true,
        false,
        Some(recovery),
    )
    .expect("real Error02..05 SDK chain must produce a switch-provider decision");

    assert_eq!(
        terminal_projection_for(decision_projection.clone(), &decision, None)
            .expect("a valid nonterminal decision must not enter Error06"),
        None
    );

    let (_, terminal_decision) = build_v3_relay_provider_error_05_decision(
        &selected,
        source_projection,
        source.clone(),
        0,
        false,
        false,
        None,
    )
    .expect("real Error02..05 SDK chain must produce a terminal decision");
    assert!(terminal_decision.clone().try_into_terminal().is_ok());

    let fault = terminal_projection_for(json!(null), &terminal_decision, None)
        .expect_err("the real Error06 SDK must reject a non-object decision projection");
    assert_eq!(
        fault.policy_failure.code,
        "relay_error_operator_sdk_failure"
    );
    assert_eq!(fault.original_source.as_deref(), Some(&source));
}
