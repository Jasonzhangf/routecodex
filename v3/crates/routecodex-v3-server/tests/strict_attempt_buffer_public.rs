//! Public regressions for the strict provider-attempt commit barrier.
//!
//! Each case uses an owned loopback upstream and an independent listener. The
//! upstream sends a recognizable business prefix, then holds or closes before
//! a valid terminal. The client must not receive that prefix until the
//! complete attempt is accepted.

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header::AUTHORIZATION, HeaderMap, StatusCode, Uri},
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::stream;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{convert::Infallible, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, oneshot, Notify},
    time::timeout,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();
const KEY_A_ENV: &str = "STRICT_ATTEMPT_BUFFER_KEY_A";
const KEY_B_ENV: &str = "STRICT_ATTEMPT_BUFFER_KEY_B";

#[derive(Clone, Copy)]
enum Scenario {
    Barrier,
    FailedPrefix,
}

#[derive(Clone)]
struct UpstreamState {
    captures: mpsc::UnboundedSender<WireAttempt>,
    prefix_sent: mpsc::UnboundedSender<()>,
    release: Arc<Notify>,
    scenario: Scenario,
}

#[derive(Debug, PartialEq, Eq)]
struct WireAttempt {
    path: String,
    model: String,
    auth_alias: &'static str,
}

fn sse_event(event: &str, data: Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

fn direct_delta(text: &str) -> String {
    sse_event(
        "response.output_text.delta",
        json!({
            "type": "response.output_text.delta",
            "item_id": "msg_strict_buffer",
            "output_index": 0,
            "content_index": 0,
            "delta": text
        }),
    )
}

fn direct_completed(text: &str) -> String {
    sse_event(
        "response.completed",
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp_strict_buffer",
                "object": "response",
                "status": "completed",
                "model": "wire-strict",
                "output": [{
                    "id": "msg_strict_buffer",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{
                        "type": "output_text",
                        "text": text,
                        "annotations": []
                    }]
                }]
            }
        }),
    )
}

fn chat_delta(text: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl_strict_buffer",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "wire-relay",
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": text}
            }]
        })
    )
}

fn chat_stop() -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl_strict_buffer",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "wire-relay",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]
        })
    )
}

async fn upstream(
    State(state): State<UpstreamState>,
    uri: Uri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    let auth_alias = match headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        Some("Bearer strict-buffer-a") => "a",
        Some("Bearer strict-buffer-b") => "b",
        _ => "unexpected",
    };
    let _ = state.captures.send(WireAttempt {
        path: uri.path().to_string(),
        model: body["model"].as_str().unwrap_or_default().to_string(),
        auth_alias,
    });
    let relay = uri.path().ends_with("/chat/completions");
    let failed_candidate = matches!(state.scenario, Scenario::FailedPrefix) && auth_alias == "a";
    let prefix = if failed_candidate {
        "failed-prefix"
    } else if auth_alias == "b" {
        "backup-success"
    } else if relay {
        "relay-prefix"
    } else {
        "direct-prefix"
    };
    let prefix_frame = if relay {
        chat_delta(prefix)
    } else {
        direct_delta(prefix)
    };
    let terminal_frame = if relay {
        chat_stop()
    } else {
        direct_completed(prefix)
    };
    let release = Arc::clone(&state.release);
    let prefix_sent = state.prefix_sent.clone();
    let hold_terminal = auth_alias != "b";
    let stream = stream::unfold(
        (Some(prefix_frame), false),
        move |(frame, terminal_sent)| {
            let release = Arc::clone(&release);
            let prefix_sent = prefix_sent.clone();
            let terminal_frame = terminal_frame.clone();
            async move {
                if let Some(frame) = frame {
                    let _ = prefix_sent.send(());
                    return Some((
                        Ok::<_, Infallible>(Bytes::from(frame)),
                        (None, terminal_sent),
                    ));
                }
                if failed_candidate || terminal_sent {
                    return None;
                }
                if !hold_terminal {
                    return Some((
                        Ok::<_, Infallible>(Bytes::from(terminal_frame)),
                        (None, true),
                    ));
                }
                release.notified().await;
                Some((
                    Ok::<_, Infallible>(Bytes::from(terminal_frame)),
                    (None, true),
                ))
            }
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
    release: Arc<Notify>,
}

impl Entry {
    async fn stop(self) {
        assert!(self.handle.shutdown().await.is_empty());
        let _ = self.shutdown.send(());
        timeout(Duration::from_secs(10), self.peer)
            .await
            .unwrap()
            .unwrap();
        std::env::remove_var(KEY_A_ENV);
        std::env::remove_var(KEY_B_ENV);
    }
}

async fn start(
    relay: bool,
    scenario: Scenario,
) -> (
    Entry,
    mpsc::UnboundedReceiver<WireAttempt>,
    mpsc::UnboundedReceiver<()>,
) {
    std::env::set_var(KEY_A_ENV, "strict-buffer-a");
    std::env::set_var(KEY_B_ENV, "strict-buffer-b");

    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    let (shutdown, stop) = oneshot::channel();
    let (captures, capture_receiver) = mpsc::unbounded_channel();
    let (prefix_sent, prefix_receiver) = mpsc::unbounded_channel();
    let release = Arc::new(Notify::new());
    let upstream_state = UpstreamState {
        captures,
        prefix_sent,
        release: Arc::clone(&release),
        scenario,
    };
    let peer = tokio::spawn(async move {
        axum::serve(
            upstream_listener,
            Router::new()
                .route("/v1/responses", post(upstream))
                .route("/v1/chat/completions", post(upstream))
                .with_state(upstream_state),
        )
        .with_graceful_shutdown(async {
            let _ = stop.await;
        })
        .await
        .unwrap();
    });

    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let declaration = if relay {
        hub_v1_fixture::hub_v1_test_declaration().replace(direct_binding, relay_binding)
    } else {
        hub_v1_fixture::hub_v1_test_declaration()
    };
    let execution = format!(
        "{}\nattempt_store = {{ residence_timeout_ms = 5000 }}\n",
        hub_v1_fixture::hub_v1_server_execution("owned")
    );
    let port = test_ports::free_port();
    let provider_type = if relay { "openai_chat" } else { "responses" };
    let process = if relay { "chat" } else { "direct" };
    let provider_id = if relay { "relay" } else { "primary" };
    let alternate_auth = if matches!(scenario, Scenario::FailedPrefix) {
        format!(r#", {{ alias = "b", env = "{KEY_B_ENV}" }}"#)
    } else {
        String::new()
    };
    let targets = if matches!(scenario, Scenario::FailedPrefix) {
        format!(
            r#"targets = [
  {{ kind = "provider_model", provider = "{provider_id}", interface = "default", model = "test", key = "a", priority = 2 }},
  {{ kind = "provider_model", provider = "{provider_id}", interface = "default", model = "test", key = "b", priority = 1 }}
]"#
        )
    } else {
        format!(
            r#"targets = [{{ kind = "provider_model", provider = "{provider_id}", interface = "default", model = "test", key = "a", priority = 1 }}]"#
        )
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
[providers.{provider_id}]
type = "{provider_type}"
base_url = "http://{upstream_addr}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "a", env = "{KEY_A_ENV}" }}{alternate_auth}] }}
responses = {{ process = "{process}", streaming = "always" }}
request_timeout_ms = 5000
sse_first_frame_timeout_ms = 5000
[providers.{provider_id}.models.test]
wire_name = "wire-strict"
capabilities = ["text"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
{targets}
[debug]
log_console = false
snapshots = true
"#
    );
    let mut manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    manifest
        .servers
        .get_mut("owned")
        .unwrap()
        .http_sse_keepalive_ms = 50;
    (
        Entry {
            handle: spawn_v3_server_aggregate(manifest).await.unwrap(),
            shutdown,
            peer,
            release,
        },
        capture_receiver,
        prefix_receiver,
    )
}

async fn send_request(entry: &Entry, body: Value) -> TcpStream {
    let mut socket = TcpStream::connect(entry.handle.listeners[0].addr)
        .await
        .unwrap();
    let body = body.to_string();
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: strict-buffer-public\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    socket
}

async fn read_available(socket: &mut TcpStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    let deadline = tokio::time::Instant::now() + Duration::from_millis(700);
    while let Ok(Ok(count)) = tokio::time::timeout_at(deadline, socket.read(&mut chunk)).await {
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    bytes
}

async fn read_to_end(socket: &mut TcpStream, mut bytes: Vec<u8>) -> Vec<u8> {
    timeout(Duration::from_secs(8), socket.read_to_end(&mut bytes))
        .await
        .expect("public stream must terminate")
        .expect("public stream read must succeed");
    bytes
}

fn wire_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

async fn assert_no_business_before_terminal(relay: bool) {
    let _guard = TEST_LOCK.lock().await;
    let (entry, _captures, mut prefix_sent) = start(relay, Scenario::Barrier).await;
    let mut socket = send_request(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;
    timeout(Duration::from_secs(2), prefix_sent.recv())
        .await
        .expect("upstream must send the business prefix")
        .expect("upstream prefix signal");

    let before_terminal = read_available(&mut socket).await;
    let before_text = wire_text(&before_terminal);
    let leaked_business = before_text.contains("event:") || before_text.contains("data:");

    entry.release.notify_waiters();
    let wire = read_to_end(&mut socket, before_terminal).await;
    let text = wire_text(&wire);
    entry.stop().await;
    assert!(
        !leaked_business,
        "provider business frames leaked before the complete terminal: {before_text}"
    );
    assert!(
        text.contains("response.completed"),
        "the accepted attempt must produce a complete client result: {text}"
    );
    assert!(
        text.contains("direct-prefix") || text.contains("relay-prefix"),
        "the accepted business content is missing: {text}"
    );
}

#[tokio::test]
async fn strict_buffer_direct_zero_business_before_terminal() {
    assert_no_business_before_terminal(false).await;
}

#[tokio::test]
async fn strict_buffer_relay_zero_business_before_terminal() {
    assert_no_business_before_terminal(true).await;
}

async fn assert_failed_prefix_reselects_once(relay: bool) {
    let _guard = TEST_LOCK.lock().await;
    let (entry, mut captures, mut prefix_sent) = start(relay, Scenario::FailedPrefix).await;
    let mut socket = send_request(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;
    timeout(Duration::from_secs(2), prefix_sent.recv())
        .await
        .expect("first provider must send its recognizable prefix")
        .expect("first provider prefix signal");
    entry.release.notify_waiters();
    let initial = read_available(&mut socket).await;
    let wire = read_to_end(&mut socket, initial).await;
    let text = wire_text(&wire);
    let mut wire_attempts = Vec::new();
    while let Ok(Some(capture)) = timeout(Duration::from_millis(100), captures.recv()).await {
        wire_attempts.push(capture);
    }
    let failed_prefix_leaked = text.contains("failed-prefix");
    let backup_delivered = text.contains("backup-success");
    let port = entry.handle.listeners[0].addr.port();
    let records_path = PathBuf::from(std::env::var_os("HOME").unwrap())
        .join(".rcc/logs")
        .join(format!("server-v3-{port}.request-records.jsonl"));
    entry.stop().await;
    let path = if relay {
        "/v1/chat/completions"
    } else {
        "/v1/responses"
    };
    assert_eq!(
        wire_attempts,
        ["a", "b"].map(|auth_alias| WireAttempt {
            path: path.to_string(),
            model: "wire-strict".to_string(),
            auth_alias,
        }),
        "each key of the same provider, interface and model must be dispatched exactly once"
    );
    let records = std::fs::read_to_string(records_path).unwrap();
    let terminal_rows = records
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|record| {
            matches!(
                record["row"]["event_type"].as_str(),
                Some("request.provider_attempt_failed" | "request.completed")
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        terminal_rows.len(),
        2,
        "one failed attempt and one completion"
    );
    let provider_id = if relay { "relay" } else { "primary" };
    let failed = &terminal_rows[0]["row"];
    let completed = &terminal_rows[1]["row"];
    assert_eq!(failed["request_key"], completed["request_key"]);
    for (row, event, key) in [
        (failed, "request.provider_attempt_failed", "a"),
        (completed, "request.completed", "b"),
    ] {
        assert_eq!(row["event_type"], event);
        assert_eq!(row["scope"]["port"], port);
        assert_eq!(row["meta"]["provider_id"], provider_id);
        assert_eq!(
            row["meta"]["provider"],
            format!("{provider_id}:default:{key}:test")
        );
        assert_eq!(row["meta"]["wire_model"], "wire-strict");
        assert_eq!(row["meta"]["auth_alias"], key);
    }
    assert!(
        !failed_prefix_leaked,
        "the failed attempt prefix must remain private: {text}"
    );
    assert!(
        backup_delivered,
        "the replacement candidate result must be delivered: {text}"
    );
}

#[tokio::test]
async fn strict_buffer_direct_failed_prefix_reselects_once() {
    assert_failed_prefix_reselects_once(false).await;
}

#[tokio::test]
async fn strict_buffer_relay_failed_prefix_reselects_once() {
    assert_failed_prefix_reselects_once(true).await;
}
