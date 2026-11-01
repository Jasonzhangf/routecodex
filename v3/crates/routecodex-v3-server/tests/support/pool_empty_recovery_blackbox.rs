use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_requests_progress_during_exec_preparation() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-entry-no-maintenance-gate");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let (url, mut requests, release, shutdown) = start_controlled_held_upstream().await;
    let mut manifest = concurrency_switch_manifest(&url, &url);
    use_native_direct_responses(&mut manifest);
    manifest
        .forwarders
        .get_mut("concurrency")
        .unwrap()
        .targets
        .truncate(1);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let preparation = timeout(Duration::from_secs(5), handle.prepare_exec_attempt())
        .await
        .expect("exec preparation must finish")
        .expect("prepare succeeds");
    let first_url = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let second_url = format!("http://{}/v1/responses", handle.listeners[1].addr);
    let first = spawn_concurrency_client(&first_url, "44cc3af-preparation-first");
    let second = spawn_concurrency_client(&second_url, "44cc3af-preparation-second");
    let first_arrived = timeout(Duration::from_secs(3), requests.recv()).await;
    let second_arrived = timeout(Duration::from_secs(3), requests.recv()).await;
    release.add_permits(2);
    let first_result = timeout(Duration::from_secs(5), first).await;
    let second_result = timeout(Duration::from_secs(5), second).await;
    drop(preparation);
    timeout(Duration::from_secs(5), handle.shutdown())
        .await
        .unwrap();
    shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert!(
        matches!(first_arrived, Ok(Some(_))) && matches!(second_arrived, Ok(Some(_))),
        "both listeners must reach the provider while exec preparation is held"
    );
    assert_eq!(first_result.unwrap().unwrap().0, StatusCode::OK);
    assert_eq!(second_result.unwrap().unwrap().0, StatusCode::OK);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_mixed_pool_direct_first_ladder_keeps_failed_identity() {
    assert_mixed_pool_first_ladder_keeps_failed_identity(true).await;
}

async fn assert_mixed_pool_first_ladder_keeps_failed_identity(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-mixed-pool-first-ladder-direct");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let mode = if direct { "Direct" } else { "Relay" };

    // A is healthy and returns a complete response without deliverable business
    // content. Its first two business arrivals are held; any later business
    // arrival is recorded and held separately so the test can observe the first
    // target-recovery ladder boundary without turning the bug into a 71-count
    // storm.
    let a_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a_url = format!("http://{}/v1", a_listener.local_addr().unwrap());
    let a_wire = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let a_business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let a_probe = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (a_business_tx, mut a_business_rx) = mpsc::unbounded_channel::<()>();
    let a_first_release = Arc::new(Semaphore::new(0));
    let a_extra_release = Arc::new(Semaphore::new(0));
    let (a_extra_tx, mut a_extra_rx) = mpsc::unbounded_channel::<std::time::Instant>();
    let a_app = Router::new().route(
        "/v1/chat/completions",
        post({
            let a_wire = a_wire.clone();
            let a_business = a_business.clone();
            let a_probe = a_probe.clone();
            let a_business_tx = a_business_tx.clone();
            let a_first_release = a_first_release.clone();
            let a_extra_release = a_extra_release.clone();
            let a_extra_tx = a_extra_tx.clone();
            move |axum::Json(body): axum::Json<Value>| {
                let a_wire = a_wire.clone();
                let a_business = a_business.clone();
                let a_probe = a_probe.clone();
                let a_business_tx = a_business_tx.clone();
                let a_first_release = a_first_release.clone();
                let a_extra_release = a_extra_release.clone();
                let a_extra_tx = a_extra_tx.clone();
                async move {
                    let is_probe = mixed_pool_is_probe(&body);
                    a_wire.lock().unwrap().push(body.clone());
                    if is_probe {
                        a_probe.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        return Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/json")
                            .body(Body::from(r#"{"probe":"qualified"}"#))
                            .unwrap();
                    }
                    let attempt = a_business.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    let _ = a_business_tx.send(());
                    if attempt <= 2 {
                        let _permit = a_first_release.acquire_owned().await.unwrap();
                    } else {
                        let _ = a_extra_tx.send(std::time::Instant::now());
                        let _permit = a_extra_release.acquire_owned().await.unwrap();
                    }
                    mixed_pool_empty_sse()
                }
            }
        }),
    );
    let a_task = tokio::spawn(async move { axum::serve(a_listener, a_app).await.unwrap() });

    // B, C, and D share the upstream/manifest/event control with the single
    // empty-SSE recovery fixture. Only A differs: its first two business
    // arrivals use the original first-ladder release, and any later business
    // arrival is recorded separately so the test can observe the ladder
    // boundary without turning the bug into a 71-count storm.
    let mut peers = spawn_mixed_pool_peers(MixedPoolWireMode::Chat).await;
    let MixedPoolServerRig {
        handle,
        base,
        endpoint,
        second,
        side,
        ..
    } = spawn_mixed_pool_manifest_server(
        direct,
        &a_url,
        &peers.b_url,
        &peers.c_url,
        &peers.d_url,
        None,
    )
        .await;
    let client = reqwest::Client::new();

    add_mixed_pool_b_cooldown(&client, &base, &second).await;

    // Two original requests share the same mixed route. One will be cancelled
    // after the first ladder; the other must complete with B's real result.
    let recover_payload = if direct {
        json!({"model":"client-test","messages":[{"role":"user","content":"mixed ladder recover"}],"max_tokens":32,"stream":false})
    } else {
        json!({"model":"client-test","input":"mixed ladder recover","stream":false})
    };
    let cancel_payload = if direct {
        json!({"model":"client-test","messages":[{"role":"user","content":"mixed ladder cancel"}],"max_tokens":32,"stream":false})
    } else {
        json!({"model":"client-test","input":"mixed ladder cancel","stream":false})
    };
    let mut recover = Some(tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        let payload = recover_payload.clone();
        async move {
            client
                .post(endpoint)
                .header("session-id", "44cc3af-mixed-ladder-recover")
                .json(&payload)
                .send()
                .await?
                .text()
                .await
        }
    }));
    let mut cancel = Some(tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        let payload = cancel_payload.clone();
        async move {
            client
                .post(endpoint)
                .header("session-id", "44cc3af-mixed-ladder-cancel")
                .json(&payload)
                .send()
                .await?
                .text()
                .await
        }
    }));
    let first_arrival = timeout(Duration::from_secs(3), a_business_rx.recv()).await;
    let second_arrival = timeout(Duration::from_secs(3), a_business_rx.recv()).await;
    assert!(
        matches!(first_arrival, Ok(Some(()))) && matches!(second_arrival, Ok(Some(()))),
        "{mode}: both original requests must reach A"
    );
    assert!(
        timeout(Duration::from_millis(100), recover.as_mut().unwrap())
            .await
            .is_err()
            && timeout(Duration::from_millis(100), cancel.as_mut().unwrap())
                .await
                .is_err(),
        "{mode}: both requests must stay pending while A is held"
    );
    assert_eq!(
        peers.b_business.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_eq!(
        peers.c_business.load(std::sync::atomic::Ordering::SeqCst),
        0
    );

    trigger_mixed_pool_b_probe(&client, &base, &second, &mut peers.b_probe_rx, mode).await;
    assert_eq!(
        peers.b_business.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_eq!(
        peers.c_business.load(std::sync::atomic::Ordering::SeqCst),
        0
    );

    assert_mixed_pool_independent_request(&client, &endpoint, &side, direct, mode).await;

    let ladder_start = std::time::Instant::now();
    a_first_release.add_permits(2);
    tokio::time::sleep(Duration::from_millis(1150)).await;
    let mut extra_before_or_at_first_ladder = Vec::<std::time::Instant>::new();
    while let Ok(at) = a_extra_rx.try_recv() {
        extra_before_or_at_first_ladder.push(at);
    }
    let a_business_at_first_ladder = a_business.load(std::sync::atomic::Ordering::SeqCst);

    // Cancel one original request before B recovers. The cancelled request must
    // not cause another business dispatch after this point.
    cancel.take().expect("cancel request handle").abort();

    // Let B's real probe succeed and then release the held extra A attempt so
    // the surviving request can switch to B.
    peers
        .b_ready
        .store(true, std::sync::atomic::Ordering::SeqCst);
    peers.b_probe_release.add_permits(1);
    a_extra_release.add_permits(8);
    let recovered = timeout(
        Duration::from_secs(5),
        recover.take().expect("recover request handle"),
    )
    .await
    .ok()
    .and_then(|joined| joined.ok())
    .and_then(|result| result.ok());

    let b_dispatched = peers.b_business.load(std::sync::atomic::Ordering::SeqCst);
    let c_dispatched = peers.c_business.load(std::sync::atomic::Ordering::SeqCst);
    let a_final = a_business.load(std::sync::atomic::Ordering::SeqCst);

    // Release all barriers before aborting handlers.
    a_first_release.add_permits(8);
    a_extra_release.add_permits(8);
    peers.b_probe_release.add_permits(8);
    handle.shutdown().await;
    a_task.abort();
    peers.b_task.abort();
    peers.c_task.abort();
    peers.d_task.abort();
    if let Some(request) = recover {
        request.abort();
    }
    if let Some(request) = cancel {
        request.abort();
    }
    std::env::remove_var("V3_P6_TEST_KEY");

    let a_arrivals = a_wire.lock().unwrap().clone();
    for (index, wire) in a_arrivals.iter().enumerate() {
        eprintln!(
            "[{mode}] A wire #{index} is_probe={} body={wire}",
            mixed_pool_is_probe(wire)
        );
    }

    let recovered_body =
        recovered.expect("the surviving original request must finish after B recovers");
    assert!(
        recovered_body.contains("cooled mixed peer recovered"),
        "{mode}: the surviving original request must carry B's real business result: {recovered_body}"
    );
    assert!(
        !recovered_body.contains("\"error\""),
        "{mode}: the client must not receive a provider/proxy error payload: {recovered_body}"
    );
    assert_eq!(
        b_dispatched, 1,
        "{mode}: B must carry the recovered business request exactly once"
    );
    assert_eq!(c_dispatched, 0, "{mode}: C must never be dispatched");
    assert!(
        a_arrivals
            .first()
            .map(|wire| !mixed_pool_is_probe(wire))
            .unwrap_or(false),
        "{mode}: A's first arrival must be the original business request, not a probe: {a_arrivals:?}"
    );
    assert_eq!(
        a_business_at_first_ladder,
        2,
        "{mode}: A must receive only the two original business attempts before the first target-recovery ladder; observed {a_business_at_first_ladder}, final {a_final}"
    );
    assert!(
        extra_before_or_at_first_ladder.is_empty(),
        "{mode}: A must not be dispatched again across the first target-recovery ladder; extra dispatches after release: {:?}; final business attempts: {a_final}",
        extra_before_or_at_first_ladder
            .iter()
            .map(|at| at.duration_since(ladder_start))
            .collect::<Vec<_>>()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_direct_listeners_do_not_share_admission_capacity() {
    assert_listener_admission_isolation(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_relay_listeners_do_not_share_admission_capacity() {
    assert_listener_admission_isolation(false).await;
}

async fn assert_listener_admission_isolation(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-listener-capacity-isolation");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let (url, mut requests, release, shutdown) = start_controlled_held_upstream().await;
    let mut manifest = concurrency_switch_manifest(&url, &url);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    manifest
        .forwarders
        .get_mut("concurrency")
        .unwrap()
        .targets
        .truncate(1);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let first_url = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let second_url = format!("http://{}/v1/responses", handle.listeners[1].addr);
    let first = spawn_concurrency_client(&first_url, "44cc3af-listener-first");
    timeout(Duration::from_secs(2), requests.recv())
        .await
        .expect("first listener reaches upstream")
        .unwrap();
    let second = spawn_concurrency_client(&second_url, "44cc3af-listener-second");
    let second_arrived = timeout(Duration::from_millis(500), requests.recv()).await;
    release.add_permits(2);
    let first_result = timeout(Duration::from_secs(3), first).await;
    let second_result = timeout(Duration::from_secs(3), second).await;
    timeout(Duration::from_secs(2), handle.shutdown())
        .await
        .unwrap();
    shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert!(
        second_arrived.is_ok(),
        "second listener must reach the same provider while first listener holds its own lease"
    );
    assert_eq!(first_result.unwrap().unwrap().0, StatusCode::OK);
    assert_eq!(second_result.unwrap().unwrap().0, StatusCode::OK);
}

#[tokio::test]
async fn issue9bb26d4_direct_public_semantic_response_outlives_residence() {
    assert_semantic_response_outlives_residence(true, false).await;
}

#[tokio::test]
async fn issue9bb26d4_relay_public_semantic_response_outlives_residence() {
    assert_semantic_response_outlives_residence(false, false).await;
}

#[tokio::test]
async fn issue9bb26d4_relay_public_reasoning_response_outlives_residence() {
    assert_semantic_response_outlives_residence(false, true).await;
}

async fn assert_semantic_response_outlives_residence(direct: bool, reasoning: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("9bb-direct-semantic-residence");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (received_tx, mut received_rx) = mpsc::unbounded_channel();
    let app = Router::new().route("/v1/responses", post(move |axum::Json(body): axum::Json<Value>| {
        let received_tx = received_tx.clone();
        async move {
        if body.to_string().contains("ping; reply pong") {
            return identity_test_response("probe");
        }
        let _ = received_tx.send(body);
        let first = if reasoning {
            b"event: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"thinking\",\"item_id\":\"rs_1\",\"output_index\":0,\"summary_index\":0,\"sequence_number\":1}\n\n".to_vec()
        } else {
            b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"long response\"}\n\n".to_vec()
        };
        let terminal = b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"long response\"}]}]}}\n\n".to_vec();
        let chunks = futures_util::stream::iter([Ok::<_, std::io::Error>(first)])
            .chain(futures_util::stream::once(async move {
                sleep(Duration::from_millis(1600)).await;
                Ok::<_, std::io::Error>(terminal)
            }));
        Response::builder().status(200).header("content-type", "text/event-stream")
            .body(Body::from_stream(chunks)).unwrap()
    }}));
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let url = format!("http://{address}/v1");
    let mut manifest = concurrency_switch_manifest(&url, &url);
    manifest
        .forwarders
        .get_mut("concurrency")
        .unwrap()
        .targets
        .truncate(1);
    for server in manifest.servers.values_mut() {
        server
            .execution
            .as_mut()
            .unwrap()
            .attempt_store
            .residence_timeout_ms = 1000;
    }
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let response = timeout(Duration::from_secs(5), async {
        reqwest::Client::new()
            .post(endpoint)
            .json(&json!({"model":"client-test","input":"slow real output","stream":true}))
            .send()
            .await?
            .text()
            .await
    })
    .await
    .expect("request must complete");
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    let received = received_rx.try_recv();
    assert!(
        received.is_ok(),
        "the configured provider must receive the business request: {response:?}"
    );
    let body = response.expect("client transport must stay intact");
    assert!(
        body.contains("long response") && body.contains("response.completed"),
        "{body}"
    );
}
use axum::response::IntoResponse;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_direct_same_identity_sessions_progress_independently() {
    assert_same_identity_sessions_progress_independently(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_relay_same_identity_sessions_progress_independently() {
    assert_same_identity_sessions_progress_independently(false).await;
}

async fn assert_same_identity_sessions_progress_independently(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-same-identity-sessions");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (arrived_tx, mut arrived_rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let upstream_release = release.clone();
    let app = Router::new().route(
        "/v1/responses",
        post(move |axum::Json(body): axum::Json<Value>| {
            let arrived_tx = arrived_tx.clone();
            let release = upstream_release.clone();
            async move {
                let input = body.to_string();
                if input.contains("ping; reply pong") {
                    return identity_test_response("probe");
                }
                let held = input.contains("hold-first-session");
                let _ = arrived_tx.send(held);
                if held {
                    let _permit = release.acquire().await.unwrap();
                }
                identity_test_response(if held {
                    "first session completed"
                } else {
                    "second session completed"
                })
            }
        }),
    );
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let url = format!("http://{address}/v1");
    let mut manifest = concurrency_switch_manifest(&url, &url);
    manifest
        .forwarders
        .get_mut("concurrency")
        .unwrap()
        .targets
        .truncate(1);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let first_endpoint = endpoint.clone();
    let first = tokio::spawn(async move {
        reqwest::Client::new()
            .post(first_endpoint)
            .header("session-id", "same-identity-first")
            .json(&json!({"model":"client-test","input":"hold-first-session","stream":true}))
            .send()
            .await?
            .text()
            .await
    });
    let first_arrived = timeout(Duration::from_secs(2), arrived_rx.recv()).await;
    let second = timeout(Duration::from_secs(2), async {
        reqwest::Client::new()
            .post(endpoint)
            .header("session-id", "same-identity-second")
            .json(&json!({"model":"client-test","input":"second-session","stream":true}))
            .send()
            .await?
            .text()
            .await
    })
    .await;
    let first_was_pending = !first.is_finished();
    release.add_permits(1);
    let first_result = timeout(Duration::from_secs(3), first).await;
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert!(
        matches!(first_arrived, Ok(Some(true))),
        "first session must reach the shared identity"
    );
    assert!(
        first_was_pending,
        "first session must still be pending when the second completes"
    );
    let second_body = second
        .expect("second session must not wait for first")
        .unwrap();
    assert!(
        second_body.contains("second session completed")
            && second_body.contains("response.completed"),
        "{second_body}"
    );
    let first_body = first_result.unwrap().unwrap().unwrap();
    assert!(
        first_body.contains("first session completed") && first_body.contains("response.completed"),
        "{first_body}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue08d36e9_direct_all_tiers_unavailable_keepalive_then_recover() {
    assert_all_tiers_unavailable_keepalive_then_recover(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue08d36e9_relay_all_tiers_unavailable_keepalive_then_recover() {
    assert_all_tiers_unavailable_keepalive_then_recover(false).await;
}

#[derive(Clone)]
struct TierAvailabilityState {
    business_calls: Arc<std::sync::atomic::AtomicUsize>,
    probe_calls: Arc<std::sync::atomic::AtomicUsize>,
    probe_status: Arc<std::sync::atomic::AtomicU16>,
    last_business_body: Arc<std::sync::Mutex<Option<Value>>>,
    marker: String,
}

struct TierAvailabilityUpstream {
    url: String,
    business_calls: Arc<std::sync::atomic::AtomicUsize>,
    probe_calls: Arc<std::sync::atomic::AtomicUsize>,
    probe_status: Arc<std::sync::atomic::AtomicU16>,
    last_business_body: Arc<std::sync::Mutex<Option<Value>>>,
    shutdown: oneshot::Sender<()>,
}

/// Controlled provider used by the tier-fallback tests. The test configures its
/// probe status and business traffic carries a distinct marker, so a test can
/// tell which route tier carried the request without relying on capacity.
async fn tier_availability_upstream(
    State(state): State<Arc<TierAvailabilityState>>,
    axum::Json(body): axum::Json<Value>,
) -> Response<Body> {
    if body.to_string().contains("ping; reply pong") {
        state
            .probe_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        return Response::builder()
            .status(
                StatusCode::from_u16(state.probe_status.load(std::sync::atomic::Ordering::SeqCst))
                    .unwrap(),
            )
            .header("content-type", "application/json")
            .body(Body::from(r#"{"probe":"qualified"}"#))
            .unwrap();
    }
    state
        .business_calls
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    *state.last_business_body.lock().unwrap() = Some(body.clone());
    let marker = state.marker.clone();
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(format!(
                "event: response.created\ndata: {{\"type\":\"response.created\",\"response\":{{\"id\":\"resp_{marker}\",\"status\":\"in_progress\"}}}}\n\nevent: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_{marker}\",\"status\":\"completed\",\"output\":[{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"{marker}\"}}]}}]}}}}\n\ndata: [DONE]\n\n"
            )))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"id":"resp_{marker}","status":"completed","output_text":"{marker}"}}"#
            )))
            .unwrap()
    }
}

async fn start_tier_availability_upstream(marker: &str) -> TierAvailabilityUpstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let business_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let probe_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let probe_status = Arc::new(std::sync::atomic::AtomicU16::new(202));
    let last_business_body = Arc::new(std::sync::Mutex::new(None));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(tier_availability_upstream))
        .with_state(Arc::new(TierAvailabilityState {
            business_calls: Arc::clone(&business_calls),
            probe_calls: Arc::clone(&probe_calls),
            probe_status: Arc::clone(&probe_status),
            last_business_body: Arc::clone(&last_business_body),
            marker: marker.to_string(),
        }));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    TierAvailabilityUpstream {
        url,
        business_calls,
        probe_calls,
        probe_status,
        last_business_body,
        shutdown: shutdown_tx,
    }
}

/// Establish explicit typed health state for the exact provider/auth/model
/// identity through the same `provider_cooldown_probes` owner the failure path
/// writes, so selection reads an ordinary cooldown instead of capacity.
async fn cool_exact_provider(client: &reqwest::Client, base: &str, provider_id: &str) {
    let response = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({
            "provider_id": provider_id,
            "interface_id": "default",
            "auth_alias": "key",
            "model_id": "test",
            "kind": "probe",
            "duration_ms": 30_000,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "manual cooldown must apply to {provider_id}"
    );
    let applied: Value = response.json().await.unwrap();
    assert_eq!(applied["applied"], "probe", "{applied}");
    let entry = provider_cooldown_entry(client, base, provider_id)
        .await
        .unwrap_or_else(|| panic!("{provider_id} must be visible in the cooldown pool"));
    assert_eq!(entry["kind"], "probe", "{entry}");
    assert_eq!(entry["interface_id"], "default", "{entry}");
    assert_eq!(entry["auth_alias"], "key", "{entry}");
    assert_eq!(entry["model_id"], "test", "{entry}");
    assert!(
        entry["state"] == "blocked" || entry["state"] == "probing",
        "{entry}"
    );
}

async fn force_recovery_probe(client: &reqwest::Client, base: &str, provider_id: &str) {
    let response = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
        .json(&json!({
            "provider_id": provider_id,
            "interface_id": "default",
            "auth_alias": "key",
            "model_id": "test",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let scheduled: Value = response.json().await.unwrap();
    assert_eq!(
        scheduled["scheduled"], true,
        "the exact {provider_id} cooldown must own a recovery probe: {scheduled}"
    );
}

async fn provider_cooldown_entry(
    client: &reqwest::Client,
    base: &str,
    provider_id: &str,
) -> Option<Value> {
    let entries: Value = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    entries["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| {
            entry["provider_id"] == provider_id
                && entry["interface_id"] == "default"
                && entry["auth_alias"] == "key"
                && entry["model_id"] == "test"
        })
        .cloned()
}

fn route_pool_target(
    target: &routecodex_v3_config::V3ForwarderTargetManifest,
) -> routecodex_v3_config::V3RoutePoolTargetManifest {
    routecodex_v3_config::V3RoutePoolTargetManifest {
        kind: target.kind.clone(),
        id: target.id.clone(),
        provider: target.provider.clone(),
        model: target.model.clone(),
        key: target.key.clone(),
        interface: target.interface.clone(),
        priority: target.priority,
        weight: target.weight,
    }
}

async fn assert_all_tiers_unavailable_keepalive_then_recover(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("08d36e9-all-tiers-unavailable");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let first = start_tier_availability_upstream("thinking-tier").await;
    let second = start_tier_availability_upstream("default-tier").await;
    let mut manifest = concurrency_switch_manifest(&first.url, &second.url);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    for server in manifest.servers.values_mut() {
        server.http_sse_keepalive_ms = 10;
    }
    let forwarder = manifest.forwarders.get("concurrency").unwrap();
    let first_target = route_pool_target(&forwarder.targets[0]);
    let second_target = route_pool_target(&forwarder.targets[1]);
    let first_id = first_target.provider.clone().unwrap();
    let second_id = second_target.provider.clone().unwrap();
    let group = manifest.route_groups.get_mut("default").unwrap();
    let mut thinking = group.pools["client_test"].clone();
    thinking.id = "thinking".into();
    thinking.targets = vec![first_target];
    group.pools.insert("thinking".into(), thinking);
    group.pools.get_mut("default").unwrap().targets = vec![second_target];
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let client = reqwest::Client::new();
    // Keep every tier unavailable while the keepalive is observed. The request
    // path must run its own exhaustion rescue probes and keep the cooldowns
    // blocked on failure, so only all-pools-empty can wait here.
    first
        .probe_status
        .store(503, std::sync::atomic::Ordering::SeqCst);
    second
        .probe_status
        .store(503, std::sync::atomic::Ordering::SeqCst);
    cool_exact_provider(&client, &base, &first_id).await;
    cool_exact_provider(&client, &base, &second_id).await;
    let mut waiting = timeout(
        Duration::from_secs(2),
        client
            .post(&endpoint)
            .header("session-id", "08d36e9-all-waiting")
            .json(&json!({"model":"client-test","input":"held","stream":true}))
            .send(),
    )
    .await
    .expect("waiting SSE headers")
    .unwrap();
    assert_eq!(waiting.status(), StatusCode::OK);
    let chunk = timeout(Duration::from_secs(2), waiting.chunk())
        .await
        .expect("transport keepalive deadline")
        .expect("transport remains open")
        .expect("no EOF while all tiers are unavailable");
    let keepalive = String::from_utf8_lossy(&chunk).to_string();
    assert!(
        keepalive.lines().any(|line| line.starts_with(':')),
        "only transport keepalive is allowed before recovery: {chunk:?}"
    );
    assert!(
        !keepalive.contains("response.created") && !keepalive.contains("response.completed"),
        "no business bytes are allowed before recovery: {keepalive:?}"
    );
    assert!(
        !keepalive.contains("thinking-tier") && !keepalive.contains("default-tier"),
        "no tier business marker may be projected before recovery: {keepalive:?}"
    );
    assert_eq!(
        first
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "only all-pools-empty may wait: a waiting request must not send bytes to an unavailable tier"
    );
    assert_eq!(
        second
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "only all-pools-empty may wait: a waiting request must not send bytes to an unavailable tier"
    );
    // Make the exact default identity probe-eligible again, then force the
    // matching probe. The unrecovered thinking tier must stay blocked.
    second
        .probe_status
        .store(202, std::sync::atomic::Ordering::SeqCst);
    force_recovery_probe(&client, &base, &second_id).await;
    let body = timeout(Duration::from_secs(5), waiting.text())
        .await
        .expect("waiting request recovers once a matching probe restores the default tier")
        .unwrap();
    assert_responses_sse_delivered_business_text(&body, "default-tier");
    assert!(
        second.probe_calls.load(std::sync::atomic::Ordering::SeqCst) >= 1,
        "the forced matching probe must reach the recovered default tier"
    );
    assert!(
        second
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst)
            >= 1,
        "the waiting request must complete on the recovered default tier"
    );
    assert!(
        provider_cooldown_entry(&client, &base, &second_id)
            .await
            .is_none(),
        "a matching probe must remove only the recovered default tier"
    );
    assert!(
        provider_cooldown_entry(&client, &base, &first_id)
            .await
            .is_some(),
        "the unrecovered thinking tier must remain excluded"
    );
    timeout(Duration::from_secs(2), handle.shutdown())
        .await
        .unwrap();
    first.shutdown.send(()).unwrap();
    second.shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue08d36e9_direct_unavailable_thinking_falls_back_to_default() {
    assert_unavailable_thinking_fallback(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue08d36e9_relay_unavailable_thinking_falls_back_to_default() {
    assert_unavailable_thinking_fallback(false).await;
}

async fn assert_unavailable_thinking_fallback(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("08d36e9-thinking-fallback");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let first = start_tier_availability_upstream("thinking-tier").await;
    let second = start_tier_availability_upstream("default-tier").await;
    let mut manifest = concurrency_switch_manifest(&first.url, &second.url);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let forwarder = manifest.forwarders.get("concurrency").unwrap();
    let first_target = route_pool_target(&forwarder.targets[0]);
    let second_target = route_pool_target(&forwarder.targets[1]);
    let first_id = first_target.provider.clone().unwrap();
    let group = manifest.route_groups.get_mut("default").unwrap();
    let mut thinking = group.pools["client_test"].clone();
    thinking.id = "thinking".into();
    thinking.targets = vec![first_target];
    group.pools.insert("thinking".into(), thinking);
    group.pools.get_mut("default").unwrap().targets = vec![second_target];
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let client = reqwest::Client::new();
    // Prove the primary tier is selected before the fallback. A first request
    // must carry the thinking marker while default stays idle, then after the
    // exact thinking identity is cooled the next request must reach default.
    let first_response = timeout(
        Duration::from_secs(2),
        client
            .post(&endpoint)
            .header("session-id", "08d36e9-thinking-first")
            .json(&json!({"model":"client-test","input":"held","stream":true}))
            .send(),
    )
    .await
    .expect("thinking tier must carry the first request without waiting")
    .unwrap();
    assert_eq!(first_response.status(), StatusCode::OK);
    let first_body = first_response.text().await.unwrap();
    assert_responses_sse_delivered_business_text(&first_body, "thinking-tier");
    assert_eq!(
        first
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the thinking tier must be tried before default"
    );
    assert_eq!(
        second
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "default must not overtake the healthy thinking tier"
    );
    // Keep the preceding thinking tier excluded while the fallback is verified.
    // Any independent probe fails and cannot restore it during this request.
    first
        .probe_status
        .store(503, std::sync::atomic::Ordering::SeqCst);
    cool_exact_provider(&client, &base, &first_id).await;
    let response = timeout(
        Duration::from_secs(2),
        client
            .post(&endpoint)
            .header("session-id", "08d36e9-thinking")
            .json(&json!({"model":"client-test","input":"held","stream":true}))
            .send(),
    )
    .await
    .expect("unavailable thinking tier must immediately use default without waiting")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert_responses_sse_delivered_business_text(&body, "default-tier");
    assert!(
        !body.contains("thinking-tier"),
        "unavailable thinking tier must not leak business bytes: {body}"
    );
    assert_eq!(
        first
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the cooled thinking tier must receive no additional business request"
    );
    assert!(
        second
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst)
            >= 1,
        "the default tier must carry the request"
    );
    timeout(Duration::from_secs(2), handle.shutdown())
        .await
        .unwrap();
    first.shutdown.send(()).unwrap();
    second.shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue08d36e9_direct_unavailable_search_and_tools_use_default() {
    assert_unavailable_search_fallback(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue08d36e9_relay_unavailable_search_and_tools_use_default() {
    assert_unavailable_search_fallback(false).await;
}

async fn assert_unavailable_search_fallback(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("08d36e9-search-fallback");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let first = start_tier_availability_upstream("search-tier").await;
    let second = start_tier_availability_upstream("tools-tier").await;
    let third = start_tier_availability_upstream("default-tier").await;
    let mut manifest = concurrency_switch_manifest(&first.url, &second.url);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let forwarder = manifest.forwarders.get("concurrency").unwrap();
    let search_target = route_pool_target(&forwarder.targets[0]);
    let tools_target = route_pool_target(&forwarder.targets[1]);
    let search_id = search_target.provider.clone().unwrap();
    let tools_id = tools_target.provider.clone().unwrap();
    let default_id = format!("{tools_id}_fallback");
    let mut default_provider = manifest.providers[&tools_id].clone();
    default_provider.id = default_id.clone();
    default_provider.base_url = third.url.clone();
    for interface in default_provider.interfaces.values_mut() {
        interface.base_url = third.url.clone();
    }
    manifest
        .providers
        .insert(default_id.clone(), default_provider);
    let mut default_target = tools_target.clone();
    default_target.provider = Some(default_id);
    let group = manifest.route_groups.get_mut("default").unwrap();
    let mut search = group.pools["client_test"].clone();
    search.id = "search".into();
    search.targets = vec![search_target.clone()];
    let mut tools = search.clone();
    tools.id = "tools".into();
    tools.targets = vec![tools_target.clone()];
    group.pools.insert("search".into(), search);
    group.pools.insert("tools".into(), tools);
    group.pools.get_mut("default").unwrap().targets = vec![default_target];
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let client = reqwest::Client::new();
    let search_request = json!({"model":"client-test","stream":true,"input":[
        {"type":"message","role":"user","content":[{"type":"input_text","text":"find the code"}]},
        {"type":"function_call","name":"exec_command","call_id":"search-call","arguments":"{\"command\":\"rg -n needle src\"}"},
        {"type":"function_call_output","call_id":"search-call","output":"found"}
    ]});
    // Keep preceding search and tools tiers excluded while fallback is checked.
    // Any independent probe fails and cannot restore them during this request.
    first
        .probe_status
        .store(503, std::sync::atomic::Ordering::SeqCst);
    second
        .probe_status
        .store(503, std::sync::atomic::Ordering::SeqCst);
    let send_search_request = |session: &str| {
        let client = client.clone();
        let endpoint = endpoint.clone();
        let request = search_request.clone();
        let session = session.to_string();
        async move {
            client
                .post(&endpoint)
                .header("session-id", session)
                .json(&request)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        }
    };
    // Prove route-tier ordering with explicit health exclusions: with only the
    // search tier cooled the request must land on tools; then cooling tools too
    // must land on default. This is the availability-only substitute for the
    // old capacity-saturation ordering, and it must not wait on any tier.
    cool_exact_provider(&client, &base, &search_id).await;
    let first_body = timeout(
        Duration::from_secs(2),
        send_search_request("08d36e9-search-order-first"),
    )
    .await
    .expect("search fallback must use tools immediately");
    assert_responses_sse_delivered_business_text(&first_body, "tools-tier");
    assert_eq!(
        first
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the cooled search tier must receive no business request before tools"
    );
    assert!(
        second
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst)
            >= 1,
        "tools must carry the request while search is cooled"
    );
    assert_eq!(
        second.probe_calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the healthy tools tier must not be probed before its own fallback phase"
    );
    // Now exclude tools too: the next request must skip search and tools and
    // reach default. Both exclusions stay exact throughout the assertion.
    cool_exact_provider(&client, &base, &tools_id).await;
    let body = timeout(
        Duration::from_secs(2),
        send_search_request("08d36e9-search-order-final"),
    )
    .await
    .expect("unavailable search and tools must immediately use default without waiting");
    assert_responses_sse_delivered_business_text(&body, "default-tier");
    assert!(
        !body.contains("search-tier") && !body.contains("tools-tier"),
        "unavailable search/tools tiers must not leak business bytes: {body}"
    );
    let sent = third
        .last_business_body
        .lock()
        .unwrap()
        .clone()
        .expect("the default tier must receive the search business request")
        .to_string();
    assert!(
        sent.contains("search-call") && sent.contains("found"),
        "tool call and result stay paired"
    );
    assert_eq!(
        first
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the cooled search tier must receive no business request"
    );
    assert_eq!(
        second
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the cooled tools tier must receive no additional business request after its phase"
    );
    assert!(
        third
            .business_calls
            .load(std::sync::atomic::Ordering::SeqCst)
            >= 1,
        "the default tier must carry the request"
    );
    for provider_id in [&search_id, &tools_id] {
        let entry = provider_cooldown_entry(&client, &base, provider_id)
            .await
            .expect("cooled identity remains in the pool");
        assert!(
            entry["state"] == "blocked" || entry["state"] == "probing",
            "{entry}"
        );
    }
    timeout(Duration::from_secs(2), handle.shutdown())
        .await
        .unwrap();
    first.shutdown.send(()).unwrap();
    second.shutdown.send(()).unwrap();
    third.shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
}

#[derive(Clone)]
struct FirstByteStallState {
    captures: tokio::sync::mpsc::UnboundedSender<ProviderCapture>,
    release: Arc<Semaphore>,
}

async fn stalled_before_first_byte_responses_upstream(
    State(state): State<Arc<FirstByteStallState>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> Response<Body> {
    let _ = state
        .captures
        .send(ProviderCapture::from_http(&headers, body));
    let _permit = Arc::clone(&state.release).acquire_owned().await.unwrap();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(
            "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stalled\",\"status\":\"in_progress\"}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stalled\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"stalled provider released\"}]}]}}\n\ndata: [DONE]\n\n",
        ))
        .unwrap()
}

async fn start_first_byte_stalled_upstream() -> (
    String,
    tokio::sync::mpsc::UnboundedReceiver<ProviderCapture>,
    Arc<Semaphore>,
    oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route(
            "/v1/responses",
            post(stalled_before_first_byte_responses_upstream),
        )
        .with_state(Arc::new(FirstByteStallState {
            captures: captures_tx,
            release: Arc::clone(&release),
        }));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (
        format!("http://{address}/v1"),
        captures_rx,
        release,
        shutdown_tx,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_first_byte_stall_keeps_sibling_requests_independent() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-first-byte-stall");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let (stalled_url, mut stalled_requests, _stalled_release, stalled_shutdown) =
        start_first_byte_stalled_upstream().await;
    let (healthy_url, mut healthy_requests, healthy_shutdown) = start_controlled_upstream().await;
    let mut manifest = concurrency_switch_manifest(&stalled_url, &healthy_url);
    use_native_direct_responses(&mut manifest);
    let ids: Vec<String> = manifest.providers.keys().cloned().collect();
    let stalled_id = ids[0].clone();
    let healthy_id = ids[1].clone();
    {
        let stalled = manifest.providers.get_mut(&stalled_id).unwrap();
        stalled.request_timeout_ms = 400;
        stalled.sse_first_frame_timeout_ms = Some(400);
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let endpoint = format!("{base}/v1/responses");
    let stalled_client = client.clone();
    let stalled_endpoint = endpoint.clone();
    let mut stalled = tokio::spawn(async move {
        stalled_client
            .post(stalled_endpoint)
            .header("session-id", "first-byte-stall")
            .json(&json!({"model":"client-test","input":"stalled","stream":true}))
            .send()
            .await
    });
    timeout(Duration::from_secs(2), stalled_requests.recv())
        .await
        .expect("the stalled provider must receive the first request")
        .unwrap();
    assert!(
        timeout(Duration::from_millis(100), &mut stalled)
            .await
            .is_err(),
        "the stalled provider must leave its request pending before the budget expires"
    );
    let started = std::time::Instant::now();
    let healthy = client
        .post(&endpoint)
        .header("session-id", "first-byte-stall")
        .json(&json!({"model":format!("{healthy_id}.test"),"input":"independent","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(healthy.status(), StatusCode::OK);
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "a stalled provider must not delay a request served by a healthy provider: {:?}",
        started.elapsed()
    );
    assert_responses_sse_delivered_business_text(
        &healthy.text().await.unwrap(),
        "controlled SSE response",
    );
    assert!(
        !stalled.is_finished(),
        "the stalled request must still be waiting while the sibling completes"
    );
    let stalled_response = timeout(Duration::from_secs(3), stalled)
        .await
        .expect("the stalled candidate must time out into the next candidate")
        .unwrap()
        .unwrap();
    assert_eq!(stalled_response.status(), StatusCode::OK);
    assert_responses_sse_delivered_business_text(
        &stalled_response.text().await.unwrap(),
        "controlled SSE response",
    );
    timeout(Duration::from_secs(2), healthy_requests.recv())
        .await
        .expect("the healthy provider must receive the independent request")
        .unwrap();
    timeout(Duration::from_secs(2), healthy_requests.recv())
        .await
        .expect("the timed-out candidate must reselect onto the healthy provider")
        .unwrap();
    assert!(
        stalled_requests.try_recv().is_err(),
        "the stalled candidate must not receive repeated concurrent attempts"
    );
    timeout(Duration::from_secs(2), handle.shutdown())
        .await
        .expect("a stalled provider must not block server shutdown");
    stalled_shutdown.send(()).unwrap();
    healthy_shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue44cc3af_inactive_window_does_not_spin_or_block_http() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-inactive-window");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let (good_url, mut good_requests, good_release, good_shutdown) =
        start_controlled_held_upstream().await;
    let mut manifest = concurrency_switch_manifest("http://127.0.0.1:9/v1", &good_url);
    use_native_direct_responses(&mut manifest);
    let ids: Vec<String> = manifest.providers.keys().cloned().collect();
    let minute = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        / 60)
        % 1440;
    let format_minute = |minute: u64| format!("{:02}:{:02}", minute / 60, minute % 60);
    let availability = routecodex_v3_config::V3ProviderModelAvailabilityAuthoringConfig {
        timezone: "UTC".into(),
        guard_minutes: 0,
        periods: vec![routecodex_v3_config::V3DailyTimeWindowAuthoringConfig {
            start: format_minute((minute + 3) % 1440),
            end: format_minute((minute + 4) % 1440),
        }],
    };
    manifest
        .providers
        .get_mut(&ids[0])
        .unwrap()
        .models
        .get_mut("test")
        .unwrap()
        .availability = Some(availability);
    manifest
        .forwarders
        .get_mut("concurrency")
        .unwrap()
        .targets
        .retain(|target| target.provider.as_deref() == Some(ids[0].as_str()));
    let good_model = format!("{}.test", ids[1]);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let mut waiting = Vec::new();
    for _ in 0..2 {
        let client = client.clone();
        let base = base.clone();
        waiting.push(tokio::spawn(async move {
            let response = client
                .post(format!("{base}/v1/responses"))
                .header("session-id", "independent")
                .json(&json!({"model":"client-test","input":"waiting","stream":true}))
                .send()
                .await?;
            response.text().await
        }));
    }
    for request in &mut waiting {
        assert!(
            timeout(Duration::from_millis(100), request).await.is_err(),
            "inactive route must wait before retry"
        );
    }
    assert!(
        good_requests.try_recv().is_err(),
        "waiting requests must not reach the unrelated provider"
    );
    let good_client = client.clone();
    let endpoint = format!("{base}/v1/responses");
    let healthy = tokio::spawn(async move {
        good_client
            .post(endpoint)
            .header("session-id", "independent")
            .json(&json!({"model":good_model,"input":"held","stream":true}))
            .send()
            .await
            .unwrap()
    });
    timeout(Duration::from_secs(2), good_requests.recv())
        .await
        .expect("independent request must reach healthy provider")
        .unwrap();
    good_release.add_permits(1);
    let response = timeout(Duration::from_secs(2), healthy)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_responses_sse_delivered_business_text(
        &response.text().await.unwrap(),
        "held response released",
    );
    for request in waiting {
        request.abort();
    }
    timeout(Duration::from_secs(2), handle.shutdown())
        .await
        .expect("waiting requests must not block shutdown");
    good_shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
}

#[tokio::test]
async fn issue44cc3af_all_tried_transport_failure_waits_for_recovered_peer() {
    assert_all_tried_transport_failure_recovers(false, false).await;
}

#[tokio::test]
async fn issue44cc3af_direct_all_tried_transport_failure_waits_for_recovered_peer() {
    assert_all_tried_transport_failure_recovers(true, false).await;
}

#[tokio::test]
async fn issue44cc3af_request_scan_relay() {
    assert_all_tried_transport_failure_recovers(false, true).await;
}

#[tokio::test]
async fn issue44cc3af_request_scan_direct() {
    assert_all_tried_transport_failure_recovers(true, true).await;
}

async fn closed_transport_peer(
    ready: Arc<std::sync::atomic::AtomicBool>,
    direct: bool,
    held: Option<Arc<Semaphore>>,
    independent: Option<Arc<Semaphore>>,
) -> (
    String,
    tokio::task::JoinHandle<()>,
    mpsc::UnboundedReceiver<(bool, String, Value)>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::<()>::new();
        loop {
            let (mut socket, _) = tokio::select! {
                accepted = listener.accept() => accepted.unwrap(),
                _ = connections.join_next(), if !connections.is_empty() => continue,
            };
            let ready = ready.clone();
            let held = held.clone();
            let independent = independent.clone();
            let tx = tx.clone();
            connections.spawn(async move {
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            let (header_end, content_length) = loop {
                let count = socket.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break (0, 0);
                }
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]);
                    let length = header
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break (end + 4, length);
                }
            };
            if header_end == 0 {
                return;
            }
            while bytes.len() < header_end + content_length {
                let count = socket.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
            }
            let body: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
            let path = String::from_utf8_lossy(&bytes[..header_end])
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap()
                .to_string();
            let probe = body.to_string().contains("ping; reply pong")
                || body
                    .to_string()
                    .contains("Reply exactly OK. Do not call tools.");
            tx.send((probe, path, body)).unwrap();
            let body_text = String::from_utf8_lossy(&bytes[header_end..header_end + content_length]);
            if body_text.contains("independence-held") {
                if let Some(held) = held.as_ref() { held.acquire().await.unwrap().forget(); }
            }
            if body_text.contains("independence-wave") {
                if let Some(independent) = independent.as_ref() { independent.acquire().await.unwrap().forget(); }
            }
            if !ready.load(std::sync::atomic::Ordering::SeqCst) {
                // No HTTP response at all: this is a real pre-header transport failure.
                socket.shutdown().await.unwrap();
                return;
            }
            let response = if direct {
                json!({"id":"recovered-peer","object":"response","status":"completed",
                    "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"all tried peer recovered"}]}]})
            } else {
                json!({"id":"recovered-peer","object":"chat.completion","model":"wire-test",
                    "choices":[{"index":0,"message":{"role":"assistant","content":"all tried peer recovered"},"finish_reason":"stop"}]})
            }.to_string();
            let wire = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response);
            socket.write_all(wire.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
            });
        }
    });
    (url, task, rx)
}

async fn assert_all_tried_transport_failure_recovers(direct: bool, hard_cap: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-all-tried-transport");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let held_release = Arc::new(Semaphore::new(0));
    let independent_release = Arc::new(Semaphore::new(0));
    let (first_url, first_task, mut first_rx) = closed_transport_peer(
        ready.clone(),
        direct,
        Some(held_release.clone()),
        Some(independent_release.clone()),
    )
    .await;
    let (second_url, second_task, mut second_rx) = closed_transport_peer(
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
        direct,
        None,
        None,
    )
    .await;
    let mut manifest = concurrency_switch_manifest_with_mode(
        &first_url,
        &second_url,
        if direct {
            V3EntryProtocolExecutionMode::Direct
        } else {
            V3EntryProtocolExecutionMode::Relay
        },
    );
    if direct {
        use_native_direct_responses(&mut manifest);
    } else {
        for provider in manifest.providers.values_mut() {
            provider.provider_type = "openai_chat".into();
            provider.responses = None;
            for interface in provider.interfaces.values_mut() {
                interface.provider_type = "openai_chat".into();
                interface.responses = None;
            }
        }
    }
    for server in manifest.servers.values_mut() {
        server
            .execution
            .as_mut()
            .unwrap()
            .attempt_store
            .residence_timeout_ms = 4000;
        if hard_cap {
            server
                .execution
                .as_mut()
                .unwrap()
                .attempt_store
                .request_max_attempts = 2;
        }
    }
    let first_id = format!("concurrency_first_{}", manifest.servers["a"].port);
    let second_id = format!("concurrency_second_{}", manifest.servers["a"].port);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let mut request = tokio::spawn({
        let client = client.clone();
        let base = base.clone();
        async move {
            client.post(format!("{base}/v1/responses"))
            .json(&json!({"model":"client-test","input":"all tried transport original request","stream":false}))
            .send().await?.text().await
        }
    });
    let first_wire = timeout(Duration::from_secs(2), first_rx.recv())
        .await
        .unwrap()
        .unwrap();
    let second_wire = timeout(Duration::from_secs(2), second_rx.recv())
        .await
        .unwrap()
        .unwrap();
    let expected_path = if direct {
        "/v1/responses"
    } else {
        "/v1/chat/completions"
    };
    assert_eq!(first_wire.1, expected_path);
    assert_eq!(second_wire.1, expected_path);
    assert!(!first_wire.0 && !second_wire.0);
    assert!(first_wire
        .2
        .to_string()
        .contains("all tried transport original request"));
    let duplicate = timeout(Duration::from_millis(250), async {
        loop {
            tokio::select! {
                observed = first_rx.recv() => {
                    let observed = observed.expect("first upstream remains available");
                    if !observed.0 { break observed; }
                }
                observed = second_rx.recv() => {
                    let observed = observed.expect("second upstream remains available");
                    if !observed.0 { break observed; }
                }
            }
        }
    })
    .await;
    assert!(
        duplicate.is_err(),
        "one request must send each complete identity at most once before complete-scan recovery: {duplicate:?}"
    );
    let early = timeout(Duration::from_millis(150), &mut request).await;
    let ended_early = early.is_ok();
    let entries = pool_entries_for_transport_case(&client, &base).await;
    assert!(
        !entries.iter().any(|e| e["provider_id"] == second_id),
        "last candidate must not be newly cooled"
    );
    ready.store(true, std::sync::atomic::Ordering::SeqCst);
    // A has not been cooled. Its existing aggregate owner observes it after
    // the declared hold floor; a manual cooldown probe would bypass that edge.
    assert!(
        !entries.iter().any(|e| e["provider_id"] == first_id),
        "the earlier failed identity must remain in pre-cool observation"
    );
    let outcome = match early {
        Ok(result) => Some(result),
        Err(_) => timeout(
            // Request-owned rescue probes are gone. Recovery now follows the
            // aggregate cooldown schedule: one second to settle the pre-cool
            // observation plus the five-second cooldown probe interval.
            Duration::from_secs(8),
            &mut request,
        )
        .await
        .ok(),
    };
    if outcome.is_none() {
        eprintln!(
            "44cc3af recovery timeout: request_finished={} pool={:?}",
            request.is_finished(),
            pool_entries_for_transport_case(&client, &base).await
        );
        while let Ok(observed) = first_rx.try_recv() {
            eprintln!("44cc3af first identity after exhaustion: {observed:?}");
        }
        while let Ok(observed) = second_rx.try_recv() {
            eprintln!("44cc3af second identity after exhaustion: {observed:?}");
        }
    }
    request.abort();
    handle.shutdown().await;
    first_task.abort();
    second_task.abort();
    assert!(
        !ended_early,
        "all tried transport failures must wait for captured-pool recovery: {outcome:?}"
    );
    let body = outcome
        .expect("a new request-local scan must complete without a prior success revision")
        .unwrap()
        .unwrap();
    assert!(body.contains("all tried peer recovered"), "{body}");
    assert!(!body.contains("\"error\""), "{body}");
    let mut recovered_business = false;
    while let Ok((probe, path, body)) = first_rx.try_recv() {
        assert_eq!(path, expected_path);
        recovered_business |= !probe
            && body
                .to_string()
                .contains("all tried transport original request");
    }
    assert!(
        recovered_business,
        "the original business request must reach the recovered peer after a new scan"
    );
    assert!(
        second_rx.try_recv().is_err(),
        "last failed candidate must not be retried"
    );
}

async fn pool_entries_for_transport_case(client: &reqwest::Client, base: &str) -> Vec<Value> {
    client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["entries"]
        .as_array()
        .unwrap()
        .clone()
}

pub(super) fn use_native_direct_responses(
    manifest: &mut routecodex_v3_config::V3Config05ManifestPublished,
) {
    for provider in manifest.providers.values_mut() {
        provider
            .responses
            .as_mut()
            .expect("fixture declares Responses")
            .process = "direct".into();
        for interface in provider.interfaces.values_mut() {
            interface
                .responses
                .as_mut()
                .expect("compiled interface declares Responses")
                .process = "direct".into();
        }
    }
}

#[tokio::test]
async fn issue44cc3af_review_chat_empty_sse_recovers_cooled_peer() {
    assert_review_direct_empty_sse_recovers("openai_chat").await;
}

#[tokio::test]
async fn issue44cc3af_review_messages_empty_sse_recovers_cooled_peer() {
    assert_review_direct_empty_sse_recovers("anthropic").await;
}

async fn assert_review_direct_empty_sse_recovers(protocol: &str) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-review-direct-protocols");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut manifest = concurrency_switch_manifest(
        &format!("http://{}/v1", first.local_addr().unwrap()),
        &format!("http://{}/v1", second.local_addr().unwrap()),
    );
    let endpoint = if protocol == "openai_chat" {
        "/v1/chat/completions"
    } else {
        "/v1/messages"
    };
    for server in manifest.servers.values_mut() {
        server.endpoints = vec![protocol.to_string()];
    }
    for provider in manifest.providers.values_mut() {
        provider.provider_type = protocol.to_string();
        provider.responses = None;
        for interface in provider.interfaces.values_mut() {
            interface.provider_type = protocol.to_string();
            interface.responses = None;
        }
    }
    let peer = format!("concurrency_second_{}", manifest.servers["a"].port);
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let app = Router::new().fallback_service(post({
        let calls = calls.clone();
        move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = tx.send(());
            async {
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from("data: [DONE]\n\n"))
                    .unwrap()
            }
        }
    }));
    let first_task = tokio::spawn(async move { axum::serve(first, app).await.unwrap() });
    let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let success = if protocol == "openai_chat" {
        json!({"id":"chat-recovered","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"cooled protocol peer recovered"},"finish_reason":"stop"}]})
    } else {
        json!({"id":"msg-recovered","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"cooled protocol peer recovered"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}})
    };
    let app = Router::new().fallback_service(post({
        let ready = ready.clone();
        move || {
            let ready = ready.clone();
            let success = success.clone();
            async move {
                if ready.load(std::sync::atomic::Ordering::SeqCst) {
                    axum::Json(success).into_response()
                } else {
                    (StatusCode::SERVICE_UNAVAILABLE, "peer still cooled").into_response()
                }
            }
        }
    }));
    let second_task = tokio::spawn(async move { axum::serve(second, app).await.unwrap() });
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let cool = client.post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({"provider_id":peer,"auth_alias":"key","model_id":"test","kind":"probe","duration_ms":500}))
        .send().await.unwrap();
    assert_eq!(cool.status(), StatusCode::OK);
    let mut request = tokio::spawn({
        let base = base.clone();
        let client = client.clone();
        async move {
            client.post(format!("{base}{endpoint}"))
            .json(&json!({"model":"client-test","messages":[{"role":"user","content":"recover empty SSE"}],"max_tokens":32,"stream":false}))
            .send().await?.text().await
        }
    });
    timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let early = timeout(Duration::from_millis(150), &mut request).await;
    let ended_early = early.is_ok();
    ready.store(true, std::sync::atomic::Ordering::SeqCst);
    let probe = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
        .json(&json!({"provider_id":peer,"auth_alias":"key","model_id":"test"}))
        .send()
        .await
        .unwrap();
    assert_eq!(probe.status(), StatusCode::OK);
    let result = match early {
        Ok(r) => Some(r),
        Err(_) => timeout(Duration::from_secs(3), &mut request).await.ok(),
    };
    request.abort();
    handle.shutdown().await;
    first_task.abort();
    second_task.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert!(
        !ended_early,
        "Direct {protocol} must hand empty SSE failure to cooled-peer recovery: {result:?}"
    );
    let body = result
        .expect("recovered request finishes")
        .unwrap()
        .unwrap();
    assert!(body.contains("cooled protocol peer recovered"), "{body}");
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn issue44cc3af_review_initial_preplan_obeys_residence_deadline() {
    assert_review_preplan_deadline(false).await;
}

#[tokio::test]
async fn issue44cc3af_review_initial_preplan_does_not_renew_deadline() {
    assert_review_preplan_deadline(true).await;
}

async fn assert_review_preplan_deadline(recover: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-preplan-deadline");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let mut manifest = concurrency_switch_manifest(&url, &url);
    for s in manifest.servers.values_mut() {
        s.execution
            .as_mut()
            .unwrap()
            .attempt_store
            .residence_timeout_ms = if recover { 1000 } else { 300 };
    }
    let ids: Vec<_> = manifest.providers.keys().cloned().collect();
    let business_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let probe_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let app = Router::new().route(
        "/v1/responses",
        post({
            let business_calls = business_calls.clone();
            let probe_calls = probe_calls.clone();
            move |axum::Json(body): axum::Json<Value>| {
                let business_calls = business_calls.clone();
                let probe_calls = probe_calls.clone();
                async move {
                    let business = body.to_string().contains("preplan must share deadline");
                    if business {
                        business_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    let recovered = recover
                        && (business
                            || probe_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0);
                    if recover && business {
                        let delayed = futures_util::stream::once(async {
                            sleep(Duration::from_secs(2)).await;
                            Ok::<_, std::io::Error>(axum::body::Bytes::from_static(
                                b"data: [DONE]\n\n",
                            ))
                        });
                        return Response::builder()
                            .header("content-type", "text/event-stream")
                            .body(Body::from_stream(delayed))
                            .unwrap();
                    }
                    if recovered {
                        sleep(Duration::from_millis(500)).await;
                    }
                    if recovered {
                        identity_test_response("late response must be cancelled")
                    } else {
                        (StatusCode::SERVICE_UNAVAILABLE, "still cooled").into_response()
                    }
                }
            }
        }),
    );
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    for id in ids {
        client.post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({"provider_id":id,"auth_alias":"key","model_id":"test","kind":"probe","duration_ms":1}))
        .send().await.unwrap().error_for_status().unwrap();
    }
    let started = tokio::time::Instant::now();
    let outcome = timeout(Duration::from_secs(3), async {
        let response = client
            .post(format!("{base}/v1/responses"))
            .json(
                &json!({"model":"client-test","input":"preplan must share deadline","stream":true}),
            )
            .send()
            .await;
        let Ok(mut response) = response else {
            return (true, Vec::new());
        };
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => bytes.extend(chunk),
                Ok(None) => return (false, bytes),
                Err(_) => return (true, bytes),
            }
        }
    })
    .await;
    let elapsed = started.elapsed();
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    if recover {
        assert_eq!(
            business_calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "successful preplanning must hand off to one real business attempt"
        );
    }
    let (minimum, maximum) = if recover { (900, 1350) } else { (250, 450) };
    assert!(
        elapsed >= Duration::from_millis(minimum) && elapsed < Duration::from_millis(maximum),
        "preplanning and execution must share the original request deadline: {elapsed:?}"
    );
    let (broken, bytes) = outcome.expect("deadline must finish the request");
    assert!(broken, "deadline must break transport detectably");
    let body = String::from_utf8_lossy(&bytes);
    assert!(
        !body.contains("error")
            && !body.contains("response.completed")
            && !body.contains("late response"),
        "no error payload or fabricated success may precede the break: {body}"
    );
}

#[tokio::test]
async fn issue44cc3af_failed_attempt_waits_for_cooled_peer() {
    assert_failed_attempt_waits_for_cooled_peer(false, "recover").await;
}

#[tokio::test]
async fn issue44cc3af_direct_failed_attempt_waits_for_cooled_peer() {
    assert_failed_attempt_waits_for_cooled_peer(true, "recover").await;
}

#[tokio::test]
async fn issue44cc3af_failed_attempt_cooled_peer_obeys_wait_budget() {
    assert_failed_attempt_waits_for_cooled_peer(false, "exhaust").await;
}

#[tokio::test]
async fn issue44cc3af_direct_failed_attempt_cooled_peer_obeys_wait_budget() {
    assert_failed_attempt_waits_for_cooled_peer(true, "exhaust").await;
}

#[tokio::test]
async fn issue44cc3af_failed_attempt_cooled_peer_residence_deadline() {
    assert_failed_attempt_waits_for_cooled_peer(false, "residence").await;
}

#[tokio::test]
async fn issue44cc3af_direct_failed_attempt_cooled_peer_residence_deadline() {
    assert_failed_attempt_waits_for_cooled_peer(true, "residence").await;
}

#[tokio::test]
async fn issue9bb26d4_relay_exhausted_send_recovers_after_real_probe() {
    assert_failed_attempt_waits_for_cooled_peer(false, "recover_exhausted").await;
}

#[tokio::test]
async fn issue9bb26d4_direct_exhausted_send_recovers_after_real_probe() {
    assert_failed_attempt_waits_for_cooled_peer(true, "recover_exhausted").await;
}

#[tokio::test]
async fn issue44cc3af_failed_attempt_cooled_peer_cancel_stops_business_dispatch() {
    assert_failed_attempt_waits_for_cooled_peer(false, "cancel").await;
}

#[tokio::test]
async fn issue44cc3af_direct_failed_attempt_cooled_peer_cancel_stops_business_dispatch() {
    assert_failed_attempt_waits_for_cooled_peer(true, "cancel").await;
}

async fn assert_failed_attempt_waits_for_cooled_peer(direct: bool, mode: &str) {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-failed-cooled-peer");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    std::env::set_var("V3_P6_TEST_KEY", "44cc3af-test-key");
    let first_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_url = format!("http://{}/v1", first_listener.local_addr().unwrap());
    let second_url = format!("http://{}/v1", second_listener.local_addr().unwrap());
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let peer_business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (failed_tx, mut failed_rx) = mpsc::unbounded_channel();
    let first_app = Router::new().route(
        "/v1/responses",
        post({
            let calls = calls.clone();
            move |axum::Json(body): axum::Json<Value>| {
                let is_independent = body.to_string().contains("independent session control");
                if !is_independent {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = failed_tx.send(());
                }
                async move {
                    if is_independent {
                        identity_test_response("independent session completed")
                    } else {
                        (
                            StatusCode::SERVICE_UNAVAILABLE,
                            axum::Json(json!({"error":{"message":"failed first identity"}})),
                        )
                            .into_response()
                    }
                }
            }
        }),
    );
    let second_app = Router::new().route(
        "/v1/responses",
        post({
            let ready = ready.clone();
            let peer_business = peer_business.clone();
            move |axum::Json(body): axum::Json<Value>| {
                let ready = ready.clone();
                let peer_business = peer_business.clone();
                async move {
                    if body.to_string().contains("failed plus cooled peer") {
                        peer_business.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    if ready.load(std::sync::atomic::Ordering::SeqCst) {
                        identity_test_response("cooled peer recovered business")
                    } else {
                        Response::builder()
                            .status(503)
                            .body(Body::from("cooled peer not ready"))
                            .unwrap()
                    }
                }
            }
        }),
    );
    let first_upstream = tokio::spawn(async move {
        axum::serve(first_listener, first_app).await.unwrap();
    });
    let second_upstream = tokio::spawn(async move {
        axum::serve(second_listener, second_app).await.unwrap();
    });
    let mut manifest = concurrency_switch_manifest(&first_url, &second_url);
    if mode == "residence" || mode == "exhaust" || mode == "recover_exhausted" {
        for server in manifest.servers.values_mut() {
            server
                .execution
                .as_mut()
                .unwrap()
                .attempt_store
                .residence_timeout_ms = if mode == "residence" || mode == "recover_exhausted" {
                300
            } else {
                400
            };
            if mode == "recover_exhausted" {
                server
                    .execution
                    .as_mut()
                    .unwrap()
                    .attempt_store
                    .request_max_attempts = 1;
            }
        }
    }
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let independent_id = format!("independent_{}", manifest.servers["a"].port);
    if mode == "recover_exhausted" {
        let first_id = format!("concurrency_first_{}", manifest.servers["a"].port);
        let mut independent = manifest.providers[&first_id].clone();
        independent.id = independent_id.clone();
        manifest
            .providers
            .insert(independent_id.clone(), independent);
    }
    let second_id = format!("concurrency_second_{}", manifest.servers["a"].port);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let cooled = reqwest::Client::new().post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({"provider_id":second_id,"auth_alias":"key","model_id":"test","kind":"probe","duration_ms":500}))
        .send().await.unwrap();
    assert_eq!(cooled.status(), StatusCode::OK);
    let started = tokio::time::Instant::now();
    let mut request = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!("{base}/v1/responses"))
            .json(&json!({"model":"client-test","input":"failed plus cooled peer","stream":true}))
            .send()
            .await?
            .text()
            .await
    });
    timeout(Duration::from_secs(2), failed_rx.recv())
        .await
        .unwrap()
        .unwrap();
    let early = timeout(Duration::from_millis(150), &mut request).await;
    let ended_early = early.is_ok();
    if mode == "cancel" && !ended_early {
        request.abort();
        let _ = (&mut request).await;
    }
    if mode == "recover_exhausted" {
        let independent = timeout(
            Duration::from_secs(2),
            async {
                reqwest::Client::new()
                    .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
                    .header("session-id", "independent-session-control")
                    .json(&json!({"model":format!("{independent_id}.test"),"input":"independent session control","stream":true}))
                    .send().await?.text().await
            },
        ).await.expect("independent session must complete while A waits").unwrap();
        assert!(
            independent.contains("independent session completed"),
            "independent session must receive real business content: {independent}"
        );
    }
    if mode == "residence" || mode == "recover_exhausted" {
        tokio::time::sleep_until(started + Duration::from_millis(400)).await;
        assert!(
            !request.is_finished(),
            "a recoverable request must remain open past residence"
        );
    }
    ready.store(mode != "exhaust", std::sync::atomic::Ordering::SeqCst);
    // Publish a genuine successful recovery probe. Do not clear cooldown or
    // rely on wall-clock expiry to make the peer routable.
    if mode != "exhaust" {
        let probe = reqwest::Client::new()
            .post(format!(
                "http://{}/_routecodex/health/cooldown-pool/probe",
                handle.listeners[0].addr
            ))
            .json(&json!({"provider_id":second_id,"auth_alias":"key","model_id":"test"}))
            .send()
            .await
            .unwrap();
        assert_eq!(probe.status(), StatusCode::OK);
    }
    if mode == "cancel" {
        sleep(Duration::from_millis(700)).await;
        handle.shutdown().await;
        first_upstream.abort();
        second_upstream.abort();
        std::env::remove_var("V3_P6_TEST_KEY");
        assert!(
            !ended_early,
            "client must be able to cancel a live recovery wait"
        );
        assert_eq!(
            peer_business.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "cancelled request must never dispatch business after recovery"
        );
        return;
    }
    if mode == "exhaust" {
        let outcome = if ended_early {
            early
        } else {
            timeout(Duration::from_millis(700), &mut request).await
        };
        assert!(
            outcome.is_err(),
            "recoverable pool exhaustion must remain open: {outcome:?}"
        );
        request.abort();
        handle.shutdown().await;
        first_upstream.abort();
        second_upstream.abort();
        std::env::remove_var("V3_P6_TEST_KEY");
        return;
    }
    let result = match early {
        Ok(result) => Some(result),
        // A failed initial rescue advances the real five-second probe ladder.
        // The request's declared acquisition budget is sixty seconds.
        Err(_) => match timeout(Duration::from_secs(10), &mut request).await {
            Ok(result) => Some(result),
            Err(_) => {
                request.abort();
                None
            }
        },
    };
    handle.shutdown().await;
    first_upstream.abort();
    second_upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert!(!ended_early, "a failed attempt must not close transport while a cooled peer can recover within budget: {result:?}");
    let body = result
        .expect("request must finish after peer recovery")
        .unwrap()
        .unwrap();
    assert!(
        body.contains("cooled peer recovered business") && body.contains("response.completed"),
        "{body}"
    );
    assert!(
        !body.contains("failed first identity"),
        "provider errors must stay internal"
    );
    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "only the unfailed peer should be recovered"
    );
}

fn identity_test_response(text: &str) -> Response<Body> {
    let event = json!({"type":"response.completed","response":{"id":"identity-test","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}]}});
    Response::builder()
        .status(200)
        .header("content-type", "text/event-stream")
        .body(Body::from(format!(
            "event: response.completed\ndata: {event}\n\ndata: [DONE]\n\n"
        )))
        .unwrap()
}

// Public-entry coverage of one real controlled 429 on an exact provider
// identity. The failing request must reselect the healthy alternative without
// waiting, while sibling keys/models/providers on the same physical upstream
// keep progressing. The provider error body never reaches a client. This does
// not restore request concurrency limits, nor assert that a single 429
// globally excludes the identity from later independent requests; the latest
// policy cools only after three consecutive real 429s.
#[tokio::test]
async fn issue44cc3af_429_healthy_alternatives_keep_parallelism() {
    assert_identity_only_rate_limit(false).await;
}

#[tokio::test]
async fn issue44cc3af_direct_429_healthy_alternatives_keep_parallelism() {
    assert_identity_only_rate_limit(true).await;
}

#[tokio::test]
async fn issue44cc3af_direct_first_byte_timeout_keeps_sibling_key_eligible() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-first-byte-sibling-key");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    std::env::set_var("V3_IDENTITY_OTHER_KEY", "other-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let app = Router::new().route(
        "/v1/responses",
        post(move |headers: HeaderMap| {
            let tx = tx.clone();
            async move {
                let other = headers.get("authorization").and_then(|v| v.to_str().ok())
                    == Some("Bearer other-key");
                let _ = tx.send(other);
                if other {
                    identity_test_response("sibling key recovered")
                } else {
                    std::future::pending::<Response<Body>>().await
                }
            }
        }),
    );
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut manifest = identity_only_rate_limit_manifest(&url, &url);
    use_native_direct_responses(&mut manifest);
    let first_id = format!("identity_first_{}", manifest.servers["a"].port);
    let provider = manifest.providers.get_mut(&first_id).unwrap();
    provider.request_timeout_ms = 300;
    provider.sse_first_frame_timeout_ms = Some(300);
    let targets = &mut manifest.forwarders.get_mut("identity").unwrap().targets;
    targets[1].provider = Some(first_id);
    targets[1].key = Some("other".into());
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let response = timeout(Duration::from_secs(5), async {
        reqwest::Client::new()
            .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
            .header("session-id", "first-byte-sibling-key")
            .json(&json!({"model":"client-test","input":"timeout sibling","stream":true}))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
    })
    .await
    .expect("healthy sibling key must complete the request");
    let first = rx.try_recv().unwrap();
    let second = rx.try_recv().unwrap();
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    std::env::remove_var("V3_IDENTITY_OTHER_KEY");
    assert!(
        !first && second,
        "the sibling key must be selected after the timed-out key"
    );
    assert!(
        response.contains("sibling key recovered") && response.contains("response.completed"),
        "{response}"
    );
}

fn identity_only_rate_limit_manifest(
    first_url: &str,
    second_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let port = free_port();
    let first = format!("identity_first_{port}");
    let second = format!("identity_second_{port}");
    let providers = [(&first, first_url), (&second, second_url)]
        .into_iter()
        .map(|(id, url)| {
            format!(
                r#"
[providers.{id}]
type = "responses"
base_url = "{url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_P6_TEST_KEY" }}, {{ alias = "other", env = "V3_IDENTITY_OTHER_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}
[providers.{id}.models.test]
wire_name = "wire-test"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[providers.{id}.models.other]
wire_name = "wire-other"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
"#
            )
        })
        .collect::<String>();
    let source = format!(
        r#"
version = 3
{HUB_V1_TEST_DECLARATION}
[servers.a]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
[servers.a.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
{providers}
[forwarders.identity]
model = "client-test"
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{first}", model = "test", key = "key", priority = 2 }}, {{ kind = "provider_model", provider = "{second}", model = "test", key = "key", priority = 1 }}]
[route_groups.default.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["client-test"] }}
targets = [{{ kind = "forwarder", id = "identity", priority = 1 }}]
[route_groups.default.pools.search]
selection = {{ strategy = "priority" }}
match = {{ precedence = 30, entry_protocol = "responses" }}
targets = [{{ kind = "provider_model", provider = "{first}", model = "test", key = "other", priority = 1 }}]
[route_groups.default.pools.other_model]
selection = {{ strategy = "priority" }}
match = {{ precedence = 30, models = ["other-model"] }}
targets = [{{ kind = "provider_model", provider = "{first}", model = "other", key = "key", priority = 1 }}]
[route_groups.default.pools.other_provider]
selection = {{ strategy = "priority" }}
match = {{ precedence = 30, models = ["other-provider"] }}
targets = [{{ kind = "provider_model", provider = "{second}", model = "test", key = "key", priority = 1 }}]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "identity", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn identity_wire_success(direct: bool, text: &str) -> Response<Body> {
    let body = if direct {
        json!({
            "id": "identity-ok",
            "object": "response",
            "status": "completed",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            }],
        })
    } else {
        json!({
            "id": "identity-ok",
            "object": "chat.completion",
            "model": "wire-test",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }],
        })
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn identity_wire_429() -> Response<Body> {
    Response::builder()
        .status(StatusCode::TOO_MANY_REQUESTS)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"error":{"type":"rate_limit_error","message":"only this identity is limited"}}"#,
        ))
        .unwrap()
}

fn assert_identity_client_success(status: StatusCode, body: &str, expected: &str, label: &str) {
    assert_eq!(
        status,
        StatusCode::OK,
        "{label}: client must get a successful business response: {body}"
    );
    assert!(
        body.contains(expected),
        "{label}: client must carry the healthy business text {expected:?}: {body}"
    );
    assert!(
        !body.contains("only this identity is limited"),
        "{label}: the provider 429 body must stay internal: {body}"
    );
    assert!(
        !body.contains("\"error\""),
        "{label}: the client must never receive a provider or proxy error payload: {body}"
    );
}

async fn assert_identity_only_rate_limit(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new(if direct {
        "44cc3af-429-identity-direct"
    } else {
        "44cc3af-429-identity-relay"
    });
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    std::env::set_var("V3_P6_TEST_KEY", "limited-key");
    std::env::set_var("V3_IDENTITY_OTHER_KEY", "other-key");
    let mode = if direct { "Direct" } else { "Relay" };
    let wire_path = if direct {
        "/v1/responses"
    } else {
        "/v1/chat/completions"
    };

    let primary_first_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let first_independent_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (first_primary_tx, mut first_primary_rx) = mpsc::unbounded_channel();
    let first_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_url = format!("http://{}/v1", first_listener.local_addr().unwrap());
    let first_app = Router::new().route(
        wire_path,
        post({
            let primary_first_calls = primary_first_calls.clone();
            let first_independent_calls = first_independent_calls.clone();
            let first_primary_tx = first_primary_tx.clone();
            move |headers: HeaderMap, axum::Json(body): axum::Json<Value>| {
                let primary_first_calls = primary_first_calls.clone();
                let first_independent_calls = first_independent_calls.clone();
                let first_primary_tx = first_primary_tx.clone();
                async move {
                    let is_other_key = headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        == Some("Bearer other-key");
                    let is_other_model =
                        body.get("model").and_then(Value::as_str) == Some("wire-other");
                    if is_other_key || is_other_model {
                        first_independent_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        return identity_wire_success(direct, "independent identity completed");
                    }
                    primary_first_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = first_primary_tx.send(());
                    identity_wire_429()
                }
            }
        }),
    );

    let (second_primary_tx, mut second_primary_rx) = mpsc::unbounded_channel::<String>();
    let (cancel_hold_tx, mut cancel_hold_rx) = mpsc::unbounded_channel();
    let cancel_release = Arc::new(Semaphore::new(0));
    let second_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second_url = format!("http://{}/v1", second_listener.local_addr().unwrap());
    let second_app = Router::new().route(
        wire_path,
        post({
            let second_primary_tx = second_primary_tx.clone();
            let cancel_hold_tx = cancel_hold_tx.clone();
            let cancel_release = cancel_release.clone();
            move |axum::Json(body): axum::Json<Value>| {
                let second_primary_tx = second_primary_tx.clone();
                let cancel_hold_tx = cancel_hold_tx.clone();
                let cancel_release = cancel_release.clone();
                async move {
                    let text = body.to_string();
                    if text.contains("independent-other-provider") {
                        return identity_wire_success(direct, "independent identity completed");
                    }
                    let _ = second_primary_tx.send(text.clone());
                    if text.contains("cancel-alternative") {
                        let _ = cancel_hold_tx.send(());
                        cancel_release.acquire().await.unwrap().forget();
                    }
                    identity_wire_success(direct, "healthy alternative completed")
                }
            }
        }),
    );
    let first_upstream = tokio::spawn(async move {
        axum::serve(first_listener, first_app).await.unwrap();
    });
    let second_upstream = tokio::spawn(async move {
        axum::serve(second_listener, second_app).await.unwrap();
    });

    let mut manifest = identity_only_rate_limit_manifest(&first_url, &second_url);
    if direct {
        use_native_direct_responses(&mut manifest);
    } else {
        let binding = manifest
            .hub_v1
            .as_mut()
            .expect("identity fixture must declare hub_v1")
            .entry_protocol_bindings
            .iter_mut()
            .find(|binding| binding.entry_protocol == "responses")
            .expect("identity fixture must declare the Responses binding");
        binding.execution_mode = V3EntryProtocolExecutionMode::Relay;
        binding.protocol_profile_owner = "v3.hub_relay_runtime_closeout".to_string();
        binding.forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.".to_string();
        binding.runtime_owner_symbol =
            Some("execute_v3_responses_relay_runtime_with_default_transport".to_string());
        binding.runtime_owner_path = Some(
            "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs".to_string(),
        );
        for provider in manifest.providers.values_mut() {
            provider.provider_type = "openai_chat".into();
            provider.responses = None;
            for interface in provider.interfaces.values_mut() {
                interface.provider_type = "openai_chat".into();
                interface.responses = None;
            }
        }
    }
    let first_id = format!("identity_first_{}", manifest.servers["a"].port);
    let second_id = format!("identity_second_{}", manifest.servers["a"].port);
    let other_model_id = format!("{first_id}.other");
    let other_provider_id = format!("{second_id}.test");
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let spawn = |model: &str, input: &str| {
        let client = client.clone();
        let endpoint = endpoint.clone();
        let model = model.to_owned();
        let input = input.to_owned();
        tokio::spawn(async move {
            let input_payload = if input == "independent-other-key" {
                json!([
                    {"type":"message","role":"user","content":input},
                    {"type":"function_call","name":"exec_command","call_id":"search-key","arguments":"{\"cmd\":\"rg route src\"}"},
                    {"type":"function_call_output","call_id":"search-key","output":"done"}
                ])
            } else {
                json!(input)
            };
            let response = client
                .post(endpoint)
                .header("session-id", format!("44cc3af-identity-{input}"))
                .json(&json!({"model": model, "input": input_payload, "stream": false}))
                .send()
                .await?;
            let status = response.status();
            Ok::<_, reqwest::Error>((status, response.text().await?))
        })
    };

    // 1) The exact identity first.test/key answers the client-test request with a
    // real 429. That same request must immediately reselect second.test/key.
    let primary = spawn("client-test", "first-reselection");
    timeout(Duration::from_secs(2), first_primary_rx.recv())
        .await
        .expect("the exact identity must receive the client-test business attempt")
        .expect("first upstream business channel closed");
    let started = tokio::time::Instant::now();
    timeout(Duration::from_secs(2), second_primary_rx.recv())
        .await
        .expect("the current request must reselect the healthy alternative")
        .expect("second upstream business channel closed");
    let first_delay = started.elapsed();
    let (status, body) = timeout(Duration::from_secs(5), primary)
        .await
        .expect("the primary request must complete")
        .unwrap()
        .unwrap();
    assert_identity_client_success(
        status,
        &body,
        "healthy alternative completed",
        &format!("{mode} primary"),
    );
    assert!(
        first_delay < Duration::from_millis(350),
        "{mode}: the healthy alternative must not await the failed identity's backoff: {first_delay:?}"
    );

    // 2) Another auth key and another model on the same physical upstream, plus
    // another provider, must progress independently of the 429'd identity.
    let other_key = spawn("other-key", "independent-other-key");
    let (status, body) = timeout(Duration::from_secs(5), other_key)
        .await
        .expect("the other-key identity must complete")
        .unwrap()
        .unwrap();
    assert_identity_client_success(
        status,
        &body,
        "independent identity completed",
        &format!("{mode} other key"),
    );
    let other_model = spawn(&other_model_id, "independent-other-model");
    let (status, body) = timeout(Duration::from_secs(5), other_model)
        .await
        .expect("the other-model identity must complete")
        .unwrap()
        .unwrap();
    assert_identity_client_success(
        status,
        &body,
        "independent identity completed",
        &format!("{mode} other model"),
    );
    let other_provider = spawn(&other_provider_id, "independent-other-provider");
    let (status, body) = timeout(Duration::from_secs(5), other_provider)
        .await
        .expect("the other-provider identity must complete")
        .unwrap()
        .unwrap();
    assert_identity_client_success(
        status,
        &body,
        "independent identity completed",
        &format!("{mode} other provider"),
    );
    assert_eq!(
        first_independent_calls.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "{mode}: a different key and a different model on the 429'd provider must both be dispatched"
    );

    // 3) Cancelling a request that reselected to the held healthy alternative
    // must not send a late business attempt to the failed identity, and a
    // sibling request must still progress.
    let cancel = spawn("client-test", "cancel-alternative");
    timeout(Duration::from_secs(2), cancel_hold_rx.recv())
        .await
        .expect("the reselected healthy alternative must receive the held attempt")
        .expect("second upstream cancel channel closed");
    assert!(
        !cancel.is_finished(),
        "{mode}: the reselected healthy attempt is held, so the client request must still be pending"
    );
    let primary_at_hold = primary_first_calls.load(std::sync::atomic::Ordering::SeqCst);
    cancel.abort();
    let _ = cancel.await;
    cancel_release.add_permits(1);
    let sibling = spawn(
        &other_provider_id,
        "independent-other-provider-after-cancel",
    );
    let (status, body) = timeout(Duration::from_secs(5), sibling)
        .await
        .expect("the sibling request must complete after the cancellation")
        .unwrap()
        .unwrap();
    assert_identity_client_success(
        status,
        &body,
        "independent identity completed",
        &format!("{mode} sibling after cancel"),
    );
    assert_eq!(
        primary_first_calls.load(std::sync::atomic::Ordering::SeqCst),
        primary_at_hold,
        "{mode}: a cancelled healthy-alternative wait must not send a later attempt to the 429'd identity"
    );

    handle.shutdown().await;
    first_upstream.abort();
    second_upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    std::env::remove_var("V3_IDENTITY_OTHER_KEY");
}

#[tokio::test]
async fn issue44cc3af_429_gate_wait_obeys_request_residence_deadline() {
    assert_rate_limit_residence_deadline(false).await;
}

#[tokio::test]
async fn issue9bb26d4_relay_429_remains_open_past_residence() {
    assert_429_remains_open_past_residence(false).await;
}

#[tokio::test]
async fn issue9bb26d4_direct_429_remains_open_past_residence() {
    assert_429_remains_open_past_residence(true).await;
}

async fn assert_429_remains_open_past_residence(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("9bb26d4-rate-residence");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let app = Router::new().route(
        "/v1/responses",
        post(move || {
            let seen_tx = seen_tx.clone();
            async move {
                let _ = seen_tx.send(());
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    axum::Json(json!({"error":{"message":"capacity busy"}})),
                )
            }
        }),
    );
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    std::env::set_var("V3_P6_TEST_KEY", "9bb26d4-test-key");
    let url = format!("http://{addr}/v1");
    let mut manifest = concurrency_switch_manifest(&url, &url);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    for server in manifest.servers.values_mut() {
        server.http_sse_keepalive_ms = 10;
        server
            .execution
            .as_mut()
            .unwrap()
            .attempt_store
            .residence_timeout_ms = 1500;
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let mut response = reqwest::Client::new()
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .header("session-id", "9bb26d4-rate-residence")
        .json(&json!({"model":"client-test","input":"rate wait","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    timeout(Duration::from_secs(3), seen_rx.recv())
        .await
        .expect("provider attempt timed out")
        .expect("provider observer closed");
    let mut bytes = Vec::new();
    let outcome = timeout(Duration::from_millis(2200), async {
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => bytes.extend(chunk),
                Ok(None) => break "eof",
                Err(_) => break "transport error",
            }
        }
    })
    .await;
    drop(response);
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    let body = String::from_utf8(bytes).unwrap();
    assert!(
        !body.contains("capacity busy") && !body.contains("response.completed"),
        "{body}"
    );
    assert!(
        outcome.is_err(),
        "recoverable request closed after residence: {outcome:?}; body={body}"
    );
}

#[tokio::test]
async fn issue44cc3af_relay_incomplete_sse_remains_open_past_residence() {
    assert_incomplete_sse_remains_open_past_residence(false).await;
}

#[tokio::test]
async fn issue44cc3af_direct_incomplete_sse_remains_open_past_residence() {
    assert_incomplete_sse_remains_open_past_residence(true).await;
}

async fn assert_incomplete_sse_remains_open_past_residence(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-incomplete-sse-residence");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let app = Router::new().route(
        "/v1/responses",
        post(move |axum::Json(body): axum::Json<Value>| {
            let seen_tx = seen_tx.clone();
            async move {
                if body.to_string().contains("ping; reply pong") {
                    return identity_test_response("probe");
                }
                let _ = seen_tx.send(());
                let first = b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_incomplete\",\"status\":\"in_progress\",\"output\":[]}}\n\n".to_vec();
                let chunks = futures_util::stream::once(async move {
                    Ok::<_, std::io::Error>(first)
                })
                .chain(futures_util::stream::pending::<
                    Result<Vec<u8>, std::io::Error>,
                >());
                Response::builder()
                    .status(200)
                    .header("content-type", "text/event-stream")
                    .body(Body::from_stream(chunks))
                    .unwrap()
            }
        }),
    );
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    std::env::set_var("V3_P6_TEST_KEY", "44cc3af-incomplete-sse-key");
    let url = format!("http://{addr}/v1");
    let mut manifest = concurrency_switch_manifest(&url, &url);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    for server in manifest.servers.values_mut() {
        server.http_sse_keepalive_ms = 10;
        server
            .execution
            .as_mut()
            .unwrap()
            .attempt_store
            .residence_timeout_ms = 1500;
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let mut response = reqwest::Client::new()
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .header("session-id", "44cc3af-incomplete-sse-residence")
        .json(&json!({"model":"client-test","input":"incomplete stream","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    timeout(Duration::from_secs(3), seen_rx.recv())
        .await
        .expect("provider attempt timed out")
        .expect("provider observer closed");
    let mut bytes = Vec::new();
    let outcome = timeout(Duration::from_millis(2200), async {
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => bytes.extend(chunk),
                Ok(None) => break "eof",
                Err(_) => break "transport error",
            }
        }
    })
    .await;
    drop(response);
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    let body = String::from_utf8(bytes).unwrap();
    assert!(
        !body.contains("response.completed") && !body.contains("\"error\""),
        "{body}"
    );
    assert!(
        outcome.is_err(),
        "recoverable incomplete SSE closed after residence: {outcome:?}; body={body}"
    );
}

#[tokio::test]
async fn issue44cc3af_direct_429_gate_wait_obeys_request_residence_deadline() {
    assert_rate_limit_residence_deadline(true).await;
}

async fn assert_rate_limit_residence_deadline(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-rate-deadline");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/v1/responses",
        post(|| async {
            (
                StatusCode::TOO_MANY_REQUESTS,
                axum::Json(json!({"error":{"type":"rate_limit_error","message":"capacity busy"}})),
            )
        }),
    );
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    std::env::set_var("V3_P6_TEST_KEY", "44cc3af-test-key");
    let url = format!("http://{addr}/v1");
    let mut manifest = concurrency_switch_manifest(&url, &url);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let model = format!("concurrency_first_{}.test", manifest.servers["a"].port);
    for server in manifest.servers.values_mut() {
        server.http_sse_keepalive_ms = 10;
        server
            .execution
            .as_mut()
            .unwrap()
            .attempt_store
            .residence_timeout_ms = 150;
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let started = tokio::time::Instant::now();
    let mut response = reqwest::Client::new()
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .header("session-id", "44cc3af-rate-deadline")
        .json(&json!({"model":model,"input":"rate wait deadline","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut bytes = Vec::new();
    let broken = timeout(Duration::from_secs(3), async {
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => bytes.extend(chunk),
                Ok(None) => break false,
                Err(_) => break true,
            }
        }
    })
    .await;
    let elapsed = started.elapsed();
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert!(broken.expect("bounded rate-limit wait must terminate"));
    assert!(
        elapsed >= Duration::from_millis(120) && elapsed < Duration::from_millis(500),
        "request residence deadline must include gate queueing: {elapsed:?}"
    );
    let body = String::from_utf8(bytes).unwrap();
    assert!(
        !body.contains("error") && !body.contains("response.completed"),
        "{body}"
    );
}

#[tokio::test]
async fn issue44cc3af_stalled_rescue_probe_obeys_wait_budget_without_error_payload() {
    assert_stalled_rescue_probe_wait_budget(false, 1, None).await;
}

#[tokio::test]
async fn issue44cc3af_repeated_all_cooled_requests_each_wait_after_exhaustion() {
    assert_stalled_rescue_probe_wait_budget(false, 4, None).await;
}

#[tokio::test]
async fn issue44cc3af_direct_repeated_all_cooled_requests_each_wait_after_exhaustion() {
    assert_stalled_rescue_probe_wait_budget(true, 4, None).await;
}

#[tokio::test]
async fn issue44cc3af_pool_wait_outlives_single_candidate_acquire_timeout() {
    assert_stalled_rescue_probe_wait_budget(false, 1, Some(800)).await;
}

#[tokio::test]
async fn issue44cc3af_direct_pool_wait_outlives_single_candidate_acquire_timeout() {
    assert_stalled_rescue_probe_wait_budget(true, 1, Some(800)).await;
}

async fn assert_stalled_rescue_probe_wait_budget(
    direct: bool,
    requests: usize,
    request_deadline_ms: Option<u64>,
) {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-probe-budget");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let release = Arc::new(tokio::sync::Notify::new());
    let arrived = Arc::new(tokio::sync::Notify::new());
    let app = Router::new().route(
        "/v1/responses",
        post({
            let release = release.clone();
            let arrived = arrived.clone();
            move || {
                let release = release.clone();
                let arrived = arrived.clone();
                async move {
                    arrived.notify_one();
                    release.notified().await;
                    (StatusCode::OK, "pong")
                }
            }
        }),
    );
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    std::env::set_var("V3_P6_TEST_KEY", "44cc3af-test-key");
    let url = format!("http://{addr}/v1");
    let mut manifest = concurrency_switch_manifest(&url, &url);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    for server in manifest.servers.values_mut() {
        server.http_sse_keepalive_ms = 10;
        server
            .execution
            .as_mut()
            .unwrap()
            .attempt_store
            .residence_timeout_ms = request_deadline_ms.unwrap_or(150);
    }
    let providers: Vec<_> = manifest.providers.keys().cloned().collect();
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    for provider in providers {
        let response = client.post(format!("{base}/_routecodex/health/cooldown-pool/add"))
            .json(&json!({"provider_id":provider,"auth_alias":"key","model_id":"test","kind":"probe","duration_ms":1}))
            .send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let mut request_tasks = Vec::new();
    for index in 0..requests {
        let client = client.clone();
        let base = base.clone();
        request_tasks.push(tokio::spawn(async move {
            let started = tokio::time::Instant::now();
            let mut response = client
                .post(format!("{base}/v1/responses"))
                .header("session-id", format!("44cc3af-stalled-probe-{index}"))
                .json(&json!({"model":"client-test","input":"probe budget","stream":true}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let mut bytes = Vec::new();
            let outcome = timeout(
                Duration::from_millis(request_deadline_ms.unwrap_or(150) + 300),
                async {
                    loop {
                        match response.chunk().await {
                            Ok(Some(chunk)) => bytes.extend(chunk),
                            Ok(None) => break "eof",
                            Err(_) => break "transport error",
                        }
                    }
                },
            )
            .await;
            (started.elapsed(), outcome, bytes)
        }));
    }
    timeout(Duration::from_secs(2), arrived.notified())
        .await
        .unwrap();
    let mut outcomes = Vec::new();
    for request in request_tasks {
        outcomes.push(
            timeout(Duration::from_secs(3), request)
                .await
                .unwrap()
                .unwrap(),
        );
    }
    release.notify_waiters();
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    for (elapsed, outcome, bytes) in outcomes {
        assert!(
            elapsed >= Duration::from_millis(request_deadline_ms.unwrap_or(150)),
            "every fresh request must wait through its original budget: {elapsed:?}"
        );
        assert!(
            outcome.is_err(),
            "recoverable request must remain open: {outcome:?}"
        );
        let body = String::from_utf8(bytes).unwrap();
        if direct {
            // Direct's transport channel uses an empty SSE comment; Relay's
            // body wrapper labels the equivalent transport-only heartbeat.
            assert!(
                body.lines().any(|line| line.starts_with(':')),
                "missing SSE transport comment after {elapsed:?}: {body:?}"
            );
        } else {
            assert!(body.contains(": keepalive"));
        }
        assert!(
            !body.contains("error") && !body.contains("response.completed"),
            "{body}"
        );
    }
}

#[tokio::test]
async fn issue44cc3af_429_waits_then_recovers_without_cooling_provider() {
    assert_rate_limit_wait(false, false, false, 1, LateRateLimitSession::None).await;
}

#[tokio::test]
async fn issue44cc3af_direct_429_waits_then_recovers_without_cooling_provider() {
    assert_rate_limit_wait(true, false, false, 1, LateRateLimitSession::None).await;
}

#[tokio::test]
async fn issue44cc3af_all_cooled_waits_for_probe_recovery() {
    assert_rate_limit_wait(false, true, false, 1, LateRateLimitSession::None).await;
}

#[tokio::test]
async fn issue44cc3af_initial_all_cooled_waits_for_active_probe() {
    assert_initial_all_cooled_active_probe(false, false).await;
}

#[tokio::test]
async fn issue44cc3af_direct_initial_all_cooled_waits_for_active_probe() {
    assert_initial_all_cooled_active_probe(true, false).await;
}

#[tokio::test]
async fn issue44cc3af_probe_success_wakes_long_pool_backoff_immediately() {
    assert_initial_all_cooled_active_probe(false, true).await;
}

#[tokio::test]
async fn issue44cc3af_direct_probe_success_wakes_long_pool_backoff_immediately() {
    assert_initial_all_cooled_active_probe(true, true).await;
}

#[tokio::test]
async fn issue44cc3af_429_with_cooled_peer_recovers_after_probe_continuation() {
    assert_429_with_cooled_peer(false).await;
}

#[tokio::test]
async fn issue44cc3af_direct_429_with_cooled_peer_recovers_after_probe_continuation() {
    assert_429_with_cooled_peer(true).await;
}

async fn assert_429_with_cooled_peer(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-429-cooled-continuation");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_url = format!("http://{}/v1", first.local_addr().unwrap());
    let second_url = format!("http://{}/v1", second.local_addr().unwrap());
    let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let a_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    let first_app = Router::new().fallback_service(post({
        let ready = ready.clone();
        let a_calls = a_calls.clone();
        move || {
            let ready = ready.clone();
            a_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = first_tx.send(());
            async move {
                if !ready.load(std::sync::atomic::Ordering::SeqCst) {
                    return (StatusCode::TOO_MANY_REQUESTS, axum::Json(json!({"status":429,"title":"Too Many Requests"}))).into_response();
                }
                let event = json!({"type":"response.completed","response":{"id":"rate-limit-recovered","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"rate limited candidate recovered after peer probe"}]}]}});
                Response::builder().header("content-type","text/event-stream")
                    .body(Body::from(format!("event: response.completed\ndata: {event}\n\n"))).unwrap()
            }
        }
    }));
    let b_business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let second_app = Router::new().fallback_service(post({
        let b_business = b_business.clone();
        move |axum::Json(body): axum::Json<Value>| {
            if body.to_string().contains("wait429 while peercooled") {
                b_business.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            async {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cooled peer remains unavailable",
                )
            }
        }
    }));
    let a_task = tokio::spawn(async move { axum::serve(first, first_app).await.unwrap() });
    let b_task = tokio::spawn(async move { axum::serve(second, second_app).await.unwrap() });
    let mode = if direct {
        V3EntryProtocolExecutionMode::Direct
    } else {
        V3EntryProtocolExecutionMode::Relay
    };
    let mut manifest = concurrency_switch_manifest_with_mode(&first_url, &second_url, mode);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let peer = format!("concurrency_second_{}", manifest.servers["a"].port);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let response = client.post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({"provider_id":peer,"auth_alias":"key","model_id":"test","kind":"probe","duration_ms":500}))
        .send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut request = tokio::spawn({
        let endpoint = format!("{base}/v1/responses");
        async move {
            let response = client.post(endpoint).json(&json!({"model":"client-test","input":"wait429 while peercooled","stream":true})).send().await?;
            response.text().await
        }
    });
    timeout(Duration::from_secs(2), first_rx.recv())
        .await
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    ready.store(true, std::sync::atomic::Ordering::SeqCst);
    let result = timeout(Duration::from_secs(5), &mut request).await;
    if result.is_err() {
        request.abort();
    }
    handle.shutdown().await;
    a_task.abort();
    b_task.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    let body = result
        .expect("backoff remains within declared budget")
        .unwrap()
        .expect("429 identity must remain recoverable across the cooled-peer probe phase");
    assert_responses_sse_delivered_business_text(
        &body,
        "rate limited candidate recovered after peer probe",
    );
    assert!(a_calls.load(std::sync::atomic::Ordering::SeqCst) >= 2);
    assert_eq!(b_business.load(std::sync::atomic::Ordering::SeqCst), 0);
}

async fn assert_initial_all_cooled_active_probe(direct: bool, long_wait: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-active-probe");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let business_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let probe_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (probe_tx, mut probes_started) = mpsc::unbounded_channel();
    let app = Router::new().fallback_service(post({
        let business_calls = business_calls.clone();
        let probe_calls = probe_calls.clone();
        let release = release.clone();
        move |axum::Json(body): axum::Json<Value>| {
            let business_calls = business_calls.clone();
            let probe_calls = probe_calls.clone();
            let release = release.clone();
            let probe_tx = probe_tx.clone();
            async move {
                if body.to_string().contains("business waits for active probe") {
                    business_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let event = json!({"type":"response.completed","response":{"id":"active-probe-recovered","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"active probe recovered"}]}]}});
                    Response::builder().header("content-type","text/event-stream")
                        .body(Body::from(format!("event: response.completed\ndata: {event}\n\n"))).unwrap()
                } else {
                    probe_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = probe_tx.send(());
                    let _permit = release.acquire().await.unwrap();
                    Response::builder().status(200).body(Body::from("probe ok")).unwrap()
                }
            }
        }
    }));
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mode = if direct {
        V3EntryProtocolExecutionMode::Direct
    } else {
        V3EntryProtocolExecutionMode::Relay
    };
    let mut manifest = concurrency_switch_manifest_with_mode(&url, &url, mode);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let provider_ids: Vec<_> = manifest.providers.keys().cloned().collect();
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    for provider_id in &provider_ids {
        let response = client.post(format!("{base}/_routecodex/health/cooldown-pool/add"))
            .json(&json!({"provider_id":provider_id,"auth_alias":"key","model_id":"test","kind":"probe","duration_ms":1}))
            .send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    for _ in &provider_ids {
        timeout(Duration::from_secs(10), probes_started.recv())
            .await
            .unwrap()
            .unwrap();
    }
    let pool: Value = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let active_probe_count = pool["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["state"] == "probing")
        .count();
    let mut request = tokio::spawn({
        let client = client.clone();
        let endpoint = format!("{base}/v1/responses");
        async move {
            let response = client.post(endpoint)
                .json(&json!({"model":"client-test","input":"business waits for active probe","stream":true}))
                .send().await?;
            response.text().await
        }
    });
    tokio::time::sleep(Duration::from_millis(if long_wait { 1200 } else { 200 })).await;
    let ended_before_recovery = request.is_finished();
    let business_before_recovery = business_calls.load(std::sync::atomic::Ordering::SeqCst);
    release.add_permits(8);
    let result = timeout(
        if long_wait {
            Duration::from_millis(600)
        } else {
            Duration::from_secs(5)
        },
        &mut request,
    )
    .await;
    if result.is_err() {
        request.abort();
    }
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert_eq!(
        active_probe_count,
        provider_ids.len(),
        "test must begin with externally held recovery probes"
    );
    assert!(
        !ended_before_recovery,
        "zero-attempt temporary exhaustion must wait for the active probe owner"
    );
    assert_eq!(business_before_recovery, 0);
    let body = result
        .expect("request recovers after probe success")
        .unwrap()
        .unwrap();
    assert_responses_sse_delivered_business_text(&body, "active probe recovered");
    assert_eq!(business_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        probe_calls.load(std::sync::atomic::Ordering::SeqCst),
        provider_ids.len(),
        "waiting requests must not duplicate probes owned by another task"
    );
}

#[tokio::test]
async fn issue44cc3af_other_session_success_preserves_429_provider_health() {
    assert_rate_limit_wait(false, false, true, 1, LateRateLimitSession::None).await;
}

#[tokio::test]
async fn issue44cc3af_concurrent_429_sessions_share_backoff_without_retry_storm() {
    assert_rate_limit_wait(false, false, false, 4, LateRateLimitSession::None).await;
}

#[tokio::test]
async fn issue44cc3af_new_session_obeys_existing_429_backoff() {
    assert_rate_limit_wait(false, false, false, 1, LateRateLimitSession::Complete).await;
}

#[tokio::test]
async fn issue44cc3af_direct_new_session_obeys_existing_429_backoff() {
    assert_rate_limit_wait(true, false, false, 1, LateRateLimitSession::Complete).await;
}

#[tokio::test]
async fn issue44cc3af_cancelled_rate_limit_wait_never_sends_later() {
    assert_rate_limit_wait(false, false, false, 1, LateRateLimitSession::Cancel).await;
}

enum LateRateLimitSession {
    None,
    Complete,
    Cancel,
}

async fn assert_rate_limit_wait(
    direct: bool,
    cooled: bool,
    parallel_success: bool,
    waiter_count: usize,
    late_session: LateRateLimitSession,
) {
    let late_join = !matches!(late_session, LateRateLimitSession::None);
    let cancel_late = matches!(late_session, LateRateLimitSession::Cancel);
    let failing_attempts = if parallel_success {
        1
    } else if cancel_late {
        2
    } else {
        3
    };
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-rate-wait");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let late_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let call_trace = Arc::new(std::sync::Mutex::new(Vec::new()));
    let fixture_started = std::time::Instant::now();
    let healthy_started = Arc::new(tokio::sync::Notify::new());
    let release_healthy = Arc::new(tokio::sync::Notify::new());
    let (hit_tx, mut hits) = mpsc::unbounded_channel();
    let app = Router::new().route("/v1/responses", post({
        let ready = ready.clone();
        let calls = calls.clone();
        let late_calls = late_calls.clone();
        let call_trace = call_trace.clone();
        let healthy_started = healthy_started.clone();
        let release_healthy = release_healthy.clone();
        move |axum::Json(body): axum::Json<Value>| {
            let ready = ready.clone();
            let calls = calls.clone();
            let late_calls = late_calls.clone();
            let call_trace = call_trace.clone();
            let hit_tx = hit_tx.clone();
            let healthy_started = healthy_started.clone();
            let release_healthy = release_healthy.clone();
            async move {
                call_trace.lock().unwrap().push((fixture_started.elapsed(), body.to_string().contains("ping; reply pong")));
                if body.to_string().contains("late session") {
                    late_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                if body.to_string().contains("healthy-session") {
                    healthy_started.notify_one();
                    release_healthy.notified().await;
                    return Response::builder().status(200).header("content-type", "text/event-stream")
                        .body(Body::from("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"parallel-success\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"healthy session completed\"}],\"output_text\":\"healthy session completed\"}}\n\ndata: [DONE]\n\n")).unwrap();
                }
                let attempt = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                let _ = hit_tx.send(());
                if attempt <= failing_attempts || !ready.load(std::sync::atomic::Ordering::SeqCst) {
                    return Response::builder().status(429)
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"error":{"type":"rate_limit_error","message":"capacity busy"}}"#)).unwrap();
                }
                Response::builder().status(200).header("content-type", "text/event-stream")
                    .body(Body::from("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"rate-recovered\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"recovered after wait\"}],\"output_text\":\"recovered after wait\"}}\n\ndata: [DONE]\n\n")).unwrap()
            }
        }
    }));
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let url = format!("http://{addr}/v1");
    std::env::set_var("V3_P6_TEST_KEY", "44cc3af-test-key");
    let mut manifest = concurrency_switch_manifest(&url, &url);
    for server in manifest.servers.values_mut() {
        server.http_sse_keepalive_ms = 50;
    }
    let first_id = format!("concurrency_first_{}", manifest.servers["a"].port);
    let second_id = format!("concurrency_second_{}", manifest.servers["a"].port);
    let pinned = if cooled {
        "client-test".to_string()
    } else {
        format!("{first_id}.test")
    };
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let healthy_request = if parallel_success {
        let endpoint = endpoint.clone();
        let pinned = pinned.clone();
        let task = tokio::spawn(async move {
            reqwest::Client::new()
                .post(endpoint)
                .header("session-id", "44cc3af-healthy-session")
                .json(&json!({"model":pinned,"input":"healthy-session","stream":true}))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        });
        timeout(Duration::from_secs(2), healthy_started.notified())
            .await
            .unwrap();
        Some(task)
    } else {
        None
    };
    if cooled {
        for provider_id in [&first_id, &second_id] {
            let response = reqwest::Client::new()
                .post(format!("http://{}/_routecodex/health/cooldown-pool/add", handle.listeners[0].addr))
                .json(&json!({"provider_id":provider_id,"auth_alias":"key","model_id":"test","kind":"probe","duration_ms":500}))
                .send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
    }
    let mut requests: Vec<_> = (0..waiter_count)
        .map(|index| {
            let endpoint = endpoint.clone();
            let pinned = pinned.clone();
            tokio::spawn(async move {
                let response = reqwest::Client::new()
                    .post(endpoint)
                    .header("session-id", format!("44cc3af-rate-limited-{index}"))
                    .json(&json!({"model":pinned,"input":"rate limited","stream":true}))
                    .send()
                    .await
                    .unwrap();
                (response.status(), response.text().await.unwrap())
            })
        })
        .collect();
    timeout(Duration::from_secs(2), hits.recv())
        .await
        .unwrap()
        .unwrap();
    if late_join {
        // Let A publish its received 429 before a fresh session arrives.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let endpoint = endpoint.clone();
        let pinned = pinned.clone();
        requests.push(tokio::spawn(async move {
            let response = reqwest::Client::new()
                .post(endpoint)
                .header("session-id", "44cc3af-late-session")
                .json(&json!({"model":pinned,"input":"late session","stream":true}))
                .send()
                .await
                .unwrap();
            (response.status(), response.text().await.unwrap())
        }));
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
    let closed_early = requests.iter().any(|request| request.is_finished());
    let early_calls = calls.load(std::sync::atomic::Ordering::SeqCst);
    let early_trace = call_trace.lock().unwrap().clone();
    if cancel_late {
        let late = requests.pop().unwrap();
        late.abort();
        let _ = late.await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    ready.store(true, std::sync::atomic::Ordering::SeqCst);
    release_healthy.notify_one();
    if let Some(healthy_request) = healthy_request {
        let body = timeout(Duration::from_secs(5), healthy_request)
            .await
            .unwrap()
            .unwrap();
        assert_responses_sse_delivered_business_text(&body, "healthy session completed");
    }
    let mut results = Vec::new();
    for request in requests {
        results.push(timeout(Duration::from_secs(30), request).await);
    }
    let health: Value = reqwest::Client::new()
        .get(format!(
            "http://{}/_routecodex/health/cooldown-pool",
            handle.listeners[0].addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert!(
        !closed_early,
        "429 must wait for capacity rather than terminate the client stream"
    );
    let max_early_calls = if late_join {
        2
    } else if cooled {
        3
    } else {
        waiter_count.max(2)
    };
    assert!(early_calls <= max_early_calls,
        "rate-limit wait must not hammer upstream: {early_calls}, fixture trace (elapsed, probe)={early_trace:?}");
    for result in results {
        let (_, body) = result
            .expect("rate-limit recovery deadline")
            .expect("intact client transport");
        assert_responses_sse_delivered_business_text(&body, "recovered after wait");
        if cooled {
            assert!(
                body.contains(": keepalive"),
                "cooled protocol planning must retain transport keepalives: {body}"
            );
        }
    }
    if !cooled {
        assert!(
            health["entries"].as_array().unwrap().is_empty(),
            "429 must not mark healthy providers cooled: {health}"
        );
    }
    if cancel_late {
        assert_eq!(
            late_calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "a fresh session may send its independent first attempt but cancellation must prevent later sends"
        );
    }
}

// ---------------------------------------------------------------------------
// Same-session request independence.
//
// These two public-entry cases cover one real client session that carries
// four complete provider identities: A/B answer the first business attempt
// with a real 503, C/D are healthy fallbacks, and A's recovery observation is
// held open by the fixture. B must still recover, serve business again, and
// the session's healthy aliases must still complete without releasing A.
// ---------------------------------------------------------------------------

const REQUEST_INDEPENDENCE_SESSION: &str = "44cc3af-independence-same-session";
const REQUEST_INDEPENDENCE_KEY: &str = "44cc3af-independence-key";
const REQUEST_INDEPENDENCE_SENTINEL_A: &str = "UPSTREAM-503-sentinel-A";
const REQUEST_INDEPENDENCE_SENTINEL_B: &str = "UPSTREAM-503-sentinel-B";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IndependencePeer {
    A,
    B,
    C,
    D,
}

impl IndependencePeer {
    fn name(self) -> &'static str {
        match self {
            IndependencePeer::A => "A",
            IndependencePeer::B => "B",
            IndependencePeer::C => "C",
            IndependencePeer::D => "D",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IndependencePeerMode {
    /// First business attempt is a real 503; every recovery probe is held open.
    FailFirstBusinessThenHoldProbes,
    /// First business attempt is a real 429; subsequent requests succeed.
    RateLimitFirstBusiness,
    /// First ten business attempts are real 503s; every recovery probe is held open.
    FailFirstTenBusinessThenHoldProbes,
    /// First ten business attempts are real 503s; recovery probes answer a real 2xx.
    FailFirstTenBusinessThenRecover,
    /// Healthy fallback that validates the bound identity and returns business.
    Healthy,
}

#[derive(Debug)]
struct IndependenceObservation {
    path: String,
    authorization: Option<String>,
    model: Option<String>,
    body: Value,
}

#[derive(Clone)]
struct IndependencePeerState {
    peer: IndependencePeer,
    mode: IndependencePeerMode,
    direct: bool,
    business_tx: mpsc::UnboundedSender<IndependenceObservation>,
    probe_tx: mpsc::UnboundedSender<IndependenceObservation>,
    business_calls: Arc<std::sync::atomic::AtomicUsize>,
    probe_calls: Arc<std::sync::atomic::AtomicUsize>,
    hold_probes: Arc<Semaphore>,
    holding_probe: Arc<std::sync::atomic::AtomicBool>,
}

fn independence_peer_success(peer: IndependencePeer, direct: bool, text: &str) -> Response<Body> {
    let body = if direct {
        json!({
            "id": format!("independence-{}", peer.name()),
            "object": "response",
            "status": "completed",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            }],
        })
    } else {
        json!({
            "id": format!("independence-{}", peer.name()),
            "object": "chat.completion",
            "model": "wire-test",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }],
        })
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn independence_peer_handler(
    State(state): State<Arc<IndependencePeerState>>,
    uri: Uri,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> Response<Body> {
    let text = body.to_string();
    let probe =
        text.contains("ping; reply pong") || text.contains("Reply exactly OK. Do not call tools.");
    let observation = IndependenceObservation {
        path: uri.path().to_string(),
        authorization: header_text(&headers, "authorization"),
        model: body.get("model").and_then(Value::as_str).map(str::to_owned),
        body: body.clone(),
    };
    if probe {
        state
            .probe_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let hold = matches!(
            state.mode,
            IndependencePeerMode::FailFirstBusinessThenHoldProbes
                | IndependencePeerMode::FailFirstTenBusinessThenHoldProbes
        );
        if hold {
            // Publish the arrival receipt and the "still held" state before
            // this task parks, so the test never guesses admission timing.
            state
                .holding_probe
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let _ = state.probe_tx.send(observation);
        if hold {
            let _permit = state.hold_probes.acquire().await.unwrap();
            state
                .holding_probe
                .store(false, std::sync::atomic::Ordering::SeqCst);
        }
        return Response::builder()
            .status(StatusCode::OK)
            .body(Body::from("probe ok"))
            .unwrap();
    }
    let attempt = state
        .business_calls
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let _ = state.business_tx.send(observation);
    let sentinel = match state.mode {
        IndependencePeerMode::FailFirstBusinessThenHoldProbes if attempt == 1 => Some((
            IndependencePeer::A,
            REQUEST_INDEPENDENCE_SENTINEL_A,
            StatusCode::SERVICE_UNAVAILABLE,
        )),
        IndependencePeerMode::RateLimitFirstBusiness if attempt == 1 => Some((
            IndependencePeer::A,
            REQUEST_INDEPENDENCE_SENTINEL_A,
            StatusCode::TOO_MANY_REQUESTS,
        )),
        IndependencePeerMode::FailFirstTenBusinessThenHoldProbes if attempt <= 10 => Some((
            IndependencePeer::A,
            REQUEST_INDEPENDENCE_SENTINEL_A,
            StatusCode::SERVICE_UNAVAILABLE,
        )),
        IndependencePeerMode::FailFirstTenBusinessThenRecover if attempt <= 10 => Some((
            IndependencePeer::B,
            REQUEST_INDEPENDENCE_SENTINEL_B,
            StatusCode::SERVICE_UNAVAILABLE,
        )),
        _ => None,
    };
    if let Some((peer, sentinel, status)) = sentinel {
        // A real provider HTTP error response, not a fabricated success.
        return Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"error":{{"type":"server_error","message":"{sentinel}-{}"}}}}"#,
                peer.name()
            )))
            .unwrap();
    }
    let text = match state.peer {
        IndependencePeer::A => "independence-A-business-recovered",
        IndependencePeer::B => "independence-B-business-recovered",
        IndependencePeer::C => "independence-C-business-ok",
        IndependencePeer::D => "independence-D-business-ok",
    };
    independence_peer_success(state.peer, state.direct, text)
}

struct IndependencePeerHandle {
    url: String,
    business: mpsc::UnboundedReceiver<IndependenceObservation>,
    probes: mpsc::UnboundedReceiver<IndependenceObservation>,
    business_calls: Arc<std::sync::atomic::AtomicUsize>,
    probe_calls: Arc<std::sync::atomic::AtomicUsize>,
    hold_probes: Arc<Semaphore>,
    holding_probe: Arc<std::sync::atomic::AtomicBool>,
    shutdown: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl IndependencePeerHandle {
    fn business_calls(&self) -> usize {
        self.business_calls
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn probe_calls(&self) -> usize {
        self.probe_calls.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn holding_probe(&self) -> bool {
        self.holding_probe.load(std::sync::atomic::Ordering::SeqCst)
    }
}

async fn start_independence_peer(
    peer: IndependencePeer,
    mode: IndependencePeerMode,
    direct: bool,
) -> IndependencePeerHandle {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (business_tx, business) = mpsc::unbounded_channel();
    let (probe_tx, probes) = mpsc::unbounded_channel();
    let (shutdown, shutdown_rx) = oneshot::channel();
    let business_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let probe_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let hold_probes = Arc::new(Semaphore::new(0));
    let holding_probe = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let state = Arc::new(IndependencePeerState {
        peer,
        mode,
        direct,
        business_tx,
        probe_tx,
        business_calls: business_calls.clone(),
        probe_calls: probe_calls.clone(),
        hold_probes: hold_probes.clone(),
        holding_probe: holding_probe.clone(),
    });
    let app = Router::new()
        .route("/v1/responses", post(independence_peer_handler))
        .route("/v1/chat/completions", post(independence_peer_handler))
        .with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    IndependencePeerHandle {
        url: format!("http://{address}/v1"),
        business,
        probes,
        business_calls,
        probe_calls,
        hold_probes,
        holding_probe,
        shutdown,
        task,
    }
}

struct RequestIndependenceRouting {
    manifest: routecodex_v3_config::V3Config05ManifestPublished,
    a: String,
    b: String,
}

fn request_independence_manifest(
    url_a: &str,
    url_b: &str,
    url_c: &str,
    url_d: &str,
    direct: bool,
) -> RequestIndependenceRouting {
    let port = free_port();
    let a = format!("independence_a_{port}");
    let b = format!("independence_b_{port}");
    let c = format!("independence_c_{port}");
    let d = format!("independence_d_{port}");
    let providers = [(&a, url_a), (&b, url_b), (&c, url_c), (&d, url_d)]
        .into_iter()
        .map(|(id, url)| {
            format!(
                r#"
[providers.{id}]
type = "responses"
base_url = "{url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_P6_TEST_KEY" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
concurrency = {{ max_in_flight = 4, acquire_timeout_ms = 60000, stale_lease_ms = 120000 }}
responses = {{ process = "chat", streaming = "always" }}
[providers.{id}.models.test]
wire_name = "wire-test"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
"#
            )
        })
        .collect::<String>();
    let source = format!(
        r#"
version = 3
{HUB_V1_TEST_DECLARATION}
[servers.a]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
[servers.b]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses"]
{HUB_V1_TEST_SERVER_EXECUTION}
{providers}
[route_groups.default.pools.alias_a]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["client-a"] }}
targets = [{{ kind = "provider_model", provider = "{a}", model = "test", key = "key", priority = 2 }}, {{ kind = "provider_model", provider = "{c}", model = "test", key = "key", priority = 1 }}]
[route_groups.default.pools.alias_b]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["client-b"] }}
targets = [{{ kind = "provider_model", provider = "{b}", model = "test", key = "key", priority = 2 }}, {{ kind = "provider_model", provider = "{d}", model = "test", key = "key", priority = 1 }}]
[route_groups.default.pools.thinking]
selection = {{ strategy = "priority" }}
match = {{ precedence = 2, required_capabilities = ["thinking"] }}
targets = [{{ kind = "provider_model", provider = "{a}", model = "test", key = "key", priority = 2 }}, {{ kind = "provider_model", provider = "{c}", model = "test", key = "key", priority = 1 }}]
[route_groups.default.pools.web_search]
selection = {{ strategy = "priority" }}
match = {{ precedence = 20, required_capabilities = ["web_search"] }}
targets = [{{ kind = "provider_model", provider = "{b}", model = "test", key = "key", priority = 2 }}, {{ kind = "provider_model", provider = "{d}", model = "test", key = "key", priority = 1 }}]
[route_groups.default.pools.pinned_a]
selection = {{ strategy = "priority" }}
match = {{ precedence = 30, models = ["{a}.test"] }}
targets = [{{ kind = "provider_model", provider = "{a}", model = "test", key = "key", priority = 1 }}]
[route_groups.default.pools.pinned_b]
selection = {{ strategy = "priority" }}
match = {{ precedence = 30, models = ["{b}.test"] }}
targets = [{{ kind = "provider_model", provider = "{b}", model = "test", key = "key", priority = 1 }}]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{c}", model = "test", key = "key", priority = 1 }}]
"#,
        free_port()
    );
    let mut manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    if direct {
        use_native_direct_responses(&mut manifest);
        for provider in manifest.providers.values() {
            assert_eq!(
                provider
                    .responses
                    .as_ref()
                    .expect("Direct requires a declared Responses interface")
                    .process,
                "direct",
                "Direct case requires provider Responses process=direct"
            );
            for interface in provider.interfaces.values() {
                assert_eq!(
                    interface
                        .responses
                        .as_ref()
                        .expect("Direct requires a compiled Responses interface")
                        .process,
                    "direct",
                    "Direct case requires interface Responses process=direct"
                );
            }
        }
    } else {
        let binding = manifest
            .hub_v1
            .as_mut()
            .expect("request independence fixture must declare hub_v1")
            .entry_protocol_bindings
            .iter_mut()
            .find(|binding| binding.entry_protocol == "responses")
            .expect("request independence fixture must declare the Responses binding");
        binding.execution_mode = V3EntryProtocolExecutionMode::Relay;
        binding.protocol_profile_owner = "v3.hub_relay_runtime_closeout".to_string();
        binding.forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.".to_string();
        binding.runtime_owner_symbol =
            Some("execute_v3_responses_relay_runtime_with_default_transport".to_string());
        binding.runtime_owner_path = Some(
            "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs".to_string(),
        );
        for provider in manifest.providers.values_mut() {
            provider.provider_type = "openai_chat".into();
            provider.responses = None;
            for interface in provider.interfaces.values_mut() {
                interface.provider_type = "openai_chat".into();
                interface.responses = None;
            }
        }
    }
    RequestIndependenceRouting { manifest, a, b }
}

fn spawn_independence_request(
    base: &str,
    model: &str,
    input: &str,
) -> tokio::task::JoinHandle<(StatusCode, String)> {
    let endpoint = format!("{base}/v1/responses");
    let model = model.to_string();
    let input = input.to_string();
    tokio::spawn(async move {
        let response = reqwest::Client::new()
            .post(endpoint)
            .header("session-id", REQUEST_INDEPENDENCE_SESSION)
            .header("thread-id", REQUEST_INDEPENDENCE_SESSION)
            .json(&json!({"model": model, "input": input, "stream": false}))
            .send()
            .await
            .unwrap();
        let status = response.status();
        (status, response.text().await.unwrap())
    })
}

fn expected_independence_authorization() -> String {
    format!("Bearer {REQUEST_INDEPENDENCE_KEY}")
}

async fn recv_independence_business(
    rx: &mut mpsc::UnboundedReceiver<IndependenceObservation>,
    label: &str,
    path: &str,
    marker: &str,
    within: Duration,
) -> IndependenceObservation {
    let observation = timeout(within, rx.recv())
        .await
        .unwrap_or_else(|_| panic!("{label}: no provider business capture within {within:?}"))
        .unwrap_or_else(|| panic!("{label}: provider business channel closed"));
    assert_eq!(observation.path, path, "{label}: provider wire path");
    assert_eq!(
        observation.authorization.as_deref(),
        Some(expected_independence_authorization().as_str()),
        "{label}: provider must receive the configured auth alias"
    );
    assert_eq!(
        observation.model.as_deref(),
        Some("wire-test"),
        "{label}: provider must receive the declared wire model"
    );
    assert!(
        observation.body.to_string().contains(marker),
        "{label}: provider body must carry the client request marker {marker}: {}",
        observation.body
    );
    observation
}

async fn recv_independence_probe(
    rx: &mut mpsc::UnboundedReceiver<IndependenceObservation>,
    label: &str,
    path: &str,
    within: Duration,
) -> IndependenceObservation {
    let observation = timeout(within, rx.recv())
        .await
        .unwrap_or_else(|_| panic!("{label}: no provider probe capture within {within:?}"))
        .unwrap_or_else(|| panic!("{label}: provider probe channel closed"));
    assert_eq!(observation.path, path, "{label}: provider wire path");
    assert_eq!(
        observation.authorization.as_deref(),
        Some(expected_independence_authorization().as_str()),
        "{label}: provider probe must use the configured auth alias"
    );
    let text = observation.body.to_string();
    assert!(
        text.contains("ping; reply pong") || text.contains("Reply exactly OK. Do not call tools."),
        "{label}: capture must be the runtime's own recovery probe: {}",
        observation.body
    );
    observation
}

fn assert_independence_client_success(status: StatusCode, body: &str, expected: &str) {
    assert_eq!(
        status,
        StatusCode::OK,
        "client must receive a successful business response: {body}"
    );
    assert!(
        body.contains(expected),
        "client must receive the matching healthy content {expected}: {body}"
    );
    for sentinel in [
        REQUEST_INDEPENDENCE_SENTINEL_A,
        REQUEST_INDEPENDENCE_SENTINEL_B,
    ] {
        assert!(
            !body.contains(sentinel),
            "provider {sentinel} must never reach the client: {body}"
        );
    }
    assert!(
        !body.contains("\"error\""),
        "client must never receive a provider or proxy error payload: {body}"
    );
}

#[tokio::test]
async fn request_independence_same_session_direct() {
    assert_request_independence_same_session(true).await;
}

#[tokio::test]
async fn request_independence_same_session_relay() {
    assert_request_independence_same_session(false).await;
}

#[tokio::test]
async fn request_independence_relay_routing_control() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-independence-relay-routing");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    std::env::set_var("V3_P6_TEST_KEY", REQUEST_INDEPENDENCE_KEY);
    let mut a =
        start_independence_peer(IndependencePeer::A, IndependencePeerMode::Healthy, false).await;
    let b =
        start_independence_peer(IndependencePeer::B, IndependencePeerMode::Healthy, false).await;
    let c =
        start_independence_peer(IndependencePeer::C, IndependencePeerMode::Healthy, false).await;
    let d =
        start_independence_peer(IndependencePeer::D, IndependencePeerMode::Healthy, false).await;
    let mut routing = request_independence_manifest(&a.url, &b.url, &c.url, &d.url, false);
    // Responses route classification selects the default pool for this plain
    // request; explicitly bind that actual pool to the intended A/C targets.
    let group = routing.manifest.route_groups.get_mut("default").unwrap();
    let targets = group.pools.get("alias_a").unwrap().targets.clone();
    group.pools.get_mut("default").unwrap().targets = targets;
    let handle = spawn_v3_server_aggregate(routing.manifest).await.unwrap();
    let base = format!(
        "http://{}",
        handle
            .listeners
            .iter()
            .find(|listener| listener.server_id == "a")
            .unwrap()
            .addr
    );
    let mut request = spawn_independence_request(&base, "client-a", "relay-routing-control");
    tokio::select! {
        observation = a.business.recv() => {
            let observation = observation.expect("upstream capture channel must stay open");
            assert_eq!(observation.path, "/v1/chat/completions");
            assert_eq!(observation.model.as_deref(), Some("wire-test"));
            assert_eq!(observation.authorization.as_deref(), Some(expected_independence_authorization().as_str()));
            assert!(observation.body.to_string().contains("relay-routing-control"));
        }
        response = &mut request => panic!("client finished before intended Relay upstream capture: {response:?}"),
        _ = sleep(Duration::from_secs(3)) => panic!("neither intended Relay upstream capture nor client completion occurred"),
    }
    let (status, body) = timeout(Duration::from_secs(5), request)
        .await
        .unwrap()
        .unwrap();
    assert_independence_client_success(status, &body, "independence-A-business-recovered");
    handle.shutdown().await;
    for peer in [a, b, c, d] {
        let _ = peer.shutdown.send(());
        let _ = peer.task.await;
    }
    std::env::remove_var("V3_P6_TEST_KEY");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(None);
}

#[tokio::test]
async fn request_independence_all_success_route_control_direct() {
    assert_request_independence_all_success_route_control(true).await;
}

#[tokio::test]
async fn request_independence_all_success_route_control_relay() {
    assert_request_independence_all_success_route_control(false).await;
}

async fn assert_request_independence_all_success_route_control(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new(if direct {
        "44cc3af-all-success-route-control-direct"
    } else {
        "44cc3af-all-success-route-control-relay"
    });
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    std::env::set_var("V3_P6_TEST_KEY", REQUEST_INDEPENDENCE_KEY);
    let mode = if direct { "Direct" } else { "Relay" };
    let wire_path = if direct {
        "/v1/responses"
    } else {
        "/v1/chat/completions"
    };
    let mut peer_a =
        start_independence_peer(IndependencePeer::A, IndependencePeerMode::Healthy, direct).await;
    let mut peer_b =
        start_independence_peer(IndependencePeer::B, IndependencePeerMode::Healthy, direct).await;
    let peer_c =
        start_independence_peer(IndependencePeer::C, IndependencePeerMode::Healthy, direct).await;
    let peer_d =
        start_independence_peer(IndependencePeer::D, IndependencePeerMode::Healthy, direct).await;
    let routing =
        request_independence_manifest(&peer_a.url, &peer_b.url, &peer_c.url, &peer_d.url, direct);
    let handle = spawn_v3_server_aggregate(routing.manifest).await.unwrap();
    let base = format!(
        "http://{}",
        handle
            .listeners
            .iter()
            .find(|listener| listener.server_id == "a")
            .expect("route control fixture must expose listener a")
            .addr
    );

    // The A route: plain current-turn user text is classified as `thinking`
    // and selects the declared A/C pool. The healthy A peer must receive the
    // first business attempt and complete the client request.
    let a_request = spawn_independence_request(&base, "client-a", "all-success-A-thinking-marker");
    let label = format!("{mode} all-success A route");
    recv_independence_business(
        &mut peer_a.business,
        &label,
        wire_path,
        "all-success-A-thinking-marker",
        Duration::from_secs(3),
    )
    .await;
    let (status, body) = timeout(Duration::from_secs(5), a_request)
        .await
        .expect("A route client must finish")
        .unwrap();
    assert_independence_client_success(status, &body, "independence-A-business-recovered");

    // The B route: current-turn web-search intent is classified as
    // `web_search` and selects the declared B/D pool. The healthy B peer must
    // receive the first business attempt and complete the client request.
    let b_request =
        spawn_independence_request(&base, "client-b", "web search all-success-B-marker");
    let label = format!("{mode} all-success B route");
    recv_independence_business(
        &mut peer_b.business,
        &label,
        wire_path,
        "all-success-B-marker",
        Duration::from_secs(3),
    )
    .await;
    let (status, body) = timeout(Duration::from_secs(5), b_request)
        .await
        .expect("B route client must finish")
        .unwrap();
    assert_independence_client_success(status, &body, "independence-B-business-recovered");

    // Each route must contact exactly its own primary provider; the healthy
    // fallbacks and the other route's providers stay untouched.
    assert_eq!(
        peer_a.business_calls(),
        1,
        "A route must dispatch exactly one business attempt to peer A"
    );
    assert_eq!(
        peer_b.business_calls(),
        1,
        "B route must dispatch exactly one business attempt to peer B"
    );
    assert_eq!(
        peer_c.business_calls(),
        0,
        "A route must not fall back to healthy C while A is healthy"
    );
    assert_eq!(
        peer_d.business_calls(),
        0,
        "B route must not fall back to healthy D while B is healthy"
    );

    handle.shutdown().await;
    for peer in [peer_a, peer_b, peer_c, peer_d] {
        let _ = peer.shutdown.send(());
        let _ = peer.task.await;
    }
    std::env::remove_var("V3_P6_TEST_KEY");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(None);
}

#[tokio::test]
async fn issue44cc3af_error_hold_does_not_block_same_identity_direct() {
    assert_error_hold_does_not_block_same_identity(true, false).await;
}

#[tokio::test]
async fn issue44cc3af_error_hold_does_not_block_same_identity_relay() {
    assert_error_hold_does_not_block_same_identity(false, false).await;
}

#[tokio::test]
async fn issue44cc3af_429_hold_does_not_block_same_identity_direct() {
    assert_error_hold_does_not_block_same_identity(true, true).await;
}

#[tokio::test]
async fn issue44cc3af_429_hold_does_not_block_same_identity_relay() {
    assert_error_hold_does_not_block_same_identity(false, true).await;
}

async fn assert_error_hold_does_not_block_same_identity(direct: bool, rate_limit: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-error-hold-isolation");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    std::env::set_var("V3_P6_TEST_KEY", REQUEST_INDEPENDENCE_KEY);
    let wire = if direct {
        "/v1/responses"
    } else {
        "/v1/chat/completions"
    };
    let mode = if rate_limit {
        IndependencePeerMode::RateLimitFirstBusiness
    } else {
        IndependencePeerMode::FailFirstBusinessThenHoldProbes
    };
    let mut a = start_independence_peer(IndependencePeer::A, mode, direct).await;
    let b =
        start_independence_peer(IndependencePeer::B, IndependencePeerMode::Healthy, direct).await;
    let mut c =
        start_independence_peer(IndependencePeer::C, IndependencePeerMode::Healthy, direct).await;
    let d =
        start_independence_peer(IndependencePeer::D, IndependencePeerMode::Healthy, direct).await;
    let mut routing = request_independence_manifest(&a.url, &b.url, &c.url, &d.url, direct);
    let group = routing.manifest.route_groups.get_mut("default").unwrap();
    let targets = group.pools.get("alias_a").unwrap().targets.clone();
    group.pools.get_mut("default").unwrap().targets = targets;
    let handle = spawn_v3_server_aggregate(routing.manifest).await.unwrap();
    let base = format!(
        "http://{}",
        handle
            .listeners
            .iter()
            .find(|listener| listener.server_id == "a")
            .unwrap()
            .addr
    );

    let first = spawn_independence_request(&base, "client-a", "hold-isolation-first");
    recv_independence_business(
        &mut a.business,
        "first request before upstream error",
        wire,
        "hold-isolation-first",
        Duration::from_secs(3),
    )
    .await;
    let second = spawn_independence_request(&base, "client-a", "hold-isolation-second");
    recv_independence_business(
        &mut a.business,
        "independent request during error hold",
        wire,
        "hold-isolation-second",
        Duration::from_millis(1500),
    )
    .await;
    let (status, body) = timeout(Duration::from_millis(1500), second)
        .await
        .expect("same-identity request must complete while peer error is held")
        .unwrap();
    assert_independence_client_success(status, &body, "independence-A-business-recovered");
    recv_independence_business(
        &mut c.business,
        "first request fallback",
        wire,
        "hold-isolation-first",
        Duration::from_secs(8),
    )
    .await;
    let (status, body) = timeout(Duration::from_secs(8), first)
        .await
        .unwrap()
        .unwrap();
    assert_independence_client_success(status, &body, "independence-C-business-ok");

    a.hold_probes.add_permits(8);
    handle.shutdown().await;
    for peer in [a, b, c, d] {
        let _ = peer.shutdown.send(());
        let _ = peer.task.await;
    }
    std::env::remove_var("V3_P6_TEST_KEY");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(None);
}

async fn assert_request_independence_same_session(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new(if direct {
        "44cc3af-request-independence-direct"
    } else {
        "44cc3af-request-independence-relay"
    });
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    std::env::set_var("V3_P6_TEST_KEY", REQUEST_INDEPENDENCE_KEY);
    let mode = if direct { "Direct" } else { "Relay" };
    let wire_path = if direct {
        "/v1/responses"
    } else {
        "/v1/chat/completions"
    };
    let mut peer_a = start_independence_peer(
        IndependencePeer::A,
        IndependencePeerMode::FailFirstTenBusinessThenHoldProbes,
        direct,
    )
    .await;
    let mut peer_b = start_independence_peer(
        IndependencePeer::B,
        IndependencePeerMode::FailFirstTenBusinessThenRecover,
        direct,
    )
    .await;
    let mut peer_c =
        start_independence_peer(IndependencePeer::C, IndependencePeerMode::Healthy, direct).await;
    let mut peer_d =
        start_independence_peer(IndependencePeer::D, IndependencePeerMode::Healthy, direct).await;
    let routing =
        request_independence_manifest(&peer_a.url, &peer_b.url, &peer_c.url, &peer_d.url, direct);
    let pinned_a = format!("{}.test", routing.a);
    let pinned_b = format!("{}.test", routing.b);
    let handle = spawn_v3_server_aggregate(routing.manifest).await.unwrap();
    let base = format!(
        "http://{}",
        handle
            .listeners
            .iter()
            .find(|listener| listener.server_id == "a")
            .expect("request independence fixture must expose listener a")
            .addr
    );

    // A identity: nine real consecutive failures must not globally cool A.
    for attempt in 1..=9_u32 {
        let marker = format!("independence-A-business-{attempt}");
        let a_req = spawn_independence_request(&base, "client-a", &marker);
        let label = format!("{mode} peer A business {attempt}");
        recv_independence_business(
            &mut peer_a.business,
            &label,
            wire_path,
            &marker,
            Duration::from_secs(3),
        )
        .await;
        let label = format!("{mode} healthy C fallback for A {attempt}");
        recv_independence_business(
            &mut peer_c.business,
            &label,
            wire_path,
            &marker,
            Duration::from_secs(3),
        )
        .await;
        let (status, body) = timeout(Duration::from_secs(5), a_req)
            .await
            .expect("A's healthy fallback must finish each of the first nine failures")
            .unwrap();
        assert_independence_client_success(status, &body, "independence-C-business-ok");
    }
    assert_eq!(
        peer_a.business_calls(),
        9,
        "the first nine consecutive real failures must all dispatch to peer A"
    );
    assert_eq!(
        peer_c.business_calls(),
        9,
        "the first nine real A failures must all fall back to healthy C"
    );
    assert_eq!(
        peer_a.probe_calls(),
        0,
        "nine real failures must not yet schedule A's recovery probe"
    );
    assert!(
        !peer_a.holding_probe(),
        "nine real failures must not put A's probe into the held state"
    );

    // A identity: the tenth real failure triggers the exact-identity global
    // cooldown, and the runtime's own recovery probe reaches A.
    let a_tenth = spawn_independence_request(&base, "client-a", "independence-A-business-10");
    let label = format!("{mode} peer A tenth business");
    recv_independence_business(
        &mut peer_a.business,
        &label,
        wire_path,
        "independence-A-business-10",
        Duration::from_secs(3),
    )
    .await;
    let label = format!("{mode} healthy C fallback for A tenth");
    recv_independence_business(
        &mut peer_c.business,
        &label,
        wire_path,
        "independence-A-business-10",
        Duration::from_secs(3),
    )
    .await;
    let (status, body) = timeout(Duration::from_secs(5), a_tenth)
        .await
        .expect("A's tenth failure must fall back to healthy C")
        .unwrap();
    assert_independence_client_success(status, &body, "independence-C-business-ok");
    assert_eq!(
        peer_a.business_calls(),
        10,
        "the tenth real failure must dispatch to peer A once"
    );
    let label = format!("{mode} peer A recovery probe");
    recv_independence_probe(
        &mut peer_a.probes,
        &label,
        wire_path,
        Duration::from_secs(6),
    )
    .await;
    assert!(
        peer_a.holding_probe(),
        "A's real recovery probe must stay parked after the tenth failure"
    );

    // A is now cooled. A same-session request completes through healthy C and
    // must not dispatch another business attempt to the observing identity.
    let a_healthy =
        spawn_independence_request(&base, "client-a", "independence-A-healthy-alternative");
    let label = format!("{mode} healthy C alternative while A is held");
    recv_independence_business(
        &mut peer_c.business,
        &label,
        wire_path,
        "independence-A-healthy-alternative",
        Duration::from_secs(3),
    )
    .await;
    let (status, body) = timeout(Duration::from_secs(5), a_healthy)
        .await
        .expect("healthy same-session alternative must not wait for peer A")
        .unwrap();
    assert_independence_client_success(status, &body, "independence-C-business-ok");
    assert_eq!(
        peer_a.business_calls(),
        10,
        "peer A must receive no further business attempt after its tenth failure"
    );
    assert!(
        peer_a.holding_probe(),
        "healthy alternatives must not release A's held recovery probe"
    );

    // B identity: nine real consecutive failures must not globally cool B.
    for attempt in 1..=9_u32 {
        let marker = format!("web search independence-B-business-{attempt}");
        let b_req = spawn_independence_request(&base, "client-b", &marker);
        let label = format!("{mode} peer B business {attempt}");
        recv_independence_business(
            &mut peer_b.business,
            &label,
            wire_path,
            &marker,
            Duration::from_secs(3),
        )
        .await;
        let label = format!("{mode} healthy D fallback for B {attempt}");
        recv_independence_business(
            &mut peer_d.business,
            &label,
            wire_path,
            &marker,
            Duration::from_secs(3),
        )
        .await;
        let (status, body) = timeout(Duration::from_secs(5), b_req)
            .await
            .expect("B's healthy fallback must finish each of the first nine failures")
            .unwrap();
        assert_independence_client_success(status, &body, "independence-D-business-ok");
    }
    assert_eq!(
        peer_b.business_calls(),
        9,
        "the first nine consecutive real failures must all dispatch to peer B"
    );
    assert_eq!(
        peer_d.business_calls(),
        9,
        "the first nine real B failures must all fall back to healthy D"
    );
    assert_eq!(
        peer_b.probe_calls(),
        0,
        "nine real failures must not yet schedule B's recovery probe"
    );
    assert!(
        !peer_b.holding_probe(),
        "B's recovery probe must not be held while A is independently held"
    );
    assert!(
        peer_a.holding_probe(),
        "B's nine real failures must not unlock A's held probe"
    );

    // B identity: the tenth real failure triggers B's global cooldown, and
    // B's real probe answers 2xx so B recovers without touching A.
    let b_tenth =
        spawn_independence_request(&base, "client-b", "web search independence-B-business-10");
    let label = format!("{mode} peer B tenth business");
    recv_independence_business(
        &mut peer_b.business,
        &label,
        wire_path,
        "web search independence-B-business-10",
        Duration::from_secs(3),
    )
    .await;
    let label = format!("{mode} healthy D fallback for B tenth");
    recv_independence_business(
        &mut peer_d.business,
        &label,
        wire_path,
        "web search independence-B-business-10",
        Duration::from_secs(3),
    )
    .await;
    let (status, body) = timeout(Duration::from_secs(5), b_tenth)
        .await
        .expect("B's tenth failure must fall back to healthy D")
        .unwrap();
    assert_independence_client_success(status, &body, "independence-D-business-ok");
    assert_eq!(
        peer_b.business_calls(),
        10,
        "the tenth real failure must dispatch to peer B once"
    );
    let label = format!("{mode} peer B recovery probe");
    recv_independence_probe(
        &mut peer_b.probes,
        &label,
        wire_path,
        Duration::from_secs(6),
    )
    .await;

    // B's business after its own 2xx probe must not depend on A.
    let b_recovered =
        spawn_independence_request(&base, &pinned_b, "independence-B-business-after-recovery");
    let label = format!("{mode} peer B recovered business");
    recv_independence_business(
        &mut peer_b.business,
        &label,
        wire_path,
        "independence-B-business-after-recovery",
        Duration::from_secs(8),
    )
    .await;
    let (status, body) = timeout(Duration::from_secs(10), b_recovered)
        .await
        .expect("B's own recovery must finish without releasing A")
        .unwrap();
    assert_independence_client_success(status, &body, "independence-B-business-recovered");
    assert_eq!(
        peer_d.business_calls(),
        10,
        "B must serve recovered business itself instead of falling back to D"
    );
    assert!(
        peer_a.holding_probe(),
        "B's recovery and business must not release A's held observation"
    );

    // A pinned request waits on A's real held observation. Cancel it and prove
    // B plus the healthy same-session aliases still continue.
    let a_waiting = spawn_independence_request(&base, &pinned_a, "independence-A-waiting-request");
    sleep(Duration::from_millis(300)).await;
    assert!(
        !a_waiting.is_finished(),
        "a pinned request must wait on the real held observation instead of terminating"
    );
    assert_eq!(
        peer_a.business_calls(),
        10,
        "a waiting request must never dispatch business to the observing identity"
    );
    a_waiting.abort();
    let _ = a_waiting.await;

    let b_after_cancel =
        spawn_independence_request(&base, &pinned_b, "independence-B-business-after-A-cancel");
    let label = format!("{mode} peer B business after A cancellation");
    recv_independence_business(
        &mut peer_b.business,
        &label,
        wire_path,
        "independence-B-business-after-A-cancel",
        Duration::from_secs(5),
    )
    .await;
    let (status, body) = timeout(Duration::from_secs(5), b_after_cancel)
        .await
        .expect("B must continue after A's waiting request is cancelled")
        .unwrap();
    assert_independence_client_success(status, &body, "independence-B-business-recovered");

    let c_after_cancel =
        spawn_independence_request(&base, "client-a", "independence-A-healthy-after-cancel");
    let label = format!("{mode} healthy C alternative after A cancellation");
    recv_independence_business(
        &mut peer_c.business,
        &label,
        wire_path,
        "independence-A-healthy-after-cancel",
        Duration::from_secs(5),
    )
    .await;
    let (status, body) = timeout(Duration::from_secs(5), c_after_cancel)
        .await
        .expect("healthy same-session concurrency must continue after A cancellation")
        .unwrap();
    assert_independence_client_success(status, &body, "independence-C-business-ok");

    // Cancelling one owner must not cancel the shared health observation: a
    // fresh pinned A request still waits on the same held probe.
    let a_still_observing =
        spawn_independence_request(&base, &pinned_a, "independence-A-still-observing");
    sleep(Duration::from_millis(300)).await;
    assert!(
        !a_still_observing.is_finished(),
        "A's recovery observation must outlive the cancelled waiting request"
    );
    a_still_observing.abort();
    let _ = a_still_observing.await;

    // Actual provider dispatch counts, from the controlled peers themselves.
    assert_eq!(
        peer_a.business_calls(),
        10,
        "peer A must dispatch exactly ten failed business attempts"
    );
    assert!(
        peer_a.probe_calls() >= 1,
        "peer A must receive the runtime's own recovery probe"
    );
    assert_eq!(
        peer_b.business_calls(),
        12,
        "peer B must dispatch ten 503s plus two recovered businesses"
    );
    assert!(
        peer_b.probe_calls() >= 1,
        "peer B must receive the runtime's own recovery probe"
    );
    assert_eq!(
        peer_c.business_calls(),
        12,
        "healthy C must serve A's ten fallbacks plus both same-session alternatives"
    );
    assert_eq!(
        peer_d.business_calls(),
        10,
        "healthy D must serve only B's ten fallbacks"
    );
    assert!(
        peer_a.business.try_recv().is_err(),
        "no unexpected peer A business capture may remain"
    );
    assert!(
        peer_b.business.try_recv().is_err(),
        "no unexpected peer B business capture may remain"
    );
    assert!(
        peer_c.business.try_recv().is_err(),
        "no unexpected peer C business capture may remain"
    );
    assert!(
        peer_d.business.try_recv().is_err(),
        "no unexpected peer D business capture may remain"
    );
    assert!(
        peer_a.holding_probe(),
        "A's actual recovery probe must still be the runtime's in-flight observation"
    );

    peer_a.hold_probes.add_permits(8);
    handle.shutdown().await;
    for peer in [peer_a, peer_b, peer_c, peer_d] {
        let _ = peer.shutdown.send(());
        peer.task.abort();
    }
    std::env::remove_var("V3_P6_TEST_KEY");
}

// ---------------------------------------------------------------------------
// Mixed candidate pool: a healthy but window-inactive candidate must not hide
// the cooled candidate's real recovery opportunity.
//
// A is selectable and healthy; it answers the first business attempt with a
// complete response that carries no deliverable business content (an empty
// SSE terminal), which is a recoverable response-processing failure. B is the
// only request-compatible candidate left and is driven into a real, probe-owned
// cooldown through the public cooldown-pool control entry. C is healthy but its
// declared availability window does not cover this request, so selection skips
// it while it stays in the captured candidate set. The original request must
// keep waiting for B's real probe and then serve B's real business result; C
// must never be dispatched and the client must never receive a provider/proxy
// error or a fabricated empty success.
// ---------------------------------------------------------------------------

fn mixed_pool_empty_sse() -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from("data: [DONE]\n\n"))
        .unwrap()
}

fn mixed_pool_chat_success(text: &str) -> Response<Body> {
    mixed_pool_chat_success_with_model("wire-test", text)
}

fn mixed_pool_chat_success_with_model(model: &str, text: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "mixed-pool-success",
                "object": "chat.completion",
                "model": model,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop"
                }]
            })
            .to_string(),
        ))
        .unwrap()
}

fn mixed_pool_is_probe(body: &Value) -> bool {
    body.get("messages")
        .and_then(Value::as_array)
        .and_then(|messages| messages.first())
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        == Some("ping; reply pong")
}

fn mixed_pool_responses_is_probe(body: &Value) -> bool {
    body.get("input")
        .and_then(Value::as_array)
        .and_then(|input| input.first())
        .and_then(|item| item.get("content"))
        .and_then(Value::as_array)
        .and_then(|content| content.first())
        .and_then(|block| block.get("text"))
        .and_then(Value::as_str)
        == Some("ping; reply pong")
}

fn mixed_pool_responses_success(text: &str) -> Response<Body> {
    mixed_pool_responses_success_with_model("wire-test", text)
}

fn mixed_pool_responses_success_with_model(model: &str, text: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "mixed-pool-responses-success",
                "object": "response",
                "model": model,
                "status": "completed",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": text}],
                }],
            })
            .to_string(),
        ))
        .unwrap()
}

fn mixed_pool_responses_empty() -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "mixed-pool-responses-empty",
                "object": "response",
                "model": "wire-test",
                "status": "completed",
                "output": [],
            })
            .to_string(),
        ))
        .unwrap()
}

struct MixedPoolManifest {
    manifest: routecodex_v3_config::V3Config05ManifestPublished,
    first: String,
    second: String,
    third: String,
    side: String,
}

fn mixed_pool_manifest(
    first_url: &str,
    second_url: &str,
    third_url: &str,
    side_url: &str,
    responses_process: &str,
) -> MixedPoolManifest {
    let port = free_port();
    let first = format!("mixed_first_{port}");
    let second = format!("mixed_second_{port}");
    let third = format!("mixed_third_{port}");
    let side = format!("mixed_side_{port}");
    let providers = [
        (&first, first_url),
        (&second, second_url),
        (&third, third_url),
    ]
    .into_iter()
    .map(|(id, url)| {
        format!(
            r#"
[providers.{id}]
type = "responses"
base_url = "{url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_P6_TEST_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "{responses_process}", streaming = "always" }}
[providers.{id}.models.test]
wire_name = "wire-test"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
"#
        )
    })
    .collect::<String>();
    let source = format!(
        r#"
version = 3
{HUB_V1_TEST_DECLARATION}
[servers.a]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
[servers.a.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
{providers}
[providers.{side}]
type = "responses"
base_url = "{side_url}"
default_model = "side"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_P6_TEST_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "{responses_process}", streaming = "always" }}
[providers.{side}.models.side]
wire_name = "wire-side"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[forwarders.mixed]
model = "client-test"
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "{first}", model = "test", key = "key", priority = 3 }},
  {{ kind = "provider_model", provider = "{second}", model = "test", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "{third}", model = "test", key = "key", priority = 1 }}
]
[route_groups.default.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["client-test"] }}
targets = [{{ kind = "forwarder", id = "mixed", priority = 1 }}]
[route_groups.default.pools.independent]
selection = {{ strategy = "priority" }}
match = {{ precedence = 30, models = ["independent-model"] }}
targets = [{{ kind = "provider_model", provider = "{side}", model = "side", key = "key", priority = 1 }}]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "mixed", priority = 1 }}]
"#
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    MixedPoolManifest {
        manifest,
        first,
        second,
        third,
        side,
    }
}

fn apply_mixed_pool_mode(
    manifest: &mut routecodex_v3_config::V3Config05ManifestPublished,
    direct: bool,
) {
    for provider in manifest.providers.values_mut() {
        provider.provider_type = "openai_chat".into();
        provider.responses = None;
        for interface in provider.interfaces.values_mut() {
            interface.provider_type = "openai_chat".into();
            interface.responses = None;
        }
    }
    if direct {
        for server in manifest.servers.values_mut() {
            server.endpoints = vec!["openai_chat".to_string()];
        }
    } else {
        let binding = manifest
            .hub_v1
            .as_mut()
            .expect("mixed pool fixture must declare hub_v1")
            .entry_protocol_bindings
            .iter_mut()
            .find(|binding| binding.entry_protocol == "responses")
            .expect("mixed pool fixture must declare the Responses binding");
        binding.execution_mode = V3EntryProtocolExecutionMode::Relay;
        binding.protocol_profile_owner = "v3.hub_relay_runtime_closeout".to_string();
        binding.forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.".to_string();
        binding.runtime_owner_symbol =
            Some("execute_v3_responses_relay_runtime_with_default_transport".to_string());
        binding.runtime_owner_path = Some(
            "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs".to_string(),
        );
    }
}

#[derive(Clone, Copy)]
enum MixedPoolWireMode {
    Chat,
    Responses,
}

struct MixedPoolPeerSet {
    b_url: String,
    b_wire: Arc<std::sync::Mutex<Vec<Value>>>,
    b_business: Arc<std::sync::atomic::AtomicUsize>,
    b_ready: Arc<std::sync::atomic::AtomicBool>,
    b_probe_release: Arc<Semaphore>,
    b_probe_rx: mpsc::UnboundedReceiver<()>,
    b_task: tokio::task::JoinHandle<()>,
    c_url: String,
    c_business: Arc<std::sync::atomic::AtomicUsize>,
    c_task: tokio::task::JoinHandle<()>,
    d_url: String,
    d_task: tokio::task::JoinHandle<()>,
}

struct MixedPoolServerRig {
    handle: routecodex_v3_server::V3ServerAggregateHandle,
    base: String,
    entry_endpoint: String,
    endpoint: String,
    first: String,
    second: String,
    third: String,
    side: String,
}

async fn spawn_mixed_pool_peers(mode: MixedPoolWireMode) -> MixedPoolPeerSet {
    let route_path = match mode {
        MixedPoolWireMode::Chat => "/v1/chat/completions",
        MixedPoolWireMode::Responses => "/v1/responses",
    };
    // B: cooled through the public control entry. Business stays unavailable
    // until the test releases B's real recovery probe from its upstream barrier.
    let b_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let b_url = format!("http://{}/v1", b_listener.local_addr().unwrap());
    let b_wire = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let b_business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let b_ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let b_probe_release = Arc::new(Semaphore::new(0));
    let (b_probe_tx, b_probe_rx) = mpsc::unbounded_channel::<()>();
    let b_app = Router::new().route(
        route_path,
        post({
            let b_wire = b_wire.clone();
            let b_business = b_business.clone();
            let b_ready = b_ready.clone();
            let b_probe_release = b_probe_release.clone();
            let b_probe_tx = b_probe_tx.clone();
            move |axum::Json(body): axum::Json<Value>| {
                let b_wire = b_wire.clone();
                let b_business = b_business.clone();
                let b_ready = b_ready.clone();
                let b_probe_release = b_probe_release.clone();
                let b_probe_tx = b_probe_tx.clone();
                async move {
                    b_wire.lock().unwrap().push(body.clone());
                    let is_probe = match mode {
                        MixedPoolWireMode::Chat => mixed_pool_is_probe(&body),
                        MixedPoolWireMode::Responses => mixed_pool_responses_is_probe(&body),
                    };
                    if is_probe {
                        let _ = b_probe_tx.send(());
                        let _permit = b_probe_release.acquire_owned().await.unwrap();
                        return Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/json")
                            .body(Body::from(r#"{"probe":"qualified"}"#))
                            .unwrap();
                    }
                    b_business.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if b_ready.load(std::sync::atomic::Ordering::SeqCst) {
                        match mode {
                            MixedPoolWireMode::Chat => {
                                mixed_pool_chat_success("cooled mixed peer recovered")
                            }
                            MixedPoolWireMode::Responses => {
                                mixed_pool_responses_success("cooled mixed peer recovered")
                            }
                        }
                    } else {
                        (StatusCode::SERVICE_UNAVAILABLE, "peer still cooled").into_response()
                    }
                }
            }
        }),
    );
    let b_task = tokio::spawn(async move { axum::serve(b_listener, b_app).await.unwrap() });

    // C: healthy but outside its declared availability window. It stays in the
    // captured candidate set yet must never be dispatched.
    let c_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let c_url = format!("http://{}/v1", c_listener.local_addr().unwrap());
    let c_business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c_app = Router::new().route(
        route_path,
        post({
            let c_business = c_business.clone();
            move || {
                let c_business = c_business.clone();
                async move {
                    c_business.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    match mode {
                        MixedPoolWireMode::Chat => mixed_pool_chat_success(
                            "availability-inactive candidate must never answer",
                        ),
                        MixedPoolWireMode::Responses => mixed_pool_responses_success(
                            "availability-inactive candidate must never answer",
                        ),
                    }
                }
            }
        }),
    );
    let c_task = tokio::spawn(async move { axum::serve(c_listener, c_app).await.unwrap() });

    // D: independent healthy route, used to prove the server keeps making
    // progress while the original request waits for B.
    let d_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let d_url = format!("http://{}/v1", d_listener.local_addr().unwrap());
    let d_app = Router::new().route(
        route_path,
        post(move || async move {
            match mode {
                MixedPoolWireMode::Chat => mixed_pool_chat_success_with_model(
                    "wire-side",
                    "independent mixed route advanced",
                ),
                MixedPoolWireMode::Responses => mixed_pool_responses_success_with_model(
                    "wire-side",
                    "independent mixed route advanced",
                ),
            }
        }),
    );
    let d_task = tokio::spawn(async move { axum::serve(d_listener, d_app).await.unwrap() });

    MixedPoolPeerSet {
        b_url,
        b_wire,
        b_business,
        b_ready,
        b_probe_release,
        b_probe_rx,
        b_task,
        c_url,
        c_business,
        c_task,
        d_url,
        d_task,
    }
}

fn apply_mixed_pool_third_availability(
    manifest: &mut routecodex_v3_config::V3Config05ManifestPublished,
    third: &str,
) {
    // C is healthy but its declared window only covers a later minute, so it is
    // not admitted for this request. Availability is declared truth, not a
    // fabricated internal state.
    let minute = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        / 60)
        % 1440;
    let format_minute = |minute: u64| format!("{:02}:{:02}", minute / 60, minute % 60);
    let availability = routecodex_v3_config::V3ProviderModelAvailabilityAuthoringConfig {
        timezone: "UTC".into(),
        guard_minutes: 0,
        periods: vec![routecodex_v3_config::V3DailyTimeWindowAuthoringConfig {
            start: format_minute((minute + 3) % 1440),
            end: format_minute((minute + 4) % 1440),
        }],
    };
    manifest
        .providers
        .get_mut(third)
        .unwrap()
        .models
        .get_mut("test")
        .unwrap()
        .availability = Some(availability);
}

fn apply_mixed_pool_debug_log(
    manifest: &mut routecodex_v3_config::V3Config05ManifestPublished,
    debug_log: Option<&std::path::Path>,
) {
    if let Some(path) = debug_log {
        manifest.debug.log_console = true;
        manifest.debug.snapshots = true;
        manifest.debug.codex_samples = true;
        manifest.debug.full_codex_sampling = true;
        manifest.debug.log_file = Some(path.display().to_string());
    }
}

async fn spawn_mixed_pool_manifest_server(
    direct: bool,
    a_url: &str,
    b_url: &str,
    c_url: &str,
    d_url: &str,
    debug_log: Option<&std::path::Path>,
) -> MixedPoolServerRig {
    let MixedPoolManifest {
        mut manifest,
        first,
        second,
        third,
        side,
    } = mixed_pool_manifest(a_url, b_url, c_url, d_url, "chat");
    apply_mixed_pool_mode(&mut manifest, direct);
    apply_mixed_pool_third_availability(&mut manifest, &third);
    apply_mixed_pool_debug_log(&mut manifest, debug_log);

    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let entry_endpoint = if direct {
        "/v1/chat/completions".to_string()
    } else {
        "/v1/responses".to_string()
    };
    let endpoint = format!("{base}{entry_endpoint}");
    MixedPoolServerRig {
        handle,
        base,
        entry_endpoint,
        endpoint,
        first,
        second,
        third,
        side,
    }
}

async fn spawn_mixed_pool_responses_direct_server(
    a_url: &str,
    b_url: &str,
    c_url: &str,
    d_url: &str,
    debug_log: Option<&std::path::Path>,
) -> MixedPoolServerRig {
    let MixedPoolManifest {
        mut manifest,
        first,
        second,
        third,
        side,
    } = mixed_pool_manifest(a_url, b_url, c_url, d_url, "direct");

    // The contract requires both the provider authoring entry and every
    // interface to declare responses process=direct. Assert the compiled truth
    // before the server starts, so this case cannot silently become Chat Relay.
    for provider in manifest.providers.values() {
        assert_eq!(
            provider
                .responses
                .as_ref()
                .map(|responses| responses.process.as_str()),
            Some("direct"),
            "provider {} must explicitly declare responses process=direct",
            provider.id
        );
        assert!(
            !provider.interfaces.is_empty(),
            "provider {} must expose at least one compiled interface",
            provider.id
        );
        for interface in provider.interfaces.values() {
            assert_eq!(
                interface
                    .responses
                    .as_ref()
                    .map(|responses| responses.process.as_str()),
                Some("direct"),
                "provider {} interface {} must explicitly declare responses process=direct",
                provider.id,
                interface.id
            );
        }
    }

    apply_mixed_pool_third_availability(&mut manifest, &third);
    apply_mixed_pool_debug_log(&mut manifest, debug_log);

    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let entry_endpoint = "/v1/responses".to_string();
    let endpoint = format!("{base}{entry_endpoint}");
    MixedPoolServerRig {
        handle,
        base,
        entry_endpoint,
        endpoint,
        first,
        second,
        third,
        side,
    }
}

async fn add_mixed_pool_b_cooldown(client: &reqwest::Client, base: &str, second: &str) {
    let cooled = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({
            "provider_id": second,
            "interface_id": "default",
            "auth_alias": "key",
            "model_id": "test",
            "kind": "probe",
            "duration_ms": 30_000,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        cooled.status(),
        StatusCode::OK,
        "B must enter a real probe cooldown"
    );
    assert!(
        provider_cooldown_entry(client, base, second)
            .await
            .is_some(),
        "B must be visible in the cooldown pool"
    );
}

async fn trigger_mixed_pool_b_probe(
    client: &reqwest::Client,
    base: &str,
    second: &str,
    b_probe_rx: &mut mpsc::UnboundedReceiver<()>,
    mode: &str,
) {
    let probe = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
        .json(&json!({
            "provider_id": second,
            "interface_id": "default",
            "auth_alias": "key",
            "model_id": "test",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(probe.status(), StatusCode::OK);
    let b_probe = timeout(Duration::from_secs(3), b_probe_rx.recv()).await;
    assert!(
        matches!(b_probe, Ok(Some(()))),
        "{mode}: B's real recovery probe must reach its upstream"
    );
}

async fn assert_mixed_pool_independent_request(
    client: &reqwest::Client,
    endpoint: &str,
    side: &str,
    direct: bool,
    mode: &str,
) {
    let independent_model = format!("{side}.side");
    let independent_payload = if direct {
        json!({"model": independent_model, "messages": [{"role": "user", "content": "independent"}], "max_tokens": 16, "stream": false})
    } else {
        json!({"model": independent_model, "input": "independent", "stream": false})
    };
    let independent = timeout(
        Duration::from_secs(3),
        client
            .post(endpoint)
            .header("session-id", "44cc3af-mixed-independent")
            .json(&independent_payload)
            .send(),
    )
    .await
    .expect("an independent request must progress while originals wait")
    .unwrap();
    assert_eq!(independent.status(), StatusCode::OK);
    let independent_body = independent.text().await.unwrap();
    assert!(
        independent_body.contains("independent mixed route advanced"),
        "{mode}: independent request must receive its healthy business result: {independent_body}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_mixed_pool_direct_empty_sse_recovers_cooled_peer() {
    assert_mixed_pool_empty_sse_recovers(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_mixed_pool_relay_empty_sse_recovers_cooled_peer() {
    assert_mixed_pool_empty_sse_recovers(false).await;
}

async fn assert_mixed_pool_empty_sse_recovers(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new(if direct {
        "44cc3af-mixed-pool-direct"
    } else {
        "44cc3af-mixed-pool-relay"
    });
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let mode = if direct { "Direct" } else { "Relay" };

    // A: selectable and healthy, but its complete response carries no
    // deliverable business content.
    let a_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a_url = format!("http://{}/v1", a_listener.local_addr().unwrap());
    let a_wire = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let a_business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let a_probe = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (a_business_tx, mut a_business_rx) = mpsc::unbounded_channel::<()>();
    let a_release = Arc::new(Semaphore::new(0));
    let a_app = Router::new().route(
        "/v1/chat/completions",
        post({
            let a_wire = a_wire.clone();
            let a_business = a_business.clone();
            let a_probe = a_probe.clone();
            let a_business_tx = a_business_tx.clone();
            let a_release = a_release.clone();
            move |axum::Json(body): axum::Json<Value>| {
                let a_wire = a_wire.clone();
                let a_business = a_business.clone();
                let a_probe = a_probe.clone();
                let a_business_tx = a_business_tx.clone();
                let a_release = a_release.clone();
                async move {
                    let is_probe = mixed_pool_is_probe(&body);
                    a_wire.lock().unwrap().push(body.clone());
                    if is_probe {
                        // A is healthy: answer its own probe channel instead of
                        // holding it, so a probe cannot stall this test.
                        a_probe.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        return Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/json")
                            .body(Body::from(r#"{"probe":"qualified"}"#))
                            .unwrap();
                    }
                    a_business.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = a_business_tx.send(());
                    let _permit = a_release.acquire_owned().await.unwrap();
                    mixed_pool_empty_sse()
                }
            }
        }),
    );
    let a_task = tokio::spawn(async move { axum::serve(a_listener, a_app).await.unwrap() });

    // B, C, and D share the upstream/manifest/event control with the first
    // ladder fixture. A is the only peer whose behavior differs here: it holds
    // every business attempt on a single release so the single empty-SSE
    // recovery request can be observed and then released.
    let mut peers = spawn_mixed_pool_peers(MixedPoolWireMode::Chat).await;
    let MixedPoolServerRig {
        handle,
        base,
        entry_endpoint,
        endpoint,
        first,
        second,
        third,
        side,
    } = spawn_mixed_pool_manifest_server(
        direct,
        &a_url,
        &peers.b_url,
        &peers.c_url,
        &peers.d_url,
        None,
    )
        .await;
    let client = reqwest::Client::new();

    add_mixed_pool_b_cooldown(&client, &base, &second).await;

    // Real runtime evidence for the captured candidate set: the virtual-router
    // dry-run runs the same Target expansion. C must remain a captured
    // candidate and be unavailable only through its declared availability
    // window, while A is the current selection.
    let dry_request = if direct {
        json!({"model": "client-test", "messages": [{"role": "user", "content": "mixed pool recovery"}], "max_tokens": 32, "stream": false})
    } else {
        json!({"model": "client-test", "input": "mixed pool recovery", "stream": false})
    };
    let dry_run: Value = client
        .post(format!(
            "{base}/_routecodex/diagnostics/virtual-router/dry-run"
        ))
        .json(&json!({
            "request": dry_request,
            "metadata": {
                "requestId": "mixed-pool-dry-run",
                "entryEndpoint": entry_endpoint,
            }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let decision = &dry_run["diagnostics"]["decision"];
    assert!(
        decision.is_object(),
        "virtual-router dry-run must expose a selection decision: {dry_run}"
    );
    let third_key = format!("{third}:default:key:test");
    let candidate_keys = decision["candidateProviderKeys"].to_string();
    let unavailable = decision["unavailableCandidates"].to_string();
    assert!(
        candidate_keys.contains(&third_key),
        "C must remain in the captured candidate set: {dry_run}"
    );
    assert!(
        unavailable.contains(&third_key) && unavailable.contains("availability_inactive"),
        "C must be unavailable only through its declared availability window: {dry_run}"
    );
    assert!(
        decision["selectedProviderKey"]
            .as_str()
            .unwrap_or_default()
            .starts_with(&format!("{first}:")),
        "A must be selected while B is cooled and C is outside its window: {dry_run}"
    );

    // Start the original request. A receives the first attempt and holds it.
    let request_payload = dry_request;
    let mut request = Some(tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        let payload = request_payload.clone();
        async move {
            client
                .post(endpoint)
                .header("session-id", "44cc3af-mixed-pool")
                .header("thread-id", "44cc3af-mixed-pool")
                .json(&payload)
                .send()
                .await?
                .text()
                .await
        }
    }));
    let a_arrived = timeout(Duration::from_secs(3), a_business_rx.recv()).await;
    assert!(
        matches!(a_arrived, Ok(Some(()))),
        "{mode}: A must receive the first live attempt"
    );
    assert!(
        timeout(Duration::from_millis(100), request.as_mut().unwrap())
            .await
            .is_err(),
        "{mode}: the request must stay pending while A is held"
    );
    assert_eq!(
        peers.b_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: B must not receive business while it is cooled"
    );
    assert_eq!(
        peers.c_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: C must never be dispatched"
    );

    // Make B's real recovery probe due. It reaches B's upstream and is held
    // there, so B cannot recover until this test releases the barrier.
    trigger_mixed_pool_b_probe(&client, &base, &second, &mut peers.b_probe_rx, mode).await;
    assert!(
        timeout(Duration::from_millis(100), request.as_mut().unwrap())
            .await
            .is_err(),
        "{mode}: the request must stay pending while B's probe is held"
    );
    assert_eq!(
        peers.b_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: B must not receive business before its probe recovers"
    );
    assert_eq!(
        peers.c_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: C must never be dispatched"
    );

    // An independent request on a healthy route must still progress while the
    // original request waits for B. `match.models` is not an ordinary inbound
    // routing dimension, so address D through the real provider.model direct
    // route.
    assert_mixed_pool_independent_request(&client, &endpoint, &side, direct, mode).await;
    assert_eq!(
        peers.b_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: the independent request must not dispatch B"
    );
    assert_eq!(
        peers.c_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: C must never be dispatched"
    );

    // Release A. Its complete-but-empty response triggers the recoverable
    // response-processing failure. The original request must keep waiting for
    // B instead of terminating, because B still owns a live recovery probe and
    // C cannot serve this request.
    let started = tokio::time::Instant::now();
    a_release.add_permits(1);
    let early = timeout(Duration::from_millis(150), request.as_mut().unwrap()).await;
    let ended_early = early.is_ok();
    let ended_body = match early {
        Ok(Ok(Ok(body))) => Some(body),
        Ok(Ok(Err(error))) => Some(format!("request error: {error}")),
        Ok(Err(join)) => Some(format!("join error: {join}")),
        Err(_) => None,
    };
    let elapsed = started.elapsed();

    let mut recovered_body = None;
    if !ended_early {
        peers
            .b_ready
            .store(true, std::sync::atomic::Ordering::SeqCst);
        peers.b_probe_release.add_permits(1);
        recovered_body = timeout(
            Duration::from_secs(5),
            request.take().expect("pending request handle"),
        )
        .await
        .ok()
        .and_then(|joined| joined.ok())
        .and_then(|result| result.ok());
    }
    let b_dispatched = peers.b_business.load(std::sync::atomic::Ordering::SeqCst);
    let c_dispatched = peers.c_business.load(std::sync::atomic::Ordering::SeqCst);
    let a_business_dispatched = a_business.load(std::sync::atomic::Ordering::SeqCst);
    let a_probe_dispatched = a_probe.load(std::sync::atomic::Ordering::SeqCst);

    // Release every held barrier so the abort below cannot strand a handler.
    a_release.add_permits(8);
    peers.b_probe_release.add_permits(8);
    handle.shutdown().await;
    a_task.abort();
    peers.b_task.abort();
    peers.c_task.abort();
    peers.d_task.abort();
    if let Some(request) = request {
        request.abort();
    }
    std::env::remove_var("V3_P6_TEST_KEY");

    // Record every A arrival with its classification, in wire order.
    let a_arrivals = a_wire.lock().unwrap().clone();
    for (index, wire) in a_arrivals.iter().enumerate() {
        eprintln!(
            "[{mode}] A wire #{index} is_probe={} body={wire}",
            mixed_pool_is_probe(wire)
        );
    }

    assert!(
        !ended_early,
        "{mode}: mixed pool terminated after {elapsed:?} while cooled B still had a live probe and only window-inactive C blocked the cooldown-only fast path: {ended_body:?}"
    );
    let recovered_body = recovered_body
        .expect("the original request must finish with B's real business result after B recovers");
    assert!(
        recovered_body.contains("cooled mixed peer recovered"),
        "{mode}: the original request must carry B's real business result: {recovered_body}"
    );
    assert!(
        !recovered_body.contains("\"error\""),
        "{mode}: the client must not receive a provider/proxy error payload: {recovered_body}"
    );
    assert_eq!(
        b_dispatched, 1,
        "{mode}: B must carry the recovered business request exactly once"
    );
    assert_eq!(c_dispatched, 0, "{mode}: C must never be dispatched");
    assert!(
        a_arrivals
            .first()
            .map(|wire| !mixed_pool_is_probe(wire))
            .unwrap_or(false),
        "{mode}: A's first arrival must be the original business request, not a probe: {a_arrivals:?}"
    );
    assert_eq!(
        a_business_dispatched, 1,
        "{mode}: A must receive exactly one business attempt; probe arrivals: {a_probe_dispatched}; wire: {a_arrivals:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_mixed_pool_responses_direct_empty_sse_recovers_cooled_peer() {
    assert_mixed_pool_responses_direct_empty_sse_recovers().await;
}

async fn assert_mixed_pool_responses_direct_empty_sse_recovers() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-mixed-pool-responses-direct");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let mode = "ResponsesDirect";

    // A: selectable and healthy Responses provider. Its complete JSON response
    // carries no deliverable business content, so the attempt fails inside the
    // runtime and must not be re-sent during the recovery scan.
    let a_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a_url = format!("http://{}/v1", a_listener.local_addr().unwrap());
    let a_wire = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let a_business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let a_probe = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (a_business_tx, mut a_business_rx) = mpsc::unbounded_channel::<()>();
    let a_release = Arc::new(Semaphore::new(0));
    let a_app = Router::new().route(
        "/v1/responses",
        post({
            let a_wire = a_wire.clone();
            let a_business = a_business.clone();
            let a_probe = a_probe.clone();
            let a_business_tx = a_business_tx.clone();
            let a_release = a_release.clone();
            move |axum::Json(body): axum::Json<Value>| {
                let a_wire = a_wire.clone();
                let a_business = a_business.clone();
                let a_probe = a_probe.clone();
                let a_business_tx = a_business_tx.clone();
                let a_release = a_release.clone();
                async move {
                    let is_probe = mixed_pool_responses_is_probe(&body);
                    a_wire.lock().unwrap().push(body.clone());
                    if is_probe {
                        a_probe.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        return Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/json")
                            .body(Body::from(r#"{"probe":"qualified"}"#))
                            .unwrap();
                    }
                    a_business.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = a_business_tx.send(());
                    let _permit = a_release.acquire_owned().await.unwrap();
                    mixed_pool_responses_empty()
                }
            }
        }),
    );
    let a_task = tokio::spawn(async move { axum::serve(a_listener, a_app).await.unwrap() });

    let mut peers = spawn_mixed_pool_peers(MixedPoolWireMode::Responses).await;
    let MixedPoolServerRig {
        handle,
        base,
        entry_endpoint,
        endpoint,
        first,
        second,
        third,
        side,
    } = spawn_mixed_pool_responses_direct_server(
        &a_url,
        &peers.b_url,
        &peers.c_url,
        &peers.d_url,
        None,
    )
        .await;
    let client = reqwest::Client::new();

    add_mixed_pool_b_cooldown(&client, &base, &second).await;

    // The dry-run must prove the same captured candidate set used by the real
    // request: C stays a candidate but is unavailable only through its declared
    // availability window, and A is the current selection.
    let dry_request =
        json!({"model": "client-test", "input": "mixed pool recovery", "stream": false});
    let dry_run: Value = client
        .post(format!(
            "{base}/_routecodex/diagnostics/virtual-router/dry-run"
        ))
        .json(&json!({
            "request": dry_request,
            "metadata": {
                "requestId": "mixed-pool-responses-direct-dry-run",
                "entryEndpoint": entry_endpoint,
            }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let decision = &dry_run["diagnostics"]["decision"];
    assert!(
        decision.is_object(),
        "virtual-router dry-run must expose a selection decision: {dry_run}"
    );
    let third_key = format!("{third}:default:key:test");
    let candidate_keys = decision["candidateProviderKeys"].to_string();
    let unavailable = decision["unavailableCandidates"].to_string();
    assert!(
        candidate_keys.contains(&third_key),
        "C must remain in the captured candidate set: {dry_run}"
    );
    assert!(
        unavailable.contains(&third_key) && unavailable.contains("availability_inactive"),
        "C must be unavailable only through its declared availability window: {dry_run}"
    );
    assert!(
        decision["selectedProviderKey"]
            .as_str()
            .unwrap_or_default()
            .starts_with(&format!("{first}:")),
        "A must be selected while B is cooled and C is outside its window: {dry_run}"
    );

    // Start the original request. A receives the first attempt and holds it.
    let request_payload = dry_request;
    let mut request = Some(tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        let payload = request_payload.clone();
        async move {
            client
                .post(endpoint)
                .header("session-id", "44cc3af-mixed-pool-responses-direct")
                .header("thread-id", "44cc3af-mixed-pool-responses-direct")
                .json(&payload)
                .send()
                .await?
                .text()
                .await
        }
    }));
    let a_arrived = timeout(Duration::from_secs(3), a_business_rx.recv()).await;
    assert!(
        matches!(a_arrived, Ok(Some(()))),
        "{mode}: A must receive the first live attempt"
    );
    assert!(
        timeout(Duration::from_millis(100), request.as_mut().unwrap())
            .await
            .is_err(),
        "{mode}: the request must stay pending while A is held"
    );
    assert_eq!(
        peers.b_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: B must not receive business while it is cooled"
    );
    assert_eq!(
        peers.c_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: C must never be dispatched"
    );

    // B's real recovery probe reaches its upstream and is held there.
    trigger_mixed_pool_b_probe(&client, &base, &second, &mut peers.b_probe_rx, mode).await;
    assert!(
        timeout(Duration::from_millis(100), request.as_mut().unwrap())
            .await
            .is_err(),
        "{mode}: the request must stay pending while B's probe is held"
    );
    assert_eq!(
        peers.b_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: B must not receive business before its probe recovers"
    );
    assert_eq!(
        peers.c_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: C must never be dispatched"
    );

    // An independent Responses request on the healthy D route must still
    // progress while the original request waits for B.
    let independent_model = format!("{side}.side");
    let independent = timeout(
        Duration::from_secs(3),
        client
            .post(&endpoint)
            .header("session-id", "44cc3af-mixed-responses-independent")
            .json(&json!({
                "model": independent_model,
                "input": "independent",
                "stream": false
            }))
            .send(),
    )
    .await
    .expect("an independent request must progress while originals wait")
    .unwrap();
    assert_eq!(independent.status(), StatusCode::OK);
    let independent_body = independent.text().await.unwrap();
    assert!(
        independent_body.contains("independent mixed route advanced"),
        "{mode}: independent request must receive its healthy business result: {independent_body}"
    );
    assert_eq!(
        peers.b_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: the independent request must not dispatch B"
    );
    assert_eq!(
        peers.c_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: C must never be dispatched"
    );

    // Release A. Its complete-but-empty Responses body triggers a recoverable
    // response-processing failure; the request must keep waiting for B.
    let started = tokio::time::Instant::now();
    a_release.add_permits(1);
    let early = timeout(Duration::from_millis(150), request.as_mut().unwrap()).await;
    let ended_early = early.is_ok();
    let ended_body = match early {
        Ok(Ok(Ok(body))) => Some(body),
        Ok(Ok(Err(error))) => Some(format!("request error: {error}")),
        Ok(Err(join)) => Some(format!("join error: {join}")),
        Err(_) => None,
    };
    let elapsed = started.elapsed();

    let mut recovered_body = None;
    if !ended_early {
        peers
            .b_ready
            .store(true, std::sync::atomic::Ordering::SeqCst);
        peers.b_probe_release.add_permits(1);
        recovered_body = timeout(
            Duration::from_secs(5),
            request.take().expect("pending request handle"),
        )
        .await
        .ok()
        .and_then(|joined| joined.ok())
        .and_then(|result| result.ok());
    }
    let b_dispatched = peers.b_business.load(std::sync::atomic::Ordering::SeqCst);
    let c_dispatched = peers.c_business.load(std::sync::atomic::Ordering::SeqCst);
    let a_business_dispatched = a_business.load(std::sync::atomic::Ordering::SeqCst);
    let a_probe_dispatched = a_probe.load(std::sync::atomic::Ordering::SeqCst);

    // Release every held barrier so the aborts below cannot strand a handler.
    a_release.add_permits(8);
    peers.b_probe_release.add_permits(8);
    handle.shutdown().await;
    a_task.abort();
    peers.b_task.abort();
    peers.c_task.abort();
    peers.d_task.abort();
    if let Some(request) = request {
        request.abort();
    }
    std::env::remove_var("V3_P6_TEST_KEY");

    // Record every A (business and probe) and B (probe) wire in arrival order.
    let a_arrivals = a_wire.lock().unwrap().clone();
    for (index, wire) in a_arrivals.iter().enumerate() {
        eprintln!(
            "[{mode}] A wire #{index} is_probe={} body={wire}",
            mixed_pool_responses_is_probe(wire)
        );
    }
    let b_arrivals = peers.b_wire.lock().unwrap().clone();
    for (index, wire) in b_arrivals.iter().enumerate() {
        eprintln!(
            "[{mode}] B wire #{index} is_probe={} body={wire}",
            mixed_pool_responses_is_probe(wire)
        );
    }

    assert!(
        !ended_early,
        "{mode}: mixed pool terminated after {elapsed:?} while cooled B still had a live probe: {ended_body:?}"
    );
    let recovered_body = recovered_body
        .expect("the original request must finish with B's real business result after B recovers");
    assert!(
        recovered_body.contains("cooled mixed peer recovered"),
        "{mode}: the original request must carry B's real business result: {recovered_body}"
    );
    assert!(
        !recovered_body.contains("\"error\""),
        "{mode}: the client must not receive a provider/proxy error payload: {recovered_body}"
    );
    assert_eq!(
        b_dispatched, 1,
        "{mode}: B must carry the recovered business request exactly once"
    );
    assert_eq!(c_dispatched, 0, "{mode}: C must never be dispatched");
    assert!(
        a_arrivals
            .first()
            .map(|wire| !mixed_pool_responses_is_probe(wire))
            .unwrap_or(false),
        "{mode}: A's first arrival must be the original business request, not a probe: {a_arrivals:?}"
    );
    assert_eq!(
        a_business_dispatched, 1,
        "{mode}: A must receive exactly one business attempt; probe arrivals: {a_probe_dispatched}; wire: {a_arrivals:?}"
    );
    let b_probe_count = b_arrivals
        .iter()
        .filter(|wire| mixed_pool_responses_is_probe(wire))
        .count();
    assert_eq!(
        b_probe_count, 1,
        "{mode}: B must receive exactly one recovery probe before the original request recovers: {b_arrivals:?}"
    );
    assert_eq!(
        b_arrivals.len(),
        2,
        "{mode}: B must receive the recovery probe and then the recovered business request: {b_arrivals:?}"
    );
    assert!(
        b_arrivals
            .first()
            .map(mixed_pool_responses_is_probe)
            .unwrap_or(false),
        "{mode}: B's recorded wire must be the real recovery probe: {b_arrivals:?}"
    );
}

// ---------------------------------------------------------------------------
// Mixed candidate pool: a health-neutral request-local failure must not turn
// the exhaustion into a terminal while a cooled peer still owns a live recovery
// probe and only a healthy-but-window-inactive candidate is otherwise present.
//
// A answers its business attempt with a recognized unharvestable tool marker.
// That is a registered health-neutral response-processing failure: A is
// excluded for this request only and is not cooled. B is driven into a real,
// probe-owned cooldown through the public control entry. C is healthy but its
// declared availability window does not cover this request, so selection skips
// it while it stays in the captured candidate set. The original request must
// keep waiting for B's real probe and then serve B's real business result; C
// must never be dispatched, A must not be re-sent, and the client must never
// receive a provider/proxy error or a fabricated empty success.
//
// This is the health-neutral counterpart of the empty-SSE fixture: the empty
// SSE body is a ProviderFailure, which takes the unconditional recovery path
// and therefore cannot reach the cooldown-only classification. Only the
// health-neutral failure reaches `v3_exhaustion_is_cooldown_only`, where a
// healthy-but-window-inactive candidate must not hide the cooled peer's live
// recovery probe.
// ---------------------------------------------------------------------------

const MIXED_POOL_UNHARVESTABLE_MARKUP: &str =
    "must-not-deliver\n<|DSML|tool_calls>\n<|exec_command\">";

fn mixed_pool_exec_command_tools() -> Value {
    json!([{
        "type": "function",
        "name": "exec_command",
        "description": "Run one bounded command.",
        "parameters": {
            "type": "object",
            "properties": {"cmd": {"type": "string"}},
            "required": ["cmd"]
        }
    }])
}

fn mixed_pool_markup_response(direct: bool, text: &str) -> Response<Body> {
    if direct {
        mixed_pool_responses_success_with_model("wire-test", text)
    } else {
        mixed_pool_chat_success_with_model("wire-test", text)
    }
}

fn mixed_pool_debug_tail(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(max_chars);
    chars[start..].iter().collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_mixed_pool_direct_health_neutral_keeps_cooled_probe() {
    assert_mixed_pool_health_neutral_recovers(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_mixed_pool_relay_health_neutral_keeps_cooled_probe() {
    assert_mixed_pool_health_neutral_recovers(false).await;
}

async fn assert_mixed_pool_health_neutral_recovers(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new(if direct {
        "44cc3af-mixed-health-neutral-direct"
    } else {
        "44cc3af-mixed-health-neutral-relay"
    });
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let mode = if direct { "ResponsesDirect" } else { "Relay" };

    // A: selectable and healthy. Its complete response carries a recognized
    // unharvestable tool marker, so the attempt fails with a health-neutral
    // typed cause and A is excluded for this request only.
    let a_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a_url = format!("http://{}/v1", a_listener.local_addr().unwrap());
    let a_wire = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let a_business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let a_probe = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (a_business_tx, mut a_business_rx) = mpsc::unbounded_channel::<()>();
    let a_release = Arc::new(Semaphore::new(0));
    let a_route: &'static str = if direct {
        "/v1/responses"
    } else {
        "/v1/chat/completions"
    };
    let a_app = Router::new().route(
        a_route,
        post({
            let a_wire = a_wire.clone();
            let a_business = a_business.clone();
            let a_probe = a_probe.clone();
            let a_business_tx = a_business_tx.clone();
            let a_release = a_release.clone();
            move |axum::Json(body): axum::Json<Value>| {
                let a_wire = a_wire.clone();
                let a_business = a_business.clone();
                let a_probe = a_probe.clone();
                let a_business_tx = a_business_tx.clone();
                let a_release = a_release.clone();
                async move {
                    let is_probe = if direct {
                        mixed_pool_responses_is_probe(&body)
                    } else {
                        mixed_pool_is_probe(&body)
                    };
                    a_wire.lock().unwrap().push(body.clone());
                    if is_probe {
                        // A answers its own probe channel instead of holding it,
                        // so a probe cannot stall this test.
                        a_probe.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        return Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/json")
                            .body(Body::from(r#"{"probe":"qualified"}"#))
                            .unwrap();
                    }
                    a_business.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = a_business_tx.send(());
                    let _permit = a_release.acquire_owned().await.unwrap();
                    mixed_pool_markup_response(direct, MIXED_POOL_UNHARVESTABLE_MARKUP)
                }
            }
        }),
    );
    let a_task = tokio::spawn(async move { axum::serve(a_listener, a_app).await.unwrap() });

    let mut peers = spawn_mixed_pool_peers(if direct {
        MixedPoolWireMode::Responses
    } else {
        MixedPoolWireMode::Chat
    })
    .await;

    // Reuse the shared spawn helpers, attaching a debug log file so the test
    // can read back the registered health-neutral typed cause instead of
    // inferring it from recovery alone.
    let debug_log = std::env::temp_dir().join(format!(
        "rcc-mixed-health-neutral-{}-{}.log",
        if direct { "direct" } else { "relay" },
        std::process::id()
    ));
    let _ = std::fs::remove_file(&debug_log);

    // Direct keeps the Responses entry on the real ResponsesDirect process; the
    // shared helper already asserts every provider/interface declares
    // responses process=direct. Relay keeps the OpenAI Chat provider wire
    // behind the Responses entry through the same shared Relay binding.
    let MixedPoolServerRig {
        handle,
        base,
        entry_endpoint,
        endpoint,
        first,
        second,
        third,
        side,
    } = if direct {
        spawn_mixed_pool_responses_direct_server(
            &a_url,
            &peers.b_url,
            &peers.c_url,
            &peers.d_url,
            Some(&debug_log),
        )
        .await
    } else {
        spawn_mixed_pool_manifest_server(
            false,
            &a_url,
            &peers.b_url,
            &peers.c_url,
            &peers.d_url,
            Some(&debug_log),
        )
        .await
    };
    let client = reqwest::Client::new();

    add_mixed_pool_b_cooldown(&client, &base, &second).await;

    // Prerequisites: the dry-run proves C stays in the captured candidate set
    // and is unavailable only through its declared window, while A is the
    // current selection and B is cooled.
    let dry_request = json!({
        "model": "client-test",
        "input": "mixed health-neutral recovery",
        "stream": false,
        "tools": mixed_pool_exec_command_tools(),
    });
    let dry_run: Value = client
        .post(format!(
            "{base}/_routecodex/diagnostics/virtual-router/dry-run"
        ))
        .json(&json!({
            "request": dry_request,
            "metadata": {
                "requestId": "mixed-health-neutral-dry-run",
                "entryEndpoint": entry_endpoint,
            }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let decision = &dry_run["diagnostics"]["decision"];
    assert!(
        decision.is_object(),
        "{mode}: virtual-router dry-run must expose a selection decision: {dry_run}"
    );
    let third_key = format!("{third}:default:key:test");
    let candidate_keys = decision["candidateProviderKeys"].to_string();
    let unavailable = decision["unavailableCandidates"].to_string();
    assert!(
        candidate_keys.contains(&third_key),
        "{mode}: C must remain in the captured candidate set: {dry_run}"
    );
    assert!(
        unavailable.contains(&third_key) && unavailable.contains("availability_inactive"),
        "{mode}: C must be unavailable only through its declared availability window: {dry_run}"
    );
    assert!(
        decision["selectedProviderKey"]
            .as_str()
            .unwrap_or_default()
            .starts_with(&format!("{first}:")),
        "{mode}: A must be selected while B is cooled and C is outside its window: {dry_run}"
    );

    // Start the original request. A receives the first attempt and holds it.
    let mut request = Some(tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        let payload = dry_request.clone();
        async move {
            client
                .post(endpoint)
                .header("session-id", "44cc3af-mixed-health-neutral")
                .header("thread-id", "44cc3af-mixed-health-neutral")
                .json(&payload)
                .send()
                .await?
                .text()
                .await
        }
    }));
    let a_arrived = timeout(Duration::from_secs(3), a_business_rx.recv()).await;
    assert!(
        matches!(a_arrived, Ok(Some(()))),
        "{mode}: A must receive the first live attempt"
    );
    assert!(
        timeout(Duration::from_millis(100), request.as_mut().unwrap())
            .await
            .is_err(),
        "{mode}: the request must stay pending while A is held"
    );
    assert_eq!(
        peers.b_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: B must not receive business while it is cooled"
    );
    assert_eq!(
        peers.c_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: C must never be dispatched"
    );

    // B's real recovery probe reaches its upstream and is held there.
    trigger_mixed_pool_b_probe(&client, &base, &second, &mut peers.b_probe_rx, mode).await;
    assert!(
        timeout(Duration::from_millis(100), request.as_mut().unwrap())
            .await
            .is_err(),
        "{mode}: the request must stay pending while B's probe is held"
    );
    assert_eq!(
        peers.b_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: B must not receive business before its probe recovers"
    );
    assert_eq!(
        peers.c_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: C must never be dispatched"
    );

    // An independent healthy D request must still progress while the original
    // request waits for B.
    let independent_model = format!("{side}.side");
    let independent = timeout(
        Duration::from_secs(3),
        client
            .post(&endpoint)
            .header("session-id", "44cc3af-mixed-health-independent")
            .json(&json!({
                "model": independent_model,
                "input": "independent",
                "stream": false
            }))
            .send(),
    )
    .await
    .expect("an independent request must progress while the original waits")
    .unwrap();
    assert_eq!(independent.status(), StatusCode::OK);
    let independent_body = independent.text().await.unwrap();
    assert!(
        independent_body.contains("independent mixed route advanced"),
        "{mode}: independent request must receive its healthy business result: {independent_body}"
    );
    assert_eq!(
        peers.b_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: the independent request must not dispatch B"
    );
    assert_eq!(
        peers.c_business.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "{mode}: C must never be dispatched"
    );

    // Release A. Its unharvestable tool marker is a health-neutral
    // request-local failure, so the mixed pool must keep waiting for B's live
    // probe instead of terminating.
    let started = tokio::time::Instant::now();
    a_release.add_permits(1);
    let early = timeout(Duration::from_millis(150), request.as_mut().unwrap()).await;
    let ended_early = early.is_ok();
    let ended_body = match early {
        Ok(Ok(Ok(body))) => Some(body),
        Ok(Ok(Err(error))) => Some(format!("request error: {error}")),
        Ok(Err(join)) => Some(format!("join error: {join}")),
        Err(_) => None,
    };
    let elapsed = started.elapsed();

    let mut recovered_body = None;
    if !ended_early {
        peers
            .b_ready
            .store(true, std::sync::atomic::Ordering::SeqCst);
        peers.b_probe_release.add_permits(1);
        recovered_body = timeout(
            Duration::from_secs(5),
            request.take().expect("pending request handle"),
        )
        .await
        .ok()
        .and_then(|joined| joined.ok())
        .and_then(|result| result.ok());
    }
    let b_dispatched = peers.b_business.load(std::sync::atomic::Ordering::SeqCst);
    let c_dispatched = peers.c_business.load(std::sync::atomic::Ordering::SeqCst);
    let a_business_dispatched = a_business.load(std::sync::atomic::Ordering::SeqCst);
    let a_probe_dispatched = a_probe.load(std::sync::atomic::Ordering::SeqCst);

    // Release every held barrier so the aborts below cannot strand a handler.
    a_release.add_permits(8);
    peers.b_probe_release.add_permits(8);
    handle.shutdown().await;
    a_task.abort();
    peers.b_task.abort();
    peers.c_task.abort();
    peers.d_task.abort();
    if let Some(request) = request {
        request.abort();
    }
    std::env::remove_var("V3_P6_TEST_KEY");

    // Record every A arrival with its classification, in wire order.
    let a_arrivals = a_wire.lock().unwrap().clone();
    for (index, wire) in a_arrivals.iter().enumerate() {
        let is_probe = if direct {
            mixed_pool_responses_is_probe(wire)
        } else {
            mixed_pool_is_probe(wire)
        };
        eprintln!("[{mode}] A wire #{index} is_probe={is_probe} body={wire}");
    }

    // Typed-cause prerequisite: A must actually produce the registered
    // health-neutral unharvestable-tool-markup cause. Without it the failure
    // would be a ProviderFailure and the request would take the unconditional
    // recovery path, so this fixture would not exercise the cooldown-only
    // classification that the production fix owns.
    let debug_text = std::fs::read_to_string(&debug_log).unwrap_or_default();
    let typed_cause_present = if direct {
        debug_text.contains("V3DirectResp14UnharvestableToolMarkup")
            || debug_text.contains("direct_tool_markup_unharvestable")
    } else {
        debug_text.contains("V3HubRelayResp03UnharvestableToolMarkup")
            || debug_text.contains("relay_unharvestable_tool_markup")
    };
    assert!(
        typed_cause_present,
        "{mode}: A must produce the registered health-neutral unharvestable-tool-markup typed cause; debug log tail: {}",
        mixed_pool_debug_tail(&debug_text, 6000)
    );

    assert!(
        !ended_early,
        "{mode}: mixed pool terminated after {elapsed:?} while cooled B still had a live probe and only window-inactive C blocked the cooldown-only fast path: {ended_body:?}"
    );
    let recovered_body = recovered_body
        .expect("the original request must finish with B's real business result after B recovers");
    assert!(
        recovered_body.contains("cooled mixed peer recovered"),
        "{mode}: the original request must carry B's real business result: {recovered_body}"
    );
    assert!(
        !recovered_body.contains("\"error\""),
        "{mode}: the client must not receive a provider/proxy error payload: {recovered_body}"
    );
    assert_eq!(
        b_dispatched, 1,
        "{mode}: B must carry the recovered business request exactly once"
    );
    assert_eq!(c_dispatched, 0, "{mode}: C must never be dispatched");
    let a_is_probe = |wire: &Value| {
        if direct {
            mixed_pool_responses_is_probe(wire)
        } else {
            mixed_pool_is_probe(wire)
        }
    };
    assert!(
        a_arrivals
            .first()
            .map(|wire| !a_is_probe(wire))
            .unwrap_or(false),
        "{mode}: A's first arrival must be the original business request, not a probe: {a_arrivals:?}"
    );
    assert_eq!(
        a_business_dispatched, 1,
        "{mode}: A must receive exactly one business attempt and must not be re-sent; probe arrivals: {a_probe_dispatched}; wire: {a_arrivals:?}"
    );
}
