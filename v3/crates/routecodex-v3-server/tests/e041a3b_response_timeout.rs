//! e041a3b public-entry reproduction: provider timeouts must remain
//! identity-scoped attempt failures, recover through another candidate, and
//! never leak an incomplete buffered provider prefix to the client.
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::StatusCode,
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::stream;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{convert::Infallible, time::Duration};
use tokio::{
    sync::{mpsc, oneshot},
    time::timeout,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

fn completed() -> Value {
    json!({
        "id": "resp_e041a3b_sibling",
        "object": "response",
        "status": "completed",
        "model": "wire-e041a3b",
        "output": [{
            "id": "msg_e041a3b_sibling",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{
                "type": "output_text",
                "text": "sibling-success",
                "annotations": []
            }]
        }]
    })
}

async fn upstream(
    State(captures): State<mpsc::UnboundedSender<Value>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let _ = captures.send(body.clone());
    let input = body["input"].as_str().unwrap_or_default();
    if input.contains("committed-deadline") && body["model"] != "wire-recover" {
        let delta = json!({
            "type": "response.output_text.delta",
            "delta": "committed-business-delta",
            "item_id": "msg_e041a3b_committed",
            "output_index": 0,
            "content_index": 0,
            "sequence_number": 1
        });
        let frame = format!("event: response.output_text.delta\ndata: {delta}\n\n");
        let stream = stream::once(async move { Ok::<_, Infallible>(Bytes::from(frame)) });
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream))
            .unwrap();
    }

    if input.contains("first-frame-timeout") && body["model"] != "wire-recover" {
        let stream = stream::pending::<Result<Bytes, Infallible>>();
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream))
            .unwrap();
    }

    let frame = format!(
        "event: response.completed\ndata: {}\n\n",
        json!({"type":"response.completed","response":completed()})
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(frame))
        .unwrap()
}

struct Entry {
    handle: V3ServerAggregateHandle,
    shutdown: oneshot::Sender<()>,
    peer: tokio::task::JoinHandle<()>,
    captures: mpsc::UnboundedReceiver<Value>,
}

impl Entry {
    fn base(&self) -> String {
        format!("http://{}", self.handle.listeners[0].addr)
    }

    async fn stop(self) {
        assert!(self.handle.shutdown().await.is_empty());
        let _ = self.shutdown.send(());
        timeout(Duration::from_secs(10), self.peer)
            .await
            .unwrap()
            .unwrap();
        std::env::remove_var("E041A3B_DEADLINE_KEY");
    }
}

async fn start_with(residence_ms: u64, timeout_ms: u64, recovery: bool, health: bool) -> Entry {
    std::env::set_var("E041A3B_DEADLINE_KEY", "owned-fixture-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = listener.local_addr().unwrap();
    let (shutdown, stop) = oneshot::channel();
    let (captures, received) = mpsc::unbounded_channel();
    let peer = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/responses", post(upstream))
                .with_state(captures),
        )
        .with_graceful_shutdown(async {
            let _ = stop.await;
        })
        .await
        .unwrap();
    });

    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = format!(
        "{}\nattempt_store = {{ residence_timeout_ms = {residence_ms} }}\n",
        hub_v1_fixture::hub_v1_server_execution("owned")
    );
    let port = test_ports::free_port();
    let backup_target = if recovery {
        ",{kind=\"provider_model\",provider=\"test\",model=\"recover\",key=\"key\",priority=1}"
    } else {
        ""
    };
    let source = format!(
        r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
[providers.test]
type = "responses"
base_url = "http://{upstream_addr}/v1"
default_model = "test"
auth = {{type="api_key",entries=[{{alias="key",env="E041A3B_DEADLINE_KEY"}}]}}
health = {{enabled={health},failure_threshold=1,cooldown_ms=5000}}
responses = {{process="direct",streaming="always"}}
request_timeout_ms = {timeout_ms}
sse_first_frame_timeout_ms = {timeout_ms}
[providers.test.models.test]
wire_name = "wire-e041a3b"
capabilities = ["text"]
supports_streaming = true
[providers.test.models.recover]
wire_name = "wire-recover"
capabilities = ["text"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{strategy="priority"}}
targets = [{{kind="provider_model",provider="test",model="test",key="key",priority=2}}{backup_target}]
[debug]
log_console = false
snapshots = true
"#
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    Entry {
        handle: spawn_v3_server_aggregate(manifest).await.unwrap(),
        shutdown,
        peer,
        captures: received,
    }
}

async fn public_logs(entry: &Entry) -> Value {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{}/_routecodex/debug/logs", entry.base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn cooldown_pool(entry: &Entry) -> Value {
    reqwest::Client::new()
        .get(format!("{}/_routecodex/health/cooldown-pool", entry.base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn first_frame_timeout_after_residence_expiry_recovers_without_client_close() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_with(100, 250, true, true).await;
    let started = std::time::Instant::now();
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"input":"first-frame-timeout","stream":true}))
        .send()
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(
        body.contains("sibling-success") && body.contains("response.completed"),
        "{body}"
    );
    assert!(
        !body.contains("committed-business-delta")
            && !body.contains("\"error\"")
            && !body.contains("network_error")
            && !body.contains("502"),
        "{body}"
    );
    assert!(
        elapsed >= Duration::from_millis(200) && elapsed <= Duration::from_secs(3),
        "the first-frame timeout must end one provider attempt without ending the request: {elapsed:?}"
    );
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-e041a3b"
    );
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-recover"
    );
    assert!(entry.captures.try_recv().is_err());
    let logs_text = serde_json::to_string(&public_logs(&entry).await).unwrap();
    assert!(
        logs_text.contains("V3Error01SourceRaised")
            && logs_text.contains("V3Error05ExecutionDecision")
            && logs_text.contains("V3TargetLocalReselected"),
        "the timed-out attempt must enter the typed Error chain and reselect: {logs_text}"
    );
    assert!(
        !logs_text.contains("V3Error06ClientProjected"),
        "the recoverable timeout must not project a client error: {logs_text}"
    );
    eprintln!(
        "e041a3b-first-frame recovered=true elapsed_ms={}",
        elapsed.as_millis()
    );
    entry.stop().await;
}

#[tokio::test]
async fn expired_residence_still_recovers_and_backup_stays_healthy() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_with(100, 250, true, true).await;
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"input":"first-frame-timeout","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(
        body.contains("sibling-success") && body.contains("response.completed"),
        "expired residence must not stop recovery: {body}"
    );
    assert!(
        !body.contains("\"error\"") && !body.contains("network_error") && !body.contains("502"),
        "expired residence must not produce a client error: {body}"
    );
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-e041a3b"
    );
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-recover"
    );
    assert!(entry.captures.try_recv().is_err());
    let pool = cooldown_pool(&entry).await;
    let entries = pool["entries"].as_array().unwrap();
    assert!(
        entries.iter().all(|item| item["model_id"] != "recover"),
        "the successful backup candidate must not be cooled: {pool}"
    );
    eprintln!("e041a3b-expired-residence backup-dispatched=true cooldown={pool}");
    entry.stop().await;
}

#[tokio::test]
async fn client_disconnect_releases_activity_without_provider_cooldown() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_with(15000, 5000, false, true).await;
    let response = reqwest::Client::new()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"model":"test.test","input":"deadline-client-cancel","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    timeout(Duration::from_secs(2), entry.captures.recv())
        .await
        .unwrap()
        .unwrap();
    drop(response);
    let preparation = timeout(Duration::from_secs(2), entry.handle.prepare_exec_attempt())
        .await
        .expect("client cancellation leaked active runtime work")
        .unwrap();
    drop(preparation);
    let pool = cooldown_pool(&entry).await;
    assert_eq!(
        pool["entries"].as_array().unwrap().len(),
        0,
        "client cancellation cooled provider: {pool}"
    );
    let response = reqwest::Client::new()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"model":"test.test","input":"healthy-sibling","stream":true}))
        .send()
        .await
        .unwrap();
    assert!(response.text().await.unwrap().contains("sibling-success"));
    eprintln!("e041a3b-client-cancel released=true cooldown=[] sibling=completed");
    entry.stop().await;
}

#[tokio::test]
async fn incomplete_buffered_visible_prefix_is_discarded_before_healthy_sibling_completion() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_with(100, 5000, true, true).await;
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"input":"committed-deadline","stream":true}))
        .send()
        .await
        .expect("the incomplete prefix must not close the client transport");
    assert_eq!(response.status(), StatusCode::OK);
    let body_result = response.text().await;
    let logs = public_logs(&entry).await;
    let body = body_result.unwrap_or_else(|error| {
        panic!(
            "the incomplete prefix must not truncate the client body: {error}; logs={}",
            serde_json::to_string(&logs).unwrap()
        )
    });
    assert!(
        body.contains("sibling-success") && body.contains("response.completed"),
        "the healthy sibling must supply the complete terminal: {body}"
    );
    assert_eq!(
        body.matches("committed-business-delta").count(),
        0,
        "an incomplete provider attempt must not expose its business prefix: {body}"
    );
    assert!(
        !body.contains("\"error\"") && !body.contains("network_error") && !body.contains("502"),
        "client received a provider/proxy error payload: {body}"
    );
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-e041a3b"
    );
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-recover"
    );
    assert!(entry.captures.try_recv().is_err());
    let logs_text = serde_json::to_string(&logs).unwrap();
    assert!(
        !logs_text.contains("V3Error06ClientProjected"),
        "the incomplete prefix must recover without a client error: {logs_text}"
    );
    eprintln!("e041a3b-buffered-prefix discarded=true sibling=completed");
    entry.stop().await;
}
