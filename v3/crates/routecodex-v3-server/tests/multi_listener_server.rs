use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{net::TcpListener, sync::Arc};
use tokio::sync::{mpsc, oneshot};

fn manifest(port_a: u16, port_b: u16) -> routecodex_v3_config::V3Config05ManifestPublished {
    manifest_with_debug(port_a, port_b, true, true)
}

fn manifest_with_debug(
    port_a: u16,
    port_b: u16,
    snapshots: bool,
    dry_run: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "default"
[servers.b]
bind = "127.0.0.1"
port = {port_b}
routing_group = "default"
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
    let source = format!(
        r#"
version = 3
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "default"
[servers.b]
bind = "127.0.0.1"
port = {port_b}
routing_group = "default"
[providers.test]
type = "responses"
base_url = "{provider_base_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_P6_TEST_KEY" }}] }}
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

fn p6_reselection_manifest(
    port_a: u16,
    port_b: u16,
    first_base_url: &str,
    second_base_url: &str,
    first_env: &str,
    second_env: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "default"
[servers.b]
bind = "127.0.0.1"
port = {port_b}
routing_group = "default"
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
async fn starts_all_listeners_and_routes_pending_endpoint_through_debug_error_chain() {
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
        let pending = client
            .post(format!("http://{}/v1/messages", listener.addr))
            .send()
            .await
            .unwrap();
        assert_eq!(pending.status(), 501);
        assert_eq!(
            pending.headers()["x-routecodex-v3-debug-node"],
            "V3Debug01NodeEventRegistered"
        );
        assert_eq!(
            pending.headers()["x-routecodex-v3-error-node"],
            "V3Error06ClientProjected"
        );
        assert_eq!(
            pending.headers()["x-routecodex-v3-error-chain"],
            "V3Error01SourceRaised,V3Error02Classified,V3Error03TargetLocalAction,V3Error04TargetExhaustionDecision,V3Error05ExecutionDecision,V3Error06ClientProjected"
        );
        let body: serde_json::Value = pending.json().await.unwrap();
        assert_eq!(body["error"]["code"], "not_implemented");
        assert_eq!(
            body["error"]["error_node"], "V3Error06ClientProjected",
            "pending endpoint must expose final error node"
        );
        assert_eq!(body["error"]["target_exhausted"], true);
    }
    handle.shutdown().await;
}

#[tokio::test]
async fn p6_models_endpoint_projects_manifest_catalog_with_alias_capabilities() {
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
async fn p6_responses_endpoint_projects_sse_without_materialize_repair() {
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
async fn p6_provider_failure_reselects_inside_target_without_router_reentry() {
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
    let handle = spawn_v3_server_aggregate(manifest(free_port(), free_port()))
        .await
        .unwrap();
    let listener = &handle.listeners[0];
    let client = reqwest::Client::new();
    let pending = client
        .post(format!("http://{}/v1/messages", listener.addr))
        .json(&serde_json::json!({
            "input": "hello",
            "Authorization": "Bearer sk-v3-secret"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(pending.status(), 501);

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
            "request_payload": {"input": "fixed"},
            "response_payload": {"id": "fixed-response"}
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(dry_run["dry_run"]["terminal_effect"], "no_network_send");
    assert_eq!(dry_run["dry_run"]["stopped_before_provider_send"], true);
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
