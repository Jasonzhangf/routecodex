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
        let mut failures = peer.failures.lock().await;
        if *failures < 3 {
            *failures += 1;
            return (
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":{"code":"insufficient_quota","message":"controlled 429"}})),
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
async fn three_business_429s_automatically_probe_2xx_and_restore_exact_key() {
    automatic_recovery(false, false).await;
}

#[tokio::test]
async fn in_flight_business_success_recovers_429_before_probe_headers() {
    automatic_recovery(true, false).await;
}

#[tokio::test]
async fn zen_non_2xx_unfinished_probe_body_preserves_cooldown_and_allows_fallback() {
    automatic_recovery(false, true).await;
}

async fn automatic_recovery(in_flight_success: bool, fail_streaming_probe: bool) {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(if fail_streaming_probe { 100 } else { 0 }));
    let failures = Arc::new(Mutex::new(0));
    let success_release = Arc::new(Semaphore::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let peer = Peer {
        receipts: tx,
        release: release.clone(),
        failures: failures.clone(),
        success_release: success_release.clone(),
        fail_streaming_probe,
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
[providers.test]
type = "{provider_type}"
{probe_timeout}
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}, {{ alias = "spare", env = "V3_COOLDOWN_BINARY_SPARE_KEY" }}] }}
[providers.test.models.test]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 100 }}, {{ kind = "provider_model", provider = "test", model = "test", key = "spare", priority = 1 }}]
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
    for attempt in 1..=3 {
        assert!(business(&client, &managed).await.contains("spare-secret"));
        assert_eq!(
            *failures.lock().await,
            attempt,
            "real business attempt must reach exact key"
        );
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
        timeout(Duration::from_secs(8), async {
            loop {
                if pool_entries(&client, managed.pool_url())
                    .await
                    .iter()
                    .any(|entry| {
                        entry["auth_alias"] == "key"
                            && entry["state"] == "blocked"
                            && entry["failure_count"].as_u64().unwrap_or(0) >= 1
                    })
                {
                    break;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("unfinished503 probe body must complete as failure and retain cooldown");
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
    if let Some(request) = held_success {
        success_release.add_permits(1);
        assert!(request.await.unwrap().contains("controlled-secret"));
        // Probe headers are still withheld, so removal below proves business recovery.
    } else {
        release.add_permits(1);
    }
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
    .expect("HTTP 2xx probe or in-flight business success removes exact cooldown");
    if in_flight_success {
        release.add_permits(1);
    }
    assert!(business(&client, &managed)
        .await
        .contains("controlled-secret"));
    wait_receipt(&mut rx, ("Bearer controlled-secret", false)).await;
    managed.finish().await;
    task.abort();
    let _ = task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
}
