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
use std::{collections::VecDeque, convert::Infallible, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, oneshot, Mutex},
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
    chat_delta_value(json!({"role": "assistant", "content": text}))
}

fn chat_delta_value(delta: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl_relay_public",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "wire-relay",
            "choices": [{"index": 0, "delta": delta}]
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

#[derive(Clone)]
struct UpstreamState {
    captures: mpsc::UnboundedSender<Value>,
    plans: Arc<Mutex<VecDeque<Vec<String>>>>,
}

fn default_plan() -> Vec<String> {
    vec![
        chat_delta("early-progressive-text"),
        chat_stop(),
        "data: [DONE]\n\n".to_string(),
    ]
}

async fn upstream(State(state): State<UpstreamState>, Json(body): Json<Value>) -> Response<Body> {
    let _ = state.captures.send(body);
    let frames = state
        .plans
        .lock()
        .await
        .pop_front()
        .unwrap_or_else(default_plan);
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
        routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(None);
    }
}

async fn start_with_plans(plans: Vec<Vec<String>>) -> (Entry, mpsc::UnboundedReceiver<Value>) {
    start_with_plans_and_refill(plans, None).await
}

async fn start_with_plans_and_refill(
    plans: Vec<Vec<String>>,
    refill_max: Option<u32>,
) -> (Entry, mpsc::UnboundedReceiver<Value>) {
    std::env::set_var(PROVIDER_KEY_ENV, "owned-fixture-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = listener.local_addr().unwrap();
    let (shutdown, stop) = oneshot::channel();
    let (captures, _received) = mpsc::unbounded_channel();
    let captures_sender = captures.clone();
    let state = UpstreamState {
        captures: captures_sender,
        plans: Arc::new(Mutex::new(plans.into_iter().collect())),
    };
    let peer = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/chat/completions", post(upstream))
                .with_state(state),
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
    if let Some(max) = refill_max {
        routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(
            max,
        ));
    }
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
    (
        Entry {
            handle: spawn_v3_server_aggregate(manifest).await.unwrap(),
            shutdown,
            peer,
        },
        _received,
    )
}

async fn start() -> Entry {
    let (entry, _captures) = start_with_plans(vec![default_plan()]).await;
    entry
}

/// Issue one chat-protocol provider round and read the full Responses SSE body.
/// The shared upstream consumes one queued plan per request.
async fn relay_body(entry: &Entry, body: Value) -> String {
    let mut socket = TcpStream::connect(entry.handle.listeners[0].addr)
        .await
        .unwrap();
    let body = body.to_string();
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: relay-first-frame-public\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut wire = Vec::new();
    loop {
        let mut chunk = [0u8; 4096];
        let count = match timeout(Duration::from_secs(8), socket.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(count)) => count,
            Ok(Err(_)) => break,
            Err(_) => break,
        };
        wire.extend_from_slice(&chunk[..count]);
    }
    decoded_chunked_body(&wire)
}

fn decoded_chunked_body(wire: &[u8]) -> String {
    let header_end = wire
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap_or(0);
    let body = &wire[header_end + 4..];
    if body.starts_with(b"data:") {
        return String::from_utf8_lossy(body).to_string();
    }
    let mut cursor = 0;
    let mut decoded = Vec::new();
    while cursor < body.len() {
        let Some(line_end) = body[cursor..].iter().position(|byte| *byte == b'\n') else {
            break;
        };
        let line_end = cursor + line_end;
        let size_line = std::str::from_utf8(&body[cursor..line_end])
            .unwrap()
            .trim_end_matches('\r');
        let Ok(size) = usize::from_str_radix(size_line.split(';').next().unwrap_or(""), 16) else {
            break;
        };
        cursor = line_end + 1;
        if size == 0 {
            break;
        }
        let chunk_end = (cursor + size).min(body.len());
        decoded.extend_from_slice(&body[cursor..chunk_end]);
        cursor = chunk_end + 2;
    }
    String::from_utf8_lossy(&decoded).to_string()
}

fn response_sse_events(body: &str) -> Vec<Value> {
    body.split("\n\n")
        .filter_map(|event| {
            let payload = event
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim))
                .collect::<Vec<_>>()
                .join("\n");
            (!payload.is_empty())
                .then(|| serde_json::from_str(&payload).ok())
                .flatten()
        })
        .collect()
}

fn completed_response(events: &[Value]) -> &Value {
    events
        .iter()
        .rev()
        .find(|event| event["type"] == "response.completed")
        .and_then(|event| event.get("response"))
        .expect("completed response")
}

fn delivered_visible_text(events: &[Value]) -> String {
    events
        .iter()
        .filter(|event| event["type"] == "response.output_text.delta")
        .filter_map(|event| event["delta"].as_str())
        .collect()
}

fn delivered_reasoning_summaries(events: &[Value]) -> Vec<Vec<String>> {
    events
        .iter()
        .filter(|event| {
            event["type"] == "response.output_item.done" && event["item"]["type"] == "reasoning"
        })
        .map(|event| {
            event["item"]["summary"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| part["text"].as_str().map(str::to_string))
                .collect()
        })
        .collect()
}

fn delivered_refusal_text(events: &[Value]) -> String {
    events
        .iter()
        .filter(|event| event["type"] == "response.refusal.delta")
        .filter_map(|event| event["delta"].as_str())
        .collect()
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

#[tokio::test]
async fn relay_public_fenced_governed_marker_seals_when_owner_preserves_it() {
    let _guard = TEST_LOCK.lock().await;
    let plans = vec![vec![
        chat_delta("Example:\n"),
        chat_delta("```\n</\u{FF5C}DSML\u{FF5C}tool_calls>\n```"),
        chat_stop(),
        "data: [DONE]\n\n".to_string(),
    ]];
    let (entry, _captures) = start_with_plans(plans).await;
    let body = relay_body(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;

    assert!(
        body.contains("</\u{FF5C}DSML\u{FF5C}tool_calls>"),
        "the fenced marker is protected business text the owner preserves: {body}"
    );
    assert!(
        body.contains("response.completed"),
        "the attempt must seal with a completed terminal: {body}"
    );
    assert!(
        !body.contains("\"error\"") && !body.contains("network_error"),
        "the client must not receive a proxy-generated error: {body}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn relay_public_quoted_governed_marker_seals_when_owner_preserves_it() {
    let _guard = TEST_LOCK.lock().await;
    let plans = vec![vec![
        chat_delta("Example:\n\""),
        chat_delta("\n</\u{FF5C}DSML\u{FF5C}tool_calls>\n\""),
        chat_stop(),
        "data: [DONE]\n\n".to_string(),
    ]];
    let (entry, _captures) = start_with_plans(plans).await;
    let body = relay_body(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;

    assert!(
        body.contains("</\u{FF5C}DSML\u{FF5C}tool_calls>"),
        "the quoted marker is protected business text the owner preserves: {body}"
    );
    assert!(
        body.contains("response.completed"),
        "the attempt must seal with a completed terminal: {body}"
    );
    assert!(
        !body.contains("\"error\"") && !body.contains("network_error"),
        "the client must not receive a proxy-generated error: {body}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn relay_public_reasoning_cipher_survives_first_frame_and_echoes_next_turn() {
    let _guard = TEST_LOCK.lock().await;
    let cipher = "chat-cipher-opaque";
    let plans = vec![
        vec![
            chat_delta_value(json!({"reasoning": {
                "summary": [{"type": "summary_text", "text": "private plan"}],
                "encrypted_content": cipher,
                "provider_extension": {"opaque": "keep"}
            }})),
            chat_delta("answer"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
        vec![
            chat_delta("second"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
    ];
    let (entry, mut captures) = start_with_plans(plans).await;
    let body = relay_body(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;

    let events = response_sse_events(&body);
    let reasoning_done = events
        .iter()
        .find(|event| {
            event["type"] == "response.output_item.done" && event["item"]["type"] == "reasoning"
        })
        .expect("reasoning item done event");
    assert_eq!(
        reasoning_done["item"]["provider_extension"],
        json!({"opaque": "keep"}),
        "the first-frame SSE item must keep the complete reasoning payload: {reasoning_done}"
    );
    let completed = events
        .iter()
        .rev()
        .find(|event| event["type"] == "response.completed")
        .expect("completed event");
    let output = completed
        .pointer("/response/output")
        .and_then(Value::as_array)
        .expect("completed output");
    let reasoning = output
        .iter()
        .find(|item| item["type"] == "reasoning")
        .expect("reasoning item in terminal");
    assert_eq!(
        reasoning["encrypted_content"],
        json!(cipher),
        "the first-frame SSE terminal must keep the reasoning cipher: {completed}"
    );
    assert_eq!(
        reasoning["provider_extension"],
        json!({"opaque": "keep"}),
        "the first-frame SSE terminal must keep the complete reasoning payload: {completed}"
    );

    // The first request was already captured by the upstream; drain it so the
    // next-turn capture is the second request's provider body.
    let _first_capture = captures.try_recv().ok();

    // Echo the delivered reasoning item into the next turn. The server-side
    // Responses->Chat projection must carry the reasoning plaintext so the
    // provider receives a complete continuation history.
    let next_body = json!({
        "model": "test",
        "stream": true,
        "input": [
            reasoning,
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "answer"}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue"}]}
        ]
    });
    let _second = relay_body(&entry, next_body).await;
    let captured = captures.try_recv().ok();
    let captured_text = captured.map(|value| value.to_string()).unwrap_or_default();
    assert!(
        captured_text.contains("private plan"),
        "the next-turn provider request must keep the echoed reasoning plaintext: {captured_text}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn relay_public_governed_post_commit_tail_is_delivered_once() {
    let _guard = TEST_LOCK.lock().await;
    let plans = vec![vec![
        chat_delta("answer"),
        chat_delta("\n<|DSML|tool_calls>\nafter"),
        chat_stop(),
        "data: [DONE]\n\n".to_string(),
    ]];
    let (entry, _captures) = start_with_plans(plans).await;
    let body = relay_body(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;
    let events = response_sse_events(&body);

    assert_eq!(
        delivered_visible_text(&events),
        "answer\nafter",
        "the held governed tail must follow the delivered prefix: {body}"
    );
    assert!(
        !body.contains("<|DSML|tool_calls>"),
        "the standalone control label must not reach the client: {body}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "response.completed")
            .count(),
        1,
        "the stream must complete exactly once: {body}"
    );
    assert!(
        !body.contains("\"error\"") && !body.contains("network_error"),
        "the client must not receive a proxy-generated error: {body}"
    );
    let completed = completed_response(&events);
    assert_eq!(
        completed["output"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item["type"] == "message")
            .flat_map(|item| item["content"].as_array().into_iter().flatten())
            .filter_map(|part| part["text"].as_str())
            .collect::<String>(),
        "answer\nafter",
        "the terminal message must carry the governed tail: {completed}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn relay_public_thinking_projection_matches_owner_protected_ranges_and_families() {
    let _guard = TEST_LOCK.lock().await;
    let cases = [
        (
            vec![
                "Example: \"<thin".to_string(),
                "king>plan</thinking>\" tail".to_string(),
            ],
            "Example: \"<thinking>plan</thinking>\" tail",
            Vec::<Vec<String>>::new(),
        ),
        (
            vec![
                "Example:\n```text\n<thin".to_string(),
                "king>plan</thinking>\n```\nend".to_string(),
            ],
            "Example:\n```text\n<thinking>plan</thinking>\n```\nend",
            Vec::<Vec<String>>::new(),
        ),
        (
            vec![
                "Example: `<thin".to_string(),
                "king>plan</thinking>` end".to_string(),
            ],
            "Example: `<thinking>plan</thinking>` end",
            Vec::<Vec<String>>::new(),
        ),
        (
            vec![
                "<think>a</thin".to_string(),
                "k><thinking>b</thinking>visible".to_string(),
            ],
            "visible",
            vec![vec!["a".to_string()], vec!["b".to_string()]],
        ),
    ];
    let plans = cases
        .iter()
        .map(|(chunks, _, _)| {
            let mut plan = chunks
                .iter()
                .map(|chunk| chat_delta(chunk))
                .collect::<Vec<_>>();
            plan.push(chat_stop());
            plan.push("data: [DONE]\n\n".to_string());
            plan
        })
        .collect();
    let (entry, _captures) = start_with_plans(plans).await;
    for (chunks, expected_visible, expected_reasoning) in cases {
        let body = relay_body(
            &entry,
            json!({"model": "test", "input": "hello", "stream": true}),
        )
        .await;
        let events = response_sse_events(&body);
        assert_eq!(
            delivered_visible_text(&events),
            expected_visible,
            "visible text must match the whole-attempt owner for {chunks:?}: {body}"
        );
        assert_eq!(
            delivered_reasoning_summaries(&events),
            expected_reasoning,
            "reasoning items must match the whole-attempt owner for {chunks:?}: {body}"
        );
        assert!(
            !body.contains("\"error\"") && !body.contains("network_error"),
            "the client must not receive a proxy-generated error: {body}"
        );
    }
    entry.stop().await;
}

#[tokio::test]
async fn relay_public_multi_think_summary_parts_and_next_turn_echo() {
    let _guard = TEST_LOCK.lock().await;
    let plans = vec![
        vec![
            chat_delta("<think>a</thin"),
            chat_delta("k><think>b</think>visible"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
        vec![
            chat_delta("second"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
    ];
    let (entry, mut captures) = start_with_plans(plans).await;
    let body = relay_body(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;
    let events = response_sse_events(&body);
    assert_eq!(
        delivered_reasoning_summaries(&events),
        vec![vec!["a".to_string(), "b".to_string()]],
        "each harvested block must be one summary part in one item: {body}"
    );
    let completed = completed_response(&events);
    let output = completed["output"].as_array().expect("completed output");
    assert_eq!(
        output.len(),
        2,
        "one reasoning item and one message must be present exactly once: {completed}"
    );
    let reasoning = output
        .iter()
        .find(|item| item["type"] == "reasoning")
        .expect("reasoning item");
    assert_eq!(
        reasoning["summary"],
        json!([
            {"type": "summary_text", "text": "a"},
            {"type": "summary_text", "text": "b"}
        ]),
        "terminal summary parts must keep the owner block boundaries: {completed}"
    );
    let reasoning_done = events
        .iter()
        .find(|event| {
            event["type"] == "response.output_item.done" && event["item"]["type"] == "reasoning"
        })
        .expect("reasoning done");
    assert_eq!(
        reasoning_done["item"]["id"], reasoning["id"],
        "the terminal must preserve the streamed reasoning identity: {body}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event["type"] == "response.output_item.done" && event["item"]["type"] == "reasoning"
            })
            .count(),
        1,
        "the owner reasoning must not be appended as a duplicate item: {body}"
    );

    let _first_capture = captures.try_recv().ok();
    let next_body = json!({
        "model": "test",
        "stream": true,
        "input": [
            reasoning.clone(),
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "visible"}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue"}]}
        ]
    });
    let _second = relay_body(&entry, next_body).await;
    let captured = captures
        .try_recv()
        .map(|value| value.to_string())
        .unwrap_or_default();
    assert!(
        captured.contains("a\\nb"),
        "the next-turn request must echo both reasoning summary parts: {captured}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn relay_public_think_blocks_separated_by_text_keep_one_reasoning_item() {
    let _guard = TEST_LOCK.lock().await;
    let plans = vec![
        vec![
            chat_delta("<think>a</thin"),
            chat_delta("k>x<think>b</think>y"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
        vec![
            chat_delta("second"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
    ];
    let (entry, mut captures) = start_with_plans(plans).await;
    let body = relay_body(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;
    let events = response_sse_events(&body);
    assert_eq!(
        delivered_visible_text(&events),
        "xy",
        "visible text between the blocks must remain a single message: {body}"
    );
    assert_eq!(
        delivered_reasoning_summaries(&events),
        vec![vec!["a".to_string(), "b".to_string()]],
        "the streamed ledger must keep one reasoning item across intervening text: {body}"
    );
    let completed = completed_response(&events);
    let output = completed["output"].as_array().expect("completed output");
    assert_eq!(
        output.len(),
        2,
        "the terminal must repeat the streamed reasoning and message exactly once: {completed}"
    );
    let reasoning = output
        .iter()
        .find(|item| item["type"] == "reasoning")
        .expect("reasoning item");
    assert_eq!(
        reasoning["summary"],
        json!([
            {"type": "summary_text", "text": "a"},
            {"type": "summary_text", "text": "b"}
        ]),
        "terminal reasoning must keep both owner summary parts: {completed}"
    );
    let reasoning_done = events
        .iter()
        .find(|event| {
            event["type"] == "response.output_item.done" && event["item"]["type"] == "reasoning"
        })
        .expect("reasoning done");
    assert_eq!(
        reasoning_done["item"]["id"], reasoning["id"],
        "terminal reasoning must keep the streamed identity: {body}"
    );

    let _first_capture = captures.try_recv().ok();
    let next_body = json!({
        "model": "test",
        "stream": true,
        "input": [
            reasoning.clone(),
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "xy"}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue"}]}
        ]
    });
    let _second = relay_body(&entry, next_body).await;
    let captured = captures
        .try_recv()
        .map(|value| value.to_string())
        .unwrap_or_default();
    assert!(
        captured.contains("a\\nb"),
        "the next-turn request must echo both reasoning summary parts: {captured}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn relay_public_thinking_body_whitespace_matches_owner() {
    let _guard = TEST_LOCK.lock().await;
    let plans = vec![vec![
        chat_delta("<thinking> bo"),
        chat_delta("dy </thinking>answer"),
        chat_stop(),
        "data: [DONE]\n\n".to_string(),
    ]];
    let (entry, _captures) = start_with_plans(plans).await;
    let body = relay_body(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;
    let events = response_sse_events(&body);
    assert_eq!(
        delivered_visible_text(&events),
        "answer",
        "visible text must match the owner: {body}"
    );
    assert_eq!(
        delivered_reasoning_summaries(&events),
        vec![vec!["body".to_string()]],
        "the streamed thinking body must match the finalized owner: {body}"
    );
    let completed = completed_response(&events);
    let output = completed["output"].as_array().expect("completed output");
    let reasoning: Vec<&Value> = output
        .iter()
        .filter(|item| item["type"] == "reasoning")
        .collect();
    assert_eq!(
        reasoning.len(),
        1,
        "the terminal must represent the thinking block exactly once: {completed}"
    );
    assert_eq!(
        reasoning[0]["summary"],
        json!([{"type": "summary_text", "text": "body"}]),
        "the terminal summary must carry the exact thinking body: {completed}"
    );
    assert!(
        !body.contains("\"error\"") && !body.contains("network_error"),
        "the client must not receive a proxy-generated error: {body}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn relay_public_governed_refill_releases_held_tail_before_round_close() {
    let _guard = TEST_LOCK.lock().await;
    let plans = vec![
        vec![
            chat_delta("answer"),
            chat_delta("\n<|DSML|tool_calls>\nafter"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
        vec![
            chat_delta("final"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
    ];
    let (entry, mut captures) = start_with_plans_and_refill(plans, Some(1)).await;
    let body = relay_body(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;
    let events = response_sse_events(&body);
    assert_eq!(
        captured_provider_requests(&mut captures),
        2,
        "the first round must admit one refill execution: {body}"
    );
    assert!(
        !body.contains("<|DSML|tool_calls>"),
        "the held control label must not leak from the round closeout: {body}"
    );
    assert_eq!(
        delivered_visible_text(&events),
        "answer\nafterfinal",
        "both the governed round-one suffix and the refill text must arrive: {body}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "response.completed")
            .count(),
        1,
        "the refill chain must complete exactly once: {body}"
    );
    let completed = completed_response(&events);
    let messages: Vec<String> = completed["output"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "message")
        .filter_map(|item| item["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "output_text")
        .filter_map(|part| part["text"].as_str().map(str::to_string))
        .collect();
    assert_eq!(
        messages,
        vec!["answer\nafter".to_string(), "final".to_string()],
        "each round must keep one fully governed message item: {completed}"
    );
    assert!(
        !body.contains("\"error\"") && !body.contains("network_error"),
        "the client must not receive a proxy-generated error: {body}"
    );
    entry.stop().await;
}

/// A governed refill chain with three rounds must keep each round's governed
/// probe and held-tail state private to that round.
///
/// Round one commits with a governed marker and releases its tail at the round
/// boundary. Round two carries only a standalone governed marker that Chat
/// Process strips to empty, so it must not open an empty message item or match
/// an earlier round's message. Round three then streams visible business text
/// and must be the only round that reconciles at the terminal. The delivered
/// ledger keeps each round's message exactly once and never leaks the raw
/// control label.
#[tokio::test]
async fn relay_public_849ed8f_governed_commit_public_refill_round_state_resets() {
    let _guard = TEST_LOCK.lock().await;
    let plans = vec![
        vec![
            chat_delta("one"),
            chat_delta("\n<|DSML|tool_calls>\ntail-one"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
        vec![
            chat_delta("<|DSML|tool_calls>\n"),
            chat_delta("two"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
        vec![
            chat_delta("three"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
    ];
    let (entry, mut captures) = start_with_plans_and_refill(plans, Some(2)).await;
    let body = relay_body(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;
    let events = response_sse_events(&body);
    assert_eq!(
        captured_provider_requests(&mut captures),
        3,
        "three governed rounds must each consume one provider plan: {body}"
    );
    assert!(
        !body.contains("<|DSML|tool_calls>"),
        "a stripped standalone marker must never leak to the client: {body}"
    );
    assert_eq!(
        delivered_visible_text(&events),
        "one\ntail-onetwothree",
        "each round's visible text must arrive exactly once, in order: {body}"
    );
    let message_added_count = events
        .iter()
        .filter(|event| event["type"] == "response.output_item.added")
        .filter(|event| event["item"]["type"] == "message")
        .count();
    assert_eq!(
        message_added_count, 3,
        "the stripped marker round must not open an empty message item: {body}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "response.completed")
            .count(),
        1,
        "the refill chain must complete exactly once: {body}"
    );
    let completed = completed_response(&events);
    let messages: Vec<String> = completed["output"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "message")
        .filter_map(|item| item["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "output_text")
        .filter_map(|part| part["text"].as_str().map(str::to_string))
        .collect();
    assert_eq!(
        messages,
        vec![
            "one\ntail-one".to_string(),
            "two".to_string(),
            "three".to_string()
        ],
        "the terminal must keep each round's message exactly once: {completed}"
    );
    assert!(
        !body.contains("\"error\"") && !body.contains("network_error"),
        "the client must not receive a proxy-generated error: {body}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn relay_public_interleaved_provider_reasoning_echoes_without_duplication() {
    let _guard = TEST_LOCK.lock().await;
    let plans = vec![
        vec![
            chat_delta_value(json!({"reasoning_content": "r1"})),
            chat_delta_value(json!({"content": "answer"})),
            chat_delta_value(json!({"reasoning_content": "r2"})),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
        vec![
            chat_delta("second"),
            chat_stop(),
            "data: [DONE]\n\n".to_string(),
        ],
    ];
    let (entry, mut captures) = start_with_plans(plans).await;
    let body = relay_body(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;
    let events = response_sse_events(&body);
    let delivered_reasoning = delivered_reasoning_summaries(&events)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(
        delivered_reasoning.concat(),
        "r1r2",
        "interleaved provider reasoning must be delivered exactly once: {body}"
    );
    let completed = completed_response(&events);
    let output = completed["output"].as_array().expect("completed output");
    assert_eq!(
        output
            .iter()
            .filter(|item| item["type"] == "message")
            .count(),
        1,
        "the terminal must keep one message exactly once: {completed}"
    );
    let reasoning = output
        .iter()
        .filter(|item| item["type"] == "reasoning")
        .cloned()
        .collect::<Vec<_>>();
    assert!(
        !reasoning.is_empty(),
        "terminal reasoning is missing: {completed}"
    );
    let terminal_reasoning = reasoning
        .iter()
        .flat_map(|item| item["summary"].as_array().into_iter().flatten())
        .filter_map(|part| part["text"].as_str())
        .collect::<String>();
    assert_eq!(
        terminal_reasoning, "r1r2",
        "the terminal reasoning must hold each fragment once regardless of item grouping: {completed}"
    );
    assert!(
        !body.contains("\"error\"") && !body.contains("network_error"),
        "the client must not receive a proxy-generated error: {body}"
    );

    let _first_capture = captures.try_recv().ok();
    let mut next_input = reasoning;
    next_input.push(json!({
        "type": "message",
        "role": "assistant",
        "content": [{"type": "output_text", "text": "answer"}]
    }));
    next_input.push(json!({
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": "continue"}]
    }));
    let next_body = json!({
        "model": "test",
        "stream": true,
        "input": next_input
    });
    let _second = relay_body(&entry, next_body).await;
    let captured_text = captures
        .try_recv()
        .ok()
        .map(|value| value.to_string())
        .unwrap_or_default();
    assert_eq!(
        captured_text.matches("r1").count(),
        1,
        "the next-turn provider request must carry r1 once: {captured_text}"
    );
    assert_eq!(
        captured_text.matches("r2").count(),
        1,
        "the next-turn provider request must carry r2 once: {captured_text}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn relay_public_governed_tail_before_refusal_delivers_both() {
    let _guard = TEST_LOCK.lock().await;
    let plans = vec![vec![
        chat_delta("hello"),
        chat_delta_value(json!({"content": "\n<|DSML|tool_calls>\nworld"})),
        chat_delta_value(json!({"refusal": "declined"})),
        chat_stop(),
        "data: [DONE]\n\n".to_string(),
    ]];
    let (entry, _captures) = start_with_plans(plans).await;
    let body = relay_body(
        &entry,
        json!({"model": "test", "input": "hello", "stream": true}),
    )
    .await;
    let events = response_sse_events(&body);
    assert_eq!(
        delivered_visible_text(&events),
        "hello\nworld",
        "the governed tail must follow the committed prefix before the refusal: {body}"
    );
    assert_eq!(
        delivered_refusal_text(&events),
        "declined",
        "the refusal must be delivered after the governed tail: {body}"
    );
    assert!(
        !body.contains("<|DSML|tool_calls>"),
        "the standalone control label must not reach the client: {body}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "response.completed")
            .count(),
        1,
        "the stream must complete exactly once: {body}"
    );
    assert!(
        !body.contains("\"error\"") && !body.contains("network_error"),
        "the client must not receive a proxy-generated error: {body}"
    );
    let completed = completed_response(&events);
    let messages: Vec<Value> = completed["output"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "message")
        .cloned()
        .collect();
    assert_eq!(
        messages.len(),
        2,
        "the terminal must keep the text message and the refusal message exactly once: {completed}"
    );
    let text = messages
        .iter()
        .filter_map(|item| item["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "output_text")
        .filter_map(|part| part["text"].as_str())
        .collect::<String>();
    assert_eq!(
        text, "hello\nworld",
        "the terminal message must carry the governed tail: {completed}"
    );
    let refusal = messages
        .iter()
        .filter_map(|item| item["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "refusal")
        .filter_map(|part| part["refusal"].as_str())
        .collect::<String>();
    assert_eq!(
        refusal, "declined",
        "the terminal refusal message must keep the refusal: {completed}"
    );
    entry.stop().await;
}

fn captured_provider_requests(captures: &mut mpsc::UnboundedReceiver<Value>) -> usize {
    let mut count = 0;
    while captures.try_recv().is_ok() {
        count += 1;
    }
    count
}
