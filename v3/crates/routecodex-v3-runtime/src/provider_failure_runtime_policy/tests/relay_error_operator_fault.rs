use super::*;
use crate::operation_runner::{
    run_v3_err01_source_raised_operator, run_v3_error_02_to_05_decision_operators,
    V3Err01SourceInput,
};
use routecodex_v3_error::{V3ErrorActionScope, V3ErrorSourceKind};
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

#[test]
fn project_v3_client_disconnect_returns_real_client_disconnect_error06() {
    let projected = project_v3_client_disconnect(
        "provider-a",
        "V3ProviderReqOutbound09TransportRequest",
        "client disconnected",
    )
    .expect("real disconnect projection must return Error06");

    assert_eq!(
        projected.diagnostic_source.source_kind,
        V3ErrorSourceKind::ClientDisconnect
    );
    assert_eq!(projected.diagnostic_source.message, "client disconnected");
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
    assert_eq!(fault.original_source, Some(source));
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
    assert_eq!(fault.original_source, Some(source));
}

#[test]
fn err01_before_source_preserves_raw_provenance() {
    let (_, source) = real_client_disconnect_source();
    let runner_error = run_v3_error_02_to_05_decision_operators(
        json!(null),
        source,
        V3ErrorActionScope::ProviderInstance {
            provider_id: "provider-a".to_string(),
        },
        0,
        false,
        false,
        None,
    )
    .expect_err("real SDK error fixture");
    let fault = relay_error_operator_fault_from_err01_failure(
        "provider-a",
        "V3ProviderReqOutbound09TransportRequest",
        "client_disconnect",
        "client disconnected",
        runner_error,
    );

    assert!(fault.original_source.is_none());
    assert!(fault
        .policy_failure
        .message
        .contains("V3ProviderReqOutbound09TransportRequest:client_disconnect"));
    assert!(fault.policy_failure.message.contains("provider-a"));
    assert!(fault.policy_failure.message.contains("client disconnected"));
    assert!(!fault.policy_failure.message.is_empty());
}
