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
    success_release: Arc<Semaphore>,
    fail_streaming_probe: bool,
    /// Upstream status used to refuse a business attempt. Health-cooling tests
    /// use 503 (a real recoverable health failure); the adaptive-budget test
    /// uses 429 because only a real rate limit collapses the capacity budget.
    refuse_status: axum::http::StatusCode,
    refuse_code: &'static str,
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
    if auth == "Bearer controlled-secret" {
        if body.to_string().contains("held success") {
            peer.success_release.acquire().await.unwrap().forget();
        } else if probe {
            peer.release.acquire().await.unwrap().forget();
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
            if *failures < peer.refuse_limit {
                *failures += 1;
                true
            } else {
                false
            }
        };
        if refused {
            return (
                peer.refuse_status,
                Json(json!({"error":{"code":peer.refuse_code,"message":"controlled refusal"}})),
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
async fn three_business_5xxs_automatically_probe_2xx_and_restore_exact_key() {
    automatic_recovery(false).await;
}

#[tokio::test]
async fn zen_non_2xx_unfinished_probe_body_preserves_cooldown_and_allows_fallback() {
    automatic_recovery(true).await;
}

async fn automatic_recovery(fail_streaming_probe: bool) {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(if fail_streaming_probe { 100 } else { 0 }));
    let failures = Arc::new(Mutex::new(0));
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
    let peer = Peer {
        receipts: tx,
        release: release.clone(),
        failures: failures.clone(),
        success_release: success_release.clone(),
        fail_streaming_probe,
        // A real 5xx cools the exact identity on its first failure, so one
        // refusal is enough to enter the cooldown-probe state.
        refuse_status: axum::http::StatusCode::SERVICE_UNAVAILABLE,
        refuse_code: "server_error",
        refuse_limit: 1,
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
    // One refused business attempt is enough: a 5xx cools the exact identity
    // immediately, and the client transparently lands on the spare key.
    assert!(business(&client, &managed).await.contains("spare-secret"));
    assert_eq!(
        *failures.lock().await,
        1,
        "the business attempt must reach the exact key before cooldown"
    );
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
        success_release: success_release.clone(),
        fail_streaming_probe: false,
        refuse_status: axum::http::StatusCode::TOO_MANY_REQUESTS,
        refuse_code: "rate_limit_error",
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
