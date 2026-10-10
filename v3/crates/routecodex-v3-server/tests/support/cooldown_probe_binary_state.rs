use super::*;
use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio::time::timeout;

#[derive(Clone)]
struct Peer {
    receipts: mpsc::UnboundedSender<(String, bool)>,
    release: Arc<Semaphore>,
    terminal: Arc<Mutex<bool>>,
}

async fn upstream(
    State(peer): State<Peer>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    let auth = headers["authorization"].to_str().unwrap().to_string();
    assert_eq!(body["model"], "test");
    let probe = body.to_string().contains("routecodex health probe");
    peer.receipts.send((auth.clone(), probe)).unwrap();
    if probe && auth == "Bearer controlled-secret" {
        peer.release.acquire().await.unwrap().forget();
        if !*peer.terminal.lock().await {
            return Json(
                json!({"id":"probe-nonterminal","object":"response","status":"in_progress","output":[]}),
            );
        }
    }
    Json(
        json!({"id":"resp-binary-state","object":"response","status":"completed","model":"test","output":[{"id":"msg-binary-state","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":auth,"annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}),
    )
}

async fn business(client: &reqwest::Client, managed: &Managed) -> String {
    let response = client
        .post(format!("{}/v1/responses", managed.base))
        .json(&json!({"model":"test","input":"binary state business","stream":false}))
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
async fn overdue_probe_stays_visible_until_semantic_recovery_and_same_key_dispatch() {
    let _guard = TEST_LOCK.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let terminal = Arc::new(Mutex::new(false));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let peer = Peer {
        receipts: tx,
        release: release.clone(),
        terminal: terminal.clone(),
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
    let managed = Managed::start_source("binary-state", false, |port| format!(r#"
version = 3
[servers.main]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
[providers.test]
type = "responses"
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
    let identity = json!({"provider_id":"test","auth_alias":"key","model_id":"test"});
    let (status, _) = post_json(&client, managed.add_url(), json!({"provider_id":"test","auth_alias":"key","model_id":"test","kind":"probe","duration_ms":1})).await;
    assert_eq!(status, 200);
    let (_, scheduled) = post_json(&client, managed.probe_url(), identity.clone()).await;
    assert_eq!(scheduled["scheduled"], true);
    wait_receipt(&mut rx, ("Bearer controlled-secret", true)).await;
    let entries = pool_entries(&client, managed.pool_url()).await;
    assert!(
        entries.iter().any(|entry| entry["auth_alias"] == "key"
            && entry["model_id"] == "test"
            && entry["state"] == "probing"),
        "overdue in-flight identity must stay in pool: {entries:?}"
    );
    assert!(business(&client, &managed).await.contains("spare-secret"));
    wait_receipt(&mut rx, ("Bearer spare-secret", false)).await;
    release.add_permits(1);
    timeout(Duration::from_secs(10), async {
        loop {
            let entries = pool_entries(&client, managed.pool_url()).await;
            if entries.iter().any(|entry| {
                entry["auth_alias"] == "key"
                    && entry["state"] == "waiting"
                    && entry["failure_count"]
                        .as_u64()
                        .is_some_and(|count| count > 0)
            }) {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("HTTP 200 without semantic terminal must keep cooldown");
    assert!(business(&client, &managed).await.contains("spare-secret"));
    *terminal.lock().await = true;
    let (_, scheduled) = post_json(&client, managed.probe_url(), identity).await;
    assert_eq!(scheduled["scheduled"], true);
    wait_receipt(&mut rx, ("Bearer controlled-secret", true)).await;
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
    .expect("semantic success removes exact cooldown");
    assert!(business(&client, &managed)
        .await
        .contains("controlled-secret"));
    wait_receipt(&mut rx, ("Bearer controlled-secret", false)).await;
    managed.finish().await;
    task.abort();
    let _ = task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
}
