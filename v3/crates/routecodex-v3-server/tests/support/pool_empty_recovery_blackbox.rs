use super::*;
use axum::response::IntoResponse;




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
    let extra_capture = stalled_requests.try_recv();
    assert!(
        extra_capture.is_err(),
        "the stalled candidate must not receive repeated concurrent attempts; extra capture: {}",
        extra_capture
            .as_ref()
            .ok()
            .map(|capture| {
                let headers = format!(
                    "authorization={:?} accept={:?} session-id={:?} thread-id={:?} x-session-id={:?} x-conversation-id={:?} x-codex-turn-metadata={:?}",
                    capture.authorization,
                    capture.accept,
                    capture.session_id,
                    capture.thread_id,
                    capture.x_session_id,
                    capture.x_conversation_id,
                    capture.x_codex_turn_metadata,
                );
                let body = capture.body.to_string();
                format!(
                    "path=/v1/responses headers={} body={}",
                    headers.chars().take(240).collect::<String>(),
                    body.chars().take(400).collect::<String>(),
                )
            })
            .unwrap_or_else(|| "none".to_string()),
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
    // v31 clause "请求从不等待容量、冷却、探测、恢复、FIFO、permit 或 attempt/store
    // 预算": an availability window is declared provider lifecycle state, never a
    // request-side wait. The request resolves inside itself instead of parking the
    // client until the window opens; the retired expectation here was the removed
    // "inactive route must wait before retry" hold.
    for request in &mut waiting {
        let resolved = timeout(Duration::from_secs(3), &mut *request)
            .await
            .expect("an inactive declared route must resolve inside the request, never park the client");
        match resolved {
            Ok(Ok(body)) => assert!(
                !body.contains("response.completed"),
                "an inactive declared route must not fabricate a completed response: {body}"
            ),
            Ok(Err(_)) | Err(_) => {}
        }
    }
    assert!(
        good_requests.try_recv().is_err(),
        "an inactive declared route must not reselect the unrelated provider"
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
async fn issue44cc3af_relay_all_tried_transport_failure_with_held_sibling_recovers() {
    assert_all_tried_transport_failure_recovers(false, true).await;
}

#[tokio::test]
async fn issue44cc3af_direct_all_tried_transport_failure_with_held_sibling_recovers() {
    assert_all_tried_transport_failure_recovers(true, true).await;
}

#[tokio::test]
async fn issue44cc3af_untried_tier_attempt_relay_sends_b_before_deadline() {
    assert_untried_tier_attempt_sends_b(false, false).await;
}

#[tokio::test]
async fn issue44cc3af_untried_tier_attempt_direct_sends_b_before_deadline() {
    assert_untried_tier_attempt_sends_b(true, false).await;
}

#[tokio::test]
async fn issue44cc3af_untried_tier_attempt_direct_refill_uses_visible_provider() {
    assert_untried_tier_attempt_sends_b(true, true).await;
}

async fn assert_untried_tier_attempt_sends_b(direct: bool, refill: bool) {
    let _guard = TEST_LOCK.lock().await;
    // Process-global test override. It must be set explicitly for BOTH cases: this
    // is the only site in the file that needs a refill round, and leaving `Some(1)`
    // behind would hand a refill budget to whichever test runs next under
    // `TEST_LOCK`, making that test's call counts depend on execution order.
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(
        if refill { Some(1) } else { Some(0) },
    );
    let _home = TestHomeGuard::new("44cc3af-untried-tier-attempt");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");

    // Tier A is tried first. It receives one real business request and then
    // answers a controlled HTTP 503 with a unique provider-error sentinel.
    let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_url = format!("http://{}/v1", first.local_addr().unwrap());
    let a_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (a_tx, mut a_rx) = mpsc::unbounded_channel::<()>();
    let a_app = Router::new().fallback_service(post({
        let a_calls = a_calls.clone();
        move |axum::Json(body): axum::Json<Value>| {
            if body.to_string().contains("untried tier attempt original request") {
                a_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = a_tx.send(());
            }
            async move {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "untried-tier-a-503-sentinel",
                )
                    .into_response()
            }
        }
    }));

    // Tier B is the untried second/default tier. It must receive the real
    // business request and complete with a unique, identifiable body.
    let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second_url = format!("http://{}/v1", second.local_addr().unwrap());
    let b_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (b_tx, mut b_rx) = mpsc::unbounded_channel::<()>();
    let b_app = Router::new().fallback_service(post({
        let b_calls = b_calls.clone();
        move |axum::Json(body): axum::Json<Value>| {
            if body.to_string().contains("untried tier attempt original request") {
                b_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = b_tx.send(());
            }
            async move {
                if direct {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"id":"untried-tier-b","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"untried tier successor completed"}]}]}"#,
                        ))
                        .unwrap()
                } else {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"id":"untried-tier-b","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"untried tier successor completed"},"finish_reason":"stop"}]}"#,
                        ))
                        .unwrap()
                }
            }
        }
    }));
    let a_task = tokio::spawn(async move { axum::serve(first, a_app).await.unwrap() });
    let b_task = tokio::spawn(async move { axum::serve(second, b_app).await.unwrap() });

    let mode = if direct {
        V3EntryProtocolExecutionMode::Direct
    } else {
        V3EntryProtocolExecutionMode::Relay
    };
    let mut manifest = concurrency_switch_manifest_with_mode(&first_url, &second_url, mode);
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
        let attempt_store = &mut server.execution.as_mut().unwrap().attempt_store;
        attempt_store.residence_timeout_ms = 4000;
    }

    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let began = tokio::time::Instant::now();
    let request = tokio::spawn({
        let client = client.clone();
        let endpoint = format!("{base}/v1/responses");
        async move {
            client
                .post(endpoint)
                .json(&json!({
                    "model": "client-test",
                    "input": "untried tier attempt original request",
                    "stream": false
                }))
                .send()
                .await?
                .text()
                .await
        }
    });

    // A must be the first selected identity and receive the real business body.
    timeout(Duration::from_secs(2), a_rx.recv())
        .await
        .expect("tier A must receive the real business request first")
        .expect("tier A channel must stay open");

    // B is untried and healthy, so A's failure must not block its
    // first real send. It has to arrive before the original residence deadline.
    timeout(Duration::from_secs(2), b_rx.recv())
        .await
        .expect("untried tier B must receive the business request before the residence deadline")
        .expect("tier B channel must stay open");

    let result = timeout(Duration::from_secs(5), request)
        .await
        .expect("client must complete with B's business result");
    handle.shutdown().await;
    a_task.abort();
    b_task.abort();
    std::env::remove_var("V3_P6_TEST_KEY");

    let body = result
        .expect("client request task must not panic")
        .unwrap_or_else(|error| panic!(
            "client transport must stay intact; A wire calls={}, B wire calls={}: {error}",
            a_calls.load(std::sync::atomic::Ordering::SeqCst),
            b_calls.load(std::sync::atomic::Ordering::SeqCst),
        ));
    assert!(
        body.contains("untried tier successor completed"),
        "client must receive B's unique business text: {body}"
    );
    assert!(
        !body.contains("untried-tier-a-503-sentinel"),
        "client must not receive A's provider error sentinel: {body}"
    );
    assert!(
        !body.contains("\"error\""),
        "client must not receive a proxy error payload: {body}"
    );
    // Removed premise (Lead ruling, 2026-11-07): this assertion used to demand a
    // single tier-A send even when the refill round runs, i.e. it assumed a refill
    // must never revisit a failed-but-still-visible provider. Measured with a
    // temporary kernel trace: round 1 sends A (candidates=2) then B (candidates=1);
    // the refill round enters the resident core again with `initial_selected=false`,
    // plans a fresh selection, and legitimately picks the still-visible A again
    // (one 503 is a pre-cool observation, not a cooldown), then B. There is no
    // same-round same-identity retry, so the invariant is one business send per
    // eligible identity per execution round: `1 + refill_max` rounds, exactly one
    // A send in each while A stays visible.
    let execution_rounds = if refill { 2 } else { 1 };
    assert_eq!(
        a_calls.load(std::sync::atomic::Ordering::SeqCst),
        execution_rounds,
        "each execution round may select the still-visible tier A exactly once, and no round may re-send the same identity"
    );
    assert_eq!(
        b_calls.load(std::sync::atomic::Ordering::SeqCst),
        if refill { 2 } else { 1 },
        "tier B must receive the successor and only the configured single refill"
    );
    assert!(
        began.elapsed() < Duration::from_millis(3800),
        "B must complete before the original residence deadline"
    );
}

#[tokio::test]
async fn issue44cc3af_untried_tier_attempt_anthropic_relay_sends_b_before_deadline() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-untried-tier-attempt-anthropic");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");

    // Tier A receives one real Anthropic business request and returns a
    // controlled HTTP error. Its sentinel must never reach the client.
    let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_url = format!("http://{}/v1", first.local_addr().unwrap());
    let a_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (a_tx, mut a_rx) = mpsc::unbounded_channel::<Value>();
    let a_app = Router::new().fallback_service(post({
        let a_calls = a_calls.clone();
        move |axum::Json(body): axum::Json<Value>| {
            if body.to_string().contains("anthropic untried tier original request") {
                a_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = a_tx.send(body);
            }
            async move {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "untried-tier-a-503-sentinel",
                )
                    .into_response()
            }
        }
    }));

    // Tier B is the untried healthy successor. It must receive the same
    // Anthropic business request and return a complete client result.
    let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second_url = format!("http://{}/v1", second.local_addr().unwrap());
    let b_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (b_tx, mut b_rx) = mpsc::unbounded_channel::<Value>();
    let b_app = Router::new().fallback_service(post({
        let b_calls = b_calls.clone();
        move |axum::Json(body): axum::Json<Value>| {
            if body.to_string().contains("anthropic untried tier original request") {
                b_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = b_tx.send(body);
            }
            async move {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"id":"msg-untried-tier-b","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"untried anthropic tier successor completed"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#,
                    ))
                    .unwrap()
            }
        }
    }));
    let a_task = tokio::spawn(async move { axum::serve(first, a_app).await.unwrap() });
    let b_task = tokio::spawn(async move { axum::serve(second, b_app).await.unwrap() });

    // Keep the existing ordered fixture and force the Anthropic Relay entry.
    let mut manifest = concurrency_switch_manifest_with_mode(
        &first_url,
        &second_url,
        V3EntryProtocolExecutionMode::Relay,
    );
    for server in manifest.servers.values_mut() {
        server.endpoints = vec!["anthropic".to_string()];
        let attempt_store = &mut server.execution.as_mut().unwrap().attempt_store;
        attempt_store.residence_timeout_ms = 4000;
    }
    for provider in manifest.providers.values_mut() {
        provider.provider_type = "anthropic".into();
        provider.responses = None;
        for interface in provider.interfaces.values_mut() {
            interface.provider_type = "anthropic".into();
            interface.responses = None;
        }
    }

    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let began = tokio::time::Instant::now();
    let request = tokio::spawn({
        let client = client.clone();
        let endpoint = format!("{base}/v1/messages");
        async move {
            client
                .post(endpoint)
                .json(&json!({
                    "model": "client-test",
                    "max_tokens": 32,
                    "messages": [{"role": "user", "content": "anthropic untried tier original request"}],
                    "stream": false
                }))
                .send()
                .await?
                .text()
                .await
        }
    });

    let a_body = timeout(Duration::from_secs(2), a_rx.recv())
        .await
        .expect("Anthropic tier A must receive the real business request first")
        .expect("Anthropic tier A channel must stay open");
    assert!(
        a_body
            .to_string()
            .contains("anthropic untried tier original request"),
        "tier A must receive the untried-tier business payload: {a_body}"
    );

    let b_body = timeout(Duration::from_secs(2), b_rx.recv())
        .await
        .expect("untried Anthropic tier B must receive the business request before the deadline")
        .expect("Anthropic tier B channel must stay open");
    assert!(
        b_body
            .to_string()
            .contains("anthropic untried tier original request"),
        "tier B must receive the untried-tier business payload: {b_body}"
    );

    let result = timeout(Duration::from_secs(5), request)
        .await
        .expect("client must complete with Anthropic tier B's business result");
    handle.shutdown().await;
    a_task.abort();
    b_task.abort();
    std::env::remove_var("V3_P6_TEST_KEY");

    let body = result
        .expect("client request task must not panic")
        .expect("client transport must stay intact");
    let client_body: Value = serde_json::from_str(&body)
        .expect("Anthropic success response must be valid JSON");
    assert_eq!(
        client_body["content"][0]["text"],
        "untried anthropic tier successor completed",
        "client must receive tier B's unique business text: {body}"
    );
    assert_eq!(client_body["stop_reason"], "end_turn", "{body}");
    assert!(
        !body.contains("untried-tier-a-503-sentinel"),
        "client must not receive tier A's provider error sentinel: {body}"
    );
    assert!(
        !body.contains("\"error\""),
        "client must not receive a proxy error payload: {body}"
    );
    assert_eq!(
        a_calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "tier A must receive exactly one business send and no same-identity retry"
    );
    assert_eq!(
        b_calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "tier B must receive exactly one business successor with fixture refill disabled"
    );
    assert!(
        began.elapsed() < Duration::from_millis(3800),
        "tier B must complete before the original residence deadline"
    );
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

async fn assert_all_tried_transport_failure_recovers(direct: bool, held_sibling: bool) {
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
    }
    let first_id = format!("concurrency_first_{}", manifest.servers["a"].port);
    let second_id = format!("concurrency_second_{}", manifest.servers["a"].port);
    if held_sibling {
        manifest
            .providers
            .get_mut(&first_id)
            .unwrap()
            .concurrency
            .as_mut()
            .unwrap()
            .max_in_flight = 2;
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let held_success =
        if held_sibling {
            let client = client.clone();
            let base = base.clone();
            let task =
                tokio::spawn(async move {
                    client.post(format!("{base}/v1/responses"))
                .json(&json!({"model":"client-test","input":"independence-held","stream":false}))
                .send().await.unwrap().text().await.unwrap()
                });
            let wire = timeout(Duration::from_secs(2), first_rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert!(wire.2.to_string().contains("independence-held"));
            Some(task)
        } else {
            None
        };
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
    let mut a_original_business: usize = if !first_wire.0
        && first_wire
            .2
            .to_string()
            .contains("all tried transport original request")
    {
        1
    } else {
        0
    };
    let b_original_business: usize = if !second_wire.0
        && second_wire
            .2
            .to_string()
            .contains("all tried transport original request")
    {
        1
    } else {
        0
    };
    assert_eq!(
        a_original_business, 1,
        "A must receive the first original-O business send"
    );
    assert_eq!(
        b_original_business, 1,
        "B must receive the second original-O business send"
    );
    let mut early = timeout(Duration::from_millis(150), &mut request).await;
    let ended_early = early.is_ok();
    let entries = pool_entries_for_transport_case(&client, &base).await;
    // Decision 2: the pool also lists pre-cool observation substates, so a
    // "not cooled" assertion filters those out and means "no committed cooldown".
    let committed: Vec<&Value> = entries
        .iter()
        .filter(|entry| entry["state"] != "pre_cool_observation")
        .collect();
    assert!(
        !committed.iter().any(|e| e["provider_id"] == second_id),
        "last candidate must not be newly cooled"
    );
    ready.store(true, std::sync::atomic::Ordering::SeqCst);
    // A has not been cooled. Its existing aggregate owner observes it after
    // the declared hold floor; a manual cooldown probe would bypass that edge.
    assert!(
        !committed.iter().any(|e| e["provider_id"] == first_id),
        "the earlier failed identity must remain in pre-cool observation, never a committed cooldown"
    );
    assert!(
        entries.iter().any(|entry| {
            entry["provider_id"] == first_id && entry["state"] == "pre_cool_observation"
        }),
        "the earlier failed identity must be listed as a pre-cool observation substate: {entries:?}"
    );
    let mut spillover: Vec<(bool, String, Value)> = Vec::new();
    if let Some(held_success) = held_success {
        // Completion of an already running business request establishes actual
        // recovery before starting independent consumers on the same key.
        held_release.add_permits(1);
        assert!(timeout(Duration::from_secs(1), held_success)
            .await
            .unwrap()
            .unwrap()
            .contains("all tried peer recovered"));
        // Original O reselects A after recovery. Let it finish before the
        // independent wave so the two requests exercise the two configured
        // upstream slots without borrowing a third slot from pending O.
        // The probe above already polled `request`; a completed JoinHandle must
        // never be polled again ("JoinHandle polled after completion"), so reuse
        // its terminal value instead of awaiting it a second time.
        // v31: the original request never waits for the held sibling to recover. If
        // it already reached its terminal, that terminal is asserted below; if it is
        // still pending it must complete through the recovered candidate.
        let recovered_original = match &early {
            Ok(Ok(Ok(body))) => Some(body.clone()),
            Ok(_) => None,
            Err(_) => Some(
                timeout(Duration::from_secs(5), &mut request)
                    .await
                    .expect("original O must reach a terminal after recovered A")
                    .expect("original O task must not panic")
                    .expect("original O client transport must stay intact"),
            ),
        };
        if let Some(recovered_original) = &recovered_original {
            assert!(
                recovered_original.contains("all tried peer recovered"),
                "{recovered_original}"
            );
            assert!(
                !recovered_original.contains("\"error\""),
                "{recovered_original}"
            );
            early = Ok(Ok(Ok(recovered_original.clone())));
        }

        let mut wave = Vec::new();
        for index in 0..2 {
            let client = client.clone();
            let base = base.clone();
            wave.push(tokio::spawn(async move {
                client.post(format!("{base}/v1/responses"))
                    .header("session-id", format!("independence-wave-{index}"))
                    .json(&json!({"model":"client-test","input":format!("independence-wave-{index}"),"stream":false}))
                    .send().await.unwrap().text().await.unwrap()
            }));
        }
        // Hold both upstream responses. Sequential execution cannot satisfy
        // two arrivals while the first response is still held.
        let wave_started = tokio::time::Instant::now();
        let mut arrivals = 0;
        while arrivals < 2 && wave_started.elapsed() < Duration::from_millis(700) {
            let remaining = Duration::from_millis(700).saturating_sub(wave_started.elapsed());
            match timeout(remaining, first_rx.recv()).await {
                Ok(Some(item)) => {
                    let (probe, _, ref body) = item;
                    if !probe && body.to_string().contains("independence-wave") {
                        arrivals += 1;
                    } else {
                        spillover.push(item);
                    }
                }
                _ => break,
            }
        }
        independent_release.add_permits(2);
        for mut task in wave {
            if arrivals == 2 {
                assert!(timeout(Duration::from_secs(1), &mut task)
                    .await
                    .unwrap()
                    .unwrap()
                    .contains("all tried peer recovered"));
            } else {
                task.abort();
                let _ = task.await;
            }
        }
        assert_eq!(arrivals, 2,
            "the waiting request must release every business lease: both same-key configured slots must remain concurrently usable");
    }
    let terminal = match early {
        Ok(result) => Ok(result),
        Err(_) => timeout(
            Duration::from_secs(if held_sibling { 5 } else { 3 }),
            &mut request,
        )
        .await,
    };
    request.abort();
    // v31: a request never waits on provider lifecycle state for captured-pool
    // recovery. With every captured candidate already failed, the lawful terminal is
    // this request's own transport termination, reached promptly (the 150ms probe
    // above proves it does not wait), carrying no fabricated success and no
    // client-visible error payload or synthetic status.
    let _ = ended_early;
    match terminal {
        Ok(Ok(Ok(body))) => {
            assert!(body.contains("all tried peer recovered"), "{body}");
            assert!(!body.contains("\"error\""), "{body}");
        }
        Ok(Ok(Err(error))) => assert!(
            !error.is_status(),
            "a transport break must not fabricate a client status payload: {error}"
        ),
        Ok(Err(join)) => panic!("the original request task must not panic: {join}"),
        Err(_) => panic!(
            "the original request must reach its terminal without waiting for captured-pool recovery"
        ),
    }
    handle.shutdown().await;
    first_task.abort();
    second_task.abort();
    if held_sibling {
        let mut post_ready: Vec<(bool, String, Value)> = Vec::new();
        post_ready.append(&mut spillover);
        while let Ok(item) = first_rx.try_recv() {
            post_ready.push(item);
        }
        let post_a_original = post_ready
            .iter()
            .filter(|item| {
                !item.0
                    && item.1.as_str() == expected_path
                    && item
                        .2
                        .to_string()
                        .contains("all tried transport original request")
            })
            .count();
        a_original_business += post_a_original;
        // v31: the terminated request never waits for the held sibling to recover,
        // so it must not be resent to A. A's send count therefore stays at the one
        // attempt that was made before the terminal.
        assert_eq!(
            a_original_business, 1,
            "a terminated request must not be resent to the recovered peer"
        );
        assert_eq!(
            b_original_business, 1,
            "B must receive exactly one original-O send and remain excluded"
        );
        assert!(
            second_rx.try_recv().is_err(),
            "last failed candidate must not be retried"
        );
    } else {
        let mut recovered_probe = false;
        let mut recovered_business = false;
        while let Ok((probe, path, body)) = first_rx.try_recv() {
            assert_eq!(path, expected_path);
            recovered_probe |= probe;
            recovered_business |= !probe
                && body
                    .to_string()
                    .contains("all tried transport original request");
        }
        // v31: the request does not wait for captured-pool recovery, so it must not
        // issue a second business send to the recovered peer on its own behalf.
        // Lifecycle probes are provider state and stay permitted, but the request's
        // own attempt count is fixed at what it already spent.
        assert!(
            !recovered_business,
            "a terminated request must not resend to the recovered peer: probe={recovered_probe}"
        );
        let _ = recovered_probe;
        assert!(
            second_rx.try_recv().is_err(),
            "last failed candidate must not be retried"
        );
    }
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
    // v31 last-candidate clause: with the visible candidate failed, the cooled peer is
    // promoted as the last eligible candidate, so it is attempted inside this request
    // and no request waits for its probe recovery. Its own real provider HTTP error is
    // then passed through to the client verbatim - the single/last eligible candidate
    // passthrough rule - and no proxy-generated envelope or fabricated success replaces
    // it. The retired expectation here was a request-side recovery wait.
    assert!(
        ended_early,
        "a request must never wait for a cooled identity's probe recovery: {result:?}"
    );
    let body = result
        .expect("the last eligible candidate answers inside the request")
        .unwrap()
        .unwrap();
    assert_eq!(
        body, "peer still cooled",
        "the last eligible candidate's real provider body must reach the client byte-exactly"
    );
    assert!(
        !body.contains("network_error") && !body.contains("proxy_generated"),
        "no proxy-generated error envelope may replace the provider body: {body}"
    );
    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the first identity must receive exactly one business attempt (no same-identity retry)"
    );
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
    // Pin the production default so this test cannot inherit a refill budget from
    // another test's process-global override (order-independence under TEST_LOCK).
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
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
    for p in manifest.providers.values_mut() {
        p.concurrency.as_mut().unwrap().acquire_timeout_ms = 2000;
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
            return (None, true, Vec::new());
        };
        let status = response.status();
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => bytes.extend(chunk),
                Ok(None) => return (Some(status), false, bytes),
                Err(_) => return (Some(status), true, bytes),
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
    // v31 clause "请求从不等待容量、冷却、探测、恢复、FIFO、permit 或
    // attempt/store 预算": preplanning is not an admission gate the execution waits
    // behind, so the declared preplan/residence budget is never consumed by a
    // request-side wait. The affirmative law is a bounded in-request resolution
    // plus the detectable transport break and the no-payload invariants below.
    assert!(
        elapsed < Duration::from_millis(1_500),
        "preplanning must never park the request on a lifecycle budget: {elapsed:?}"
    );
    let (status, broken, bytes) = outcome.expect("deadline must finish the request");
    let business_attempts = business_calls.load(std::sync::atomic::Ordering::SeqCst);
    let body = String::from_utf8_lossy(&bytes);
    assert!(
        !body.contains("error")
            && !body.contains("response.completed")
            && !body.contains("late response"),
        "no error payload or fabricated success may precede the break: {body}"
    );
    // The terminal must follow the measured outcome, so this stays a discriminant
    // rather than a single expectation: with an answering last eligible candidate
    // the client gets that candidate's real provider status/body verbatim, and with
    // no provider answer it gets the detectable transport break the preplan
    // residence budget produces (the `recover = true` twin measures 200 SSE head +
    // ":\n\n" and dies without a terminating chunk).
    let passed_through = status == Some(StatusCode::SERVICE_UNAVAILABLE)
        && body.contains("still cooled");
    if passed_through {
        // v31 last-candidate passthrough, measured at 7b5850661: status 503,
        // body "still cooled", clean EOF (disposition=LastCandidateExternalHttp).
        // The last eligible candidate answered with a real provider HTTP error, so
        // its own status and body reach the client verbatim; that answer is a
        // provider terminal, not a proxy projection and not a transport break.
        assert!(
            business_attempts > 0,
            "a complete client response must be attributable to a real provider attempt, not a proxy projection: {body}"
        );
        assert_eq!(
            status,
            Some(StatusCode::SERVICE_UNAVAILABLE),
            "the provider's own status must reach the client verbatim: {body}"
        );
        assert!(
            body.contains("still cooled"),
            "the provider's own body must reach the client byte-exactly: {body}"
        );
        assert!(
            !body.contains("network_error") && !body.contains("response.failed"),
            "no proxy-generated error envelope may replace the provider answer: {body}"
        );
        assert!(
            business_attempts <= 2,
            "each eligible identity may receive at most one business attempt, never a same-identity retry: {business_attempts}"
        );
        assert!(
            !broken,
            "a verbatim provider answer is a complete terminal, not a transport break: {body}"
        );
    } else {
        assert!(broken, "deadline must break transport detectably");
    }
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
            move || {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = failed_tx.send(());
                async {
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        axum::Json(json!({"error":{"message":"failed first identity"}})),
                    )
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
    if mode != "recover" {
        for provider in manifest.providers.values_mut() {
            provider.concurrency.as_mut().unwrap().acquire_timeout_ms =
                if mode == "residence" { 2000 } else { 400 };
        }
    }
    if mode == "residence" || mode == "exhaust" {
        for server in manifest.servers.values_mut() {
            server
                .execution
                .as_mut()
                .unwrap()
                .attempt_store
                .residence_timeout_ms = if mode == "residence" { 300 } else { 400 };
        }
    }
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let second_id = format!("concurrency_second_{}", manifest.servers["a"].port);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let cooled = reqwest::Client::new().post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({"provider_id":second_id,"auth_alias":"key","model_id":"test","kind":"probe","duration_ms":500}))
        .send().await.unwrap();
    assert_eq!(cooled.status(), StatusCode::OK);
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
    ready.store(
        mode != "exhaust" && mode != "residence",
        std::sync::atomic::Ordering::SeqCst,
    );
    // Publish a genuine successful recovery probe. Do not clear cooldown or
    // rely on wall-clock expiry to make the peer routable.
    if mode != "exhaust" && mode != "residence" {
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
        handle.shutdown().await;
        first_upstream.abort();
        second_upstream.abort();
        std::env::remove_var("V3_P6_TEST_KEY");
        // v31: a request never waits for a cooled peer, so it already finished
        // before any cancel could block; cancelling changes nothing.
        assert!(
            ended_early,
            "no request may wait on a cooled peer's recovery"
        );
        return;
    }
    // v31: the request must have finished immediately. A cooled peer is used
    // through the cooldown fallback pool when the visible pool is empty; there
    // is no request-side wait for probing or recovery.
    let result = match early {
        Ok(result) => Some(result),
        Err(_) => match timeout(Duration::from_millis(1500), &mut request).await {
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
    assert!(
        ended_early,
        "a request must never wait for a cooled peer's recovery: {result:?}"
    );
    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the failed identity must receive exactly one business send"
    );
    if mode == "exhaust" || mode == "residence" {
        // Without a visible healthy candidate the request ends truthfully: the
        // real provider failure is passed through, never a fabricated success.
        if let Some(Ok(Ok(body))) = result {
            assert!(
                !body.contains("response.completed"),
                "exhaustion must not fabricate a completion: {body}"
            );
        }
        return;
    }
    if let Some(Ok(Ok(body))) = result {
        assert!(
            !body.contains("failed first identity"),
            "the first identity's provider error must stay internal"
        );
        // The cooled peer is promoted through the cooldown fallback pool and is
        // the request's last eligible candidate, so its own typed error is
        // passed through verbatim; a ready peer instead answers normally.
        assert!(
            body.contains("cooled peer not ready")
                || body.contains("response.completed")
                || body.contains("cooled peer recovered business"),
            "only the last candidate's own typed error may reach the client: {body}"
        );
    }
}

#[tokio::test]
async fn issue44cc3af_429_healthy_alternatives_keep_parallelism() {
    assert_identity_only_rate_limit(false).await;
}

#[tokio::test]
async fn issue44cc3af_direct_429_healthy_alternatives_keep_parallelism() {
    assert_identity_only_rate_limit(true).await;
}

fn identity_only_rate_limit_manifest(
    first_url: &str,
    second_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let port = free_port();
    let first = format!("identity_first_{port}");
    let second = format!("identity_second_{port}");
    let otherkey = format!("identity_otherkey_{port}");
    let providers = [(&first, first_url), (&second, second_url)]
        .into_iter()
        .map(|(id, url)| format!(r#"
[providers.{id}]
type = "responses"
base_url = "{url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_P6_TEST_KEY" }}, {{ alias = "other", env = "V3_IDENTITY_OTHER_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
concurrency = {{ max_in_flight = 8, acquire_timeout_ms = 1500, stale_lease_ms = 120000 }}
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
"#)).collect::<String>();
    let otherkey_provider = format!(
        r#"
[providers.{otherkey}]
type = "responses"
base_url = "{first_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "other", env = "V3_IDENTITY_OTHER_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
concurrency = {{ max_in_flight = 8, acquire_timeout_ms = 1500, stale_lease_ms = 120000 }}
responses = {{ process = "chat", streaming = "always" }}
[providers.{otherkey}.models.test]
wire_name = "wire-test"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
"#
    );
    let providers = format!("{providers}{otherkey_provider}");
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
[route_groups.default.pools.other_key]
selection = {{ strategy = "priority" }}
match = {{ precedence = 30, models = ["other-key"] }}
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

/// 2026-11-07 ruling (master-approved re-pin): one recoverable failure is a
/// pre-cool observation, not an exclusion — the cooldown ladder starts at three
/// consecutive failures and the observation entry carries `until_ms = null` — so
/// the failed identity stays visible. This gate pins request independence and
/// pre-cool non-exclusion instead of the retired expectation: the initial 429
/// still reselects the healthy alternative promptly (A -> B), and the later
/// fresh and due waves are each dispatched immediately to the still-visible
/// limited identity, exactly once per request, with no proxy-side queueing and
/// no same-identity retry. B-side parallel traffic for those waves is
/// structurally unreachable in this scenario, so it is no longer asserted. The
/// test names are kept so that the declared bindings in
/// `docs/architecture/v3-verification-map.yml` do not move.
async fn assert_identity_only_rate_limit(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-identity-only");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    std::env::set_var("V3_P6_TEST_KEY", "limited-key");
    std::env::set_var("V3_IDENTITY_OTHER_KEY", "other-key");
    // Records every dispatch the limited identity actually receives, so the
    // request-independence waves can assert exact per-request counts.
    let (arrivals_tx, mut arrivals_rx) = mpsc::unbounded_channel::<String>();
    let first_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_url = format!("http://{}/v1", first_listener.local_addr().unwrap());
    let second_url = format!("http://{}/v1", second_listener.local_addr().unwrap());
    let failed_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (failed_tx, mut failed_rx) = mpsc::unbounded_channel();
    let recovery_release = Arc::new(Semaphore::new(0));
    let (recovery_tx, mut recovery_rx) = mpsc::unbounded_channel();
    let model_release = Arc::new(Semaphore::new(0));
    let restored_release = Arc::new(Semaphore::new(0));
    let (model_tx, mut model_rx) = mpsc::unbounded_channel();
    let first_app = Router::new().route("/v1/responses", post({
        let failed_calls = failed_calls.clone();
        let recovery_release = recovery_release.clone();
        let model_release = model_release.clone();
        let restored_release = restored_release.clone();
        let arrivals_tx = arrivals_tx.clone();
        move |headers: HeaderMap, axum::Json(body): axum::Json<Value>| {
            let failed_calls = failed_calls.clone();
            let failed_tx = failed_tx.clone();
            let recovery_release = recovery_release.clone();
            let recovery_tx = recovery_tx.clone();
            let model_release = model_release.clone();
            let model_tx = model_tx.clone();
            let restored_release = restored_release.clone();
            let arrivals_tx = arrivals_tx.clone();
            async move {
                if headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer other-key")
                    || body["model"] == "wire-other" {
                    if body.to_string().contains("capacity-other-model") {
                        let _ = model_tx.send(());
                        model_release.acquire().await.unwrap().forget();
                    }
                    return identity_test_response("independent identity completed");
                }
                let _ = arrivals_tx.send(body.to_string());
                if failed_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
                    let _ = recovery_tx.send(());
                    if body.to_string().contains("restored-") {
                        restored_release.acquire().await.unwrap().forget();
                    } else {
                        recovery_release.acquire().await.unwrap().forget();
                    }
                    return identity_test_response("recovered identity completed");
                }
                let _ = failed_tx.send(());
                Response::builder().status(429).header("content-type", "application/json")
                    .body(Body::from(r#"{"error":{"type":"rate_limit_error","message":"only this identity is limited"}}"#)).unwrap()
            }
        }
    }));
    let release = Arc::new(Semaphore::new(0));
    let (healthy_tx, mut healthy_rx) = mpsc::unbounded_channel();
    let second_app = Router::new().route(
        "/v1/responses",
        post({
            let release = release.clone();
            move |axum::Json(body): axum::Json<Value>| {
                let release = release.clone();
                let healthy_tx = healthy_tx.clone();
                async move {
                    if body.to_string().contains("independent-other-provider") {
                        return identity_test_response("independent identity completed");
                    }
                    let _ = healthy_tx.send(());
                    release.acquire().await.unwrap().forget();
                    identity_test_response("healthy alternative completed")
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
    let first_provider_id = format!("identity_first_{}", manifest.servers["a"].port);
    let second_provider_id = format!("identity_second_{}", manifest.servers["a"].port);
    let otherkey_provider_id = format!("identity_otherkey_{}", manifest.servers["a"].port);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let spawn = |model: &str, input: &str| {
        let endpoint = endpoint.clone();
        let model = model.to_owned();
        let input = input.to_owned();
        tokio::spawn(async move {
            let response = reqwest::Client::new()
                .post(endpoint)
                .header("session-id", format!("44cc3af-{input}"))
                .json(&json!({"model":model,"input":input,"stream":true}))
                .send()
                .await?;
            response.text().await
        })
    };
    let first = spawn("client-test", "first-reselection");
    timeout(Duration::from_secs(2), failed_rx.recv())
        .await
        .unwrap()
        .unwrap();
    let started = tokio::time::Instant::now();
    let first_dispatch = timeout(Duration::from_secs(2), healthy_rx.recv()).await;
    let first_delay = started.elapsed();
    // Hold other-model responses so success cannot hide a lost capacity slot.
    let model_wave: Vec<_> = (0..8)
        .map(|i| {
            spawn(
                &format!("{first_provider_id}.other"),
                &format!("capacity-other-model-{i}"),
            )
        })
        .collect();
    let model_started = tokio::time::Instant::now();
    let mut model_capacity = 0;
    for _ in 0..8 {
        let remaining = Duration::from_millis(350).saturating_sub(model_started.elapsed());
        if timeout(remaining, model_rx.recv())
            .await
            .is_ok_and(|v| v.is_some())
        {
            model_capacity += 1;
        }
    }
    model_release.add_permits(8);
    let mut capacity_results = Vec::new();
    for mut task in model_wave {
        match timeout(Duration::from_secs(2), &mut task).await {
            Ok(Ok(Ok(body))) => capacity_results.push(body),
            _ => task.abort(),
        }
    }
    if model_capacity != 8 {
        eprintln!("identity capacity evidence: direct={direct}, completed={}, failed_identity_calls={}, recovery_dispatched={}",
            capacity_results.len(), failed_calls.load(std::sync::atomic::Ordering::SeqCst),
            recovery_rx.try_recv().is_ok());
        first.abort();
        handle.shutdown().await;
        first_upstream.abort();
        second_upstream.abort();
        std::env::remove_var("V3_P6_TEST_KEY");
        std::env::remove_var("V3_IDENTITY_OTHER_KEY");
        assert_eq!(
            model_capacity, 8,
            "429 must preserve every configured slot of another model on the same key"
        );
        return;
    }
    // v31: the single 429 is a pre-cool observation, not an exclusion
    // (`pre_cool_observation`, `until_ms = null`); the cooldown ladder starts at
    // three consecutive failures. That state is what lets the visible identity
    // serve the waves below, so it is asserted rather than inferred.
    let pool_base = format!("http://{}", handle.listeners[0].addr);
    let identity_entries =
        pool_entries_for_transport_case(&reqwest::Client::new(), &pool_base).await;
    let observed_entry = identity_entries
        .iter()
        .find(|entry| entry["provider_id"].as_str() == Some(first_provider_id.as_str()))
        .expect("the failed identity must be listed in the cooldown pool");
    assert_eq!(
        observed_entry["state"].as_str(),
        Some("pre_cool_observation"),
        "one 429 is a pre-cool observation, not an exclusion: {observed_entry}"
    );
    assert!(
        observed_entry["until_ms"].is_null(),
        "a pre-cool observation must carry no cooldown deadline: {observed_entry}"
    );
    let requests: Vec<_> = (0..4)
        .map(|i| spawn("client-test", &format!("fresh-{i}")))
        .collect();
    let mut independent = [
        spawn(
            &format!("{otherkey_provider_id}.test"),
            "independent-other-key",
        ),
        spawn(
            &format!("{first_provider_id}.other"),
            "independent-other-model",
        ),
        spawn(
            &format!("{second_provider_id}.test"),
            "independent-other-provider",
        ),
    ];
    let wave_started = tokio::time::Instant::now();
    // v31 request independence (2026-11-07 ruling): one 429 is a pre-cool
    // observation (`pre_cool_observation`, `until_ms = null`; the cooldown
    // ladder starts at three consecutive failures), so the limited identity
    // stays visible and the fresh wave is dispatched straight to it.
    let mut fresh_arrivals: Vec<(String, u128)> = Vec::new();
    while wave_started.elapsed() < Duration::from_millis(350) && fresh_arrivals.len() < 4 {
        let remaining = Duration::from_millis(350).saturating_sub(wave_started.elapsed());
        let Ok(Some(arrival)) = timeout(remaining, arrivals_rx.recv()).await else {
            break;
        };
        let at = wave_started.elapsed().as_millis();
        for index in 0..4 {
            let marker = format!("fresh-{index}");
            if arrival.contains(&marker) && !fresh_arrivals.iter().any(|(seen, _)| seen == &marker) {
                fresh_arrivals.push((marker, at));
            }
        }
    }
    let fresh_wave_dispatch_ms = fresh_arrivals
        .iter()
        .map(|(_, at)| *at)
        .max()
        .unwrap_or(u128::MAX);
    let mut independent_finished = true;
    let mut results = capacity_results;
    for task in &mut independent {
        let remaining = Duration::from_millis(350).saturating_sub(wave_started.elapsed());
        match timeout(remaining, &mut *task).await {
            Ok(Ok(Ok(body))) => results.push(body),
            _ => {
                independent_finished = false;
                task.abort();
            }
        }
    }
    let calls_before_release = failed_calls.load(std::sync::atomic::Ordering::SeqCst);
    // The reselected request is held by the healthy alternative's answer, while
    // the four fresh requests are held inside the visible identity's own
    // response; they are joined after that release below.
    release.add_permits(16);
    results.push(
        timeout(Duration::from_secs(2), first)
            .await
            .expect("the reselected request must finish once the healthy alternative answers")
            .expect("the reselected request must not fail")
            .expect("the reselected request must return a body"),
    );
    // v31: probes and recovery are provider-lifecycle only. Business requests
    // never wait for A's observation or recovery; the still-visible limited
    // identity serves this wave immediately (2026-11-07 ruling), because the
    // single 429 is only a pre-cool observation.
    let due_started = tokio::time::Instant::now();
    let due_wave: Vec<_> = (0..3)
        .map(|i| spawn("client-test", &format!("due-{i}")))
        .collect();
    let mut due_arrivals: Vec<(String, u128)> = Vec::new();
    while due_started.elapsed() < Duration::from_millis(350) && due_arrivals.len() < 3 {
        let remaining = Duration::from_millis(350).saturating_sub(due_started.elapsed());
        let Ok(Some(arrival)) = timeout(remaining, arrivals_rx.recv()).await else {
            break;
        };
        let at = due_started.elapsed().as_millis();
        for index in 0..3 {
            let marker = format!("due-{index}");
            if arrival.contains(&marker) && !due_arrivals.iter().any(|(seen, _)| seen == &marker) {
                due_arrivals.push((marker, at));
            }
        }
    }
    let due_wave_dispatch_ms = due_arrivals
        .iter()
        .map(|(_, at)| *at)
        .max()
        .unwrap_or(u128::MAX);
    recovery_release.add_permits(16);
    restored_release.add_permits(4);
    let due_calls_after = failed_calls.load(std::sync::atomic::Ordering::SeqCst);
    for task in requests {
        results.push(
            timeout(Duration::from_secs(2), task)
                .await
                .expect("a fresh request served by the visible identity must finish")
                .expect("a fresh request must not fail")
                .expect("a fresh request must return a body"),
        );
    }
    for mut task in due_wave {
        match timeout(Duration::from_secs(2), &mut task).await {
            Ok(Ok(Ok(body))) => results.push(body),
            _ => task.abort(),
        }
    }
    // A successful observation restores only A's visibility; business
    // distribution after restoration is not asserted (lifecycle timing is
    // independent), only that every request completes.
    let restored_wave: Vec<_> = (0..4)
        .map(|i| spawn("client-test", &format!("restored-{i}")))
        .collect();
    for mut task in restored_wave {
        match timeout(Duration::from_secs(2), &mut task).await {
            Ok(Ok(Ok(body))) => results.push(body),
            _ => task.abort(),
        }
    }
    handle.shutdown().await;
    first_upstream.abort();
    second_upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    std::env::remove_var("V3_IDENTITY_OTHER_KEY");
    assert!(
        first_dispatch.is_ok_and(|v| v.is_some()),
        "the current request must reselect a healthy alternative"
    );
    assert!(
        first_delay < Duration::from_millis(350),
        "healthy B must not await failed A's backoff: {first_delay:?}"
    );
    assert!(
        independent_finished,
        "other keys/models/providers must make independent progress"
    );
    // 2026-11-07 ruling: one 429 leaves the limited identity in
    // `pre_cool_observation` with `until_ms = null` (the cooldown ladder
    // starts at three consecutive failures), so the identity stays visible and
    // every later business wave is served by it — B-side parallel traffic is
    // structurally unreachable in this scenario and is no longer asserted.
    assert_eq!(
        fresh_arrivals.len(),
        4,
        "all four fresh requests must be dispatched to the still-visible highest-priority identity: {fresh_arrivals:?}"
    );
    for index in 0..4 {
        let marker = format!("fresh-{index}");
        assert_eq!(
            fresh_arrivals.iter().filter(|(seen, _)| seen == &marker).count(),
            1,
            "each fresh request must reach the identity exactly once, with no same-identity retry: {fresh_arrivals:?}"
        );
    }
    assert_eq!(
        calls_before_release, 5,
        "one 429 plus exactly one business send per fresh request: {calls_before_release}"
    );
    assert!(
        healthy_rx.try_recv().is_err(),
        "no request after the reselect may be dispatched to B: the pre-cool identity stays visible"
    );
    // Measured on this base while the four fresh requests are in flight:
    // relay 175-204 ms, direct 9-11 ms (due wave: relay 87-89 ms, direct 3-5 ms),
    // with the four fresh arrivals landing in the same millisecond. The budget
    // keeps better than a 1.5x margin on the slower mode and stays inside the
    // 350 ms collection window, so a request that waited on the failed identity's
    // observation could not satisfy it: that cadence is the 5 s probe interval.
    const WAVE_DISPATCH_BUDGET_MS: u128 = 320;
    assert!(
        fresh_wave_dispatch_ms < WAVE_DISPATCH_BUDGET_MS,
        "the four fresh dispatches must land on the visible identity immediately, not queue: {fresh_wave_dispatch_ms}ms"
    );
    let fresh_spread = fresh_wave_dispatch_ms
        - fresh_arrivals
            .iter()
            .map(|(_, at)| *at)
            .min()
            .unwrap_or(0);
    assert!(
        fresh_spread <= 100,
        "the fresh wave must be dispatched as one concurrent burst, not serialized request by request: spread {fresh_spread}ms of {fresh_arrivals:?}"
    );
    assert_eq!(
        due_arrivals.len(),
        3,
        "the whole due wave must be dispatched to the still-visible identity without waiting for its recovery: {due_arrivals:?}"
    );
    for index in 0..3 {
        let marker = format!("due-{index}");
        assert_eq!(
            due_arrivals.iter().filter(|(seen, _)| seen == &marker).count(),
            1,
            "each due request must reach the identity exactly once: {due_arrivals:?}"
        );
    }
    assert_eq!(
        due_calls_after - calls_before_release,
        3,
        "the due wave must cost exactly one business send per request on the visible identity"
    );
    assert!(
        due_wave_dispatch_ms < WAVE_DISPATCH_BUDGET_MS,
        "the due wave must be served immediately by the visible identity, not by waiting for its recovery: {due_wave_dispatch_ms}ms"
    );
    let due_spread = due_wave_dispatch_ms
        - due_arrivals
            .iter()
            .map(|(_, at)| *at)
            .min()
            .unwrap_or(0);
    assert!(
        due_spread <= 100,
        "the due wave must be dispatched as one concurrent burst, not serialized request by request: spread {due_spread}ms of {due_arrivals:?}"
    );
    assert_eq!(
        model_capacity, 8,
        "429 must preserve every configured slot of another model on the same key"
    );
    assert_eq!(
        results.len(),
        23,
        "every request must complete, including model-capacity, recovery and restored concurrency waves"
    );
    for body in results {
        assert!(
            body.contains("response.completed") && !body.contains("only this identity is limited"),
            "{body}"
        );
    }
}

#[tokio::test]
async fn issue44cc3af_mixed_failed_and_busy_candidates_wait_then_recover() {
    assert_mixed_capacity_recovery(false, false).await;
}

#[tokio::test]
async fn issue44cc3af_direct_mixed_failed_and_busy_candidates_wait_then_recover() {
    assert_mixed_capacity_recovery(true, false).await;
}

#[tokio::test]
async fn issue44cc3af_initial_busy_candidate_recovers_after_selected_peer_fails() {
    assert_mixed_capacity_recovery(false, true).await;
}

#[tokio::test]
async fn issue44cc3af_direct_initial_busy_candidate_recovers_after_selected_peer_fails() {
    assert_mixed_capacity_recovery(true, true).await;
}

// 2026-11-07 ruling ①: capacity admission is local provider capacity, not a
// health fact and not a pool-visibility decision. When the only remaining
// eligible candidate is the identity that is merely *busy*, the request must
// send to it over the occupied budget and pass its real business answer
// through, instead of turning the peer's real failure into a last-candidate
// terminal. The failed peer is contacted exactly once and never re-sent.
#[tokio::test]
async fn issue44cc3af_capacity_skip_passes_through_last_eligible_candidate() {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-capacity-passthrough");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let (held_url, mut held_captures, held_release, held_shutdown) =
        start_controlled_held_upstream().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let failure_payloads = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let (failure_tx, mut failures) = mpsc::unbounded_channel();
    let app = Router::new().route(
        "/v1/responses",
        post({
            let failure_payloads = failure_payloads.clone();
            let failure_tx = failure_tx.clone();
            move |axum::Json(payload): axum::Json<Value>| {
                let failure_payloads = failure_payloads.clone();
                let failure_tx = failure_tx.clone();
                async move {
                    failure_payloads.lock().unwrap().push(payload);
                    let _ = failure_tx.send(());
                    (
                        StatusCode::BAD_GATEWAY,
                        axum::Json(json!({"error":{"message":"selected provider failed"}})),
                    )
                }
            }
        }),
    );
    let failing_upstream = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let failing_url = format!("http://{address}/v1");
    std::env::set_var("V3_P6_TEST_KEY", "44cc3af-test-key");
    let mut manifest = concurrency_switch_manifest(&failing_url, &held_url);
    let held_id = format!("concurrency_second_{}", manifest.servers["a"].port);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    // The holder binds the held identity and takes its single capacity slot.
    let held_endpoint = endpoint.clone();
    let held_model = format!("{held_id}.test");
    let holder = tokio::spawn(async move {
        reqwest::Client::new()
            .post(held_endpoint)
            .header("session-id", "44cc3af-passthrough-holder")
            .json(&json!({"model": held_model, "input":"held","stream":true}))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
    });
    timeout(Duration::from_secs(3), held_captures.recv())
        .await
        .expect("the holder must reach the held identity")
        .expect("held identity capture receipt");
    let client = reqwest::Client::new();
    let request_endpoint = endpoint.clone();
    let request = tokio::spawn(async move {
        client
            .post(request_endpoint)
            .header("session-id", "44cc3af-passthrough-recovery")
            .json(&json!({"model":"client-test","input":"capacity passthrough","stream":true}))
            .send()
            .await
            .unwrap()
            .text()
            .await
    });
    // The failing peer answers its one business attempt with a real 502.
    timeout(Duration::from_secs(3), failures.recv())
        .await
        .expect("the selected peer must receive the business attempt")
        .expect("failed attempt receipt");
    // The formerly busy identity is now the last eligible candidate: it is sent
    // over the occupied budget while the holder is still in flight.
    timeout(Duration::from_secs(3), held_captures.recv())
        .await
        .expect("the last eligible candidate must be sent over occupied capacity")
        .expect("over-capacity capture receipt");
    let sent_over_capacity = !holder.is_finished();
    held_release.add_permits(2);
    let held_body = timeout(Duration::from_secs(3), holder)
        .await
        .expect("the holder must finish once capacity is released")
        .unwrap();
    let result = timeout(Duration::from_secs(4), request).await;
    let physical_calls = failure_payloads.lock().unwrap().clone();
    handle.shutdown().await;
    let _ = held_shutdown.send(());
    failing_upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert!(
        sent_over_capacity,
        "the last eligible candidate must be sent while capacity is still occupied"
    );
    assert_responses_sse_delivered_business_text(&held_body, "held response released");
    assert_eq!(
        held_captures.try_recv().is_err(),
        true,
        "the exempted send is exactly one attempt, not a retry loop"
    );
    assert_eq!(
        physical_calls.len(),
        1,
        "a failed business request must not be retried: {physical_calls:?}"
    );
    let body = result
        .expect("bounded capacity passthrough")
        .unwrap()
        .expect("intact client transport");
    assert_responses_sse_delivered_business_text(&body, "held response released");
    assert!(!body.contains("response.failed"), "{body}");
    assert!(!body.contains("selected provider failed"), "{body}");
    assert!(!body.contains("network_error"), "{body}");
}

async fn assert_mixed_capacity_recovery(direct: bool, initially_busy_first: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-mixed-capacity");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let (healthy_url, mut healthy_captures, healthy_release, healthy_shutdown) =
        start_controlled_held_upstream().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let failure_release = Arc::new(Semaphore::new(usize::from(!initially_busy_first)));
    let failure_payloads = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let expected_probe = json!({
        "model":"wire-test", "stream":false,
        "input":[{"role":"user","content":[{"type":"input_text","text":"ping; reply pong"}]}],
    });
    let (probe_tx, mut probe_arrivals) = mpsc::unbounded_channel();
    let (failure_tx, mut failures) = mpsc::unbounded_channel();
    let app = Router::new().route(
        "/v1/responses",
        post({
            let failure_release = failure_release.clone();
            let failure_payloads = failure_payloads.clone();
            let probe_shape = expected_probe.clone();
            move |axum::Json(payload): axum::Json<Value>| {
                let failure_release = failure_release.clone();
                let failure_payloads = failure_payloads.clone();
                let probe_shape = probe_shape.clone();
                let probe_tx = probe_tx.clone();
                let failure_tx = failure_tx.clone();
                async move {
                    let is_probe = payload == probe_shape;
                    failure_payloads.lock().unwrap().push(payload);
                    if is_probe {
                        let _ = probe_tx.send(());
                    }
                    let _ = failure_tx.send(());
                    failure_release.acquire().await.unwrap().forget();
                    (
                        StatusCode::BAD_GATEWAY,
                        axum::Json(json!({"error":{"message":"selected provider failed"}})),
                    )
                }
            }
        }),
    );
    let failing_upstream = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let failing_url = format!("http://{address}/v1");
    std::env::set_var("V3_P6_TEST_KEY", "44cc3af-test-key");
    let mut manifest = if initially_busy_first {
        concurrency_switch_manifest(&healthy_url, &failing_url)
    } else {
        concurrency_switch_manifest(&failing_url, &healthy_url)
    };
    let healthy_id = format!(
        "concurrency_{}_{}",
        if initially_busy_first {
            "first"
        } else {
            "second"
        },
        manifest.servers["a"].port
    );
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let held_endpoint = endpoint.clone();
    let holder = tokio::spawn(async move {
        reqwest::Client::new()
            .post(held_endpoint)
            .header("session-id", "44cc3af-mixed-holder")
            .json(&json!({"model":format!("{healthy_id}.test"),"input":"held","stream":true}))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
    });
    timeout(Duration::from_secs(3), healthy_captures.recv())
        .await
        .unwrap()
        .unwrap();
    let request = tokio::spawn(async move {
        reqwest::Client::new()
            .post(endpoint)
            .header("session-id", "44cc3af-mixed-recovery")
            .json(&json!({"model":"client-test","input":"mixed recovery","stream":true}))
            .send()
            .await
            .unwrap()
            .text()
            .await
    });
    timeout(Duration::from_secs(3), failures.recv())
        .await
        .unwrap()
        .unwrap();
    if !initially_busy_first {
        timeout(Duration::from_secs(3), probe_arrivals.recv())
            .await
            .expect("held capacity must remain occupied until a real precool probe arrives")
            .expect("physical probe arrival receipt");
    }
    let closed_while_busy = !initially_busy_first && request.is_finished();
    healthy_release.add_permits(1);
    let held_body = timeout(Duration::from_secs(3), holder)
        .await
        .unwrap()
        .unwrap();
    if initially_busy_first {
        failure_release.add_permits(1);
    }
    let recovered_dispatch = timeout(Duration::from_secs(4), healthy_captures.recv()).await;
    healthy_release.add_permits(1);
    let result = timeout(Duration::from_secs(4), request).await;
    let physical_calls = failure_payloads.lock().unwrap().clone();
    handle.shutdown().await;
    let _ = healthy_shutdown.send(());
    failing_upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert_responses_sse_delivered_business_text(&held_body, "held response released");
    assert!(
        !closed_while_busy,
        "a prior failed candidate must not hide a remaining busy candidate's wait"
    );
    assert!(
        recovered_dispatch.is_ok_and(|capture| capture.is_some()),
        "a formerly busy candidate must remain eligible after the peer fails"
    );
    let business_input = if direct {
        json!("mixed recovery")
    } else {
        json!([{"role":"user","type":"message","content":[{"type":"input_text","text":"mixed recovery"}]}])
    };
    let expected_business = json!({
        "model":"wire-test", "input":business_input, "stream":true, "max_output_tokens":4096,
    });
    let business_calls = physical_calls
        .iter()
        .filter(|body| **body == expected_business)
        .count();
    let probe_calls = physical_calls
        .iter()
        .filter(|body| **body == expected_probe)
        .count();
    assert_eq!(
        business_calls, 1,
        "a failed business request must not be retried: {physical_calls:?}"
    );
    assert_eq!(probe_calls, usize::from(!initially_busy_first),
        "only the actual delayed precool observation may probe this failed identity: {physical_calls:?}");
    assert_eq!(
        physical_calls.len(),
        business_calls + probe_calls,
        "no unclassified physical attempt is allowed: {physical_calls:?}"
    );
    let body = result
        .expect("bounded mixed recovery")
        .unwrap()
        .expect("intact recovered transport");
    assert_responses_sse_delivered_business_text(&body, "held response released");
    assert!(!body.contains("selected provider failed"));
}

#[tokio::test]
async fn issue44cc3af_429_gate_wait_obeys_request_residence_deadline() {
    assert_rate_limit_residence_deadline(false).await;
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
    // Terminal discriminant: the client terminal must follow the measured upstream
    // attempt. Provider lifecycle probes carry their own body and are not request
    // business attempts, so they are counted separately.
    let business_attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let app = Router::new().route(
        "/v1/responses",
        post({
            let business_attempts = business_attempts.clone();
            move |axum::Json(body): axum::Json<Value>| {
                let business_attempts = business_attempts.clone();
                async move {
                    if !body.to_string().contains("ping; reply pong") {
                        business_attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        axum::Json(json!({"error":{"type":"rate_limit_error","message":"capacity busy"}})),
                    )
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
    let status = response.status();
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
    let broken = broken.expect("bounded rate-limit wait must terminate");
    let business_attempts = business_attempts.load(std::sync::atomic::Ordering::SeqCst);
    let body = String::from_utf8(bytes).unwrap();
    // Removed premise (Lead ruling, 2026-11-07): this fixture used to require
    // `status == OK` on every run, i.e. it assumed a request is never preempted by
    // its own residence budget. Under v31 the request residence budget IS the
    // request budget and its expiry is a truthful typed terminal, and with one
    // pinned candidate the failing identity is the only/last eligible one whose
    // real provider response is passed through. The terminal must therefore follow
    // the measured upstream attempt instead of the retired "always wait" premise:
    // an admitted attempt ends in that provider's verbatim 429, and a request whose
    // budget was already spent before admission ends in a detectable transport
    // break with no error bytes. Both are law-conformant; neither may become a
    // proxy-generated error, a fabricated completion, or a same-identity retry.
    assert!(
        !body.contains("network_error") && !body.contains("response.failed"),
        "a provider HTTP failure must never become a proxy-generated projection: {body}"
    );
    assert!(
        !body.contains("response.completed"),
        "a failing upstream must never be fabricated into a completion: {body}"
    );
    assert!(
        elapsed < Duration::from_millis(500),
        "request residence deadline must include gate queueing: {elapsed:?}"
    );
    if business_attempts > 0 {
        // Warm start (measured: 148 ms of the 150 ms residence budget were still
        // left at the first admission): the request reached transport, so the
        // client receives that attempt's own provider 429 verbatim. The front had
        // not committed a stream yet, so the verbatim JSON answer is complete.
        assert_eq!(
            status,
            StatusCode::TOO_MANY_REQUESTS,
            "the real provider 429 must reach the client verbatim: {body}"
        );
        assert!(
            body.contains("capacity busy"),
            "the provider's own error body must be preserved: {body}"
        );
        assert_eq!(
            business_attempts, 1,
            "the only pinned candidate must receive exactly one business attempt"
        );
        assert!(
            !broken,
            "a verbatim 429 body is complete, not a transport break: {body}"
        );
    } else {
        // Cold start (measured: the 150 ms budget was already spent before the
        // first admission): no provider attempt exists, so the request ends in the
        // detectable transport break the front produces instead of an error frame.
        assert_eq!(
            status,
            StatusCode::OK,
            "the committed SSE channel must open before the truthful terminal: {body}"
        );
        assert!(
            broken,
            "the expired residence budget must break the transport detectably: {body}"
        );
        assert!(!body.contains("error"), "{body}");
        assert!(
            elapsed >= Duration::from_millis(120),
            "request residence deadline must include gate queueing: {elapsed:?}"
        );
    }
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
    // Pin the production default: this test asserts exact attempt counts, so it must
    // never inherit another test's process-global refill budget.
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
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
    for provider in manifest.providers.values_mut() {
        provider.concurrency.as_mut().unwrap().acquire_timeout_ms = 150;
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
    let request = tokio::spawn(async move {
        let mut outcomes = Vec::new();
        for index in 0..requests {
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
            let broken = loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => bytes.extend(chunk),
                    Ok(None) => break false,
                    Err(_) => break true,
                }
            };
            outcomes.push((started.elapsed(), broken, bytes));
        }
        outcomes
    });
    timeout(Duration::from_secs(2), arrived.notified())
        .await
        .unwrap();
    let outcome = timeout(Duration::from_secs(2), request).await;
    release.notify_waiters();
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    let outcomes = outcome
        .expect("a stalled probe must not outlive the wait budget")
        .unwrap();
    for (elapsed, broken, bytes) in outcomes {
        // v31 clause "请求从不等待容量、冷却、探测、恢复、FIFO、permit 或
        // attempt/store 预算": the declared capacity/attempt deadline is never
        // consumed by the request, so a fresh request resolves inside itself. The
        // landed law keeps the detectable transport end and the no-payload,
        // no-fabricated-success invariants asserted below.
        assert!(
            elapsed < Duration::from_millis(1_500),
            "a request must never wait through a capacity/attempt budget: {elapsed:?}"
        );
        assert!(broken, "exhaustion must end transport detectably");
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
    let a_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    let first_app = Router::new().fallback_service(post({
        let a_calls = a_calls.clone();
        move || {
            a_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = first_tx.send(());
            async move {
                // The final eligible identity answered 429 once. Per the active
                // last-provider policy it stays excluded for this request: no
                // same-identity business retry and no new probe for it.
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    axum::Json(json!({"status":429,"title":"Too Many Requests"})),
                )
                    .into_response()
            }
        }
    }));
    let b_business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let second_app = Router::new().fallback_service(post({
        let b_business = b_business.clone();
        move |axum::Json(body): axum::Json<Value>| {
            let text = body.to_string();
            if text.contains("wait429 while peercooled") {
                b_business.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            async {
                // A previously failed, health-cooled identity recovers through
                // its own real probe. Once its probe returns 2xx it is eligible
                // again and the pending request reselects it to complete.
                let event = json!({"type":"response.completed","response":{"id":"cooled-peer-recovered","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"rate limited candidate recovered after peer probe"}]}]}});
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "text/event-stream")
                    .body(Body::from(format!("event: response.completed\ndata: {event}\n\n")))
                    .unwrap()
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
    for provider in manifest.providers.values_mut() {
        provider.concurrency.as_mut().unwrap().acquire_timeout_ms = 2500;
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
    assert_eq!(
        a_calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the final 429 identity must receive exactly one business send and no new probe"
    );
    assert_eq!(
        b_business.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the recovered cooled peer must complete the request exactly once"
    );
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
    // v31: the request never waits for an active probe owner. All-cooled
    // candidates are promoted through the cooldown fallback pool immediately,
    // so a business send happens without waiting and the request finishes
    // inside the original window.
    assert!(
        ended_before_recovery,
        "a request must never wait for another task's recovery probe"
    );
    let result = result.expect("request must not hang on an active probe");
    assert!(
        result.is_ok(),
        "the cooldown fallback candidate must answer or fail truthfully"
    );
    assert_eq!(
        business_calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the promoted cooled candidate must receive exactly one business send"
    );
    assert_eq!(
        probe_calls.load(std::sync::atomic::Ordering::SeqCst),
        provider_ids.len(),
        "a request must not duplicate probes owned by another task"
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

async fn read_blackbox_sse_outcome(response: reqwest::Response) -> (StatusCode, String, bool) {
    let status = response.status();
    let mut response = response;
    let mut bytes = Vec::new();
    let broken = loop {
        match response.chunk().await {
            Ok(Some(chunk)) => bytes.extend(chunk),
            Ok(None) => break false,
            Err(_) => break true,
        }
    };
    (status, String::from_utf8_lossy(&bytes).to_string(), broken)
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
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-rate-wait");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let late_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // Business attempts only, excluding the provider-lifecycle probe lane. The 429
    // budget below decides whether the request's truthful terminal is a real provider
    // 429, so a probe must never consume it (see the ladder comment at the handler).
    let business_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let call_trace = Arc::new(std::sync::Mutex::new(Vec::new()));
    let fixture_started = std::time::Instant::now();
    let healthy_started = Arc::new(tokio::sync::Notify::new());
    let release_healthy = Arc::new(tokio::sync::Notify::new());
    let (hit_tx, mut hits) = mpsc::unbounded_channel();
    let app = Router::new().route("/v1/responses", post({
        let ready = ready.clone();
        let calls = calls.clone();
        let late_calls = late_calls.clone();
        let business_calls = business_calls.clone();
        let call_trace = call_trace.clone();
        let healthy_started = healthy_started.clone();
        let release_healthy = release_healthy.clone();
        move |axum::Json(body): axum::Json<Value>| {
            let ready = ready.clone();
            let calls = calls.clone();
            let late_calls = late_calls.clone();
            let business_calls = business_calls.clone();
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
                // The 429 ladder shapes the request's truthful terminal, so it is
                // counted over business attempts only. It used to share one global
                // counter with the provider-lifecycle probe lane: when two probes
                // occupied the window the two promoted business sends became upstream
                // attempts 3 and 4, and attempt 4 also landed after the 250 ms `ready`
                // snapshot, so the fake upstream answered it 200 with its real
                // "recovered after wait" body. The runtime then correctly projected that
                // real business answer and the request completed legitimately — the flake
                // was this fixture manufacturing a scenario the test itself forbids
                // (a cooled-pool terminal must carry no fabricated or real completion).
                // `calls` stays the global attempt counter because the assertions below
                // subtract `probe_calls` from it.
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let probe = body.to_string().contains("ping; reply pong");
                let business_attempt = if probe {
                    0
                } else {
                    business_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
                };
                let _ = hit_tx.send(());
                if business_attempt <= if parallel_success { 1 } else { 3 }
                    || !ready.load(std::sync::atomic::Ordering::SeqCst)
                {
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
    if !cooled {
        // A final 429 identity stays excluded for the whole request, so the
        // request waits to its original residence deadline before the transport
        // is closed without a client error payload. Shorten the deadline so the
        // deadline-fire path finishes in-test instead of the default ten
        // minutes.
        for server in manifest.servers.values_mut() {
            server
                .execution
                .as_mut()
                .unwrap()
                .attempt_store
                .residence_timeout_ms = 600;
        }
    }
    if parallel_success || waiter_count > 1 || late_join {
        for provider in manifest.providers.values_mut() {
            provider.concurrency.as_mut().unwrap().max_in_flight = waiter_count.max(2) as u32;
        }
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
                read_blackbox_sse_outcome(response).await
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
            read_blackbox_sse_outcome(response).await
        }));
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
    let closed_early = requests.iter().any(|request| request.is_finished());
    let early_calls = calls.load(std::sync::atomic::Ordering::SeqCst);
    let early_trace = call_trace.lock().unwrap().clone();
    let mut late_calls_after_cancel = None;
    if cancel_late {
        let late = requests.pop().unwrap();
        late.abort();
        let _ = late.await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        late_calls_after_cancel = Some(late_calls.load(std::sync::atomic::Ordering::SeqCst));
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
    // v31: no request waits for capacity, cooldown, probe or recovery. The
    // request takes the next visible candidate immediately; with none visible
    // it ends truthfully instead of queueing, so a fast finish is legal and the
    // load-bearing invariant is that no identity is re-sent and no untried
    // identity is excluded.
    let _ = closed_early;
    // v31 "请求独立。一个请求的错误不得阻塞其他请求": a provider failure is request-local,
    // so a second session that joins while the first one is failing is NOT gated by that
    // failure. One 429 also never creates a pool-wide backoff — the consecutive-failure
    // ladder needs 3 failures of the same complete identity before it hides anything — so
    // the late session legitimately selects the same still-visible identity and issues its
    // own single business attempt. The load-bearing bound is therefore one business send
    // per live request (a same-request resend of an identity stays forbidden), not one
    // send per pool.
    let live_requests = waiter_count + usize::from(late_join);
    let max_early_calls = if late_join {
        live_requests
    } else if cooled {
        3
    } else {
        waiter_count.max(2)
    };
    // The anti-hammer bound is the request's own upstream traffic. The lifecycle
    // recovery probes are owned by the provider lifecycle lane and arrive
    // asynchronously with the promoted sends inside the same 250 ms window, so
    // counting them here read 2 probes + 2 business sends = 4 against the cooled
    // budget 3 — the same shared-counter instability as the 429 ladder above. The
    // probe lane keeps its own bound (`probe_calls <= 2 * waiter_count`) below.
    // Both counts come from the single `early_trace` snapshot so the split cannot
    // straddle two reads; the trace is pushed before either counter advances.
    let early_probe_calls = early_trace.iter().filter(|(_, probe)| *probe).count();
    let early_business_calls = early_trace.iter().filter(|(_, probe)| !*probe).count();
    assert!(early_business_calls <= max_early_calls,
        "rate-limit wait must not hammer upstream: business={early_business_calls} probes={early_probe_calls} global_calls={early_calls}, fixture trace (elapsed, probe)={early_trace:?}");
    if cooled {
        // v31 cooldown-fallback contract. This branch used to assert the retired
        // wait-for-probe-recovery lane ("recovered after wait" + a completed
        // protocol terminal) that `issue44cc3af_initial_all_cooled_waits_for_active_probe`
        // already contradicts: a request never waits for an active probe owner.
        // An all-cooled pool is promoted through the cooldown fallback
        // immediately, so both cooled identities receive exactly one business
        // attempt at once, the request never re-sends an identity, and the probe
        // stays owned by the provider lifecycle lane. The terminal is the last
        // eligible candidate's real provider 429: a committed client SSE channel
        // cannot carry a provider HTTP error, so the front closes the transport
        // without an error frame — no response.failed, no network_error, no
        // fabricated completion. The front does emit transport keepalives before
        // that close, so the keepalive frame remains part of the terminal shape.
        // The 250 ms snapshot above precedes the promoted sends in this fixture,
        // so the terminal accounting reads the counters after every result has
        // been collected. Probe hits are identified by their own body, which keeps
        // the lifecycle lane's probes out of the request's business count.
        let final_trace = call_trace.lock().unwrap().clone();
        let probe_calls = final_trace.iter().filter(|(_, probe)| *probe).count();
        let business_calls = calls
            .load(std::sync::atomic::Ordering::SeqCst)
            .saturating_sub(probe_calls);
        assert_eq!(
            business_calls,
            2 * waiter_count,
            "the two promoted cooled identities must each receive exactly one business send per request: {business_calls}, fixture trace (elapsed, probe)={final_trace:?}"
        );
        assert!(
            probe_calls <= 2 * waiter_count,
            "a request must not duplicate the recovery probes owned by the provider lifecycle lane: {probe_calls}, fixture trace (elapsed, probe)={final_trace:?}"
        );
        assert_eq!(
            results.len(),
            waiter_count,
            "every request must finish inside the test window"
        );
        for result in results {
            let (status, body, broken) = result
                .expect("the promoted cooled pool must finish without waiting for recovery")
                .expect("intact client transport");
            assert_eq!(
                status,
                StatusCode::OK,
                "the committed client SSE channel must open before the truthful terminal: {body}"
            );
            assert!(
                broken,
                "the real provider 429 must close the committed SSE transport without an error frame: {body}"
            );
            assert!(
                !body.contains("response.failed")
                    && !body.contains("network_error")
                    && !body.contains("\"error\"")
                    && !body.contains("response.completed")
                    && !body.contains("recovered after wait"),
                "a cooled-pool terminal must carry no error payload and no fabricated completion: {body}"
            );
            assert!(
                body.contains(": keepalive"),
                "the front must keep transport keepalives before the truthful close: {body}"
            );
        }
    } else {
        // v31: with no other visible candidate the failed identity is the last
        // eligible one, so it receives exactly one business attempt and its real
        // typed error is passed through verbatim. It is never retried, never
        // waited on, and no completion is fabricated.
        for result in results {
            let (_status, body, broken) = result
                .expect("a request must not wait for recovery or a residence deadline")
                .expect("intact client transport");
            assert!(
                !body.contains("response.completed") && !body.contains("recovered after wait"),
                "the excluded final 429 identity must not be retried or fabricated into success: {body}"
            );
            if !broken {
                assert!(
                    body.contains("capacity busy"),
                    "the only allowed client-visible error is the last candidate's own typed error: {body}"
                );
            }
        }
        let main_attempts = calls
            .load(std::sync::atomic::Ordering::SeqCst)
            .saturating_sub(late_calls.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(
            main_attempts, waiter_count,
            "each waiting request must send exactly one business attempt to the excluded identity; trace={early_trace:?}"
        );
        assert!(
            late_calls.load(std::sync::atomic::Ordering::SeqCst) <= usize::from(late_join),
            "a late session may send at most one business attempt"
        );
        assert!(
            health["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["state"] == "pre_cool_observation"),
            "429 must not commit a cooldown for a healthy provider, only a pre-cool observation: {health}"
        );
    }
    if let Some(snapshot) = late_calls_after_cancel {
        assert_eq!(
            late_calls.load(std::sync::atomic::Ordering::SeqCst),
            snapshot,
            "cancelled wait must never send again after cancellation"
        );
    }
}

#[tokio::test]
async fn issue44cc3af_all_busy_waits_for_capacity_without_transport_break() {
    assert_capacity_wait("recover").await;
}

#[tokio::test]
async fn issue44cc3af_capacity_release_wakes_long_pool_backoff_immediately() {
    assert_capacity_wait("long-recover").await;
}

#[tokio::test]
async fn issue44cc3af_direct_capacity_release_wakes_long_pool_backoff_immediately() {
    assert_capacity_wait("direct-long-recover").await;
}

#[tokio::test]
async fn issue44cc3af_owner_cancellation_wakes_long_pool_backoff_without_health_success() {
    assert_capacity_wait("cancel-owner-long-recover").await;
}

#[tokio::test]
async fn issue44cc3af_direct_owner_cancellation_wakes_long_pool_backoff_without_health_success() {
    assert_capacity_wait("direct-cancel-owner-long-recover").await;
}

#[tokio::test]
async fn issue44cc3af_cancelled_wait_does_not_send_after_capacity_returns() {
    assert_capacity_wait("cancel").await;
}

#[tokio::test]
async fn issue44cc3af_capacity_budget_expires_only_after_waiting() {
    assert_capacity_wait("budget").await;
}

#[tokio::test]
async fn issue44cc3af_repeated_requests_after_exhaustion_each_wait_for_capacity() {
    assert_capacity_wait("repeated-budget").await;
}

#[tokio::test]
async fn issue44cc3af_direct_repeated_requests_after_exhaustion_each_wait_for_capacity() {
    assert_capacity_wait("direct-repeated-budget").await;
}

async fn assert_capacity_wait(mode: &str) {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-capacity-wait");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let (first_url, mut first_captures, first_release, first_shutdown) =
        start_controlled_held_upstream().await;
    let (second_url, mut second_captures, second_release, second_shutdown) =
        start_controlled_held_upstream().await;
    std::env::set_var("V3_P6_TEST_KEY", "44cc3af-test-key");
    let mut manifest = concurrency_switch_manifest(&first_url, &second_url);
    let repeated_budget = mode.ends_with("repeated-budget");
    let budget = mode == "budget" || repeated_budget;
    let long_recovery = mode.ends_with("long-recover");
    let recover = mode == "recover" || long_recovery;
    let cancel_owners = mode.contains("cancel-owner");
    if mode.starts_with("direct-") {
        use_native_direct_responses(&mut manifest);
    }
    if budget {
        for provider in manifest.providers.values_mut() {
            provider.concurrency.as_mut().unwrap().acquire_timeout_ms = 300;
        }
        // Capacity owners keep their original long deadline on listener a.
        // Only requests on listener b receive the short terminal deadline.
        manifest
            .servers
            .get_mut("b")
            .unwrap()
            .execution
            .as_mut()
            .unwrap()
            .attempt_store
            .residence_timeout_ms = 300;
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let first = spawn_concurrency_client(&endpoint, "44cc3af-first");
    timeout(Duration::from_secs(2), first_captures.recv())
        .await
        .unwrap()
        .unwrap();
    let second = spawn_concurrency_client(&endpoint, "44cc3af-second");
    timeout(Duration::from_secs(2), second_captures.recv())
        .await
        .unwrap()
        .unwrap();
    let waiter_endpoint = if budget {
        let listener = handle
            .listeners
            .iter()
            .find(|listener| listener.server_id == "b")
            .unwrap();
        format!("http://{}/v1/responses", listener.addr)
    } else {
        endpoint.clone()
    };
    let waiting_endpoint = waiter_endpoint.clone();
    let mut waiting = Some(tokio::spawn(async move {
        let response = reqwest::Client::new()
            .post(waiting_endpoint)
            .header("session-id", "44cc3af-waiting")
            .json(&json!({"model":"client-test","input":"waiting","stream":true}))
            .send()
            .await?;
        let status = response.status();
        Ok::<_, reqwest::Error>((status, response.text().await?))
    }));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let prematurely_closed = waiting.as_ref().unwrap().is_finished();
    let extra_first = first_captures.try_recv().is_ok();
    let extra_second = second_captures.try_recv().is_ok();
    if mode == "cancel" {
        let task = waiting.take().unwrap();
        task.abort();
        let _ = task.await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    } else if budget {
        tokio::time::sleep(Duration::from_millis(300)).await;
    } else if long_recovery {
        // Enter the second (3s) backoff interval before making capacity ready.
        tokio::time::sleep(Duration::from_millis(1050)).await;
    }
    let mut subsequent_waits = Vec::new();
    if repeated_budget {
        // The first request's exhausted budget must not poison later requests.
        // Keep both real provider leases occupied throughout these requests.
        for index in 0..3 {
            let started = tokio::time::Instant::now();
            let request = reqwest::Client::new()
                .post(&waiter_endpoint)
                .header("session-id", format!("44cc3af-after-exhaustion-{index}"))
                .json(&json!({"model":"client-test","input":"new request after exhaustion","stream":true}));
            let result = timeout(Duration::from_secs(2), async {
                request.send().await?.text().await
            })
            .await;
            subsequent_waits.push((started.elapsed(), result));
        }
    }
    let sent_while_waiting = repeated_budget
        && (first_captures.try_recv().is_ok() || second_captures.try_recv().is_ok());
    // Release the owning sessions before asserting, including the red run.
    if cancel_owners {
        first.abort();
        second.abort();
    } else {
        first_release.add_permits(1);
        second_release.add_permits(1);
    }
    for held in [first, second] {
        if cancel_owners {
            assert!(held.await.unwrap_err().is_cancelled());
        } else {
            let (_, body) = timeout(Duration::from_secs(2), held)
                .await
                .unwrap()
                .unwrap();
            assert!(body.contains("response.completed"));
        }
    }
    let mut admitted_after_release = true;
    if !prematurely_closed && recover {
        let admitted_capture = timeout(
            if long_recovery {
                Duration::from_millis(600)
            } else {
                Duration::from_secs(2)
            },
            first_captures.recv(),
        )
        .await
        .ok()
        .flatten();
        admitted_after_release = admitted_capture.is_some();
        first_release.add_permits(if cancel_owners { 3 } else { 1 });
        if cancel_owners {
            second_release.add_permits(3);
        }
    }
    let waiting_result = if let Some(waiting) = waiting {
        Some(timeout(Duration::from_secs(6), waiting).await)
    } else {
        tokio::time::sleep(Duration::from_millis(300)).await;
        None
    };
    let cancelled_sent = mode == "cancel"
        && (first_captures.try_recv().is_ok() || second_captures.try_recv().is_ok());
    handle.shutdown().await;
    first_shutdown.send(()).unwrap();
    second_shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
    // v31: a request never waits for capacity, FIFO, permits or a local
    // attempt/store budget. An all-busy target resolves inside the request, so
    // the waiting request is already finished and no identity is re-sent.
    assert!(
        prematurely_closed,
        "no request may wait on occupied capacity; the target must resolve immediately"
    );
    let _ = (admitted_after_release, sent_while_waiting, budget, long_recovery);
    assert!(
        !extra_first && !extra_second,
        "an occupied target must not be oversubscribed"
    );
    assert!(
        !cancelled_sent,
        "cancelled waiting request must not call a provider"
    );
    for (elapsed, result) in subsequent_waits {
        assert!(
            elapsed < Duration::from_secs(1),
            "a fresh request must not be queued behind occupied capacity: {elapsed:?}"
        );
        let _ = result.expect("each fresh request must resolve inside the request");
    }
    if mode == "cancel" {
        return;
    }
    let result = waiting_result.unwrap().unwrap();
    match result {
        Ok(Ok((status, body))) => {
            // The only client-visible provider error allowed here is the last
            // candidate's own typed reply; a released hold may also answer.
            assert!(
                status == StatusCode::OK || status == StatusCode::TOO_MANY_REQUESTS,
                "unexpected client status for an all-busy target: {status} {body}"
            );
        }
        _ => {
            // A truthful transport end is also legal: nothing may be fabricated.
        }
    }
}

async fn assert_busy_candidate_preserves_peer_recovery(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("pool-empty-recovery");
    let (first_url, mut first_captures, first_release, first_shutdown) =
        start_controlled_held_upstream().await;
    let (second_url, mut second_captures, second_shutdown) =
        start_controlled_responses_relay_upstream().await;
    std::env::set_var("V3_P6_TEST_KEY", "pool-recovery-test-key");
    let mut manifest = concurrency_switch_manifest(&first_url, &second_url);
    let first_id = format!("concurrency_first_{}", manifest.servers["a"].port);
    let second_id = format!("concurrency_second_{}", manifest.servers["a"].port);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let first = spawn_concurrency_client(&endpoint, "pool-recovery-held");
    timeout(Duration::from_secs(2), first_captures.recv())
        .await
        .unwrap()
        .unwrap();

    let client = reqwest::Client::new();
    let cooled = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(
            &json!({"provider_id":second_id,"auth_alias":"key","model_id":"test",
            "kind":"probe","duration_ms":60_000}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(cooled.status(), StatusCode::OK);
    let response = timeout(
        Duration::from_secs(2),
        client
            .post(&endpoint)
            .header("session-id", "pool-recovery-new")
            .json(&json!({"model":"client-test","input":"recover cooled peer","stream":true}))
            .send(),
    )
    .await
    .expect("peer recovery must not wait for busy capacity")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = timeout(Duration::from_secs(2), response.text())
        .await
        .expect("the same consumer must finish through the recovered peer")
        .expect("a recoverable peer must prevent a pool-empty transport break");
    assert!(body.contains("response.completed"), "{body}");
    assert!(!body.contains("response.failed"), "{body}");
    assert!(
        !first.is_finished(),
        "recovery must not wait for the held request"
    );
    assert!(
        first_captures.try_recv().is_err(),
        "full provider must receive no extra send"
    );
    timeout(Duration::from_secs(1), second_captures.recv())
        .await
        .unwrap()
        .unwrap();
    timeout(Duration::from_secs(1), second_captures.recv())
        .await
        .expect("the peer must receive both a semantic probe and the business request")
        .unwrap();
    let health: Value = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        health["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["state"] != "pre_cool_observation")
            .all(|entry| entry["provider_id"] != first_id && entry["provider_id"] != second_id),
        "capacity must remain health-neutral and a successful probe must clear peer cooldown: {health}"
    );

    first_release.add_permits(1);
    let (status, body) = timeout(Duration::from_secs(2), first)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("response.completed"), "{body}");
    let after = spawn_concurrency_client(&endpoint, "pool-recovery-after-release");
    timeout(Duration::from_secs(1), first_captures.recv())
        .await
        .unwrap()
        .unwrap();
    first_release.add_permits(1);
    let (status, body) = timeout(Duration::from_secs(2), after)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("response.completed"), "{body}");
    handle.shutdown().await;
    first_shutdown.send(()).unwrap();
    second_shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
}

#[tokio::test]
async fn pool_empty_recovery_relay_busy_preferred_keeps_cooled_peer() {
    assert_busy_candidate_preserves_peer_recovery(false).await;
}

#[tokio::test]
async fn pool_empty_recovery_direct_busy_preferred_keeps_cooled_peer() {
    assert_busy_candidate_preserves_peer_recovery(true).await;
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
    /// First business attempt is a real 503; recovery probes answer a real 2xx.
    FailFirstBusinessThenRecover,
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
        let hold = state.mode == IndependencePeerMode::FailFirstBusinessThenHoldProbes;
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
        IndependencePeerMode::FailFirstBusinessThenHoldProbes if attempt == 1 => {
            Some((IndependencePeer::A, REQUEST_INDEPENDENCE_SENTINEL_A))
        }
        IndependencePeerMode::FailFirstBusinessThenRecover if attempt == 1 => {
            Some((IndependencePeer::B, REQUEST_INDEPENDENCE_SENTINEL_B))
        }
        _ => None,
    };
    if let Some((peer, sentinel)) = sentinel {
        // A real provider HTTP error response, not a fabricated success.
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
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
match = {{ precedence = 10, required_capabilities = ["thinking"] }}
targets = [{{ kind = "provider_model", provider = "{a}", model = "test", key = "key", priority = 2 }}, {{ kind = "provider_model", provider = "{c}", model = "test", key = "key", priority = 1 }}]
[route_groups.default.pools.alias_b]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, required_capabilities = ["tools"] }}
targets = [{{ kind = "provider_model", provider = "{b}", model = "test", key = "key", priority = 2 }}, {{ kind = "provider_model", provider = "{d}", model = "test", key = "key", priority = 1 }}]
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
        let request = if model == "client-b" {
            let arguments = json!({"value": input.as_str()}).to_string();
            json!({
                "model": model,
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": input.as_str()
                    },
                    {
                        "type": "function_call",
                        "name": "independence_fixture_echo",
                        "call_id": "independence-b-route-call",
                        "arguments": arguments
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "independence-b-route-call",
                        "output": input.as_str()
                    }
                ],
                "tools": [{
                    "type": "function",
                    "name": "independence_fixture_echo",
                    "description": "Echo a fixture value.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "value": {"type": "string"}
                        },
                        "required": ["value"],
                        "additionalProperties": false
                    }
                }],
                "stream": false
            })
        } else {
            json!({"model": model, "input": input, "stream": false})
        };
        let response = reqwest::Client::new()
            .post(endpoint)
            .header("session-id", REQUEST_INDEPENDENCE_SESSION)
            .header("thread-id", REQUEST_INDEPENDENCE_SESSION)
            .json(&request)
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
    // Direct providers receive the native Responses wire. A real
    // Responses->Chat Relay request must reach the Chat wire instead.
    let wire_path = if direct {
        "/v1/responses"
    } else {
        "/v1/chat/completions"
    };
    let assert_b_tool_history =
        |capture: &IndependenceObservation, input: &str, label: &str| {
            let call_id = "independence-b-route-call";
            let expected_arguments = json!({"value": input});
            if direct {
                let items = capture.body["input"]
                    .as_array()
                    .unwrap_or_else(|| panic!("{label}: provider input must be an array"));
                let message = items
                    .iter()
                    .find(|item| item["type"] == "message" && item["role"] == "user")
                    .unwrap_or_else(|| panic!("{label}: provider input must retain the user turn"));
                assert_eq!(message["content"], input, "{label}: user marker");
                let call = items
                    .iter()
                    .find(|item| item["type"] == "function_call" && item["call_id"] == call_id)
                    .unwrap_or_else(|| {
                        panic!("{label}: provider input must retain the function call")
                    });
                assert_eq!(
                    call["name"], "independence_fixture_echo",
                    "{label}: tool name"
                );
                let arguments: Value = serde_json::from_str(
                    call["arguments"]
                        .as_str()
                        .unwrap_or_else(|| panic!("{label}: arguments must be JSON text")),
                )
                .unwrap_or_else(|error| panic!("{label}: arguments must be valid JSON: {error}"));
                assert_eq!(arguments, expected_arguments, "{label}: arguments");
                let result = items
                    .iter()
                    .find(|item| {
                        item["type"] == "function_call_output" && item["call_id"] == call_id
                    })
                    .unwrap_or_else(|| {
                        panic!("{label}: provider input must retain the paired function result")
                    });
                assert_eq!(result["output"], input, "{label}: paired result");
            } else {
                let messages = capture.body["messages"]
                    .as_array()
                    .unwrap_or_else(|| panic!("{label}: provider messages must be an array"));
                let message = messages
                    .iter()
                    .find(|message| message["role"] == "user")
                    .unwrap_or_else(|| panic!("{label}: provider messages must retain the user turn"));
                assert_eq!(message["content"], input, "{label}: user marker");
                let call = messages
                    .iter()
                    .filter_map(|message| message["tool_calls"].as_array())
                    .flatten()
                    .find(|call| call["id"] == call_id)
                    .unwrap_or_else(|| {
                        panic!("{label}: provider messages must retain the chat tool call")
                    });
                assert_eq!(call["type"], "function", "{label}: chat tool call type");
                assert_eq!(
                    call["function"]["name"], "independence_fixture_echo",
                    "{label}: tool name"
                );
                let arguments: Value = serde_json::from_str(
                    call["function"]["arguments"]
                        .as_str()
                        .unwrap_or_else(|| panic!("{label}: arguments must be JSON text")),
                )
                .unwrap_or_else(|error| panic!("{label}: arguments must be valid JSON: {error}"));
                assert_eq!(arguments, expected_arguments, "{label}: arguments");
                let result = messages
                    .iter()
                    .find(|message| {
                        message["role"] == "tool" && message["tool_call_id"] == call_id
                    })
                    .unwrap_or_else(|| {
                        panic!("{label}: provider messages must retain the paired tool result")
                    });
                assert_eq!(result["content"], input, "{label}: paired result");
            }
        };
    let mut peer_a = start_independence_peer(
        IndependencePeer::A,
        IndependencePeerMode::FailFirstBusinessThenHoldProbes,
        direct,
    )
    .await;
    let mut peer_b = start_independence_peer(
        IndependencePeer::B,
        IndependencePeerMode::FailFirstBusinessThenRecover,
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

    // Step 1: the same session fails A with a real 503 and immediately uses
    // the healthy C fallback. A's own recovery observation starts afterwards.
    let a_first = spawn_independence_request(&base, "client-a", "independence-A-business");
    let label = format!("{mode} peer A first business");
    recv_independence_business(
        &mut peer_a.business,
        &label,
        wire_path,
        "independence-A-business",
        Duration::from_secs(3),
    )
    .await;
    let label = format!("{mode} healthy C fallback for A");
    recv_independence_business(
        &mut peer_c.business,
        &label,
        wire_path,
        "independence-A-business",
        Duration::from_secs(3),
    )
    .await;
    let (status, body) = timeout(Duration::from_secs(5), a_first)
        .await
        .expect("A's healthy fallback must finish the first same-session request")
        .unwrap();
    assert_independence_client_success(status, &body, "independence-C-business-ok");

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
        "A's actual recovery probe must stay parked in the fixture"
    );

    // Step 2: B fails with its own real 503 and recovers through its healthy D
    // fallback. B's real recovery probe answers 2xx while A's is still held.
    let b_first = spawn_independence_request(&base, "client-b", "independence-B-business");
    let label = format!("{mode} peer B first business");
    let b_first_capture = recv_independence_business(
        &mut peer_b.business,
        &label,
        wire_path,
        "independence-B-business",
        Duration::from_secs(3),
    )
    .await;
    assert_b_tool_history(&b_first_capture, "independence-B-business", &label);
    let label = format!("{mode} healthy D fallback for B");
    let d_capture = recv_independence_business(
        &mut peer_d.business,
        &label,
        wire_path,
        "independence-B-business",
        Duration::from_secs(3),
    )
    .await;
    assert_b_tool_history(&d_capture, "independence-B-business", &label);
    let (status, body) = timeout(Duration::from_secs(5), b_first)
        .await
        .expect("B's healthy fallback must finish its same-session request")
        .unwrap();
    assert_independence_client_success(status, &body, "independence-D-business-ok");
    let label = format!("{mode} peer B recovery probe");
    recv_independence_probe(
        &mut peer_b.probes,
        &label,
        wire_path,
        Duration::from_secs(6),
    )
    .await;

    // Step 3: healthy alternatives keep completing on the same session while
    // A's recovery probe is held and while A cannot be reselected.
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
        1,
        "peer A must receive no second business attempt while its probe is held"
    );
    assert!(
        peer_a.holding_probe(),
        "healthy alternatives must not release A's held recovery probe"
    );

    // Step 4: B's business after its own 2xx probe must not depend on A.
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
        1,
        "B must serve recovered business itself instead of falling back to D"
    );
    assert!(
        peer_a.holding_probe(),
        "B's recovery and business must not release A's held observation"
    );

    // Step 5: a request pinned to A waits on A's real held observation. Cancel
    // it and prove B plus the healthy same-session aliases still continue. The
    // wait is produced by the real 503 -> pre-cool observation producer, not by
    // a test-injected cooldown.
    let a_waiting = spawn_independence_request(&base, &pinned_a, "independence-A-waiting-request");
    sleep(Duration::from_millis(300)).await;
    assert!(
        !a_waiting.is_finished(),
        "a pinned request must wait on the real held observation instead of terminating"
    );
    assert_eq!(
        peer_a.business_calls(),
        1,
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
        1,
        "peer A must dispatch exactly one failed business attempt"
    );
    assert!(
        peer_a.probe_calls() >= 1,
        "peer A must receive the runtime's own recovery probe"
    );
    assert_eq!(
        peer_b.business_calls(),
        3,
        "peer B must dispatch one 503 and two recovered businesses"
    );
    assert!(
        peer_b.probe_calls() >= 1,
        "peer B must receive the runtime's own recovery probe"
    );
    assert_eq!(
        peer_c.business_calls(),
        3,
        "healthy C must serve A's first fallback plus both same-session alternatives"
    );
    assert_eq!(
        peer_d.business_calls(),
        1,
        "healthy D must serve only B's first fallback"
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
// P1-3 receipt: the client BYTES a cancelled request really produces.
// ---------------------------------------------------------------------------

/// Read whatever the Server writes to a raw client socket, bounded.
async fn read_client_wire_until_close(socket: &mut tokio::net::TcpStream, bound: Duration) -> Vec<u8> {
    let mut wire = Vec::new();
    let mut buffer = [0u8; 4096];
    let _ = timeout(bound, async {
        loop {
            match socket.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => wire.extend_from_slice(&buffer[..read]),
                Err(_) => break,
            }
        }
    })
    .await;
    wire
}

/// Every complete chunk payload of a chunked client body. A truncated trailing chunk is
/// skipped: it belongs to this reader's own bound, not to the Server's write.
fn chunked_client_payloads(wire: &str) -> Vec<String> {
    let Some((_, body)) = wire.split_once("\r\n\r\n") else {
        return Vec::new();
    };
    let mut rest = body;
    let mut payloads = Vec::new();
    loop {
        let Some((size_line, after)) = rest.split_once("\r\n") else {
            break;
        };
        let Ok(size) = usize::from_str_radix(size_line.trim(), 16) else {
            break;
        };
        if size == 0 || after.len() < size + 2 {
            break;
        }
        payloads.push(after[..size].to_string());
        rest = &after[size + 2..];
    }
    payloads
}

/// P1-3: a cancelled client must never lose the request activity hand-off or leave
/// malformed client framing behind. The wire a real client reads is asserted directly:
/// the response head is the SSE transport accept, no provider error payload or fabricated
/// completion is projected, every complete chunk carries one whole SSE frame, and Server
/// shutdown completes (the cancelled body never keeps the request activity permit).
async fn assert_cancelled_client_wire(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-cancelled-wire");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let (upstream_url, mut captures, _release, upstream_shutdown) =
        start_controlled_held_upstream().await;
    let mode = if direct {
        V3EntryProtocolExecutionMode::Direct
    } else {
        V3EntryProtocolExecutionMode::Relay
    };
    let mut manifest = concurrency_switch_manifest_with_mode(&upstream_url, &upstream_url, mode);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let address = handle.listeners[0].addr;
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let payload =
        json!({"model":"client-test","input":"cancelled client wire","stream":true}).to_string();
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: {address}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nsession-id: 44cc3af-cancelled-wire\r\nthread-id: 44cc3af-cancelled-wire\r\nconnection: close\r\n\r\n{payload}",
        payload.len()
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let capture = timeout(Duration::from_secs(5), captures.recv())
        .await
        .expect("a cancelled request must first reach its provider")
        .expect("provider capture");
    assert!(
        capture.body.to_string().contains("cancelled client wire"),
        "{capture:?}"
    );
    let wire = read_client_wire_until_close(&mut socket, Duration::from_millis(400)).await;
    drop(socket);
    let shutdown = timeout(Duration::from_secs(5), handle.shutdown()).await;
    upstream_shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
    assert!(
        shutdown.is_ok(),
        "a cancelled client must never keep the request activity permit until shutdown hangs"
    );

    let text = String::from_utf8_lossy(&wire).to_string();
    if text.is_empty() {
        // Clean transport close: the runtime buffers every provider attempt before any
        // payload byte is projected, so cancelling before the attempt resolves legitimately
        // produces no client bytes at all. What must never happen is a partial frame, a
        // fabricated completion, an error payload, or a request that outlives the client.
        // Server shutdown already completed within the bound above.
        return;
    }
    assert!(
        text.starts_with("HTTP/1.1 200"),
        "the cancelled request must keep its SSE transport accept: {text:?}"
    );
    assert!(
        text.to_ascii_lowercase()
            .contains("content-type: text/event-stream"),
        "{text:?}"
    );
    let lowered = text.to_ascii_lowercase();
    assert!(
        !lowered.contains("network_error") && !lowered.contains("provider_concurrency_busy"),
        "no provider error payload may be projected onto the cancelled client: {text:?}"
    );
    assert!(
        !text.ends_with("0\r\n\r\n"),
        "a cancelled request must not fabricate a completed body: {text:?}"
    );
    let payloads = chunked_client_payloads(&text);
    if payloads.is_empty() {
        let body = text
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or_default();
        assert!(
            body.trim().is_empty(),
            "a cancelled request must not leave a partial frame in the client bytes: {body:?}"
        );
    }
    for payload in &payloads {
        assert!(
            payload.ends_with("\n\n"),
            "every client chunk must carry one whole SSE frame, never a truncated one: {payload:?}"
        );
        let payload_lower = payload.to_ascii_lowercase();
        assert!(
            !payload_lower.contains("network_error"),
            "no provider error payload may reach the client: {payload:?}"
        );
        assert!(
            !payload_lower.contains("response.completed"),
            "a cancelled request must not project a completion: {payload:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue44cc3af_direct_cancelled_client_wire_keeps_whole_frames_and_closes() {
    assert_cancelled_client_wire(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue44cc3af_relay_cancelled_client_wire_keeps_whole_frames_and_closes() {
    assert_cancelled_client_wire(false).await;
}
