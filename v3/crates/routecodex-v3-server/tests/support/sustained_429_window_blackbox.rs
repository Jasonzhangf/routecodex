use super::*;
use axum::{response::IntoResponse, Json};

#[tokio::test]
async fn ordinary_429_exact_identity_direct_public_http() {
    assert_ordinary_429_lifecycle(true, false).await;
}

#[tokio::test]
async fn ordinary_429_exact_identity_relay_public_http() {
    assert_ordinary_429_lifecycle(false, false).await;
}

#[tokio::test]
async fn ordinary_429_probe_failure_visibility_direct_public_http() {
    assert_ordinary_429_lifecycle(true, true).await;
}

#[tokio::test]
async fn ordinary_429_probe_failure_visibility_relay_public_http() {
    assert_ordinary_429_lifecycle(false, true).await;
}

async fn quota_peer(
    direct: bool,
    quota: Arc<std::sync::atomic::AtomicBool>,
    business: Arc<std::sync::atomic::AtomicUsize>,
    probes: Arc<std::sync::atomic::AtomicUsize>,
    probe_status: Arc<std::sync::atomic::AtomicU16>,
    marker: &'static str,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let path = if direct {
        "/v1/responses"
    } else {
        "/v1/chat/completions"
    };
    let app = Router::new().route(path, post(move |Json(body): Json<Value>| {
        let quota = quota.clone();
        let business = business.clone();
        let probes = probes.clone();
        let probe_status = probe_status.clone();
        async move {
            assert_eq!(body["model"], "wire-test");
            assert!(if direct { body.get("input").is_some() } else { body["messages"].is_array() });
            let probe = body.to_string().contains("ping; reply pong")
                || body.to_string().contains("Reply exactly OK. Do not call tools.");
            if probe { probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }
            else { business.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }
            if quota.load(std::sync::atomic::Ordering::SeqCst) {
                return (StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({"error":{"code":"rate_limit_error","message":"controlled quota429"}}))).into_response();
            }
            if probe {
                // A verified HTTP202 is enough. The probe must not parse this body.
                return (StatusCode::from_u16(probe_status.load(std::sync::atomic::Ordering::SeqCst)).unwrap(),
                    "not-json; real probe response").into_response();
            }
            let body = if direct {
                json!({"id":"quota-primary","object":"response","status":"completed",
                    "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":marker}]}]})
            } else {
                json!({"id":"quota-primary","object":"chat.completion","model":"wire-test",
                    "choices":[{"index":0,"message":{"role":"assistant","content":marker},"finish_reason":"stop"}]})
            };
            Json(body).into_response()
        }
    }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, task)
}

async fn quota_business(client: &reqwest::Client, base: &str, session: &str) -> String {
    let response = timeout(
        Duration::from_secs(4),
        client
            .post(format!("{base}/v1/responses"))
            .header("session-id", session)
            .json(
                &json!({"model":"client-test","input":"valid quota window request","stream":false}),
            )
            .send(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(
        !body.contains("\"error\""),
        "provider error must stay internal: {body}"
    );
    body
}

async fn quota_entries(client: &reqwest::Client, base: &str) -> Vec<Value> {
    let value: Value = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    value["entries"].as_array().unwrap().clone()
}

async fn wait_for_exact_quota_entry(
    client: &reqwest::Client,
    base: &str,
    provider_id: &str,
) -> Vec<Value> {
    timeout(Duration::from_secs(4), async {
        loop {
            let entries = quota_entries(client, base).await;
            if entries
                .iter()
                .any(|entry| entry["provider_id"] == provider_id && entry["auth_alias"] == "key")
            {
                return entries;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the failed exact identity must become visible after its real probe")
}

async fn wait_for_probe_after(
    probes: &std::sync::atomic::AtomicUsize,
    before: usize,
) -> usize {
    timeout(Duration::from_secs(4), async {
        loop {
            let current = probes.load(std::sync::atomic::Ordering::SeqCst);
            if current > before {
                return current;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the exact identity must receive a real probe")
}

async fn assert_ordinary_429_lifecycle(direct: bool, failed_probe_first: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("sustained-429-window");
    std::env::set_var("V3_P6_TEST_KEY", "quota-test-key");
    let quota = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let probe_status = Arc::new(std::sync::atomic::AtomicU16::new(202));
    let (first_url, first_task) = quota_peer(
        direct,
        quota.clone(),
        business.clone(),
        probes.clone(),
        probe_status.clone(),
        "quota-window-primary",
    )
    .await;
    let (second_url, second_task) = quota_peer(
        direct,
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
        Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        Arc::new(std::sync::atomic::AtomicU16::new(202)),
        "quota-window-fallback",
    )
    .await;
    let mut manifest = two_provider_failover_manifest_with_execution_mode(
        &first_url,
        &second_url,
        if direct {
            V3EntryProtocolExecutionMode::Direct
        } else {
            V3EntryProtocolExecutionMode::Relay
        },
    );
    if direct {
        super::pool_empty_recovery_blackbox::use_native_direct_responses(&mut manifest);
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
    let first_id = format!("failover_first_{}", manifest.servers["a"].port);
    let handle = routecodex_v3_server::spawn_v3_server_aggregate(manifest)
        .await
        .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let sibling_base = format!("http://{}", handle.listeners[1].addr);
    let client = reqwest::Client::new();
    let probes_before = probes.load(std::sync::atomic::Ordering::SeqCst);
    assert!(quota_business(&client, &base, "quota-first")
        .await
        .contains("quota-window-fallback"));
    assert!(
        quota_entries(&client, &base)
            .await
            .iter()
            .all(|entry| entry["state"] == "pre_cool_observation"),
        "one429 cannot commit a cooldown"
    );
    assert_eq!(business.load(std::sync::atomic::Ordering::SeqCst), 1);
    wait_for_probe_after(&probes, probes_before).await;
    let entries = wait_for_exact_quota_entry(&client, &base, &first_id).await;
    assert!(
        entries
            .iter()
            .any(|entry| entry["provider_id"] == first_id && entry["auth_alias"] == "key"),
        "the real failed probe must keep the exact identity visible: {entries:?}"
    );
    // v31: below three consecutive failures the identity stays VISIBLE, so the
    // next business requests each select it exactly once instead of being
    // skipped, and no cooldown row is committed until the ladder threshold.
    assert!(quota_business(&client, &base, "quota-window-boundary")
        .await
        .contains("quota-window-fallback"));
    assert_eq!(
        business.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "a still-visible identity is re-selected exactly once per request"
    );
    assert!(quota_business(&client, &base, "quota-fresh-fallback")
        .await
        .contains("quota-window-fallback"));
    assert_eq!(
        business.load(std::sync::atomic::Ordering::SeqCst),
        3,
        "each request selects the visible identity at most once; no same-identity retry"
    );
    // The third consecutive business failure reaches the ladder threshold, so an
    // expiring row may now exist - only for the exact identity and only at the
    // 10s floor, never an earlier one.
    for entry in quota_entries(&client, &base).await {
        if entry["until_ms"].is_null() {
            continue;
        }
        assert_eq!(entry["provider_id"], first_id.as_str(), "only the failed identity may cool: {entry:?}");
        assert_eq!(entry["auth_alias"], "key");
        let remaining = entry["remaining_ms"].as_i64().unwrap_or(-1);
        assert!(
            remaining > 0 && remaining <= 10_000,
            "an automatic cooldown must start at the v31 10s floor: {entry:?}"
        );
    }
    assert!(
        quota_business(&client, &sibling_base, "quota-other-listener")
            .await
            .contains("quota-window-fallback")
    );

    let probe_body = json!({"provider_id":first_id,"interface_id":"default","auth_alias":"key","model_id":"test"});
    if failed_probe_first {
        let business_before_probe = business.load(std::sync::atomic::Ordering::SeqCst);
        let before = probes.load(std::sync::atomic::Ordering::SeqCst);
        client
            .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
            .json(&probe_body)
            .send()
            .await
            .unwrap();
        wait_for_probe_after(&probes, before).await;
        wait_for_exact_quota_entry(&client, &base, &first_id).await;
        assert!(quota_business(&client, &base, "quota-probe-failure-fallback")
            .await
            .contains("quota-window-fallback"));
        assert_eq!(
            business.load(std::sync::atomic::Ordering::SeqCst),
            business_before_probe
        );

        quota.store(false, std::sync::atomic::Ordering::SeqCst);
        probe_status.store(503, std::sync::atomic::Ordering::SeqCst);
        let before = probes.load(std::sync::atomic::Ordering::SeqCst);
        client
            .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
            .json(&probe_body)
            .send()
            .await
            .unwrap();
        wait_for_probe_after(&probes, before).await;
        wait_for_exact_quota_entry(&client, &base, &first_id).await;
        assert!(quota_business(&client, &base, "quota-503-probe-fallback")
            .await
            .contains("quota-window-fallback"));
        assert!(
            quota_entries(&client, &base)
                .await
                .iter()
                .any(|entry| entry["provider_id"] == first_id),
            "non429503 is not a healthy probe and must not open business routing"
        );
        probe_status.store(202, std::sync::atomic::Ordering::SeqCst);
    } else {
        quota.store(false, std::sync::atomic::Ordering::SeqCst);
    }
    let before = probes.load(std::sync::atomic::Ordering::SeqCst);
    let probe_response = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
        .json(&probe_body)
        .send()
        .await
        .unwrap();
    assert_eq!(probe_response.status(), StatusCode::OK);
    timeout(Duration::from_secs(3), async {
        loop {
            if probes.load(std::sync::atomic::Ordering::SeqCst) > before
                && !quota_entries(&client, &base)
                    .await
                    .iter()
                    .any(|entry| entry["provider_id"] == first_id)
            {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|error| {
        panic!("a current HTTP202 probe must recover the exact identity: {error}")
    });
    assert!(quota_business(&client, &base, "quota-restored")
        .await
        .contains("quota-window-primary"));
    handle.shutdown().await;
    first_task.abort();
    second_task.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
}
