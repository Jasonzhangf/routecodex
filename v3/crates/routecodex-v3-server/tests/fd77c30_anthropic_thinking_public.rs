//! fd77c30 public-entry regressions: an Anthropic `/v1/messages` history that
//! contains an empty, absent, or whitespace-only `thinking` block must enter the
//! semantic pipeline instead of being rejected by the inbound codec and turned
//! into a client transport break.
//!
//! The controlled upstream below validates the exact expected provider shape.
//! It does not return unconditional success: an incomplete history (missing
//! thinking blocks, signatures, tool identity or paired results) is rejected on
//! the first attempt, so a codec regression cannot pass behind a rubber-stamp.

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
use std::{
    convert::Infallible,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();
const PROVIDER_KEY_ENV: &str = "V3_FD77C30_ANTHROPIC_THINKING_KEY";

const EMPTY_SIGNATURE: &str = "sig-empty";
const TOOL_HISTORY_ID: &str = "call_1";
const TOOL_HISTORY_RESULT: &str = "ok";
const FOLLOW_UP_ID: &str = "call_2";
const FOLLOW_UP_RESULT: &str = "echoed-2";
const FINAL_TEXT: &str = "thinking roundtrip complete";
const REJECT_MARKER: &str = "FD77C30_MOCK_SHAPE_REJECT";

/// Entry binding that this run exercises. `Direct` is the config default for a
/// same-protocol Anthropic target; `Relay` is declared explicitly with the Hub
/// fixture's relay binding.
#[derive(Clone, Copy)]
enum Mode {
    Direct,
    Relay,
}

impl Mode {
    fn label(self) -> &'static str {
        match self {
            Mode::Direct => "direct",
            Mode::Relay => "relay",
        }
    }

    fn declaration(self) -> String {
        match self {
            // A skeleton-only Hub declaration keeps the config default
            // Anthropic binding (Direct).
            Mode::Direct => "[pipelines.hub_v1]\nskeleton = \"hub_v1\"\n".to_string(),
            // The shared fixture declares the Anthropic endpoint as Relay.
            Mode::Relay => hub_v1_fixture::hub_v1_test_declaration(),
        }
    }
}

#[derive(Clone)]
struct UpstreamState {
    calls: std::sync::Arc<AtomicUsize>,
    captures: mpsc::UnboundedSender<Value>,
}

fn reject(reason: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "type": "error",
                "error": {"type": "invalid_request_error", "message": format!("{REJECT_MARKER} {reason}")}
            })
            .to_string(),
        ))
        .unwrap()
}

fn sse(body: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

fn text_sse() -> String {
    format!(
        "event: message_start\n\
         data: {{\"type\":\"message_start\",\"message\":{{\"id\":\"msg_fd77c30\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"anthropic-wire\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{{\"input_tokens\":9,\"output_tokens\":0}}}}}}\n\n\
         event: content_block_start\n\
         data: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"text\",\"text\":\"\"}}}}\n\n\
         event: content_block_delta\n\
         data: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"{FINAL_TEXT}\"}}}}\n\n\
         event: content_block_stop\n\
         data: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n\
         event: message_delta\n\
         data: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"end_turn\",\"stop_sequence\":null}},\"usage\":{{\"output_tokens\":3}}}}\n\n\
         event: message_stop\n\
         data: {{\"type\":\"message_stop\"}}\n\n"
    )
}

fn tool_use_sse() -> String {
    format!(
        "event: message_start\n\
         data: {{\"type\":\"message_start\",\"message\":{{\"id\":\"msg_fd77c30_tool\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"anthropic-wire\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{{\"input_tokens\":9,\"output_tokens\":0}}}}}}\n\n\
         event: content_block_start\n\
         data: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"tool_use\",\"id\":\"{FOLLOW_UP_ID}\",\"name\":\"echo\",\"input\":{{}}}}}}\n\n\
         event: content_block_delta\n\
         data: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"input_json_delta\",\"partial_json\":\"{{\\\"x\\\":2}}\"}}}}\n\n\
         event: content_block_stop\n\
         data: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n\
         event: message_delta\n\
         data: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"tool_use\",\"stop_sequence\":null}},\"usage\":{{\"output_tokens\":7}}}}\n\n\
         event: message_stop\n\
         data: {{\"type\":\"message_stop\"}}\n\n"
    )
}

fn content_blocks(body: &Value) -> Vec<&Value> {
    body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .collect()
}

/// Rejects any provider request that lost part of the expected history. This is
/// deliberate: the fixture proves the first attempt carries the real shape.
fn validate_expected_history(body: &Value) -> Result<(), String> {
    let blocks = content_blocks(body);
    let has = |predicate: &dyn Fn(&&Value) -> bool| blocks.iter().any(predicate);
    if !has(&|block| {
        block["type"] == "thinking"
            && block.get("thinking").and_then(Value::as_str) == Some("")
            && block.get("signature").and_then(Value::as_str) == Some(EMPTY_SIGNATURE)
    }) {
        return Err("empty-thinking-with-signature".into());
    }
    if !has(&|block| block["type"] == "thinking" && block.get("thinking").is_none()) {
        return Err("absent-thinking".into());
    }
    if !has(&|block| {
        block["type"] == "thinking" && block.get("thinking").and_then(Value::as_str) == Some("   ")
    }) {
        return Err("whitespace-thinking".into());
    }
    if !has(&|block| {
        block["type"] == "thinking"
            && block.get("thinking").and_then(Value::as_str) == Some("real thought")
    }) {
        return Err("nonempty-thinking".into());
    }
    if !has(&|block| {
        block["type"] == "tool_use"
            && block["id"] == TOOL_HISTORY_ID
            && block["name"] == "echo"
            && block["input"] == json!({"x":1})
    }) {
        return Err("historic-tool-use".into());
    }
    if !has(&|block| {
        block["type"] == "tool_result"
            && block["tool_use_id"] == TOOL_HISTORY_ID
            && block["content"] == TOOL_HISTORY_RESULT
    }) {
        return Err("historic-tool-result-pairing".into());
    }
    Ok(())
}

fn is_follow_up_turn(body: &Value) -> bool {
    content_blocks(body)
        .iter()
        .any(|block| block["type"] == "tool_result" && block["tool_use_id"] == FOLLOW_UP_ID)
}

fn validate_follow_up(body: &Value) -> Result<(), String> {
    let blocks = content_blocks(body);
    let has = |predicate: &dyn Fn(&&Value) -> bool| blocks.iter().any(predicate);
    if !has(&|block| {
        block["type"] == "tool_use"
            && block["id"] == FOLLOW_UP_ID
            && block["name"] == "echo"
            && block["input"] == json!({"x":2})
    }) {
        return Err("executed-tool-use".into());
    }
    if !has(&|block| {
        block["type"] == "tool_result"
            && block["tool_use_id"] == FOLLOW_UP_ID
            && block["content"] == FOLLOW_UP_RESULT
    }) {
        return Err("executed-tool-result-pairing".into());
    }
    Ok(())
}

/// Two-turn controlled tool provider. The first accepted attempt returns a tool
/// call the client must execute; the follow-up carries the paired result.
async fn roundtrip_upstream(
    State(state): State<UpstreamState>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.calls.fetch_add(1, Ordering::SeqCst);
    let capture = state.captures.clone();
    let _ = capture.send(body.clone());
    if let Err(reason) = validate_expected_history(&body) {
        return reject(&reason);
    }
    if is_follow_up_turn(&body) {
        if let Err(reason) = validate_follow_up(&body) {
            return reject(&reason);
        }
        return sse(text_sse());
    }
    sse(tool_use_sse())
}

/// First candidate in the timeout case: validate the real shape, then yield no
/// first frame so the declared provider first-frame budget fails it and the
/// request reselects the healthy sibling.
async fn stalled_upstream(
    State(state): State<UpstreamState>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.calls.fetch_add(1, Ordering::SeqCst);
    let _ = state.captures.send(body.clone());
    if let Err(reason) = validate_expected_history(&body) {
        return reject(&reason);
    }
    let pending = stream::pending::<Result<Bytes, Infallible>>();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(pending))
        .unwrap()
}

/// Healthy sibling for the timeout case: validates the same preserved history
/// and returns a complete Anthropic terminal.
async fn final_upstream(
    State(state): State<UpstreamState>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.calls.fetch_add(1, Ordering::SeqCst);
    let _ = state.captures.send(body.clone());
    if let Err(reason) = validate_expected_history(&body) {
        return reject(&reason);
    }
    sse(text_sse())
}

struct Entry {
    base: String,
    upstream_ok: String,
    handle: V3ServerAggregateHandle,
    shutdown: oneshot::Sender<()>,
    peer: tokio::task::JoinHandle<()>,
    calls: std::sync::Arc<AtomicUsize>,
    captures: mpsc::UnboundedReceiver<Value>,
}

struct Upstream {
    addr: std::net::SocketAddr,
    shutdown: oneshot::Sender<()>,
    peer: tokio::task::JoinHandle<()>,
    calls: std::sync::Arc<AtomicUsize>,
    captures: mpsc::UnboundedReceiver<Value>,
}

async fn spawn_upstream() -> Upstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (shutdown, stop) = oneshot::channel();
    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let state = UpstreamState {
        calls: calls.clone(),
        captures: captures_tx,
    };
    let peer = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/ok/v1/messages", post(roundtrip_upstream))
                .route("/stall/v1/messages", post(stalled_upstream))
                .route("/final/v1/messages", post(final_upstream))
                .with_state(state),
        )
        .with_graceful_shutdown(async {
            let _ = stop.await;
        })
        .await
        .unwrap();
    });
    Upstream {
        addr,
        shutdown,
        peer,
        calls,
        captures: captures_rx,
    }
}

async fn start_server(source: String) -> V3ServerAggregateHandle {
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    spawn_v3_server_aggregate(manifest).await.unwrap()
}

fn execution_block() -> String {
    format!(
        "{}\nattempt_store = {{ residence_timeout_ms = 15000 }}\n",
        hub_v1_fixture::hub_v1_server_execution("owned")
    )
}

impl Entry {
    async fn roundtrip(mode: Mode) -> Self {
        std::env::set_var(PROVIDER_KEY_ENV, "fd77c30-owned-key");
        let upstream = spawn_upstream().await;
        let declaration = mode.declaration();
        let execution = execution_block();
        let port = test_ports::free_port();
        let source = format!(
            r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["anthropic"]
{execution}
[providers.ok]
type = "anthropic"
base_url = "http://{upstream_addr}/ok"
default_model = "anthropic-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
request_timeout_ms = 2000
sse_first_frame_timeout_ms = 2000
[providers.ok.models.anthropic-wire]
wire_name = "anthropic-wire"
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "ok", model = "anthropic-wire", key = "key", priority = 1 }}]
[debug]
log_console = false
snapshots = true
"#,
            upstream_addr = upstream.addr,
        );
        let handle = start_server(source).await;
        Self {
            base: format!("http://{}", handle.listeners[0].addr),
            upstream_ok: format!("http://{}/ok", upstream.addr),
            handle,
            shutdown: upstream.shutdown,
            peer: upstream.peer,
            calls: upstream.calls,
            captures: upstream.captures,
        }
    }

    async fn timeout_reselect(mode: Mode) -> Self {
        std::env::set_var(PROVIDER_KEY_ENV, "fd77c30-owned-key");
        let upstream = spawn_upstream().await;
        let declaration = mode.declaration();
        let execution = execution_block();
        let port = test_ports::free_port();
        let source = format!(
            r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["anthropic"]
{execution}
[providers.stall]
type = "anthropic"
base_url = "http://{upstream_addr}/stall"
default_model = "anthropic-stall-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
request_timeout_ms = 200
sse_first_frame_timeout_ms = 200
[providers.stall.models.anthropic-stall-wire]
wire_name = "anthropic-stall-wire"
supports_streaming = true
capabilities = ["text", "tools"]
[providers.ok]
type = "anthropic"
base_url = "http://{upstream_addr}/final"
default_model = "anthropic-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
request_timeout_ms = 2000
sse_first_frame_timeout_ms = 2000
[providers.ok.models.anthropic-wire]
wire_name = "anthropic-wire"
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "stall", model = "anthropic-stall-wire", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "ok", model = "anthropic-wire", key = "key", priority = 1 }}
]
[debug]
log_console = false
snapshots = true
"#,
            upstream_addr = upstream.addr,
        );
        let handle = start_server(source).await;
        Self {
            base: format!("http://{}", handle.listeners[0].addr),
            upstream_ok: format!("http://{}/ok", upstream.addr),
            handle,
            shutdown: upstream.shutdown,
            peer: upstream.peer,
            calls: upstream.calls,
            captures: upstream.captures,
        }
    }

    fn client(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap()
    }

    async fn next_capture(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(5), self.captures.recv())
            .await
            .expect("controlled upstream request")
            .expect("controlled upstream capture")
    }

    async fn stop(self) {
        assert!(self.handle.shutdown().await.is_empty());
        let _ = self.shutdown.send(());
        tokio::time::timeout(Duration::from_secs(10), self.peer)
            .await
            .unwrap()
            .unwrap();
        std::env::remove_var(PROVIDER_KEY_ENV);
    }
}

/// The exact history that triggered ECONNRESET: an assistant turn carrying
/// empty, absent and whitespace-only `thinking` alongside a real thought, a
/// tool_use, and its paired tool_result.
fn history_request(extra_messages: Vec<Value>) -> Value {
    let mut messages = vec![
        json!({"role":"user","content":"inspect cwd"}),
        json!({"role":"assistant","content":[
            {"type":"thinking","thinking":"","signature":EMPTY_SIGNATURE},
            {"type":"thinking"},
            {"type":"thinking","thinking":"   "},
            {"type":"thinking","thinking":"real thought"},
            {"type":"tool_use","id":TOOL_HISTORY_ID,"name":"echo","input":{"x":1}}
        ]}),
        json!({"role":"user","content":[
            {"type":"tool_result","tool_use_id":TOOL_HISTORY_ID,"content":TOOL_HISTORY_RESULT}
        ]}),
    ];
    messages.extend(extra_messages);
    json!({
        "model":"client",
        "max_tokens":256,
        "stream":true,
        "tools":[{"name":"echo","description":"Echo an integer","input_schema":{"type":"object","properties":{"x":{"type":"integer"}},"required":["x"]}}],
        "messages":messages
    })
}

fn sse_json_values(body: &str) -> Vec<Value> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .filter(|data| !data.is_empty())
        .filter_map(|data| serde_json::from_str(data).ok())
        .collect()
}

fn anthropic_tool_call(body: &str) -> (String, String, Value) {
    let events = sse_json_values(body);
    let mut id = None;
    let mut name = None;
    let mut partial_json = String::new();
    for event in &events {
        if event["type"] == "content_block_start" && event["content_block"]["type"] == "tool_use" {
            id = event["content_block"]["id"].as_str().map(str::to_string);
            name = event["content_block"]["name"].as_str().map(str::to_string);
        }
        if event["type"] == "content_block_delta" && event["delta"]["type"] == "input_json_delta" {
            if let Some(part) = event["delta"]["partial_json"].as_str() {
                partial_json.push_str(part);
            }
        }
    }
    let input: Value = serde_json::from_str(&partial_json)
        .unwrap_or_else(|error| panic!("tool arguments must reconstruct: {error}; {body}"));
    (id.unwrap_or_default(), name.unwrap_or_default(), input)
}

fn assert_no_client_error(body: &str) {
    assert!(
        !body.contains("\"error\"")
            && !body.contains("network_error")
            && !body.contains(REJECT_MARKER),
        "client must not receive a fabricated error: {body}"
    );
    assert!(
        body.contains("message_stop"),
        "client must receive a complete Anthropic SSE terminal: {body}"
    );
}

async fn entry_execution_modes(client: &reqwest::Client, entry: &Entry) -> Vec<String> {
    let logs: Value = client
        .get(format!("{}/_routecodex/debug/logs", entry.base))
        .send()
        .await
        .expect("debug logs request")
        .json()
        .await
        .expect("debug logs JSON");
    logs["logs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|event| event["node_id"] == "V3Server03HttpRequestRaw")
        .filter_map(|event| event["details"]["execution_mode"].as_str())
        .map(str::to_string)
        .collect()
}

async fn run_roundtrip(mode: Mode) {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = Entry::roundtrip(mode).await;
    let client = entry.client();
    let endpoint = format!("{}/v1/messages", entry.base);

    // First provider attempt: the full history must reach the wire intact.
    let response = client
        .post(&endpoint)
        .json(&history_request(Vec::new()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let first_body = response.text().await.unwrap();
    assert_no_client_error(&first_body);
    let (call_id, call_name, call_input) = anthropic_tool_call(&first_body);
    assert_eq!(call_id, FOLLOW_UP_ID, "{first_body}");
    assert_eq!(call_name, "echo", "{first_body}");
    assert_eq!(call_input, json!({"x":2}), "{first_body}");

    let first = entry.next_capture().await;
    assert_eq!(entry.calls.load(Ordering::SeqCst), 1);
    assert_preserved_history(&first);

    // The client executes the tool it just received, then follows up with the
    // paired result and the unchanged thinking history.
    let executed = format!(
        "echoed-{}",
        call_input["x"].as_i64().expect("numeric echo input")
    );
    let follow_up = history_request(vec![
        json!({"role":"assistant","content":[
            {"type":"tool_use","id":call_id,"name":call_name,"input":call_input}
        ]}),
        json!({"role":"user","content":[
            {"type":"tool_result","tool_use_id":FOLLOW_UP_ID,"content":executed}
        ]}),
    ]);
    let response = client
        .post(&endpoint)
        .json(&follow_up)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let second_body = response.text().await.unwrap();
    assert_no_client_error(&second_body);
    assert!(
        second_body.contains(FINAL_TEXT),
        "follow-up must complete with the provider result: {second_body}"
    );

    let second = entry.next_capture().await;
    assert_eq!(entry.calls.load(Ordering::SeqCst), 2);
    assert_preserved_history(&second);
    assert!(
        content_blocks(&second).iter().any(|block| {
            block["type"] == "tool_use"
                && block["id"] == FOLLOW_UP_ID
                && block["name"] == "echo"
                && block["input"] == json!({"x":2})
        }),
        "follow-up tool identity must survive: {second}"
    );
    assert!(
        content_blocks(&second).iter().any(|block| {
            block["type"] == "tool_result"
                && block["tool_use_id"] == FOLLOW_UP_ID
                && block["content"] == FOLLOW_UP_RESULT
        }),
        "follow-up tool result must stay paired: {second}"
    );

    let modes = entry_execution_modes(&client, &entry).await;
    assert!(
        !modes.is_empty(),
        "the entry must record its binding-resolved execution mode"
    );
    assert!(
        modes.iter().all(|observed| observed == mode.label()),
        "entry must run the configured {label} binding, saw {modes:?}",
        label = mode.label()
    );

    entry.stop().await;
}

fn assert_preserved_history(body: &Value) {
    let blocks = content_blocks(body);
    let empty = blocks
        .iter()
        .find(|block| {
            block["type"] == "thinking"
                && block.get("thinking").and_then(Value::as_str) == Some("")
                && block.get("signature").and_then(Value::as_str) == Some(EMPTY_SIGNATURE)
        })
        .copied()
        .unwrap_or_else(|| panic!("empty signed thinking block must survive: {body}"));
    assert_eq!(empty.get("thinking"), Some(&json!("")), "{body}");
    let absent = blocks
        .iter()
        .find(|block| block["type"] == "thinking" && block.get("thinking").is_none())
        .copied()
        .unwrap_or_else(|| panic!("absent thinking block must survive: {body}"));
    assert_eq!(absent.get("thinking"), None, "{body}");
    let whitespace = blocks
        .iter()
        .find(|block| {
            block["type"] == "thinking"
                && block.get("thinking").and_then(Value::as_str) == Some("   ")
        })
        .copied()
        .unwrap_or_else(|| panic!("whitespace thinking block must survive: {body}"));
    assert_eq!(whitespace["thinking"], "   ", "{body}");
    assert!(
        blocks.iter().any(|block| {
            block["type"] == "tool_use"
                && block["id"] == TOOL_HISTORY_ID
                && block["name"] == "echo"
                && block["input"] == json!({"x":1})
        }),
        "tool identity/arguments/call-id must survive: {body}"
    );
    assert!(
        blocks.iter().any(|block| {
            block["type"] == "tool_result"
                && block["tool_use_id"] == TOOL_HISTORY_ID
                && block["content"] == TOOL_HISTORY_RESULT
        }),
        "paired tool result must survive: {body}"
    );
}

#[tokio::test]
async fn fd77c30_thinking_history_roundtrip_direct() {
    run_roundtrip(Mode::Direct).await;
}

#[tokio::test]
async fn fd77c30_thinking_history_roundtrip_relay() {
    run_roundtrip(Mode::Relay).await;
}

#[tokio::test]
async fn fd77c30_upstream_mock_rejects_incomplete_history() {
    let _guard = TEST_LOCK.lock().await;
    let entry = Entry::roundtrip(Mode::Relay).await;
    let client = entry.client();
    // A user-only body is forwarded by the proxy but must be rejected by the
    // controlled provider: the mock is not a rubber stamp.
    let incomplete = json!({
        "model":"client",
        "stream":true,
        "messages":[{"role":"user","content":"missing the whole history"}]
    });
    let response = client
        .post(format!("{}/v1/messages", entry.upstream_ok))
        .json(&incomplete)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response.text().await.unwrap();
    assert!(
        body.contains(REJECT_MARKER),
        "mock must reject an incomplete expected shape: {body}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn fd77c30_provider_first_frame_timeout_reselects_while_preserving_history() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = Entry::timeout_reselect(Mode::Relay).await;
    let client = entry.client();
    let response = client
        .post(format!("{}/v1/messages", entry.base))
        .json(&history_request(Vec::new()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert_no_client_error(&body);
    assert!(
        body.contains(FINAL_TEXT),
        "healthy sibling must complete the request: {body}"
    );

    let stalled = entry.next_capture().await;
    assert_preserved_history(&stalled);
    assert_eq!(stalled["model"], "anthropic-stall-wire");
    let healthy = entry.next_capture().await;
    assert_preserved_history(&healthy);
    assert_eq!(healthy["model"], "anthropic-wire");
    assert_eq!(entry.calls.load(Ordering::SeqCst), 2);
    assert!(
        entry.captures.try_recv().is_err(),
        "declared timeout must dispatch exactly the timed-out candidate and one healthy alternative"
    );
    entry.stop().await;
}

#[tokio::test]
async fn fd77c30_invalid_json_preserves_request_error() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = Entry::roundtrip(Mode::Relay).await;
    let client = entry.client();
    let response = client
        .post(format!("{}/v1/messages", entry.base))
        .header("content-type", "application/json")
        .body("{")
        .send()
        .await;
    if let Ok(response) = response {
        assert!(
            !response.status().is_success(),
            "malformed JSON must not fabricate success"
        );
        // The request boundary may also break the transport without a read
        // status; that is still a truthful non-success, not a fabricated error
        // payload or empty completion.
    }
    assert!(
        entry.captures.try_recv().is_err(),
        "malformed JSON must not dispatch a provider attempt"
    );
    assert_eq!(entry.calls.load(Ordering::SeqCst), 0);
    entry.stop().await;
}
