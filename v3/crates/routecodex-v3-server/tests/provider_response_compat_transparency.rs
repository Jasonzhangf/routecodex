//! Public HTTP/SSE regression boundary for bug `b9db8b1`.
//!
//! Contract: a provider successful business response is faithful. Provider
//! response compatibility is a *mechanical* projection only (registered
//! provider-family wire mapping and configured whitelist/blacklist execution).
//! It must never adjudicate model text: no diagnostic-looking-text detection,
//! no fabricated empty completion, and no rejection of a forwardable
//! model-authored tool marker. A forwardable provider response must reach the
//! client exactly once with its original business text and fields, must not
//! cool the provider key, and must not reselect a sibling candidate.
//!
//! These tests enter through the real aggregate server public entry
//! (`/v1/responses`) with an explicit Relay binding and actual compiled
//! provider compatibility profiles (`responses:cc`, `chat:minimax`). The
//! upstream fixture counts attempts per provider so an extra reselect is
//! directly observable.

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::stream;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{ffi::OsString, fs, io, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

// Aggregate servers resolve process-level runtime paths (HOME, request-id
// counter). Serialize the environment mutations for this test binary and
// restore/remove the temp paths on drop.
static TEST_LOCK: Mutex<()> = Mutex::const_new(());

struct IsolatedRuntimeEnvironment {
    previous_home: Option<OsString>,
    previous_counter: Option<OsString>,
    home: PathBuf,
}

impl IsolatedRuntimeEnvironment {
    fn new(label: &str) -> Self {
        let home = std::env::temp_dir().join(format!(
            "routecodex-v3-server-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        let counter = home.join("request-id-counter.json");
        let previous_home = std::env::var_os("HOME");
        let previous_counter = std::env::var_os("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
        std::env::set_var("HOME", &home);
        std::env::set_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE", &counter);
        Self {
            previous_home,
            previous_counter,
            home,
        }
    }
}

impl Drop for IsolatedRuntimeEnvironment {
    fn drop(&mut self) {
        match &self.previous_home {
            Some(previous) => std::env::set_var("HOME", previous),
            None => std::env::remove_var("HOME"),
        }
        match &self.previous_counter {
            Some(previous) => std::env::set_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE", previous),
            None => std::env::remove_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE"),
        }
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[derive(Debug)]
struct ProviderCapture {
    body: Value,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
    body: Arc<ProviderBody>,
}

#[derive(Debug)]
enum ProviderBody {
    Json { status: u16, bytes: Vec<u8> },
    Sse { chunks: Vec<Vec<u8>> },
}

async fn controlled_upstream(
    State(state): State<Arc<ProviderState>>,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture { body: body.clone() })
        .unwrap();
    match state.body.as_ref() {
        ProviderBody::Json { status, bytes } => Response::builder()
            .status(StatusCode::from_u16(*status).unwrap())
            .header("content-type", "application/json")
            .body(Body::from(bytes.clone()))
            .unwrap(),
        ProviderBody::Sse { chunks } => {
            let items: Vec<Result<Bytes, io::Error>> = chunks
                .iter()
                .cloned()
                .map(|chunk| Ok(Bytes::from(chunk)))
                .collect();
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(stream::iter(items)))
                .unwrap()
        }
    }
}

async fn start_upstream(
    body: ProviderBody,
) -> (
    u16,
    mpsc::UnboundedReceiver<ProviderCapture>,
    oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
            body: Arc::new(body),
        }));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (port, captures_rx, shutdown_tx)
}

/// Two-candidate manifest on the `/v1/responses` entry. `profile` is the
/// compiled provider compatibility profile under test; both candidates share it
/// so the only difference between primary and fallback is attempt ordering.
/// `responses = { process = "chat" }` forces the Runtime to select Hub Relay for
/// this same-protocol Responses target. Relay is the mode that reaches the
/// shared provider response compat owner (`run_resp_inbound_stage3_compat`);
/// Direct selects the local `ThinkingTags`/no-op block for these `responses:*`
/// profiles and never reaches that owner.
fn two_candidate_manifest(
    server_port: u16,
    primary_port: u16,
    fallback_port: u16,
    profile: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.compat]
bind = "127.0.0.1"
port = {server_port}
routing_group = "compat"
endpoints = ["responses"]

{server_execution}

[providers.primary]
type = "responses"
responses = {{ process = "chat", streaming = "client" }}
base_url = "http://127.0.0.1:{primary_port}/v1"
default_model = "wire-model"
compatibility_profile = "{profile}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COMPAT_TRANSPARENCY_KEY" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.primary.models.wire-model]
wire_name = "wire-model"
aliases = ["client-responses"]
supports_streaming = true
capabilities = ["text", "tools"]
max_context_tokens = 128000

[providers.fallback]
type = "responses"
responses = {{ process = "chat", streaming = "client" }}
base_url = "http://127.0.0.1:{fallback_port}/v1"
default_model = "wire-model"
compatibility_profile = "{profile}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COMPAT_TRANSPARENCY_KEY" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.fallback.models.wire-model]
wire_name = "wire-model"
aliases = ["client-responses"]
supports_streaming = true
capabilities = ["text", "tools"]
max_context_tokens = 128000

[route_groups.compat.pools.client_entry]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-responses"] }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "wire-model", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "fallback", model = "wire-model", key = "key", priority = 1 }}
]
[route_groups.compat.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "wire-model", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "fallback", model = "wire-model", key = "key", priority = 1 }}
]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("compat"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

/// A provider Responses document that carries the CC diagnostic routing marker
/// verbatim in a normal assistant message.
fn cc_diagnostic_body() -> Value {
    json!({
        "id": "resp_cc_primary",
        "object": "response",
        "status": "completed",
        "model": "wire-model",
        "output": [{
            "type": "message",
            "id": "msg_cc_primary",
            "role": "assistant",
            "content": [{
                "type": "output_text",
                "text": "检测到请求较复杂已自动路由到硬推理模型\n继续执行用户请求",
                "annotations": []
            }]
        }],
        "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
        "metadata": {"client_visible": "kept"}
    })
}

/// A provider Responses document whose assistant text contains a malformed
/// model-authored tool envelope. It is forwardable model business text.
fn minimax_malformed_body() -> Value {
    json!({
        "id": "resp_minimax_primary",
        "object": "response",
        "status": "completed",
        "model": "wire-model",
        "output": [{
            "type": "message",
            "id": "msg_minimax_primary",
            "role": "assistant",
            "content": [{
                "type": "output_text",
                "text": "<get_goal></invoke></tool_call>",
                "annotations": []
            }]
        }],
        "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
        "metadata": {"client_visible": "kept"}
    })
}

fn responses_sse_completed(text: &str) -> Vec<u8> {
    format!(
        "data: {{\"type\":\"response.created\",\"response\":{{\"id\":\"resp_primary\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"wire-model\",\"output\":[]}}}}\n\n\
         data: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_primary\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"wire-model\",\"output\":[{{\"type\":\"message\",\"id\":\"msg_primary\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"{text}\"}}]}}]}}}}\n\n"
    )
    .into_bytes()
}

async fn assert_listener_closed(addr: std::net::SocketAddr) {
    let closed =
        tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(addr)).await;
    match closed {
        Ok(Ok(_)) => panic!("listener {addr} must be closed after shutdown"),
        Ok(Err(_)) | Err(_) => {}
    }
}

/// Independent next request: because a faithful forward must not cool the
/// provider key, the primary candidate must still be attempted first.
async fn assert_primary_remains_first(
    client: &reqwest::Client,
    endpoint: &str,
    primary_captures: &mut mpsc::UnboundedReceiver<ProviderCapture>,
    fallback_captures: &mut mpsc::UnboundedReceiver<ProviderCapture>,
) {
    let follow_up = client
        .post(endpoint)
        .json(&json!({"model":"client-responses","input":"again"}))
        .send()
        .await
        .unwrap();
    assert!(
        follow_up.status().is_success(),
        "the follow-up request must succeed, got {}",
        follow_up.status()
    );
    let _ = follow_up.bytes().await.unwrap();
    let capture = primary_captures
        .recv()
        .await
        .expect("the primary key must remain available after a faithful forward");
    assert!(
        capture.body.is_object(),
        "the primary provider fixture must receive the follow-up request body"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(300), fallback_captures.recv())
            .await
            .is_err(),
        "the primary key must not be cooled, so the fallback must never be used"
    );
}

fn assert_no_error_payload(body: &str) {
    assert!(
        !body.contains("\"error\"")
            && !body.contains("response.failed")
            && !body.contains("event: error"),
        "a forwardable provider response must not project any client error: {body}"
    );
}

#[tokio::test]
async fn cc_diagnostic_text_json_is_forwarded_without_fabricated_completion() {
    let _guard = TEST_LOCK.lock().await;
    let _environment = IsolatedRuntimeEnvironment::new("compat-cc-json");
    std::env::set_var("V3_COMPAT_TRANSPARENCY_KEY", "compat-secret");
    let (primary_port, mut primary_captures, primary_shutdown) =
        start_upstream(ProviderBody::Json {
            status: 200,
            bytes: serde_json::to_vec(&cc_diagnostic_body()).unwrap(),
        })
        .await;
    let (fallback_port, mut fallback_captures, fallback_shutdown) =
        start_upstream(ProviderBody::Json {
            status: 200,
            bytes: serde_json::to_vec(&cc_diagnostic_body()).unwrap(),
        })
        .await;

    let handle = spawn_v3_server_aggregate(two_candidate_manifest(
        free_port(),
        primary_port,
        fallback_port,
        "responses:cc",
    ))
    .await
    .unwrap();
    let server_addr = handle.listeners[0].addr;
    let endpoint = format!("http://{server_addr}/v1/responses");
    let client = reqwest::Client::new();

    let response = client
        .post(&endpoint)
        .json(&json!({"model":"client-responses","input":"hello"}))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let body: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);

    assert!(
        primary_captures.recv().await.is_some(),
        "the primary candidate must receive the request"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(300), fallback_captures.recv())
            .await
            .is_err(),
        "a forwardable provider response must not trigger reselection"
    );
    assert!(
        status.is_success(),
        "provider success must project as client success, got {status}: {raw}"
    );
    assert_no_error_payload(&raw);
    assert_eq!(
        body.pointer("/output/0/content/0/text")
            .and_then(Value::as_str),
        Some("检测到请求较复杂已自动路由到硬推理模型\n继续执行用户请求"),
        "the provider's own diagnostic-looking business text must be preserved verbatim: {raw}"
    );
    assert_eq!(
        body.pointer("/metadata/client_visible")
            .and_then(Value::as_str),
        Some("kept"),
        "ordinary business fields must survive provider response compatibility: {raw}"
    );
    assert_ne!(
        body.get("status").and_then(Value::as_str),
        Some("completed").filter(|_| {
            body.get("output")
                .and_then(Value::as_array)
                .is_some_and(|output| output.is_empty())
        }),
        "provider compatibility must not fabricate an empty completion: {raw}"
    );

    assert_primary_remains_first(
        &client,
        &endpoint,
        &mut primary_captures,
        &mut fallback_captures,
    )
    .await;

    handle.shutdown().await;
    let _ = primary_shutdown.send(());
    let _ = fallback_shutdown.send(());
    assert_listener_closed(server_addr).await;
    std::env::remove_var("V3_COMPAT_TRANSPARENCY_KEY");
}

#[tokio::test]
async fn cc_diagnostic_text_sse_is_forwarded_without_fabricated_completion() {
    let _guard = TEST_LOCK.lock().await;
    let _environment = IsolatedRuntimeEnvironment::new("compat-cc-sse");
    std::env::set_var("V3_COMPAT_TRANSPARENCY_KEY", "compat-secret");
    let (primary_port, mut primary_captures, primary_shutdown) =
        start_upstream(ProviderBody::Sse {
            chunks: vec![responses_sse_completed(
                "检测到请求较复杂已自动路由到硬推理模型\\n继续执行用户请求",
            )],
        })
        .await;
    let (fallback_port, mut fallback_captures, fallback_shutdown) =
        start_upstream(ProviderBody::Sse {
            chunks: vec![responses_sse_completed("fallback answered")],
        })
        .await;

    let handle = spawn_v3_server_aggregate(two_candidate_manifest(
        free_port(),
        primary_port,
        fallback_port,
        "responses:cc",
    ))
    .await
    .unwrap();
    let server_addr = handle.listeners[0].addr;
    let endpoint = format!("http://{server_addr}/v1/responses");
    let client = reqwest::Client::new();

    let response = client
        .post(&endpoint)
        .json(&json!({"model":"client-responses","input":"hello","stream":true}))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();

    assert!(
        primary_captures.recv().await.is_some(),
        "the primary candidate must receive the request"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(300), fallback_captures.recv())
            .await
            .is_err(),
        "a forwardable provider SSE response must not trigger reselection"
    );
    assert!(
        status.is_success(),
        "provider SSE success must project as client success, got {status}: {raw}"
    );
    assert_no_error_payload(&raw);
    assert!(
        raw.contains("检测到请求较复杂已自动路由到硬推理模型"),
        "the provider's own diagnostic-looking business text must be preserved verbatim: {raw}"
    );
    assert!(
        raw.contains("继续执行用户请求"),
        "the full provider business text must be preserved verbatim: {raw}"
    );

    handle.shutdown().await;
    let _ = primary_shutdown.send(());
    let _ = fallback_shutdown.send(());
    assert_listener_closed(server_addr).await;
    std::env::remove_var("V3_COMPAT_TRANSPARENCY_KEY");
}

#[tokio::test]
async fn minimax_malformed_tool_marker_json_is_forwarded_once_without_reselect() {
    let _guard = TEST_LOCK.lock().await;
    let _environment = IsolatedRuntimeEnvironment::new("compat-minimax-json");
    std::env::set_var("V3_COMPAT_TRANSPARENCY_KEY", "compat-secret");
    let (primary_port, mut primary_captures, primary_shutdown) =
        start_upstream(ProviderBody::Json {
            status: 200,
            bytes: serde_json::to_vec(&minimax_malformed_body()).unwrap(),
        })
        .await;
    let (fallback_port, mut fallback_captures, fallback_shutdown) =
        start_upstream(ProviderBody::Json {
            status: 200,
            bytes: serde_json::to_vec(&json!({
                "id": "resp_fallback",
                "object": "response",
                "status": "completed",
                "model": "wire-model",
                "output": [{
                    "type": "message",
                    "id": "msg_fallback",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "fallback answered"}]
                }]
            }))
            .unwrap(),
        })
        .await;

    let handle = spawn_v3_server_aggregate(two_candidate_manifest(
        free_port(),
        primary_port,
        fallback_port,
        "chat:minimax",
    ))
    .await
    .unwrap();
    let server_addr = handle.listeners[0].addr;
    let endpoint = format!("http://{server_addr}/v1/responses");
    let client = reqwest::Client::new();

    let response = client
        .post(&endpoint)
        .json(&json!({"model":"client-responses","input":"hello"}))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let body: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);

    assert!(
        primary_captures.recv().await.is_some(),
        "the primary candidate must receive the request"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(300), fallback_captures.recv())
            .await
            .is_err(),
        "a forwardable malformed model tool marker must not trigger reselection"
    );
    assert!(
        status.is_success(),
        "provider success must project as client success, got {status}: {raw}"
    );
    assert_no_error_payload(&raw);
    assert_eq!(
        body.pointer("/output/0/content/0/text")
            .and_then(Value::as_str),
        Some("<get_goal></invoke></tool_call>"),
        "the model's own malformed tool marker text must be forwarded unchanged: {raw}"
    );
    assert_eq!(
        body.pointer("/metadata/client_visible")
            .and_then(Value::as_str),
        Some("kept"),
        "ordinary business fields must survive provider response compatibility: {raw}"
    );

    assert_primary_remains_first(
        &client,
        &endpoint,
        &mut primary_captures,
        &mut fallback_captures,
    )
    .await;

    handle.shutdown().await;
    let _ = primary_shutdown.send(());
    let _ = fallback_shutdown.send(());
    assert_listener_closed(server_addr).await;
    std::env::remove_var("V3_COMPAT_TRANSPARENCY_KEY");
}

#[tokio::test]
async fn minimax_malformed_tool_marker_sse_is_forwarded_once_without_reselect() {
    let _guard = TEST_LOCK.lock().await;
    let _environment = IsolatedRuntimeEnvironment::new("compat-minimax-sse");
    std::env::set_var("V3_COMPAT_TRANSPARENCY_KEY", "compat-secret");
    let (primary_port, mut primary_captures, primary_shutdown) =
        start_upstream(ProviderBody::Sse {
            chunks: vec![responses_sse_completed("<get_goal></invoke></tool_call>")],
        })
        .await;
    let (fallback_port, mut fallback_captures, fallback_shutdown) =
        start_upstream(ProviderBody::Sse {
            chunks: vec![responses_sse_completed("fallback answered")],
        })
        .await;

    let handle = spawn_v3_server_aggregate(two_candidate_manifest(
        free_port(),
        primary_port,
        fallback_port,
        "chat:minimax",
    ))
    .await
    .unwrap();
    let server_addr = handle.listeners[0].addr;
    let endpoint = format!("http://{server_addr}/v1/responses");
    let client = reqwest::Client::new();

    let response = client
        .post(&endpoint)
        .json(&json!({"model":"client-responses","input":"hello","stream":true}))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();

    assert!(
        primary_captures.recv().await.is_some(),
        "the primary candidate must receive the request"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(300), fallback_captures.recv())
            .await
            .is_err(),
        "a forwardable malformed model tool marker must not trigger reselection"
    );
    assert!(
        status.is_success(),
        "provider SSE success must project as client success, got {status}: {raw}"
    );
    assert_no_error_payload(&raw);
    assert!(
        raw.contains("<get_goal></invoke></tool_call>"),
        "the model's own malformed tool marker text must be forwarded unchanged: {raw}"
    );

    handle.shutdown().await;
    let _ = primary_shutdown.send(());
    let _ = fallback_shutdown.send(());
    assert_listener_closed(server_addr).await;
    std::env::remove_var("V3_COMPAT_TRANSPARENCY_KEY");
}
