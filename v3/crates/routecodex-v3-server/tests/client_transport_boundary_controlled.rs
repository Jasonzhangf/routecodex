//! Public-entry black-box behavior for the client-facing transport boundary.
//!
//! Test IDs (run with
//! `cargo test -p routecodex-v3-server --test client_transport_boundary_controlled`):
//! - `chat_sse_head_commit_keeps_the_client_transport_live_while_the_provider_stalls`
//! - `chat_json_client_still_waits_for_the_runtime_outcome`
//! - `chat_sse_head_commit_never_projects_a_provider_terminal_to_the_client`
//! - `chat_sse_head_commit_carries_a_json_success_for_an_sse_client`
//! - `exec_preparation_drains_an_in_flight_client_response_before_closing_transports`
//! - `exec_preparation_is_bounded_when_a_provider_attempt_never_finishes`
//!
//! Every case enters through the real `/v1/chat/completions` listener with a
//! controlled provider. The controlled provider holds its response until the test
//! releases it, so a client that observes the SSE head before the release proves
//! the head was committed while the provider attempt was still buffered.
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use axum::body::Body;
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
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
    let handle = spawn_v3_server_aggregate(manifest(free_port(), upstream_addr.port()))
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

/// The drain must stay bounded. A provider attempt that never finishes must not
/// hold the exec replacement open, and the client transport is closed then.
#[tokio::test]
async fn exec_preparation_is_bounded_when_a_provider_attempt_never_finishes() {
    let _guard = TEST_LOCK.lock().await;
    let ControlledEntry {
        endpoint,
        handle,
        mut captures,
        release: _release,
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
        elapsed >= Duration::from_secs(4) && elapsed < Duration::from_secs(15),
        "exec preparation must drain for a bounded window, waited {elapsed:?}"
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
