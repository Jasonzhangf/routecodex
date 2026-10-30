use super::*;
use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::sync::Arc;
use tokio::sync::{mpsc, Barrier, Mutex, Semaphore};
use tokio::time::timeout;

#[derive(Clone)]
struct Peer {
    receipts: mpsc::UnboundedSender<(String, bool)>,
    release: Arc<Semaphore>,
    failures: Arc<Mutex<u32>>,
    refusal_phase: Arc<std::sync::atomic::AtomicBool>,
    success_release: Arc<Semaphore>,
    fail_streaming_probe: bool,
    refusal_status: u16,
    late_probe_failure: Arc<std::sync::atomic::AtomicBool>,
    late_business_failure: bool,
    /// 429 前的并发闸门。适配后 adaptive 预算按 429 观测水位塌缩：只有三个
    /// 业务请求同时到达上游（水位=held+3=4），平滑预算才保留 held 与探针
    /// 同时在途的余量。仅在 in_flight_success 变体设置。
    rate_limit_barrier: Option<Arc<Barrier>>,
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
            if peer.fail_streaming_probe {
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
            if let Some(barrier) = &peer.rate_limit_barrier {
                barrier.wait().await;
            }
            return (
                axum::http::StatusCode::from_u16(peer.refusal_status).unwrap(),
                Json(json!({"error":{"code":if peer.refusal_status == 429 { "insufficient_quota" } else { "server_error" },"message":"controlled provider failure"}})),
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
async fn health_neutral_429_then_manual_probe_2xx_restores_exact_key() {
    automatic_recovery(false, false).await;
}

#[tokio::test]
async fn in_flight_business_success_wakes_exact_429_gate_before_backoff() {
    automatic_recovery(true, false).await;
}

#[tokio::test]
async fn non429_hold_preserves_healthy_fallback_and_matching_success_cancels_cooling() {
    recovery_with_refusal_status(true, false, 503).await;
}

#[tokio::test]
async fn non429_business_success_supersedes_in_flight_observation_failure() {
    recovery_with_observation_race(true, false, 503, true, false).await;
}

#[tokio::test]
async fn late_inflight_failure_cannot_shadow_existing_cooldown_recovery_public_http() {
    recovery_with_observation_race(true, false, 503, false, true).await;
}

#[tokio::test]
async fn zen_non_2xx_unfinished_probe_body_preserves_cooldown_and_allows_fallback() {
    recovery_with_refusal_status(false, true, 503).await;
}

#[tokio::test]
async fn business_5xx_observation_automatically_probes_and_restores_exact_key() {
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
    let peer = Peer {
        receipts: tx,
        release: release.clone(),
        failures: failures.clone(),
        refusal_phase: refusal_phase.clone(),
        success_release: success_release.clone(),
        fail_streaming_probe,
        refusal_status,
        late_probe_failure: probe_failure.clone(),
        late_business_failure,
        // The held request stays in flight for the whole refusal phase, so the
        // new 429 watermark collapses the budget below anything the held
        // request leaves free unless all three business attempts are refused
        // simultaneously. A three-party gate makes that watermark (held + 3)
        // deterministic instead of scheduler-dependent.
        rate_limit_barrier: if in_flight_success {
            Some(Arc::new(Barrier::new(3)))
        } else {
            None
        },
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
    let managed = Managed::start_source("binary-state", false, |port| format!(r#"
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
"#)).await;
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
        // attempts must be refused together: each 429 records the in-flight
        // watermark (held + 3), the hour-window median stays above the held
        // request, and the smoothed budget keeps room for the later probe.
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
    let mut refused_at = tokio::time::Instant::now();
    let refused_count = *failures.lock().await;
    assert!(business(&client, &managed).await.contains("spare-secret"));
    assert_eq!(
        *failures.lock().await,
        refused_count,
        "fresh must skip gated identity"
    );
    assert!(
        pool_entries(&client, managed.pool_url())
            .await
            .iter()
            .all(|e| e["provider_id"] != provider_id || e["auth_alias"] != "key"),
        "neither 429 nor an unobserved non429 failure may create a health cooldown"
    );
    if late_probe_failure || late_business_failure {
        wait_receipt(&mut rx, ("Bearer controlled-secret", true)).await;
        assert!(
            pool_entries(&client, managed.pool_url())
                .await
                .iter()
                .all(|entry| entry["provider_id"] != provider_id || entry["auth_alias"] != "key"),
            "an in-flight observation must not create a cooldown"
        );
        assert!(
            business(&client, &managed).await.contains("spare-secret"),
            "the observation must not block a healthy sibling key"
        );
        refused_at = tokio::time::Instant::now();
    }
    refusal_phase.store(false, std::sync::atomic::Ordering::SeqCst);
    if let Some(request) = held_success {
        if late_business_failure {
            release.add_permits(1);
            timeout(Duration::from_secs(8), async {
                loop {
                    if pool_entries(&client, managed.pool_url())
                        .await
                        .iter()
                        .any(|entry| {
                            entry["provider_id"] == provider_id && entry["auth_alias"] == "key"
                        })
                    {
                        break;
                    }
                    sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("failed qualified observation must commit exact cooldown");
            assert!(business(&client, &managed).await.contains("spare-secret"));
            success_release.add_permits(1);
            assert!(timeout(Duration::from_secs(4), request)
                .await
                .expect("late failed attempt must immediately switch to healthy spare")
                .unwrap()
                .contains("spare-secret"));
            assert!(
                pool_entries(&client, managed.pool_url())
                    .await
                    .iter()
                    .any(
                        |entry| entry["provider_id"] == provider_id && entry["auth_alias"] == "key"
                    ),
                "late failure must retain the existing cooldown owner"
            );
            probe_failure.store(false, std::sync::atomic::Ordering::SeqCst);
            while rx.try_recv().is_ok() {}
            let (status, body) = post_json(&client,
                format!("{}/_routecodex/health/cooldown-pool/probe", managed.base),
                json!({"provider_id":provider_id,"interface_id":"default","auth_alias":"key","model_id":"test"}),
            ).await;
            assert_eq!(status, 200, "force exact recovery due: {body}");
            release.add_permits(1);
            timeout(Duration::from_secs(8), async {
                loop {
                    if pool_entries(&client, managed.pool_url())
                        .await
                        .iter()
                        .all(|entry| {
                            entry["provider_id"] != provider_id || entry["auth_alias"] != "key"
                        })
                    {
                        break;
                    }
                    sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("current recovery must not be shadowed by a late precool lane");
            assert!(
                business(&client, &managed)
                    .await
                    .contains("controlled-secret"),
                "the real recovered business identity must be selected again"
            );
            managed.finish().await;
            task.abort();
            let _ = task.await;
            env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
            return;
        }
        while rx.try_recv().is_ok() {}
        let mut held_spares = Vec::new();
        for _ in 0..4 {
            let client = client.clone();
            let base = managed.base.clone();
            held_spares.push(tokio::spawn(async move {
                business_at(&client, &base, "held spare").await
            }));
            wait_receipt(&mut rx, ("Bearer spare-secret", false)).await;
        }
        let client_wait = client.clone();
        let base = managed.base.clone();
        let waiting =
            tokio::spawn(
                async move { business_at(&client_wait, &base, "waiting exact key").await },
            );
        sleep(Duration::from_millis(100)).await;
        if waiting.is_finished() {
            panic!(
                "no-alternative request completed before matching success: {:?}",
                waiting.await
            );
        }
        assert!(
            refused_at.elapsed() < Duration::from_millis(500),
            "fixture missed backoff window"
        );
        success_release.add_permits(1);
        assert!(request.await.unwrap().contains("controlled-secret"));
        assert!(timeout(Duration::from_millis(500), waiting)
            .await
            .expect("matching success must wake exact waiter before backoff")
            .unwrap()
            .contains("controlled-secret"));
        assert!(
            refused_at.elapsed() < Duration::from_millis(900),
            "natural expiry is not success wakeup"
        );
        assert!(business(&client, &managed)
            .await
            .contains("controlled-secret"));
        release.add_permits(if late_probe_failure { 5 } else { 4 });
        for held in held_spares {
            assert!(held.await.unwrap().contains("spare-secret"));
        }
        if late_probe_failure {
            // The old physical observation can now return its real 503.
            // Matching business success must have invalidated its decision.
            let until = tokio::time::Instant::now() + Duration::from_millis(1200);
            while tokio::time::Instant::now() < until {
                assert!(
                    pool_entries(&client, managed.pool_url())
                        .await
                        .iter()
                        .all(|entry| entry["provider_id"] != provider_id
                            || entry["auth_alias"] != "key"),
                    "late observation failure must not resurrect cooling"
                );
                sleep(Duration::from_millis(50)).await;
            }
            assert!(business(&client, &managed)
                .await
                .contains("controlled-secret"));
        }
        managed.finish().await;
        task.abort();
        let _ = task.await;
        env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
        return;
    }
    if refusal_status != 429 {
        // A real failed observation, rather than a manual seed, must admit
        // ordinary503 cooldown before its independent recovery probe.
        wait_receipt(&mut rx, ("Bearer controlled-secret", true)).await;
        release.add_permits(1);
        timeout(Duration::from_secs(4), async {
            loop {
                if pool_entries(&client, managed.pool_url())
                    .await
                    .iter()
                    .any(|entry| {
                        entry["provider_id"] == provider_id && entry["auth_alias"] == "key"
                    })
                {
                    break;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("failed physical observation commits exact503 cooldown");
        probe_failure.store(false, std::sync::atomic::Ordering::SeqCst);
    } else {
        let (status, body) = post_json(
            &client,
            managed.add_url(),
            json!({
                "provider_id":provider_id, "interface_id":"default", "auth_alias":"key",
                "model_id":"test", "kind":"probe", "duration_ms":1100
            }),
        )
        .await;
        assert_eq!(status, 200, "manual health probe seed: {body}");
    }
    wait_receipt(&mut rx, ("Bearer controlled-secret", true)).await;
    let entries = pool_entries(&client, managed.pool_url()).await;
    assert!(
        entries.iter().any(|entry| entry["auth_alias"] == "key"
            && entry["model_id"] == "test"
            && (entry["state"] == "probing"
                || (fail_streaming_probe && entry["state"] == "waiting"))),
        "overdue in-flight identity must stay in pool: {entries:?}"
    );
    assert!(business(&client, &managed).await.contains("spare-secret"));
    wait_receipt(&mut rx, ("Bearer spare-secret", false)).await;
    if fail_streaming_probe {
        release.add_permits(100);
        let mut last = Vec::new();
        let retained = timeout(Duration::from_secs(8), async {
            loop {
                last = pool_entries(&client, managed.pool_url()).await;
                if last.iter().any(|entry| {
                    entry["auth_alias"] == "key"
                        && entry["failure_count"].as_u64().unwrap_or(0) >= 1
                        && (entry["state"] == "blocked" || entry["state"] == "waiting")
                }) {
                    break;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(
            retained.is_ok(),
            "an unfinished probe body must complete as a failure and retain the cooldown: {last:?}"
        );
        assert!(timeout(Duration::from_secs(2), business(&client, &managed))
            .await
            .expect("failed probe must not block fallback")
            .contains("spare-secret"));
        managed.finish().await;
        task.abort();
        let _ = task.await;
        env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
        return;
    }
    release.add_permits(1);
    timeout(Duration::from_secs(10), async {
        loop {
            if pool_entries(&client, managed.pool_url())
                .await
                .iter()
                .all(|entry| entry["auth_alias"] != "key")
            {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a matching 2xx probe removes the exact cooldown");
    assert!(business(&client, &managed)
        .await
        .contains("controlled-secret"));
    wait_receipt(&mut rx, ("Bearer controlled-secret", false)).await;
    managed.finish().await;
    task.abort();
    let _ = task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
}

// A business 2xx must restore the adaptive concurrency budget that a 429
// reduced, otherwise a recovered key stays admission-busy and a later business
// request is silently routed to the fallback key.
#[tokio::test]
async fn business_success_restores_budget_for_a_later_business_request() {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let failures = Arc::new(Mutex::new(0));
    let success_release = Arc::new(Semaphore::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    static NEXT_BUDGET_PROVIDER_ID: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);
    let provider_id = format!(
        "budget_state_{}",
        NEXT_BUDGET_PROVIDER_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let peer = Peer {
        receipts: tx,
        release: Arc::new(Semaphore::new(0)),
        failures: failures.clone(),
        refusal_phase: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        success_release: success_release.clone(),
        fail_streaming_probe: false,
        refusal_status: 429,
        late_probe_failure: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        late_business_failure: false,
        rate_limit_barrier: None,
        refuse_limit: 3,
    };
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/responses", post(upstream))
                .with_state(peer),
        )
        .await
        .unwrap();
    });
    env::set_var("V3_COOLDOWN_BINARY_SPARE_KEY", "spare-secret");
    let execution = hub_v1_fixture::hub_v1_test_declaration();
    let managed = Managed::start_source("budget-state", false, |port| format!(r#"
version = 3
[servers.main]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
[providers.{provider_id}]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
concurrency = {{ max_in_flight = 4, acquire_timeout_ms = 60000, stale_lease_ms = 120000 }}
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}, {{ alias = "spare", env = "V3_COOLDOWN_BINARY_SPARE_KEY" }}] }}
[providers.{provider_id}.models.test]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{provider_id}", model = "test", key = "key", priority = 100 }}, {{ kind = "provider_model", provider = "{provider_id}", model = "test", key = "spare", priority = 1 }}]
"#)).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    // Two failures are already banked when held A is dispatched, so the third
    // business 429 is refused while held A occupies a slot: the 429 watermark
    // (held + 1) collapses the budget to 1 exactly as the old three-429
    // sequence did, and held A still lands on the 2xx gate the mock opens.
    let held_a = {
        let client = client.clone();
        let base = managed.base.clone();
        tokio::spawn(async move { business_at(&client, &base, "held success").await })
    };
    wait_receipt(&mut rx, ("Bearer controlled-secret", false)).await;
    *failures.lock().await = 2;
    assert!(business(&client, &managed).await.contains("spare-secret"));
    assert_eq!(
        *failures.lock().await,
        3,
        "the business attempt must reach the exact key while held A is in flight"
    );
    // Held A completes with a real 2xx; it must restore the budget from 1 to 2.
    success_release.add_permits(1);
    let held_a_body = held_a.await.unwrap();
    assert!(
        held_a_body.contains("controlled-secret"),
        "held A response: {held_a_body}"
    );
    while rx.try_recv().is_ok() {}
    // Held B occupies the single restored slot. Without the fix the budget is
    // still 1, so the next business request is busy and falls to the spare key.
    let held_b = {
        let client = client.clone();
        let base = managed.base.clone();
        tokio::spawn(async move { business_at(&client, &base, "held success").await })
    };
    wait_receipt(&mut rx, ("Bearer controlled-secret", false)).await;
    assert!(
        business(&client, &managed)
            .await
            .contains("controlled-secret"),
        "a business 2xx must restore the adaptive concurrency budget"
    );
    success_release.add_permits(1);
    let held_b_body = held_b.await.unwrap();
    assert!(
        held_b_body.contains("controlled-secret"),
        "held B response: {held_b_body}"
    );
    managed.finish().await;
    task.abort();
    let _ = task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
}
