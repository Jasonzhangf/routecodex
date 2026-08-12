use super::*;

#[tokio::test]
async fn missing_exact_pin_is_provider_availability_error05_without_router_reentry() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    struct NoSendTransport {
        sends: AtomicUsize,
    }

    #[async_trait]
    impl ResponsesTransport for NoSendTransport {
        async fn send(
            &self,
            _request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            self.sends.fetch_add(1, Ordering::SeqCst);
            panic!("missing exact pin must never enter provider transport")
        }
    }

    let mut manifest = test_manifest();
    manifest.servers.get_mut("test").unwrap().routing_group = "missing_exact_pin".to_string();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let continuation_scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-missing-exact-pin",
        "conversation-missing-exact-pin",
        4444,
        "missing_exact_pin",
    );
    let pin = V3RemoteContinuationPin::new("openai", "gpt-test", "key1");
    let capability_revision = capability_revision_for_pin(&manifest, &pin).unwrap();
    continuation_state
        .store
        .lock()
        .unwrap()
        .commit(V3RemoteContinuationCommitInput::locator_only(
            V3RemoteContinuationLocator::new_direct(
                "resp_missing_exact_pin",
                continuation_scope.key.clone(),
                pin,
                capability_revision,
                1_000,
                60_000,
            ),
        ))
        .unwrap();
    manifest.providers.remove("openai");
    let transport = NoSendTransport {
        sends: AtomicUsize::new(0),
    };

    let started = Instant::now();
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(
            &continuation_state,
            continuation_scope,
            2_000,
        ),
        &manifest,
        V3Server03HttpRequestRaw {
            server_id: "test".to_string(),
            failure_session_scope: test_failure_session_scope("test"),
            request_id: "req-missing-exact-pin".to_string(),
            execution_id: "exec-missing-exact-pin".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            body: json!({
                "model":"client-model",
                "previous_response_id":"resp_missing_exact_pin",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_missing_exact_pin",
                    "output":"ok"
                }]
            }),
        },
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(transport.sends.load(Ordering::SeqCst), 0);
    assert!(
        started.elapsed() >= Duration::from_millis(1_000),
        "isolated exact-pin availability failure bypassed the Error05 action gate"
    );
    assert_eq!(
        output.error_chain.as_deref(),
        Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
    );
    match output.client_payload.body {
        V3ClientBody::Json(value) => {
            assert_eq!(value["error"]["code"], "continuation_exact_pin_unavailable");
            assert!(
                value.pointer("/error/external_error").is_none()
                    && value.pointer("/error/class").is_none()
                    && value.pointer("/error/stage").is_none()
                    && value.pointer("/error/error_node").is_none(),
                "Error06 body must not carry control-plane fields: {value}"
            );
        }
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => {
            panic!("missing exact pin must project typed terminal Error06 JSON")
        }
    }
    assert_eq!(
        continuation_state.len().unwrap(),
        0,
        "terminal exact-pin availability failure must release its locator"
    );
    assert!(!output.node_trace.contains(&"V3Router07OpaqueTargetHitOnce"));
}

#[tokio::test]
async fn exact_pin_capability_revision_mismatch_stays_out_of_provider_failure_gate() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    struct NoSendTransport {
        sends: AtomicUsize,
    }

    #[async_trait]
    impl ResponsesTransport for NoSendTransport {
        async fn send(
            &self,
            _request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            self.sends.fetch_add(1, Ordering::SeqCst);
            panic!("capability revision mismatch must never enter provider transport")
        }
    }

    let manifest = test_manifest();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let continuation_scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-revision-mismatch",
        "conversation-revision-mismatch",
        4444,
        "default",
    );
    continuation_state
        .store
        .lock()
        .unwrap()
        .commit(V3RemoteContinuationCommitInput::locator_only(
            V3RemoteContinuationLocator::new_direct(
                "resp_revision_mismatch",
                continuation_scope.key.clone(),
                V3RemoteContinuationPin::new("openai", "gpt-test", "key1"),
                "stale-capability-revision",
                1_000,
                60_000,
            ),
        ))
        .unwrap();
    let transport = NoSendTransport {
        sends: AtomicUsize::new(0),
    };

    let started = Instant::now();
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(
            &continuation_state,
            continuation_scope,
            2_000,
        ),
        &manifest,
        V3Server03HttpRequestRaw {
            server_id: "test".to_string(),
            failure_session_scope: test_failure_session_scope("test"),
            request_id: "req-revision-mismatch".to_string(),
            execution_id: "exec-revision-mismatch".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            body: json!({
                "model":"client-model",
                "previous_response_id":"resp_revision_mismatch",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_revision_mismatch",
                    "output":"ok"
                }]
            }),
        },
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(transport.sends.load(Ordering::SeqCst), 0);
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "continuation contract mismatch must not enter the provider action gate"
    );
    match output.client_payload.body {
        V3ClientBody::Json(value) => {
            assert_eq!(value["error"]["code"], "v3_route_target_runtime_failure");
            assert!(
                value.pointer("/error/class").is_none(),
                "Error06 body must not carry the error class: {value}"
            );
            assert_ne!(
                value["error"]["code"],
                json!("continuation_exact_pin_unavailable")
            );
        }
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => {
            panic!("capability revision mismatch must project non-provider JSON error")
        }
    }
    assert!(!output.node_trace.contains(&"V3Router07OpaqueTargetHitOnce"));
}
