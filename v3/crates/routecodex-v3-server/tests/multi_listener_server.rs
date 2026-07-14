use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use std::net::TcpListener;

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
            .post(format!("http://{}/v1/responses", listener.addr))
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
async fn debug_endpoints_project_shared_runtime_state_and_dry_run_no_send() {
    let handle = spawn_v3_server_aggregate(manifest(free_port(), free_port()))
        .await
        .unwrap();
    let listener = &handle.listeners[0];
    let client = reqwest::Client::new();
    let pending = client
        .post(format!("http://{}/v1/responses", listener.addr))
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
