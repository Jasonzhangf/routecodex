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

const GEMINI_JSON_REQUEST_SENTINEL: &str = "req02-gemini-json-provider-request-sentinel";
const GEMINI_JSON_RESPONSE_SENTINEL: &str = "req02-gemini-json-client-response-sentinel";
const GEMINI_SSE_REQUEST_SENTINEL: &str = "req02-gemini-sse-provider-request-sentinel";
const GEMINI_SSE_FIRST_SENTINEL: &str = "req02-gemini-sse-first-client-sentinel";
const GEMINI_SSE_FINAL_SENTINEL: &str = "req02-gemini-sse-final-client-sentinel";
const ANTHROPIC_JSON_REQUEST_SENTINEL: &str = "req02-anthropic-json-provider-request-sentinel";
const ANTHROPIC_JSON_RESPONSE_SENTINEL: &str = "req02-anthropic-json-client-response-sentinel";
const ANTHROPIC_SSE_REQUEST_SENTINEL: &str = "req02-anthropic-sse-provider-request-sentinel";
const ANTHROPIC_SSE_RESPONSE_SENTINEL: &str = "req02-anthropic-sse-client-response-sentinel";

const GEMINI_KEY_ENV: &str = "V3_REQ02_GEMINI_KEY";
const ANTHROPIC_KEY_ENV: &str = "V3_REQ02_ANTHROPIC_KEY";
const GEMINI_SECRET: &str = "req02-gemini-secret";
const ANTHROPIC_SECRET: &str = "req02-anthropic-secret";

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

async fn gemini_json_upstream(
    State(state): State<Arc<ProviderState>>,
    headers: HeaderMap,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture_provider_request(state.as_ref(), &headers, &uri, body);
    json_response(json!({
        "candidates": [{
            "index": 0,
            "finishReason": "STOP",
            "content": {
                "role": "model",
                "parts": [{"text": GEMINI_JSON_RESPONSE_SENTINEL}]
            }
        }],
        "usageMetadata": {
            "promptTokenCount": 3,
            "candidatesTokenCount": 5,
            "totalTokenCount": 8
        }
    }))
}

async fn gemini_sse_upstream(
    State(state): State<Arc<ProviderState>>,
    headers: HeaderMap,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture_provider_request(state.as_ref(), &headers, &uri, body);
    let first = json!({
        "candidates": [{
            "index": 0,
            "content": {
                "role": "model",
                "parts": [{"text": GEMINI_SSE_FIRST_SENTINEL}]
            },
            "finishReason": null
        }]
    });
    let final_event = json!({
        "candidates": [{
            "index": 0,
            "content": {
                "role": "model",
                "parts": [{"text": GEMINI_SSE_FINAL_SENTINEL}]
            },
            "finishReason": "STOP"
        }],
        "usageMetadata": {"totalTokenCount": 9}
    });
    sse_response(format!("data: {first}\n\ndata: {final_event}\n\n"))
}

async fn anthropic_json_upstream(
    State(state): State<Arc<ProviderState>>,
    headers: HeaderMap,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture_provider_request(state.as_ref(), &headers, &uri, body);
    json_response(json!({
        "id": "msg_req02_json",
        "type": "message",
        "role": "assistant",
        "model": "anthropic-wire",
        "content": [{
            "type": "text",
            "text": ANTHROPIC_JSON_RESPONSE_SENTINEL
        }],
        "stop_reason": "end_turn",
        "stop_sequence": null,
        "usage": {
            "input_tokens": 11,
            "output_tokens": 7
        }
    }))
}

async fn anthropic_sse_upstream(
    State(state): State<Arc<ProviderState>>,
    headers: HeaderMap,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture_provider_request(state.as_ref(), &headers, &uri, body);
    let events = [
        json!({
            "type": "message_start",
            "message": {
                "id": "msg_req02_sse",
                "type": "message",
                "role": "assistant",
                "model": "anthropic-wire",
                "content": [],
                "usage": {"input_tokens": 13}
            }
        }),
        json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""}
        }),
        json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": {
                "type": "text_delta",
                "text": ANTHROPIC_SSE_RESPONSE_SENTINEL
            }
        }),
        json!({
            "type": "content_block_stop",
            "index": 0
        }),
        json!({
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 9}
        }),
        json!({"type": "message_stop"}),
    ];
    let mut body = String::new();
    for event in events {
        body.push_str(&format!(
            "event: {}\ndata: {event}\n\n",
            event["type"].as_str().unwrap()
        ));
    }
    sse_response(body)
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
    let exec_arguments = r#"{"cmd":"printf '%s\n' 'literal $() and `bytes`'","cwd":"/tmp"}"#;
    let patch = "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n";
    let mcp_input = json!({
        "arguments": {"query": "find nested json", "limit": 3}
    });
    if stream {
        let exec_partial = json!({"cmd": "printf '%s\n' 'literal $() and `bytes`'"}).to_string();
        let patch_partial = json!({"input": patch}).to_string();
        let mcp_partial = json!({"arguments": {"query": "find nested json"}}).to_string();
        let events = [
            json!({"type":"message_start","message":{"id":"msg_req02_tools_sse","type":"message","role":"assistant","model":"anthropic-wire","content":[],"usage":{"input_tokens":1}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"exec-call","name":exec_name}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":exec_partial}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"patch-call","name":patch_name}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":patch_partial}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"mcp-call","name":mcp_name}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":mcp_partial}}),
            json!({"type":"content_block_stop","index":2}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":2}}),
            json!({"type":"message_stop"}),
        ];
        let mut wire = String::new();
        for event in events {
            wire.push_str(&format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap()));
        }
        sse_response(wire)
    } else {
        json_response(json!({
            "id": "msg_req02_tools",
            "type": "message",
            "role": "assistant",
            "model": "anthropic-wire",
            "content": [
                {"type": "tool_use", "id": "exec-call", "name": exec_name, "input": serde_json::from_str::<Value>(exec_arguments).unwrap()},
                {"type": "tool_use", "id": "patch-call", "name": patch_name, "input": {"input": patch}},
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

fn anthropic_message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        other => panic!("unexpected Anthropic message content shape: {other:?}"),
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn anthropic_tools_manifest(
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

fn gemini_manifest(
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
endpoints = ["gemini"]

{server_execution}

[providers.controlled]
type = "gemini"
base_url = "http://127.0.0.1:{upstream_port}/v1beta"
default_model = "gemini-wire"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "{GEMINI_KEY_ENV}" }}] }}
[providers.controlled.models.gemini-wire]
wire_name = "gemini-wire"
aliases = ["gemini-client"]
supports_streaming = true
capabilities = ["text"]
[route_groups.req02.pools.gemini_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "gemini", models = ["gemini-client"] }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "gemini-wire", key = "controlled", priority = 1 }}]
[route_groups.req02.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "gemini-wire", key = "controlled", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("req02"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
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

#[tokio::test]
async fn req02_gemini_json_relay_public_entry_round_trips_real_http_upstream() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(GEMINI_KEY_ENV, GEMINI_SECRET);

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route(
            "/v1beta/models/gemini-wire:generateContent",
            post(gemini_json_upstream),
        )
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let handle = spawn_v3_server_aggregate(gemini_manifest(free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let endpoint = format!(
        "http://{}/v1beta/models/gemini-client/generateContent",
        handle.listeners[0].addr
    );
    let response = reqwest::Client::new()
        .post(endpoint)
        .json(&json!({
            "contents": [{
                "role": "user",
                "parts": [{"text": GEMINI_JSON_REQUEST_SENTINEL}]
            }],
            "stream": false
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("application/json")),
        "Gemini JSON entry must return a JSON content type"
    );
    let body: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(
        body["candidates"][0]["content"]["parts"][0]["text"],
        GEMINI_JSON_RESPONSE_SENTINEL
    );
    assert_eq!(body["candidates"][0]["finishReason"], "STOP");
    assert_eq!(body["usageMetadata"]["totalTokenCount"], 8);

    let capture = recv_capture(&mut captures_rx).await;
    assert_eq!(capture.path, "/v1beta/models/gemini-wire:generateContent");
    assert_eq!(
        capture.authorization.as_deref(),
        Some("Bearer req02-gemini-secret")
    );
    assert_eq!(
        capture.body["contents"][0]["parts"][0]["text"],
        GEMINI_JSON_REQUEST_SENTINEL
    );
    assert!(capture.body.get("metadata_center").is_none());

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(GEMINI_KEY_ENV);
}

#[tokio::test]
async fn req02_gemini_sse_relay_public_entry_round_trips_real_http_upstream() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(GEMINI_KEY_ENV, GEMINI_SECRET);

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route(
            "/v1beta/models/gemini-wire:streamGenerateContent",
            post(gemini_sse_upstream),
        )
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let handle = spawn_v3_server_aggregate(gemini_manifest(free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let endpoint = format!(
        "http://{}/v1beta/models/gemini-client/generateContent",
        handle.listeners[0].addr
    );
    let response = reqwest::Client::new()
        .post(endpoint)
        .json(&json!({
            "contents": [{
                "role": "user",
                "parts": [{"text": GEMINI_SSE_REQUEST_SENTINEL}]
            }],
            "stream": true
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream")),
        "Gemini SSE entry must return an event-stream content type"
    );
    let body = String::from_utf8(response.bytes().await.unwrap().to_vec()).unwrap();
    let events = parse_sse_json(&body);
    assert!(
        events.iter().any(|event| {
            event["candidates"][0]["content"]["parts"][0]["text"] == GEMINI_SSE_FIRST_SENTINEL
        }),
        "Gemini SSE output must preserve the first sentinel: {body}"
    );
    assert!(
        events.iter().any(|event| {
            event["candidates"][0]["content"]["parts"][0]["text"] == GEMINI_SSE_FINAL_SENTINEL
        }),
        "Gemini SSE output must preserve the final sentinel: {body}"
    );
    assert!(
        events
            .iter()
            .any(|event| event["candidates"][0]["finishReason"] == "STOP"),
        "Gemini SSE output must preserve the terminal finish reason: {body}"
    );
    assert!(
        events
            .iter()
            .any(|event| event["usageMetadata"]["totalTokenCount"] == 9),
        "Gemini SSE output must preserve usage metadata: {body}"
    );
    assert!(
        !body.contains("[DONE]"),
        "Gemini SSE must not use Chat [DONE]"
    );

    let capture = recv_capture(&mut captures_rx).await;
    assert_eq!(
        capture.path,
        "/v1beta/models/gemini-wire:streamGenerateContent"
    );
    assert_eq!(
        capture.authorization.as_deref(),
        Some("Bearer req02-gemini-secret")
    );
    assert_eq!(
        capture.body["contents"][0]["parts"][0]["text"],
        GEMINI_SSE_REQUEST_SENTINEL
    );
    assert!(capture.body.get("metadata_center").is_none());

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(GEMINI_KEY_ENV);
}

#[tokio::test]
async fn req02_anthropic_json_relay_public_entry_round_trips_real_http_upstream() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(ANTHROPIC_KEY_ENV, ANTHROPIC_SECRET);

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/messages", post(anthropic_json_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let handle = spawn_v3_server_aggregate(anthropic_manifest(free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": "anthropic-client",
            "max_tokens": 64,
            "messages": [{
                "role": "user",
                "content": ANTHROPIC_JSON_REQUEST_SENTINEL
            }],
            "stream": false
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("application/json")),
        "Anthropic JSON entry must return a JSON content type"
    );
    let body: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(body["type"], "message");
    assert_eq!(body["role"], "assistant");
    assert_eq!(body["content"][0]["type"], "text");
    assert_eq!(body["content"][0]["text"], ANTHROPIC_JSON_RESPONSE_SENTINEL);
    assert_eq!(body["stop_reason"], "end_turn");
    assert_eq!(body["usage"]["output_tokens"], 7);

    let capture = recv_capture(&mut captures_rx).await;
    assert_eq!(capture.path, "/v1/messages");
    assert_eq!(
        capture.authorization.as_deref(),
        Some("Bearer req02-anthropic-secret")
    );
    assert_eq!(capture.body["model"], "anthropic-wire");
    assert_eq!(capture.body["stream"], false);
    assert_eq!(
        anthropic_message_text(&capture.body["messages"][0]),
        ANTHROPIC_JSON_REQUEST_SENTINEL
    );
    assert!(capture.body.get("metadata_center").is_none());

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(ANTHROPIC_KEY_ENV);
}

#[tokio::test]
async fn req02_anthropic_sse_relay_public_entry_round_trips_real_http_upstream() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(ANTHROPIC_KEY_ENV, ANTHROPIC_SECRET);

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/messages", post(anthropic_sse_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let handle = spawn_v3_server_aggregate(anthropic_manifest(free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": "anthropic-client",
            "max_tokens": 64,
            "messages": [{
                "role": "user",
                "content": ANTHROPIC_SSE_REQUEST_SENTINEL
            }],
            "stream": true
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream")),
        "Anthropic SSE entry must return an event-stream content type"
    );
    let body = String::from_utf8(response.bytes().await.unwrap().to_vec()).unwrap();
    let events = parse_sse_json(&body);
    assert_eq!(events.first().unwrap()["type"], "message_start");
    let text = events
        .iter()
        .filter(|event| event["type"] == "content_block_delta")
        .filter_map(|event| event["delta"]["text"].as_str())
        .collect::<String>();
    assert_eq!(text, ANTHROPIC_SSE_RESPONSE_SENTINEL, "{body}");
    assert!(
        events.iter().any(|event| {
            event["type"] == "message_delta" && event["delta"]["stop_reason"] == "end_turn"
        }),
        "Anthropic SSE output must preserve the terminal stop reason: {body}"
    );
    assert_eq!(events.last().unwrap()["type"], "message_stop");
    assert!(body.contains("event: message_stop"), "{body}");

    let capture = recv_capture(&mut captures_rx).await;
    assert_eq!(capture.path, "/v1/messages");
    assert_eq!(
        capture.authorization.as_deref(),
        Some("Bearer req02-anthropic-secret")
    );
    assert_eq!(capture.body["model"], "anthropic-wire");
    assert_eq!(capture.body["stream"], true);
    assert_eq!(
        anthropic_message_text(&capture.body["messages"][0]),
        ANTHROPIC_SSE_REQUEST_SENTINEL
    );
    assert!(capture.body.get("metadata_center").is_none());

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(ANTHROPIC_KEY_ENV);
}

#[tokio::test]
async fn req02_anthropic_json_relay_recovers_declared_tools_from_successful_attempt() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(ANTHROPIC_KEY_ENV, ANTHROPIC_SECRET);
    let capture = anthropic_tool_relay_capture(false).await;
    std::env::remove_var(ANTHROPIC_KEY_ENV);

    let body: Value = serde_json::from_str(&capture.response_body).unwrap();
    eprintln!("ANTHROPIC_JSON_BODY={body}");
    assert_eq!(body["stop_reason"], "tool_use");
    let names = body["content"].as_array().unwrap();
    assert_eq!(names[0]["name"], "functions.exec");
    assert_eq!(names[0]["id"], "exec-call");
    assert_eq!(
        names[0]["input"]["cmd"],
        "printf '%s\n' 'literal $() and `bytes`'"
    );
    assert_eq!(names[1]["name"], "custom.apply_patch");
    assert_eq!(names[1]["id"], "patch-call");
    assert_eq!(
        names[1]["input"]["input"],
        "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n"
    );
    assert_eq!(names[2]["name"], "mcp__search.find");
    assert_eq!(names[2]["id"], "mcp-call");
    assert_eq!(
        names[2]["input"]["arguments"]["query"],
        "find nested json"
    );
    assert_provider_tool_names_changed(&capture.provider_body);
}

#[tokio::test]
async fn req02_anthropic_sse_relay_recovers_declared_tools_from_successful_attempt() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(ANTHROPIC_KEY_ENV, ANTHROPIC_SECRET);
    let capture = anthropic_tool_relay_capture(true).await;
    std::env::remove_var(ANTHROPIC_KEY_ENV);

    let events = parse_sse_json(&capture.response_body);
    eprintln!("ANTHROPIC_SSE_EVENTS={events:?}");
    let blocks = events
        .iter()
        .filter(|event| event["type"] == "content_block_start")
        .map(|event| event["content_block"].clone())
        .collect::<Vec<_>>();
    assert_eq!(blocks[0]["type"], "tool_use");
    assert_eq!(blocks[0]["name"], "functions.exec");
    assert_eq!(blocks[0]["id"], "exec-call");
    assert_eq!(
        blocks[0]["input"]["cmd"],
        "printf '%s\n' 'literal $() and `bytes`'"
    );
    assert_eq!(blocks[1]["type"], "tool_use");
    assert_eq!(blocks[1]["name"], "custom.apply_patch");
    assert_eq!(blocks[1]["id"], "patch-call");
    assert_eq!(
        blocks[1]["input"]["input"],
        "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n"
    );
    assert_eq!(blocks[2]["type"], "tool_use");
    assert_eq!(blocks[2]["name"], "mcp__search.find");
    assert_eq!(blocks[2]["id"], "mcp-call");
    assert_eq!(
        blocks[2]["input"]["arguments"]["query"],
        "find nested json"
    );
    assert!(
        events.iter().any(|event| {
            event["type"] == "message_delta" && event["delta"]["stop_reason"] == "tool_use"
        })
    );
    assert_provider_tool_names_changed(&capture.provider_body);
}

struct AnthropicToolCapture {
    response_body: String,
    provider_body: Value,
}

fn assert_provider_tool_names_changed(provider_body: &Value) {
    let tools = provider_body["tools"].as_array().expect("provider tools");
    let provider_names = tools
        .iter()
        .map(|tool| tool["name"].as_str().expect("provider tool name"))
        .collect::<Vec<_>>();
    assert_eq!(provider_names[0], "functions.exec");
    assert_eq!(provider_names[1], "custom.apply_patch");
    assert_ne!(provider_names[2], "mcp__search.find");
}

async fn anthropic_tool_relay_capture(stream: bool) -> AnthropicToolCapture {
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/messages", post(anthropic_tool_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;
    let handle = spawn_v3_server_aggregate(anthropic_tools_manifest(
        free_port(),
        upstream_addr.port(),
    ))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": "anthropic-client",
            "max_tokens": 64,
            "stream": stream,
            "messages": [{
                "role": "user",
                "content": "complete all tools"
            }],
            "tools": [
                {"name": "functions.exec", "input_schema": {"type": "object"}},
                {"name": "custom.apply_patch", "input_schema": {"type": "object"}},
                {"name": "mcp__search.find", "input_schema": {"type": "object"}}
            ]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let response_body = String::from_utf8(response.bytes().await.unwrap().to_vec()).unwrap();
    let capture = recv_capture(&mut captures_rx).await;
    let provider_body = capture.body;
    eprintln!("ANTHROPIC_PROVIDER_BODY={provider_body}");
    handle.shutdown().await;
    upstream.shutdown().await;
    AnthropicToolCapture {
        response_body,
        provider_body,
    }
}
