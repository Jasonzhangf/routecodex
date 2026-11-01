//! Public-entry black-box regression for canonical issue `7517a07`.
//!
//! Stable test IDs:
//! `issue7517a07_client_cancel_not_provider_502`,
//! `issue7517a07_body_timeout_not_provider_502`,
//! `issue7517a07_genuine_provider_502_keeps_502`,
//! `issue7517a07_multi_candidate_cancel_does_not_inherit_primary_502`, and
//! `issue7517a07_multi_candidate_residence_does_not_inherit_primary_502`.
//!
//! Command:
//! `node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test issue7517a07_terminal_ledger_status -- --nocapture`
//!
//! The 4444 request ledger used to write `error_category=http_502` and
//! `provider_status=502` for provider attempts that never returned an HTTP 502
//! (client-cancelled streams and provider response-body/transport timeouts).
//! These cases enter the real `/v1/responses` listener of a spawned aggregate
//! server and read the persisted request-record ledger:
//! - a delivered, then client-cancelled stream records a terminal row that is
//!   not a provider HTTP 502;
//! - a provider response-body/transport timeout records its typed transport
//!   terminal, not a fabricated provider 502;
//! - a genuine provider HTTP 502 keeps `provider_status=502`/`http_502`.

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
use std::{convert::Infallible, path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, oneshot},
    time::{sleep, timeout, Instant},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const AUTH_ENV: &str = "ISSUE_7517A07_LEDGER_KEY";
const CLIENT_MODEL: &str = "declared";
const PROVIDER_A: &str = "primary7517";
const PROVIDER_B: &str = "fallback7517";

fn completed() -> Value {
    json!({
        "id": "resp_7517a07",
        "object": "response",
        "status": "completed",
        "model": "wire-7517a07",
        "output": [{
            "id": "msg_7517a07",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{
                "type": "output_text",
                "text": "issue-7517a07-success",
                "annotations": []
            }]
        }]
    })
}

/// Controlled Responses upstream. The request `input` selects the behavior:
/// - `deliver-then-hang`: emit one committed business delta, then never finish;
/// - `reasoning-then-hang`: emit one reasoning-only delta (clears the first-frame
///   guard but never commits) then never finish, so the attempt residence
///   deadline fires and the runtime reports a typed transport NoResponse;
/// - `provider-502`: answer a real HTTP 502 with a JSON body.
async fn upstream(
    State(captures): State<mpsc::UnboundedSender<Value>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let _ = captures.send(body.clone());
    let input = body["input"].as_str().unwrap_or_default();
    if input.contains("provider-502") {
        return Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"type":"server_error","message":"controlled provider 502"}}"#,
            ))
            .unwrap();
    }
    if input.contains("deliver-then-hang") {
        let delta = json!({
            "type": "response.output_text.delta",
            "delta": "committed-business-delta",
            "item_id": "msg_7517a07_delivered",
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
    if input.contains("reasoning-then-hang") {
        let reasoning = json!({
            "type": "response.reasoning_summary_text.delta",
            "delta": "deadline-reasoning",
            "item_id": "rs_7517a07_deadline",
            "output_index": 0,
            "summary_index": 0,
            "sequence_number": 1
        });
        let frame = format!("event: response.reasoning_summary_text.delta\ndata: {reasoning}\n\n");
        let stream = stream::once(async move { Ok::<_, Infallible>(Bytes::from(frame)) })
            .chain(stream::pending());
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream))
            .unwrap();
    }
    if input.contains("sse-body-error") {
        // Emit one semantic frame, then fail the body stream. The SSE reader sees
        // an upstream read error and maps it to `provider_response_body_error`.
        let reasoning = json!({
            "type": "response.reasoning_summary_text.delta",
            "delta": "body-error-reasoning",
            "item_id": "rs_7517a07_body_error",
            "output_index": 0,
            "summary_index": 0,
            "sequence_number": 1
        });
        let frame = format!("event: response.reasoning_summary_text.delta\ndata: {reasoning}\n\n");
        // Flush the head and first frame first, then error the body so the
        // reader sees an upstream read error rather than a send failure.
        let first = stream::once(async move { Ok::<Bytes, std::io::Error>(Bytes::from(frame)) });
        let failure = stream::once(async {
            tokio::time::sleep(Duration::from_millis(150)).await;
            Err::<Bytes, std::io::Error>(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "controlled upstream SSE body error: operation timed out",
            ))
        });
        let stream = first.chain(failure);
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream))
            .unwrap();
    }
    let frame = format!(
        "event: response.completed\ndata: {}\n\n",
        json!({"type": "response.completed", "response": completed()})
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(frame))
        .unwrap()
}

/// Candidate A's controlled upstream: a real HTTP 502. It ignores the request
/// input, so the only way candidate B can serve the request is that the runtime
/// really switched candidates after the 502.
async fn upstream_primary_502(
    State(captures): State<mpsc::UnboundedSender<Value>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let _ = captures.send(body);
    eprintln!("[diag-upstream-a] served primary 502");
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"error":{"type":"server_error","message":"controlled primary 502"}}"#,
        ))
        .unwrap()
}

struct Entry {
    handle: V3ServerAggregateHandle,
    shutdown: oneshot::Sender<()>,
    peer: tokio::task::JoinHandle<()>,
    #[allow(dead_code)]
    _captures: mpsc::UnboundedReceiver<Value>,
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
        std::env::remove_var(AUTH_ENV);
    }
}

async fn start() -> Entry {
    start_with(300, 5000, 5000).await
}

async fn start_with(residence_ms: u64, request_timeout_ms: u64, first_frame_ms: u64) -> Entry {
    std::env::set_var(AUTH_ENV, "owned-fixture-key");
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
        hub_v1_fixture::hub_v1_server_execution("owned"),
    );
    let port = test_ports::free_port();
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
default_model = "{client_model}"
auth = {{type="api_key",entries=[{{alias="key",env="{auth_env}"}}]}}
health = {{enabled=false,failure_threshold=1,cooldown_ms=5000}}
responses = {{process="direct",streaming="always"}}
request_timeout_ms = {request_timeout_ms}
sse_first_frame_timeout_ms = {first_frame_ms}
[providers.test.models.{client_model}]
wire_name = "wire-7517a07"
capabilities = ["text"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{strategy="priority"}}
targets = [{{kind="provider_model",provider="test",model="{client_model}",key="key",priority=1}}]
[debug]
log_console = false
snapshots = true
"#,
        declaration = declaration,
        port = port,
        upstream_addr = upstream_addr,
        client_model = CLIENT_MODEL,
        auth_env = AUTH_ENV,
        execution = execution,
        request_timeout_ms = request_timeout_ms,
        first_frame_ms = first_frame_ms,
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    Entry {
        handle: spawn_v3_server_aggregate(manifest).await.unwrap(),
        shutdown,
        peer,
        _captures: received,
    }
}

/// Two-candidate aggregate server: candidate A (`priority = 2`) is a real HTTP
/// 502 peer, candidate B (`priority = 1`) is the existing behaviour-selectable
/// Responses peer. Both upstream request streams are kept for assertions.
struct MultiEntry {
    handle: V3ServerAggregateHandle,
    stop_a: oneshot::Sender<()>,
    stop_b: oneshot::Sender<()>,
    peer_a: tokio::task::JoinHandle<()>,
    peer_b: tokio::task::JoinHandle<()>,
    a_requests: mpsc::UnboundedReceiver<Value>,
    b_requests: mpsc::UnboundedReceiver<Value>,
}

impl MultiEntry {
    fn base(&self) -> String {
        format!("http://{}", self.handle.listeners[0].addr)
    }

    fn drain_a_requests(&mut self) -> Vec<Value> {
        std::iter::from_fn(|| self.a_requests.try_recv().ok()).collect()
    }

    fn drain_b_requests(&mut self) -> Vec<Value> {
        std::iter::from_fn(|| self.b_requests.try_recv().ok()).collect()
    }

    async fn stop(self) {
        assert!(self.handle.shutdown().await.is_empty());
        let _ = self.stop_a.send(());
        let _ = self.stop_b.send(());
        timeout(Duration::from_secs(10), self.peer_a)
            .await
            .unwrap()
            .unwrap();
        timeout(Duration::from_secs(10), self.peer_b)
            .await
            .unwrap()
            .unwrap();
        std::env::remove_var(AUTH_ENV);
    }
}

async fn start_multi(
    residence_ms: u64,
    request_timeout_ms: u64,
    first_frame_ms: u64,
) -> MultiEntry {
    std::env::set_var(AUTH_ENV, "owned-fixture-key");

    let listener_a = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_a_addr = listener_a.local_addr().unwrap();
    let (stop_a, shutdown_a) = oneshot::channel();
    let (captures_a, a_requests) = mpsc::unbounded_channel();
    let peer_a = tokio::spawn(async move {
        axum::serve(
            listener_a,
            Router::new()
                .route("/v1/responses", post(upstream_primary_502))
                .with_state(captures_a),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_a.await;
        })
        .await
        .unwrap();
    });

    let listener_b = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_b_addr = listener_b.local_addr().unwrap();
    let (stop_b, shutdown_b) = oneshot::channel();
    let (captures_b, b_requests) = mpsc::unbounded_channel();
    let peer_b = tokio::spawn(async move {
        axum::serve(
            listener_b,
            Router::new()
                .route("/v1/responses", post(upstream))
                .with_state(captures_b),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_b.await;
        })
        .await
        .unwrap();
    });

    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = format!(
        "{}\nattempt_store = {{ residence_timeout_ms = {residence_ms} }}\n",
        hub_v1_fixture::hub_v1_server_execution("owned"),
    );
    let port = test_ports::free_port();
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
[providers.{provider_a}]
type = "responses"
base_url = "http://{upstream_a_addr}/v1"
default_model = "{client_model}"
auth = {{type="api_key",entries=[{{alias="key",env="{auth_env}"}}]}}
health = {{enabled=false,failure_threshold=1,cooldown_ms=5000}}
responses = {{process="direct",streaming="always"}}
request_timeout_ms = {request_timeout_ms}
sse_first_frame_timeout_ms = {first_frame_ms}
[providers.{provider_a}.models.{client_model}]
wire_name = "wire-7517a07"
capabilities = ["text"]
supports_streaming = true
[providers.{provider_b}]
type = "responses"
base_url = "http://{upstream_b_addr}/v1"
default_model = "{client_model}"
auth = {{type="api_key",entries=[{{alias="key",env="{auth_env}"}}]}}
health = {{enabled=false,failure_threshold=1,cooldown_ms=5000}}
responses = {{process="direct",streaming="always"}}
request_timeout_ms = {request_timeout_ms}
sse_first_frame_timeout_ms = {first_frame_ms}
[providers.{provider_b}.models.{client_model}]
wire_name = "wire-7517a07"
capabilities = ["text"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{strategy="priority"}}
targets = [
  {{kind="provider_model",provider="{provider_a}",model="{client_model}",key="key",priority=2}},
  {{kind="provider_model",provider="{provider_b}",model="{client_model}",key="key",priority=1}},
]
[debug]
log_console = false
snapshots = true
"#,
        declaration = declaration,
        port = port,
        upstream_a_addr = upstream_a_addr,
        upstream_b_addr = upstream_b_addr,
        client_model = CLIENT_MODEL,
        auth_env = AUTH_ENV,
        provider_a = PROVIDER_A,
        provider_b = PROVIDER_B,
        execution = execution,
        request_timeout_ms = request_timeout_ms,
        first_frame_ms = first_frame_ms,
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    MultiEntry {
        handle: spawn_v3_server_aggregate(manifest).await.unwrap(),
        stop_a,
        stop_b,
        peer_a,
        peer_b,
        a_requests,
        b_requests,
    }
}

fn request_records_path(home: &std::path::Path, port: u16) -> PathBuf {
    home.join(".rcc")
        .join("logs")
        .join(format!("server-v3-{port}.request-records.jsonl"))
}

fn read_rows(path: &std::path::Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|line| line.get("row").cloned())
        .collect()
}

fn is_terminal(row: &Value) -> bool {
    matches!(
        row["event_type"].as_str(),
        Some("request.completed" | "request.failed" | "request.cancelled")
    )
}

async fn wait_terminal(path: &std::path::Path, budget: Duration) -> Vec<Value> {
    let deadline = Instant::now() + budget;
    loop {
        let rows = read_rows(path);
        if rows.iter().any(is_terminal) || Instant::now() >= deadline {
            return rows;
        }
        sleep(Duration::from_millis(50)).await;
    }
}

fn dump_rows(label: &str, rows: &[Value]) -> Vec<Value> {
    let terminals: Vec<Value> = rows
        .iter()
        .filter(|row| is_terminal(row))
        .cloned()
        .collect();
    eprintln!(
        "[{label}] event_types={:?}",
        rows.iter()
            .map(|row| row["event_type"].as_str().unwrap_or("?"))
            .collect::<Vec<_>>()
    );
    for terminal in &terminals {
        eprintln!(
            "[{label}] terminal event={} provider_status={} error_category={}",
            terminal["event_type"],
            terminal["meta"]["provider_status"],
            terminal["meta"]["error_category"]
        );
        eprintln!("[{label}] terminal_row={terminal}");
    }
    terminals
}

/// Candidate A's real provider HTTP 502 attempt must survive on its own row.
/// The terminal-row fix may only stop a later terminal from inheriting it.
fn assert_primary_attempt_kept_502(rows: &[Value]) {
    let attempt = rows
        .iter()
        .find(|row| {
            row["event_type"] == json!("request.provider_attempt_failed")
                && row["meta"]["provider_id"] == json!(PROVIDER_A)
        })
        .unwrap_or_else(|| {
            panic!(
                "candidate {PROVIDER_A} must leave a provider-attempt row: {}",
                serde_json::to_string_pretty(rows).unwrap()
            )
        });
    assert_eq!(
        attempt["meta"]["provider_status"],
        json!(502),
        "candidate A's real 502 must stay on its own attempt row: {attempt}"
    );
    assert_eq!(
        attempt["meta"]["error_category"],
        json!("provider_http_502"),
        "candidate A's attempt row keeps the typed provider HTTP 502 category: {attempt}"
    );
    assert_eq!(
        attempt["meta"]["observed_error"]["external_error_status"],
        json!(502),
        "candidate A's observed attempt truth keeps the real upstream status: {attempt}"
    );
}

fn assert_no_terminal_keeps_provider_502(label: &str, terminals: &[Value]) {
    for terminal in terminals {
        assert_ne!(
            terminal["meta"]["provider_status"],
            json!(502),
            "{label}: the terminal must not inherit candidate A's provider 502: {terminal}"
        );
        assert_ne!(
            terminal["meta"]["error_category"],
            json!("http_502"),
            "{label}: the terminal must not inherit candidate A's http_502 category: {terminal}"
        );
    }
}

/// Sub-form 1: a provider attempt delivered 2xx business content, then the client
/// closed. The terminal row must not be a fabricated provider HTTP 502.
#[tokio::test]
async fn issue7517a07_client_cancel_not_provider_502() {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    let entry = start().await;
    let server_port = entry.handle.listeners[0].addr.port();
    let addr = entry.handle.listeners[0].addr;

    let body = json!({
        "model": CLIENT_MODEL,
        "input": "deliver-then-hang client cancel regression",
        "stream": true
    })
    .to_string();
    let mut socket = TcpStream::connect(addr).await.unwrap();
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: issue7517a07-cancel\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    // Read the response head plus at least one committed business frame, then
    // drop the client socket to cancel the stream after delivery.
    let mut delivered = Vec::new();
    let read = timeout(Duration::from_secs(6), async {
        let mut buf = [0u8; 4096];
        while let Ok(n) = socket.read(&mut buf).await {
            if n == 0 {
                break;
            }
            delivered.extend_from_slice(&buf[..n]);
            if delivered
                .windows(b"committed-business".len())
                .any(|window| window == b"committed-business")
            {
                break;
            }
        }
    })
    .await;
    drop(socket);
    eprintln!(
        "[issue7517a07-cancel] delivered_bytes={} read_ok={:?}",
        delivered.len(),
        read.is_ok()
    );

    let path = request_records_path(&home, server_port);
    let rows = wait_terminal(&path, Duration::from_secs(15)).await;
    let terminals = dump_rows("issue7517a07-cancel", &rows);
    assert!(
        !terminals.is_empty(),
        "client cancel must leave a terminal ledger row: {}",
        path.display()
    );
    assert!(
        read.is_ok(),
        "the client must observe committed business content before closing"
    );
    assert!(
        delivered
            .windows(b"committed-business".len())
            .any(|window| window == b"committed-business"),
        "the client must receive committed business content before closing: {}",
        String::from_utf8_lossy(&delivered)
    );
    let cancelled = terminals
        .iter()
        .find(|terminal| terminal["event_type"] == json!("request.cancelled"));
    let cancelled = cancelled
        .expect("a delivered-then-cancelled Responses stream must record request.cancelled");
    assert!(
        cancelled["meta"]["provider_status"].is_null(),
        "client cancellation must not fabricate a provider status: {cancelled}"
    );
    assert_eq!(
        cancelled["meta"]["observed_error"]["source"],
        json!("error01_client_disconnect"),
        "the transport-disconnect terminal must name the typed Error01 fact it holds: {cancelled}"
    );
    assert_ne!(
        cancelled["meta"]["observed_error"]["source"],
        json!("error06_projection"),
        "this path holds no V3Error06ClientProjected and must not claim it: {cancelled}"
    );
    for terminal in &terminals {
        assert_ne!(
            terminal["meta"]["provider_status"],
            json!(502),
            "a client-cancelled delivery must not be labeled provider_status=502: {terminal}"
        );
        assert_ne!(
            terminal["meta"]["error_category"],
            json!("http_502"),
            "a client-cancelled delivery must not be labeled http_502: {terminal}"
        );
    }

    entry.stop().await;
    drop(home_guard);
}

/// Sub-form 2: a provider response-body/transport timeout reaches `NoResponse`.
/// The ledger must name that typed transport terminal instead of provider 502.
#[tokio::test]
async fn issue7517a07_body_timeout_not_provider_502() {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    // Residence deadline well beyond the provider request timeout so the
    // response-body read timeout owns the terminal and the runtime reports the
    // typed `provider_response_body_error`, matching the live sample family.
    let entry = start_with(3000, 600, 500).await;
    let server_port = entry.handle.listeners[0].addr.port();

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let response = client
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({
            "model": CLIENT_MODEL,
            "input": "sse-body-error provider response body error regression",
            "stream": true
        }))
        .send()
        .await;
    let client_outcome = match response {
        Err(error) => format!("transport_error: {error}"),
        Ok(response) => {
            let status = response.status();
            let body = response.bytes().await.map(|b| b.len()).unwrap_or(0);
            format!("status={status} body_bytes={body}")
        }
    };
    eprintln!("[issue7517a07-timeout] client_outcome={client_outcome}");

    let path = request_records_path(&home, server_port);
    let rows = wait_terminal(&path, Duration::from_secs(15)).await;
    let terminals = dump_rows("issue7517a07-timeout", &rows);
    assert!(
        !terminals.is_empty(),
        "a transport timeout must leave a terminal ledger row: {}",
        path.display()
    );
    for terminal in &terminals {
        assert_ne!(
            terminal["meta"]["provider_status"],
            json!(502),
            "a typed transport timeout must not record provider_status=502: {terminal}"
        );
        assert_ne!(
            terminal["meta"]["error_category"],
            json!("http_502"),
            "a typed transport timeout must not be labeled http_502: {terminal}"
        );
    }
    assert!(
        terminals.iter().any(|terminal| {
            terminal["meta"]["error_category"] == json!("provider_response_body_error")
        }),
        "the typed provider response-body error code must own the terminal category: {terminals:#?}"
    );

    entry.stop().await;
    drop(home_guard);
}

/// Inverse guard: a genuine provider HTTP 502 attempt still records 502.
#[tokio::test]
async fn issue7517a07_genuine_provider_502_keeps_502() {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    let entry = start().await;
    let server_port = entry.handle.listeners[0].addr.port();

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let response = client
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({
            "model": CLIENT_MODEL,
            "input": "provider-502 genuine 502 regression",
            "stream": true
        }))
        .send()
        .await;
    let client_outcome = match response {
        Err(error) => format!("transport_error: {error}"),
        Ok(response) => {
            let status = response.status();
            let body = response.bytes().await.map(|b| b.len()).unwrap_or(0);
            format!("status={status} body_bytes={body}")
        }
    };
    eprintln!("[issue7517a07-502] client_outcome={client_outcome}");

    let path = request_records_path(&home, server_port);
    let rows = wait_terminal(&path, Duration::from_secs(15)).await;
    let terminals = dump_rows("issue7517a07-502", &rows);
    assert!(
        !terminals.is_empty(),
        "a genuine provider 502 must leave a terminal ledger row: {}",
        path.display()
    );
    let kept = terminals.iter().any(|terminal| {
        terminal["meta"]["provider_status"] == json!(502)
            && terminal["meta"]["error_category"] == json!("http_502")
    });
    assert!(
        kept,
        "a genuine provider HTTP 502 must keep provider_status=502/http_502: {terminals:#?}"
    );

    entry.stop().await;
    drop(home_guard);
}

/// Multi-candidate sub-form: candidate A returns a real HTTP 502, candidate B
/// delivers committed business content, and the client cancels. The terminal
/// belongs to candidate B and must not inherit A's provider status; A's own
/// attempt row keeps the real 502.
#[tokio::test]
async fn issue7517a07_multi_candidate_cancel_does_not_inherit_primary_502() {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    let mut entry = start_multi(3000, 5000, 5000).await;
    let server_port = entry.handle.listeners[0].addr.port();
    let addr = entry.handle.listeners[0].addr;

    let body = json!({
        "model": CLIENT_MODEL,
        "input": "deliver-then-hang multi-candidate cancel regression",
        "stream": true
    })
    .to_string();
    let mut socket = TcpStream::connect(addr).await.unwrap();
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: issue7517a07-multi-cancel\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut delivered = Vec::new();
    let read = timeout(Duration::from_secs(10), async {
        let mut buf = [0u8; 4096];
        while let Ok(n) = socket.read(&mut buf).await {
            if n == 0 {
                break;
            }
            delivered.extend_from_slice(&buf[..n]);
            if delivered
                .windows(b"committed-business".len())
                .any(|window| window == b"committed-business")
            {
                break;
            }
        }
    })
    .await;
    drop(socket);
    eprintln!(
        "[issue7517a07-multi-cancel] delivered_bytes={} read_ok={:?}",
        delivered.len(),
        read.is_ok()
    );
    assert!(
        read.is_ok()
            && delivered
                .windows(b"committed-business".len())
                .any(|window| window == b"committed-business"),
        "the client must receive candidate B's committed business content before closing: {}",
        String::from_utf8_lossy(&delivered)
    );

    let path = request_records_path(&home, server_port);
    let rows = wait_terminal(&path, Duration::from_secs(15)).await;
    let terminals = dump_rows("issue7517a07-multi-cancel", &rows);
    assert!(
        !terminals.is_empty(),
        "the multi-candidate cancel must leave a terminal ledger row: {}",
        path.display()
    );
    let cancelled = terminals
        .iter()
        .find(|terminal| terminal["event_type"] == json!("request.cancelled"))
        .unwrap_or_else(|| {
            panic!(
                "a committed-then-cancelled Responses stream must record request.cancelled: {terminals:#?}"
            )
        });
    assert_eq!(
        cancelled["meta"]["provider_id"],
        json!(PROVIDER_B),
        "the terminal must belong to candidate B: {cancelled}"
    );
    assert!(
        cancelled["meta"]["provider_status"].is_null(),
        "a client cancellation has no provider HTTP status: {cancelled}"
    );
    assert_eq!(
        cancelled["meta"]["error_category"],
        json!("client_disconnect"),
        "the typed client-disconnect source owns the category: {cancelled}"
    );
    assert_eq!(
        cancelled["meta"]["observed_error"]["source"],
        json!("error01_client_disconnect"),
        "the transport-disconnect terminal must name the typed Error01 fact it holds: {cancelled}"
    );
    assert_ne!(
        cancelled["meta"]["observed_error"]["source"],
        json!("error06_projection"),
        "this path holds no V3Error06ClientProjected and must not claim it: {cancelled}"
    );
    assert_no_terminal_keeps_provider_502("multi-candidate cancel", &terminals);
    assert_primary_attempt_kept_502(&rows);

    let a_requests = entry.drain_a_requests();
    let b_requests = entry.drain_b_requests();
    assert_eq!(
        a_requests.len(),
        1,
        "candidate A must really be attempted once: {a_requests:#?}"
    );
    assert_eq!(
        b_requests.len(),
        1,
        "candidate B must really be attempted after A's 502: {b_requests:#?}"
    );

    entry.stop().await;
    drop(home_guard);
}

/// Multi-candidate sub-form: candidate A returns a real HTTP 502, candidate B
/// sends only a reasoning delta and hangs until the typed residence terminal.
/// The terminal belongs to candidate B and must not inherit A's 502; A's own
/// attempt row keeps the real 502.
#[tokio::test]
async fn issue7517a07_multi_candidate_residence_does_not_inherit_primary_502() {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    let mut entry = start_multi(3000, 5000, 5000).await;
    let server_port = entry.handle.listeners[0].addr.port();

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let response = client
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({
            "model": CLIENT_MODEL,
            "input": "reasoning-then-hang multi-candidate residence regression",
            "stream": true
        }))
        .send()
        .await;
    let client_outcome = match response {
        Err(error) => format!("transport_error: {error}"),
        Ok(response) => {
            let status = response.status();
            let body = response.bytes().await.map(|b| b.len()).unwrap_or(0);
            format!("status={status} body_bytes={body}")
        }
    };
    eprintln!("[issue7517a07-multi-residence] client_outcome={client_outcome}");

    let path = request_records_path(&home, server_port);
    let rows = wait_terminal(&path, Duration::from_secs(15)).await;
    let terminals = dump_rows("issue7517a07-multi-residence", &rows);
    assert!(
        !terminals.is_empty(),
        "the multi-candidate residence terminal must leave a ledger row: {}",
        path.display()
    );
    let terminal = terminals
        .iter()
        .find(|terminal| terminal["meta"]["provider_id"] == json!(PROVIDER_B))
        .unwrap_or_else(|| {
            panic!("the residence terminal must belong to candidate B: {terminals:#?}")
        });
    assert_eq!(
        terminal["event_type"],
        json!("request.failed"),
        "a typed residence terminal is a failed terminal: {terminal}"
    );
    assert_eq!(
        terminal["meta"]["error_category"],
        json!("provider_response_residence_timeout"),
        "the typed residence source owns the terminal category: {terminal}"
    );
    assert_eq!(
        terminal["meta"]["provider_status"],
        json!(200),
        "the terminal keeps candidate B's real upstream status, not A's 502: {terminal}"
    );
    assert_ne!(
        terminal["meta"]["provider_status"],
        json!(502),
        "the residence terminal must not inherit candidate A's 502: {terminal}"
    );
    assert_ne!(
        terminal["meta"]["error_category"],
        json!("http_502"),
        "the residence terminal must not inherit candidate A's http_502: {terminal}"
    );
    assert_eq!(
        terminal["meta"]["observed_error"]["source"],
        json!("error06_projection"),
        "the Direct residence lane holds the typed Error06 chain: {terminal}"
    );
    assert_no_terminal_keeps_provider_502("multi-candidate residence", &terminals);
    assert_primary_attempt_kept_502(&rows);

    let a_requests = entry.drain_a_requests();
    let b_requests = entry.drain_b_requests();
    assert_eq!(
        a_requests.len(),
        1,
        "candidate A must really be attempted once: {a_requests:#?}"
    );
    assert_eq!(
        b_requests.len(),
        1,
        "candidate B must really be attempted after A's 502: {b_requests:#?}"
    );

    entry.stop().await;
    drop(home_guard);
}
