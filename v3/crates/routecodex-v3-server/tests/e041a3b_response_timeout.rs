//! e041a3b public-entry reproduction: Direct Responses SSE must honor the
//! execution attempt residence deadline before the provider request timeout.
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::StatusCode,
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
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
    if input.contains("deadline") && body["model"] != "wire-recover" {
        let delta = json!({
            "type": "response.output_text.delta",
            "delta": "deadline-business-delta",
            "item_id": "msg_e041a3b_deadline",
            "output_index": 0,
            "content_index": 0,
            "sequence_number": 1
        });
        let frame = format!("event: response.output_text.delta\ndata: {delta}\n\n");
        let stream = stream::once(async move { Ok::<_, Infallible>(Bytes::from(frame)) })
            .chain(stream::pending());
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

async fn start() -> Entry {
    start_with(250, 5000, false, false).await
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

async fn raw_deadline_request(entry: &Entry) -> (Vec<u8>, Duration, std::io::Result<usize>) {
    let body = json!({
        "model": "test.test",
        "input": "deadline-never-terminal",
        "stream": true
    })
    .to_string();
    let mut socket = TcpStream::connect(entry.handle.listeners[0].addr)
        .await
        .unwrap();
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: e041a3b-deadline\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let started = Instant::now();
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut wire = Vec::new();
    let ended = timeout(Duration::from_secs(8), socket.read_to_end(&mut wire))
        .await
        .expect("deadline request must terminate before the fixture watchdog");
    (wire, started.elapsed(), ended)
}

#[tokio::test]
async fn residence_deadline_terminates_uncommitted_direct_sse_with_typed_error_and_survives() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start().await;

    let (wire, elapsed, ended) = raw_deadline_request(&entry).await;
    let wire_text = String::from_utf8_lossy(&wire);
    let logs = public_logs(&entry).await;
    let projected_chains = logs["logs"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["node_id"] == "V3Error06ClientProjected")
        .map(|event| event["details"]["error_chain"].clone())
        .collect::<Vec<_>>();
    let projected_text = serde_json::to_string(&projected_chains).unwrap();
    let logs_text = serde_json::to_string(&logs).unwrap();
    let typed_deadline = logs_text.contains("residence deadline")
        || logs_text.contains("direct_sse_attempt_store_rejected")
        || logs_text.contains("provider_response_sse_stream");
    let six_node_chain = projected_chains.iter().any(|chain| {
        chain.as_array().is_some_and(|nodes| {
            nodes.len() == 6
                && nodes.first() == Some(&json!("V3Error01SourceRaised"))
                && nodes.last() == Some(&json!("V3Error06ClientProjected"))
        })
    });

    eprintln!(
        "e041a3b-red elapsed_ms={} wire_bytes={} wire={} ended={ended:?}",
        elapsed.as_millis(),
        wire.len(),
        wire_text
    );
    eprintln!("e041a3b-red typed_deadline={typed_deadline}");
    eprintln!("e041a3b-red chains={projected_text}");

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let response = client
        .post(format!("{}/v1/responses", entry.base()))
        .header("x-session-id", "e041a3b-deadline")
        .json(&json!({
            "model": "test.test",
            "input": "healthy-sibling",
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let sibling = response.text().await.unwrap();
    assert!(sibling.contains("sibling-success"));
    assert!(sibling.contains("response.completed"));
    eprintln!("e041a3b-red sibling={sibling}");

    assert!(
        elapsed <= Duration::from_millis(2000),
        "deadline request took {elapsed:?}; expected the 250ms residence deadline, not the 5s provider timeout"
    );
    assert!(
        elapsed >= Duration::from_millis(200),
        "deadline request ended before the declared 250ms residence deadline: {elapsed:?}"
    );
    assert!(
        six_node_chain,
        "public diagnostics did not retain the V3Error01 -> V3Error06 typed chain: {projected_text}"
    );
    assert!(
        ended.is_ok()
            || ended
                .as_ref()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset),
        "client transport ended abnormally without an acceptable reset: {ended:?}"
    );
    assert!(
        wire.is_empty()
            || (wire_text.starts_with("HTTP/1.1 200") && wire_text.contains("text/event-stream")),
        "unexpected client transport framing: {wire_text}"
    );
    assert!(
        !wire_text.contains("deadline-business-delta")
            && !wire_text.contains("response.completed")
            && !wire_text.contains("\"status\":\"completed\""),
        "client received fake business success: {wire_text}"
    );
    assert!(
        !wire_text.contains("\"error\"")
            && !wire_text.contains("network_error")
            && !wire_text.contains("598")
            && !wire_text.contains("599")
            && !wire_text.contains("502"),
        "client received a provider/proxy error payload: {wire_text}"
    );
    assert!(
        !wire.ends_with(b"0\r\n\r\n"),
        "client received a normal chunked completion: {wire_text}"
    );

    entry.stop().await;
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
async fn provider_timeout_recovers_while_residence_remains() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_with(15000, 150, true, true).await;
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(12))
        .build()
        .unwrap()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"input":"deadline-first-provider","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(
        body.contains("sibling-success") && body.contains("response.completed"),
        "{body}"
    );
    assert!(
        !body.contains("deadline-business-delta") && !body.contains("\"error\""),
        "{body}"
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
    eprintln!("e041a3b-recovery two-dispatches completed=true");
    entry.stop().await;
}

#[tokio::test]
async fn expired_request_never_dispatches_or_cools_backup_candidate() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_with(250, 5000, true, true).await;
    let body = json!({"input":"deadline-no-backup-budget","stream":true}).to_string();
    let mut socket = TcpStream::connect(entry.handle.listeners[0].addr)
        .await
        .unwrap();
    socket.write_all(format!("POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    let mut wire = Vec::new();
    let _ = timeout(Duration::from_secs(2), socket.read_to_end(&mut wire))
        .await
        .expect("expired residence must not wait for recovery admission");
    assert!(!String::from_utf8_lossy(&wire).contains("response.completed"));
    assert!(!String::from_utf8_lossy(&wire).contains("\"error\""));
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-e041a3b"
    );
    assert!(
        entry.captures.try_recv().is_err(),
        "expired request dispatched backup"
    );
    let pool = cooldown_pool(&entry).await;
    let entries = pool["entries"].as_array().unwrap();
    assert!(
        !entries.is_empty(),
        "attempted provider must be cooled: {pool}"
    );
    assert!(
        entries.iter().all(|item| item["model_id"] != "recover"),
        "unattempted backup cooled: {pool}"
    );
    let response = reqwest::Client::new()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"model":"test.recover","input":"healthy-sibling","stream":true}))
        .send()
        .await
        .unwrap();
    assert!(response.text().await.unwrap().contains("sibling-success"));
    eprintln!("e041a3b-deadline backup-dispatched=false cooldown={pool}");
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
