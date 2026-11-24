use super::*;
use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio::time::timeout;

#[derive(Clone)]
struct Peer {
    receipts: mpsc::UnboundedSender<(String, bool)>,
    release: Arc<Semaphore>,
    failures: Arc<Mutex<u32>>,
    refusal_phase: Arc<std::sync::atomic::AtomicBool>,
    success_release: Arc<Semaphore>,
    fail_streaming_probe: Arc<std::sync::atomic::AtomicBool>,
    refusal_status: u16,
    late_probe_failure: Arc<std::sync::atomic::AtomicBool>,
    late_business_failure: bool,
    /// How many business attempts are refused before the upstream starts
    /// answering normally.
    refuse_limit: u32,
}

async fn upstream(
    State(peer): State<Peer>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let auth = headers["authorization"].to_str().unwrap().to_string();
    assert_eq!(body["model"], "test");
    let probe = body.to_string().contains("ping; reply pong")
        || body
            .to_string()
            .contains("Reply exactly OK. Do not call tools.");
    peer.receipts.send((auth.clone(), probe)).unwrap();
    if auth == "Bearer spare-secret" && body.to_string().contains("held spare") {
        peer.release.acquire().await.unwrap().forget();
    }
    if auth == "Bearer controlled-secret" {
        if body.to_string().contains("held success") {
            peer.success_release.acquire().await.unwrap().forget();
            if peer.late_business_failure {
                return (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":{"message":"late in-flight business failure"}})),
                )
                    .into_response();
            }
        } else if probe {
            peer.release.acquire().await.unwrap().forget();
            if peer
                .late_probe_failure
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":{"message":"late observation failure"}})),
                )
                    .into_response();
            }
            if peer
                .fail_streaming_probe
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Response::builder()
                    .status(503)
                    .header("content-length", "100000")
                    .body(axum::body::Body::from_stream(
                        futures_util::stream::pending::<Result<String, std::io::Error>>(),
                    ))
                    .unwrap();
            }
            return (axum::http::StatusCode::OK, "not-json; no semantic terminal").into_response();
        }
        let refused = {
            let mut failures = peer.failures.lock().await;
            if peer.refusal_phase.load(std::sync::atomic::Ordering::SeqCst)
                && *failures < peer.refuse_limit
            {
                *failures += 1;
                true
            } else {
                false
            }
        };
        if refused {
            return (
                axum::http::StatusCode::from_u16(peer.refusal_status).unwrap(),
                Json(json!({"error":{"code":if peer.refusal_status == 429 { "rate_limit_exceeded" } else if peer.refusal_status == 401 { "invalid_api_key" } else { "server_error" },"message":"controlled provider failure"}})),
            )
                .into_response();
        }
    }
    if body.get("messages").is_some() {
        return Json(json!({"id":"chat-binary-state","object":"chat.completion","model":"test","choices":[{"index":0,"message":{"role":"assistant","content":auth},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})).into_response();
    }
    Json(
        json!({"id":"resp-binary-state","object":"response","status":"completed","model":"test","output":[{"id":"msg-binary-state","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":auth,"annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}),
    ).into_response()
}

async fn business(client: &reqwest::Client, managed: &Managed) -> String {
    business_at(client, &managed.base, "binary state business").await
}

async fn business_at(client: &reqwest::Client, base: &str, input: &str) -> String {
    let response = client
        .post(format!("{base}/v1/responses"))
        .json(&json!({"model":"test","input":input,"stream":false}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.text().await.unwrap()
}

async fn wait_receipt(rx: &mut mpsc::UnboundedReceiver<(String, bool)>, expected: (&str, bool)) {
    timeout(Duration::from_secs(15), async {
        loop {
            let receipt = rx.recv().await.unwrap();
            if receipt.0 == expected.0 && receipt.1 == expected.1 {
                break;
            }
        }
    })
    .await
    .expect("expected exact key dispatch");
}

#[tokio::test]
async fn recoverable_429_stays_routable_below_tenth_without_probe() {
    automatic_recovery(false, false).await;
}

#[tokio::test]
async fn in_flight_business_success_completes_without_reopening_429_backpressure() {
    automatic_recovery(true, false).await;
}

#[tokio::test]
async fn non429_hold_preserves_healthy_fallback_and_matching_success_cancels_cooling() {
    recovery_with_refusal_status(true, false, 401).await;
}

#[tokio::test]
async fn non429_business_success_supersedes_in_flight_observation_failure() {
    recovery_with_observation_race(true, false, 401, true, false).await;
}

#[tokio::test]
async fn late_inflight_failure_cannot_shadow_existing_cooldown_recovery_public_http() {
    recovery_with_observation_race(true, false, 401, false, true).await;
}

#[tokio::test]
async fn zen_non_2xx_unfinished_probe_body_preserves_cooldown_and_allows_fallback() {
    recovery_with_refusal_status(false, true, 401).await;
}

#[tokio::test]
async fn business_5xx_stays_routable_below_tenth_without_probe() {
    recovery_with_refusal_status(false, false, 503).await;
}

async fn automatic_recovery(in_flight_success: bool, fail_streaming_probe: bool) {
    recovery_with_refusal_status(in_flight_success, fail_streaming_probe, 429).await;
}

async fn recovery_with_refusal_status(
    in_flight_success: bool,
    fail_streaming_probe: bool,
    refusal_status: u16,
) {
    recovery_with_observation_race(
        in_flight_success,
        fail_streaming_probe,
        refusal_status,
        false,
        false,
    )
    .await;
}

async fn recovery_with_observation_race(
    in_flight_success: bool,
    fail_streaming_probe: bool,
    refusal_status: u16,
    late_probe_failure: bool,
    late_business_failure: bool,
) {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let failures = Arc::new(Mutex::new(0));
    let refusal_phase = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let success_release = Arc::new(Semaphore::new(0));
    let probe_failure = Arc::new(std::sync::atomic::AtomicBool::new(
        late_probe_failure
            || late_business_failure
            || (!in_flight_success && refusal_status != 429),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    // Aggregate health stores are isolated, but adaptive concurrency is keyed
    // process-wide by provider ID and auth alias. Give this peer its own identity.
    static NEXT_PROVIDER_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let provider_id = format!(
        "binary_state_{}",
        NEXT_PROVIDER_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = Arc::new(ObservationClock(AtomicU64::new(now)));
    let fail_streaming_probe_state =
        Arc::new(std::sync::atomic::AtomicBool::new(fail_streaming_probe));
    let peer = Peer {
        receipts: tx,
        release: release.clone(),
        failures: failures.clone(),
        refusal_phase: refusal_phase.clone(),
        success_release: success_release.clone(),
        fail_streaming_probe: fail_streaming_probe_state.clone(),
        refusal_status,
        late_probe_failure: probe_failure.clone(),
        late_business_failure,
        refuse_limit: if in_flight_success { 3 } else { 1 },
    };
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/responses", post(upstream))
                .route("/v1/chat/completions", post(upstream))
                .with_state(peer),
        )
        .await
        .unwrap();
    });
    env::set_var("V3_COOLDOWN_BINARY_SPARE_KEY", "spare-secret");
    let execution = hub_v1_fixture::hub_v1_test_declaration();
    let provider_type = if fail_streaming_probe {
        "openai_chat"
    } else {
        "responses"
    };
    let probe_timeout = if fail_streaming_probe {
        "request_timeout_ms = 500\ncompatibility_profile = \"chat:opencode-zen-tcm\""
    } else {
        ""
    };
    let managed = Managed::start_source_with_clock("binary-state", false, |port| format!(r#"
version = 3
[servers.main]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
[providers.{provider_id}]
type = "{provider_type}"
{probe_timeout}
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
concurrency = {{ max_in_flight = 4, acquire_timeout_ms = 60000, stale_lease_ms = 120000 }}
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}, {{ alias = "spare", env = "V3_COOLDOWN_BINARY_SPARE_KEY" }}] }}
[providers.{provider_id}.models.test]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{provider_id}", model = "test", key = "key", priority = 100 }}, {{ kind = "provider_model", provider = "{provider_id}", model = "test", key = "spare", priority = 1 }}]
"#), Some(clock.clone())).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let held_success = if in_flight_success {
        let client = client.clone();
        let base = managed.base.clone();
        let request =
            tokio::spawn(async move { business_at(&client, &base, "held success").await });
        wait_receipt(&mut rx, ("Bearer controlled-secret", false)).await;
        Some(request)
    } else {
        None
    };
    if in_flight_success {
        // The held request already owns one slot, so the three business
        // attempts must be refused together. The request-local failed
        // identity exclusion still selects the spare for each request.
        let mut attempts = Vec::new();
        for _ in 0..3 {
            let client = client.clone();
            let base = managed.base.clone();
            attempts.push(tokio::spawn(async move {
                business_at(&client, &base, "binary state business").await
            }));
        }
        for attempt in attempts {
            assert!(attempt.await.unwrap().contains("spare-secret"));
        }
        assert_eq!(
            *failures.lock().await,
            3,
            "all three concurrent business attempts must reach exact key"
        );
    } else {
        assert!(business(&client, &managed).await.contains("spare-secret"));
        assert_eq!(*failures.lock().await, 1);
    }
    let refused_count = *failures.lock().await;
    let fresh = business(&client, &managed).await;
    if refusal_status == 401 {
        assert!(
            fresh.contains("spare-secret"),
            "an immediate unrecoverable cooldown must select the healthy fallback: {fresh}"
        );
        assert_eq!(
            *failures.lock().await,
            refused_count,
            "a cooled identity must not receive a fresh request"
        );
        assert!(
            pool_entries(&client, managed.pool_url())
                .await
                .iter()
                .any(|e| e["provider_id"] == provider_id && e["auth_alias"] == "key"),
            "a confirmed permission failure must commit exact-identity cooldown"
        );
    } else {
        assert!(
            fresh.contains("controlled-secret"),
            "a recoverable failure below ten must remain routable for a fresh request: {fresh}"
        );
        assert_eq!(
            *failures.lock().await,
            refused_count,
            "the fresh request may use the identity again after the first request completed"
        );
        assert!(
            pool_entries(&client, managed.pool_url())
                .await
                .iter()
                .all(|e| e["provider_id"] != provider_id || e["auth_alias"] != "key"),
            "a recoverable failure below ten must not create a health cooldown"
        );
    }
    if late_probe_failure || late_business_failure {
        // This branch now uses an immediate unrecoverable cooldown. Trigger
        // its existing exact probe through the public manual control before
        // waiting for the controlled provider receipt.
        clock.0.store(now + 60_000, Ordering::SeqCst);
        let (status, body) = post_json(
            &client,
            managed.probe_url(),
            json!({
                "provider_id": provider_id,
                "interface_id": "default",
                "auth_alias": "key",
                "model_id": "test",
            }),
        )
        .await;
        assert_eq!(status, 200, "exact manual probe must be scheduled: {body}");
        assert_eq!(body["scheduled"], json!(true), "{body}");
        wait_receipt(&mut rx, ("Bearer controlled-secret", true)).await;
        release.add_permits(1);
        timeout(Duration::from_secs(8), async {
            loop {
                if pool_entries(&client, managed.pool_url())
                    .await
                    .iter()
                    .any(|entry| {
                        entry["provider_id"] == provider_id
                            && entry["auth_alias"] == "key"
                            && (entry["state"] == "blocked" || entry["state"] == "waiting")
                    })
                {
                    break;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the first probe must settle before a later probe is scheduled");
        assert!(
            pool_entries(&client, managed.pool_url())
                .await
                .iter()
                .any(|entry| entry["provider_id"] == provider_id && entry["auth_alias"] == "key"),
            "an in-flight probe failure must preserve the committed cooldown"
        );
        let next = business(&client, &managed).await;
        assert!(
            next.contains("spare-secret"),
            "the probe failure must not block a healthy sibling key"
        );
    }
    if refusal_status == 429 {
        refusal_phase.store(false, std::sync::atomic::Ordering::SeqCst);
        if let Some(request) = held_success {
            success_release.add_permits(1);
            assert!(request.await.unwrap().contains("controlled-secret"));
        }
        managed.finish().await;
        task.abort();
        let _ = task.await;
        env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
        return;
    }

    refusal_phase.store(false, std::sync::atomic::Ordering::SeqCst);
    if refusal_status == 503 {
        assert!(business(&client, &managed)
            .await
            .contains("controlled-secret"));
        managed.finish().await;
        task.abort();
        let _ = task.await;
        env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
        return;
    }

    if let Some(request) = held_success {
        success_release.add_permits(1);
        let held_body = timeout(Duration::from_secs(8), request)
            .await
            .expect("the held business request must finish")
            .unwrap();
        let expected_key = if late_business_failure {
            "spare-secret"
        } else {
            "controlled-secret"
        };
        assert!(
            held_body.contains(expected_key),
            "held business outcome: {held_body}"
        );
    }
    assert!(
        pool_entries(&client, managed.pool_url())
            .await
            .iter()
            .any(|entry| entry["provider_id"] == provider_id && entry["auth_alias"] == "key"),
        "a later business outcome must preserve the committed cooldown"
    );

    while rx.try_recv().is_ok() {}
    // Manual scheduling still waits for the provider-owned first cadence when
    // the injected clock is used by this fixture.
    clock.0.store(now + 60_000, Ordering::SeqCst);
    let (status, body) = post_json(
        &client,
        managed.probe_url(),
        json!({
            "provider_id": provider_id,
            "interface_id": "default",
            "auth_alias": "key",
            "model_id": "test",
        }),
    )
    .await;
    assert_eq!(status, 200, "early exact probe must be scheduled: {body}");
    assert_eq!(body["scheduled"], json!(true), "{body}");
    wait_receipt(&mut rx, ("Bearer controlled-secret", true)).await;
    assert!(
        business(&client, &managed).await.contains("spare-secret"),
        "business must continue while an exact probe is held"
    );
    wait_receipt(&mut rx, ("Bearer spare-secret", false)).await;

    let initial_entries = pool_entries(&client, managed.pool_url()).await;
    let initial = initial_entries
        .iter()
        .find(|entry| entry["provider_id"] == provider_id && entry["auth_alias"] == "key")
        .expect("the exact cooldown must remain while its probe is in flight")
        .clone();
    let deadline = initial["until_ms"].as_u64();
    assert_eq!(deadline, Some(now + 3_600_000));
    if fail_streaming_probe {
        release.add_permits(1);
        sleep(Duration::from_millis(700)).await;
    } else {
        release.add_permits(1);
    }
    timeout(Duration::from_secs(8), async {
        loop {
            let entries = pool_entries(&client, managed.pool_url()).await;
            if entries.iter().any(|entry| {
                entry["provider_id"] == provider_id
                    && entry["auth_alias"] == "key"
                    && (entry["state"] == "blocked" || entry["state"] == "waiting")
            }) {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the early probe failure must settle without restoring routing");
    assert_eq!(
        pool_entries(&client, managed.pool_url())
            .await
            .iter()
            .find(|entry| entry["provider_id"] == provider_id && entry["auth_alias"] == "key")
            .and_then(|entry| entry["until_ms"].as_u64()),
        deadline,
        "a failed probe must not change the committed cooldown deadline"
    );
    assert!(business(&client, &managed).await.contains("spare-secret"));

    clock.0.store(
        deadline.expect("cooldown deadline") + 1,
        std::sync::atomic::Ordering::SeqCst,
    );
    probe_failure.store(false, std::sync::atomic::Ordering::SeqCst);
    fail_streaming_probe_state.store(false, std::sync::atomic::Ordering::SeqCst);
    while rx.try_recv().is_ok() {}
    let (status, body) = post_json(
        &client,
        managed.probe_url(),
        json!({
            "provider_id": provider_id,
            "interface_id": "default",
            "auth_alias": "key",
            "model_id": "test",
        }),
    )
    .await;
    assert_eq!(status, 200, "expired exact probe must be scheduled: {body}");
    assert_eq!(body["scheduled"], json!(true), "{body}");
    wait_receipt(&mut rx, ("Bearer controlled-secret", true)).await;
    assert!(
        business(&client, &managed).await.contains("spare-secret"),
        "business must continue until the expired exact probe succeeds"
    );
    wait_receipt(&mut rx, ("Bearer spare-secret", false)).await;
    release.add_permits(1);
    timeout(Duration::from_secs(8), async {
        loop {
            if pool_entries(&client, managed.pool_url())
                .await
                .iter()
                .all(|entry| entry["provider_id"] != provider_id || entry["auth_alias"] != "key")
            {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("only a 2xx probe after expiry may remove the exact cooldown");
    assert!(business(&client, &managed)
        .await
        .contains("controlled-secret"));
    wait_receipt(&mut rx, ("Bearer controlled-secret", false)).await;
    managed.finish().await;
    task.abort();
    let _ = task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
}
