//! Independent Cordis parity red tests.
//!
//! Each case executes the real mock transport entry and checks one semantic
//! stage invariant. The assertions are deliberately separate so a missing
//! stage cannot be hidden by an aggregate pipeline result.

use routecodex_v4_runtime::{execute_mock_transport_slice, KeylessChatFixture, MockTransportIdentityCounter};

mod support;

const CONTRACT_JSON: &str = include_str!("../../../contracts/skeleton-plan.contract.json");

fn fixture() -> KeylessChatFixture {
    KeylessChatFixture::chat(
        r#"{"model":"mock-model","messages":[{"role":"user","content":"hello"}]}"#,
        "mock-model",
    )
}

fn trace_for(protocol: &str, owner: &str) -> Vec<String> {
    let runtime = support::active_runtime(CONTRACT_JSON);
    let mut counter = MockTransportIdentityCounter::new();
    execute_mock_transport_slice(
        &runtime,
        &mut counter,
        &fixture(),
        r#"{"id":"resp-red","object":"response","output":[]}"#,
        "red-stages",
        "2026-09-01",
        7777,
        "red-session",
        "red-conversation",
        protocol,
        owner,
    )
    .expect("valid fixture must reach the real transport entry")
    .trace
}

fn requires_trace(protocol: &str, owner: &str, stage: &str) {
    let trace = trace_for(protocol, owner);
    assert!(
        trace.iter().any(|entry| entry == stage),
        "stage {stage} must publish its independent semantic checkpoint; trace={trace:?}"
    );
}

#[test]
fn request_inbound_normalize_red() { requires_trace("chat", "relay", "request.inbound_normalize"); }
#[test]
fn request_continuation_classify_red() { requires_trace("chat", "relay", "request.continuation_classify"); }
#[test]
fn request_chat_process_red() { requires_trace("chat", "relay", "request.chat_process"); }
#[test]
fn request_execution_plan_red() { requires_trace("chat", "relay", "request.execution_plan"); }
#[test]
fn request_route_facts_red() { requires_trace("chat", "relay", "request.route_facts"); }
#[test]
fn request_target_resolve_red() { requires_trace("chat", "relay", "request.target_resolve"); }
#[test]
fn request_provider_semantic_red() { requires_trace("chat", "relay", "request.provider_semantic"); }
#[test]
fn request_wire_build_red() { requires_trace("chat", "relay", "request.wire_build"); }
#[test]
fn request_transport_red() { requires_trace("chat", "relay", "request.transport"); }

#[test]
fn response_provider_inbound_red() { requires_trace("chat", "relay", "response.provider_inbound"); }
#[test]
fn response_normalize_red() { requires_trace("chat", "relay", "response.normalize"); }
#[test]
fn response_response_process_red() { requires_trace("chat", "relay", "response.response_process"); }
#[test]
fn response_continuation_commit_red() { requires_trace("chat", "relay", "response.continuation_commit"); }
#[test]
fn response_client_projection_red() { requires_trace("chat", "relay", "response.client_projection"); }
#[test]
fn response_frame_red() { requires_trace("chat", "relay", "response.frame"); }
