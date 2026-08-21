//! L2 mock transport regression for the V4 M8 first slice.
//!
//! Coverage:
//! - positive: keyless fixture identity sequence, trace chain, responses+direct
//! - red: invalid fixture fields, malformed provider frame, error-chain scope
//! - red: (entry_protocol, continuation_owner) illegal pairs
//! - red: fixture.path vs entry_protocol mismatch
//! - red: error-chain projection consumes real ExecutionReport.scope
use routecodex_v4_runtime::{
    execute_mock_transport_slice, execution_binding, is_known_mock_transport_fault_code,
    KeylessChatFixture, MockTransportIdentityCounter, MockTransportReport,
    MOCK_TRANSPORT_FAULT_CODES,
};
use routecodex_v4_base_node::Scope;
use routecodex_v4_runtime::SkeletonRuntime;

const CONTRACT_JSON: &str = include_str!("../../../contracts/skeleton-plan.contract.json");
const TEST_PORT: u16 = 5555;

fn load_runtime() -> SkeletonRuntime {
    SkeletonRuntime::load(CONTRACT_JSON).expect("runtime must load contract")
}

fn chat_fixture() -> KeylessChatFixture {
    KeylessChatFixture::chat("chat:hello-world".to_string(), "mock-model".to_string())
}

/// Fixture whose path starts with /v1/responses — required for entry_protocol=responses.
fn responses_fixture() -> KeylessChatFixture {
    KeylessChatFixture::new(
        "POST",
        "/v1/responses",
        Vec::new(),
        "responses:hello".to_string(),
        "responses-model".to_string(),
    )
}

fn mock_provider_frame_ok() -> &'static str {
    r#"{"ok": true, "choices": [{"message": {"role": "assistant"}}]}"#
}

#[test]
fn positive_keyless_fixture_carries_fixture_identity_through_request_chain() {
    let runtime = load_runtime();
    let bound = execution_binding(runtime.plan()).clone();
    let mut counter = MockTransportIdentityCounter::new();
    let fixture = chat_fixture();
    let first = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        mock_provider_frame_ok(),
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-a",
        "conv-a",
        "chat",
        "relay",
    )
    .expect("mock transport slice must succeed");
    assert_eq!(first.request_id, "mock.srv-m8-2026-08-17-00000001");
    assert_eq!(first.request_binding, bound);
    let frame: serde_json::Value =
        serde_json::from_str(&first.client_frame).expect("client frame must be JSON");
    assert_eq!(frame["object"], "chat.completion");
    assert_eq!(frame["choices"][0]["message"]["role"], "assistant");
    assert!(first.provider_wire.starts_with("wire:semantic:mock-model:"));
    assert!(first.continuation_committed, "chat/relay commits");
    assert_eq!(first.continuation_owner, "relay");
    assert_eq!(first.fixture_method, "POST");
    assert_eq!(first.fixture_path, "/v1/chat/completions");
    assert_eq!(first.fixture_model, "mock-model");
    assert_eq!(first.fixture_headers, Vec::<(String, String)>::new());
    assert!(first.relay_operator_accepted, "chat+relay is a valid typed-facts pair");
    assert_eq!(first.error_projection_scope, None, "no error occurred");
    assert!(first.error.is_none(), "no fault expected");
    let second = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        mock_provider_frame_ok(),
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-b",
        "conv-b",
        "chat",
        "relay",
    )
    .expect("second mock transport slice must succeed");
    assert_eq!(second.request_id, "mock.srv-m8-2026-08-17-00000002");
    assert_eq!(second.request_binding, bound);
    assert_ne!(first.request_id, second.request_id);
    assert_eq!(second.fixture_method, "POST");
    assert_eq!(second.fixture_model, "mock-model");
}

#[test]
fn positive_trace_entries_follows_request_then_response_chains() {
    let runtime = load_runtime();
    let mut counter = MockTransportIdentityCounter::new();
    let fixture = chat_fixture();
    let report: MockTransportReport = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        mock_provider_frame_ok(),
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-trace",
        "conv-trace",
        "chat",
        "relay",
    )
    .expect("mock transport slice must succeed");
    assert_eq!(report.trace.len(), 7 + 6);
}

#[test]
fn positive_responses_direct_operator_accepted() {
    let runtime = load_runtime();
    let mut counter = MockTransportIdentityCounter::new();
    let fixture = responses_fixture();
    let report = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        mock_provider_frame_ok(),
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-direct",
        "conv-direct",
        "responses",
        "direct",
    )
    .expect("responses + direct must succeed");
    assert!(report.error.is_none(), "no fault expected: {:?}", report.error);
    assert!(report.relay_operator_accepted, "responses+direct selects Direct operator");
    assert_eq!(report.fixture_path, "/v1/responses");
    assert_eq!(report.fixture_model, "responses-model");
    assert!(report.continuation_committed, "responses/direct commits");
    assert_eq!(report.continuation_owner, "direct");
}

#[test]
fn red_responses_relay_operator_rejected() {
    let runtime = load_runtime();
    let mut counter = MockTransportIdentityCounter::new();
    let fixture = responses_fixture();
    let outcome = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        mock_provider_frame_ok(),
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-r",
        "conv-r",
        "responses",
        "relay",
    );
    assert!(outcome.is_err(), "responses + relay owner must fail fast");
    let fault = outcome.err().expect("missing fault");
    assert_eq!(fault.code, "keyless_fixture_invalid");
    assert!(fault.message.contains("responses"), "error must mention invalid pair");
}

#[test]
fn red_chat_direct_operator_rejected() {
    let runtime = load_runtime();
    let mut counter = MockTransportIdentityCounter::new();
    let fixture = chat_fixture();
    let outcome = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        mock_provider_frame_ok(),
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-cd",
        "conv-cd",
        "chat",
        "direct",
    );
    assert!(outcome.is_err(), "chat + direct owner must fail fast");
    let fault = outcome.err().expect("missing fault");
    assert_eq!(fault.code, "keyless_fixture_invalid");
}

#[test]
fn red_chat_fixture_with_responses_entry_rejected() {
    let runtime = load_runtime();
    let mut counter = MockTransportIdentityCounter::new();
    let fixture = chat_fixture(); // path = /v1/chat/completions
    let outcome = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        mock_provider_frame_ok(),
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-m",
        "conv-m",
        "responses", // expects /v1/responses but fixture path is /v1/chat/completions
        "direct",
    );
    assert!(outcome.is_err(), "chat fixture path cannot serve responses entry");
    let fault = outcome.err().expect("missing fault");
    assert_eq!(fault.code, "keyless_fixture_invalid");
    assert!(fault.message.contains("/v1/chat/completions"), "error must name the mismatched path");
}

#[test]
fn red_responses_path_with_chat_body_rejected() {
    let runtime = load_runtime();
    let mut counter = MockTransportIdentityCounter::new();
    // Path matches the responses entry, but the raw body still declares chat.
    let fixture = KeylessChatFixture::new(
        "POST",
        "/v1/responses",
        Vec::new(),
        "chat:hello-world".to_string(),
        "responses-model".to_string(),
    );
    let outcome = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        mock_provider_frame_ok(),
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-body",
        "conv-body",
        "responses",
        "direct",
    );
    let fault = outcome.expect_err("body must match entry protocol");
    assert_eq!(fault.code, "keyless_fixture_invalid");
    assert!(fault.message.contains("body"), "error must name the mismatched body");
}

#[test]
fn red_empty_server_id_fails_fast() {
    let runtime = load_runtime();
    let mut counter = MockTransportIdentityCounter::new();
    let fixture = chat_fixture();
    let outcome = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        mock_provider_frame_ok(),
        "",
        "2026-08-17",
        TEST_PORT,
        "session-z",
        "conv-z",
        "chat",
        "relay",
    );
    assert!(outcome.is_err(), "empty server_id must fail fast");
    let fault = outcome.err().expect("missing fault");
    assert!(is_known_mock_transport_fault_code(&fault.code));
    assert_eq!(fault.code, "keyless_fixture_invalid");
}

#[test]
fn red_empty_fixture_model_fails_fast() {
    let runtime = load_runtime();
    let mut counter = MockTransportIdentityCounter::new();
    let fixture = KeylessChatFixture::chat("chat:hello-world", "");
    let outcome = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        mock_provider_frame_ok(),
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-model",
        "conversation-model",
        "chat",
        "relay",
    );
    let fault = outcome.expect_err("empty model must fail fast");
    assert_eq!(fault.code, "keyless_fixture_invalid");
}

#[test]
fn red_empty_continuation_scope_fails_fast() {
    let runtime = load_runtime();
    let mut counter = MockTransportIdentityCounter::new();
    let fixture = chat_fixture();
    let outcome = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        mock_provider_frame_ok(),
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-scope",
        "",
        "chat",
        "relay",
    );
    let fault = outcome.expect_err("empty conversation scope must fail fast");
    assert_eq!(fault.code, "keyless_fixture_invalid");
}

#[test]
fn red_malformed_provider_frame_flows_error_chain_with_real_scope() {
    let runtime = load_runtime();
    let mut counter = MockTransportIdentityCounter::new();
    let fixture = chat_fixture();
    let report = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        "this-is-not-json",
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-err",
        "conv-err",
        "chat",
        "relay",
    )
    .expect("raw_parse fault must be projected as a typed error");
    let error = report
        .error
        .as_ref()
        .expect("malformed frame must surface a typed error");
    assert!(
        MOCK_TRANSPORT_FAULT_CODES.contains(&error.fault_code.as_str()),
        "fault code {} must be in the recognised mock transport slice set",
        error.fault_code
    );
    assert!(
        error
            .client_projection_message
            .contains("malformed provider JSON"),
        "client projection must carry the json_parse reason: {:?}",
        error.client_projection_message
    );
    assert_eq!(report.continuation_committed, false);
    // The error projection scope is NOT the old fake "mock-transport-slice/port=0";
    // it is the real request-bound scope from the same request id.
    assert!(
        report.error_projection_scope.is_some(),
        "error projection scope must be the real ExecutionReport.scope, not a static placeholder"
    );
    let scope = report.error_projection_scope.as_ref().unwrap();
    assert_eq!(
        scope,
        &Scope::new(
            &report.request_id,
            "v4-skeleton",
            TEST_PORT,
            "session-err",
            "conv-err",
        ),
        "error projection scope must be the real request scope, not a static placeholder"
    );
}

#[test]
fn red_blank_provider_frame_fails_fast() {
    let runtime = load_runtime();
    let mut counter = MockTransportIdentityCounter::new();
    let fixture = chat_fixture();
    let outcome = execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture,
        "   \n  ",
        "srv-m8",
        "2026-08-17",
        TEST_PORT,
        "session-blank",
        "conv-blank",
        "chat",
        "relay",
    );
    assert!(outcome.is_err(), "blank provider frame must fail fast");
    let fault = outcome.err().expect("missing fault");
    assert_eq!(fault.code, "keyless_fixture_invalid");
}
