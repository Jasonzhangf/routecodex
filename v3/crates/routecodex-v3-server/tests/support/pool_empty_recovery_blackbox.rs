use super::*;
use axum::response::IntoResponse;

#[tokio::test]
async fn issue44cc3af_all_tried_transport_failure_waits_for_recovered_peer() {
    assert_all_tried_transport_failure_recovers(false, false).await;
}

#[tokio::test]
async fn issue44cc3af_direct_all_tried_transport_failure_waits_for_recovered_peer() {
    assert_all_tried_transport_failure_recovers(true, false).await;
}

#[tokio::test]
async fn issue44cc3af_relay_hard_attempt_cap_waits_without_sending_or_breaking_early() {
    assert_all_tried_transport_failure_recovers(false, true).await;
}

#[tokio::test]
async fn issue44cc3af_direct_hard_attempt_cap_waits_without_sending_or_breaking_early() {
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
    if hard_cap {
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
        if hard_cap {
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
    let began = tokio::time::Instant::now();
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
    if let Some(held_success) = held_success {
        // Completion of an already running business request establishes actual
        // recovery before starting independent consumers on the same key.
        held_release.add_permits(1);
        assert!(timeout(Duration::from_secs(1), held_success)
            .await
            .unwrap()
            .unwrap()
            .contains("all tried peer recovered"));
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
                Ok(Some((false, _, body))) if body.to_string().contains("independence-wave") => {
                    arrivals += 1
                }
                Ok(Some((true, _, _))) => {}
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
        assert!(
            !request.is_finished(),
            "only the exhausted request remains pending"
        );
    }
    let outcome = match early {
        Ok(result) => Some(result),
        Err(_) => timeout(
            Duration::from_secs(if hard_cap { 5 } else { 3 }),
            &mut request,
        )
        .await
        .ok(),
    };
    request.abort();
    handle.shutdown().await;
    first_task.abort();
    second_task.abort();
    assert!(
        !ended_early,
        "all tried transport failures must wait for captured-pool recovery: {outcome:?}"
    );
    if hard_cap {
        assert!(began.elapsed() >= Duration::from_millis(3800),
            "the configured cap forbids more sends but must not end transport before residence expiry");
        assert!(
            outcome
                .expect("deadline must finish this request")
                .unwrap()
                .is_err(),
            "exhausted configured budget cannot fabricate success"
        );
        while let Ok((probe, _, _)) = first_rx.try_recv() {
            assert!(probe, "hard cap must forbid recovered-peer business sends");
        }
        assert!(
            second_rx.try_recv().is_err(),
            "last candidate remains protected"
        );
        return;
    }
    let body = outcome
        .expect("recovered peer must complete original request")
        .unwrap()
        .unwrap();
    assert!(body.contains("all tried peer recovered"), "{body}");
    assert!(!body.contains("\"error\""), "{body}");
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
    assert!(
        recovered_probe && recovered_business,
        "matching probe then original business must reach recovered peer"
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
    let restored_release = Arc::new(Semaphore::new(0));
    let (model_tx, mut model_rx) = mpsc::unbounded_channel();
    let first_app = Router::new().route("/v1/responses", post({
        let failed_calls = failed_calls.clone();
        let recovery_release = recovery_release.clone();
        let model_release = model_release.clone();
        let restored_release = restored_release.clone();
        move |headers: HeaderMap, axum::Json(body): axum::Json<Value>| {
            let failed_calls = failed_calls.clone();
            let failed_tx = failed_tx.clone();
            let recovery_release = recovery_release.clone();
            let recovery_tx = recovery_tx.clone();
            let model_release = model_release.clone();
            let model_tx = model_tx.clone();
            let restored_release = restored_release.clone();
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
    let tested_capacity_key = format!("identity_first_{}:key", manifest.servers["a"].port);
    let initial_capacity = routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyController::process_shared()
        .snapshot(&tested_capacity_key);
    if direct {
        use_native_direct_responses(&mut manifest);
    }
    let sampled_scope =
        routecodex_v3_provider_responses::adaptive_concurrency::V3ConcurrencyIdentityScope {
            interface_id: manifest.providers
                [&format!("identity_first_{}", manifest.servers["a"].port)]
                .interfaces
                .keys()
                .next()
                .unwrap()
                .clone(),
            model_id: "test".into(),
        };
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
    let capacity_before_wave = routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyController::process_shared()
        .snapshot(&tested_capacity_key);
    let sampled = routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyController::process_shared()
        .snapshot_for_scope(&tested_capacity_key, Some(&sampled_scope)).unwrap();
    assert_eq!(
        sampled.rate_limit_samples, 1,
        "real business429 must retain dynamic sampling"
    );
    assert_eq!(sampled.budget, 1);
    assert_eq!(sampled.hard_max_in_flight, 8);
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
    let capacity_before_release = routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyController::process_shared()
        .snapshot(&tested_capacity_key);
    model_release.add_permits(8);
    let mut capacity_results = Vec::new();
    for mut task in model_wave {
        match timeout(Duration::from_secs(2), &mut task).await {
            Ok(Ok(Ok(body))) => capacity_results.push(body),
            _ => task.abort(),
        }
    }
    if model_capacity != 8 {
        eprintln!("identity capacity evidence: key={tested_capacity_key}, direct={direct}, initial={initial_capacity:?}, before_wave={capacity_before_wave:?}, before_release={capacity_before_release:?}, completed={}, failed_identity_calls={}, recovery_dispatched={}",
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
    // Matching success removes A's retry gate immediately and restores one
    // learned budget unit (1 -> 2). Hold those responses so later successes
    // cannot hide the exact learned limit. The other two requests must use B.
    let recovered_budget = routecodex_v3_provider_responses::adaptive_concurrency::V3AdaptiveConcurrencyController::process_shared()
        .snapshot_for_scope(&tested_capacity_key, Some(&sampled_scope)).unwrap().budget;
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
    let mut restored_alternatives = 0;
    for _ in 0..2 {
        if timeout(Duration::from_millis(350), healthy_rx.recv())
            .await
            .is_ok_and(|v| v.is_some())
        {
            restored_alternatives += 1;
        }
    }
    restored_release.add_permits(4);
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
        recovered_budget, 2,
        "matching business success must restore one unit of the learned dynamic budget"
    );
    assert_eq!(restored, 2, "both learned A slots must be usable immediately, without an old retry gate or oversubscription");
    assert_eq!(
        restored_alternatives, 2,
        "requests beyond A's learned limit must use healthy B without blocking"
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
        assert!(
            elapsed >= Duration::from_millis(request_deadline_ms.unwrap_or(150)),
            "every fresh request must wait through its original budget: {elapsed:?}"
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
        1
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
        admitted_after_release = timeout(
            if long_recovery {
                Duration::from_millis(600)
            } else {
                Duration::from_secs(2)
            },
            first_captures.recv(),
        )
        .await
        .is_ok_and(|capture| capture.is_some());
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
    assert!(
        !sent_while_waiting,
        "successive waiting requests must not oversubscribe occupied providers"
    );
    assert!(
        admitted_after_release,
        "available capacity must wake the request during the 3s interval, not wait out its timer"
    );
    for (elapsed, result) in subsequent_waits {
        assert!(
            elapsed >= Duration::from_millis(250),
            "a later request must receive its own 300ms waiting budget: {elapsed:?}"
        );
        assert!(
            result
                .expect("each fresh request must remain bounded")
                .is_err(),
            "exhaustion must break transport without a completed error or empty success"
        );
    }
    if mode == "cancel" {
        return;
    }
    let result = waiting_result.unwrap().unwrap().unwrap();
    if budget {
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

fn independence_peer_success(
    peer: IndependencePeer,
    direct: bool,
    text: &str,
) -> Response<Body> {
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
    let probe = text.contains("ping; reply pong")
        || text.contains("Reply exactly OK. Do not call tools.");
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
        self.business_calls.load(std::sync::atomic::Ordering::SeqCst)
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
    let mut peer_c = start_independence_peer(
        IndependencePeer::C,
        IndependencePeerMode::Healthy,
        direct,
    )
    .await;
    let mut peer_d = start_independence_peer(
        IndependencePeer::D,
        IndependencePeerMode::Healthy,
        direct,
    )
    .await;
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
    recv_independence_business(
        &mut peer_b.business,
        &label,
        wire_path,
        "independence-B-business",
        Duration::from_secs(3),
    )
    .await;
    let label = format!("{mode} healthy D fallback for B");
    recv_independence_business(
        &mut peer_d.business,
        &label,
        wire_path,
        "independence-B-business",
        Duration::from_secs(3),
    )
    .await;
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
    let a_waiting =
        spawn_independence_request(&base, &pinned_a, "independence-A-waiting-request");
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

    let b_after_cancel = spawn_independence_request(
        &base,
        &pinned_b,
        "independence-B-business-after-A-cancel",
    );
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
