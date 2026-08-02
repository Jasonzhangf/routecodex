use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct DirectOnlyFailureTransport {
    sends: AtomicUsize,
}

#[async_trait]
impl ResponsesTransport for DirectOnlyFailureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        assert_eq!(request.provider_id(), "first");
        self.sends.fetch_add(1, Ordering::SeqCst);
        Err(V3ProviderError::Transport {
            request_id: request.request_id().to_string(),
            provider_id: request.provider_id().to_string(),
            reason: "first failed before relay-only candidate".to_string(),
        })
    }
}

#[tokio::test]
async fn direct_reselect_can_handoff_to_relay_target_after_provider_failure() {
    let transport = DirectOnlyFailureTransport {
        sends: AtomicUsize::new(0),
    };
    let routing_group = "cross_protocol_reselection";
    let manifest = scoped_test_manifest(mixed_protocol_reselection_manifest(), routing_group);
    let raw = V3Server03HttpRequestRaw {
        server_id: "test".to_string(),
        failure_session_scope: test_failure_session_scope(routing_group),
        request_id: "req".to_string(),
        execution_id: "exec".to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        body: json!({"model":"client-model","input":"hello"}),
    };
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("protocol plan");
    assert_eq!(
        plan.decision.mode,
        V3Execution11ProtocolDecisionMode::SameProtocolDirect
    );
    assert!(plan.protocol_candidate_keys.contains("first:key:test"));
    assert!(!plan.protocol_candidate_keys.contains("chat:key:test"));

    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation().with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert!(transport.sends.load(Ordering::SeqCst) >= 1);
    assert!(
        output.node_trace.contains(&"V3TargetLocalReselected"),
        "provider failure should reselect across the full route pool: {output:?}"
    );
    assert!(
        output.error_chain.is_none(),
        "typed relay handoff must not be projected as a client error: {output:?}"
    );
    let handoff = output
        .protocol_relay_handoff
        .expect("reselected chat target should hand off to Relay");
    assert_eq!(handoff.target.candidate.provider_id, "chat");
    assert_eq!(
        handoff.observability_accumulator.attempts(),
        1,
        "Direct-to-Relay handoff must carry the completed provider attempt",
    );
    assert!(handoff
        .expanded
        .candidates
        .iter()
        .any(|candidate| candidate.provider_id == "first"));
    assert!(handoff
        .expanded
        .candidates
        .iter()
        .any(|candidate| candidate.provider_id == "chat"));
    assert!(
        handoff
            .request_local_excluded_candidates
            .contains("first:key:test"),
        "Relay must inherit the request-local Direct failure exclusion"
    );
    assert_eq!(
        transport.sends.load(Ordering::SeqCst),
        1,
        "Direct must not retry the failed first provider when a route candidate remains"
    );
}

#[tokio::test]
async fn direct_continues_relay_handoff_attempts_and_timing_without_payload_leakage() {
    let accumulator = V3RuntimeObservabilityAccumulator::start();
    let timing = accumulator.timing();
    timing.start_external().unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    timing.finish_external().unwrap();
    let accumulator = accumulator.with_additional_attempts(1);

    let manifest = test_manifest();
    let raw = test_responses_raw(
        "test",
        "req-relay-to-direct-observability",
        "exec-relay-to-direct-observability",
        json!({"model":"client-model","input":"hello"}),
    );
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("protocol plan");
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_initial_plan(&plan)
            .with_observability_accumulator(Some(accumulator)),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &CaptureTransport,
    )
    .await;

    let observability = output.observability.expect("terminal observability");
    assert_eq!(observability.attempts, Some(2));
    assert!(observability.timing.expect("request-wide timing").external > Duration::ZERO);
    let V3ClientBody::Json(client_payload) = output.client_payload.body else {
        panic!("expected JSON client payload");
    };
    assert!(client_payload.get("observability").is_none());
    assert!(client_payload.get("timing").is_none());
}

#[test]
fn relay_only_same_protocol_responses_is_planned_as_hub_relay() {
    let mut manifest = test_manifest();
    manifest
        .servers
        .get_mut("test")
        .expect("test server")
        .execution
        .as_mut()
        .expect("execution policy")
        .allowed_modes = vec!["relay".to_string()];
    let raw = V3Server03HttpRequestRaw {
        server_id: "test".to_string(),
        failure_session_scope: test_failure_session_scope("default"),
        request_id: "req-relay-only".to_string(),
        execution_id: "exec-relay-only".to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        body: json!({"model":"client-model","input":"hello"}),
    };

    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw,
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("same-protocol Responses must remain valid through Relay-only execution");

    assert_eq!(
        plan.decision.mode,
        V3Execution11ProtocolDecisionMode::HubRelay
    );
}

#[test]
fn same_protocol_without_direct_or_relay_fails_explicitly() {
    let manifest = test_manifest();
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        V3Server03HttpRequestRaw {
            server_id: "test".to_string(),
            failure_session_scope: test_failure_session_scope("default"),
            request_id: "req-no-mode".to_string(),
            execution_id: "exec-no-mode".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            body: json!({"model":"client-model","input":"hello"}),
        },
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("baseline plan");

    let error = build_v3_execution_11_protocol_decision_from_v3_target_10(
        plan.decision.target,
        "responses",
        &[],
    )
    .expect_err("same protocol without an allowed execution mode must fail");

    assert_eq!(error.code, "protocol_same_execution_mode_not_allowed");
}
