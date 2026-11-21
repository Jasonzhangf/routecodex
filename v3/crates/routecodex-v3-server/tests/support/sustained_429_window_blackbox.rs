use super::*;
use axum::{response::IntoResponse, Json};

#[derive(Debug)]
pub(super) struct ObservationClock(pub(super) std::sync::atomic::AtomicU64);

impl routecodex_v3_runtime::V3ProviderHealthObservationClock for ObservationClock {
    fn now_epoch_ms(&self) -> u64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[tokio::test]
async fn consecutive_provider_errors_direct_public_http() {
    assert_consecutive_errors(true).await;
}

#[tokio::test]
async fn consecutive_provider_errors_relay_public_http() {
    assert_consecutive_errors(false).await;
}

async fn quota_peer(
    direct: bool,
    business_status: Arc<std::sync::atomic::AtomicU16>,
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
        let business_status = business_status.clone();
        let business = business.clone();
        let probes = probes.clone();
        let probe_status = probe_status.clone();
        async move {
            assert_eq!(body["model"], "wire-test");
            assert!(if direct { body.get("input").is_some() } else { body["messages"].is_array() });
            let probe = body.to_string().contains("ping; reply pong")
                || body.to_string().contains("Reply exactly OK. Do not call tools.");
            if probe {
                probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // A verified HTTP202 is enough. The probe must not parse this body.
                return (StatusCode::from_u16(probe_status.load(std::sync::atomic::Ordering::SeqCst)).unwrap(),
                    "not-json; real probe response").into_response();
            }
            business.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let status = StatusCode::from_u16(business_status.load(std::sync::atomic::Ordering::SeqCst)).unwrap();
            if !status.is_success() {
                if status == StatusCode::TOO_MANY_REQUESTS
                    && body.to_string().contains("controlled exhausted quota")
                {
                    return (status, Json(json!({"error":{
                        "code":"insufficient_quota",
                        "type":"rate_limit_error",
                        "message":"controlled exhausted quota"
                    }}))).into_response();
                }
                return (status, Json(json!({"error":{"message":"controlled provider failure"}}))).into_response();
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
            .json(&json!({"model":"client-test","input":session,"stream":false}))
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

async fn await_quota_probe(
    client: &reqwest::Client,
    base: &str,
    identity: &Value,
    probes: &std::sync::atomic::AtomicUsize,
) {
    use std::sync::atomic::Ordering::SeqCst;

    let before = probes.load(SeqCst);
    let response = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
        .json(identity)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    timeout(Duration::from_secs(3), async {
        loop {
            if probes.load(SeqCst) > before
                && !quota_entries(client, base).await.iter().any(|entry| {
                    entry["provider_id"] == identity["provider_id"] && entry["state"] == "probing"
                })
            {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the matching recovery probe must complete");
}

async fn assert_consecutive_errors(direct: bool) {
    use std::sync::atomic::Ordering::SeqCst;

    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("sustained-429-window");
    std::env::set_var("V3_P6_TEST_KEY", "quota-test-key");
    let business_status = Arc::new(std::sync::atomic::AtomicU16::new(429));
    let business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let fallback_business = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let probe_status = Arc::new(std::sync::atomic::AtomicU16::new(202));
    let (first_url, first_task) = quota_peer(
        direct,
        business_status.clone(),
        business.clone(),
        probes.clone(),
        probe_status.clone(),
        "quota-window-primary",
    )
    .await;
    let (second_url, second_task) = quota_peer(
        direct,
        Arc::new(std::sync::atomic::AtomicU16::new(200)),
        fallback_business.clone(),
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

    let cooldown_start = now + 120_000;
    for (index, status) in [429, 429, 500, 502, 429, 500, 502, 429, 500, 502]
        .into_iter()
        .enumerate()
    {
        if index == 1 {
            clock.0.store(cooldown_start, SeqCst);
        }
        business_status.store(status, SeqCst);
        assert!(
            quota_business(&client, &base, &format!("failure-{index}"))
                .await
                .contains("quota-window-fallback"),
            "declared B must complete the request after A returns HTTP {status}"
        );
        assert_eq!(business.load(SeqCst), index + 1, "one A send per request");
        assert_eq!(
            fallback_business.load(SeqCst),
            index + 1,
            "one B send per request"
        );
        if index < 9 {
            assert!(
                quota_entries(&client, &base).await.is_empty(),
                "error {} must stay below the cooldown threshold",
                index + 1
            );
        }
    }
    let minimum_end = cooldown_start + 3_600_000;
    let identity = json!({"provider_id":first_id,"interface_id":"default","auth_alias":"key","model_id":"test"});
    let entries = quota_entries(&client, &base).await;
    assert_eq!(entries.len(), 1);
    for field in ["provider_id", "interface_id", "auth_alias", "model_id"] {
        assert_eq!(entries[0][field], identity[field]);
    }
    assert_eq!(entries[0]["until_ms"], minimum_end);
    assert!(quota_business(&client, &base, "quota-fresh-fallback")
        .await
        .contains("quota-window-fallback"));
    assert_eq!(
        business.load(SeqCst),
        10,
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
    assert_eq!(business.load(SeqCst), 11);

    for status in [503, 202] {
        probe_status.store(status, SeqCst);
        await_quota_probe(&client, &base, &identity, &probes).await;
        let entries = quota_entries(&client, &base).await;
        assert_eq!(entries.len(), 1, "early probe HTTP {status}");
        assert_eq!(entries[0]["until_ms"], minimum_end);
    }
    assert!(quota_business(&client, &base, "quota-early-probe")
        .await
        .contains("quota-window-fallback"));
    assert_eq!(business.load(SeqCst), 11);
    business_status.store(200, SeqCst);
    clock.0.store(minimum_end, SeqCst);
    await_quota_probe(&client, &base, &identity, &probes).await;
    assert!(quota_entries(&client, &base).await.is_empty());
    assert!(quota_business(&client, &base, "quota-restored")
        .await
        .contains("quota-window-primary"));
    assert_eq!(business.load(SeqCst), 12);
    business_status.store(429, SeqCst);
    assert!(quota_business(&client, &base, "controlled exhausted quota")
        .await
        .contains("quota-window-fallback"));
    let entries = quota_entries(&client, &base).await;
    assert_eq!(
        entries.len(),
        1,
        "confirmed quota exhaustion must cool on its first HTTP 429"
    );
    assert_eq!(entries[0]["provider_id"], identity["provider_id"]);
    assert_eq!(entries[0]["until_ms"], minimum_end + 3_600_000);
    assert_eq!(business.load(SeqCst), 13);
    handle.shutdown().await;
    first_task.abort();
    second_task.abort();
    let _ = first_task.await;
    let _ = second_task.await;
    std::env::remove_var("V3_P6_TEST_KEY");
}
