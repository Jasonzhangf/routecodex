//! Public-entry black-box behavior for the client-facing transport boundary.
//!
//! Test IDs (run with
//! `cargo test -p routecodex-v3-server --test client_transport_boundary_controlled`):
//! - `chat_sse_head_commit_keeps_the_client_transport_live_while_the_provider_stalls`
//! - `chat_json_client_still_waits_for_the_runtime_outcome`
//! - `chat_sse_head_commit_never_projects_a_provider_terminal_to_the_client`
//! - `chat_sse_head_commit_carries_a_json_success_for_an_sse_client`
//! - `exec_preparation_drains_an_in_flight_client_response_before_closing_transports`
//! - `exec_preparation_waits_for_real_provider_timeout_without_fabricated_terminal`
//! - `borrowed_exec_preparation_cancellation_resumes_queued_dispatch_and_pending_sse`
//!
//! Every case enters through the real `/v1/chat/completions` listener with a
//! controlled provider. The controlled provider holds its response until the test
//! releases it, so a client that observes the SSE head before the release proves
//! the head was committed while the provider attempt was still buffered.
use axum::body::Body;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{
    spawn_v3_server_aggregate, spawn_v3_server_aggregate_with_admin, V3ServerAggregateHandle,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const KEEPALIVE_MS: u64 = 300;
const KEEPALIVE_FRAME: &[u8] = b": keepalive\n\n";

struct ProviderState {
    captures: mpsc::UnboundedSender<Value>,
    release: watch::Sender<bool>,
}

async fn controlled_gated_openai_chat_upstream(
    State(state): State<Arc<ProviderState>>,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    let _ = state.captures.send(body.clone());
    let content = body
        .pointer("/messages/0/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let stream_requested = body.get("stream").and_then(Value::as_bool) == Some(true);

    // The provider attempt stays buffered until the test releases it. A client
    // that observes the response head before this returns proves the head was
    // committed while the provider attempt was still in flight.
    let mut release = state.release.subscribe();
    let _ = release.wait_for(|released| *released).await;

    if stream_requested && content == "fail-slow" {
        // A real provider terminal whose raw body must never reach the client.
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"type":"rate_limit_error","message":"raw provider secret detail"}}"#,
            ))
            .unwrap();
    }

    if stream_requested && content == "json-for-stream" {
        // A compatible upstream may answer a streaming request with a complete
        // JSON document. The client keeps its SSE boundary, so the committed
        // channel must carry the projected successful payload instead of
        // turning the successful outcome into a client transport failure.
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "id": "chatcmpl-json-for-stream",
                    "object": "chat.completion",
                    "model": "chat-wire-model",
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": "controlled json for sse"},
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
                }))
                .unwrap(),
            ))
            .unwrap();
    }

    if stream_requested {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(
                br#"data: {"id":"chatcmpl-controlled","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"first"},"finish_reason":null}]}

data: {"id":"chatcmpl-controlled","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#
                .to_vec(),
            ))
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "id": "chatcmpl-controlled",
                "object": "chat.completion",
                "model": "chat-wire-model",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "controlled json"},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
            }))
            .unwrap(),
        ))
        .unwrap()
}

struct ControlledEntry {
    endpoint: String,
    handle: V3ServerAggregateHandle,
    captures: mpsc::UnboundedReceiver<Value>,
    release: watch::Sender<bool>,
    upstream_shutdown: oneshot::Sender<()>,
}

impl ControlledEntry {
    fn release_provider(&self) {
        let _ = self.release.send(true);
    }
}

async fn start_controlled_entry() -> ControlledEntry {
    start_controlled_entry_with_timeout(None).await
}

async fn start_controlled_entry_with_timeout(request_timeout_ms: Option<u64>) -> ControlledEntry {
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (upstream_shutdown_tx, upstream_shutdown_rx) = oneshot::channel();
    let (release_tx, _release_rx) = watch::channel(false);
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(controlled_gated_openai_chat_upstream),
        )
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
            release: release_tx.clone(),
        }));
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = upstream_shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let mut manifest = manifest(free_port(), upstream_addr.port());
    if let Some(timeout_ms) = request_timeout_ms {
        manifest
            .providers
            .get_mut("controlled")
            .unwrap()
            .request_timeout_ms = timeout_ms;
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    ControlledEntry {
        endpoint: format!("http://{}/v1/chat/completions", handle.listeners[0].addr),
        handle,
        captures: captures_rx,
        release: release_tx,
        upstream_shutdown: upstream_shutdown_tx,
    }
}

async fn stop_controlled_entry(entry: ControlledEntry) {
    entry.handle.shutdown().await;
    let _ = entry.upstream_shutdown.send(());
    std::env::remove_var("ROUTECODEX_HTTP_SSE_KEEPALIVE_MS");
}

#[tokio::test]
async fn chat_sse_head_commit_keeps_the_client_transport_live_while_the_provider_stalls() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_controlled_entry().await;
    let client = reqwest::Client::new();

    let response = tokio::time::timeout(
        Duration::from_secs(5),
        client
            .post(&entry.endpoint)
            .json(&json!({
                "model": "chat-client-alias",
                "messages": [{"role": "user", "content": "stream"}],
                "stream": true
            }))
            .send(),
    )
    .await
    .expect("the committed client SSE head must arrive while the provider is still gated")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream"),
        "a streaming client must observe the committed SSE head"
    );
    let capture = entry
        .captures
        .try_recv()
        .expect("the provider must already hold the buffered attempt");
    assert_eq!(capture["stream"], json!(true));

    let mut body = response.bytes_stream();
    let first = tokio::time::timeout(Duration::from_secs(2), body.next())
        .await
        .expect("the committed head must write its first byte immediately")
        .unwrap()
        .unwrap();
    assert_eq!(
        first.as_ref(),
        KEEPALIVE_FRAME,
        "the committed head must carry a transport keepalive"
    );
    let second = tokio::time::timeout(Duration::from_secs(2), body.next())
        .await
        .expect("the client transport must stay live while the provider is gated")
        .unwrap()
        .unwrap();
    assert_eq!(
        second.as_ref(),
        KEEPALIVE_FRAME,
        "keepalives must repeat at the configured interval"
    );

    entry.release_provider();
    let mut rest = Vec::new();
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(5), body.next())
        .await
        .expect("the runtime outcome must still reach the committed client stream")
    {
        rest.extend_from_slice(&chunk.unwrap());
    }
    let rest = String::from_utf8(rest).unwrap();
    assert!(
        rest.contains("\"content\":\"first\""),
        "the buffered provider payload must stream through once: {rest}"
    );
    assert!(
        rest.contains("data: [DONE]"),
        "the runtime terminal must stream through: {rest}"
    );
    stop_controlled_entry(entry).await;
}

#[tokio::test]
async fn chat_json_client_still_waits_for_the_runtime_outcome() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_controlled_entry().await;
    let client = reqwest::Client::new();
    let endpoint = entry.endpoint.clone();
    let request = tokio::spawn(async move {
        client
            .post(&endpoint)
            .json(&json!({
                "model": "chat-client-alias",
                "messages": [{"role": "user", "content": "json"}],
                "stream": false
            }))
            .send()
            .await
    });
    tokio::time::sleep(Duration::from_millis(KEEPALIVE_MS * 3)).await;
    assert!(
        !request.is_finished(),
        "a non-SSE client must keep waiting for the runtime outcome"
    );
    let _capture = entry
        .captures
        .try_recv()
        .expect("the provider must already hold the buffered attempt");

    entry.release_provider();
    let response = tokio::time::timeout(Duration::from_secs(5), request)
        .await
        .expect("the runtime outcome must reach the non-SSE client")
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["choices"][0]["message"]["content"], "controlled json");
    stop_controlled_entry(entry).await;
}

#[tokio::test]
async fn chat_sse_head_commit_never_projects_a_provider_terminal_to_the_client() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_controlled_entry().await;
    let client = reqwest::Client::new();

    let response = tokio::time::timeout(
        Duration::from_secs(5),
        client
            .post(&entry.endpoint)
            .json(&json!({
                "model": "chat-client-alias",
                "messages": [{"role": "user", "content": "fail-slow"}],
                "stream": true
            }))
            .send(),
    )
    .await
    .expect("the committed client SSE head must arrive while the provider is still gated")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.bytes_stream();
    let first = tokio::time::timeout(Duration::from_secs(2), body.next())
        .await
        .expect("the committed head must write its first byte immediately")
        .unwrap()
        .unwrap();
    assert_eq!(first.as_ref(), KEEPALIVE_FRAME);
    let _capture = entry
        .captures
        .try_recv()
        .expect("the provider must already hold the buffered attempt");

    entry.release_provider();
    let mut received = Vec::new();
    let mut aborted = false;
    loop {
        match tokio::time::timeout(Duration::from_secs(5), body.next()).await {
            Ok(Some(Ok(chunk))) => received.extend_from_slice(&chunk),
            Ok(Some(Err(_))) | Err(_) => {
                aborted = true;
                break;
            }
            Ok(None) => break,
        }
    }
    assert!(
        aborted,
        "a provider terminal must stay an explicit client transport failure, not a clean end"
    );
    let received = String::from_utf8_lossy(&received).to_string();
    assert!(
        received.is_empty() || received.starts_with(": keepalive"),
        "only transport keepalives may follow the committed head before the terminal: {received}"
    );
    assert!(
        !received.contains("raw provider secret detail"),
        "provider detail must never reach the client: {received}"
    );
    assert!(
        !received.contains("data:"),
        "no error frame may be projected to the client: {received}"
    );
    stop_controlled_entry(entry).await;
}

/// A successful runtime outcome must reach an SSE client even when the projected
/// client payload is not itself SSE. The committed channel carries the payload by
/// SSE transport framing; a successful outcome must never turn into a client
/// transport failure or an error frame.
#[tokio::test]
async fn chat_sse_head_commit_carries_a_json_success_for_an_sse_client() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_controlled_entry().await;
    let client = reqwest::Client::new();

    let response = tokio::time::timeout(
        Duration::from_secs(5),
        client
            .post(&entry.endpoint)
            .json(&json!({
                "model": "chat-client-alias",
                "messages": [{"role": "user", "content": "json-for-stream"}],
                "stream": true
            }))
            .send(),
    )
    .await
    .expect("the committed client SSE head must arrive while the provider is still gated")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream"),
        "a streaming client must observe the committed SSE head"
    );
    let _capture = entry
        .captures
        .try_recv()
        .expect("the provider must already hold the buffered attempt");

    let mut body = response.bytes_stream();
    let first = tokio::time::timeout(Duration::from_secs(2), body.next())
        .await
        .expect("the committed head must write its first byte immediately")
        .unwrap()
        .unwrap();
    assert_eq!(first.as_ref(), KEEPALIVE_FRAME);

    entry.release_provider();
    let mut received = Vec::new();
    let mut aborted = false;
    loop {
        match tokio::time::timeout(Duration::from_secs(5), body.next()).await {
            Ok(Some(Ok(chunk))) => received.extend_from_slice(&chunk),
            Ok(Some(Err(_))) | Err(_) => {
                aborted = true;
                break;
            }
            Ok(None) => break,
        }
    }
    assert!(
        !aborted,
        "a successful runtime outcome must not become a client transport failure"
    );
    let received = String::from_utf8_lossy(&received).to_string();
    assert!(
        received.starts_with("data: {"),
        "the committed channel must carry the projected payload by SSE framing: {received}"
    );
    assert!(
        received.contains("controlled json for sse"),
        "the projected successful payload must reach the client unchanged: {received}"
    );
    assert!(
        !received.contains("\"error\""),
        "no error payload may be projected to the client: {received}"
    );
    stop_controlled_entry(entry).await;
}

/// An exec replacement must let the client responses that are already in flight
/// finish. The provider attempt stays gated while `prepare_for_exec` runs, so the
/// committed response can only complete if the preparation waited for it.
#[tokio::test]
async fn exec_preparation_drains_an_in_flight_client_response_before_closing_transports() {
    let _guard = TEST_LOCK.lock().await;
    let ControlledEntry {
        endpoint,
        handle,
        mut captures,
        release,
        upstream_shutdown,
    } = start_controlled_entry().await;
    let client = reqwest::Client::new();
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        client
            .post(&endpoint)
            .json(&json!({
                "model": "chat-client-alias",
                "messages": [{"role": "user", "content": "stream"}],
                "stream": true
            }))
            .send(),
    )
    .await
    .expect("the committed client SSE head must arrive while the provider is gated")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.bytes_stream();
    let first = tokio::time::timeout(Duration::from_secs(2), body.next())
        .await
        .expect("the committed head must write its first byte immediately")
        .unwrap()
        .unwrap();
    assert_eq!(first.as_ref(), KEEPALIVE_FRAME);
    let _capture = tokio::time::timeout(Duration::from_secs(5), captures.recv())
        .await
        .expect("the provider must hold the buffered attempt")
        .expect("the provider capture channel must stay open");

    // Release the provider only after the preparation started, so a preparation
    // that closes transports without draining cuts this response.
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = release.send(true);
    });
    let started = std::time::Instant::now();
    let _preparation = handle.prepare_for_exec().await;
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "exec preparation must wait for the in-flight client response, waited {:?}",
        started.elapsed()
    );

    let mut rest = Vec::new();
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(5), body.next())
        .await
        .expect("the drained client response must stay readable until it completes")
    {
        rest.extend_from_slice(&chunk.expect("the drained client response must not break"));
    }
    let rest = String::from_utf8(rest).unwrap();
    assert!(
        rest.contains("\"content\":\"first\""),
        "the drained response must deliver its payload: {rest}"
    );
    assert!(
        rest.contains("data: [DONE]"),
        "the drained response must deliver its terminal frame: {rest}"
    );
    let _ = upstream_shutdown.send(());
    std::env::remove_var("ROUTECODEX_HTTP_SSE_KEEPALIVE_MS");
}

/// The provider request deadline, rather than a restart drain cutoff, ends an
/// unsuccessful attempt. Its error remains request-local with no client payload.
#[tokio::test]
async fn exec_preparation_waits_for_real_provider_timeout_without_fabricated_terminal() {
    let _guard = TEST_LOCK.lock().await;
    let ControlledEntry {
        endpoint,
        handle,
        mut captures,
        release: _release,
        upstream_shutdown,
    } = start_controlled_entry_with_timeout(Some(1200)).await;
    let client = reqwest::Client::new();
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        client
            .post(&endpoint)
            .json(&json!({
                "model": "chat-client-alias",
                "messages": [{"role": "user", "content": "stream"}],
                "stream": true
            }))
            .send(),
    )
    .await
    .expect("the committed client SSE head must arrive while the provider is gated")
    .unwrap();
    let mut body = response.bytes_stream();
    let first = tokio::time::timeout(Duration::from_secs(2), body.next())
        .await
        .expect("the committed head must write its first byte immediately")
        .unwrap()
        .unwrap();
    assert_eq!(first.as_ref(), KEEPALIVE_FRAME);
    let _capture = tokio::time::timeout(Duration::from_secs(5), captures.recv())
        .await
        .expect("the provider must hold the buffered attempt")
        .expect("the provider capture channel must stay open");

    let started = std::time::Instant::now();
    let _preparation = tokio::time::timeout(Duration::from_secs(20), handle.prepare_for_exec())
        .await
        .expect("exec preparation must never wait forever for an in-flight response");
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(700) && elapsed < Duration::from_secs(10),
        "exec preparation must wait for the actual provider request deadline, waited {elapsed:?}"
    );

    let mut received = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(5), body.next()).await {
            Ok(Some(Ok(chunk))) => received.extend_from_slice(&chunk),
            Ok(Some(Err(_))) | Err(_) | Ok(None) => break,
        }
    }
    let received = String::from_utf8_lossy(&received).to_string();
    assert!(
        !received.contains("data: [DONE]"),
        "an unfinished provider attempt must not project a terminal frame: {received}"
    );
    let _ = upstream_shutdown.send(());
    std::env::remove_var("ROUTECODEX_HTTP_SSE_KEEPALIVE_MS");
}

/// Borrowed preparation must restore queued business dispatch when its caller
/// cancels, while the already committed SSE remains healthy.
#[tokio::test]
async fn borrowed_exec_preparation_cancellation_resumes_queued_dispatch_and_pending_sse() {
    let _guard = TEST_LOCK.lock().await;
    let ControlledEntry {
        endpoint,
        handle,
        mut captures,
        release,
        upstream_shutdown,
    } = start_controlled_entry().await;
    let client = reqwest::Client::new();
    // First complete a request so this client can reuse its keepalive connection.
    release.send_replace(true);
    let warm = client
        .post(&endpoint)
        .json(&json!({
            "model": "chat-client-alias", "messages": [{"role":"user", "content":"warm"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        warm.json::<Value>().await.unwrap()["id"],
        "chatcmpl-controlled"
    );
    captures.recv().await.unwrap();
    release.send_replace(false);
    let held = client.post(&endpoint).json(&json!({
        "model": "chat-client-alias", "messages": [{"role":"user", "content":"held"}], "stream":true
    })).send().await.unwrap();
    assert_eq!(held.status(), StatusCode::OK);
    captures.recv().await.unwrap();
    let mut preparation = Box::pin(handle.prepare_exec_attempt());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut preparation)
            .await
            .is_err()
    );
    let mut queued = Box::pin(client.post(&endpoint).json(&json!({
        "model": "chat-client-alias", "messages": [{"role":"user", "content":"queued"}], "stream":false
    })).send());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut queued)
            .await
            .is_err()
    );
    assert!(
        captures.try_recv().is_err(),
        "queued dispatch must not reach the provider"
    );
    drop(preparation);
    // Poll the queued JSON concurrently: it reaches the still-held provider
    // before that provider is released, proving cancellation reopened admission.
    tokio::select! {
        result = &mut queued => panic!("provider must still be held: {result:?}"),
        captured = captures.recv() => {
            assert_eq!(captured.unwrap()["messages"][0]["content"], "queued");
        }
        _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("cancelled preparation did not restore dispatch"),
    }
    release.send(true).unwrap();
    let queued = queued.await.unwrap();
    assert_eq!(queued.status(), StatusCode::OK);
    assert_eq!(
        queued.json::<Value>().await.unwrap()["id"],
        "chatcmpl-controlled"
    );
    let held_body = held.text().await.unwrap();
    assert!(held_body.contains("\"content\":\"first\""), "{held_body}");
    assert_eq!(held_body.matches("data: [DONE]").count(), 1, "{held_body}");
    handle.shutdown().await;
    let _ = upstream_shutdown.send(());
    std::env::remove_var("ROUTECODEX_HTTP_SSE_KEEPALIVE_MS");
}

fn manifest(
    server_port: u16,
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    std::env::set_var("ROUTECODEX_HTTP_SSE_KEEPALIVE_MS", KEEPALIVE_MS.to_string());
    std::env::set_var("V3_OPENAI_CHAT_CONTROLLED_KEY", "controlled-secret");
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.controlled]
bind = "127.0.0.1"
port = {server_port}
routing_group = "controlled"
endpoints = ["openai_chat"]

{server_execution}

[providers.controlled]
type = "openai_chat"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "chat-wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "V3_OPENAI_CHAT_CONTROLLED_KEY" }}] }}
[providers.controlled.models.chat-wire-model]
wire_name = "chat-wire-model"
aliases = ["chat-client-alias"]
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.controlled.pools.chat_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["chat-client-alias"] }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "chat-wire-model", key = "controlled", priority = 1 }}]
[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "chat-wire-model", key = "controlled", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("controlled"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

// ===========================================================================
// client_reset_enters_fixed_error_before_cleanup (public-entry red test)
//
// A real raw-TCP client opens the public `/v1/chat/completions` entry with
// `stream:true`. The controlled provider captures the buffered attempt and stays
// gated while the committed SSE head and its transport keepalives reach the
// client, then the client resets the connection. The corrected contract requires
// the real client-transport failure to enter the independent typed Error chain
// (ErrorErr01..ErrorErr06) and then produce a typed internal outcome, an
// abort/already-disconnected receipt, drain, attempt cleanup and the request
// finalizer -- with no provider health mutation -- and to leave the listener and
// provider identity usable for a later request.
//
// Isolation: the parent test process keeps the real HOME and only re-executes
// this exact test as a child whose Command environment binds the owned fixture
// HOME. The real `<HOME>/.rcc` sample lock is never touched.
// ===========================================================================

const CLIENT_RED_CHILD_ENV: &str = "V3_CLIENT_RED_ISOLATED_CHILD";
const CLIENT_RED_TEST_NAME: &str = "client_reset_enters_fixed_error_before_cleanup";
const CLIENT_RED_HOME: &str = "/Volumes/Intel/playground/routecodex/client-error-runtime-20261011/v3/build-control/temp/runtime-error-fixture-home/client-red";

/// Corrected graph identities (reviewed lifecycle manifest `error_sequence`).
const CORRECTED_ERROR_CHAIN: [&str; 6] = [
    "ErrorErr01SourceRaised",
    "ErrorErr02HostCaptured",
    "ErrorErr03RuntimeClassified",
    "ErrorErr04RouterPolicyApplied",
    "ErrorErr05ExecutionDecision",
    "ErrorErr06ClientProjected",
];
/// Current Rust chain identities (`V3_ERROR_CHAIN_NODE_IDS`), accepted as the
/// same six nodes until A/C reconcile the graph and runtime symbols.
const LEGACY_ERROR_CHAIN: [&str; 6] = [
    "V3Error01SourceRaised",
    "V3Error02Classified",
    "V3Error03TargetLocalAction",
    "V3Error04TargetExhaustionDecision",
    "V3Error05ExecutionDecision",
    "V3Error06ClientProjected",
];
/// Corrected ordered closeout (reviewed lifecycle manifest `cleanup_order`).
const CORRECTED_CLOSEOUT: [&str; 5] = [
    "RuntimeTransportOutcome",
    "ServerAbortOrAlreadyDisconnectedReceipt",
    "drain",
    "RuntimeAttemptCleanup",
    "RuntimeRequestFinalizer",
];

fn client_red_chain_index(node: &str) -> Option<usize> {
    CORRECTED_ERROR_CHAIN
        .iter()
        .position(|candidate| *candidate == node)
        .or_else(|| {
            LEGACY_ERROR_CHAIN
                .iter()
                .position(|candidate| *candidate == node)
        })
}

/// Read one JSONL evidence file into parsed lines; a missing file reads empty.
fn read_client_red_jsonl(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Controlled entry whose aggregate server binds an owned canonical config path
/// and an owned debug-log file, so all server state stays inside the fixture home.
async fn start_client_red_entry(
    run_dir: &Path,
    log_path: &Path,
    config_path: &Path,
) -> ControlledEntry {
    std::fs::create_dir_all(run_dir).unwrap();
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (upstream_shutdown_tx, upstream_shutdown_rx) = oneshot::channel();
    let (release_tx, _release_rx) = watch::channel(false);
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(controlled_gated_openai_chat_upstream),
        )
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
            release: release_tx.clone(),
        }));
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = upstream_shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let mut manifest = manifest(free_port(), upstream_addr.port());
    manifest.debug.log_file = Some(log_path.to_string_lossy().into_owned());
    let handle =
        spawn_v3_server_aggregate_with_admin(manifest, None, Some(config_path.to_path_buf()))
            .await
            .unwrap();
    ControlledEntry {
        endpoint: format!("http://{}/v1/chat/completions", handle.listeners[0].addr),
        handle,
        captures: captures_rx,
        release: release_tx,
        upstream_shutdown: upstream_shutdown_tx,
    }
}

#[tokio::test]
async fn client_reset_enters_fixed_error_before_cleanup() {
    if std::env::var_os(CLIENT_RED_CHILD_ENV).is_none() {
        // Parent: keep the real HOME. Re-exec this exact test as a child whose
        // Command environment binds the owned fixture HOME and counter file.
        let home = PathBuf::from(CLIENT_RED_HOME);
        std::fs::create_dir_all(&home).expect("create the owned fixture home");
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                CLIENT_RED_TEST_NAME,
                "--test-threads=1",
                "--nocapture",
            ])
            .env(CLIENT_RED_CHILD_ENV, "1")
            .env("HOME", &home)
            .env(
                "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
                home.join("request-id-counter.json"),
            )
            .output()
            .expect("spawn the isolated client-reset child");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[client-red] owned fixture home: {}", home.display());
        eprintln!("[client-red] child stdout:\n{stdout}");
        eprintln!("[client-red] child stderr:\n{stderr}");
        assert!(
            output.status.success(),
            "the isolated client-reset child failed (product red boundary):\n--- child stdout ---\n{stdout}\n--- child stderr ---\n{stderr}"
        );
        return;
    }
    let home = PathBuf::from(std::env::var("HOME").expect("child HOME is the owned fixture home"));
    run_client_red_scenario(&home).await;
}

async fn run_client_red_scenario(home: &Path) {
    let _guard = TEST_LOCK.lock().await;
    let run_dir = home.join("run");
    let log_path = run_dir.join("debug.log");
    let config_path = run_dir.join("config.toml");

    eprintln!(
        "[client-red] child pid {} home {}",
        std::process::id(),
        home.display()
    );
    eprintln!("[client-red] debug log {}", log_path.display());
    eprintln!("[client-red] canonical config {}", config_path.display());

    let mut entry = start_client_red_entry(&run_dir, &log_path, &config_path).await;
    let addr = entry.handle.listeners[0].addr;
    let port = addr.port();
    let records_path = run_dir.join(format!("server-v3-{port}.request-records.jsonl"));
    eprintln!(
        "[client-red] listener {addr} request-records {}",
        records_path.display()
    );
    let client = reqwest::Client::new();

    // (0) Prove the fixture starts and serves a normal public response first.
    // `send_replace` updates the gate even before the provider handler
    // subscribes; `watch::send` would be dropped with no receiver yet.
    entry.release.send_replace(true);
    let warm = client
        .post(&entry.endpoint)
        .json(&json!({
            "model": "chat-client-alias",
            "messages": [{"role": "user", "content": "warm"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        warm.status(),
        StatusCode::OK,
        "the controlled fixture must serve a normal public response"
    );
    assert_eq!(
        warm.json::<Value>().await.unwrap()["id"],
        "chatcmpl-controlled"
    );
    let _warm_capture = tokio::time::timeout(Duration::from_secs(5), entry.captures.recv())
        .await
        .expect("warm provider capture")
        .expect("capture channel");
    // Re-gate the provider for the reset case.
    entry.release.send_replace(false);

    // (1) Raw-TCP public entry with stream:true.
    let mut sock = TcpStream::connect(addr).await.unwrap();
    let body =
        br#"{"model":"chat-client-alias","messages":[{"role":"user","content":"stream"}],"stream":true}"#;
    let head = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    sock.write_all(head.as_bytes()).await.unwrap();
    sock.write_all(body).await.unwrap();
    sock.flush().await.unwrap();

    // (2) Read the committed SSE head and at least one transport keepalive.
    let mut received = Vec::new();
    let head_terminator: &[u8] = b"\r\n\r\n";
    let saw_head_and_keepalive = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let mut buf = [0u8; 512];
            let n = sock.read(&mut buf).await.unwrap();
            if n == 0 {
                return false;
            }
            received.extend_from_slice(&buf[..n]);
            let head_done = received
                .windows(head_terminator.len())
                .any(|window| window == head_terminator);
            let keepalive = received
                .windows(KEEPALIVE_FRAME.len())
                .any(|window| window == KEEPALIVE_FRAME);
            if head_done && keepalive {
                return true;
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        saw_head_and_keepalive,
        "the committed SSE head and a transport keepalive must reach the raw client while the provider is gated"
    );
    let head_text = String::from_utf8_lossy(&received);
    assert!(
        head_text.starts_with("HTTP/1.1 200"),
        "the raw client must observe the committed SSE head: {head_text}"
    );
    assert!(
        head_text.contains("text/event-stream"),
        "the committed head must be an SSE boundary: {head_text}"
    );

    // (3) The provider holds the buffered attempt and stays gated.
    let capture = tokio::time::timeout(Duration::from_secs(5), entry.captures.recv())
        .await
        .expect("the provider must hold the buffered attempt")
        .expect("capture channel");
    assert_eq!(
        capture["stream"],
        json!(true),
        "the buffered provider attempt must be the streaming request"
    );

    // (4) Reset the client connection while the provider is still gated.
    sock.set_linger(Some(Duration::from_secs(0))).unwrap();
    drop(sock);

    // (5) Wait for the server to observe the real reset.
    let observed = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let lines = read_client_red_jsonl(&log_path);
            let saw = lines.iter().any(|line| {
                line.get("event").and_then(Value::as_str) == Some("client_transport")
                    && matches!(
                        line.get("stage").and_then(Value::as_str),
                        Some("http_connection_end")
                            | Some("write_failure")
                            | Some("flush_failure")
                            | Some("socket_closed")
                    )
            });
            if saw {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        observed,
        "the server must observe the real client reset (connection end / write failure)"
    );
    // Let the terminal projection / finalizer settle.
    tokio::time::sleep(Duration::from_millis(750)).await;

    let log_lines = read_client_red_jsonl(&log_path);
    let records = read_client_red_jsonl(&records_path);

    // The reset request id = the last request bound to a client identity line.
    let rid = log_lines
        .iter()
        .rev()
        .find_map(|line| {
            let is_identified = line.get("event").and_then(Value::as_str)
                == Some("client_transport")
                && line.get("stage").and_then(Value::as_str) == Some("request_identified");
            is_identified
                .then(|| {
                    line.get("request_id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .flatten()
        })
        .expect("the reset request must have a client_transport request identity");
    eprintln!("[client-red] reset request id {rid}");

    // Ordered node events bound to the reset request.
    let mut ordered_nodes: Vec<(u64, String)> = log_lines
        .iter()
        .filter_map(|line| {
            let node = line.get("node_id").and_then(Value::as_str)?;
            if line.get("request_id").and_then(Value::as_str) != Some(rid.as_str()) {
                return None;
            }
            let seq = line.get("sequence").and_then(Value::as_u64).unwrap_or(0);
            Some((seq, node.to_string()))
        })
        .collect();
    ordered_nodes.sort_by_key(|(seq, _)| *seq);
    let ordered_ids: Vec<String> = ordered_nodes.into_iter().map(|(_, id)| id).collect();
    eprintln!("[client-red] reset request node ids: {ordered_ids:?}");

    // (6) Corrected independent client-source Error chain, request-bound and ordered.
    let mut chain_first = [usize::MAX; 6];
    for (pos, node) in ordered_ids.iter().enumerate() {
        if let Some(idx) = client_red_chain_index(node) {
            if chain_first[idx] == usize::MAX {
                chain_first[idx] = pos;
            }
        }
    }
    assert!(
        chain_first.iter().all(|p| *p != usize::MAX),
        "the corrected client-source Error chain {CORRECTED_ERROR_CHAIN:?} must be request-bound and complete for {rid}; observed node ids: {ordered_ids:?}"
    );
    assert!(
        chain_first.windows(2).all(|window| window[0] < window[1]),
        "the corrected Error chain nodes must be emitted in order; positions {chain_first:?} from {ordered_ids:?}"
    );

    // (7) Ordered closeout after the Error chain.
    let mut closeout_first = [usize::MAX; CORRECTED_CLOSEOUT.len()];
    for (pos, node) in ordered_ids.iter().enumerate() {
        if let Some(idx) = CORRECTED_CLOSEOUT
            .iter()
            .position(|candidate| candidate == node)
        {
            if closeout_first[idx] == usize::MAX {
                closeout_first[idx] = pos;
            }
        }
    }
    assert!(
        closeout_first.iter().all(|p| *p != usize::MAX),
        "the corrected closeout {CORRECTED_CLOSEOUT:?} must be request-bound for {rid}; observed node ids: {ordered_ids:?}"
    );
    assert!(
        closeout_first.windows(2).all(|window| window[0] < window[1]),
        "the corrected closeout must run in order; positions {closeout_first:?} from {ordered_ids:?}"
    );
    assert!(
        *chain_first.iter().max().unwrap() < *closeout_first.iter().min().unwrap(),
        "the independent Error chain must complete before the transport outcome/closeout; chain {chain_first:?} closeout {closeout_first:?}"
    );

    // (8) The client failure must not mutate provider health.
    assert!(
        entry.captures.try_recv().is_err(),
        "a client-transport failure must not start a second provider attempt"
    );
    assert!(
        !records.iter().any(|row| {
            row.get("event_type").and_then(Value::as_str) == Some("request.provider_switched")
        }),
        "a client-transport failure must not switch provider"
    );
    let pool: Value = client
        .get(format!("http://{addr}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        pool.get("entries")
            .and_then(Value::as_array)
            .map(|entries| entries.is_empty())
            .unwrap_or(false),
        "a client-transport failure must not cool or exclude any provider identity: {pool}"
    );

    // (9) Release the provider; a later request still succeeds.
    entry.release.send_replace(true);
    let fresh = client
        .post(&entry.endpoint)
        .json(&json!({
            "model": "chat-client-alias",
            "messages": [{"role": "user", "content": "fresh"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        fresh.status(),
        StatusCode::OK,
        "a later request must still succeed after the client reset"
    );
    assert_eq!(
        fresh.json::<Value>().await.unwrap()["choices"][0]["message"]["content"],
        "controlled json"
    );

    stop_controlled_entry(entry).await;
    let _ = std::fs::remove_dir_all(home);
}

// ===========================================================================
// public_entry_client_body_cancellation_without_io_enters_error_before_finalizer
// (public-entry committed client-body Drop with no captured socket I/O)
//
// Same controlled harness as `client_reset_enters_fixed_error_before_cleanup`,
// but the raw client half-closes only its write direction (a graceful FIN, not
// an RST) once the committed SSE head and a transport keepalive reached it. The
// read half stays open, so the server observes a clean EOF and no keepalive
// write fails: no Server socket I/O cause is captured, and the committed
// channel's premature body Drop is the only failure evidence.
//
// The committed body Drop must run the same fixed client-source Error chain
// (ErrorErr01..ErrorErr06), publish the typed internal abort, close the socket,
// drain the bound runtime task and finalize the request -- with no Provider
// attempt, switch, exclusion or cooldown, and no client error / end / success
// bytes. A later request must still succeed.
//
// Isolation: identical to the reset case. The parent keeps the real HOME and
// re-executes this exact test as a child bound to an owned fixture HOME.
// ===========================================================================

const CLIENT_BODY_CANCEL_CHILD_ENV: &str = "V3_CLIENT_BODY_CANCEL_ISOLATED_CHILD";
const CLIENT_BODY_CANCEL_TEST_NAME: &str =
    "public_entry_client_body_cancellation_without_io_enters_error_before_finalizer";

/// Socket-observation stages that prove a real Server I/O failure was captured.
/// A graceful client FIN must not produce any of these.
const CLIENT_IO_FAILURE_STAGES: [&str; 4] =
    ["write_failure", "flush_failure", "peer_reset", "read_error"];

#[tokio::test]
async fn public_entry_client_body_cancellation_without_io_enters_error_before_finalizer() {
    if std::env::var_os(CLIENT_BODY_CANCEL_CHILD_ENV).is_none() {
        // Parent: keep the real HOME. Re-exec this exact test as a child whose
        // Command environment binds an owned fixture HOME under this worktree's
        // build-control temp root.
        let run_id = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        );
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("build-control")
            .join("temp")
            .join("runtime-error-fixture-home")
            .join("client")
            .join(format!("client-body-cancel-{run_id}"));
        std::fs::create_dir_all(&home).expect("create the owned fixture home");
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                CLIENT_BODY_CANCEL_TEST_NAME,
                "--test-threads=1",
                "--nocapture",
            ])
            .env(CLIENT_BODY_CANCEL_CHILD_ENV, "1")
            .env("HOME", &home)
            .env(
                "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
                home.join("request-id-counter.json"),
            )
            .output()
            .expect("spawn the isolated client-body-cancel child");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[client-body-cancel] owned fixture home: {}", home.display());
        eprintln!("[client-body-cancel] child stdout:\n{stdout}");
        eprintln!("[client-body-cancel] child stderr:\n{stderr}");
        assert!(
            output.status.success(),
            "the isolated client-body-cancel child failed:\n--- child stdout ---\n{stdout}\n--- child stderr ---\n{stderr}"
        );
        return;
    }
    let home = PathBuf::from(std::env::var("HOME").expect("child HOME is the owned fixture home"));
    run_client_body_cancel_scenario(&home).await;
}

async fn run_client_body_cancel_scenario(home: &Path) {
    let _guard = TEST_LOCK.lock().await;
    let run_dir = home.join("run");
    let log_path = run_dir.join("debug.log");
    let config_path = run_dir.join("config.toml");

    eprintln!(
        "[client-body-cancel] child pid {} home {}",
        std::process::id(),
        home.display()
    );

    let mut entry = start_client_red_entry(&run_dir, &log_path, &config_path).await;
    let addr = entry.handle.listeners[0].addr;
    let port = addr.port();
    let records_path = run_dir.join(format!("server-v3-{port}.request-records.jsonl"));
    let client = reqwest::Client::new();

    // (0) Prove the fixture serves a normal public response, then re-gate.
    entry.release.send_replace(true);
    let warm = client
        .post(&entry.endpoint)
        .json(&json!({
            "model": "chat-client-alias",
            "messages": [{"role": "user", "content": "warm"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        warm.status(),
        StatusCode::OK,
        "the controlled fixture must serve a normal public response"
    );
    assert_eq!(
        warm.json::<Value>().await.unwrap()["id"],
        "chatcmpl-controlled"
    );
    let _warm_capture = tokio::time::timeout(Duration::from_secs(5), entry.captures.recv())
        .await
        .expect("warm provider capture")
        .expect("capture channel");
    entry.release.send_replace(false);

    // (1) Raw-TCP public entry with stream:true.
    let mut sock = TcpStream::connect(addr).await.unwrap();
    let body =
        br#"{"model":"chat-client-alias","messages":[{"role":"user","content":"stream"}],"stream":true}"#;
    let head = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    sock.write_all(head.as_bytes()).await.unwrap();
    sock.write_all(body).await.unwrap();
    sock.flush().await.unwrap();

    // (2) Read the committed SSE head and at least one transport keepalive.
    let mut received = Vec::new();
    let head_terminator: &[u8] = b"\r\n\r\n";
    let saw_head_and_keepalive = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let mut buf = [0u8; 512];
            let n = sock.read(&mut buf).await.unwrap();
            if n == 0 {
                return false;
            }
            received.extend_from_slice(&buf[..n]);
            let head_done = received
                .windows(head_terminator.len())
                .any(|window| window == head_terminator);
            let keepalive = received
                .windows(KEEPALIVE_FRAME.len())
                .any(|window| window == KEEPALIVE_FRAME);
            if head_done && keepalive {
                return true;
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        saw_head_and_keepalive,
        "the committed SSE head and a transport keepalive must reach the raw client while the provider is gated"
    );
    let head_text = String::from_utf8_lossy(&received);
    assert!(
        head_text.starts_with("HTTP/1.1 200"),
        "the raw client must observe the committed SSE head: {head_text}"
    );
    assert!(
        head_text.contains("text/event-stream"),
        "the committed head must be an SSE boundary: {head_text}"
    );

    // (3) The provider holds the buffered attempt and stays gated.
    let capture = tokio::time::timeout(Duration::from_secs(5), entry.captures.recv())
        .await
        .expect("the provider must hold the buffered attempt")
        .expect("capture channel");
    assert_eq!(
        capture["stream"],
        json!(true),
        "the buffered provider attempt must be the streaming request"
    );

    // (4) Graceful client FIN: half-close only the write direction. The read
    // half stays open so the server observes a clean EOF (not an RST) and no
    // keepalive write fails -- no Server I/O cause is captured.
    let std_sock = sock
        .into_std()
        .expect("convert the raw client socket for a write half-close");
    std_sock
        .shutdown(std::net::Shutdown::Write)
        .expect("half-close the raw client write direction");
    let mut sock = TcpStream::from_std(std_sock)
        .expect("restore the async client socket after the write half-close");

    // (5) Keep the read half open and read the committed response to EOF.
    let initial_body_offset = received
        .windows(KEEPALIVE_FRAME.len())
        .position(|window| window == KEEPALIVE_FRAME)
        .expect("the initial transport keepalive must be present")
        + KEEPALIVE_FRAME.len();
    let mut terminal = Vec::new();
    let read_result =
        tokio::time::timeout(Duration::from_secs(8), sock.read_to_end(&mut terminal)).await;
    assert!(
        read_result.is_ok(),
        "the committed response must reach EOF after the client write half-close"
    );
    read_result
        .unwrap()
        .expect("read the committed response to EOF");
    received.extend_from_slice(&terminal);
    let after_initial = &received[initial_body_offset..];
    let after_initial_text = String::from_utf8_lossy(after_initial);
    for (label, needle) in [
        ("SSE data/error payload", "data:"),
        ("SSE error event", "event: error"),
        ("error payload", "\"error\""),
        ("terminal marker", "[DONE]"),
        ("success completion", "\"choices\""),
        ("success completion", "\"finish_reason\""),
        ("fabricated business response", "chat.completion"),
        ("fabricated business response", "{"),
    ] {
        assert!(
            !after_initial_text.contains(needle),
            "post-FIN bytes must not contain {label} ({needle:?}); received: {after_initial_text:?}"
        );
    }

    // (6) Wait for the server to observe the graceful connection end.
    let observed = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let lines = read_client_red_jsonl(&log_path);
            let saw = lines.iter().any(|line| {
                line.get("event").and_then(Value::as_str) == Some("client_transport")
                    && matches!(
                        line.get("stage").and_then(Value::as_str),
                        Some("http_connection_end") | Some("socket_closed")
                    )
            });
            if saw {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        observed,
        "the server must observe the graceful client FIN (connection end / socket close)"
    );
    // Let the terminal projection / finalizer settle.
    tokio::time::sleep(Duration::from_millis(750)).await;

    let log_lines = read_client_red_jsonl(&log_path);
    let records = read_client_red_jsonl(&records_path);

    // (7) No socket I/O failure may be captured: the committed body Drop with no
    // I/O cause is the only failure evidence for this request.
    let io_failures: Vec<String> = log_lines
        .iter()
        .filter_map(|line| {
            let is_client_transport =
                line.get("event").and_then(Value::as_str) == Some("client_transport");
            let stage = line.get("stage").and_then(Value::as_str)?;
            (is_client_transport && CLIENT_IO_FAILURE_STAGES.contains(&stage))
                .then(|| stage.to_string())
        })
        .collect();
    assert!(
        io_failures.is_empty(),
        "a graceful client FIN must not be captured as a socket I/O failure (write/flush/peer_reset/read_error): {io_failures:?}"
    );

    // The request id = the last request bound to a client identity line.
    let rid = log_lines
        .iter()
        .rev()
        .find_map(|line| {
            let is_identified = line.get("event").and_then(Value::as_str)
                == Some("client_transport")
                && line.get("stage").and_then(Value::as_str) == Some("request_identified");
            is_identified
                .then(|| {
                    line.get("request_id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .flatten()
        })
        .expect("the cancellation request must have a client_transport request identity");
    eprintln!("[client-body-cancel] request id {rid}");

    // Ordered node events bound to the request.
    let mut ordered_nodes: Vec<(u64, String)> = log_lines
        .iter()
        .filter_map(|line| {
            let node = line.get("node_id").and_then(Value::as_str)?;
            if line.get("request_id").and_then(Value::as_str) != Some(rid.as_str()) {
                return None;
            }
            let seq = line.get("sequence").and_then(Value::as_u64).unwrap_or(0);
            Some((seq, node.to_string()))
        })
        .collect();
    ordered_nodes.sort_by_key(|(seq, _)| *seq);
    let ordered_ids: Vec<String> = ordered_nodes.into_iter().map(|(_, id)| id).collect();
    eprintln!("[client-body-cancel] request node ids: {ordered_ids:?}");

    // (8) The committed body Drop must run the same six request-bound Error nodes.
    let mut chain_first = [usize::MAX; 6];
    for (pos, node) in ordered_ids.iter().enumerate() {
        if let Some(idx) = client_red_chain_index(node) {
            if chain_first[idx] == usize::MAX {
                chain_first[idx] = pos;
            }
        }
    }
    assert!(
        chain_first.iter().all(|p| *p != usize::MAX),
        "the client-source Error chain {CORRECTED_ERROR_CHAIN:?} must be request-bound and complete for {rid}; observed node ids: {ordered_ids:?}"
    );
    assert!(
        chain_first.windows(2).all(|window| window[0] < window[1]),
        "the client-source Error chain nodes must be emitted in order; positions {chain_first:?} from {ordered_ids:?}"
    );

    // (9) The ordered closeout must follow the Error chain.
    let mut closeout_first = [usize::MAX; CORRECTED_CLOSEOUT.len()];
    for (pos, node) in ordered_ids.iter().enumerate() {
        if let Some(idx) = CORRECTED_CLOSEOUT
            .iter()
            .position(|candidate| candidate == node)
        {
            if closeout_first[idx] == usize::MAX {
                closeout_first[idx] = pos;
            }
        }
    }
    assert!(
        closeout_first.iter().all(|p| *p != usize::MAX),
        "the closeout {CORRECTED_CLOSEOUT:?} must be request-bound for {rid}; observed node ids: {ordered_ids:?}"
    );
    assert!(
        closeout_first.windows(2).all(|window| window[0] < window[1]),
        "the closeout must run in order; positions {closeout_first:?} from {ordered_ids:?}"
    );
    assert!(
        *chain_first.iter().max().unwrap() < *closeout_first.iter().min().unwrap(),
        "the client-source Error chain must complete before the transport outcome/closeout; chain {chain_first:?} closeout {closeout_first:?}"
    );

    // (10) The cancellation must not mutate provider health or start a provider.
    assert!(
        entry.captures.try_recv().is_err(),
        "a client body cancellation must not start a second provider attempt"
    );
    assert!(
        !records.iter().any(|row| {
            row.get("event_type").and_then(Value::as_str) == Some("request.provider_switched")
        }),
        "a client body cancellation must not switch provider"
    );
    let pool: Value = client
        .get(format!("http://{addr}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        pool.get("entries")
            .and_then(Value::as_array)
            .map(|entries| entries.is_empty())
            .unwrap_or(false),
        "a client body cancellation must not cool or exclude any provider identity: {pool}"
    );

    // (11) Release the provider; a later request still succeeds.
    entry.release.send_replace(true);
    let fresh = client
        .post(&entry.endpoint)
        .json(&json!({
            "model": "chat-client-alias",
            "messages": [{"role": "user", "content": "fresh"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        fresh.status(),
        StatusCode::OK,
        "a later request must still succeed after the client body cancellation"
    );
    assert_eq!(
        fresh.json::<Value>().await.unwrap()["choices"][0]["message"]["content"],
        "controlled json"
    );

    stop_controlled_entry(entry).await;
    // This path is unique per invocation; the child owns and removes only it.
    let _ = std::fs::remove_dir_all(home);
}
