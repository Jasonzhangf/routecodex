//! REQ02 R31: Anthropic failure/cancellation public consumers.
//!
//! These tests enter through the real Anthropic Messages HTTP endpoint and a
//! loopback upstream. They assert the externally observable client result and
//! the provider requests. They do not inspect runtime private state.

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::stream;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    convert::Infallible,
    net::{SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    net::TcpStream,
    sync::{mpsc, oneshot, Mutex, Notify},
    task::JoinHandle,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const FIRST_KEY_ENV: &str = "V3_REQ02_ANTHROPIC_LIFECYCLE_FIRST_KEY";
const SECOND_KEY_ENV: &str = "V3_REQ02_ANTHROPIC_LIFECYCLE_SECOND_KEY";
const FIRST_SECRET: &str = "req02-anthropic-lifecycle-first-secret";
const SECOND_SECRET: &str = "req02-anthropic-lifecycle-second-secret";
const CLIENT_MODEL: &str = "anthropic-client";
const FIRST_WIRE_MODEL: &str = "first-wire";
const SECOND_WIRE_MODEL: &str = "second-wire";

const LONG_EXEC_COMMAND: &str =
    "printf '%s\\n' 'literal $() and `bytes`' && printf '%s\\n' 'req02-exec-long-value'";
const LONG_PATCH: &str =
    "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n";
const MCP_QUERY: &str = "find nested json with complete arguments";
const PARTIAL_SENTINEL: &str = "req02-partial-attempt-must-not-commit";

#[derive(Debug)]
struct ProviderCapture {
    path: String,
    authorization: Option<String>,
    body: Value,
}

struct ProviderSpec {
    id: &'static str,
    provider_type: &'static str,
    base_url: String,
    model: &'static str,
    key_env: &'static str,
    key_alias: &'static str,
    health: bool,
}

#[derive(Clone)]
struct SuccessProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

#[derive(Clone, Copy)]
enum FirstFailureMode {
    HttpStatus,
    TerminalErrorEvent,
}

#[derive(Clone)]
struct FirstProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
    mode: FirstFailureMode,
}

#[derive(Clone)]
struct IncompleteProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

#[derive(Clone)]
struct CancellationProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
    started: mpsc::UnboundedSender<()>,
    dropped: mpsc::UnboundedSender<()>,
    release: Arc<Notify>,
}

struct DropSignal {
    tx: Option<mpsc::UnboundedSender<()>>,
    completed: Arc<AtomicBool>,
}

impl Drop for DropSignal {
    fn drop(&mut self) {
        if !self.completed.load(Ordering::SeqCst) {
            if let Some(tx) = self.tx.take() {
                let _ = tx.send(());
            }
        }
    }
}

struct UpstreamPeer {
    shutdown: Option<oneshot::Sender<()>>,
    join: JoinHandle<()>,
}

impl UpstreamPeer {
    async fn shutdown(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        tokio::time::timeout(Duration::from_secs(3), self.join)
            .await
            .expect("controlled upstream must stop after graceful shutdown")
            .expect("controlled upstream task must not panic");
    }
}

fn send_capture(
    tx: &mpsc::UnboundedSender<ProviderCapture>,
    headers: &HeaderMap,
    uri: &Uri,
    body: Value,
) {
    tx.send(ProviderCapture {
        path: uri.path().to_string(),
        authorization: headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned),
        body,
    })
    .unwrap();
}

fn json_response(body: Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

fn status_json(status: StatusCode, body: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

fn sse_body_response(body: Body) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(body)
        .unwrap()
}

fn sse_response(body: String) -> Response<Body> {
    sse_body_response(Body::from(body))
}

async fn spawn_upstream(app: Router) -> (SocketAddr, UpstreamPeer) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (
        address,
        UpstreamPeer {
            shutdown: Some(shutdown_tx),
            join,
        },
    )
}

async fn recv_capture(captures: &mut mpsc::UnboundedReceiver<ProviderCapture>) -> ProviderCapture {
    tokio::time::timeout(Duration::from_secs(3), captures.recv())
        .await
        .expect("real HTTP upstream must receive the provider request")
        .expect("provider capture channel must remain open")
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn lifecycle_manifest(
    server_port: u16,
    providers: &[ProviderSpec],
) -> routecodex_v3_config::V3Config05ManifestPublished {
    assert!(
        !providers.is_empty(),
        "lifecycle manifest needs at least one provider"
    );
    let server_id = "req02_lifecycle";

    let provider_blocks = providers
        .iter()
        .map(|provider| {
            let health = if provider.health {
                "health = { enabled = true, failure_threshold = 1, cooldown_ms = 5000 }\n"
            } else {
                ""
            };
            let thinking = if provider.provider_type == "anthropic" {
                "supports_thinking = false\n"
            } else {
                ""
            };
            let aliases = if provider.id == "first" {
                format!("aliases = [\"{CLIENT_MODEL}\"]\n")
            } else {
                String::new()
            };
            format!(
                r#"
[providers.{id}]
type = "{provider_type}"
base_url = "{base_url}"
default_model = "{model}"
auth = {{ type = "api_key", entries = [{{ alias = "{key_alias}", env = "{key_env}" }}] }}
{health}[providers.{id}.models.{model}]
wire_name = "{model}"
{aliases}capabilities = ["text", "tools"]
supports_streaming = true
{thinking}max_tokens = 4096
max_context_tokens = 128000
"#,
                id = provider.id,
                provider_type = provider.provider_type,
                base_url = provider.base_url,
                model = provider.model,
                key_alias = provider.key_alias,
                key_env = provider.key_env,
                health = health,
                thinking = thinking,
                aliases = aliases,
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let target_lines = providers
        .iter()
        .enumerate()
        .map(|(index, provider)| {
            format!(
                "  {{ kind = \"provider_model\", provider = \"{}\", model = \"{}\", key = \"{}\", priority = {} }}",
                provider.id,
                provider.model,
                provider.key_alias,
                providers.len() - index
            )
        })
        .collect::<Vec<_>>()
        .join(",\n");

    let source = format!(
        r#"
version = 3

{declaration}

[error]
provider_error_default_path = [
  {{ step = "cooldown", scope = "provider_model", duration_ms = 5000, provider_global_failure = false }},
  {{ step = "wait_retry", retry_mode = "reselect_before_client_projection", max_attempts = 2, backoff_ms = 0 }},
  {{ step = "project", status = 502, reason_code = "provider_failure", message_mode = "code_only" }},
]

[servers.{server_id}]
bind = "127.0.0.1"
port = {server_port}
routing_group = "{server_id}"
endpoints = ["anthropic"]

{execution}

{provider_blocks}

[route_groups.{server_id}.pools.anthropic_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "anthropic", models = ["{client_model}"] }}
targets = [
{target_lines}
]
[route_groups.{server_id}.pools.default]
selection = {{ strategy = "priority" }}
targets = [
{target_lines}
]
"#,
        declaration = hub_v1_test_declaration(),
        execution = hub_v1_server_execution(server_id),
        server_id = server_id,
        server_port = server_port,
        provider_blocks = provider_blocks,
        client_model = CLIENT_MODEL,
        target_lines = target_lines,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn anthropic_request(stream: bool, content: &str) -> Value {
    json!({
        "model": CLIENT_MODEL,
        "max_tokens": 128,
        "stream": stream,
        "messages": [{"role": "user", "content": content}],
        "tools": [
            {"name": "functions.exec", "input_schema": {"type": "object"}},
            {"name": "custom.apply_patch", "input_schema": {"type": "object"}},
            {"name": "mcp__search.find", "input_schema": {"type": "object"}}
        ]
    })
}

async fn anthropic_first_failure_upstream(
    State(state): State<Arc<FirstProviderState>>,
    headers: HeaderMap,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    send_capture(&state.captures, &headers, &uri, body.clone());
    match state.mode {
        FirstFailureMode::HttpStatus => status_json(
            StatusCode::TOO_MANY_REQUESTS,
            json!({
                "type": "error",
                "error": {"type": "rate_limit_error", "message": "controlled first provider failure"}
            }),
        ),
        FirstFailureMode::TerminalErrorEvent => sse_response(
            "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"controlled first provider terminal error\"}}\n\n"
                .to_string(),
        ),
    }
}

async fn anthropic_incomplete_sse_upstream(
    State(state): State<Arc<IncompleteProviderState>>,
    headers: HeaderMap,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    send_capture(&state.captures, &headers, &uri, body.clone());
    let name = body["tools"][0]["name"]
        .as_str()
        .unwrap_or("functions.exec")
        .to_string();
    let events = [
        json!({"type":"message_start","message":{"id":"msg_partial","type":"message","role":"assistant","model":FIRST_WIRE_MODEL,"content":[],"usage":{"input_tokens":1}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"partial-call","name":name}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":format!("{{\"cmd\":\"{PARTIAL_SENTINEL}")}}),
    ];
    let mut wire = String::new();
    for event in events {
        wire.push_str(&format!(
            "event: {}\ndata: {event}\n\n",
            event["type"].as_str().unwrap()
        ));
    }
    sse_response(wire)
}

fn openai_chat_provider_tool_name(body: &Value, index: usize) -> String {
    body["tools"][index]["function"]["name"]
        .as_str()
        .or_else(|| body["tools"][index]["name"].as_str())
        .unwrap_or_else(|| panic!("provider tool {index} must carry a name: {}", body["tools"]))
        .to_string()
}

async fn openai_chat_success_upstream(
    State(state): State<Arc<SuccessProviderState>>,
    headers: HeaderMap,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    send_capture(&state.captures, &headers, &uri, body.clone());
    let stream = body["stream"] == true;
    let exec_name = openai_chat_provider_tool_name(&body, 0);
    let patch_name = openai_chat_provider_tool_name(&body, 1);
    let mcp_name = openai_chat_provider_tool_name(&body, 2);
    let exec_input = json!({"cmd": LONG_EXEC_COMMAND, "cwd": "/tmp"});
    let patch_input = json!({"input": LONG_PATCH});
    let mcp_input = json!({"arguments": {"query": MCP_QUERY, "limit": 3}});

    if stream {
        let tool_call_chunk = |index: usize, id: &str, name: &str, arguments: &Value| {
            json!({
                "id":"chatcmpl-req02-lifecycle",
                "object":"chat.completion.chunk",
                "model": SECOND_WIRE_MODEL,
                "choices":[{
                    "index":0,
                    "delta":{"tool_calls":[{
                        "index":index,
                        "id":id,
                        "type":"function",
                        "function":{"name":name,"arguments":arguments.to_string()}
                    }]},
                    "finish_reason":null
                }]
            })
        };
        let frames = [
            tool_call_chunk(0, "exec-call", &exec_name, &exec_input),
            tool_call_chunk(1, "patch-call", &patch_name, &patch_input),
            tool_call_chunk(2, "mcp-call", &mcp_name, &mcp_input),
            json!({
                "id":"chatcmpl-req02-lifecycle",
                "object":"chat.completion.chunk",
                "model": SECOND_WIRE_MODEL,
                "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]
            }),
        ];
        let mut wire = String::new();
        for frame in frames {
            wire.push_str(&format!("data: {frame}\n\n"));
        }
        wire.push_str("data: [DONE]\n\n");
        sse_response(wire)
    } else {
        json_response(json!({
            "id": "chatcmpl-req02-lifecycle",
            "object": "chat.completion",
            "model": SECOND_WIRE_MODEL,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {"id":"exec-call","type":"function","function":{"name":exec_name,"arguments":exec_input.to_string()}},
                        {"id":"patch-call","type":"function","function":{"name":patch_name,"arguments":patch_input.to_string()}},
                        {"id":"mcp-call","type":"function","function":{"name":mcp_name,"arguments":mcp_input.to_string()}}
                    ]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}
        }))
    }
}

fn anthropic_success_response(body: &Value) -> Response<Body> {
    let exec_name = body["tools"][0]["name"].as_str().unwrap().to_string();
    let patch_name = body["tools"][1]["name"].as_str().unwrap().to_string();
    let mcp_name = body["tools"][2]["name"].as_str().unwrap().to_string();
    json_response(json!({
        "id": "msg_req02_lifecycle_survivor",
        "type": "message",
        "role": "assistant",
        "model": FIRST_WIRE_MODEL,
        "content": [
            {"type":"tool_use","id":"exec-call","name":exec_name,"input":{"cmd":LONG_EXEC_COMMAND,"cwd":"/tmp"}},
            {"type":"tool_use","id":"patch-call","name":patch_name,"input":{"input":LONG_PATCH}},
            {"type":"tool_use","id":"mcp-call","name":mcp_name,"input":{"arguments":{"query":MCP_QUERY,"limit":3}}}
        ],
        "stop_reason": "tool_use",
        "stop_sequence": null,
        "usage": {"input_tokens": 11, "output_tokens": 7}
    }))
}

fn held_sse_response(
    started: mpsc::UnboundedSender<()>,
    dropped: mpsc::UnboundedSender<()>,
    release: Arc<Notify>,
) -> Response<Body> {
    let first_event = b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_hold\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"first-wire\",\"content\":[],\"usage\":{\"input_tokens\":1}}}\n\n".to_vec();
    let final_event = b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec();
    let completed = Arc::new(AtomicBool::new(false));
    let guard = DropSignal {
        tx: Some(dropped),
        completed: Arc::clone(&completed),
    };
    let state = (0u8, first_event, final_event, release, Some(started), guard);
    let body_stream = stream::unfold(
        state,
        move |(step, first, final_event, release, started, guard)| {
            let completed = Arc::clone(&completed);
            async move {
                match step {
                    0 => {
                        if let Some(started) = started {
                            let _ = started.send(());
                        }
                        Some((
                            Ok::<_, Infallible>(first.clone()),
                            (1, first, final_event, release, None, guard),
                        ))
                    }
                    1 => {
                        release.notified().await;
                        completed.store(true, Ordering::SeqCst);
                        Some((
                            Ok::<_, Infallible>(final_event.clone()),
                            (2, first, final_event, release, None, guard),
                        ))
                    }
                    _ => None,
                }
            }
        },
    );
    sse_body_response(Body::from_stream(body_stream))
}

async fn anthropic_cancellation_upstream(
    State(state): State<Arc<CancellationProviderState>>,
    headers: HeaderMap,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    send_capture(&state.captures, &headers, &uri, body.clone());
    if body.to_string().contains("hold") {
        held_sse_response(
            state.started.clone(),
            state.dropped.clone(),
            Arc::clone(&state.release),
        )
    } else {
        anthropic_success_response(&body)
    }
}

fn parse_sse_json(body: &str) -> Vec<Value> {
    let mut events = Vec::new();
    for frame in body.split("\n\n") {
        let data = frame
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(event) = serde_json::from_str(&data) {
            events.push(event);
        }
    }
    events
}

fn sse_event_count(body: &str, event_type: &str) -> usize {
    parse_sse_json(body)
        .iter()
        .filter(|event| event["type"] == event_type)
        .count()
}

fn client_tool_blocks_from_json(body: &Value) -> Vec<Value> {
    body["content"]
        .as_array()
        .expect("client Anthropic JSON content array")
        .iter()
        .filter(|block| block["type"] == "tool_use")
        .cloned()
        .collect()
}

fn client_tool_blocks_from_sse(body: &str) -> Vec<Value> {
    let events = parse_sse_json(body);
    let mut blocks: BTreeMap<u64, Value> = BTreeMap::new();
    for event in &events {
        match event["type"].as_str() {
            Some("content_block_start") => {
                if event["content_block"]["type"] == "tool_use" {
                    let index = event["index"].as_u64().expect("block index");
                    let block = event["content_block"].clone();
                    blocks.insert(index, block);
                }
            }
            Some("content_block_delta") => {
                if event["delta"]["type"] == "input_json_delta" {
                    let index = event["index"].as_u64().expect("delta index");
                    let partial = event["delta"]["partial_json"]
                        .as_str()
                        .expect("input_json_delta partial_json");
                    let block = blocks
                        .entry(index)
                        .or_insert_with(|| json!({"type":"tool_use","input":{}}));
                    let mut raw = block["_input_json"].as_str().unwrap_or("").to_string();
                    raw.push_str(partial);
                    block["_input_json"] = json!(raw);
                }
            }
            _ => {}
        }
    }
    blocks
        .into_values()
        .map(|mut block| {
            if let Some(raw) = block.get("_input_json").and_then(Value::as_str) {
                block["input"] = serde_json::from_str(raw).unwrap_or_else(|error| {
                    panic!("client SSE tool input must be valid JSON: {error}; raw={raw}")
                });
                block.as_object_mut().unwrap().remove("_input_json");
            }
            block
        })
        .collect()
}

fn tool_block<'a>(blocks: &'a [Value], name: &str) -> &'a Value {
    blocks
        .iter()
        .find(|block| block["name"] == name)
        .unwrap_or_else(|| {
            panic!("client output must contain restored tool block `{name}`: {blocks:?}")
        })
}

fn assert_restored_tool_blocks(blocks: &[Value]) {
    assert_eq!(
        blocks.len(),
        3,
        "client must expose exactly the successful attempt tools: {blocks:?}"
    );
    let exec = tool_block(blocks, "functions.exec");
    assert_eq!(exec["id"], "exec-call");
    assert_eq!(exec["input"]["cmd"], LONG_EXEC_COMMAND);
    assert_eq!(exec["input"]["cwd"], "/tmp");
    let patch = tool_block(blocks, "custom.apply_patch");
    assert_eq!(patch["id"], "patch-call");
    assert_eq!(patch["input"]["input"], LONG_PATCH);
    let mcp = tool_block(blocks, "mcp__search.find");
    assert_eq!(mcp["id"], "mcp-call");
    assert_eq!(mcp["input"]["arguments"]["query"], MCP_QUERY);
    assert_eq!(mcp["input"]["arguments"]["limit"], 3);
    for block in blocks {
        assert_ne!(block["name"], "functions__exec", "{block:?}");
        assert_ne!(block["name"], "custom__apply_patch", "{block:?}");
    }
}

fn assert_anthropic_first_capture(capture: &ProviderCapture, secret: &str, stream: bool) {
    let expected = format!("Bearer {secret}");
    assert_eq!(capture.path, "/v1/messages");
    assert_eq!(capture.authorization.as_deref(), Some(expected.as_str()));
    assert_eq!(capture.body["stream"], stream);
    let tools = capture.body["tools"].as_array().expect("provider tools");
    assert_eq!(tools[0]["name"], "functions.exec");
    assert_eq!(tools[1]["name"], "custom.apply_patch");
    assert_eq!(tools[2]["name"], "mcp__search__find");
}

fn assert_openai_chat_success_capture(capture: &ProviderCapture, secret: &str, stream: bool) {
    let expected = format!("Bearer {secret}");
    assert_eq!(capture.path, "/v1/chat/completions");
    assert_eq!(capture.authorization.as_deref(), Some(expected.as_str()));
    assert_eq!(capture.body["stream"], stream);
    let names = [
        openai_chat_provider_tool_name(&capture.body, 0),
        openai_chat_provider_tool_name(&capture.body, 1),
        openai_chat_provider_tool_name(&capture.body, 2),
    ];
    // These declarations have literal dotted names, not namespace containers.
    assert_eq!(names[0], "functions.exec");
    assert_eq!(names[1], "custom.apply_patch");
    assert_eq!(names[2], "mcp__search__find");
}

fn first_provider_spec(port: u16, health: bool) -> ProviderSpec {
    ProviderSpec {
        id: "first",
        provider_type: "anthropic",
        base_url: format!("http://127.0.0.1:{port}"),
        model: FIRST_WIRE_MODEL,
        key_env: FIRST_KEY_ENV,
        key_alias: "first",
        health,
    }
}

fn second_provider_spec(port: u16) -> ProviderSpec {
    ProviderSpec {
        id: "second",
        provider_type: "openai_chat",
        base_url: format!("http://127.0.0.1:{port}/v1"),
        model: SECOND_WIRE_MODEL,
        key_env: SECOND_KEY_ENV,
        key_alias: "second",
        health: false,
    }
}

#[tokio::test]
async fn req02_anthropic_failover_json_uses_successful_attempt_inverse() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(FIRST_KEY_ENV, FIRST_SECRET);
    std::env::set_var(SECOND_KEY_ENV, SECOND_SECRET);

    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    let first_app = Router::new()
        .route("/v1/messages", post(anthropic_first_failure_upstream))
        .with_state(Arc::new(FirstProviderState {
            captures: first_tx,
            mode: FirstFailureMode::HttpStatus,
        }));
    let (first_addr, first_upstream) = spawn_upstream(first_app).await;

    let (second_tx, mut second_rx) = mpsc::unbounded_channel();
    let second_app = Router::new()
        .route("/v1/chat/completions", post(openai_chat_success_upstream))
        .with_state(Arc::new(SuccessProviderState {
            captures: second_tx,
        }));
    let (second_addr, second_upstream) = spawn_upstream(second_app).await;

    let manifest = lifecycle_manifest(
        free_port(),
        &[
            first_provider_spec(first_addr.port(), true),
            second_provider_spec(second_addr.port()),
        ],
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let response = reqwest::Client::new()
        .post(&endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&anthropic_request(false, "complete all tools"))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/json");
    let body: Value = response.json().await.unwrap();
    assert!(
        body.get("error").is_none(),
        "client must not receive the first error: {body}"
    );
    assert_restored_tool_blocks(&client_tool_blocks_from_json(&body));

    let first_capture = recv_capture(&mut first_rx).await;
    assert_anthropic_first_capture(&first_capture, FIRST_SECRET, false);
    let second_capture = recv_capture(&mut second_rx).await;
    assert_openai_chat_success_capture(&second_capture, SECOND_SECRET, false);

    handle.shutdown().await;
    first_upstream.shutdown().await;
    second_upstream.shutdown().await;
    std::env::remove_var(FIRST_KEY_ENV);
    std::env::remove_var(SECOND_KEY_ENV);
}

#[tokio::test]
async fn req02_anthropic_failover_sse_uses_successful_attempt_inverse() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(FIRST_KEY_ENV, FIRST_SECRET);
    std::env::set_var(SECOND_KEY_ENV, SECOND_SECRET);

    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    let first_app = Router::new()
        .route("/v1/messages", post(anthropic_first_failure_upstream))
        .with_state(Arc::new(FirstProviderState {
            captures: first_tx,
            mode: FirstFailureMode::TerminalErrorEvent,
        }));
    let (first_addr, first_upstream) = spawn_upstream(first_app).await;

    let (second_tx, mut second_rx) = mpsc::unbounded_channel();
    let second_app = Router::new()
        .route("/v1/chat/completions", post(openai_chat_success_upstream))
        .with_state(Arc::new(SuccessProviderState {
            captures: second_tx,
        }));
    let (second_addr, second_upstream) = spawn_upstream(second_app).await;

    let manifest = lifecycle_manifest(
        free_port(),
        &[
            first_provider_spec(first_addr.port(), true),
            second_provider_spec(second_addr.port()),
        ],
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let response = reqwest::Client::new()
        .post(&endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&anthropic_request(true, "complete all tools"))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let body = String::from_utf8(response.bytes().await.unwrap().to_vec()).unwrap();
    assert!(!body.contains("event: error"), "{body}");
    assert!(!body.contains("overloaded_error"), "{body}");
    assert_eq!(sse_event_count(&body, "message_stop"), 1, "{body}");
    assert_restored_tool_blocks(&client_tool_blocks_from_sse(&body));

    let first_capture = recv_capture(&mut first_rx).await;
    assert_anthropic_first_capture(&first_capture, FIRST_SECRET, true);
    let second_capture = recv_capture(&mut second_rx).await;
    assert_openai_chat_success_capture(&second_capture, SECOND_SECRET, true);

    handle.shutdown().await;
    first_upstream.shutdown().await;
    second_upstream.shutdown().await;
    std::env::remove_var(FIRST_KEY_ENV);
    std::env::remove_var(SECOND_KEY_ENV);
}

#[tokio::test]
async fn req02_anthropic_incomplete_provider_sse_reselects_without_partial_tools() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(FIRST_KEY_ENV, FIRST_SECRET);
    std::env::set_var(SECOND_KEY_ENV, SECOND_SECRET);

    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    let first_app = Router::new()
        .route("/v1/messages", post(anthropic_incomplete_sse_upstream))
        .with_state(Arc::new(IncompleteProviderState { captures: first_tx }));
    let (first_addr, first_upstream) = spawn_upstream(first_app).await;

    let (second_tx, mut second_rx) = mpsc::unbounded_channel();
    let second_app = Router::new()
        .route("/v1/chat/completions", post(openai_chat_success_upstream))
        .with_state(Arc::new(SuccessProviderState {
            captures: second_tx,
        }));
    let (second_addr, second_upstream) = spawn_upstream(second_app).await;

    let manifest = lifecycle_manifest(
        free_port(),
        &[
            first_provider_spec(first_addr.port(), true),
            second_provider_spec(second_addr.port()),
        ],
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let response = reqwest::Client::new()
        .post(&endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&anthropic_request(true, "complete all tools"))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let body = String::from_utf8(response.bytes().await.unwrap().to_vec()).unwrap();
    assert!(
        !body.contains(PARTIAL_SENTINEL),
        "partial provider tool input must not reach the client: {body}"
    );
    assert!(!body.contains("event: error"), "{body}");
    assert_eq!(sse_event_count(&body, "message_stop"), 1, "{body}");
    assert_restored_tool_blocks(&client_tool_blocks_from_sse(&body));

    let first_capture = recv_capture(&mut first_rx).await;
    assert_anthropic_first_capture(&first_capture, FIRST_SECRET, true);
    let second_capture = recv_capture(&mut second_rx).await;
    assert_openai_chat_success_capture(&second_capture, SECOND_SECRET, true);

    handle.shutdown().await;
    first_upstream.shutdown().await;
    second_upstream.shutdown().await;
    std::env::remove_var(FIRST_KEY_ENV);
    std::env::remove_var(SECOND_KEY_ENV);
}

#[tokio::test]
async fn req02_anthropic_incomplete_provider_sse_exhaustion_does_not_fabricate_success() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(FIRST_KEY_ENV, FIRST_SECRET);

    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    let first_app = Router::new()
        .route("/v1/messages", post(anthropic_incomplete_sse_upstream))
        .with_state(Arc::new(IncompleteProviderState { captures: first_tx }));
    let (first_addr, first_upstream) = spawn_upstream(first_app).await;
    let manifest = lifecycle_manifest(
        free_port(),
        &[first_provider_spec(first_addr.port(), false)],
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);

    let response = reqwest::Client::new()
        .post(&endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&anthropic_request(true, "complete all tools"))
        .send()
        .await;

    match response {
        Ok(mut response) => {
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["content-type"], "text/event-stream");
            let mut wire = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => wire.extend_from_slice(&chunk),
                    Err(_) => break,
                    Ok(None) => panic!(
                        "exhausted incomplete provider must not complete the client SSE transfer"
                    ),
                }
            }
            let text = String::from_utf8_lossy(&wire);
            assert!(!text.contains(PARTIAL_SENTINEL), "{text}");
            assert!(!text.contains("event: error"), "{text}");
            assert!(!text.contains("message_stop"), "{text}");
            assert!(!text.contains("\"type\":\"tool_use\""), "{text}");
        }
        Err(error) => {
            assert!(
                error.is_request() || error.is_body() || error.is_decode(),
                "unexpected client transport error: {error}"
            );
        }
    }

    let first_capture = recv_capture(&mut first_rx).await;
    assert_anthropic_first_capture(&first_capture, FIRST_SECRET, true);

    handle.shutdown().await;
    first_upstream.shutdown().await;
    std::env::remove_var(FIRST_KEY_ENV);
}

#[tokio::test]
async fn req02_anthropic_client_disconnect_cancels_pending_provider_and_survivor_succeeds() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(FIRST_KEY_ENV, FIRST_SECRET);

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (started_tx, mut started_rx) = mpsc::unbounded_channel();
    let (dropped_tx, mut dropped_rx) = mpsc::unbounded_channel();
    let release = Arc::new(Notify::new());
    let state = Arc::new(CancellationProviderState {
        captures: captures_tx,
        started: started_tx,
        dropped: dropped_tx,
        release: Arc::clone(&release),
    });
    let app = Router::new()
        .route("/v1/messages", post(anthropic_cancellation_upstream))
        .with_state(state);
    let (upstream_addr, upstream) = spawn_upstream(app).await;
    let manifest = lifecycle_manifest(
        free_port(),
        &[first_provider_spec(upstream_addr.port(), false)],
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let addr = handle.listeners[0].addr;
    let endpoint = format!("http://{addr}/v1/messages");

    let request = anthropic_request(true, "hold");
    let request_body = serde_json::to_vec(&request).unwrap();
    let mut socket = TcpStream::connect(addr).await.unwrap();
    socket
        .write_all(
            format!(
                "POST /v1/messages HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                request_body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    socket.write_all(&request_body).await.unwrap();

    let held_capture = recv_capture(&mut captures_rx).await;
    assert_anthropic_first_capture(&held_capture, FIRST_SECRET, true);
    tokio::time::timeout(Duration::from_secs(3), started_rx.recv())
        .await
        .expect("runtime must poll the held provider stream")
        .expect("started channel must remain open");
    drop(socket);

    tokio::time::timeout(Duration::from_secs(3), dropped_rx.recv())
        .await
        .expect("client disconnect must drop the pending provider stream")
        .expect("dropped channel must remain open");

    let survivor = reqwest::Client::new()
        .post(&endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&anthropic_request(false, "survivor"))
        .send()
        .await
        .unwrap();
    assert_eq!(survivor.status(), StatusCode::OK);
    let survivor_body: Value = survivor.json().await.unwrap();
    assert_restored_tool_blocks(&client_tool_blocks_from_json(&survivor_body));
    let survivor_capture = recv_capture(&mut captures_rx).await;
    assert_eq!(
        survivor_capture.authorization.as_deref(),
        Some("Bearer req02-anthropic-lifecycle-first-secret")
    );
    assert_eq!(survivor_capture.body["stream"], false);
    assert_eq!(
        survivor_capture.body["messages"][0]["content"],
        json!([{"type":"text","text":"survivor"}])
    );

    release.notify_one();
    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(FIRST_KEY_ENV);
}
