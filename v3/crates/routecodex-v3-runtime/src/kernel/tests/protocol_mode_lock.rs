use super::*;
use routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyController;
use std::sync::atomic::{AtomicUsize, Ordering};

struct DirectOnlyFailureTransport {
    sends: AtomicUsize,
}

struct DirectProviderFamilyFailureTransport {
    sends: AtomicUsize,
}

struct DirectProviderCompatTerminalTransport {
    sends: AtomicUsize,
}

struct DirectTransportFailureWithoutResponse {
    sends: AtomicUsize,
}

const HANDOFF_DIRECT_PROVIDER: &str = "first_handoff_busy_r5";
const HANDOFF_RELAY_PROVIDER: &str = "chat_handoff_busy_r5";

fn mixed_protocol_capacity_handoff_manifest(routing_group: &str) -> V3Config05ManifestPublished {
    let mut manifest = mixed_protocol_reselection_manifest();
    manifest.servers.get_mut("test").unwrap().execution.as_mut().unwrap()
        .attempt_store.residence_timeout_ms = 2000;
    let mut direct = manifest
        .providers
        .remove("first")
        .expect("mixed manifest direct provider");
    direct.id = HANDOFF_DIRECT_PROVIDER.to_string();
    manifest
        .providers
        .insert(HANDOFF_DIRECT_PROVIDER.to_string(), direct);
    let mut relay = manifest
        .providers
        .remove("chat")
        .expect("mixed manifest Relay provider");
    relay.id = HANDOFF_RELAY_PROVIDER.to_string();
    relay.auth.entries[0].env =
        Some("ROUTECODEX_TEST_745F6E9_HANDOFF_BUSY_MISSING_SECRET".to_string());
    manifest
        .providers
        .insert(HANDOFF_RELAY_PROVIDER.to_string(), relay);
    for provider_id in [HANDOFF_DIRECT_PROVIDER, HANDOFF_RELAY_PROVIDER] {
        manifest.providers.get_mut(provider_id).unwrap().concurrency = Some(
            routecodex_v3_config::V3ProviderConcurrencyAuthoringConfig {
                max_in_flight: 1,
                acquire_timeout_ms: 200,
                stale_lease_ms: 10_000,
            },
        );
    }
    for target in &mut manifest
        .forwarders
        .get_mut("mixed")
        .expect("mixed forwarder")
        .targets
    {
        match target.provider.as_deref() {
            Some("first") => target.provider = Some(HANDOFF_DIRECT_PROVIDER.to_string()),
            Some("chat") => target.provider = Some(HANDOFF_RELAY_PROVIDER.to_string()),
            _ => {}
        }
    }
    scoped_test_manifest(manifest, routing_group)
}

fn saturate_handoff_capacity(provider_key: &str) -> Vec<V3AdaptiveConcurrencyLease> {
    let controller = V3AdaptiveConcurrencyController::process_shared();
    let scope = routecodex_v3_provider_responses::adaptive_concurrency::V3ConcurrencyIdentityScope {
        interface_id: "default".into(),
        model_id: "test".into(),
    };
    controller.ensure_initial_budget(provider_key, 1).unwrap();
    let held = controller.try_acquire_business_scoped(provider_key, Some(&scope))
        .expect("one real scoped business lease fills the declared maxInFlight=1");
    let snapshot = controller.snapshot_for_scope(provider_key, Some(&scope)).unwrap();
    assert_eq!(snapshot.hard_max_in_flight, 1);
    assert_eq!(snapshot.in_flight, 1);
    assert_eq!(snapshot.rate_limit_samples, 0, "capacity fixture does not invent a429");
    assert!(controller.try_acquire_business_scoped(provider_key, Some(&scope)).is_none());
    vec![held]
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

#[async_trait]
impl ResponsesTransport for DirectProviderFamilyFailureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        assert_eq!(request.provider_id(), "first");
        if self.sends.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(V3ProviderError::HttpStatus {
                response: Box::new(routecodex_v3_provider_responses::V3ProviderHttpFailure {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    status: 400,
                    headers: Vec::new(),
                    body: br#"{"error":{"type":"invalid_request_error","message":"prompt is too long"}}"#.to_vec(),
                    body_read_failure: None,
                }),
            });
        }
        assert_eq!(request.body()["model"], "wire-sibling");
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            br#"{"id":"resp_sibling","status":"completed","output_text":"ok"}"#.to_vec(),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for DirectProviderCompatTerminalTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.sends.fetch_add(1, Ordering::SeqCst);
        Err(V3ProviderError::HttpStatus {
            response: Box::new(routecodex_v3_provider_responses::V3ProviderHttpFailure {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                status: 400,
                headers: Vec::new(),
                body:
                    br#"{"error":{"type":"invalid_request_error","message":"prompt is too long"}}"#
                        .to_vec(),
                body_read_failure: None,
            }),
        })
    }
}

#[async_trait]
impl ResponsesTransport for DirectTransportFailureWithoutResponse {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.sends.fetch_add(1, Ordering::SeqCst);
        Err(V3ProviderError::Transport {
            request_id: request.request_id().to_string(),
            provider_id: request.provider_id().to_string(),
            reason: "connection closed before response headers".to_string(),
        })
    }
}

async fn direct_busy_cross_protocol_handoff(
    manifest: &V3Config05ManifestPublished,
    routing_group: &str,
    request_id: &str,
) -> crate::V3ResponsesProtocolRelayHandoff {
    let raw = test_responses_raw(
        routing_group,
        request_id,
        &format!("exec-{request_id}"),
        json!({"model": "client-model", "input": "hello"}),
    );
    let transport = ProviderConcurrencyRecordingTransport::default();
    let output = crate::execute_v3_responses_direct_runtime_kernel(
        manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert!(
        transport.sends.lock().unwrap().is_empty(),
        "busy Direct admission must hand off before provider transport"
    );
    assert!(output.error_chain.is_none(), "{output:?}");
    let handoff = output
        .protocol_relay_handoff
        .expect("Direct busy admission must hand off the Chat candidate");
    assert_eq!(handoff.target.candidate.provider_id, HANDOFF_RELAY_PROVIDER);
    assert!(
        handoff
            .request_local_busy_candidates
            .contains(&format!("{HANDOFF_DIRECT_PROVIDER}:default:key:test")),
        "temporary busy A must cross the typed handoff in its classified resource: {handoff:?}"
    );
    assert!(!handoff.request_local_excluded_candidates
        .contains(&format!("{HANDOFF_DIRECT_PROVIDER}:default:key:test")),
        "temporary capacity cannot become a permanent request-shape exclusion");
    handoff
}

async fn exhaust_handoff_at_relay(
    manifest: &V3Config05ManifestPublished,
    handoff: crate::V3ResponsesProtocolRelayHandoff,
    relay_health: &crate::V3ResponsesRelayProviderHealthHandle,
    routing_group: &str,
    request_id: &str,
    use_handoff_target: bool,
) -> crate::V3ResponsesRelayRuntimeOutput {
    let relay_seeds = handoff.relay_runtime_seeds();
    let selected_target = if use_handoff_target {
        Some(handoff.target)
    } else {
        None
    };
    let expanded = handoff.expanded;
    let excluded = handoff.request_local_excluded_candidates;
    let output = crate::execute_v3_responses_relay_runtime_with_default_transport_health(
        manifest,
        crate::V3ResponsesRelayRuntimeInput {
            server_id: "test".to_string(),
            failure_session_scope: test_failure_session_scope(routing_group),
            request_id: request_id.to_string(),
            payload: json!({"model": "client-model", "input": "hello"}),
        },
        relay_health,
        crate::V3ResponsesRelayProviderSnapshotCapture::new(true, true),
        None,
        None,
        selected_target,
        Some(expanded),
        excluded,
        relay_seeds,
    )
    .await
    .expect("Relay handoff exhaustion must return typed runtime output");
    output
}

#[tokio::test]
async fn direct_to_relay_handoff_preserves_capacity_busy_exhaustion_source() {
    let routing_group = "handoff_capacity_busy_r5";
    let manifest = mixed_protocol_capacity_handoff_manifest(routing_group);
    let first_capacity_key = format!("{HANDOFF_DIRECT_PROVIDER}:key");
    let second_capacity_key = format!("{HANDOFF_RELAY_PROVIDER}:key");
    let relay_health =
        crate::V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&manifest);

    let held_first = saturate_handoff_capacity(&first_capacity_key);
    let handoff =
        direct_busy_cross_protocol_handoff(&manifest, routing_group, "req-handoff-busy-r5").await;
    let held_second = saturate_handoff_capacity(&second_capacity_key);
    let output = exhaust_handoff_at_relay(
        &manifest,
        handoff,
        &relay_health,
        routing_group,
        "req-handoff-busy-r5",
        true,
    )
    .await;
    let snapshots = output
        .provider_snapshots
        .as_ref()
        .expect("Relay handoff output must retain provider snapshot evidence");
    assert!(
        snapshots.provider_request.is_none() && snapshots.provider_response.is_none(),
        "Relay admission exhaustion must not send a provider request: {output:?}"
    );
    release_capacity_leases(held_first);
    release_capacity_leases(held_second);
    V3AdaptiveConcurrencyController::process_shared()
        .observe_business_success(&first_capacity_key, 0)
        .expect("clear first capacity saturation");
    V3AdaptiveConcurrencyController::process_shared()
        .observe_business_success(&second_capacity_key, 0)
        .expect("clear second capacity saturation");

    assert_eq!(output.status, 502, "{output:?}");
    let source = output
        .diagnostic_source
        .as_ref()
        .expect("all-busy handoff exhaustion must retain its typed source");
    assert_eq!(
        source.source_kind,
        routecodex_v3_error::V3ErrorSourceKind::TargetPoolExhausted
    );
    assert_eq!(
        source.code, "provider_concurrency_busy",
        "busy provenance from Direct must remain exact across Relay handoff"
    );
    let observability = output
        .observability
        .as_ref()
        .expect("all-busy handoff exhaustion must retain typed observability");
    assert_eq!(observability.entry_protocol, "responses");
    assert_eq!(observability.execution_mode, "relay");

    let held_first = saturate_handoff_capacity(&first_capacity_key);
    let mut handoff =
        direct_busy_cross_protocol_handoff(&manifest, routing_group, "req-handoff-mixed-r5").await;
    let relay_busy_key = crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key(
        &handoff.target.candidate,
    );
    assert!(
        !handoff
            .request_local_busy_candidates
            .contains(&relay_busy_key),
        "mixed Relay candidate must stay outside capacity-busy provenance"
    );
    handoff
        .request_local_excluded_candidates
        .insert(relay_busy_key);
    let output = exhaust_handoff_at_relay(
        &manifest,
        handoff,
        &relay_health,
        routing_group,
        "req-handoff-mixed-r5",
        false,
    )
    .await;
    release_capacity_leases(held_first);
    V3AdaptiveConcurrencyController::process_shared()
        .observe_business_success(&first_capacity_key, 0)
        .expect("clear mixed first capacity saturation");

    assert_eq!(output.status, 502, "{output:?}");
    let source = output
        .diagnostic_source
        .as_ref()
        .expect("mixed handoff exhaustion must retain its typed source");
    assert_eq!(
        source.source_kind,
        routecodex_v3_error::V3ErrorSourceKind::ProviderFailure
    );
    assert_eq!(
        source.code, "selected_target_exhausted",
        "non-capacity exclusion must not be relabeled as provider_concurrency_busy"
    );
    let observability = output
        .observability
        .as_ref()
        .expect("mixed handoff exhaustion must retain typed observability");
    assert_eq!(observability.entry_protocol, "responses");
    assert_eq!(observability.execution_mode, "relay");
}

#[tokio::test]
async fn direct_generic_provider_http_400_reselects_untried_sibling_model() {
    let routing_group = "direct_provider_compat_sibling";
    let manifest = scoped_test_manifest(provider_compat_sibling_manifest(), routing_group);
    let raw = V3Server03HttpRequestRaw {
        request_purpose: V3RequestPurpose::Conversation,
        port: Some(7777),
        pipeline_id: Some("test-pipeline:test-session:direct-provider-compat".to_string()),
        server_id: "test".to_string(),
        failure_session_scope: test_failure_session_scope(routing_group),
        request_id: "req-direct-provider-compat".to_string(),
        execution_id: "exec-direct-provider-compat".to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        body: json!({"model":"client-model","input":"hello"}),
    };
    let transport = DirectProviderFamilyFailureTransport {
        sends: AtomicUsize::new(0),
    };
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("protocol plan");
    assert_eq!(plan.decision.target.candidate.provider_id, "first");
    assert_eq!(plan.decision.target.candidate.model_id, "test");

    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::new().with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert!(
        output.node_trace.contains(&"V3TargetLocalReselected"),
        "generic provider HTTP 400 must preserve the untried sibling: {output:?}"
    );
    assert_eq!(
        transport.sends.load(Ordering::SeqCst),
        2,
        "one failed model and one successful sibling attempt: {output:?}"
    );
    assert!(
        output.error_chain.is_none(),
        "successful sibling must complete without a terminal error: {output:?}"
    );
    assert_eq!(output.client_payload.status, 200);
}

#[tokio::test]
async fn direct_generic_provider_http_400_terminal_exhaustion_has_no_health_or_wait() {
    let routing_group = "direct_provider_compat_terminal";
    let mut manifest = scoped_test_manifest(provider_compat_single_manifest(), routing_group);
    // The controller is process-shared; isolate this test's provider identity
    // so another test's legitimate lease cannot contaminate the zero assertion.
    let provider_id = "direct_terminal_lease_test";
    let mut provider = manifest.providers.remove("first").unwrap();
    provider.id = provider_id.into();
    manifest.providers.insert(provider_id.into(), provider);
    for target in &mut manifest.forwarders.get_mut("responses").unwrap().targets {
        target.provider = Some(provider_id.into());
    }
    manifest.servers.get_mut("test").unwrap().execution.as_mut().unwrap().attempt_store.residence_timeout_ms = 300;
    let raw = V3Server03HttpRequestRaw {
        request_purpose: V3RequestPurpose::Conversation,
        port: Some(7777),
        pipeline_id: Some("test-pipeline:test-session:direct-provider-compat-terminal".to_string()),
        server_id: "test".to_string(),
        failure_session_scope: test_failure_session_scope(routing_group),
        request_id: "req-direct-provider-compat-terminal".to_string(),
        execution_id: "exec-direct-provider-compat-terminal".to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        body: json!({"model":"client-model","input":"hello"}),
    };
    let transport = DirectProviderCompatTerminalTransport {
        sends: AtomicUsize::new(0),
    };
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("protocol plan");
    assert_eq!(plan.decision.target.candidate.provider_id, provider_id);
    assert_eq!(plan.decision.target.candidate.model_id, "test");

    let execution = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::new().with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &transport,
    );
    tokio::pin!(execution);
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut execution).await.is_err(),
        "last HTTP400 remains pending inside its original residence budget");
    assert_eq!(transport.sends.load(Ordering::SeqCst), 1);
    assert_eq!(V3AdaptiveConcurrencyController::process_shared()
        .snapshot("direct_terminal_lease_test:key").unwrap().total_provider_in_flight, 0,
        "pending request releases its failed business lease");
    let output = tokio::time::timeout(Duration::from_secs(3), execution).await
        .expect("original residence ends only this request");

    assert_eq!(
        transport.sends.load(Ordering::SeqCst),
        1,
        "generic provider HTTP 400 must not retry the same candidate: {output:?}"
    );
    assert_eq!(output.observability.as_ref().and_then(|value| value.attempts), Some(1),
        "exhaustion must preserve its completed provider attempt: {output:?}");
    assert!(matches!(output.terminal_disposition, Some(V3ProviderTerminalDisposition::ExternalHttp(ref witness))
        if witness.status() == 400 && String::from_utf8_lossy(witness.body()).contains("prompt is too long")),
        "original provider400 stays in the typed terminal witness, not the client wire: {output:?}");
    assert!(
        output.error_chain.is_some(),
        "generic provider HTTP 400 exhaustion must retain its internal error: {output:?}"
    );
    let observation = output
        .observability
        .expect("generic provider failure must publish observability");
    assert!(observation.timing.is_some(), "exhaustion must finish the original Runtime timing");
    let failure = observation
        .provider_failure_events
        .first()
        .expect("generic provider failure event");
    assert_eq!(failure.error_type.as_deref(), Some("provider_http_400"));
    assert_eq!(failure.health_state, "last_candidate_terminal");
    assert_eq!(failure.failure_count, 0);
    assert_eq!(failure.wait_ms, Some(0), "the failure event records the immediate re-evaluation; the original request budget owns subsequent waiting");
    assert!(
        !observation
            .unavailable_candidates
            .contains(&"first:default:key:test".to_string()),
        "last candidate HTTP 400 must not exclude the candidate"
    );
}

#[tokio::test]
async fn direct_transport_failure_without_response_keeps_last_candidate_health_neutral() {
    let routing_group = "direct_transport_last_candidate";
    let mut manifest = scoped_test_manifest(provider_compat_single_manifest(), routing_group);
    manifest.servers.get_mut("test").unwrap().execution.as_mut().unwrap()
        .attempt_store.residence_timeout_ms = 300;
    let raw = V3Server03HttpRequestRaw {
        request_purpose: V3RequestPurpose::Conversation,
        port: Some(7777),
        pipeline_id: Some("test-pipeline:test-session:direct-transport-last-candidate".to_string()),
        server_id: "test".to_string(),
        failure_session_scope: test_failure_session_scope(routing_group),
        request_id: "req-direct-transport-last-candidate".to_string(),
        execution_id: "exec-direct-transport-last-candidate".to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        body: json!({"model":"client-model","input":"hello"}),
    };
    let transport = DirectTransportFailureWithoutResponse {
        sends: AtomicUsize::new(0),
    };
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("protocol plan");
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::new().with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(
        transport.sends.load(Ordering::SeqCst),
        1,
        "a response-less transport failure must not retry the last candidate: {output:?}"
    );
    let observation = output
        .observability
        .expect("transport failure must publish observability");
    let failure = observation
        .provider_failure_events
        .first()
        .expect("transport failure event");
    assert_eq!(
        failure.error_type.as_deref(),
        Some("provider_transport_error"),
        "{failure:?}"
    );
    assert_eq!(
        failure.health_state, "last_candidate_terminal",
        "the response-less transport failure must use the terminal health-neutral boundary: {failure:?}"
    );
    assert_eq!(failure.failure_count, 0);
    assert_eq!(failure.cooldown_until_ms, None);
}

#[tokio::test]
async fn direct_reselect_can_handoff_to_relay_target_after_provider_failure() {
    let transport = DirectOnlyFailureTransport {
        sends: AtomicUsize::new(0),
    };
    let routing_group = "cross_protocol_reselection";
    let manifest = scoped_test_manifest(mixed_protocol_reselection_manifest(), routing_group);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let raw = V3Server03HttpRequestRaw {
        request_purpose: V3RequestPurpose::Conversation,
        port: Some(7777),
        pipeline_id: Some("test-pipeline:test-session:cross_protocol_reselection".to_string()),
        server_id: "test".to_string(),
        failure_session_scope: test_failure_session_scope(routing_group),
        request_id: "req".to_string(),
        execution_id: "exec".to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        body: json!({"model":"client-model","input":"hello"}),
    };
    let continuation_request = raw.clone();
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        health.clone(),
        0,
    )
    .expect("protocol plan");
    assert_eq!(
        plan.decision.mode,
        V3Execution11ProtocolDecisionMode::SameProtocolDirect
    );
    assert!(plan
        .protocol_candidate_keys
        .contains("first:default:key:test"));
    assert!(!plan.protocol_candidate_keys.contains("chat:key:test"));

    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::new()
            .with_provider_health(health.clone())
            .with_initial_plan(&plan),
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
    let continued = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        continuation_request,
        health,
        0,
    ).expect("the shared typed health owner must survive protocol handoff");
    assert_eq!(continued.decision.target.candidate.provider_id, "chat",
        "pending failure must remain excluded when Relay selects from the same captured identities");
    assert_eq!(handoff.provider_failure_events.len(), 1);
    assert_eq!(handoff.provider_failure_events[0].health_state, "pre_cool_observation",
        "recoverable exclusion stays in the exact health owner instead of becoming a permanent request-shape exclusion");
    assert_eq!(
        transport.sends.load(Ordering::SeqCst),
        1,
        "Direct must not retry the failed first provider when a route candidate remains"
    );
    assert_eq!(
        handoff.request_execution_control.transport_attempts(),
        1,
        "typed Direct-to-Relay handoff must carry the admitted transport attempt"
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
        V3ResponsesDirectRuntimeCoreState::new()
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
fn compact_direct_protocol_plan_keeps_typed_compact_pool_after_route_policy() {
    let authoring = routecodex_v3_config::parse_v3_config_02_authoring(
        r#"
version = 3
[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client"]
allowed_transports = ["json"]
[providers.primary]
type = "responses"
base_url = "http://primary.invalid/v1"
default_model = "primary-model"
auth = { type = "api_key", entries = [{ alias = "key", env = "PRIMARY_KEY" }] }
[providers.primary.models.primary-model]
capabilities = ["text"]
[route_groups.default]
compact_route_object = "compact"
[[route_groups.default.route_policies]]
id = "compact-purpose"
precedence = 10
condition = { kind = "current_compaction" }
action = { select_route_pool = "compact" }
[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "primary", model = "primary-model", key = "key", priority = 1 }]
[route_groups.default.pools.compact]
route_object = "compact"
selection = { strategy = "priority" }
match = { precedence = 5, entry_protocol = "responses" }
targets = [{ kind = "provider_model", provider = "primary", model = "primary-model", key = "key", priority = 1 }]
"#,
    )
    .expect("compact test config");
    let manifest = routecodex_v3_config::compile_v3_config_05_manifest(authoring)
        .expect("compact test manifest");
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        V3Server03HttpRequestRaw {
            request_purpose: V3RequestPurpose::NativeCompaction,
            port: None,
            pipeline_id: None,
            server_id: "test".to_string(),
            failure_session_scope: test_failure_session_scope("default"),
            request_id: "compact-plan".to_string(),
            execution_id: "compact-plan-exec".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses/compact".to_string(),
            body: json!({"model":"primary-model","input":"compact"}),
        },
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("compact protocol plan");
    assert_eq!(plan.decision.target.route.pool_id, "compact");
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
        request_purpose: V3RequestPurpose::Conversation,
        port: None,
        pipeline_id: None,
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
            request_purpose: V3RequestPurpose::Conversation,
            port: None,
            pipeline_id: None,
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

#[test]
fn protocol_mismatch_is_decided_before_same_protocol_process_policy() {
    let manifest = test_manifest();
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        V3Server03HttpRequestRaw {
            request_purpose: V3RequestPurpose::Conversation,
            port: None,
            pipeline_id: None,
            server_id: "test".to_string(),
            failure_session_scope: test_failure_session_scope("default"),
            request_id: "req-protocol-first".to_string(),
            execution_id: "exec-protocol-first".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            body: json!({"model":"client-model","input":"hello"}),
        },
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("baseline plan");
    let mut selected = plan.decision.target;
    selected.candidate.responses_process = Some("chat".to_string());

    let error = build_v3_execution_11_protocol_decision_from_v3_target_10(
        selected,
        "anthropic_messages",
        &["direct".to_string()],
    )
    .expect_err("protocol mismatch must require Relay before reading same-protocol policy");

    assert_eq!(error.code, "responses_process_chat_relay_not_allowed");
}
