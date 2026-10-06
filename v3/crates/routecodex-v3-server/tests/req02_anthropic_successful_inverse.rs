use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    response::Response,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    net::{SocketAddr, TcpListener},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, Mutex},
    task::JoinHandle,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const ANTHROPIC_KEY_ENV: &str = "V3_REQ02_ANTHROPIC_SUCCESSFUL_INVERSE_KEY";
const ANTHROPIC_SECRET: &str = "req02-anthropic-successful-inverse-secret";

const LONG_EXEC_COMMAND: &str =
    "printf '%s\\n' 'literal $() and `bytes`' && printf '%s\\n' 'req02-exec-long-value'";
const LONG_PATCH: &str =
    "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n";
const MCP_QUERY: &str = "find nested json with complete arguments";

#[derive(Debug)]
struct ProviderCapture {
    path: String,
    authorization: Option<String>,
    body: Value,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
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

fn capture_provider_request(state: &ProviderState, headers: &HeaderMap, uri: &Uri, body: Value) {
    state
        .captures
        .send(ProviderCapture {
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

fn sse_response(body: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

async fn anthropic_tool_upstream(
    State(state): State<Arc<ProviderState>>,
    headers: HeaderMap,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture_provider_request(state.as_ref(), &headers, &uri, body.clone());
    let stream = body["stream"] == true;
    let exec_name = body["tools"][0]["name"].as_str().unwrap().to_string();
    let patch_name = body["tools"][1]["name"].as_str().unwrap().to_string();
    let mcp_name = body["tools"][2]["name"].as_str().unwrap().to_string();
    let exec_input = json!({
        "cmd": LONG_EXEC_COMMAND,
        "cwd": "/tmp",
    });
    let patch_input = json!({"input": LONG_PATCH});
    let mcp_input = json!({
        "arguments": {
            "query": MCP_QUERY,
            "limit": 3,
        }
    });

    if stream {
        let events = [
            json!({"type":"message_start","message":{"id":"msg_req02_successful_inverse_sse","type":"message","role":"assistant","model":"anthropic-wire","content":[],"usage":{"input_tokens":1}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"exec-call","name":exec_name}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":exec_input.to_string()}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"patch-call","name":patch_name}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":patch_input.to_string()}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"mcp-call","name":mcp_name}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":mcp_input.to_string()}}),
            json!({"type":"content_block_stop","index":2}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":2}}),
            json!({"type":"message_stop"}),
        ];
        let mut wire = String::new();
        for event in events {
            wire.push_str(&format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            ));
        }
        sse_response(wire)
    } else {
        json_response(json!({
            "id": "msg_req02_successful_inverse",
            "type": "message",
            "role": "assistant",
            "model": "anthropic-wire",
            "content": [
                {"type": "tool_use", "id": "exec-call", "name": exec_name, "input": exec_input},
                {"type": "tool_use", "id": "patch-call", "name": patch_name, "input": patch_input},
                {"type": "tool_use", "id": "mcp-call", "name": mcp_name, "input": mcp_input}
            ],
            "stop_reason": "tool_use",
            "stop_sequence": null,
            "usage": {"input_tokens": 11, "output_tokens": 7}
        }))
    }
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

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn anthropic_manifest(
    server_port: u16,
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.req02]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req02"
endpoints = ["anthropic"]

{server_execution}

[providers.controlled]
type = "anthropic"
base_url = "http://127.0.0.1:{upstream_port}"
default_model = "anthropic-wire"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "{ANTHROPIC_KEY_ENV}" }}] }}
[providers.controlled.models.anthropic-wire]
wire_name = "anthropic-wire"
aliases = ["anthropic-client"]
capabilities = ["text"]
supports_streaming = true
supports_thinking = false
max_tokens = 4096
max_context_tokens = 128000
[route_groups.req02.pools.anthropic_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "anthropic", models = ["anthropic-client"] }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "anthropic-wire", key = "controlled", priority = 1 }}]
[route_groups.req02.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "anthropic-wire", key = "controlled", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("req02"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn anthropic_request(stream: bool) -> Value {
    json!({
        "model": "anthropic-client",
        "max_tokens": 128,
        "stream": stream,
        "messages": [{
            "role": "user",
            "content": "complete all tools with long values"
        }],
        "tools": [
            {"name": "functions.exec", "input_schema": {"type": "object"}},
            {"name": "custom.apply_patch", "input_schema": {"type": "object"}},
            {"name": "mcp__search.find", "input_schema": {"type": "object"}}
        ]
    })
}

fn assert_provider_names(capture: &ProviderCapture) {
    assert_eq!(capture.path, "/v1/messages");
    assert_eq!(
        capture.authorization.as_deref(),
        Some("Bearer req02-anthropic-successful-inverse-secret")
    );
    let tools = capture.body["tools"].as_array().expect("provider tools");
    let names = tools
        .iter()
        .map(|tool| tool["name"].as_str().expect("provider tool name"))
        .collect::<Vec<_>>();
    assert_eq!(names[0], "functions.exec");
    assert_eq!(names[1], "custom.apply_patch");
    assert_ne!(names[2], "mcp__search.find");
}

fn assert_client_tool_blocks(blocks: &[Value]) {
    assert_eq!(blocks[0]["name"], "functions.exec");
    assert_eq!(blocks[0]["id"], "exec-call");
    assert_eq!(blocks[0]["input"]["cmd"], LONG_EXEC_COMMAND);
    assert_eq!(blocks[0]["input"]["cwd"], "/tmp");
    assert_eq!(blocks[1]["name"], "custom.apply_patch");
    assert_eq!(blocks[1]["id"], "patch-call");
    assert_eq!(blocks[1]["input"]["input"], LONG_PATCH);
    assert_eq!(blocks[2]["name"], "mcp__search.find");
    assert_eq!(blocks[2]["id"], "mcp-call");
    assert_eq!(blocks[2]["input"]["arguments"]["query"], MCP_QUERY);
    assert_eq!(blocks[2]["input"]["arguments"]["limit"], 3);
}

// --- openai_chat provider wire (the other supported wire representation) ---
//
// The Anthropic entry also serves `openai_chat` provider candidates. Their wire
// carries the emitted `__`-encoded name in
// `choices[0].message.tool_calls[].function.name`, so the same successful-attempt
// typed view must restore the original dotted identity before client framing.

fn openai_chat_provider_tool_name(body: &Value, index: usize) -> String {
    body["tools"][index]["function"]["name"]
        .as_str()
        .or_else(|| body["tools"][index]["name"].as_str())
        .unwrap_or_else(|| panic!("provider tool {index} must carry a name: {}", body["tools"]))
        .to_string()
}

async fn anthropic_openai_chat_tool_upstream(
    State(state): State<Arc<ProviderState>>,
    headers: HeaderMap,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture_provider_request(state.as_ref(), &headers, &uri, body.clone());
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
                "id":"chatcmpl-req02-openai-chat-inverse-sse",
                "object":"chat.completion.chunk",
                "model":"chat-wire",
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
                "id":"chatcmpl-req02-openai-chat-inverse-sse",
                "object":"chat.completion.chunk",
                "model":"chat-wire",
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
            "id": "chatcmpl-req02-openai-chat-inverse",
            "object": "chat.completion",
            "model": "chat-wire",
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

fn assert_openai_chat_provider_names(capture: &ProviderCapture) {
    assert_eq!(capture.path, "/v1/chat/completions");
    assert_eq!(
        capture.authorization.as_deref(),
        Some("Bearer req02-anthropic-successful-inverse-secret")
    );
    let emitted_mcp = openai_chat_provider_tool_name(&capture.body, 2);
    assert_ne!(
        emitted_mcp, "mcp__search.find",
        "the openai_chat wire must carry the emitted namespace-encoded name"
    );
}

fn client_tool_block_by_name<'a>(blocks: &'a [Value], name: &str) -> &'a Value {
    blocks
        .iter()
        .find(|block| block["name"] == name)
        .unwrap_or_else(|| panic!("client output must contain restored tool block `{name}`: {blocks:?}"))
}

fn assert_client_tool_blocks_restored(blocks: &[Value]) {
    let exec = client_tool_block_by_name(blocks, "functions.exec");
    assert_eq!(exec["id"], "exec-call");
    assert_eq!(exec["input"]["cmd"], LONG_EXEC_COMMAND);
    assert_eq!(exec["input"]["cwd"], "/tmp");
    let patch = client_tool_block_by_name(blocks, "custom.apply_patch");
    assert_eq!(patch["id"], "patch-call");
    assert_eq!(patch["input"]["input"], LONG_PATCH);
    let mcp = client_tool_block_by_name(blocks, "mcp__search.find");
    assert_eq!(mcp["id"], "mcp-call");
    assert_eq!(mcp["input"]["arguments"]["query"], MCP_QUERY);
    assert_eq!(mcp["input"]["arguments"]["limit"], 3);
}

fn anthropic_openai_chat_manifest(
    server_port: u16,
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.req02]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req02"
endpoints = ["anthropic"]

{server_execution}

[providers.controlled]
type = "openai_chat"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "chat-wire"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "{ANTHROPIC_KEY_ENV}" }}] }}
[providers.controlled.models.chat-wire]
wire_name = "chat-wire"
aliases = ["anthropic-client"]
capabilities = ["text", "tools"]
supports_streaming = true
[route_groups.req02.pools.anthropic_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "anthropic", models = ["anthropic-client"] }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "chat-wire", key = "controlled", priority = 1 }}]
[route_groups.req02.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "chat-wire", key = "controlled", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("req02"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

#[tokio::test]
async fn req02_anthropic_successful_inverse_openai_chat_wire_json_restores_original_identity() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(ANTHROPIC_KEY_ENV, ANTHROPIC_SECRET);

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(anthropic_openai_chat_tool_upstream),
        )
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;
    let handle = spawn_v3_server_aggregate(anthropic_openai_chat_manifest(
        free_port(),
        upstream_addr.port(),
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&anthropic_request(false))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    let blocks = body["content"].as_array().expect("client tool blocks");
    assert_client_tool_blocks_restored(blocks);

    let capture = recv_capture(&mut captures_rx).await;
    assert_openai_chat_provider_names(&capture);

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(ANTHROPIC_KEY_ENV);
}

#[tokio::test]
async fn req02_anthropic_successful_inverse_openai_chat_wire_sse_restores_original_identity() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(ANTHROPIC_KEY_ENV, ANTHROPIC_SECRET);

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(anthropic_openai_chat_tool_upstream),
        )
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;
    let handle = spawn_v3_server_aggregate(anthropic_openai_chat_manifest(
        free_port(),
        upstream_addr.port(),
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&anthropic_request(true))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = String::from_utf8(response.bytes().await.unwrap().to_vec()).unwrap();
    let events = parse_sse_json(&body);
    let blocks = events
        .iter()
        .filter(|event| event["type"] == "content_block_start")
        .map(|event| event["content_block"].clone())
        .collect::<Vec<_>>();
    assert_client_tool_blocks_restored(&blocks);

    let capture = recv_capture(&mut captures_rx).await;
    assert_openai_chat_provider_names(&capture);

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(ANTHROPIC_KEY_ENV);
}

#[tokio::test]
async fn req02_anthropic_successful_inverse_json_restores_original_identity() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(ANTHROPIC_KEY_ENV, ANTHROPIC_SECRET);

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/messages", post(anthropic_tool_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;
    let handle = spawn_v3_server_aggregate(anthropic_manifest(
        free_port(),
        upstream_addr.port(),
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&anthropic_request(false))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    let blocks = body["content"].as_array().expect("client tool blocks");
    assert_client_tool_blocks(blocks);

    let capture = recv_capture(&mut captures_rx).await;
    assert_provider_names(&capture);

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(ANTHROPIC_KEY_ENV);
}

#[tokio::test]
async fn req02_anthropic_successful_inverse_sse_restores_original_identity() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(ANTHROPIC_KEY_ENV, ANTHROPIC_SECRET);

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/messages", post(anthropic_tool_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;
    let handle = spawn_v3_server_aggregate(anthropic_manifest(
        free_port(),
        upstream_addr.port(),
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&anthropic_request(true))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = String::from_utf8(response.bytes().await.unwrap().to_vec()).unwrap();
    let events = parse_sse_json(&body);
    let blocks = events
        .iter()
        .filter(|event| event["type"] == "content_block_start")
        .map(|event| event["content_block"].clone())
        .collect::<Vec<_>>();
    assert_client_tool_blocks(&blocks);

    let capture = recv_capture(&mut captures_rx).await;
    assert_provider_names(&capture);

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(ANTHROPIC_KEY_ENV);
}
