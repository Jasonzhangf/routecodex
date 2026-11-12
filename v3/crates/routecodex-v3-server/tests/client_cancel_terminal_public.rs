//! Public-entry black-box behavior for client cancellation terminal ownership.
//!
//! Stable test IDs:
//! `client_cancel_before_business_records_one_cancel_and_session_recovers`,
//! `client_cancel_after_business_prefix_records_one_cancel`, and
//! `normal_completion_body_drop_does_not_add_cancel`.
//!
//! Command:
//! `node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test client_cancel_terminal_public -- --nocapture`
//!
//! Each case enters a real SSE listener through one of three modes: Responses
//! Direct, Responses Relay, or OpenAI Chat Direct. The controlled upstream
//! holds each attempt at an explicit barrier so the client can close its socket
//! before any business frame or, for the modes that commit a business prefix
//! before the provider terminal, after that committed prefix. OpenAI Chat
//! Direct buffers the whole attempt, so its applicable cases are cancellation
//! before business output and a resolved normal outcome. The request ledger is
//! read from the isolated test home and checked for one effective terminal, not
//! just one final display row.

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
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::{sleep, timeout},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const AUTH_ENV: &str = "CLIENT_CANCEL_TERMINAL_PUBLIC_KEY";
const KEEPALIVE_ENV: &str = "ROUTECODEX_HTTP_SSE_KEEPALIVE_MS";
const CLIENT_MODEL: &str = "cancel-public";
const SESSION_ID: &str = "client-cancel-terminal-public";
const KEEPALIVE_FRAME: &[u8] = b": keepalive\n\n";
const BEFORE_BUSINESS_INPUT: &str = "hold-before-business";
const AFTER_PREFIX_INPUT: &str = "business-prefix-then-hold";
const AFTER_PREFIX_TEXT: &str = "after-prefix-business";
const COMPLETION_TEXT: &str = "after-cancel-success";

/// SSE execution modes that share the Server-owned client transport channel.
///
/// The disconnect recorder lives in the shared transport, so each mode must
/// prove the same terminal behavior through its real public entry rather than
/// relying on the Direct Responses case alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    ResponsesDirect,
    ResponsesRelay,
    OpenAiChat,
}

impl Mode {
    fn endpoint_path(self) -> &'static str {
        match self {
            Self::ResponsesDirect | Self::ResponsesRelay => "/v1/responses",
            Self::OpenAiChat => "/v1/chat/completions",
        }
    }

    fn is_chat(self) -> bool {
        matches!(self, Self::OpenAiChat)
    }
}

struct EnvGuard {
    previous_auth: Option<OsString>,
    previous_keepalive: Option<OsString>,
}

impl EnvGuard {
    fn install() -> Self {
        let previous_auth = std::env::var_os(AUTH_ENV);
        let previous_keepalive = std::env::var_os(KEEPALIVE_ENV);
        std::env::set_var(AUTH_ENV, "owned-fixture-key");
        std::env::set_var(KEEPALIVE_ENV, "50");
        Self {
            previous_auth,
            previous_keepalive,
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        restore_env(AUTH_ENV, self.previous_auth.take());
        restore_env(KEEPALIVE_ENV, self.previous_keepalive.take());
    }
}

fn restore_env(name: &str, value: Option<OsString>) {
    match value {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    }
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<Value>,
    release: watch::Sender<bool>,
    mode: Mode,
}

fn completed_response(text: &str) -> String {
    let response = json!({
        "id": "resp_client_cancel_terminal",
        "object": "response",
        "status": "completed",
        "model": "wire-cancel-public",
        "output": [{
            "id": "msg_client_cancel_terminal",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{
                "type": "output_text",
                "text": text,
                "annotations": []
            }]
        }],
        "output_text": text
    });
    format!(
        "event: response.completed\ndata: {}\n\n",
        json!({"type": "response.completed", "response": response})
    )
}

fn business_delta(text: &str) -> String {
    format!(
        "event: response.output_text.delta\ndata: {}\n\n",
        json!({
            "type": "response.output_text.delta",
            "delta": text,
            "item_id": "msg_client_cancel_terminal",
            "output_index": 0,
            "content_index": 0,
            "sequence_number": 1
        })
    )
}

fn sse_response(body: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

fn chat_chunk(delta: Value, finish_reason: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl-client-cancel-terminal",
            "object": "chat.completion.chunk",
            "model": "wire-cancel-public",
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason
            }]
        })
    )
}

fn chat_prefix(text: &str) -> String {
    chat_chunk(json!({"role": "assistant", "content": text}), Value::Null)
}

fn chat_completion(text: &str) -> String {
    let mut body = chat_prefix(text);
    body.push_str(&chat_chunk(json!({}), json!("stop")));
    body.push_str("data: [DONE]\n\n");
    body
}

fn chat_sse_response(body: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

async fn controlled_upstream(
    State(state): State<Arc<ProviderState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let _ = state.captures.send(body.clone());
    // Direct Responses carries the marker as a string input; Relay and Chat
    // modes wrap it in their own message arrays. Search the serialized wire so
    // the marker gate works for every execution mode.
    let wire = body.to_string();
    let hold_before_business = wire.contains(BEFORE_BUSINESS_INPUT);
    let hold_after_prefix = wire.contains(AFTER_PREFIX_INPUT);

    if state.mode.is_chat() {
        if hold_before_business {
            let mut release = state.release.subscribe();
            let _ = release.wait_for(|released| *released).await;
            return chat_sse_response(chat_completion(COMPLETION_TEXT));
        }
        if hold_after_prefix {
            let mut release = state.release.subscribe();
            let delta = chat_prefix(AFTER_PREFIX_TEXT);
            let completed = chat_completion(AFTER_PREFIX_TEXT);
            let body = stream::once(async move { Ok::<_, Infallible>(Bytes::from(delta)) }).chain(
                stream::once(async move {
                    let _ = release.wait_for(|released| *released).await;
                    Ok::<_, Infallible>(Bytes::from(completed))
                }),
            );
            return Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(body))
                .unwrap();
        }
        return chat_sse_response(chat_completion(COMPLETION_TEXT));
    }

    if hold_before_business {
        let mut release = state.release.subscribe();
        let _ = release.wait_for(|released| *released).await;
        return sse_response(completed_response(COMPLETION_TEXT));
    }

    if hold_after_prefix {
        let mut release = state.release.subscribe();
        let delta = business_delta(AFTER_PREFIX_TEXT);
        let completed = completed_response(AFTER_PREFIX_TEXT);
        let body = stream::once(async move { Ok::<_, Infallible>(Bytes::from(delta)) }).chain(
            stream::once(async move {
                let _ = release.wait_for(|released| *released).await;
                Ok::<_, Infallible>(Bytes::from(completed))
            }),
        );
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(body))
            .unwrap();
    }

    sse_response(completed_response(COMPLETION_TEXT))
}

struct Entry {
    handle: V3ServerAggregateHandle,
    upstream_shutdown: oneshot::Sender<()>,
    upstream_task: JoinHandle<()>,
    captures: mpsc::UnboundedReceiver<Value>,
    release: watch::Sender<bool>,
}

impl Entry {
    fn release_provider(&self) {
        let _ = self.release.send(true);
    }

    async fn stop(self) {
        assert!(self.handle.shutdown().await.is_empty());
        let _ = self.upstream_shutdown.send(());
        timeout(Duration::from_secs(10), self.upstream_task)
            .await
            .expect("upstream task must stop")
            .expect("upstream task must not panic");
    }
}

fn config_source(mode: Mode, port: u16, upstream_addr: std::net::SocketAddr) -> String {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = format!(
        "{}\nattempt_store = {{ residence_timeout_ms = 5000 }}\n",
        hub_v1_fixture::hub_v1_server_execution("owned"),
    );
    match mode {
        Mode::ResponsesDirect | Mode::ResponsesRelay => {
            let process = if mode == Mode::ResponsesRelay {
                "relay"
            } else {
                "direct"
            };
            format!(
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
default_model = "{CLIENT_MODEL}"
auth = {{type="api_key",entries=[{{alias="key",env="{AUTH_ENV}"}}]}}
health = {{enabled=true,failure_threshold=1,cooldown_ms=5000}}
responses = {{process="{process}",streaming="always"}}
request_timeout_ms = 5000
sse_first_frame_timeout_ms = 5000
[providers.test.models.{CLIENT_MODEL}]
wire_name = "wire-cancel-public"
capabilities = ["text"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{strategy="priority"}}
targets = [{{kind="provider_model",provider="test",model="{CLIENT_MODEL}",key="key",priority=1}}]
[debug]
log_console = false
snapshots = true
"#,
            )
        }
        Mode::OpenAiChat => format!(
            r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["openai_chat"]
{execution}
[providers.test]
type = "openai_chat"
base_url = "http://{upstream_addr}/v1"
default_model = "{CLIENT_MODEL}"
auth = {{type="api_key",entries=[{{alias="key",env="{AUTH_ENV}"}}]}}
health = {{enabled=true,failure_threshold=1,cooldown_ms=5000}}
request_timeout_ms = 5000
sse_first_frame_timeout_ms = 5000
[providers.test.models.{CLIENT_MODEL}]
wire_name = "wire-cancel-public"
capabilities = ["text"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{strategy="priority"}}
targets = [{{kind="provider_model",provider="test",model="{CLIENT_MODEL}",key="key",priority=1}}]
[debug]
log_console = false
snapshots = true
"#,
        ),
    }
}

async fn start(mode: Mode) -> Entry {
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (upstream_shutdown_tx, upstream_shutdown_rx) = oneshot::channel();
    let (release_tx, _release_rx) = watch::channel(false);
    let provider_release = release_tx.clone();
    let upstream_task = tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new()
                .route("/v1/responses", post(controlled_upstream))
                .route("/v1/chat/completions", post(controlled_upstream))
                .with_state(Arc::new(ProviderState {
                    captures: captures_tx,
                    release: provider_release.clone(),
                    mode,
                })),
        )
        .with_graceful_shutdown(async move {
            let _ = upstream_shutdown_rx.await;
        })
        .await
        .unwrap();
    });

    let port = test_ports::free_port();
    let source = config_source(mode, port, upstream_addr);
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    Entry {
        handle: spawn_v3_server_aggregate(manifest).await.unwrap(),
        upstream_shutdown: upstream_shutdown_tx,
        upstream_task,
        captures: captures_rx,
        release: release_tx,
    }
}

fn request_json(mode: Mode, input: &str) -> Value {
    match mode {
        Mode::ResponsesDirect | Mode::ResponsesRelay => json!({
            "model": CLIENT_MODEL,
            "input": input,
            "stream": true
        }),
        Mode::OpenAiChat => json!({
            "model": CLIENT_MODEL,
            "messages": [{"role": "user", "content": input}],
            "stream": true
        }),
    }
}

fn request_body(mode: Mode, input: &str) -> String {
    request_json(mode, input).to_string()
}

async fn write_raw_request(socket: &mut TcpStream, mode: Mode, input: &str) {
    let body = request_body(mode, input);
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: {SESSION_ID}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        mode.endpoint_path(),
        body.len()
    );
    socket.write_all(request.as_bytes()).await.unwrap();
}

async fn read_until(socket: &mut TcpStream, needle: &[u8], budget: Duration) -> Vec<u8> {
    let deadline = Instant::now() + budget;
    let mut wire = Vec::new();
    loop {
        if wire.windows(needle.len()).any(|window| window == needle) {
            return wire;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let mut chunk = [0_u8; 4096];
        match timeout(remaining, socket.read(&mut chunk)).await {
            Ok(Ok(0)) => panic!(
                "client socket closed before {:?}: {}",
                String::from_utf8_lossy(needle),
                String::from_utf8_lossy(&wire)
            ),
            Ok(Ok(count)) => wire.extend_from_slice(&chunk[..count]),
            Ok(Err(error)) => panic!("client socket read failed before expected bytes: {error}"),
            Err(_) => panic!(
                "timed out waiting for {:?}: {}",
                String::from_utf8_lossy(needle),
                String::from_utf8_lossy(&wire)
            ),
        }
    }
}

fn request_records_path(home: &Path, port: u16) -> PathBuf {
    home.join(".rcc")
        .join("logs")
        .join(format!("server-v3-{port}.request-records.jsonl"))
}

async fn cooldown_entries(
    client: &reqwest::Client,
    server_addr: std::net::SocketAddr,
) -> Vec<Value> {
    let response = client
        .get(format!(
            "http://{server_addr}/_routecodex/health/cooldown-pool"
        ))
        .send()
        .await
        .expect("cooldown pool endpoint");
    assert_eq!(response.status(), StatusCode::OK);
    response.json::<Value>().await.unwrap()["entries"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn read_rows(path: &Path) -> Vec<Value> {
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

fn session_rows<'a>(rows: &'a [Value], event_type: &str) -> Vec<&'a Value> {
    rows.iter()
        .filter(|row| {
            row["scope"]["session"] == json!(SESSION_ID) && row["event_type"] == json!(event_type)
        })
        .collect()
}

fn session_terminal_rows<'a>(rows: &'a [Value]) -> Vec<&'a Value> {
    rows.iter()
        .filter(|row| row["scope"]["session"] == json!(SESSION_ID) && is_terminal(row))
        .collect()
}

async fn wait_for_event(path: &Path, event_type: &str, budget: Duration) -> Vec<Value> {
    let deadline = Instant::now() + budget;
    loop {
        let rows = read_rows(path);
        if !session_rows(&rows, event_type).is_empty() {
            return rows;
        }
        if Instant::now() >= deadline {
            panic!(
                "timed out waiting for {event_type} in {}: {rows:#?}",
                path.display()
            );
        }
        sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_for_terminal_count(path: &Path, count: usize, budget: Duration) -> Vec<Value> {
    let deadline = Instant::now() + budget;
    loop {
        let rows = read_rows(path);
        if session_terminal_rows(&rows).len() >= count {
            return rows;
        }
        if Instant::now() >= deadline {
            panic!(
                "timed out waiting for {count} terminal row(s) in {}: {rows:#?}",
                path.display()
            );
        }
        sleep(Duration::from_millis(50)).await;
    }
}

fn assert_cancelled_terminal(row: &Value) {
    assert_eq!(row["event_type"], json!("request.cancelled"), "{row}");
    assert!(
        row["meta"]["provider_status"].is_null(),
        "client cancellation must not carry a provider status: {row}"
    );
    assert_eq!(
        row["meta"]["error_category"],
        json!("client_disconnect"),
        "the typed client-disconnect source owns the terminal category: {row}"
    );
    assert_eq!(
        row["meta"]["observed_error"]["source"],
        json!("error01_client_disconnect"),
        "the terminal must name the typed Error01 fact it holds: {row}"
    );
}

fn assert_no_failed_or_provider_failure(rows: &[Value]) {
    for row in rows {
        if row["scope"]["session"] != json!(SESSION_ID) {
            continue;
        }
        assert_ne!(
            row["event_type"],
            json!("request.failed"),
            "client cancellation must not record a failed terminal: {row}"
        );
        assert_ne!(
            row["event_type"],
            json!("request.provider_attempt_failed"),
            "client cancellation must not pollute provider health: {row}"
        );
    }
}

async fn run_before_business(mode: Mode) {
    let (_home_guard, _lock) = TEST_LOCK.lock().await;
    let _env = EnvGuard::install();
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    let mut entry = start(mode).await;
    let server_addr = entry.handle.listeners[0].addr;
    let path = request_records_path(&home, server_addr.port());

    let mut socket = TcpStream::connect(server_addr).await.unwrap();
    write_raw_request(&mut socket, mode, BEFORE_BUSINESS_INPUT).await;
    let capture = timeout(Duration::from_secs(5), entry.captures.recv())
        .await
        .expect("the controlled provider must receive the held request")
        .expect("provider capture channel");
    assert_eq!(capture["stream"], json!(true));

    let wire = read_until(&mut socket, KEEPALIVE_FRAME, Duration::from_secs(3)).await;
    let head = String::from_utf8_lossy(&wire);
    assert!(
        head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200"),
        "the client must observe a committed SSE head: {head}"
    );
    assert!(
        head.contains(": keepalive\n\n"),
        "the client must observe transport keepalive before the business frame: {head}"
    );
    let rows = wait_for_event(&path, "request.route_selected", Duration::from_secs(3)).await;
    assert!(
        !session_rows(&rows, "request.route_selected").is_empty(),
        "the request must be selected before the disconnect: {rows:#?}"
    );

    drop(socket);
    let rows = wait_for_terminal_count(&path, 1, Duration::from_secs(10)).await;
    let terminals = session_terminal_rows(&rows);
    assert_eq!(
        terminals.len(),
        1,
        "the keepalive-only disconnect must produce one effective terminal: {terminals:#?}"
    );
    assert_cancelled_terminal(terminals[0]);
    assert_no_failed_or_provider_failure(&rows);

    entry.release_provider();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    assert!(
        cooldown_entries(&client, server_addr).await.is_empty(),
        "the cancelled request must not pollute provider health"
    );
    let response = client
        .post(format!("http://{server_addr}{}", mode.endpoint_path()))
        .header("x-session-id", SESSION_ID)
        .json(&request_json(mode, "complete after-cancel-success"))
        .send()
        .await
        .expect("the same session must recover after the cancellation");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(
        body.contains(COMPLETION_TEXT),
        "the same-session recovery request must complete: {body}"
    );
    let capture = timeout(Duration::from_secs(5), entry.captures.recv())
        .await
        .expect("the same-session recovery request must reach the provider")
        .expect("provider capture channel");
    assert!(
        capture
            .to_string()
            .contains("complete after-cancel-success"),
        "{mode:?} recovery request must reach the provider with its marker: {capture}"
    );
    assert!(
        cooldown_entries(&client, server_addr).await.is_empty(),
        "the same-session recovery must leave provider health neutral"
    );

    let rows = wait_for_terminal_count(&path, 2, Duration::from_secs(10)).await;
    let terminals = session_terminal_rows(&rows);
    assert_eq!(
        terminals.len(),
        2,
        "the cancelled request and the recovered request must each have one terminal: {terminals:#?}"
    );
    assert_eq!(
        terminals
            .iter()
            .filter(|row| row["event_type"] == json!("request.cancelled"))
            .count(),
        1,
        "the same-session success must not add a second cancelled terminal: {terminals:#?}"
    );
    assert_eq!(
        terminals
            .iter()
            .filter(|row| row["event_type"] == json!("request.completed"))
            .count(),
        1,
        "the recovered request must complete once: {terminals:#?}"
    );
    assert_no_failed_or_provider_failure(&rows);

    sleep(Duration::from_millis(200)).await;
    let rows = read_rows(&path);
    assert_eq!(
        session_terminal_rows(&rows).len(),
        2,
        "dropping the completed response body must not append another terminal"
    );
    entry.stop().await;
}

async fn run_after_business_prefix(mode: Mode) {
    let (_home_guard, _lock) = TEST_LOCK.lock().await;
    let _env = EnvGuard::install();
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    let mut entry = start(mode).await;
    let server_addr = entry.handle.listeners[0].addr;
    let path = request_records_path(&home, server_addr.port());

    let mut socket = TcpStream::connect(server_addr).await.unwrap();
    write_raw_request(&mut socket, mode, AFTER_PREFIX_INPUT).await;
    let capture = timeout(Duration::from_secs(5), entry.captures.recv())
        .await
        .expect("the controlled provider must receive the prefix request")
        .expect("provider capture channel");
    assert_eq!(capture["stream"], json!(true));
    let wire = read_until(
        &mut socket,
        AFTER_PREFIX_TEXT.as_bytes(),
        Duration::from_secs(5),
    )
    .await;
    assert!(
        String::from_utf8_lossy(&wire).contains(AFTER_PREFIX_TEXT),
        "the client must receive the committed business prefix before closing"
    );

    drop(socket);
    let rows = wait_for_terminal_count(&path, 1, Duration::from_secs(10)).await;
    let terminals = session_terminal_rows(&rows);
    assert_eq!(
        terminals.len(),
        1,
        "the post-prefix disconnect must produce one effective terminal: {terminals:#?}"
    );
    assert_cancelled_terminal(terminals[0]);
    assert_no_failed_or_provider_failure(&rows);
    entry.release_provider();

    sleep(Duration::from_millis(200)).await;
    let rows = read_rows(&path);
    assert_eq!(
        session_terminal_rows(&rows).len(),
        1,
        "the provider completion after the disconnect must not add a second terminal"
    );
    entry.stop().await;
}

async fn run_normal_completion(mode: Mode) {
    let (_home_guard, _lock) = TEST_LOCK.lock().await;
    let _env = EnvGuard::install();
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    let entry = start(mode).await;
    let server_addr = entry.handle.listeners[0].addr;
    let path = request_records_path(&home, server_addr.port());
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let response = client
        .post(format!("http://{server_addr}{}", mode.endpoint_path()))
        .header("x-session-id", SESSION_ID)
        .json(&request_json(mode, "complete normal-completion-body-drop"))
        .send()
        .await
        .expect("normal completion must return a response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(
        body.contains(COMPLETION_TEXT),
        "normal completion must deliver its business result: {body}"
    );

    let rows = wait_for_terminal_count(&path, 1, Duration::from_secs(10)).await;
    let terminals = session_terminal_rows(&rows);
    assert_eq!(
        terminals.len(),
        1,
        "normal completion must produce one effective terminal: {terminals:#?}"
    );
    assert_eq!(
        terminals[0]["event_type"],
        json!("request.completed"),
        "normal completion must remain a success terminal: {}",
        terminals[0]
    );
    assert!(
        terminals
            .iter()
            .all(|row| row["event_type"] != json!("request.cancelled")),
        "a normal completed response must not become cancelled: {terminals:#?}"
    );

    sleep(Duration::from_millis(200)).await;
    let rows = read_rows(&path);
    assert_eq!(
        session_terminal_rows(&rows).len(),
        1,
        "dropping the completed body must not append a cancelled terminal"
    );
    entry.stop().await;
}

#[tokio::test]
async fn client_cancel_before_business_records_one_cancel_and_session_recovers() {
    run_before_business(Mode::ResponsesDirect).await;
}

#[tokio::test]
async fn client_cancel_after_business_prefix_records_one_cancel() {
    run_after_business_prefix(Mode::ResponsesDirect).await;
}

#[tokio::test]
async fn normal_completion_body_drop_does_not_add_cancel() {
    run_normal_completion(Mode::ResponsesDirect).await;
}

#[tokio::test]
async fn client_cancel_before_business_records_one_cancel_responses_relay() {
    run_before_business(Mode::ResponsesRelay).await;
}

#[tokio::test]
async fn client_cancel_after_business_prefix_records_one_cancel_responses_relay() {
    run_after_business_prefix(Mode::ResponsesRelay).await;
}

#[tokio::test]
async fn normal_completion_body_drop_does_not_add_cancel_responses_relay() {
    run_normal_completion(Mode::ResponsesRelay).await;
}

#[tokio::test]
async fn client_cancel_before_business_records_one_cancel_openai_chat() {
    run_before_business(Mode::OpenAiChat).await;
}

#[tokio::test]
async fn normal_completion_body_drop_does_not_add_cancel_openai_chat() {
    run_normal_completion(Mode::OpenAiChat).await;
}
