use super::*;
use axum::response::IntoResponse;

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
            .send().await;
        let Ok(mut response) = response else { return (true, Vec::new()); };
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => bytes.extend(chunk),
                Ok(None) => return (false, bytes),
                Err(_) => return (true, bytes),
            }
        }
    }).await;
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
    assert!(!body.contains("error") && !body.contains("response.completed") && !body.contains("late response"), "no error payload or fabricated success may precede the break: {body}");
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
    if mode == "residence" {
        for server in manifest.servers.values_mut() {
            server
                .execution
                .as_mut()
                .unwrap()
                .attempt_store
                .residence_timeout_ms = 300;
        }
    }
    if direct {
        for provider in manifest.providers.values_mut() {
            provider.responses = None;
        }
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
    if mode == "exhaust" || mode == "residence" {
        if mode == "residence" {
            assert!(started.elapsed() < Duration::from_millis(1000), "a two-second target acquisition budget must not overrun the request's 300ms residence deadline: {:?}", started.elapsed());
        } else {
            assert!(
                started.elapsed() >= Duration::from_millis(400),
                "declared wait budget must be consumed before transport termination"
            );
        }
        assert!(
            result
                .expect("budgeted exhaustion must finish")
                .unwrap()
                .is_err(),
            "exhaustion must break transport instead of completing a provider error payload"
        );
        return;
    }
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

async fn assert_identity_only_rate_limit(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-identity-only");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    std::env::set_var("V3_P6_TEST_KEY", "limited-key");
    std::env::set_var("V3_IDENTITY_OTHER_KEY", "other-key");
    let first_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_url = format!("http://{}/v1", first_listener.local_addr().unwrap());
    let second_url = format!("http://{}/v1", second_listener.local_addr().unwrap());
    let failed_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (failed_tx, mut failed_rx) = mpsc::unbounded_channel();
    let recovery_release = Arc::new(Semaphore::new(0));
    let (recovery_tx, mut recovery_rx) = mpsc::unbounded_channel();
    let model_release = Arc::new(Semaphore::new(0));
    let (model_tx, mut model_rx) = mpsc::unbounded_channel();
    let first_app = Router::new().route("/v1/responses", post({
        let failed_calls = failed_calls.clone();
        let recovery_release = recovery_release.clone();
        let model_release = model_release.clone();
        move |headers: HeaderMap, axum::Json(body): axum::Json<Value>| {
            let failed_calls = failed_calls.clone();
            let failed_tx = failed_tx.clone();
            let recovery_release = recovery_release.clone();
            let recovery_tx = recovery_tx.clone();
            let model_release = model_release.clone();
            let model_tx = model_tx.clone();
            async move {
                if headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer other-key")
                    || body["model"] == "wire-other" {
                    if body.to_string().contains("capacity-other-model") {
                        let _ = model_tx.send(());
                        model_release.acquire().await.unwrap().forget();
                    }
                    return identity_test_response("independent identity completed");
                }
                if failed_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
                    let _ = recovery_tx.send(());
                    recovery_release.acquire().await.unwrap().forget();
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
    if direct {
        for provider in manifest.providers.values_mut() {
            provider.responses = None;
        }
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
        .map(|i| spawn("other-model", &format!("capacity-other-model-{i}")))
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
    let requests: Vec<_> = (0..4)
        .map(|i| spawn("client-test", &format!("fresh-{i}")))
        .collect();
    let mut independent = [
        spawn("other-key", "independent-other-key"),
        spawn("other-model", "independent-other-model"),
        spawn("other-provider", "independent-other-provider"),
    ];
    let wave_started = tokio::time::Instant::now();
    let mut parallel_dispatches = 0;
    while wave_started.elapsed() < Duration::from_millis(350) && parallel_dispatches < 4 {
        let remaining = Duration::from_millis(350).saturating_sub(wave_started.elapsed());
        if timeout(remaining, healthy_rx.recv())
            .await
            .is_ok_and(|v| v.is_some())
        {
            parallel_dispatches += 1;
        } else {
            break;
        }
    }
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
    release.add_permits(16);
    for task in std::iter::once(first).chain(requests) {
        if first_delay < Duration::from_millis(350)
            && parallel_dispatches == 4
            && independent_finished
        {
            results.push(
                timeout(Duration::from_secs(2), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap(),
            );
        } else {
            task.abort();
            let _ = task.await;
        }
    }
    // When A becomes due, exactly one recovery attempt may occupy A. Other
    // requests must continue on B while that attempt is held open.
    tokio::time::sleep(Duration::from_millis(1100).saturating_sub(started.elapsed())).await;
    let due_wave: Vec<_> = (0..3)
        .map(|i| spawn("client-test", &format!("due-{i}")))
        .collect();
    let due_recovery = timeout(Duration::from_millis(350), recovery_rx.recv())
        .await
        .is_ok_and(|v| v.is_some());
    let mut due_alternatives = 0;
    for _ in 0..2 {
        if timeout(Duration::from_millis(350), healthy_rx.recv())
            .await
            .is_ok_and(|v| v.is_some())
        {
            due_alternatives += 1;
        }
    }
    let calls_during_recovery = failed_calls.load(std::sync::atomic::Ordering::SeqCst);
    recovery_release.add_permits(16);
    for mut task in due_wave {
        match timeout(Duration::from_secs(2), &mut task).await {
            Ok(Ok(Ok(body))) => results.push(body),
            _ => task.abort(),
        }
    }
    // Matching success restores normal A concurrency immediately, with no
    // retained sustained-delay window from its previous waiters.
    let restored_wave: Vec<_> = (0..4)
        .map(|i| spawn("client-test", &format!("restored-{i}")))
        .collect();
    let restored_started = tokio::time::Instant::now();
    let mut restored = 0;
    // Discard no notifications: the due recovery notification was consumed.
    for _ in 0..4 {
        let remaining = Duration::from_millis(350).saturating_sub(restored_started.elapsed());
        if timeout(remaining, recovery_rx.recv())
            .await
            .is_ok_and(|v| v.is_some())
        {
            restored += 1;
        }
    }
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
    assert_eq!(
        parallel_dispatches, 4,
        "all fresh requests must reach healthy B concurrently instead of queueing on A"
    );
    assert!(
        independent_finished,
        "other keys/models/providers must make independent progress"
    );
    assert_eq!(
        calls_before_release, 1,
        "fresh requests must skip the active429 identity without a retry storm"
    );
    assert!(due_recovery, "one due recovery must reach A");
    assert_eq!(
        due_alternatives, 2,
        "other requests must use B while A recovery is in flight"
    );
    assert_eq!(calls_during_recovery, 2, "only one recovery may reach A");
    assert_eq!(
        model_capacity, 8,
        "429 must preserve every configured slot of another model on the same key"
    );
    assert_eq!(
        restored, 4,
        "successful A must immediately regain normal concurrency"
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

async fn assert_mixed_capacity_recovery(direct: bool, initially_busy_first: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-mixed-capacity");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let (healthy_url, mut healthy_captures, healthy_release, healthy_shutdown) =
        start_controlled_held_upstream().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let failure_release = Arc::new(Semaphore::new(usize::from(!initially_busy_first)));
    let failure_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (failure_tx, mut failures) = mpsc::unbounded_channel();
    let app = Router::new().route(
        "/v1/responses",
        post({
            let failure_release = failure_release.clone();
            let failure_calls = failure_calls.clone();
            move || {
                let failure_release = failure_release.clone();
                let failure_calls = failure_calls.clone();
                let failure_tx = failure_tx.clone();
                async move {
                    failure_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
        for provider in manifest.providers.values_mut() {
            provider.responses = None;
        }
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
        // Keep the alternative busy beyond the first Error05 admission delay.
        tokio::time::sleep(Duration::from_millis(1500)).await;
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
    let failures_count = failure_calls.load(std::sync::atomic::Ordering::SeqCst);
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
    assert_eq!(
        failures_count, 1,
        "a failed candidate stays permanently excluded"
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
        for provider in manifest.providers.values_mut() {
            provider.responses = None;
        }
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
    for server in manifest.servers.values_mut() {
        server.http_sse_keepalive_ms = 10;
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
    let started = tokio::time::Instant::now();
    let request = tokio::spawn(async move {
        let mut response = client
            .post(format!("{base}/v1/responses"))
            .header("session-id", "44cc3af-stalled-probe")
            .json(&json!({"model":"client-test","input":"probe budget","stream":true}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => bytes.extend(chunk),
                Ok(None) => return (false, bytes),
                Err(_) => return (true, bytes),
            }
        }
    });
    timeout(Duration::from_secs(2), arrived.notified())
        .await
        .unwrap();
    let outcome = timeout(Duration::from_secs(2), request).await;
    release.notify_waiters();
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
    let (broken, bytes) = outcome
        .expect("a stalled probe must not outlive the wait budget")
        .unwrap();
    assert!(started.elapsed() >= Duration::from_millis(150));
    assert!(broken, "exhaustion must end transport detectably");
    let body = String::from_utf8(bytes).unwrap();
    assert!(body.contains(": keepalive"));
    assert!(
        !body.contains("error") && !body.contains("response.completed"),
        "{body}"
    );
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
    let _guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("44cc3af-rate-wait");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let late_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let healthy_started = Arc::new(tokio::sync::Notify::new());
    let release_healthy = Arc::new(tokio::sync::Notify::new());
    let (hit_tx, mut hits) = mpsc::unbounded_channel();
    let app = Router::new().route("/v1/responses", post({
        let ready = ready.clone();
        let calls = calls.clone();
        let late_calls = late_calls.clone();
        let healthy_started = healthy_started.clone();
        let release_healthy = release_healthy.clone();
        move |axum::Json(body): axum::Json<Value>| {
            let ready = ready.clone();
            let calls = calls.clone();
            let late_calls = late_calls.clone();
            let hit_tx = hit_tx.clone();
            let healthy_started = healthy_started.clone();
            let release_healthy = release_healthy.clone();
            async move {
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
                if attempt <= if parallel_success { 1 } else { 3 } || !ready.load(std::sync::atomic::Ordering::SeqCst) {
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
        for provider in manifest.providers.values_mut() {
            provider.responses = None;
        }
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
    assert!(
        early_calls
            <= if late_join {
                1
            } else if cooled {
                3
            } else {
                waiter_count.max(2)
            },
        "rate-limit wait must not hammer upstream: {early_calls}"
    );
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
            0,
            "cancelled fresh-session wait must never send after recovery"
        );
    }
}

#[tokio::test]
async fn issue44cc3af_all_busy_waits_for_capacity_without_transport_break() {
    assert_capacity_wait("recover").await;
}

#[tokio::test]
async fn issue44cc3af_cancelled_wait_does_not_send_after_capacity_returns() {
    assert_capacity_wait("cancel").await;
}

#[tokio::test]
async fn issue44cc3af_capacity_budget_expires_only_after_waiting() {
    assert_capacity_wait("budget").await;
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
    if mode == "budget" {
        for provider in manifest.providers.values_mut() {
            provider.concurrency.as_mut().unwrap().acquire_timeout_ms = 300;
        }
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
    let waiting_endpoint = endpoint.clone();
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
    } else if mode == "budget" {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // Release the owning sessions before asserting, including the red run.
    first_release.add_permits(1);
    second_release.add_permits(1);
    for held in [first, second] {
        let (_, body) = timeout(Duration::from_secs(2), held)
            .await
            .unwrap()
            .unwrap();
        assert!(body.contains("response.completed"));
    }
    if !prematurely_closed && mode == "recover" {
        timeout(Duration::from_secs(2), first_captures.recv())
            .await
            .unwrap()
            .unwrap();
        first_release.add_permits(1);
    }
    let waiting_result = if let Some(waiting) = waiting {
        Some(timeout(Duration::from_secs(2), waiting).await)
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
    assert!(
        !prematurely_closed,
        "temporary all-busy target must wait, not break the client transport"
    );
    assert!(
        !extra_first && !extra_second,
        "waiting must not oversubscribe or hammer upstreams"
    );
    assert!(
        !cancelled_sent,
        "cancelled waiting request must not call a provider"
    );
    if mode == "cancel" {
        return;
    }
    let result = waiting_result.unwrap().unwrap().unwrap();
    if mode == "budget" {
        assert!(
            result.is_err(),
            "budget-exhausted capacity must terminate detectably, not fabricate completion"
        );
        return;
    }
    let (status, body) = result.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_responses_sse_delivered_business_text(&body, "held response released");
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
        for provider in manifest.providers.values_mut() {
            provider.responses = None;
        }
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
    assert!(health["entries"].as_array().unwrap().iter().all(|entry| {
        entry["provider_id"] != first_id && entry["provider_id"] != second_id
    }), "capacity must remain health-neutral and a successful probe must clear peer cooldown: {health}");

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
