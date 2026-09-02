//! routecodex-v4-runtime L2 regression (compiled through build-link
//! test-consumer with Active deps routecodex-v4-error/base-node and
//! --source-deps routecodex-v4-skeleton).

use routecodex_v4_base_node::Scope;
use routecodex_v4_control::{ControlError, ControlSignal, ControlSignalKind, MetadataOperation};
use routecodex_v4_error::{DecisionAction, ErrorChain, ErrorStage, ExecutionDecision, RetryPolicy};
use routecodex_v4_runtime::{
    assert_no_control_leak, bind_scope_via_bridge, execution_binding, project_runtime_fault,
    project_runtime_fault_with_policy, release_scope_via_bridge, select_relay_operator,
    ContinuationFacts, ContinuationKey, ExecutionBinding, ExecutionContext, PayloadCycleError,
    PayloadCycleRegistry, PayloadCycleState, RelayOperator, ResponseStreamDisposition,
    ResponseStreamProcessor, ScopeError, ScopeRegistry, SkeletonRuntime,
};
use routecodex_v4_standard_plugins::sse_transport::SseTransportFrame;
use serde_json::json;
use std::fs;

mod support;

fn active_runtime() -> SkeletonRuntime {
    support::active_runtime(&contract_json())
}

fn contract_json() -> String {
    let path = std::env::var("RUNTIME_CONTRACT_PATH").unwrap_or_else(|_| {
        format!(
            "{}/../../contracts/skeleton-plan.contract.json",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    fs::read_to_string(&path).expect("skeleton plan contract must be readable from v4 root")
}

fn scope(request_id: &str) -> Scope {
    Scope::new(
        request_id,
        "v4-pipeline",
        5555,
        "session-1",
        "conversation-1",
    )
}

fn first_sse_data_json(frame: &str) -> serde_json::Value {
    let payload = frame
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .expect("SSE data line must exist");
    serde_json::from_str(payload).expect("SSE data must be JSON")
}

fn bridge_scope(operation: &str) -> serde_json::Value {
    json!({
        "scope_command": {
            "entry_protocol": "responses",
            "continuation_owner": "direct",
            "pipeline_id": "v4-pipeline",
            "port": 5555,
            "session_scope": "session-1",
            "conversation_scope": "conversation-1",
            "request_id": "request-1",
            "full_input_hash": "sha256:full-input",
            "operation": operation,
            "sequence": 1
        }
    })
}

#[test]
fn bridge_scope_bind_and_release_reach_registry_truth() {
    let mut registry = ScopeRegistry::new();
    let key = ContinuationKey::new("responses", "direct", 5555, "session-1", "conversation-1");
    let bind = bind_scope_via_bridge(&bridge_scope("bind"), &mut registry)
        .expect("typed bridge bind reaches ScopeRegistry");
    assert_eq!(bind.operation, "bind");
    assert!(registry.is_bound(&key));

    let release = release_scope_via_bridge(&bridge_scope("release"), &mut registry)
        .expect("typed bridge release reaches ScopeRegistry");
    assert_eq!(release.operation, "release");
    assert!(matches!(
        registry.restore(&key, "request-2", Some("sha256:full-input")),
        Err(ScopeError::RestoreAfterRelease)
    ));
}

#[test]
fn bridge_scope_missing_or_duplicate_bind_fails_fast() {
    let mut registry = ScopeRegistry::new();
    assert!(matches!(
        bind_scope_via_bridge(&json!({}), &mut registry),
        Err(ScopeError::NotBound)
    ));
    bind_scope_via_bridge(&bridge_scope("bind"), &mut registry).expect("first bind succeeds");
    assert!(matches!(
        bind_scope_via_bridge(&bridge_scope("bind"), &mut registry),
        Err(ScopeError::AlreadyBound)
    ));
}

#[test]
fn bridge_scope_rejects_malformed_operation_and_payload_lookalike() {
    let mut registry = ScopeRegistry::new();
    assert!(matches!(
        bind_scope_via_bridge(&bridge_scope("replace"), &mut registry),
        Err(ScopeError::InvalidBridgeControl)
    ));
    let mut unknown = bridge_scope("bind");
    unknown["scope_command"]["payload_hint"] = json!(true);
    assert!(matches!(
        bind_scope_via_bridge(&unknown, &mut registry),
        Err(ScopeError::InvalidBridgeControl)
    ));
    assert!(matches!(
        bind_scope_via_bridge(
            &json!({"normal_payload": bridge_scope("bind")["scope_command"].clone()}),
            &mut registry,
        ),
        Err(ScopeError::NotBound)
    ));
}

#[test]
fn bridge_scope_release_without_bind_fails_fast() {
    let mut registry = ScopeRegistry::new();
    assert!(matches!(
        release_scope_via_bridge(&bridge_scope("release"), &mut registry),
        Err(ScopeError::NotBound)
    ));
}

#[test]
fn bridge_bound_scope_rejects_all_isolation_mismatches() {
    let mut registry = ScopeRegistry::new();
    bind_scope_via_bridge(&bridge_scope("bind"), &mut registry)
        .expect("typed bind reaches ScopeRegistry");

    let mismatches = [
        (
            ContinuationKey::new("responses", "relay", 5555, "session-1", "conversation-1"),
            ScopeError::OwnerMismatch,
        ),
        (
            ContinuationKey::new("chat", "direct", 5555, "session-1", "conversation-1"),
            ScopeError::EntryProtocolMismatch,
        ),
        (
            ContinuationKey::new("responses", "direct", 5556, "session-1", "conversation-1"),
            ScopeError::PortMismatch,
        ),
        (
            ContinuationKey::new("responses", "direct", 5555, "session-2", "conversation-1"),
            ScopeError::SessionMismatch,
        ),
        (
            ContinuationKey::new("responses", "direct", 5555, "session-1", "conversation-2"),
            ScopeError::ConversationMismatch,
        ),
    ];
    for (key, expected) in mismatches {
        let error = registry
            .restore(&key, "request-2", Some("sha256:full-input"))
            .expect_err("isolation mismatch must fail");
        assert_eq!(error, expected);
    }
}

#[test]
fn positive_request_chain_produces_wire_and_stable_binding() {
    let runtime = active_runtime();
    let plan = runtime.plan();
    let report = runtime
        .execute_request_json_scoped(
            r#"{"model":"m","messages":[{"role":"user","content":"hello"}]}"#,
            "chat",
            "m",
            false,
            "r-request-1",
            5555,
            "session-request",
            "conversation-request",
            Some("relay"),
        )
        .expect("request chain runs");
    let wire = report
        .provider_wire_value
        .as_ref()
        .expect("provider wire produced");
    assert_eq!(wire["model"], "m");
    assert_eq!(wire["messages"][0]["content"], "hello");
    assert_eq!(wire["stream"], false);
    assert_eq!(
        report.binding,
        execution_binding(plan),
        "execution binding must match the loaded plan"
    );
    let semantic_trace = report
        .trace
        .iter()
        .filter(|entry| !entry.contains(":plugin.executed:"))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(
        semantic_trace,
        vec![
            "request.inbound_normalize",
            "request.continuation_classify",
            "v4.std.contract.input_validate:node.input_validated:standard input validator",
            "request.chat_process",
            "v4.std.diagnostic.debug_observe:node.debug_observe:debug observation emitted",
            "v4.std.diagnostic.timing:node.timing:timing observation emitted",
            "v4.std.diagnostic.snapshot_record:node.snapshot:snapshot observation emitted",
            "v4.std.diagnostic.request_payload_console_render:console.payload_ready:▶ [req] model=m stream=false messages=1 tools=0",
            "request.execution_plan",
            "request.route_facts",
            "request.target_resolve",
            "request.provider_semantic",
            "request.wire_build",
            "request.transport",
            "v4.std.provider.transport_validate:node.provider_transport_validated:provider wire transport boundary validated",
        ]
    );
    assert_eq!(report.continuation_owner.as_deref(), Some("relay"));
    assert!(!report.continuation_committed);
    assert!(!report.continuation_restored);
}

#[test]
fn responses_entry_runs_direct_lane_without_relay_projection() {
    let runtime = active_runtime();
    let report = runtime
        .execute_request_json_scoped(
            r#"{"model":"m","input":[]}"#,
            "responses",
            "m",
            false,
            "r-direct-1",
            5555,
            "session-direct",
            "conversation-direct",
            Some("direct"),
        )
        .expect("responses request chain runs");
    let wire = report
        .provider_wire_value
        .as_ref()
        .expect("Responses provider wire produced");
    assert_eq!(wire["model"], "m");
    assert_eq!(wire["input"], json!([]));
    assert_eq!(wire["stream"], false);
    assert!(!report.relay_operator_selected);
    assert!(!report.continuation_committed);
    assert!(!report.continuation_restored);
    assert_eq!(
        report.scope,
        Scope::new(
            "r-direct-1",
            "v4-skeleton",
            5555,
            "session-direct",
            "conversation-direct",
        )
    );
}

#[test]
fn relay_request_chat_to_responses_is_plugin_owned() {
    let runtime = active_runtime();
    let report = runtime
        .execute_request_json_scoped_for_target_with_lease(
            r#"{"model":"m","messages":[{"role":"user","content":"hello"}],"max_tokens":8}"#,
            "chat",
            "responses",
            "m",
            false,
            "r-chat-responses-plugin",
            5555,
            "session-chat-responses",
            "conversation-chat-responses",
            Some("relay"),
            None,
        )
        .expect("chat to Responses request chain runs");
    let wire = report.provider_wire_value.expect("provider wire produced");
    assert_eq!(wire["input"][0]["content"], "hello");
    assert!(wire.get("messages").is_none());
    assert_eq!(wire["max_output_tokens"], 8);
    assert!(wire.get("codec").is_none(), "production wire must not use mock codec handle");
    assert!(report
        .trace
        .iter()
        .all(|entry| !entry.contains("build_retry_wire")));
}

#[test]
fn relay_request_runs_all_contract_bound_request_plugins() {
    let runtime = active_runtime();
    let report = runtime
        .execute_request_json_scoped_for_target_with_lease(
            r#"{"model":"m","messages":[{"role":"user","content":"hello"}],"tools":[]}"#,
            "chat",
            "responses",
            "m",
            false,
            "r-all-request-plugins",
            5555,
            "session-all-request",
            "conversation-all-request",
            Some("relay"),
            None,
        )
        .expect("relay request with full contract plugin set runs");
    let wire = report
        .provider_wire_value
        .expect("provider wire produced");
    assert_eq!(
        wire["input"][0]["content"],
        json!("hello"),
        "responses_normalize + responses_wire_build must execute in relay_request"
    );
}

#[test]
fn relay_request_governance_plugin_rejects_invalid_tools_shape() {
    let runtime = active_runtime();
    let error = runtime
        .execute_request_json_scoped_for_target_with_lease(
            r#"{"model":"m","messages":[{"role":"user","content":"hello"}],"tools":{}}"#,
            "chat",
            "responses",
            "m",
            false,
            "r-request-governance-red",
            5555,
            "session-request-governance",
            "conversation-request-governance",
            Some("relay"),
            None,
        )
        .expect_err("request governance must reject non-array tools");
    assert_eq!(error.code, "execution_engine");
    assert!(
        error.message.contains("request_governance"),
        "failure must identify the governance plugin owner: {}",
        error.message
    );
}

#[test]
fn active_runtime_epoch_pins_every_production_contract_binding() {
    let runtime = active_runtime();
    let contract: serde_json::Value =
        serde_json::from_str(&contract_json()).expect("contract parses");
    let production_chains = [
        "direct_request",
        "direct_response",
        "relay_request",
        "relay_response",
        "error",
        "control",
    ];
    let mut contract_bindings = contract["chains"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|chain| {
            chain["chain_id"]
                .as_str()
                .map(|id| production_chains.contains(&id))
                .unwrap_or(false)
        })
        .flat_map(|chain| chain["nodes"].as_array().into_iter().flatten())
        .flat_map(|node| node["plugins"].as_array().into_iter().flatten())
        .filter_map(|binding| binding["plugin_id"].as_str())
        .filter(|id| id.starts_with("v4.std."))
        .map(str::to_string)
        .collect::<Vec<_>>();
    contract_bindings.sort();
    contract_bindings.dedup();

    let mut epoch_plugins = runtime.epoch_plugin_ids();
    epoch_plugins.sort();
    let missing = contract_bindings
        .iter()
        .filter(|id| !epoch_plugins.contains(id))
        .cloned()
        .collect::<Vec<_>>();

    assert!(
        missing.is_empty(),
        "production contract bindings not pinned by active epoch:\n{}",
        missing.join("\n")
    );
}

#[test]
fn one_admission_lease_survives_request_provider_response_to_terminal() {
    let runtime = active_runtime();
    let lease = runtime
        .admit_request("r-lease-lifecycle")
        .expect("admission");
    assert_eq!(lease.snapshot().in_flight_leases, 1);
    let request = runtime
        .execute_request_json_scoped_with_lease(
            r#"{"model":"m","input":[]}"#,
            "responses",
            "m",
            false,
            "r-lease-lifecycle",
            5555,
            "session-1",
            "conversation-1",
            Some("direct"),
            Some(&lease),
        )
        .expect("request through admitted lease");
    assert_eq!(request.request_id, "r-lease-lifecycle");
    assert!(request
        .trace
        .iter()
        .any(|entry| entry.starts_with("v4.hook.direct.request:plugin.executed:")),
        "request must carry a typed plugin execution witness, trace={:?}", request.trace
    );
    assert_eq!(lease.snapshot().in_flight_leases, 1);
    let response = runtime
        .execute_provider_response_scoped_with_lease(
            r#"{"id":"resp_lease","model":"m","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}"#,
            "r-lease-lifecycle",
            5555,
            "session-1",
            "conversation-1",
            "responses",
            "direct",
            Some(&lease),
        )
        .expect("terminal response through same lease");
    assert!(response.client_frame.is_some());
    assert_eq!(lease.snapshot().in_flight_leases, 1);
    drop(lease);
}

#[test]
fn relay_operator_select_uses_typed_facts_only() {
    let relay = select_relay_operator(&ContinuationFacts::new("chat", "hub", "relay", "relay"))
        .expect("chat + relay owner selects relay operator");
    assert_eq!(relay, RelayOperator::Relay);
    let direct = select_relay_operator(&ContinuationFacts::new(
        "responses",
        "responses",
        "direct",
        "direct",
    ))
    .expect("responses + direct owner selects direct operator");
    assert_eq!(direct, RelayOperator::Direct);
    let responses_relay = select_relay_operator(&ContinuationFacts::new(
        "responses",
        "responses",
        "relay",
        "relay",
    ))
    .expect_err("responses + local relay owner must fail fast");
    assert_eq!(responses_relay.code, "relay_operator_select");
    let chat_direct =
        select_relay_operator(&ContinuationFacts::new("chat", "hub", "direct", "direct"))
            .expect_err("chat entry with direct owner must fail (no typed-facts match)");
    assert_eq!(chat_direct.code, "relay_operator_select");
}

#[test]
fn responses_relay_lane_does_not_create_local_continuation() {
    let runtime = active_runtime();
    let report = runtime
        .execute_request_json_scoped(
            r#"{"model":"gpt-wire","input":[]}"#,
            "responses",
            "gpt-wire",
            false,
            "r-local-owner",
            5520,
            "session-local",
            "conversation-local",
            Some("relay"),
        )
        .expect("fresh Responses Relay execution lane remains valid");
    let wire = report
        .provider_wire_value
        .as_ref()
        .expect("Responses provider wire produced");
    assert_eq!(wire["model"], "gpt-wire");
    assert_eq!(wire["input"], json!([]));
    assert_eq!(wire["stream"], false);
    assert_eq!(report.continuation_owner.as_deref(), Some("relay"));
    assert!(!report.continuation_committed);
    assert!(!report.continuation_restored);
    assert!(!report.relay_operator_selected);
}

#[test]
fn red_session_only_restore_fails_fast() {
    let mut registry = ScopeRegistry::new();
    let full_key = ContinuationKey::new("responses", "direct", 5555, "session-1", "conversation-1");
    registry
        .bind(full_key.clone(), "r-sess-save", Some("sha256:full"))
        .expect("bind succeeds");
    // Session-only restore is impossible by construction: a key carrying only
    // session/conversation (empty entry protocol and owner) cannot match the
    // three-key binding and must fail fast.
    let session_only = ContinuationKey::new("", "", 5555, "session-1", "conversation-1");
    let error = registry
        .restore(&session_only, "r-sess-restore", Some("sha256:full"))
        .expect_err("session-only restore must fail");
    assert_eq!(error, ScopeError::OwnerMismatch);
}

#[test]
fn red_immutable_interval_double_restore_fails() {
    let mut registry = ScopeRegistry::new();
    let key = ContinuationKey::new("responses", "direct", 5555, "session-1", "conversation-1");
    registry
        .bind(key.clone(), "r-imm-save", Some("sha256:full"))
        .expect("bind succeeds");
    registry
        .restore(&key, "r-imm-restore-1", Some("sha256:full"))
        .expect("first restore succeeds");
    let error = registry
        .restore(&key, "r-imm-restore-2", Some("sha256:full"))
        .expect_err("second restore must fail (immutable interval)");
    assert_eq!(error, ScopeError::ImmutableIntervalViolation);
}

#[test]
fn payload_cycle_open_merge_terminal_lifecycle() {
    let mut registry = PayloadCycleRegistry::new();
    let opened = registry
        .open("r-cycle-1", "sha256:original")
        .expect("open succeeds");
    assert_eq!(opened.state, PayloadCycleState::Open);
    assert_eq!(opened.attempts, 1);
    let merged = registry.merge_retry("r-cycle-1").expect("merge succeeds");
    assert_eq!(merged.attempts, 2);
    let closed = registry.close_success("r-cycle-1").expect("success close");
    assert_eq!(closed.state, PayloadCycleState::SuccessTerminal);
    let error = registry
        .merge_retry("r-cycle-1")
        .expect_err("merge after terminal must fail");
    assert_eq!(error, PayloadCycleError::MergeAfterTerminal);
}

#[test]
fn payload_cycle_error_terminal_and_double_close_red() {
    let mut registry = PayloadCycleRegistry::new();
    registry
        .open("r-cycle-2", "sha256:original")
        .expect("open succeeds");
    let closed = registry.close_error("r-cycle-2").expect("error close");
    assert_eq!(closed.state, PayloadCycleState::ErrorTerminal);
    let error = registry
        .close_success("r-cycle-2")
        .expect_err("close after terminal must fail");
    assert_eq!(error, PayloadCycleError::AlreadyTerminal);
    let mut second = PayloadCycleRegistry::new();
    second
        .open("r-cycle-3", "sha256:original")
        .expect("first open succeeds");
    let open_twice = second
        .open("r-cycle-3", "sha256:original")
        .expect_err("second open of the same request must fail");
    assert_eq!(open_twice, PayloadCycleError::OpenTwice);
}

#[test]
fn positive_provider_response_chain_projects_client_frame() {
    let runtime = active_runtime();
    let report = runtime
        .execute_provider_response_scoped_for_target_with_lease(
            r#"{"id":"resp_1","model":"m","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}"#,
            "r-response-1",
            5555,
            "session-response",
            "conversation-response",
            "responses",
            "responses",
            "direct",
            None,
        )
        .expect("provider response chain runs");
    let frame: serde_json::Value = serde_json::from_str(
        report
            .client_frame
            .as_deref()
            .expect("client frame produced"),
    )
    .expect("client frame is Responses JSON");
    assert_eq!(frame["output"][0]["content"][0]["text"], "ok");
    assert!(!report.continuation_committed);
}

#[test]
fn direct_provider_transport_envelope_projects_response_json() {
    let runtime = active_runtime();
    let report = runtime
        .execute_provider_response_scoped_for_target_with_lease(
            r#"{"_provider_http_status":200,"_provider_http_body":"{\"id\":\"resp_envelope\",\"object\":\"response\",\"model\":\"m\",\"output\":[]}"} "#,
            "r-response-envelope",
            5555,
            "session-response-envelope",
            "conversation-response-envelope",
            "responses",
            "responses",
            "direct",
            None,
        )
        .expect("direct response envelope must decode");
    let frame: serde_json::Value = serde_json::from_str(
        report
            .client_frame
            .as_deref()
            .expect("client frame produced"),
    )
    .expect("client frame is JSON");
    assert_eq!(frame["id"], "resp_envelope");
    assert_eq!(frame["object"], "response");
}

fn response_stream_processor(
    runtime: &SkeletonRuntime,
    request_id: &str,
    entry_protocol: &str,
    provider_protocol: &str,
    continuation_owner: &str,
) -> ResponseStreamProcessor {
    let request_lease = runtime.admit_request(request_id).expect("stream admission");
    let body = if entry_protocol == "chat" {
        r#"{"model":"m","messages":[{"role":"user","content":"hello"}]}"#
    } else {
        r#"{"model":"m","input":[]}"#
    };
    let report = runtime
        .execute_request_json_scoped_for_target_with_lease(
            body,
            entry_protocol,
            provider_protocol,
            "m",
            true,
            request_id,
            5555,
            "session-stream",
            "conversation-stream",
            Some(continuation_owner),
            Some(&request_lease),
        )
        .expect("request chain establishes exact stream scope");
    ResponseStreamProcessor::new(
        request_lease,
        report.scope,
        5555,
        entry_protocol,
        provider_protocol,
        continuation_owner,
        "session-stream",
        "conversation-stream",
    )
    .expect("typed stream processor")
}

fn transport_frame(bytes: &[u8]) -> SseTransportFrame {
    SseTransportFrame::from_complete_bytes(bytes.to_vec()).expect("complete transport frame")
}

#[test]
fn direct_stream_processor_keeps_continue_and_terminal_typed() {
    let runtime = active_runtime();
    let mut processor = response_stream_processor(
        &runtime,
        "r-stream-direct",
        "responses",
        "responses",
        "direct",
    );
    assert_eq!(processor.lease_snapshot().in_flight_leases, 1);

    let delta = processor
        .process_frame(
            &runtime,
            transport_frame(
                b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
            ),
        )
        .expect("direct delta");
    let ResponseStreamDisposition::Continue { frame } = delta else {
        panic!("delta must remain non-terminal");
    };
    assert!(String::from_utf8_lossy(frame.as_bytes()).contains("response.output_text.delta"));
    assert_eq!(processor.lease_snapshot().in_flight_leases, 1);

    let completed = processor
        .process_frame(
            &runtime,
            transport_frame(
                b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"m\",\"output\":[]}}\n\n",
            ),
        )
        .expect("direct terminal");
    let ResponseStreamDisposition::Terminal { frame } = completed else {
        panic!("response.completed must be terminal");
    };
    assert!(String::from_utf8_lossy(frame.as_bytes()).contains("event: response.completed"));
    processor.finish().expect("terminal stream closes cleanly");
    assert_eq!(processor.lease_snapshot().in_flight_leases, 1);
}

#[test]
fn relay_stream_processor_projects_client_protocol_after_response_chain() {
    let runtime = active_runtime();
    let mut processor =
        response_stream_processor(&runtime, "r-stream-relay", "chat", "responses", "relay");
    let projected = processor
        .process_frame(
            &runtime,
            transport_frame(
                b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
            ),
        )
        .expect("relay delta");
    let ResponseStreamDisposition::Continue { frame } = projected else {
        panic!("relay delta must remain non-terminal");
    };
    let text = String::from_utf8_lossy(frame.as_bytes());
    assert!(text.starts_with("data: {"));
    assert!(text.contains("chat.completion.chunk"));
    assert!(!text.contains("event: response.output_text.delta"));
}

#[test]
fn response_failed_projects_one_error_without_success_closeout() {
    let runtime = active_runtime();
    let mut processor =
        response_stream_processor(&runtime, "r-stream-failed", "chat", "responses", "relay");
    let projected = processor
        .process_frame(
            &runtime,
            transport_frame(
                b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"upstream failed\"}}}\n\n",
            ),
        )
        .expect("failed event enters error chain");
    let ResponseStreamDisposition::Failure { frame } = projected else {
        panic!("response.failed must not become success terminal");
    };
    let text = String::from_utf8_lossy(frame.as_bytes());
    assert!(text.contains("upstream failed"));
    assert!(!text.contains("response.completed"));
    assert!(!text.contains("[DONE]"));

    let duplicate = processor
        .project_failure(&runtime, routecodex_v4_runtime::RuntimeFault::new(
            "second_failure",
            "must not project twice",
        ))
        .expect_err("one stream may project only one failure");
    assert_eq!(duplicate.code, "response_stream_failure_duplicate");
}

#[test]
fn response_stream_eof_before_terminal_fails_fast() {
    let runtime = active_runtime();
    let mut processor =
        response_stream_processor(&runtime, "r-stream-eof", "responses", "responses", "direct");
    let fault = processor
        .finish()
        .expect_err("EOF without provider terminal truth must fail");
    assert_eq!(fault.code, "provider_sse_eof_before_terminal");
}

#[test]
fn relay_json_projects_responses_to_chat_semantic() {
    let runtime = active_runtime();
    let report = runtime
        .execute_provider_response_scoped(
            "{\"id\":\"resp_1\",\"model\":\"m\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}]}",
            "r-relay-json",
            5555,
            "session-relay-json",
            "conversation-relay-json",
            "chat",
            "relay",
        )
        .expect("relay JSON must traverse response nodes");
    let frame: serde_json::Value = serde_json::from_str(
        report
            .client_frame
            .as_deref()
            .expect("chat frame must exist"),
    )
    .expect("chat frame must be JSON");
    assert_eq!(frame["object"], "chat.completion");
    assert_eq!(frame["choices"][0]["message"]["content"], "hello");
    assert!(!report.continuation_committed);
    assert_eq!(report.continuation_owner.as_deref(), Some("relay"));
}

#[test]
fn relay_json_projects_tool_calls_and_usage_to_chat_contract() {
    let runtime = active_runtime();
    let report = runtime
        .execute_provider_response_scoped(
            "{\"id\":\"resp_tool\",\"model\":\"m\",\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"{}\"}],\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"total_tokens\":18}}",
            "r-relay-json-tool",
            5555,
            "session-relay-json-tool",
            "conversation-relay-json-tool",
            "chat",
            "relay",
        )
        .expect("relay JSON tool response must traverse response nodes");
    let frame: serde_json::Value = serde_json::from_str(
        report
            .client_frame
            .as_deref()
            .expect("chat frame must exist"),
    )
    .expect("chat frame must be JSON");
    let tool = &frame["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(tool["id"], "call_1");
    assert_eq!(tool["function"]["name"], "lookup");
    assert!(tool.get("index").is_none());
    assert_eq!(frame["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(frame["usage"]["prompt_tokens"], 11);
    assert_eq!(frame["usage"]["completion_tokens"], 7);
    assert_eq!(frame["usage"]["total_tokens"], 18);
    assert!(frame["usage"].get("input_tokens").is_none());
    assert!(frame["usage"].get("output_tokens").is_none());
}

#[test]
fn relay_sse_function_arguments_delta_is_preserved() {
    let runtime = active_runtime();
    let mut processor = response_stream_processor(
        &runtime,
        "r-relay-sse-tool-args",
        "chat",
        "responses",
        "relay",
    );
    let disposition = processor
        .process_frame(
            &runtime,
            transport_frame(
                b"event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"{\\\"city\\\":\"}\n\n",
            ),
        )
        .expect("relay SSE tool arguments must traverse the stream processor");
    let ResponseStreamDisposition::Continue { frame } = disposition else {
        panic!("tool arguments delta must remain non-terminal");
    };
    let frame = first_sse_data_json(&String::from_utf8_lossy(frame.as_bytes()));
    assert_eq!(frame["choices"][0]["delta"]["tool_calls"][0]["index"], 1);
    assert_eq!(
        frame["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"],
        "{\"city\":"
    );
}

#[test]
fn relay_sse_tool_terminal_projects_tool_calls_finish_reason() {
    let runtime = active_runtime();
    let mut processor = response_stream_processor(
        &runtime,
        "r-relay-sse-tool-terminal",
        "chat",
        "responses",
        "relay",
    );
    let disposition = processor
        .process_frame(
            &runtime,
            transport_frame(
                b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_tool\",\"model\":\"m\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"{}\"}]}}\n\n",
            ),
        )
        .expect("relay SSE tool terminal must traverse the stream processor");
    let ResponseStreamDisposition::Terminal { frame } = disposition else {
        panic!("response.completed must be terminal");
    };
    let frame = first_sse_data_json(&String::from_utf8_lossy(frame.as_bytes()));
    assert_eq!(frame["choices"][0]["finish_reason"], "tool_calls");
}

#[test]
fn red_invalid_input_flows_typed_error_path_to_terminal_projection() {
    let runtime = active_runtime();
    let mut chain = ErrorChain::new(scope("r-error-1"));
    let fault = runtime
        .execute_request_json_scoped(
            "{",
            "responses",
            "m",
            false,
            "r-error-1",
            5555,
            "session-error",
            "conversation-error",
            Some("direct"),
        )
        .expect_err("malformed production JSON must fail the request chain");
    assert_eq!(fault.code, "request_json_invalid");
    assert!(fault.node_id.is_none());

    let projection = project_runtime_fault(&mut chain, fault).expect("fault must project");
    assert_eq!(projection.code, "request_json_invalid");
    assert_eq!(chain.current_stage(), Some(ErrorStage::ClientProjected));
    assert!(chain.is_terminal());
    assert_eq!(chain.records().count(), 6, "01..06 stages must be recorded");
    assert!(
        !projection.message.contains("continuation_scope"),
        "client projection must not carry control fields"
    );
}

#[test]
fn provider_policy_decision_enters_error_chain_without_payload_control() {
    let mut chain = ErrorChain::new(scope("r-error-policy"));
    let projection = project_runtime_fault_with_policy(
        &mut chain,
        routecodex_v4_runtime::RuntimeFault::new("provider_http_401", "upstream unauthorized"),
        RetryPolicy {
            policy_id: "account_http_401_two_errors".to_string(),
            provider_scope: "auth_key".to_string(),
            matcher: "http_status=401".to_string(),
            action_class: "retry_then_cooldown".to_string(),
            reason_code: "provider_account_http_401".to_string(),
        },
        ExecutionDecision {
            decision_id: "decision.reselect".to_string(),
            action: DecisionAction::Reroute,
            reason_code: "provider_account_http_401".to_string(),
        },
    )
    .expect("policy decision projects");
    assert_eq!(projection.code, "provider_http_401");
    assert_eq!(chain.current_stage(), Some(ErrorStage::ClientProjected));
    assert!(chain
        .records()
        .any(|record| { record.detail.as_deref() == Some("account_http_401_two_errors") }));
}

#[test]
fn red_external_chain_plugins_never_run_inside_runtime() {
    let runtime = active_runtime();
    for chain_id in ["error", "config"] {
        let error = runtime
            .execute_chain(chain_id, &format!("r-ext-{chain_id}"))
            .expect_err("external-owned chain must not execute in the runtime");
        assert_eq!(error.code, "execution_chain_external_owner");
    }
}

#[test]
fn red_control_leak_into_wire_fails() {
    let binding = ExecutionBinding {
        skeleton_version: "v4-skeleton-1".to_string(),
        manifest_hash: "sha256:test".to_string(),
        plan_epoch: 1,
        plan_hash: "sha256:test".to_string(),
    };
    let mut ctx = ExecutionContext::new("r-leak-1", binding);
    ctx.control.continuation_scope = Some("scope:typed-only".to_string());
    ctx.control.route_facts = Some("facts:typed-only".to_string());
    ctx.data.provider_wire = Some("{\"continuation_scope\":\"business-data\"}".to_string());
    ctx.data.client_frame = Some("{\"route_facts\":\"business-data\"}".to_string());
    let error = assert_no_control_leak(&ctx).expect_err("control fields in wire must fail fast");
    assert_eq!(error.code, "control_payload_leak");
    assert_eq!(
        ctx.control.continuation_scope.as_deref(),
        Some("scope:typed-only")
    );
    assert_eq!(ctx.control.route_facts.as_deref(), Some("facts:typed-only"));
}

#[test]
fn red_binding_drift_fails() {
    let binding = ExecutionBinding {
        skeleton_version: "v4-skeleton-1".to_string(),
        manifest_hash: "sha256:test".to_string(),
        plan_epoch: 1,
        plan_hash: "sha256:test".to_string(),
    };
    let mut ctx = ExecutionContext::new("r-drift-1", binding);
    let before = ctx.binding().clone();
    ctx.binding_mut().plan_hash = "sha256:drifted".to_string();
    assert_ne!(ctx.binding(), &before);
}

#[test]
fn red_cross_request_reuse_fails() {
    let runtime = active_runtime();
    runtime.claim("r-reuse-1").expect("first claim succeeds");
    let error = runtime
        .execute_request_json_scoped(
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}]}"#,
            "chat",
            "m",
            false,
            "r-reuse-1",
            5555,
            "session-reuse",
            "conversation-reuse",
            Some("relay"),
        )
        .expect_err("second claim of the same request id must fail");
    assert_eq!(error.code, "cross_request_reuse");
    runtime.release("r-reuse-1");
    runtime
        .execute_request_json_scoped(
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}]}"#,
            "chat",
            "m",
            false,
            "r-reuse-1",
            5555,
            "session-reuse",
            "conversation-reuse",
            Some("relay"),
        )
        .expect("after release the request id is reusable");
}

#[test]
fn control_resources_lifecycle_positive_and_red() {
    use routecodex_v4_runtime::{
        ControlLedgerRecord, DryRunExecutionError, NodeStatistic, StoplessError, StoplessFacts,
        V4Control02RecordLedger, V4Control03NodeStatistics, V4Debug09DryRunNoNetworkTerminalEffect,
        V4RuntimeObservability, V4RuntimeTimingSummary, V4StoplessControlState,
    };

    // Stopless: store -> consume -> clear; double-store and empty-clear are red.
    let mut stopless = V4StoplessControlState::new();
    stopless
        .store_for_scope(StoplessFacts {
            entry_endpoint: "responses".to_string(),
            session_id: "s-1".to_string(),
            conversation_id: "c-1".to_string(),
            port: 5555,
            routing_group: "rg-1".to_string(),
        })
        .expect("first store must succeed");
    assert_eq!(stopless.consume().unwrap().port, 5555);
    stopless.clear_for_scope().expect("clear must succeed");
    assert!(matches!(stopless.consume(), Err(StoplessError::NotStored)));
    let mut store_twice = || -> Result<(), StoplessError> {
        stopless.store_for_scope(StoplessFacts {
            entry_endpoint: "chat".to_string(),
            session_id: "s-2".to_string(),
            conversation_id: "c-2".to_string(),
            port: 5555,
            routing_group: "rg-1".to_string(),
        })?;
        stopless.store_for_scope(StoplessFacts {
            entry_endpoint: "chat".to_string(),
            session_id: "s-2".to_string(),
            conversation_id: "c-2".to_string(),
            port: 5555,
            routing_group: "rg-1".to_string(),
        })
    };
    assert!(matches!(store_twice(), Err(StoplessError::AlreadyStored)));

    // Ledger: append immutable; duplicate record id is red.
    let mut ledger = V4Control02RecordLedger::new();
    ledger
        .append(ControlLedgerRecord {
            record_id: "r-1".to_string(),
            node_id: "V4ScopeRegistry".to_string(),
            direction: "in".to_string(),
            control_key: "scope.bind".to_string(),
            scope_key: "scope-a".to_string(),
            payload_hash: Some("sha256:abc".to_string()),
        })
        .expect("append must succeed");
    assert_eq!(ledger.scope_records("scope-a").count(), 1);
    assert!(matches!(
        ledger.append(ControlLedgerRecord {
            record_id: "r-1".to_string(),
            node_id: "V4ScopeRegistry".to_string(),
            direction: "in".to_string(),
            control_key: "scope.bind".to_string(),
            scope_key: "scope-a".to_string(),
            payload_hash: Some("sha256:abc".to_string()),
        }),
        Err(routecodex_v4_runtime::ControlLedgerError::ImmutableRecord)
    ));

    // Statistics: diagnostic-only counters, never decision input.
    let mut stats = V4Control03NodeStatistics::new();
    stats
        .record("V4ScopeRegistry", "bind", "scope-a", false)
        .unwrap();
    stats
        .record("V4ScopeRegistry", "bind", "scope-a", true)
        .unwrap();
    let snapshot: Vec<NodeStatistic> = stats.snapshot().cloned().collect();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].invocations, 2);
    assert_eq!(snapshot[0].errors, 1);

    // Dry-run: registered fixture executes with no network effect; empty
    // fixture id is red.
    let mut dry_run = V4Debug09DryRunNoNetworkTerminalEffect::new();
    let execution = dry_run
        .execute(
            "fixture-1",
            "exec-1",
            "V4ServerReqInbound01ClientRaw",
            "V4ServerRespOutbound06ClientFrame",
            "sha256:input",
        )
        .expect("dry-run must execute");
    assert_eq!(execution.terminal_state, "dry_run_terminal");
    assert_eq!(dry_run.executions().count(), 1);
    assert!(matches!(
        dry_run.execute(
            "",
            "exec-2",
            "V4ServerReqInbound01ClientRaw",
            "V4ServerRespOutbound06ClientFrame",
            "sha256:input"
        ),
        Err(DryRunExecutionError::FixtureMissing)
    ));

    // Observability + timing: diagnostic projections only.
    let mut observability = V4RuntimeObservability::new();
    observability.accumulator().record(
        "req-1",
        "responses",
        "relay",
        "rg-1",
        "cc",
        "deepseek-v4-flash",
    );
    assert_eq!(observability.summaries().count(), 1);
    let mut timing = V4RuntimeTimingSummary::new();
    timing.state().record_phase("resp_chatprocess", 42);
    assert_eq!(timing.total_micros("resp_chatprocess"), 42);
}

#[test]
fn metadata_center_lifecycle_register_consume_release() {
    let binding = ExecutionBinding {
        skeleton_version: "v4-skeleton-1".to_string(),
        manifest_hash: "sha256:test".to_string(),
        plan_epoch: 1,
        plan_hash: "sha256:test".to_string(),
    };
    let mut ctx = ExecutionContext::new("r-meta-1", binding);
    let signal = ControlSignal::new(
        ControlSignalKind::Route,
        "route.target",
        "sha256:value",
        ctx.scope().clone(),
        Some("sha256:payload"),
    );
    let registered = ctx
        .control
        .metadata
        .register(signal)
        .expect("register must succeed within the request scope");
    assert_eq!(registered.operation, MetadataOperation::Register);
    assert!(ctx.control.metadata.is_registered("route.target"));

    let consumed = ctx
        .control
        .metadata
        .consume("route.target")
        .expect("consume must succeed while registered");
    assert_eq!(consumed.key, "route.target");
    assert!(ctx.control.metadata.is_registered("route.target"));

    let released = ctx
        .control
        .metadata
        .release("route.target")
        .expect("release must succeed while registered");
    assert_eq!(released.operation, MetadataOperation::Release);
    assert!(ctx.control.metadata.is_released("route.target"));

    let ops: Vec<MetadataOperation> = ctx
        .control
        .metadata
        .records()
        .map(|record| record.operation)
        .collect();
    assert_eq!(
        ops,
        vec![
            MetadataOperation::Register,
            MetadataOperation::Consume,
            MetadataOperation::Release
        ]
    );
}

#[test]
fn metadata_center_scope_isolation_red() {
    let binding = ExecutionBinding {
        skeleton_version: "v4-skeleton-1".to_string(),
        manifest_hash: "sha256:test".to_string(),
        plan_epoch: 1,
        plan_hash: "sha256:test".to_string(),
    };
    let mut ctx = ExecutionContext::new("r-meta-a", binding);
    let foreign_scope = Scope::new("r-other", "v4-other", 6666, "sess-other", "conv-other");
    let signal = ControlSignal::new(
        ControlSignalKind::Route,
        "route.target",
        "sha256:value",
        foreign_scope,
        None,
    );
    let error = ctx
        .control
        .metadata
        .register(signal)
        .expect_err("cross-scope signal must fail at the owning boundary");
    assert!(matches!(error, ControlError::ScopeMismatch));
    assert!(!ctx.control.metadata.is_registered("route.target"));
}

#[test]
fn metadata_center_cross_request_reuse_fails() {
    let binding = ExecutionBinding {
        skeleton_version: "v4-skeleton-1".to_string(),
        manifest_hash: "sha256:test".to_string(),
        plan_epoch: 1,
        plan_hash: "sha256:test".to_string(),
    };
    let mut first = ExecutionContext::new("r-meta-x", binding.clone());
    let signal = ControlSignal::new(
        ControlSignalKind::Route,
        "route.target",
        "sha256:value",
        first.scope().clone(),
        None,
    );
    first
        .control
        .metadata
        .register(signal)
        .expect("register in the owning request must succeed");

    let mut second = ExecutionContext::new("r-meta-y", binding);
    let error = second
        .control
        .metadata
        .consume("route.target")
        .expect_err("control state must never be reusable across requests");
    assert!(matches!(error, ControlError::NotRegistered));
    assert!(first.control.metadata.is_registered("route.target"));
}
