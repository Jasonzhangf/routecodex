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
    failures: Arc<Mutex<u32>>,
    refusal_phase: Arc<std::sync::atomic::AtomicBool>,
    success_release: Arc<Semaphore>,
    refusal_status: u16,
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
    if probe {
        return (axum::http::StatusCode::BAD_REQUEST, "synthetic traffic").into_response();
    }
    if body.to_string().contains("terminal trial failure") {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":{"message":"terminal trial failure"}})),
        )
            .into_response();
    }
    if auth == "Bearer controlled-secret" && body.to_string().contains("held compatibility trial") {
        peer.success_release.acquire().await.unwrap().forget();
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"error":{"code":"invalid_request_error","message":"controlled compatibility failure"}})),
        )
            .into_response();
    }
    if auth == "Bearer controlled-secret" {
        if body.to_string().contains("incomplete recovery") {
            return Response::builder()
                .status(503)
                .header("content-length", "100000")
                .body(axum::body::Body::from_stream(
                    futures_util::stream::pending::<Result<String, std::io::Error>>(),
                ))
                .unwrap();
        }
        if body.to_string().contains("failed recovery") {
            if body.to_string().contains("held failed recovery") {
                peer.success_release.acquire().await.unwrap().forget();
            }
            return (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":{"message":"upstream is still unavailable"}})),
            )
                .into_response();
        }
        if body.to_string().contains("held success") {
            peer.success_release.acquire().await.unwrap().forget();
            if peer.late_business_failure {
                return (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":{"message":"late in-flight business failure"}})),
                )
                    .into_response();
            }
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

#[derive(Clone, Copy)]
enum EntryMode {
    Direct,
    Relay,
}

fn recovery_config(port: u16, upstream_port: u16, mode: EntryMode) -> String {
    let mut execution = hub_v1_fixture::hub_v1_test_declaration();
    if matches!(mode, EntryMode::Relay) {
        execution = execution.replace(
            "execution_mode = \"direct\", protocol_profile_owner = \"v3.entry_protocol_registry_contract\", implemented = true, forbidden_reentry_behavior = \"Responses endpoint must not fall through to relay or pending runtime.\", runtime_owner_symbol = \"execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug\", runtime_owner_path = \"v3/crates/routecodex-v3-runtime/src/kernel.rs\"",
            "execution_mode = \"relay\", protocol_profile_owner = \"v3.hub_relay_runtime_closeout\", implemented = true, forbidden_reentry_behavior = \"Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.\", runtime_owner_symbol = \"execute_v3_responses_relay_runtime_with_default_transport\", runtime_owner_path = \"v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs\"",
        );
    }
    format!(
        r#"
version = 3
[servers.main]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
[providers.primary]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}] }}
[providers.primary.models.test]
[providers.spare]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_BINARY_SPARE_KEY" }}] }}
[providers.spare.models.test]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "primary", model = "test", key = "key", priority = 100 }}, {{ kind = "provider_model", provider = "spare", model = "test", key = "key", priority = 1 }}]
"#
    )
}

async fn assert_terminal_trial_remains_routable(mode: EntryMode) {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/responses", post(upstream))
                .with_state(Peer {
                    receipts: tx,
                    failures: Arc::new(Mutex::new(0)),
                    refusal_phase: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                    success_release: Arc::new(Semaphore::new(0)),
                    refusal_status: 401,
                    late_business_failure: false,
                    refuse_limit: 1,
                }),
        )
        .await
        .unwrap();
    });
    env::set_var("V3_COOLDOWN_BINARY_SPARE_KEY", "spare-secret");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = Arc::new(ObservationClock(AtomicU64::new(now)));
    let managed = Managed::start_source_with_clock(
        "terminal-trial-public",
        false,
        |port| recovery_config(port, upstream_port, mode),
        Some(clock.clone()),
    )
    .await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    assert!(business(&client, &managed).await.contains("spare-secret"));
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer controlled-secret".into(), false)
    );
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer spare-secret".into(), false)
    );
    let cooldown = pool_entries(&client, managed.pool_url())
        .await
        .into_iter()
        .find(|entry| entry["provider_id"] == "primary")
        .expect("the real primary 401 must create its cooldown");
    let until = cooldown["until_ms"].as_u64().unwrap();
    clock.0.store(until + 10_000, Ordering::SeqCst);

    for _ in 0..2 {
        let response = client
            .post(format!("{}/v1/responses", managed.base))
            .json(&json!({"model":"primary.test","input":"terminal trial failure","stream":false}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 503);
        assert_eq!(
            response.text().await.unwrap(),
            r#"{"error":{"message":"terminal trial failure"}}"#
        );
        assert_eq!(
            timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap(),
            ("Bearer controlled-secret".into(), false),
            "each independent singleton terminal attempt must reach the real provider"
        );
    }
    managed.finish().await;
    task.abort();
    let _ = task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
}

async fn assert_superseded_compatibility_trial_preserves_newer_state(mode: EntryMode) {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let upstream_release = release.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/responses", post(upstream))
                .with_state(Peer {
                    receipts: tx,
                    failures: Arc::new(Mutex::new(0)),
                    refusal_phase: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                    success_release: upstream_release,
                    refusal_status: 403,
                    late_business_failure: false,
                    refuse_limit: 1,
                }),
        )
        .await
        .unwrap();
    });
    env::set_var("V3_COOLDOWN_BINARY_SPARE_KEY", "spare-secret");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = Arc::new(ObservationClock(AtomicU64::new(now)));
    let mut managed = Managed::start_source_with_clock(
        "stale-compatibility-public",
        false,
        |port| recovery_config(port, upstream_port, mode),
        Some(clock.clone()),
    )
    .await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    assert!(business(&client, &managed).await.contains("spare-secret"));
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer controlled-secret".into(), false)
    );
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer spare-secret".into(), false)
    );
    let (status, initial) = post_json(
        &client,
        managed.add_url(),
        json!({
            "kind":"probe", "provider_id":"primary", "interface_id":"default",
            "auth_alias":"key", "model_id":"test", "duration_ms":5_000
        }),
    )
    .await;
    assert_eq!(status, 200, "{initial}");
    let initial_deadline = initial["until_ms"].as_u64().unwrap();
    clock.0.store(initial_deadline + 10_000, Ordering::SeqCst);

    let trial = {
        let client = client.clone();
        let base = managed.base.clone();
        tokio::spawn(async move { business_at(&client, &base, "held compatibility trial").await })
    };
    assert_eq!(
        timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap(),
        ("Bearer controlled-secret".into(), false)
    );
    let (status, body) = post_json(
        &client,
        managed.add_url(),
        json!({
            "kind":"probe", "provider_id":"primary", "interface_id":"default",
            "auth_alias":"key", "model_id":"test", "duration_ms":10_800_000
        }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let extended = pool_entries(&client, managed.pool_url())
        .await
        .into_iter()
        .find(|entry| entry["provider_id"] == "primary")
        .expect("operator extension must retain the primary cooldown");
    let deadline = extended["until_ms"].as_u64().unwrap();
    assert!(deadline > initial_deadline);
    let extended_failure_count = extended["failure_count"].as_u64().unwrap();

    release.add_permits(1);
    assert!(trial.await.unwrap().contains("spare-secret"));
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer spare-secret".into(), false)
    );
    let settled = pool_entries(&client, managed.pool_url())
        .await
        .into_iter()
        .find(|entry| entry["provider_id"] == "primary")
        .expect("the stale compatibility result must preserve the newer cooldown");
    assert_eq!(settled["until_ms"].as_u64(), Some(deadline));
    assert_eq!(
        settled["failure_count"].as_u64(),
        Some(extended_failure_count)
    );

    clock.0.store(deadline - 1, Ordering::SeqCst);
    assert!(business(&client, &managed).await.contains("spare-secret"));
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer spare-secret".into(), false)
    );
    managed.handle.take().unwrap().shutdown().await;
    let paths: Vec<_> = fs::read_dir(managed.home.join(".rcc/state"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("provider-cooldowns-") && name.ends_with(".json")
                })
        })
        .collect();
    assert_eq!(paths.len(), 1, "one listener owns the persisted health");
    let store = routecodex_v3_provider_responses::V3ProviderCooldownCoordinator::load(
        paths.into_iter().next().unwrap(),
    )
    .unwrap();
    let exact = |key: &routecodex_v3_provider_responses::V3ProviderCooldownKey| {
        key.provider_id == "primary"
            && key.interface_id == "default"
            && key.auth_alias.as_deref() == Some("key")
            && key.model_id.as_deref() == Some("test")
    };
    let (_, minimum, next_trial) = store
        .persisted_entries()
        .into_iter()
        .find(|(key, _, _)| exact(key))
        .expect("the newer identity persists");
    assert_eq!((minimum, next_trial), (deadline, deadline));
    let (_, episode) = store
        .persisted_rate_limit_episodes()
        .into_iter()
        .find(|(key, _)| exact(key))
        .expect("the real HTTP 403 streak persists");
    assert_eq!(episode.failure_count, 1);
    assert!(episode.failure_streak_is_http_403);
    managed.finish().await;
    task.abort();
    let _ = task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
}

#[tokio::test]
async fn superseded_compatibility_failure_preserves_newer_cooldown_public_http() {
    assert_superseded_compatibility_trial_preserves_newer_state(EntryMode::Direct).await;
    assert_superseded_compatibility_trial_preserves_newer_state(EntryMode::Relay).await;
}

#[tokio::test]
async fn final_terminal_trial_is_health_neutral_on_direct_public_entry() {
    assert_terminal_trial_remains_routable(EntryMode::Direct).await;
}

#[tokio::test]
async fn final_terminal_trial_is_health_neutral_on_relay_public_entry() {
    assert_terminal_trial_remains_routable(EntryMode::Relay).await;
}

#[tokio::test]
async fn direct_trial_uses_successor_window_at_failure_public_http() {
    for spare_opens in [true, false] {
        let _guard = TEST_LOCK.lock().await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let release = Arc::new(Semaphore::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let peer = Peer {
            receipts: tx,
            failures: Arc::new(Mutex::new(0)),
            refusal_phase: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            success_release: release.clone(),
            refusal_status: 503,
            late_business_failure: false,
            refuse_limit: 0,
        };
        let upstream_task = tokio::spawn(async move {
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
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let minute = now / 60_000 % 1_440;
        let hhmm = |minute: u64| {
            let minute = minute % 1_440;
            format!("{:02}:{:02}", minute / 60, minute % 60)
        };
        let (start, end) = if spare_opens {
            (hhmm(minute + 3), hhmm(minute + 9))
        } else {
            (hhmm(minute + 1_437), hhmm(minute + 3))
        };
        let clock = Arc::new(ObservationClock(AtomicU64::new(now)));
        let managed = Managed::start_source_with_clock(
            "direct-recovery-successor-window",
            false,
            |port| {
                recovery_config(port, upstream_port, EntryMode::Direct).replace(
                    "[providers.spare.models.test]",
                    &format!(
                        "[providers.spare.models.test]\navailability = {{ timezone = \"UTC\", periods = [{{ start = \"{start}\", end = \"{end}\" }}] }}"
                    ),
                )
            },
            Some(clock.clone()),
        )
        .await;
        let client = reqwest::Client::new();
        let (status, seeded) = post_json(
            &client,
            managed.add_url(),
            json!({
                "kind":"probe", "provider_id":"primary", "interface_id":"default",
                "auth_alias":"key", "model_id":"test", "duration_ms":5_000
            }),
        )
        .await;
        assert_eq!(status, 200, "{seeded}");
        let deadline = seeded["until_ms"].as_u64().unwrap();
        clock.0.store(deadline + 1, Ordering::SeqCst);
        let trial = tokio::spawn(
            client
                .post(format!("{}/v1/responses", managed.base))
                .json(&json!({"model":"test","input":"held failed recovery","stream":false}))
                .send(),
        );
        assert_eq!(
            timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap(),
            ("Bearer controlled-secret".into(), false)
        );
        clock.0.store(now + 5 * 60_000, Ordering::SeqCst);
        release.add_permits(1);
        let response = timeout(Duration::from_secs(5), trial)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let status = response.status();
        let body = response.text().await.unwrap();
        if spare_opens {
            assert_eq!(status, 200, "eligible successor must serve: {body}");
            assert!(body.contains("spare-secret"), "{body}");
            assert_eq!(
                rx.try_recv().unwrap(),
                ("Bearer spare-secret".into(), false)
            );
        } else {
            assert_eq!(
                status, 503,
                "closed successor leaves a real final error: {body}"
            );
            assert!(body.contains("upstream is still unavailable"), "{body}");
            assert!(rx.try_recv().is_err());
            let next = client
                .post(format!("{}/v1/responses", managed.base))
                .json(&json!({"model":"primary.test","input":"terminal trial failure","stream":false}))
                .send()
                .await
                .unwrap();
            assert_eq!(
                next.status(),
                503,
                "the final trial must preserve immediate eligibility"
            );
            assert_eq!(
                rx.try_recv().unwrap(),
                ("Bearer controlled-secret".into(), false)
            );
        }
        managed.finish().await;
        upstream_task.abort();
        let _ = upstream_task.await;
        env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
    }
}

#[tokio::test]
async fn recoverable_429_stays_routable_below_tenth_without_probe() {
    automatic_recovery(false, false).await;
}

#[derive(Debug)]
struct RetryWindowClock {
    open: AtomicU64,
    closed: u64,
    sample: std::sync::atomic::AtomicUsize,
}

impl routecodex_v3_runtime::V3ProviderHealthObservationClock for RetryWindowClock {
    fn now_epoch_ms(&self) -> u64 {
        let state = self.sample.load(Ordering::SeqCst);
        if state == 1 {
            self.sample.store(2, Ordering::SeqCst);
        }
        if state == 2 {
            self.closed
        } else {
            self.open.load(Ordering::SeqCst)
        }
    }
}

#[tokio::test]
async fn direct_429_replans_when_its_preferred_successor_closes_public_http() {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let minute = now / 60_000 % 1_440;
    let hhmm = |minute: u64| {
        let minute = minute % 1_440;
        format!("{:02}:{:02}", minute / 60, minute % 60)
    };
    let (start, end) = (hhmm(minute + 1_437), hhmm(minute + 3));
    let clock = Arc::new(RetryWindowClock {
        open: AtomicU64::new(now),
        closed: now + 5 * 60_000,
        sample: std::sync::atomic::AtomicUsize::new(0),
    });
    let upstream_clock = clock.clone();
    let peer = Peer {
        receipts: tx,
        failures: Arc::new(Mutex::new(0)),
        refusal_phase: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        success_release: Arc::new(Semaphore::new(0)),
        refusal_status: 429,
        late_business_failure: false,
        refuse_limit: 1,
    };
    let upstream_task = tokio::spawn(async move {
        let router = Router::new()
            .route(
                "/v1/responses",
                post(
                    move |state: State<Peer>, headers: HeaderMap, body: Json<Value>| {
                        let clock = upstream_clock.clone();
                        async move {
                            let response = upstream(state, headers, body).await;
                            if response.status() == axum::http::StatusCode::TOO_MANY_REQUESTS {
                                // The failure policy observes the open window once.
                                // The next selection observes the closed window.
                                clock.sample.store(1, Ordering::SeqCst);
                            }
                            response
                        }
                    },
                ),
            )
            .with_state(peer);
        axum::serve(listener, router).await.unwrap();
    });
    env::set_var("V3_COOLDOWN_BINARY_SPARE_KEY", "spare-secret");
    env::set_var("V3_COOLDOWN_BINARY_THIRD_KEY", "third-secret");
    let managed = Managed::start_source_with_clock(
        "direct-429-preferred-window",
        false,
        |port| {
            recovery_config(port, upstream_port, EntryMode::Direct)
                .replace("[providers.spare.models.test]", &format!(
                    "[providers.spare.models.test]\navailability = {{ timezone = \"UTC\", periods = [{{ start = \"{start}\", end = \"{end}\" }}] }}"
                ))
                .replace("[route_groups.default.pools.default]", &format!(r#"
[providers.third]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_BINARY_THIRD_KEY" }}] }}
[providers.third.models.test]
[route_groups.default.pools.default]"#))
                .replace(
                    "provider = \"spare\", model = \"test\", key = \"key\", priority = 1 }]",
                    "provider = \"spare\", model = \"test\", key = \"key\", priority = 10 }, { kind = \"provider_model\", provider = \"third\", model = \"test\", key = \"key\", priority = 1 }]",
                )
        },
        Some(clock.clone()),
    ).await;
    let client = reqwest::Client::new();
    let (status, seeded) = post_json(
        &client,
        managed.add_url(),
        json!({
            "kind":"probe", "provider_id":"primary", "interface_id":"default",
            "auth_alias":"key", "model_id":"test", "duration_ms":5_000
        }),
    )
    .await;
    assert_eq!(status, 200, "{seeded}");
    clock
        .open
        .store(seeded["until_ms"].as_u64().unwrap() + 1, Ordering::SeqCst);
    let body = business(&client, &managed).await;
    assert!(
        body.contains("third-secret"),
        "the closed preferred key must be skipped: {body}"
    );
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer controlled-secret".into(), false)
    );
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer third-secret".into(), false)
    );
    assert!(rx.try_recv().is_err());
    managed.finish().await;
    upstream_task.abort();
    let _ = upstream_task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
    env::remove_var("V3_COOLDOWN_BINARY_THIRD_KEY");
}

#[tokio::test]
async fn direct_tenth_429_crosses_120_seconds_while_in_flight_public_http() {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let release = Arc::new(Semaphore::new(0));
    let upstream_release = release.clone();
    let peer = Peer {
        receipts: tx,
        failures: Arc::new(Mutex::new(0)),
        refusal_phase: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        success_release: release.clone(),
        refusal_status: 429,
        late_business_failure: false,
        refuse_limit: 10,
    };
    let upstream_task = tokio::spawn(async move {
        let router = Router::new()
            .route(
                "/v1/responses",
                post(
                    move |state: State<Peer>, headers: HeaderMap, body: Json<Value>| {
                        let release = upstream_release.clone();
                        async move {
                            let held = headers["authorization"] == "Bearer controlled-secret"
                                && body.to_string().contains("held tenth 429");
                            let response = upstream(state, headers, body).await;
                            if held {
                                assert_eq!(response.status(), 429);
                                release.acquire().await.unwrap().forget();
                            }
                            response
                        }
                    },
                ),
            )
            .with_state(peer);
        axum::serve(listener, router).await.unwrap();
    });
    env::set_var("V3_COOLDOWN_BINARY_SPARE_KEY", "spare-secret");
    let wall_now = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    };
    let first_429_ms = wall_now() - 115_000;
    let threshold = first_429_ms + 120_000;
    let clock = Arc::new(ObservationClock(AtomicU64::new(first_429_ms)));
    let mut managed = Managed::start_source_with_clock(
        "direct-429-in-flight-span",
        false,
        |port| recovery_config(port, upstream_port, EntryMode::Direct),
        Some(clock.clone()),
    )
    .await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .pool_max_idle_per_host(0)
        .build()
        .unwrap();
    for attempt in 0..9 {
        clock.0.store(first_429_ms + attempt * 10, Ordering::SeqCst);
        assert!(business(&client, &managed).await.contains("spare-secret"));
        assert_eq!(
            rx.try_recv().unwrap(),
            ("Bearer controlled-secret".into(), false)
        );
        assert_eq!(
            rx.try_recv().unwrap(),
            ("Bearer spare-secret".into(), false)
        );
    }
    assert!(pool_entries(&client, managed.pool_url()).await.is_empty());

    // Restore the nine real observations into a listener using the production clock.
    managed.handle.take().unwrap().shutdown().await;
    timeout(Duration::from_secs(2), async {
        loop {
            if tokio::net::TcpListener::bind(("127.0.0.1", managed.listener_port))
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the isolated listener must release its port before rebuild");
    let manifest = V3ConfigStore::new(managed.home.join("config.v3.toml"))
        .load_snapshot_with_source_identity()
        .unwrap()
        .manifest;
    managed.handle = Some(
        routecodex_v3_server::spawn_v3_server_aggregate(manifest)
            .await
            .unwrap(),
    );
    let tenth = {
        let client = client.clone();
        let base = managed.base.clone();
        tokio::spawn(async move { business_at(&client, &base, "held tenth 429").await })
    };
    assert_eq!(
        timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap(),
        ("Bearer controlled-secret".into(), false)
    );
    let entered = wall_now();
    assert!(
        entered < threshold,
        "the tenth request must enter inside the 120-second span"
    );
    tokio::time::sleep(Duration::from_millis(threshold + 250 - entered)).await;
    assert!(wall_now() > threshold);
    release.add_permits(1);
    assert!(tenth.await.unwrap().contains("spare-secret"));
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer spare-secret".into(), false)
    );
    assert!(
        pool_entries(&client, managed.pool_url()).await.is_empty(),
        "the tenth observed 429 beyond 120 seconds must not start a short cooldown"
    );
    assert!(business(&client, &managed)
        .await
        .contains("controlled-secret"));
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer controlled-secret".into(), false)
    );
    assert!(rx.try_recv().is_err());
    managed.finish().await;
    upstream_task.abort();
    let _ = upstream_task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
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
    recovery_with_observation_race(true, false, 401, true, false, None).await;
}

#[tokio::test]
async fn late_inflight_failure_cannot_shadow_existing_cooldown_recovery_public_http() {
    recovery_with_observation_race(true, false, 401, false, true, None).await;
}

#[tokio::test]
async fn expired_cooldown_is_recovered_by_the_real_request_public_http() {
    recovery_with_observation_race(false, false, 401, false, false, Some(TrialOutcome::Success))
        .await;
}

#[tokio::test]
async fn failed_real_recovery_attempt_preserves_cooldown_public_http() {
    recovery_with_observation_race(false, false, 401, false, false, Some(TrialOutcome::Failure))
        .await;
}

#[tokio::test]
async fn expired_cooldown_is_recovered_by_the_real_request_relay_public_http() {
    recovery_with_observation_race(
        false,
        false,
        401,
        false,
        false,
        Some(TrialOutcome::RelaySuccess),
    )
    .await;
}

enum TrialOutcome {
    Success,
    Failure,
    RelaySuccess,
}

#[tokio::test]
async fn slow_direct_trial_defers_from_failure_settlement_public_http() {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let peer = Peer {
        receipts: tx,
        failures: Arc::new(Mutex::new(0)),
        refusal_phase: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        success_release: release.clone(),
        refusal_status: 503,
        late_business_failure: false,
        refuse_limit: 0,
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
    let managed = Managed::start_source("slow-direct-trial", false, |port| format!(r#"
version = 3
[servers.main]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
[providers.slow_direct_trial]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}, {{ alias = "spare", env = "V3_COOLDOWN_BINARY_SPARE_KEY" }}] }}
[providers.slow_direct_trial.models.test]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "slow_direct_trial", model = "test", key = "key", priority = 100 }}, {{ kind = "provider_model", provider = "slow_direct_trial", model = "test", key = "spare", priority = 1 }}]
"#)).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let (status, body) = post_json(
        &client,
        managed.add_url(),
        json!({
            "kind":"probe", "provider_id":"slow_direct_trial", "interface_id":"default",
            "auth_alias":"key", "model_id":"test", "duration_ms":1
        }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    sleep(Duration::from_millis(20)).await;
    let trial = {
        let client = client.clone();
        let base = managed.base.clone();
        tokio::spawn(async move { business_at(&client, &base, "held failed recovery").await })
    };
    assert_eq!(
        timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap(),
        ("Bearer controlled-secret".to_owned(), false)
    );
    // The first failed trial uses the existing ten-second cadence. Holding
    // beyond it makes entry-based settlement immediately eligible and wrong.
    sleep(Duration::from_secs(11)).await;
    let failure_not_before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    release.add_permits(1);
    let switched = trial.await.unwrap();
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer spare-secret".to_owned(), false)
    );
    let before_deadline = business(&client, &managed).await;
    let premature = rx.try_recv().unwrap();
    let entries = pool_entries(&client, managed.pool_url()).await;
    let retained = entries
        .iter()
        .any(|entry| entry["provider_id"] == "slow_direct_trial" && entry["auth_alias"] == "key");
    // The public spare response follows settlement, so this is an upper
    // bound on the failure-based deadline without a production test clock.
    sleep(Duration::from_secs(10)).await;
    let recovered = business(&client, &managed).await;
    let recovery_receipt = rx.try_recv().unwrap();
    let cleared = pool_entries(&client, managed.pool_url())
        .await
        .iter()
        .all(|entry| entry["provider_id"] != "slow_direct_trial" || entry["auth_alias"] != "key");
    let extra_send = rx.try_recv().ok();
    managed.finish().await;
    task.abort();
    let _ = task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
    assert!(switched.contains("spare-secret"));
    assert!(
        before_deadline.contains("spare-secret"),
        "slow failure must defer from settlement ({failure_not_before}), not request entry"
    );
    assert_eq!(premature, ("Bearer spare-secret".to_owned(), false));
    assert!(
        retained,
        "failed trial must retain the episode until a later real trial"
    );
    assert!(recovered.contains("controlled-secret"));
    assert_eq!(
        recovery_receipt,
        ("Bearer controlled-secret".to_owned(), false)
    );
    assert!(cleared);
    assert_eq!(extra_send, None, "no automatic or duplicate sends");
}

#[tokio::test]
async fn direct_failure_hands_off_an_expired_trial_to_relay_once() {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/responses", post(upstream))
                .route("/v1/chat/completions", post(upstream))
                .with_state(Peer {
                    receipts: tx,
                    failures: Arc::new(Mutex::new(0)),
                    refusal_phase: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                    success_release: Arc::new(Semaphore::new(0)),
                    refusal_status: 401,
                    late_business_failure: false,
                    refuse_limit: 1,
                }),
        )
        .await
        .unwrap();
    });
    env::set_var("V3_COOLDOWN_BINARY_SPARE_KEY", "spare-secret");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = Arc::new(ObservationClock(AtomicU64::new(now)));
    let execution = hub_v1_fixture::hub_v1_test_declaration();
    let managed = Managed::start_source_with_clock("cross-protocol-recovery", false, |port| format!(r#"
version = 3
[servers.main]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["openai_chat"]
{execution}
[providers.direct]
type = "openai_chat"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}] }}
[providers.direct.models.test]
[providers.recovering]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "spare", env = "V3_COOLDOWN_BINARY_SPARE_KEY" }}] }}
[providers.recovering.models.test]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
    {{ kind = "provider_model", provider = "direct", model = "test", key = "key", priority = 100 }},
    {{ kind = "provider_model", provider = "recovering", model = "test", key = "spare", priority = 1 }},
]
"#), Some(clock.clone())).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap();
    let (status, body) = post_json(
        &client,
        managed.add_url(),
        json!({
            "kind":"probe", "provider_id":"recovering", "interface_id":"default",
            "auth_alias":"spare", "model_id":"test", "duration_ms":60_000
        }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let until = pool_entries(&client, managed.pool_url())
        .await
        .iter()
        .find(|entry| entry["provider_id"] == "recovering")
        .unwrap()["until_ms"]
        .as_u64()
        .unwrap();
    clock.0.store(until + 1, Ordering::SeqCst);
    let response = client.post(format!("{}/v1/chat/completions", managed.base))
        .json(&json!({"model":"test","messages":[{"role":"user","content":"real recovery"}],"stream":false}))
        .send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.text().await.unwrap().contains("spare-secret"));
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer controlled-secret".to_owned(), false)
    );
    assert_eq!(
        rx.try_recv().unwrap(),
        ("Bearer spare-secret".to_owned(), false)
    );
    assert!(rx.try_recv().is_err());
    assert!(pool_entries(&client, managed.pool_url())
        .await
        .iter()
        .all(|entry| entry["provider_id"] != "recovering"));
    managed.finish().await;
    upstream.abort();
    let _ = upstream.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
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
        None,
    )
    .await;
}

async fn recovery_with_observation_race(
    in_flight_success: bool,
    fail_streaming_probe: bool,
    refusal_status: u16,
    late_probe_failure: bool,
    late_business_failure: bool,
    business_recovery: Option<TrialOutcome>,
) {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let failures = Arc::new(Mutex::new(0));
    let refusal_phase = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let success_release = Arc::new(Semaphore::new(0));
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
    let peer = Peer {
        receipts: tx,
        failures: failures.clone(),
        refusal_phase: refusal_phase.clone(),
        success_release: success_release.clone(),
        refusal_status,
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
    let provider_type =
        if fail_streaming_probe || matches!(business_recovery, Some(TrialOutcome::RelaySuccess)) {
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
    if let Some(expected) = business_recovery {
        refusal_phase.store(false, Ordering::SeqCst);
        clock.0.store(now + 3_600_001, Ordering::SeqCst);
        let mut synthetic_attempts = 0;
        while let Ok((_, synthetic)) = rx.try_recv() {
            synthetic_attempts += usize::from(synthetic);
        }
        assert!(
            timeout(Duration::from_millis(1_100), rx.recv())
                .await
                .is_err(),
            "expiry must not dispatch an upstream request without business traffic"
        );
        if matches!(expected, TrialOutcome::Failure) {
            let switched = business_at(&client, &managed.base, "failed recovery").await;
            assert_eq!(
                rx.try_recv().unwrap(),
                ("Bearer controlled-secret".to_owned(), false)
            );
            assert_eq!(
                rx.try_recv().unwrap(),
                ("Bearer spare-secret".to_owned(), false)
            );
            let next = business(&client, &managed).await;
            assert_eq!(
                rx.try_recv().unwrap(),
                ("Bearer spare-secret".to_owned(), false)
            );
            let remains_cooled = pool_entries(&client, managed.pool_url())
                .await
                .iter()
                .any(|entry| entry["provider_id"] == provider_id && entry["auth_alias"] == "key");
            while let Ok((_, synthetic)) = rx.try_recv() {
                synthetic_attempts += usize::from(synthetic);
            }
            managed.finish().await;
            task.abort();
            let _ = task.await;
            env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
            assert!(switched.contains("spare-secret") && next.contains("spare-secret"));
            assert!(
                remains_cooled,
                "failed recovery must retain the exact cooldown"
            );
            assert_eq!(synthetic_attempts, 0);
            return;
        }
        let trial = {
            let client = client.clone();
            let base = managed.base.clone();
            tokio::spawn(async move { business_at(&client, &base, "held success").await })
        };
        assert_eq!(
            timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap(),
            ("Bearer controlled-secret".to_owned(), false),
        );
        let (first, second) =
            tokio::join!(business(&client, &managed), business(&client, &managed));
        success_release.add_permits(1);
        let outcome = trial.await.unwrap();
        let remains_cooled = pool_entries(&client, managed.pool_url())
            .await
            .iter()
            .any(|entry| entry["provider_id"] == provider_id && entry["auth_alias"] == "key");
        while let Ok((_, synthetic)) = rx.try_recv() {
            synthetic_attempts += usize::from(synthetic);
        }
        managed.finish().await;
        task.abort();
        let _ = task.await;
        env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
        assert_eq!(
            synthetic_attempts, 0,
            "recovery must not emit synthetic traffic"
        );
        assert!(
            outcome.contains("controlled-secret"),
            "expired identity must receive the real request: {outcome}"
        );
        assert!(
            first.contains("spare-secret") && second.contains("spare-secret"),
            "concurrent requests must use the spare while the trial is held"
        );
        assert!(
            !remains_cooled,
            "matching business success must clear the exact cooldown"
        );
        return;
    }
    refusal_phase.store(false, Ordering::SeqCst);
    if let Some(request) = held_success {
        success_release.add_permits(1);
        let settled = timeout(Duration::from_secs(8), request)
            .await
            .unwrap()
            .unwrap();
        let expected_key = if late_business_failure {
            "spare-secret"
        } else {
            "controlled-secret"
        };
        assert!(settled.contains(expected_key));
    }
    if refusal_status == 401 {
        assert!(
            pool_entries(&client, managed.pool_url())
                .await
                .iter()
                .any(|entry| entry["provider_id"] == provider_id && entry["auth_alias"] == "key"),
            "an older attempt cannot clear the current episode"
        );
        assert!(business(&client, &managed).await.contains("spare-secret"));

        clock.0.store(now + 3_600_001, Ordering::SeqCst);
        if late_probe_failure || fail_streaming_probe {
            let input = if fail_streaming_probe {
                "incomplete recovery"
            } else {
                "failed recovery"
            };
            assert!(business_at(&client, &managed.base, input)
                .await
                .contains("spare-secret"));
            assert!(business(&client, &managed).await.contains("spare-secret"));
            assert!(pool_entries(&client, managed.pool_url())
                .await
                .iter()
                .any(|entry| entry["provider_id"] == provider_id && entry["auth_alias"] == "key"));
            clock.0.store(now + 3_700_000, Ordering::SeqCst);
        }
        assert!(business(&client, &managed)
            .await
            .contains("controlled-secret"));
        assert!(pool_entries(&client, managed.pool_url())
            .await
            .iter()
            .all(|entry| entry["provider_id"] != provider_id || entry["auth_alias"] != "key"));
    } else if refusal_status == 503 {
        assert!(business(&client, &managed)
            .await
            .contains("controlled-secret"));
    }
    assert!(
        std::iter::from_fn(|| rx.try_recv().ok()).all(|(_, synthetic)| !synthetic),
        "automatic health recovery must not emit synthetic traffic"
    );
    managed.finish().await;
    task.abort();
    let _ = task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
}
