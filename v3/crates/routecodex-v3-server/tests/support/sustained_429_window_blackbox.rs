use super::*;
use axum::{response::IntoResponse, Json};

#[derive(Debug)]
struct ObservationClock(std::sync::atomic::AtomicU64);

impl routecodex_v3_runtime::V3ProviderHealthObservationClock for ObservationClock {
    fn now_epoch_ms(&self) -> u64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[tokio::test]
async fn sustained_429_window_direct_public_http() {
    assert_sustained_window(true, false).await;
}

#[tokio::test]
async fn sustained_429_window_relay_public_http() {
    assert_sustained_window(false, false).await;
}

#[tokio::test]
async fn sustained_429_hour_direct_public_http() {
    assert_sustained_window(true, true).await;
}

#[tokio::test]
async fn sustained_429_hour_relay_public_http() {
    assert_sustained_window(false, true).await;
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

async fn assert_sustained_window(direct: bool, hour: bool) {
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
    let first_id = format!("concurrency_first_{}", manifest.servers["a"].port);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = Arc::new(ObservationClock(std::sync::atomic::AtomicU64::new(now)));
    let handle = routecodex_v3_server::spawn_v3_server_aggregate_with_health_observation_clock(
        manifest,
        clock.clone(),
    )
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let sibling_base = format!("http://{}", handle.listeners[1].addr);
    let client = reqwest::Client::new();
    assert!(quota_business(&client, &base, "quota-first")
        .await
        .contains("quota-window-fallback"));
    assert!(
        quota_entries(&client, &base).await.is_empty(),
        "one429 cannot cool"
    );
    assert_eq!(business.load(std::sync::atomic::Ordering::SeqCst), 1);
    // Retry admission still uses its independent real monotonic floor.
    sleep(Duration::from_millis(1100)).await;
    clock
        .0
        .store(now + 120000, std::sync::atomic::Ordering::SeqCst);
    assert!(quota_business(&client, &base, "quota-window-boundary")
        .await
        .contains("quota-window-fallback"));
    assert_eq!(business.load(std::sync::atomic::Ordering::SeqCst), 2);
    let entries = quota_entries(&client, &base).await;
    assert!(
        entries
            .iter()
            .any(|entry| entry["provider_id"] == first_id && entry["auth_alias"] == "key"),
        "a real429 crossing the observation window must cool the exact identity: {entries:?}"
    );
    assert!(quota_business(&client, &base, "quota-fresh-fallback")
        .await
        .contains("quota-window-fallback"));
    assert_eq!(
        business.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "fresh requests must skip cooled A"
    );
    assert!(
        quota_business(&client, &sibling_base, "quota-other-listener")
            .await
            .contains("quota-window-fallback")
    );
    assert!(
        quota_entries(&client, &sibling_base).await.is_empty(),
        "another listener starts its own observation"
    );

    let probe_body = json!({"provider_id":first_id,"interface_id":"default","auth_alias":"key","model_id":"test"});
    if hour {
        // The independent listener above also sent one real A429. Count only
        // additional sends here instead of attributing its traffic to this port.
        let business_before_hour = business.load(std::sync::atomic::Ordering::SeqCst);
        clock
            .0
            .store(now + 3600000, std::sync::atomic::Ordering::SeqCst);
        let before = probes.load(std::sync::atomic::Ordering::SeqCst);
        client
            .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
            .json(&probe_body)
            .send()
            .await
            .unwrap();
        timeout(Duration::from_secs(3), async {
            loop {
                let entries = quota_entries(&client, &base).await;
                if probes.load(std::sync::atomic::Ordering::SeqCst) > before
                    && entries.iter().any(|entry| {
                        entry["provider_id"] == first_id
                            && entry["failure_count"].as_u64().unwrap_or(0) > 0
                    })
                {
                    break;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("real429 probe must keep the hour-long episode excluded");
        assert!(quota_business(&client, &base, "quota-hour-fallback")
            .await
            .contains("quota-window-fallback"));
        assert_eq!(
            business.load(std::sync::atomic::Ordering::SeqCst),
            business_before_hour
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
        timeout(Duration::from_secs(3), async {
            while probes.load(std::sync::atomic::Ordering::SeqCst) == before {
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("real non429 HTTP failure must be observed");
        assert!(quota_business(&client, &base, "quota-hour-503-fallback")
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
        let before = probes.load(std::sync::atomic::Ordering::SeqCst);
        let response = client
            .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
            .json(&probe_body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        timeout(Duration::from_secs(3), async {
            while probes.load(std::sync::atomic::Ordering::SeqCst) == before {
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("a real early probe must run");
        assert!(
            quota_entries(&client, &base)
                .await
                .iter()
                .any(|entry| entry["provider_id"] == first_id),
            "early202 probe cannot shorten30-minute minimum"
        );
        assert!(quota_business(&client, &base, "quota-minimum-fallback")
            .await
            .contains("quota-window-fallback"));

        clock
            .0
            .store(now + 1920000, std::sync::atomic::Ordering::SeqCst);
    }
    let before = probes.load(std::sync::atomic::Ordering::SeqCst);
    client
        .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
        .json(&probe_body)
        .send()
        .await
        .unwrap();
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
    .expect("current202 probe after minimum must recover exact A");
    assert!(quota_business(&client, &base, "quota-restored")
        .await
        .contains("quota-window-primary"));
    handle.shutdown().await;
    first_task.abort();
    second_task.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
}
