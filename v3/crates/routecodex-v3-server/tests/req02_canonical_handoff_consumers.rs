//! REQ02 R26 canonical Direct-to-Relay handoff public consumers.
//!
//! These tests drive the real aggregate HTTP entry. A cross-protocol Chat or
//! Responses request runs the Direct phase, which executes REQ02 once and
//! publishes the original request pair, then selects a Relay target. The typed
//! handoff moves the already-normalized canonical Value plus the captured
//! target/candidates/control into the shared Relay skeleton. The tests assert
//! the first provider attempt reaches the originally selected target, the
//! canonical business payload survives to the provider wire, the original pair
//! is not republished, and the client receives a success frame.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_runtime::operation_runner::{RequestNormalizationEntry, RequestOriginKind};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

static TEST_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

const CHAT_KEY_ENV: &str = "V3_REQ02_CANONICAL_HANDOFF_CHAT_KEY";
const CHAT_SECRET: &str = "req02-canonical-handoff-secret";

const USER_TEXT_SENTINEL: &str = "req02-canonical-handoff-user-text";
const OPAQUE_TAIL_SENTINEL: &str = "req02-canonical-handoff-opaque-tail";
const EXEC_CALL_ID: &str = "call_req02_exec";
const CUSTOM_CALL_ID: &str = "call_req02_custom";
const MCP_CALL_ID: &str = "call_req02_mcp";
const MCP_TOOL_NAME: &str = "mcp__req02__lookup";
const PROVIDER_JSON_TEXT: &str = "req02 canonical handoff json ok";
const PROVIDER_SSE_TEXT: &str = "req02 canonical handoff sse ok";

#[derive(Clone, Copy, PartialEq, Eq)]
enum UpstreamReply {
    JsonOk,
    SseOk,
}

struct UpstreamControl {
    reply: UpstreamReply,
    captured: Mutex<Vec<Value>>,
}

impl UpstreamControl {
    fn captures(&self) -> Vec<Value> {
        self.captured.lock().unwrap().clone()
    }
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

async fn controlled_responses_upstream(
    State(control): State<Arc<UpstreamControl>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    control.captured.lock().unwrap().push(body);
    match control.reply {
        UpstreamReply::JsonOk => json_response(json!({
            "id": "resp_req02_canonical_handoff_json",
            "status": "completed",
            "output": [{"type": "output_text", "text": PROVIDER_JSON_TEXT}],
            "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
        })),
        UpstreamReply::SseOk => sse_response(format!(
            concat!(
                "event: response.output_text.delta\n",
                "data: {{\"type\":\"response.output_text.delta\",\"delta\":\"{text}\"}}\n\n",
                "event: response.completed\n",
                "data: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_req02_canonical_handoff_sse\",\"status\":\"completed\",\"output\":[{{\"type\":\"output_text\",\"text\":\"{text}\"}}],\"usage\":{{\"input_tokens\":3,\"output_tokens\":3,\"total_tokens\":6}}}}}}\n\n"
            ),
            text = PROVIDER_SSE_TEXT,
        )),
    }
}

async fn start_upstream(
    reply: UpstreamReply,
) -> (
    std::net::SocketAddr,
    Arc<UpstreamControl>,
    oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let control = Arc::new(UpstreamControl {
        reply,
        captured: Mutex::new(Vec::new()),
    });
    let app = Router::new()
        .route("/v1/responses", post(controlled_responses_upstream))
        .with_state(Arc::clone(&control));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (address, control, shutdown_tx)
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Chat entry (`/v1/chat/completions`) routed to a Responses provider. The
/// entry protocol differs from the target protocol, so the Direct phase selects
/// Relay and produces the canonical handoff the tests exercise.
fn chat_to_responses_manifest(server_port: u16, upstream_port: u16) -> V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.req02]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req02"
endpoints = ["openai_chat"]

{server_execution}

[providers.controlled]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "responses-wire"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "{CHAT_KEY_ENV}" }}] }}
[providers.controlled.models.responses-wire]
wire_name = "responses-wire"
aliases = ["chat-client"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[route_groups.req02.pools.chat_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["chat-client"] }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "responses-wire", key = "controlled", priority = 1 }}]
[route_groups.req02.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "responses-wire", key = "controlled", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("req02"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

/// Canonical Chat request carrying the complete exec/custom-patch/MCP tool
/// history plus an opaque business tail the proxy must forward unchanged.
fn canonical_chat_request(stream: bool) -> Value {
    json!({
        "model": "chat-client",
        "stream": stream,
        "messages": [
            {"role": "system", "content": "req02 canonical handoff system"},
            {"role": "user", "content": USER_TEXT_SENTINEL},
            {
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {
                        "id": EXEC_CALL_ID,
                        "type": "function",
                        "function": {"name": "exec_command", "arguments": "{\"cmd\":\"echo req02 exec\"}"}
                    },
                    {
                        "id": CUSTOM_CALL_ID,
                        "type": "custom",
                        "custom": {"name": "apply_patch", "input": "*** Begin Patch\n*** End Patch\n"}
                    },
                    {
                        "id": MCP_CALL_ID,
                        "type": "function",
                        "function": {"name": MCP_TOOL_NAME, "arguments": "{\"query\":\"req02 mcp\"}"}
                    }
                ]
            },
            {"role": "tool", "tool_call_id": EXEC_CALL_ID, "content": "req02 exec output"},
            {"role": "tool", "tool_call_id": CUSTOM_CALL_ID, "content": "req02 custom patch output"},
            {"role": "tool", "tool_call_id": MCP_CALL_ID, "content": "req02 mcp output"}
        ],
        "x_req02_opaque_tail": {"marker": OPAQUE_TAIL_SENTINEL}
    })
}

fn serialized_contains(value: &Value, needle: &str) -> bool {
    serde_json::to_string(value)
        .map(|serialized| serialized.contains(needle))
        .unwrap_or(false)
}

const CHAT_PROVIDER_TEXT: &str = "req02 canonical handoff chat provider ok";

async fn controlled_chat_upstream(
    State(control): State<Arc<UpstreamControl>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    control.captured.lock().unwrap().push(body);
    json_response(json!({
        "id": "chatcmpl-req02-canonical-handoff",
        "object": "chat.completion",
        "created": 7,
        "model": "chat-wire",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": CHAT_PROVIDER_TEXT},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}
    }))
}

async fn start_chat_upstream() -> (
    std::net::SocketAddr,
    Arc<UpstreamControl>,
    oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let control = Arc::new(UpstreamControl {
        reply: UpstreamReply::JsonOk,
        captured: Mutex::new(Vec::new()),
    });
    let app = Router::new()
        .route("/v1/chat/completions", post(controlled_chat_upstream))
        .with_state(Arc::clone(&control));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (address, control, shutdown_tx)
}

/// Responses entry (`/v1/responses`) routed to an OpenAI Chat provider. The
/// Direct phase again selects Relay and produces the canonical handoff; the
/// Responses Relay entry consumes the moved canonical Value and captured
/// target without a second normalization.
fn responses_to_chat_manifest(server_port: u16, upstream_port: u16) -> V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.req02]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req02"
endpoints = ["responses"]

{server_execution}

[providers.controlled]
type = "openai_chat"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "chat-wire"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "{CHAT_KEY_ENV}" }}] }}
responses = {{ process = "chat", streaming = "always" }}
[providers.controlled.models.chat-wire]
wire_name = "chat-wire"
aliases = ["responses-client"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[route_groups.req02.pools.responses_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["responses-client"] }}
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

fn canonical_responses_request() -> Value {
    json!({
        "model": "responses-client",
        "stream": false,
        "input": [
            {"role": "user", "content": USER_TEXT_SENTINEL},
            {
                "type": "function_call",
                "call_id": EXEC_CALL_ID,
                "name": "exec_command",
                "arguments": "{\"cmd\":\"echo req02 exec\"}"
            },
            {
                "type": "function_call_output",
                "call_id": EXEC_CALL_ID,
                "output": "req02 exec output"
            }
        ],
        "x_req02_opaque_tail": {"marker": OPAQUE_TAIL_SENTINEL}
    })
}

#[tokio::test]
async fn req02_chat_canonical_handoff_json_reaches_selected_target_via_real_http() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(CHAT_KEY_ENV, CHAT_SECRET);

    let (upstream_addr, upstream, shutdown) = start_upstream(UpstreamReply::JsonOk).await;
    let manifest = chat_to_responses_manifest(free_port(), upstream_addr.port());
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);

    let response = reqwest::Client::new()
        .post(endpoint)
        .json(&canonical_chat_request(false))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        content_type.starts_with("application/json"),
        "Chat JSON entry must return a JSON content type: {content_type}"
    );
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["choices"][0]["message"]["content"], PROVIDER_JSON_TEXT);

    let captures = upstream.captures();
    assert_eq!(
        captures.len(),
        1,
        "the canonical handoff must reach the originally selected target exactly once"
    );
    let capture = &captures[0];
    assert_eq!(
        capture["model"], "responses-wire",
        "the first attempt must consume the Direct-selected target"
    );
    assert!(
        serialized_contains(capture, USER_TEXT_SENTINEL),
        "the provider payload must preserve the canonical user text: {capture}"
    );
    assert!(
        serialized_contains(capture, EXEC_CALL_ID)
            && serialized_contains(capture, CUSTOM_CALL_ID)
            && serialized_contains(capture, MCP_CALL_ID),
        "the provider payload must preserve the complete exec/custom/MCP history: {capture}"
    );
    assert!(
        serialized_contains(capture, MCP_TOOL_NAME),
        "the provider payload must preserve the MCP tool identity: {capture}"
    );
    assert!(
        capture.get("metadata_center").is_none(),
        "control facts must not be mirrored into the provider payload"
    );

    handle.shutdown().await;
    let _ = shutdown.send(());
    std::env::remove_var(CHAT_KEY_ENV);
}

#[tokio::test]
async fn req02_chat_canonical_handoff_sse_reaches_selected_target_via_real_http() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(CHAT_KEY_ENV, CHAT_SECRET);

    let (upstream_addr, upstream, shutdown) = start_upstream(UpstreamReply::SseOk).await;
    let manifest = chat_to_responses_manifest(free_port(), upstream_addr.port());
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);

    let response = reqwest::Client::new()
        .post(endpoint)
        .json(&canonical_chat_request(true))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        content_type.starts_with("text/event-stream"),
        "Chat SSE entry must return an SSE content type: {content_type}"
    );
    let forwarded = response.text().await.unwrap();
    assert!(
        forwarded.contains("\"object\":\"chat.completion.chunk\""),
        "client SSE must project valid Chat chunks: {forwarded}"
    );
    assert!(
        forwarded.contains(PROVIDER_SSE_TEXT),
        "client SSE must preserve the provider text: {forwarded}"
    );
    assert_eq!(
        forwarded.matches("data: [DONE]").count(),
        1,
        "client SSE must carry exactly one Chat terminal: {forwarded}"
    );

    let captures = upstream.captures();
    assert_eq!(
        captures.len(),
        1,
        "SSE handoff must reach the provider once"
    );
    assert!(
        serialized_contains(&captures[0], USER_TEXT_SENTINEL),
        "SSE handoff must forward the canonical request: {}",
        captures[0]
    );

    handle.shutdown().await;
    let _ = shutdown.send(());
    std::env::remove_var(CHAT_KEY_ENV);
}

#[tokio::test]
async fn req02_responses_canonical_handoff_json_reaches_selected_target_via_real_http() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(CHAT_KEY_ENV, CHAT_SECRET);

    let (upstream_addr, upstream, shutdown) = start_chat_upstream().await;
    let manifest = responses_to_chat_manifest(free_port(), upstream_addr.port());
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);

    let response = reqwest::Client::new()
        .post(endpoint)
        .json(&canonical_responses_request())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert!(
        serialized_contains(&body, CHAT_PROVIDER_TEXT),
        "Responses client must receive the provider text: {body}"
    );

    let captures = upstream.captures();
    assert_eq!(
        captures.len(),
        1,
        "the Responses handoff must reach the originally selected target exactly once"
    );
    let capture = &captures[0];
    assert_eq!(capture["model"], "chat-wire");
    assert!(
        serialized_contains(capture, USER_TEXT_SENTINEL),
        "the Chat provider payload must preserve the canonical user text: {capture}"
    );
    assert!(
        serialized_contains(capture, EXEC_CALL_ID),
        "the Chat provider payload must preserve the tool call history: {capture}"
    );

    handle.shutdown().await;
    let _ = shutdown.send(());
    std::env::remove_var(CHAT_KEY_ENV);
}

#[tokio::test]
async fn req02_direct_relay_handoff_rejects_raw_entry_as_internal_contract() {
    // The typed origin contract rejects a handoff that still carries raw wire
    // instead of the already-canonical Direct result. This is an internal
    // contract check, not a business-payload admission rule.
    let raw = RequestNormalizationEntry::RawEntry(json!({"model": "chat-client"}));
    let error = raw
        .validate_origin(RequestOriginKind::DirectRelayHandoff)
        .expect_err("DirectRelayHandoff must require an already-canonical entry");
    assert!(
        error.contains("already-canonical"),
        "unexpected typed origin rejection: {error}"
    );

    let canonical = RequestNormalizationEntry::AlreadyCanonical(json!({"model": "chat-client"}));
    assert!(canonical
        .validate_origin(RequestOriginKind::DirectRelayHandoff)
        .is_ok());
}
