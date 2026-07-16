use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{net::TcpListener, sync::Arc};
use tokio::{
    sync::{mpsc, oneshot, Mutex},
    time::{timeout, Duration},
};
use tokio_tungstenite::{
    accept_hdr_async, connect_async,
    tungstenite::{
        client::IntoClientRequest,
        handshake::server::{Request, Response as WsResponse},
        http::HeaderValue,
        Message,
    },
};

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const HUB_V1_TEST_DECLARATION: &str = r#"
[pipelines.hub_v1]
skeleton = "hub_v1"
entry_protocols = ["responses", "anthropic", "gemini", "openai_chat"]
hook_set_id = "hub_v1.default"
entry_protocol_bindings = [
  { entry_protocol = "responses", endpoint_patterns = ["/v1/responses"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" },
  { entry_protocol = "anthropic", endpoint_patterns = ["/v1/messages"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Anthropic Messages endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_anthropic_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs" },
  { entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" },
  { entry_protocol = "gemini", endpoint_patterns = ["/v1beta/models/:model/generateContent"], execution_mode = "relay", protocol_profile_owner = "v3.gemini_relay_runtime_integration", implemented = true, forbidden_reentry_behavior = "Gemini endpoint must not fall through to pending or direct runtime.", runtime_owner_symbol = "execute_v3_gemini_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs" },
]
resources = { metadata_center = { kind = "control", scope = "request" }, continuation_store = { kind = "continuation", scope = "server" }, error_chain = { kind = "error", scope = "request" }, debug_artifact = { kind = "debug", scope = "debug" }, snapshot_buffer = { kind = "snapshot", scope = "debug" }, provider_health = { kind = "provider_health", scope = "provider" } }
hooks = [
  { hook_id = "hub_v1.V3HubReqInbound01ClientRaw.entry.not_implemented", node = "V3HubReqInbound01ClientRaw", phase = "entry", requirement = "required", priority = 0, order = 0, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound01ClientRaw.exit.not_implemented", node = "V3HubReqInbound01ClientRaw", phase = "exit", requirement = "required", priority = 0, order = 1, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound02Normalized.entry.not_implemented", node = "V3HubReqInbound02Normalized", phase = "entry", requirement = "required", priority = 0, order = 2, allowed_resources = ["metadata_center"], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound02Normalized.exit.not_implemented", node = "V3HubReqInbound02Normalized", phase = "exit", requirement = "optional", enabled = false, priority = 0, order = 3, allowed_resources = [], forbidden_resources = ["continuation_store"] },
  { hook_id = "hub_v1.V3HubReqContinuation03Classified.entry.not_implemented", node = "V3HubReqContinuation03Classified", phase = "entry", requirement = "required", priority = 0, order = 4, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqContinuation03Classified.exit.not_implemented", node = "V3HubReqContinuation03Classified", phase = "exit", requirement = "required", priority = 0, order = 5, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqChatProcess04Governed.entry.not_implemented", node = "V3HubReqChatProcess04Governed", phase = "entry", requirement = "required", priority = 0, order = 6, allowed_resources = ["continuation_store"], forbidden_resources = [], profile = "servertool" },
  { hook_id = "hub_v1.V3HubReqChatProcess04Governed.exit.not_implemented", node = "V3HubReqChatProcess04Governed", phase = "exit", requirement = "required", priority = 0, order = 7, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqExecution05Planned.entry.not_implemented", node = "V3HubReqExecution05Planned", phase = "entry", requirement = "required", priority = 0, order = 8, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqExecution05Planned.exit.not_implemented", node = "V3HubReqExecution05Planned", phase = "exit", requirement = "required", priority = 0, order = 9, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqTarget06Resolved.entry.not_implemented", node = "V3HubReqTarget06Resolved", phase = "entry", requirement = "required", priority = 0, order = 10, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqTarget06Resolved.exit.not_implemented", node = "V3HubReqTarget06Resolved", phase = "exit", requirement = "required", priority = 0, order = 11, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqOutbound07ProviderSemantic.entry.not_implemented", node = "V3HubReqOutbound07ProviderSemantic", phase = "entry", requirement = "required", priority = 0, order = 12, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqOutbound07ProviderSemantic.exit.not_implemented", node = "V3HubReqOutbound07ProviderSemantic", phase = "exit", requirement = "required", priority = 0, order = 13, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.entry.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "entry", requirement = "required", priority = 0, order = 14, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.exit.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "exit", requirement = "required", priority = 0, order = 15, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.entry.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "entry", requirement = "required", priority = 0, order = 16, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.exit.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "exit", requirement = "required", priority = 0, order = 17, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.entry.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "entry", requirement = "required", priority = 0, order = 18, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.exit.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "exit", requirement = "required", priority = 0, order = 19, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.entry.not_implemented", node = "V3HubRespInbound02Normalized", phase = "entry", requirement = "required", priority = 0, order = 20, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.exit.not_implemented", node = "V3HubRespInbound02Normalized", phase = "exit", requirement = "required", priority = 0, order = 21, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.entry.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "entry", requirement = "required", priority = 0, order = 22, allowed_resources = ["continuation_store"], forbidden_resources = [], profile = "servertool" },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.exit.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "exit", requirement = "required", priority = 0, order = 23, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespContinuation04Committed.entry.not_implemented", node = "V3HubRespContinuation04Committed", phase = "entry", requirement = "required", priority = 0, order = 24, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespContinuation04Committed.exit.not_implemented", node = "V3HubRespContinuation04Committed", phase = "exit", requirement = "required", priority = 0, order = 25, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.entry.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "entry", requirement = "required", priority = 0, order = 26, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.exit.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "exit", requirement = "required", priority = 0, order = 27, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.entry.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "entry", requirement = "required", priority = 0, order = 28, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.exit.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "exit", requirement = "required", priority = 0, order = 29, allowed_resources = [], forbidden_resources = [] },
]
"#;

const HUB_V1_TEST_SERVER_EXECUTION: &str = r#"
[servers.a.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[servers.b.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
"#;

fn manifest(port_a: u16, port_b: u16) -> routecodex_v3_config::V3Config05ManifestPublished {
    manifest_with_debug(port_a, port_b, true, true)
}

fn manifest_with_debug(
    port_a: u16,
    port_b: u16,
    snapshots: bool,
    dry_run: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let hub_v1_declaration = HUB_V1_TEST_DECLARATION;
    let hub_v1_server_execution = HUB_V1_TEST_SERVER_EXECUTION;
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "default"
endpoints = ["responses", "anthropic", "gemini", "openai_chat"]
[servers.b]
bind = "127.0.0.1"
port = {port_b}
routing_group = "default"
endpoints = ["responses", "anthropic", "gemini", "openai_chat"]
{hub_v1_server_execution}
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_TEST_KEY" }}] }}
[providers.test.models.test]
[debug]
log_console = false
snapshots = {snapshots}
dry_run = {dry_run}
retention = {{ raw_requests = 4, raw_responses = 4, events = 32 }}
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn p6_manifest(
    port_a: u16,
    port_b: u16,
    provider_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let hub_v1_declaration = HUB_V1_TEST_DECLARATION;
    let hub_v1_server_execution = HUB_V1_TEST_SERVER_EXECUTION;
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "default"
endpoints = ["responses"]
[servers.b]
bind = "127.0.0.1"
port = {port_b}
routing_group = "default"
endpoints = ["responses"]
{hub_v1_server_execution}
[providers.test]
type = "responses"
base_url = "{provider_base_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_P6_TEST_KEY" }}] }}
responses = {{ process = "chat", streaming = "always" }}
[providers.test.models.test]
wire_name = "wire-test"
aliases = ["client-test"]
capabilities = ["text", "tools"]
supports_streaming = true
supports_thinking = true
thinking = "optional"
max_tokens = 4096
max_context_tokens = 128000
[debug]
log_console = false
snapshots = true
dry_run = true
retention = {{ raw_requests = 8, raw_responses = 8, events = 64 }}
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn p6_remote_continuation_manifest(
    port_a: u16,
    port_b: u16,
    websocket_v2_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let hub_v1_declaration = HUB_V1_TEST_DECLARATION;
    let hub_v1_server_execution = HUB_V1_TEST_SERVER_EXECUTION;
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "default"
endpoints = ["responses"]
[servers.b]
bind = "127.0.0.1"
port = {port_b}
routing_group = "default"
endpoints = ["responses"]
{hub_v1_server_execution}
[providers.test]
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_P6_TEST_KEY" }}] }}
responses = {{ process = "chat", streaming = "always", transport = "websocket_v2", websocket_v2_url = "{websocket_v2_url}" }}
[providers.test.models.test]
wire_name = "wire-test"
aliases = ["client-test"]
capabilities = ["text", "tools", "tool_outputs", "remote_continuation"]
supports_streaming = true
supports_thinking = true
thinking = "optional"
max_tokens = 4096
max_context_tokens = 128000
[debug]
log_console = false
snapshots = true
dry_run = true
retention = {{ raw_requests = 8, raw_responses = 8, events = 64 }}
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn p6_reselection_manifest(
    port_a: u16,
    port_b: u16,
    first_base_url: &str,
    second_base_url: &str,
    first_env: &str,
    second_env: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let hub_v1_declaration = HUB_V1_TEST_DECLARATION;
    let hub_v1_server_execution = HUB_V1_TEST_SERVER_EXECUTION;
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "default"
endpoints = ["responses"]
[servers.b]
bind = "127.0.0.1"
port = {port_b}
routing_group = "default"
endpoints = ["responses"]
{hub_v1_server_execution}
[providers.first]
type = "responses"
base_url = "{first_base_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{first_env}" }}] }}
[providers.first.models.test]
wire_name = "wire-first"
[providers.second]
type = "responses"
base_url = "{second_base_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{second_env}" }}] }}
[providers.second.models.test]
wire_name = "wire-second"
[forwarders.responses]
model = "test"
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "first", model = "test", key = "key", priority = 1 }},
  {{ kind = "provider_model", provider = "second", model = "test", key = "key", priority = 2 }}
]
[debug]
log_console = false
snapshots = true
dry_run = true
retention = {{ raw_requests = 8, raw_responses = 8, events = 128 }}
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "responses", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

#[derive(Debug)]
struct ProviderCapture {
    authorization: Option<String>,
    accept: Option<String>,
    body: Value,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

async fn controlled_responses_upstream(
    State(state): State<Arc<ProviderState>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            authorization: headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            accept: headers
                .get("accept")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            body: body.clone(),
        })
        .unwrap();

    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(
                "event: response.created\ndata: {\"id\":\"resp_sse\"}\n\ndata: [DONE]\n\n",
            ))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(r#"{"id":"resp_json","output_text":"ok"}"#))
            .unwrap()
    }
}

async fn start_controlled_upstream() -> (
    String,
    mpsc::UnboundedReceiver<ProviderCapture>,
    oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_responses_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}/v1"), captures_rx, shutdown_tx)
}

async fn controlled_anthropic_wire_upstream(
    State(state): State<Arc<ProviderState>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            authorization: headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            accept: headers
                .get("accept")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            body,
        })
        .unwrap();

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"id":"resp_anthropic_json","status":"completed","output":[{"type":"output_text","text":"anthropic controlled"}]}"#,
        ))
        .unwrap()
}

async fn start_controlled_anthropic_wire_upstream() -> (
    String,
    mpsc::UnboundedReceiver<ProviderCapture>,
    oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_anthropic_wire_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}/v1"), captures_rx, shutdown_tx)
}

#[allow(clippy::result_large_err)]
async fn start_controlled_continuation_websocket() -> (
    String,
    mpsc::UnboundedReceiver<ProviderCapture>,
    oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        let (stream, _) = tokio::select! {
            accepted = listener.accept() => accepted.unwrap(),
            _ = &mut shutdown_rx => return,
        };
        let captures = captures_tx.clone();
        let mut socket =
            accept_hdr_async(stream, move |request: &Request, response: WsResponse| {
                let authorization = request
                    .headers()
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .map(ToOwned::to_owned);
                captures
                    .send(ProviderCapture {
                        authorization,
                        accept: None,
                        body: json!({"handshake": true}),
                    })
                    .unwrap();
                Ok(response)
            })
            .await
            .unwrap();
        while let Some(message) = socket.next().await {
            let Ok(message) = message else {
                break;
            };
            let bytes = match message {
                Message::Text(text) => text.as_bytes().to_vec(),
                Message::Binary(bytes) => bytes.to_vec(),
                Message::Close(_) => break,
                Message::Ping(bytes) => {
                    socket.send(Message::Pong(bytes)).await.unwrap();
                    continue;
                }
                Message::Pong(_) | Message::Frame(_) => continue,
            };
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            captures_tx
                .send(ProviderCapture {
                    authorization: None,
                    accept: None,
                    body: body.clone(),
                })
                .unwrap();
            let response = if body.get("previous_response_id").and_then(Value::as_str)
                == Some("resp_server_remote_1")
            {
                json!({"type":"response.completed","response":{"id":"resp_server_remote_2","status":"completed","output":[{"type":"output_text","text":"server done"}]}})
            } else {
                json!({"type":"response.completed","response":{"id":"resp_server_remote_1","status":"completed","output":[{"type":"function_call","call_id":"call_server_1","name":"lookup","arguments":"{}"}]}})
            };
            socket
                .send(Message::Text(serde_json::to_string(&response).unwrap()))
                .await
                .unwrap();
        }
    });
    (
        format!("ws://{address}/v1/responses"),
        captures_rx,
        shutdown_tx,
    )
}

#[allow(clippy::result_large_err)]
async fn start_incremental_controlled_continuation_websocket() -> (
    String,
    mpsc::UnboundedReceiver<ProviderCapture>,
    oneshot::Receiver<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (closed_tx, closed_rx) = oneshot::channel();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let captures = captures_tx.clone();
        let mut socket =
            accept_hdr_async(stream, move |request: &Request, response: WsResponse| {
                let authorization = request
                    .headers()
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .map(ToOwned::to_owned);
                captures
                    .send(ProviderCapture {
                        authorization,
                        accept: None,
                        body: json!({"handshake": true}),
                    })
                    .unwrap();
                Ok(response)
            })
            .await
            .unwrap();
        let Some(Ok(message)) = socket.next().await else {
            let _ = closed_tx.send(());
            return;
        };
        let bytes = match message {
            Message::Text(text) => text.as_bytes().to_vec(),
            Message::Binary(bytes) => bytes.to_vec(),
            Message::Close(_) => {
                let _ = closed_tx.send(());
                return;
            }
            Message::Ping(bytes) => {
                socket.send(Message::Pong(bytes)).await.unwrap();
                let Some(Ok(next)) = socket.next().await else {
                    let _ = closed_tx.send(());
                    return;
                };
                match next {
                    Message::Text(text) => text.as_bytes().to_vec(),
                    Message::Binary(bytes) => bytes.to_vec(),
                    _ => {
                        let _ = closed_tx.send(());
                        return;
                    }
                }
            }
            Message::Pong(_) | Message::Frame(_) => {
                let _ = closed_tx.send(());
                return;
            }
        };
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        captures_tx
            .send(ProviderCapture {
                authorization: None,
                accept: None,
                body,
            })
            .unwrap();
        socket
            .send(Message::Text(
                serde_json::to_string(&json!({
                    "type":"response.output_text.delta",
                    "delta":"first"
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = socket
            .send(Message::Text(
                serde_json::to_string(&json!({
                    "type":"response.completed",
                    "response":{
                        "id":"resp_incremental_after_disconnect",
                        "status":"completed",
                        "output":[{"type":"output_text","text":"first"}]
                    }
                }))
                .unwrap(),
            ))
            .await;
        let _ = socket.next().await;
        let _ = closed_tx.send(());
    });
    (
        format!("ws://{address}/v1/responses"),
        captures_rx,
        closed_rx,
    )
}

async fn controlled_failure_upstream() -> Response<Body> {
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("content-type", "application/json")
        .body(Body::from(r#"{"error":"controlled_unavailable"}"#))
        .unwrap()
}

async fn start_controlled_failure_upstream() -> (String, oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new().route("/v1/responses", post(controlled_failure_upstream));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}/v1"), shutdown_tx)
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
async fn starts_all_listeners_and_routes_gemini_runtime_input_errors_through_error_chain() {
    let _test_guard = TEST_LOCK.lock().await;
    let handle = spawn_v3_server_aggregate(manifest(free_port(), free_port()))
        .await
        .unwrap();
    assert_eq!(handle.listeners.len(), 2);
    let client = reqwest::Client::new();
    for listener in &handle.listeners {
        let health: serde_json::Value = client
            .get(format!("http://{}/health", listener.addr))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["server_id"], listener.server_id);
        assert_eq!(health["manifest_version"], 3);
        let invalid_gemini = client
            .post(format!(
                "http://{}/v1beta/models/test/generateContent",
                listener.addr
            ))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(invalid_gemini.status(), 500);
        assert_eq!(
            invalid_gemini.headers()["x-routecodex-v3-error-chain"],
            "V3Error01SourceRaised,V3Error02Classified,V3Error03TargetLocalAction,V3Error04TargetExhaustionDecision,V3Error05ExecutionDecision,V3Error06ClientProjected"
        );
        let body: serde_json::Value = invalid_gemini.json().await.unwrap();
        assert_eq!(body["error"]["code"], "runtime_error");
        assert_eq!(
            body["error"]["message"],
            "Gemini request contents must be an array"
        );
    }
    handle.shutdown().await;
}

#[tokio::test]
async fn entry_protocol_binding_dispatches_relay_without_body_leakage() {
    let _test_guard = TEST_LOCK.lock().await;
    let (provider_base_url, mut captures, shutdown) =
        start_controlled_anthropic_wire_upstream().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-entry-binding");
    let mut manifest = p6_manifest(free_port(), free_port(), &provider_base_url);
    for server in manifest.servers.values_mut() {
        server.endpoints = vec![
            "responses".to_string(),
            "anthropic".to_string(),
            "gemini".to_string(),
            "openai_chat".to_string(),
        ];
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();

    let anthropic = client
        .post(format!("{base}/v1/messages"))
        .json(&json!({
            "model":"client-test",
            "max_tokens":64,
            "messages":[{"role":"user","content":"hello"}],
            "stream":false
        }))
        .send()
        .await
        .unwrap();
    let anthropic_status = anthropic.status();
    let anthropic_trace = anthropic.headers()["x-routecodex-v3-node-trace"]
        .to_str()
        .unwrap()
        .to_string();
    let anthropic_body_text = anthropic.text().await.unwrap();
    assert_eq!(
        anthropic_status,
        StatusCode::OK,
        "Anthropic Relay response body: {anthropic_body_text}"
    );
    assert!(anthropic_trace.contains("V3HubReqExecution05Planned"));
    let anthropic_body: Value = serde_json::from_str(&anthropic_body_text).unwrap();
    assert_eq!(anthropic_body["content"][0]["text"], "anthropic controlled");
    let capture = captures.recv().await.unwrap();
    assert_eq!(
        capture.authorization.as_deref(),
        Some("Bearer secret-entry-binding")
    );
    assert_eq!(capture.body["model"], "wire-test");
    assert_eq!(capture.body["stream"], false);
    assert!(capture.body.get("metadata_center").is_none());

    let mut disabled_manifest = p6_manifest(free_port(), free_port(), &provider_base_url);
    for server in disabled_manifest.servers.values_mut() {
        server.endpoints = vec!["responses".to_string()];
    }
    let disabled_handle = spawn_v3_server_aggregate(disabled_manifest).await.unwrap();
    let disabled_base = format!("http://{}", disabled_handle.listeners[0].addr);
    let disabled = client
        .post(format!(
            "{disabled_base}/v1beta/models/test/generateContent"
        ))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(disabled.status(), StatusCode::NOT_IMPLEMENTED);
    assert!(disabled
        .headers()
        .get("x-routecodex-v3-pending-owner")
        .is_none());
    let disabled_body: Value = disabled.json().await.unwrap();
    assert_eq!(disabled_body["error"]["code"], "endpoint_not_enabled");

    let unknown = client
        .post(format!("{disabled_base}/v1/unknown"))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    assert!(unknown
        .headers()
        .get("x-routecodex-v3-pending-owner")
        .is_none());
    let unknown_body: Value = unknown.json().await.unwrap();
    assert_eq!(unknown_body["error"]["code"], "path_not_found");

    disabled_handle.shutdown().await;
    handle.shutdown().await;
    shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
}

#[tokio::test]
async fn p6_models_endpoint_projects_manifest_catalog_with_alias_capabilities() {
    let _test_guard = TEST_LOCK.lock().await;
    let (provider_base_url, _captures, shutdown) = start_controlled_upstream().await;
    let handle =
        spawn_v3_server_aggregate(p6_manifest(free_port(), free_port(), &provider_base_url))
            .await
            .unwrap();
    let client = reqwest::Client::new();
    let response: Value = client
        .get(format!("http://{}/v1/models", handle.listeners[0].addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["object"], "list");
    let model = response["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["id"] == "client-test")
        .expect("alias must be projected as client visible model id");
    assert_eq!(model["canonical_model_id"], "test");
    assert_eq!(model["wire_model"], "wire-test");
    assert_eq!(model["provider_id"], "test");
    assert_eq!(model["capabilities"], json!(["text", "tools"]));
    assert_eq!(model["supports_streaming"], true);
    assert_eq!(model["supports_thinking"], true);
    assert_eq!(model["thinking"], "optional");
    assert_eq!(model["max_tokens"], 4096);
    assert_eq!(model["max_context_tokens"], 128000);
    assert!(
        !serde_json::to_string(&response)
            .unwrap()
            .contains("V3_P6_TEST_KEY"),
        "model catalog must not expose auth handles"
    );
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn p6_responses_endpoint_uses_runtime_provider_path_and_projects_json() {
    let _test_guard = TEST_LOCK.lock().await;
    let (provider_base_url, mut captures, shutdown) = start_controlled_upstream().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6");
    let handle =
        spawn_v3_server_aggregate(p6_manifest(free_port(), free_port(), &provider_base_url))
            .await
            .unwrap();
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .json(&json!({
            "model": "client-test",
            "input": "hello",
            "metadata": {"client_field": "preserve"}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.headers()["x-routecodex-v3-node-trace"]
        .to_str()
        .unwrap()
        .ends_with("V3Resp15ClientPayload,V3Server16HttpFrame"));
    assert_eq!(
        response.headers()["content-type"].to_str().unwrap(),
        "application/json"
    );
    let body: Value = response.json().await.unwrap();
    assert_eq!(body, json!({"id": "resp_json", "output_text": "ok"}));

    let capture = captures.recv().await.unwrap();
    assert_eq!(capture.authorization.as_deref(), Some("Bearer secret-p6"));
    assert_eq!(capture.accept.as_deref(), Some("application/json"));
    assert_eq!(capture.body["model"], "wire-test");
    assert_eq!(
        capture.body["metadata"],
        json!({"client_field": "preserve"})
    );

    let logs: Value = client
        .get(format!(
            "http://{}/_routecodex/debug/logs",
            handle.listeners[0].addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let serialized_logs = serde_json::to_string(&logs).unwrap();
    for node in [
        "V3Provider12ResponsesWirePayload",
        "V3Transport13ResponsesHttpRequest",
        "V3ProviderResp14Raw",
        "V3Resp15ClientPayload",
    ] {
        assert!(serialized_logs.contains(node), "{node}");
    }
    assert!(!serialized_logs.contains("secret-p6"));
    std::env::remove_var("V3_P6_TEST_KEY");
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn p6_responses_endpoint_accepts_image_payload_above_one_mib() {
    let _test_guard = TEST_LOCK.lock().await;
    let (provider_base_url, mut captures, shutdown) = start_controlled_upstream().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-large-image");
    let handle =
        spawn_v3_server_aggregate(p6_manifest(free_port(), free_port(), &provider_base_url))
            .await
            .unwrap();
    let client = reqwest::Client::new();
    let image_url = format!("data:image/png;base64,{}", "A".repeat(1_200_000));
    let response = client
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .json(&json!({
            "model": "client-test",
            "input": [{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Describe this image."},
                    {"type": "input_image", "image_url": image_url}
                ]
            }]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::OK,
        "V3 must preserve the V2 64MiB HTTP body contract for image-bearing requests"
    );
    let capture = captures.recv().await.unwrap();
    assert!(
        capture.body["input"][0]["content"][1]["image_url"]
            .as_str()
            .is_some_and(|value| value.len() > 1_000_000),
        "provider wire request must retain the original image payload"
    );

    std::env::remove_var("V3_P6_TEST_KEY");
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn p6_responses_endpoint_projects_sse_without_materialize_repair() {
    let _test_guard = TEST_LOCK.lock().await;
    let (provider_base_url, mut captures, shutdown) = start_controlled_upstream().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6");
    let handle =
        spawn_v3_server_aggregate(p6_manifest(free_port(), free_port(), &provider_base_url))
            .await
            .unwrap();
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .json(&json!({
            "model": "client-test",
            "input": "hello",
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.headers()["x-routecodex-v3-node-trace"]
        .to_str()
        .unwrap()
        .ends_with("V3Resp15ClientPayload,V3Server16HttpFrame"));
    assert_eq!(
        response.headers()["content-type"].to_str().unwrap(),
        "text/event-stream"
    );
    let body = response.text().await.unwrap();
    assert_eq!(
        body,
        "event: response.created\ndata: {\"id\":\"resp_sse\"}\n\ndata: [DONE]\n\n"
    );
    let capture = captures.recv().await.unwrap();
    assert_eq!(capture.accept.as_deref(), Some("text/event-stream"));
    assert_eq!(capture.body["stream"], true);
    assert_eq!(capture.body["model"], "wire-test");
    std::env::remove_var("V3_P6_TEST_KEY");
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn responses_direct_server_replays_two_turn_remote_continuation_with_header_scope_and_no_router_reentry(
) {
    let _test_guard = TEST_LOCK.lock().await;
    let (websocket_v2_url, mut captures, shutdown) =
        start_controlled_continuation_websocket().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-continuation");
    let handle = spawn_v3_server_aggregate(p6_remote_continuation_manifest(
        free_port(),
        free_port(),
        &websocket_v2_url,
    ))
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let metadata = json!({
        "session_id":"session-server-a",
        "thread_id":"conversation-server-a",
        "turn_id":"turn-server-1"
    })
    .to_string();
    let first = client
        .post(&endpoint)
        .header("session-id", "session-server-a")
        .header("thread-id", "conversation-server-a")
        .header("x-codex-turn-metadata", &metadata)
        .json(&json!({
            "model":"client-test",
            "input":"use tool",
            "tools":[{"type":"function","name":"lookup"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    let first_trace = first.headers()["x-routecodex-v3-node-trace"]
        .to_str()
        .unwrap()
        .to_string();
    assert!(first_trace.contains("V3Router07OpaqueTargetHitOnce"));
    assert!(first_trace.contains("V3HubRespContinuation04Committed"));
    let first_body: Value = first.json().await.unwrap();
    assert_eq!(first_body["id"], "resp_server_remote_1");

    let second = client
        .post(&endpoint)
        .header("session-id", "session-server-a")
        .header("thread-id", "conversation-server-a")
        .header(
            "x-codex-turn-metadata",
            json!({
                "session_id":"session-server-a",
                "thread_id":"conversation-server-a",
                "turn_id":"turn-server-2"
            })
            .to_string(),
        )
        .json(&json!({
            "model":"client-test",
            "previous_response_id":"resp_server_remote_1",
            "input":[{"type":"function_call_output","call_id":"call_server_1","output":"ok"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), 200);
    let second_trace = second.headers()["x-routecodex-v3-node-trace"]
        .to_str()
        .unwrap()
        .to_string();
    assert!(second_trace.contains("V3HubReqContinuation03Classified"));
    assert!(second_trace.contains("V3HubReqTarget06Resolved"));
    assert!(!second_trace.contains("V3Router07OpaqueTargetHitOnce"));
    assert!(!second_trace.contains("V3TargetLocalReselected"));
    let second_body: Value = second.json().await.unwrap();
    assert_eq!(second_body["id"], "resp_server_remote_2");

    let handshake_capture = captures.recv().await.unwrap();
    assert_eq!(
        handshake_capture.authorization.as_deref(),
        Some("Bearer secret-p6-continuation")
    );
    let first_capture = captures.recv().await.unwrap();
    let second_capture = captures.recv().await.unwrap();
    assert_eq!(first_capture.body["model"], "wire-test");
    assert_eq!(second_capture.body["model"], "wire-test");
    assert_eq!(first_capture.body["type"], "response.create");
    assert!(first_capture.body.get("stream").is_none());
    assert!(first_capture.body.get("background").is_none());
    assert_eq!(
        second_capture.body["previous_response_id"],
        "resp_server_remote_1"
    );
    for body in [&first_capture.body, &second_capture.body] {
        for forbidden in [
            "session_id",
            "thread_id",
            "provider_id",
            "auth_alias",
            "continuation_owner",
            "capability_revision",
            "routing_group",
        ] {
            assert!(body.get(forbidden).is_none(), "{forbidden}: {body}");
        }
    }

    std::env::remove_var("V3_P6_TEST_KEY");
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn responses_direct_server_replays_two_turn_sse_remote_continuation_without_router_reentry() {
    let _test_guard = TEST_LOCK.lock().await;
    let (websocket_v2_url, mut captures, shutdown) =
        start_controlled_continuation_websocket().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-continuation-sse");
    let handle = spawn_v3_server_aggregate(p6_remote_continuation_manifest(
        free_port(),
        free_port(),
        &websocket_v2_url,
    ))
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let first = client
        .post(&endpoint)
        .header("session-id", "session-server-sse")
        .header("thread-id", "conversation-server-sse")
        .json(&json!({
            "model":"client-test",
            "stream":true,
            "input":"use tool",
            "tools":[{"type":"function","name":"lookup"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    assert_eq!(first.headers()["content-type"], "text/event-stream");
    let first_trace = first.headers()["x-routecodex-v3-node-trace"]
        .to_str()
        .unwrap()
        .to_string();
    assert!(first_trace.contains("V3Router07OpaqueTargetHitOnce"));
    assert!(first.text().await.unwrap().contains("resp_server_remote_1"));

    let second = client
        .post(&endpoint)
        .header("session-id", "session-server-sse")
        .header("thread-id", "conversation-server-sse")
        .json(&json!({
            "model":"client-test",
            "stream":true,
            "previous_response_id":"resp_server_remote_1",
            "input":[{"type":"function_call_output","call_id":"call_server_1","output":"ok"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), 200);
    assert_eq!(second.headers()["content-type"], "text/event-stream");
    let second_trace = second.headers()["x-routecodex-v3-node-trace"]
        .to_str()
        .unwrap()
        .to_string();
    assert!(second_trace.contains("V3HubReqContinuation03Classified"));
    assert!(second_trace.contains("V3HubReqTarget06Resolved"));
    assert!(!second_trace.contains("V3Router07OpaqueTargetHitOnce"));
    assert!(!second_trace.contains("V3TargetLocalReselected"));
    assert!(second
        .text()
        .await
        .unwrap()
        .contains("resp_server_remote_2"));

    let handshake_capture = captures.recv().await.unwrap();
    assert_eq!(
        handshake_capture.authorization.as_deref(),
        Some("Bearer secret-p6-continuation-sse")
    );
    let first_capture = captures.recv().await.unwrap();
    let second_capture = captures.recv().await.unwrap();
    assert!(first_capture.body.get("stream").is_none());
    assert!(second_capture.body.get("stream").is_none());
    assert_eq!(
        second_capture.body["previous_response_id"],
        "resp_server_remote_1"
    );
    assert_control_fields_absent(&first_capture.body);
    assert_control_fields_absent(&second_capture.body);

    std::env::remove_var("V3_P6_TEST_KEY");
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
// feature_id: v3.responses_inbound_websocket_proxy
async fn responses_inbound_websocket_requires_beta_upgrade_and_handles_ping() {
    let _test_guard = TEST_LOCK.lock().await;
    let (provider_base_url, mut captures, shutdown) = start_controlled_upstream().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-inbound-ws-handshake");
    let handle =
        spawn_v3_server_aggregate(p6_manifest(free_port(), free_port(), &provider_base_url))
            .await
            .unwrap();
    let http_endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let plain_get = reqwest::Client::new()
        .get(&http_endpoint)
        .header("openai-beta", "responses_websockets=2026-02-06")
        .send()
        .await
        .unwrap();
    assert_eq!(plain_get.status(), StatusCode::BAD_REQUEST);
    let plain_body: Value = plain_get.json().await.unwrap();
    assert_eq!(plain_body["error"]["code"], "websocket_upgrade_required");

    let ws_endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    let missing_beta_error = connect_async(ws_endpoint.clone())
        .await
        .expect_err("missing beta handshake must be rejected");
    match missing_beta_error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        other => panic!("unexpected missing beta error: {other}"),
    }

    let mut request = ws_endpoint.into_client_request().unwrap();
    request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    let (mut socket, handshake) = connect_async(request).await.unwrap();
    assert_eq!(handshake.status(), StatusCode::SWITCHING_PROTOCOLS);
    socket
        .send(Message::Ping(vec![1_u8, 2_u8, 3_u8]))
        .await
        .unwrap();
    let pong = socket.next().await.unwrap().unwrap();
    assert_eq!(pong, Message::Pong(vec![1_u8, 2_u8, 3_u8]));
    assert!(captures.try_recv().is_err());

    std::env::remove_var("V3_P6_TEST_KEY");
    let _ = socket.close(None).await;
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn responses_inbound_websocket_projects_json_completed_event_and_enters_runtime() {
    let _test_guard = TEST_LOCK.lock().await;
    let (websocket_v2_url, mut captures, shutdown) =
        start_controlled_continuation_websocket().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-inbound-ws-json");
    let handle = spawn_v3_server_aggregate(p6_remote_continuation_manifest(
        free_port(),
        free_port(),
        &websocket_v2_url,
    ))
    .await
    .unwrap();
    let endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    let mut request = endpoint.into_client_request().unwrap();
    request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    request.headers_mut().insert(
        "session-id",
        HeaderValue::from_static("session-inbound-json"),
    );
    request
        .headers_mut()
        .insert("thread-id", HeaderValue::from_static("thread-inbound-json"));
    let (mut socket, handshake) = connect_async(request).await.unwrap();
    assert_eq!(handshake.status(), StatusCode::SWITCHING_PROTOCOLS);

    socket
        .send(Message::Text(
            json!({
                "type": "response.create",
                "model": "client-test",
                "input": "use tool",
                "tools": [{"type":"function","name":"lookup"}]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let message = socket.next().await.unwrap().unwrap();
    let event: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(event["type"], "response.completed");
    assert_eq!(event["response"]["id"], "resp_server_remote_1");
    assert_eq!(event["response"]["output"][0]["type"], "function_call");

    let handshake_capture = captures.recv().await.unwrap();
    assert_eq!(
        handshake_capture.authorization.as_deref(),
        Some("Bearer secret-p6-inbound-ws-json")
    );
    let provider_event = captures.recv().await.unwrap();
    assert_eq!(provider_event.body["type"], "response.create");
    assert_eq!(provider_event.body["model"], "wire-test");
    assert_eq!(provider_event.body["input"], "use tool");
    assert_control_fields_absent(&provider_event.body);

    std::env::remove_var("V3_P6_TEST_KEY");
    let _ = socket.close(None).await;
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn responses_inbound_websocket_accepts_binary_response_create_payload() {
    let _test_guard = TEST_LOCK.lock().await;
    let (websocket_v2_url, mut captures, shutdown) =
        start_controlled_continuation_websocket().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-inbound-ws-binary");
    let handle = spawn_v3_server_aggregate(p6_remote_continuation_manifest(
        free_port(),
        free_port(),
        &websocket_v2_url,
    ))
    .await
    .unwrap();
    let endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    let mut request = endpoint.into_client_request().unwrap();
    request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    let (mut socket, handshake) = connect_async(request).await.unwrap();
    assert_eq!(handshake.status(), StatusCode::SWITCHING_PROTOCOLS);

    socket
        .send(Message::Binary(
            json!({
                "type": "response.create",
                "model": "client-test",
                "input": "binary ok"
            })
            .to_string()
            .into_bytes(),
        ))
        .await
        .unwrap();
    let message = socket.next().await.unwrap().unwrap();
    let event: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(event["type"], "response.completed");
    assert_eq!(event["response"]["id"], "resp_server_remote_1");

    let _handshake_capture = captures.recv().await.unwrap();
    let provider_event = captures.recv().await.unwrap();
    assert_eq!(provider_event.body["input"], "binary ok");
    assert_control_fields_absent(&provider_event.body);

    std::env::remove_var("V3_P6_TEST_KEY");
    let _ = socket.close(None).await;
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn responses_inbound_websocket_projects_sse_runtime_events_as_websocket_frames() {
    let _test_guard = TEST_LOCK.lock().await;
    let (websocket_v2_url, mut captures, shutdown) =
        start_controlled_continuation_websocket().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-inbound-ws-sse");
    let handle = spawn_v3_server_aggregate(p6_remote_continuation_manifest(
        free_port(),
        free_port(),
        &websocket_v2_url,
    ))
    .await
    .unwrap();
    let endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    let mut request = endpoint.into_client_request().unwrap();
    request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    request.headers_mut().insert(
        "session-id",
        HeaderValue::from_static("session-inbound-sse"),
    );
    request
        .headers_mut()
        .insert("thread-id", HeaderValue::from_static("thread-inbound-sse"));
    let (mut socket, handshake) = connect_async(request).await.unwrap();
    assert_eq!(handshake.status(), StatusCode::SWITCHING_PROTOCOLS);

    socket
        .send(Message::Text(
            json!({
                "type": "response.create",
                "model": "client-test",
                "stream": true,
                "input": "use tool",
                "tools": [{"type":"function","name":"lookup"}]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let message = socket.next().await.unwrap().unwrap();
    let event: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(event["type"], "response.completed");
    assert_eq!(event["response"]["id"], "resp_server_remote_1");

    let _handshake_capture = captures.recv().await.unwrap();
    let provider_event = captures.recv().await.unwrap();
    assert_eq!(provider_event.body["type"], "response.create");
    assert!(provider_event.body.get("stream").is_none());
    assert_eq!(provider_event.body["model"], "wire-test");
    assert_control_fields_absent(&provider_event.body);

    std::env::remove_var("V3_P6_TEST_KEY");
    let _ = socket.close(None).await;
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn responses_inbound_websocket_rejects_malformed_client_event_without_provider_send() {
    let _test_guard = TEST_LOCK.lock().await;
    let (websocket_v2_url, mut captures, shutdown) =
        start_controlled_continuation_websocket().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-inbound-ws-malformed");
    let handle = spawn_v3_server_aggregate(p6_remote_continuation_manifest(
        free_port(),
        free_port(),
        &websocket_v2_url,
    ))
    .await
    .unwrap();
    let endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    for invalid_event in [
        "{not-json".to_string(),
        json!({"model": "client-test", "input": "missing type"}).to_string(),
        json!({"type": "response.cancel", "response_id": "resp_bad"}).to_string(),
        json!({
            "type": "response.create",
            "response": {"model": "client-test", "input": "nested shape"}
        })
        .to_string(),
    ] {
        let mut request = endpoint.clone().into_client_request().unwrap();
        request.headers_mut().insert(
            "openai-beta",
            HeaderValue::from_static("responses_websockets=2026-02-06"),
        );
        let (mut socket, handshake) = connect_async(request).await.unwrap();
        assert_eq!(handshake.status(), StatusCode::SWITCHING_PROTOCOLS);
        socket.send(Message::Text(invalid_event)).await.unwrap();
        let message = socket.next().await.unwrap().unwrap();
        let event: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        assert_eq!(event["type"], "error");
        assert_eq!(event["error"]["code"], "invalid_client_event");
        let _ = socket.close(None).await;
    }
    assert!(captures.try_recv().is_err());

    std::env::remove_var("V3_P6_TEST_KEY");
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn responses_inbound_websocket_replays_two_turn_tool_continuation_on_same_socket() {
    let _test_guard = TEST_LOCK.lock().await;
    let (websocket_v2_url, mut captures, shutdown) =
        start_controlled_continuation_websocket().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-inbound-ws-two-turn");
    let handle = spawn_v3_server_aggregate(p6_remote_continuation_manifest(
        free_port(),
        free_port(),
        &websocket_v2_url,
    ))
    .await
    .unwrap();
    let endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    let mut request = endpoint.into_client_request().unwrap();
    request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    request.headers_mut().insert(
        "session-id",
        HeaderValue::from_static("session-inbound-two-turn"),
    );
    request.headers_mut().insert(
        "thread-id",
        HeaderValue::from_static("thread-inbound-two-turn"),
    );
    let (mut socket, handshake) = connect_async(request).await.unwrap();
    assert_eq!(handshake.status(), StatusCode::SWITCHING_PROTOCOLS);

    socket
        .send(Message::Text(
            json!({
                "type": "response.create",
                "model": "client-test",
                "input": "use tool",
                "tools": [{"type":"function","name":"lookup"}]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let first_message = socket.next().await.unwrap().unwrap();
    let first_event: Value = serde_json::from_str(first_message.to_text().unwrap()).unwrap();
    assert_eq!(first_event["type"], "response.completed");
    assert_eq!(first_event["response"]["id"], "resp_server_remote_1");
    assert_eq!(
        first_event["response"]["output"][0]["type"],
        "function_call"
    );

    socket
        .send(Message::Text(
            json!({
                "type": "response.create",
                "model": "client-test",
                "previous_response_id": "resp_server_remote_1",
                "input": [{"type":"function_call_output","call_id":"call_server_1","output":"ok"}]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let second_message = socket.next().await.unwrap().unwrap();
    let second_event: Value = serde_json::from_str(second_message.to_text().unwrap()).unwrap();
    assert_eq!(second_event["type"], "response.completed");
    assert_eq!(second_event["response"]["id"], "resp_server_remote_2");

    let handshake_capture = captures.recv().await.unwrap();
    assert_eq!(
        handshake_capture.authorization.as_deref(),
        Some("Bearer secret-p6-inbound-ws-two-turn")
    );
    let first_capture = captures.recv().await.unwrap();
    let second_capture = captures.recv().await.unwrap();
    assert_eq!(first_capture.body["type"], "response.create");
    assert_eq!(second_capture.body["type"], "response.create");
    assert_eq!(
        second_capture.body["previous_response_id"],
        "resp_server_remote_1"
    );
    assert_control_fields_absent(&first_capture.body);
    assert_control_fields_absent(&second_capture.body);

    let logs: Value = reqwest::Client::new()
        .get(format!(
            "http://{}/_routecodex/debug/logs",
            handle.listeners[0].addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events = logs["logs"].as_array().unwrap();
    let router_hits = events
        .iter()
        .filter(|event| event["node_id"] == "V3Router07OpaqueTargetHitOnce")
        .count();
    assert_eq!(
        router_hits, 1,
        "second WebSocket turn must use existing continuation owner without Router re-entry"
    );
    assert!(events
        .iter()
        .any(|event| event["node_id"] == "V3HubReqContinuation03Classified"));

    std::env::remove_var("V3_P6_TEST_KEY");
    let _ = socket.close(None).await;
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn responses_inbound_websocket_scope_mismatch_fails_before_provider_send() {
    let _test_guard = TEST_LOCK.lock().await;
    let (websocket_v2_url, mut captures, shutdown) =
        start_controlled_continuation_websocket().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-inbound-ws-scope");
    let handle = spawn_v3_server_aggregate(p6_remote_continuation_manifest(
        free_port(),
        free_port(),
        &websocket_v2_url,
    ))
    .await
    .unwrap();
    let endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    let mut first_request = endpoint.clone().into_client_request().unwrap();
    first_request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    first_request.headers_mut().insert(
        "session-id",
        HeaderValue::from_static("session-inbound-scope-a"),
    );
    first_request.headers_mut().insert(
        "thread-id",
        HeaderValue::from_static("thread-inbound-scope-a"),
    );
    let (mut first_socket, _) = connect_async(first_request).await.unwrap();
    first_socket
        .send(Message::Text(
            json!({
                "type": "response.create",
                "model": "client-test",
                "input": "use tool",
                "tools": [{"type":"function","name":"lookup"}]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let first_message = first_socket.next().await.unwrap().unwrap();
    let first_event: Value = serde_json::from_str(first_message.to_text().unwrap()).unwrap();
    assert_eq!(first_event["response"]["id"], "resp_server_remote_1");
    let _ = first_socket.close(None).await;

    let mut second_request = endpoint.into_client_request().unwrap();
    second_request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    second_request.headers_mut().insert(
        "session-id",
        HeaderValue::from_static("session-inbound-scope-b"),
    );
    second_request.headers_mut().insert(
        "thread-id",
        HeaderValue::from_static("thread-inbound-scope-b"),
    );
    let (mut second_socket, _) = connect_async(second_request).await.unwrap();
    second_socket
        .send(Message::Text(
            json!({
                "type": "response.create",
                "model": "client-test",
                "previous_response_id": "resp_server_remote_1",
                "input": [{"type":"function_call_output","call_id":"call_server_1","output":"ok"}]
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let second_message = second_socket.next().await.unwrap().unwrap();
    let second_event: Value = serde_json::from_str(second_message.to_text().unwrap()).unwrap();
    assert_eq!(second_event["type"], "error");
    assert_eq!(second_event["error"]["code"], "runtime_error");

    let _handshake_capture = captures.recv().await.unwrap();
    let first_capture = captures.recv().await.unwrap();
    assert_eq!(first_capture.body["type"], "response.create");
    assert!(captures.try_recv().is_err());

    std::env::remove_var("V3_P6_TEST_KEY");
    let _ = second_socket.close(None).await;
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn responses_inbound_websocket_projects_provider_error_as_websocket_error_without_http_fallback(
) {
    let _test_guard = TEST_LOCK.lock().await;
    let closed_websocket_url = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        format!("ws://{addr}/v1/responses")
    };
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-inbound-ws-provider-error");
    let handle = spawn_v3_server_aggregate(p6_remote_continuation_manifest(
        free_port(),
        free_port(),
        &closed_websocket_url,
    ))
    .await
    .unwrap();
    let endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    let mut request = endpoint.into_client_request().unwrap();
    request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    let (mut socket, handshake) = connect_async(request).await.unwrap();
    assert_eq!(handshake.status(), StatusCode::SWITCHING_PROTOCOLS);
    socket
        .send(Message::Text(
            json!({
                "type": "response.create",
                "model": "client-test",
                "input": "hello"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let message = timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let event: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(event["type"], "error");
    assert_eq!(event["error"]["code"], "runtime_error");
    assert!(event["error"]["message"].as_str().unwrap_or_default().len() > 8);

    std::env::remove_var("V3_P6_TEST_KEY");
    let _ = socket.close(None).await;
    handle.shutdown().await;
}

#[tokio::test]
async fn responses_inbound_websocket_client_disconnect_drops_incremental_runtime_stream() {
    let _test_guard = TEST_LOCK.lock().await;
    let (websocket_v2_url, mut captures, provider_closed) =
        start_incremental_controlled_continuation_websocket().await;
    std::env::set_var("V3_P6_TEST_KEY", "secret-p6-inbound-ws-disconnect");
    let handle = spawn_v3_server_aggregate(p6_remote_continuation_manifest(
        free_port(),
        free_port(),
        &websocket_v2_url,
    ))
    .await
    .unwrap();
    let endpoint = format!("ws://{}/v1/responses", handle.listeners[0].addr);
    let mut request = endpoint.into_client_request().unwrap();
    request.headers_mut().insert(
        "openai-beta",
        HeaderValue::from_static("responses_websockets=2026-02-06"),
    );
    let (mut socket, handshake) = connect_async(request).await.unwrap();
    assert_eq!(handshake.status(), StatusCode::SWITCHING_PROTOCOLS);
    socket
        .send(Message::Text(
            json!({
                "type": "response.create",
                "model": "client-test",
                "stream": true,
                "input": "stream then disconnect"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let first_message = timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let first_event: Value = serde_json::from_str(first_message.to_text().unwrap()).unwrap();
    assert_eq!(first_event["type"], "response.output_text.delta");
    drop(socket);
    timeout(Duration::from_secs(3), provider_closed)
        .await
        .expect("provider websocket must observe client disconnect")
        .unwrap();

    let handshake_capture = captures.recv().await.unwrap();
    assert_eq!(
        handshake_capture.authorization.as_deref(),
        Some("Bearer secret-p6-inbound-ws-disconnect")
    );
    let provider_event = captures.recv().await.unwrap();
    assert_eq!(provider_event.body["type"], "response.create");
    assert_control_fields_absent(&provider_event.body);

    std::env::remove_var("V3_P6_TEST_KEY");
    handle.shutdown().await;
}

fn assert_control_fields_absent(body: &Value) {
    for forbidden in [
        "session_id",
        "thread_id",
        "provider_id",
        "auth_alias",
        "continuation_owner",
        "capability_revision",
        "routing_group",
    ] {
        assert!(body.get(forbidden).is_none(), "{forbidden}: {body}");
    }
}

#[tokio::test]
async fn p6_provider_failure_reselects_inside_target_without_router_reentry() {
    let _test_guard = TEST_LOCK.lock().await;
    let (failed_provider_base_url, failed_shutdown) = start_controlled_failure_upstream().await;
    let (provider_base_url, mut captures, shutdown) = start_controlled_upstream().await;
    std::env::set_var("V3_P6_RESELECT_FIRST_KEY", "secret-first");
    std::env::set_var("V3_P6_RESELECT_SECOND_KEY", "secret-second");
    let handle = spawn_v3_server_aggregate(p6_reselection_manifest(
        free_port(),
        free_port(),
        &failed_provider_base_url,
        &provider_base_url,
        "V3_P6_RESELECT_FIRST_KEY",
        "V3_P6_RESELECT_SECOND_KEY",
    ))
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .json(&json!({"model":"client-test","input":"hello"}))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let response_body = response.text().await.unwrap();
    assert_eq!(status, 200, "unexpected response body: {response_body}");
    let body: Value = serde_json::from_str(&response_body).unwrap();
    assert_eq!(body, json!({"id": "resp_json", "output_text": "ok"}));
    let capture = captures.recv().await.unwrap();
    assert_eq!(
        capture.authorization.as_deref(),
        Some("Bearer secret-second")
    );
    assert_eq!(capture.body["model"], "wire-second");

    let logs: Value = client
        .get(format!(
            "http://{}/_routecodex/debug/logs",
            handle.listeners[0].addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events = logs["logs"].as_array().unwrap();
    let router_hits = events
        .iter()
        .filter(|event| event["node_id"] == "V3Router07OpaqueTargetHitOnce")
        .count();
    assert_eq!(
        router_hits, 1,
        "Target reselection must not re-enter Router"
    );
    assert!(events
        .iter()
        .any(|event| event["node_id"] == "V3TargetLocalReselected"));
    std::env::remove_var("V3_P6_RESELECT_FIRST_KEY");
    std::env::remove_var("V3_P6_RESELECT_SECOND_KEY");
    handle.shutdown().await;
    failed_shutdown.send(()).unwrap();
    shutdown.send(()).unwrap();
}

#[tokio::test]
async fn p6_all_provider_failures_project_terminal_error_chain() {
    let _test_guard = TEST_LOCK.lock().await;
    let closed_a = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{addr}/v1")
    };
    let closed_b = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{addr}/v1")
    };
    std::env::set_var("V3_P6_EXHAUST_FIRST_KEY", "secret-first");
    std::env::set_var("V3_P6_EXHAUST_SECOND_KEY", "secret-second");
    let handle = spawn_v3_server_aggregate(p6_reselection_manifest(
        free_port(),
        free_port(),
        &closed_a,
        &closed_b,
        "V3_P6_EXHAUST_FIRST_KEY",
        "V3_P6_EXHAUST_SECOND_KEY",
    ))
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .json(&json!({"model":"client-test","input":"hello"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 502);
    assert_eq!(
        response.headers()["x-routecodex-v3-error-chain"],
        "V3Error01SourceRaised,V3Error02Classified,V3Error03TargetLocalAction,V3Error04TargetExhaustionDecision,V3Error05ExecutionDecision,V3Error06ClientProjected"
    );
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "provider_transport_error");
    assert_eq!(body["error"]["target_exhausted"], true);
    assert_eq!(body["error"]["candidates_remaining"], 0);
    assert_eq!(body["error"]["decision"], "project_client_error");
    std::env::remove_var("V3_P6_EXHAUST_FIRST_KEY");
    std::env::remove_var("V3_P6_EXHAUST_SECOND_KEY");
    handle.shutdown().await;
}

#[tokio::test]
async fn debug_endpoints_project_shared_runtime_state_and_dry_run_no_send() {
    let _test_guard = TEST_LOCK.lock().await;
    let handle = spawn_v3_server_aggregate(manifest(free_port(), free_port()))
        .await
        .unwrap();
    let listener = &handle.listeners[0];
    let client = reqwest::Client::new();
    let runtime_error = client
        .post(format!("http://{}/v1/responses", listener.addr))
        .json(&serde_json::json!({
            "model": "test",
            "input": "hello",
            "Authorization": "Bearer sk-v3-secret"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(runtime_error.status(), 502);

    let status: serde_json::Value = client
        .get(format!("http://{}/_routecodex/debug/status", listener.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(status["debug"]["event_count"].as_u64().unwrap() >= 3);
    assert_eq!(status["debug"]["raw_request_count"], 1);

    let logs: serde_json::Value = client
        .get(format!("http://{}/_routecodex/debug/logs", listener.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let serialized_logs = serde_json::to_string(&logs).unwrap();
    assert!(serialized_logs.contains("V3Server03HttpRequestRaw"));
    assert!(serialized_logs.contains("V3Error06ClientProjected"));
    assert!(!serialized_logs.contains("sk-v3-secret"));

    let dry_run: serde_json::Value = client
        .post(format!(
            "http://{}/_routecodex/debug/dry-run",
            listener.addr
        ))
        .json(&serde_json::json!({
            "fixture_id": "server-dry-run",
            "method": "POST",
            "path": "/v1/responses",
            "request_payload": {"input": "fixed", "authorization": "Bearer dry-run-request-secret"},
            "response_payload": {"id": "fixed-response", "api_key": "dry-run-response-secret"}
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(dry_run["dry_run"]["terminal_effect"], "no_network_send");
    assert_eq!(dry_run["dry_run"]["provider_pipeline_executed"], true);
    assert_eq!(dry_run["dry_run"]["provider_network_send"], false);
    assert_eq!(dry_run["dry_run"]["stopped_before_network_send"], true);
    assert_eq!(dry_run["dry_run"]["stopped_before_provider_send"], true);
    assert_eq!(
        dry_run["dry_run"]["response_payload"]["id"],
        "fixed-response"
    );
    let serialized_dry_run = serde_json::to_string(&dry_run).unwrap();
    assert!(!serialized_dry_run.contains("dry-run-request-secret"));
    assert!(!serialized_dry_run.contains("dry-run-response-secret"));
    let node_ids = dry_run["dry_run"]["node_ids"].as_array().unwrap();
    for node in [
        "V3Server03HttpRequestRaw",
        "V3Req04StandardizedResponses",
        "V3Router05RequestClassified",
        "V3Router06RoutePoolResolved",
        "V3Router07OpaqueTargetHitOnce",
        "V3Target08KindClassified",
        "V3Target09CandidateSetExpanded",
        "V3Target10ConcreteProviderSelected",
        "V3ResponsesDirect11Policy",
        "V3Provider12ResponsesWirePayload",
        "V3Transport13ResponsesHttpRequest",
        "V3DryRunNoNetworkTerminalEffect",
        "V3ProviderResp14Raw",
        "V3Resp15ClientPayload",
        "V3Server16HttpFrame",
    ] {
        assert!(node_ids.iter().any(|value| value == node), "{node}");
    }
    assert!(
        !dry_run["dry_run"]["snapshots"]
            .as_array()
            .unwrap()
            .is_empty(),
        "dry run response should carry this execution's transient snapshots"
    );

    let snapshots: serde_json::Value = client
        .get(format!(
            "http://{}/_routecodex/debug/snapshots",
            listener.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        snapshots["snapshots"].as_array().unwrap().is_empty(),
        "dry run snapshot session must be released after response projection"
    );
    handle.shutdown().await;
}

#[tokio::test]
async fn malformed_and_disabled_dry_run_enter_six_node_error_chain_without_panic() {
    let _test_guard = TEST_LOCK.lock().await;
    let client = reqwest::Client::new();
    let enabled = spawn_v3_server_aggregate(manifest(free_port(), free_port()))
        .await
        .unwrap();
    let malformed = client
        .post(format!(
            "http://{}/_routecodex/debug/dry-run",
            enabled.listeners[0].addr
        ))
        .json(&serde_json::json!({"fixture_id": "missing-required-fields"}))
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), 500);
    assert_eq!(
        malformed.headers()["x-routecodex-v3-error-node"],
        "V3Error06ClientProjected"
    );
    assert_eq!(
        malformed.headers()["x-routecodex-v3-error-chain"],
        "V3Error01SourceRaised,V3Error02Classified,V3Error03TargetLocalAction,V3Error04TargetExhaustionDecision,V3Error05ExecutionDecision,V3Error06ClientProjected"
    );
    let malformed_body: serde_json::Value = malformed.json().await.unwrap();
    assert_eq!(malformed_body["error"]["code"], "v3_debug_failure");
    assert!(malformed_body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("malformed dry-run fixture"));
    enabled.shutdown().await;

    let disabled =
        spawn_v3_server_aggregate(manifest_with_debug(free_port(), free_port(), true, false))
            .await
            .unwrap();
    let response = client
        .post(format!(
            "http://{}/_routecodex/debug/dry-run",
            disabled.listeners[0].addr
        ))
        .json(&serde_json::json!({
            "fixture_id": "disabled",
            "method": "POST",
            "path": "/v1/responses",
            "request_payload": {"input": "fixed"},
            "response_payload": {"id": "fixed"}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 500);
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("debug feature disabled: dry_run"));
    disabled.shutdown().await;
}

#[tokio::test]
async fn one_bind_failure_prevents_aggregate_start() {
    let _test_guard = TEST_LOCK.lock().await;
    let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
    let occupied_port = occupied.local_addr().unwrap().port();
    let first_port = free_port();
    let result = spawn_v3_server_aggregate(manifest(first_port, occupied_port)).await;
    assert!(result.is_err());
    let rebound = TcpListener::bind(("127.0.0.1", first_port));
    assert!(
        rebound.is_ok(),
        "aggregate failure must release earlier preflight binds"
    );
}

#[tokio::test]
async fn invalid_http_boundaries_fail_before_runtime_with_typed_error_chain() {
    let _test_guard = TEST_LOCK.lock().await;
    let mut strict_manifest = manifest(free_port(), free_port());
    for server in strict_manifest.servers.values_mut() {
        server.endpoints = vec!["responses".to_string()];
    }
    let handle = spawn_v3_server_aggregate(strict_manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();

    let cases = [
        (
            client
                .post(format!("{base}/v1/messages"))
                .header("content-type", "application/json")
                .body("{}")
                .send()
                .await
                .unwrap(),
            StatusCode::NOT_IMPLEMENTED,
            "endpoint_not_enabled",
        ),
        (
            client
                .get(format!("{base}/v1/responses"))
                .send()
                .await
                .unwrap(),
            StatusCode::BAD_REQUEST,
            "websocket_upgrade_required",
        ),
        (
            client
                .post(format!("{base}/v1/unknown"))
                .send()
                .await
                .unwrap(),
            StatusCode::NOT_FOUND,
            "path_not_found",
        ),
        (
            client
                .post(format!("{base}/v1/responses"))
                .body(r#"{"input":"hello"}"#)
                .send()
                .await
                .unwrap(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "content_type_required",
        ),
        (
            client
                .post(format!("{base}/v1/responses"))
                .header("content-type", "text/plain")
                .body(r#"{"input":"hello"}"#)
                .send()
                .await
                .unwrap(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "content_type_unsupported",
        ),
        (
            client
                .post(format!("{base}/v1/responses"))
                .header("content-type", "application/json")
                .body("{")
                .send()
                .await
                .unwrap(),
            StatusCode::BAD_REQUEST,
            "malformed_json",
        ),
        (
            client
                .post(format!("{base}/v1/responses"))
                .header("content-type", "application/json")
                .body(vec![b'x'; 64 * 1024 * 1024 + 1])
                .send()
                .await
                .unwrap(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "body_too_large",
        ),
    ];

    for (response, expected_status, expected_code) in cases {
        assert_eq!(response.status(), expected_status);
        assert_eq!(
            response.headers()["x-routecodex-v3-error-node"],
            "V3Error06ClientProjected"
        );
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], expected_code);
        assert_eq!(body["error"]["stage"], "V3Server03HttpRequestRaw");
    }

    let logs: Value = client
        .get(format!("{base}/_routecodex/debug/logs"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        !serde_json::to_string(&logs)
            .unwrap()
            .contains("V3Server03HttpRequestRaw"),
        "invalid HTTP input must not enter Runtime"
    );
    handle.shutdown().await;
}
