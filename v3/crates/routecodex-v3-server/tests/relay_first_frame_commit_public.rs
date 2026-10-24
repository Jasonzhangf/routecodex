//! Public-entry regression for the Responses Relay first-frame commit gate.
//!
//! A real HTTP listener and raw client socket prove the first business frame
//! crosses the client SSE channel while the OpenAI Chat provider stream is
//! still open, before the provider terminal arrives.

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
const PROVIDER_KEY_ENV: &str = "RELAY_FIRST_FRAME_PUBLIC_KEY";

fn chat_delta(text: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl_relay_public",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "wire-relay",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}}]
        })
    )
}

fn chat_stop() -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl_relay_public",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "wire-relay",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]
        })
    )
}

async fn upstream(
    State(captures): State<mpsc::UnboundedSender<Value>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let _ = captures.send(body);
    let frames = vec![
        chat_delta("early-progressive-text"),
        chat_stop(),
        "data: [DONE]\n\n".to_string(),
    ];
    // Hold every frame after the first 500ms apart, so the first delta can only
    // reach the client before the terminal if the Relay gate projects it during
    // the provider hold.
    let stream = stream::unfold(
        (frames.into_iter(), 0usize),
        |(mut frames, index)| async move {
            let frame = match frames.next() {
                Some(frame) => frame,
                None => return None,
            };
            if index > 0 {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Some((Ok::<_, Infallible>(Bytes::from(frame)), (frames, index + 1)))
        },
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(stream))
        .unwrap()
}

struct Entry {
    handle: V3ServerAggregateHandle,
    shutdown: oneshot::Sender<()>,
    peer: tokio::task::JoinHandle<()>,
}

impl Entry {
    async fn stop(self) {
        assert!(self.handle.shutdown().await.is_empty());
        let _ = self.shutdown.send(());
        timeout(Duration::from_secs(10), self.peer)
            .await
            .unwrap()
            .unwrap();
        std::env::remove_var(PROVIDER_KEY_ENV);
    }
}

async fn start() -> Entry {
    std::env::set_var(PROVIDER_KEY_ENV, "owned-fixture-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = listener.local_addr().unwrap();
    let (shutdown, stop) = oneshot::channel();
    let (captures, _received) = mpsc::unbounded_channel();
    let peer = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/chat/completions", post(upstream))
                .with_state(captures),
        )
        .with_graceful_shutdown(async {
            let _ = stop.await;
        })
        .await
        .unwrap();
    });

    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let declaration =
        hub_v1_fixture::hub_v1_test_declaration().replace(direct_binding, relay_binding);
    let execution = format!(
        "{}\nattempt_store = {{ residence_timeout_ms = 5000 }}\n",
        hub_v1_fixture::hub_v1_server_execution("owned")
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
[providers.relay]
type = "openai_chat"
base_url = "http://{upstream_addr}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}
request_timeout_ms = 5000
sse_first_frame_timeout_ms = 5000
[providers.relay.models.test]
wire_name = "wire-relay"
capabilities = ["text"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "relay", model = "test", key = "controlled", priority = 1 }}]
[debug]
log_console = false
snapshots = true
"#,
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    Entry {
        handle: spawn_v3_server_aggregate(manifest).await.unwrap(),
        shutdown,
        peer,
    }
}

struct TimedWire {
    wire: Vec<u8>,
    first_delta_at: Option<Duration>,
    completed_at: Option<Duration>,
}

async fn timed_request(entry: &Entry) -> TimedWire {
    let body = json!({"model": "test", "input": "hello", "stream": true}).to_string();
    let mut socket = TcpStream::connect(entry.handle.listeners[0].addr)
        .await
        .unwrap();
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: relay-first-frame-public\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(request.as_bytes()).await.unwrap();

    let started = std::time::Instant::now();
    let mut wire = Vec::new();
    let mut first_delta_at = None;
    let mut completed_at = None;
    loop {
        let mut chunk = [0u8; 4096];
        let count = match timeout(Duration::from_secs(8), socket.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(count)) => count,
            Ok(Err(_)) => break,
            Err(_) => break,
        };
        wire.extend_from_slice(&chunk[..count]);
        let seen = String::from_utf8_lossy(&wire);
        if first_delta_at.is_none() && seen.contains("response.output_text.delta") {
            first_delta_at = Some(started.elapsed());
        }
        if completed_at.is_none() && seen.contains("response.completed") {
            completed_at = Some(started.elapsed());
        }
    }
    TimedWire {
        wire,
        first_delta_at,
        completed_at,
    }
}

#[tokio::test]
async fn relay_first_business_frame_precedes_provider_terminal_at_public_http_entry() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start().await;
    let timed = timed_request(&entry).await;
    let text = String::from_utf8_lossy(&timed.wire);

    assert!(text.contains("early-progressive-text"), "{text}");
    let first_delta_at = timed
        .first_delta_at
        .expect("the first business delta must reach the client");
    let completed_at = timed
        .completed_at
        .expect("the relay attempt must project its terminal");
    let lead = completed_at.saturating_sub(first_delta_at);
    assert!(
        lead >= Duration::from_millis(300),
        "Relay must project its first business delta before the provider terminal; measured delta={first_delta_at:?} terminal={completed_at:?} lead={lead:?}"
    );
    assert!(
        !text.contains("\"error\"") && !text.contains("network_error"),
        "client received a provider/proxy error payload: {text}"
    );
    entry.stop().await;
}
