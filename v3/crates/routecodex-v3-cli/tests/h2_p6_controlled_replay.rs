use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, Response, StatusCode},
    routing::post,
    Router,
};
use reqwest::StatusCode as ReqwestStatusCode;
use serde_json::{json, Value};
use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{mpsc, oneshot},
    time::{sleep, timeout},
};

#[path = "../../../tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

const H2_SCENARIOS: &[&str] = &[
    "json_baseline",
    "sse_baseline",
    "target_local_reselection",
    "default_pool_exhaustion",
    "dry_run_no_network",
    "debug_side_channel",
];

#[derive(Debug, Clone)]
struct ProviderCapture {
    authorization: Option<String>,
    accept: Option<String>,
    body: Value,
}

#[derive(Debug, Clone)]
enum ProviderMode {
    Success,
    Failure { label: &'static str },
}

#[derive(Clone)]
struct ProviderState {
    mode: ProviderMode,
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

struct ControlledUpstream {
    base_url: String,
    captures: mpsc::UnboundedReceiver<ProviderCapture>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl Drop for ControlledUpstream {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

struct CliProcess {
    child: Child,
}

impl Drop for CliProcess {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[tokio::test]
async fn h2_p6_cli_controlled_upstream_replay_covers_equivalence_baseline() {
    assert_eq!(H2_SCENARIOS.len(), 6);

    let mut success = start_controlled_upstream(ProviderMode::Success).await;
    let mut failure_a =
        start_controlled_upstream(ProviderMode::Failure { label: "failure-a" }).await;
    let mut failure_b =
        start_controlled_upstream(ProviderMode::Failure { label: "failure-b" }).await;
    let ports = H2Ports::allocate();
    let config_path = write_h2_config(&ports, &success, &failure_a, &failure_b);

    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config_path, ports.all());
    wait_for_health(&client, &mut cli, ports.success, "h2_success").await;
    wait_for_health(&client, &mut cli, ports.reselect, "h2_reselect").await;
    wait_for_health(&client, &mut cli, ports.exhausted, "h2_exhausted").await;

    let json_request = json!({
        "model": "client-test",
        "input": "json baseline",
        "metadata": {"h2_case": "json_baseline"}
    });
    let json_response = client
        .post(format!("http://127.0.0.1:{}/v1/responses", ports.success))
        .json(&json_request)
        .send()
        .await
        .unwrap();
    assert_eq!(json_response.status(), ReqwestStatusCode::OK);
    let json_trace = header_trace(&json_response);
    assert_eq!(count_node(&json_trace, "V3Router07OpaqueTargetHitOnce"), 1);
    assert_trace_tail(
        &json_trace,
        &[
            "V3ProviderResp14Raw",
            "V3Resp15ClientPayload",
            "V3Server16HttpFrame",
        ],
    );
    assert_eq!(
        json_response.headers()["content-type"].to_str().unwrap(),
        "application/json"
    );
    let json_client_body_text = json_response.text().await.unwrap();
    let json_client_body: Value = serde_json::from_str(&json_client_body_text).unwrap();
    assert_eq!(json_client_body, json!({"id":"h2_json","output_text":"ok"}));
    assert!(
        !json_client_body_text.contains("V3")
            && !json_client_body_text.contains("routecodex")
            && !json_client_body_text.contains("debug"),
        "client normal JSON body must not carry debug/control state"
    );
    let json_capture = next_capture(&mut success.captures, "json success").await;
    assert_eq!(
        json_capture.authorization.as_deref(),
        Some("Bearer h2-success-secret")
    );
    assert_eq!(json_capture.accept.as_deref(), Some("application/json"));
    assert_eq!(json_capture.body["model"], "wire-success");
    assert_eq!(json_capture.body["input"], json_request["input"]);
    assert_eq!(json_capture.body["metadata"], json_request["metadata"]);
    assert_no_internal_wire_fields(&json_capture.body);

    let sse_request = json!({
        "model": "client-test",
        "input": "sse baseline",
        "stream": true,
        "metadata": {"h2_case": "sse_baseline"}
    });
    let sse_response = client
        .post(format!("http://127.0.0.1:{}/v1/responses", ports.success))
        .json(&sse_request)
        .send()
        .await
        .unwrap();
    assert_eq!(sse_response.status(), ReqwestStatusCode::OK);
    let sse_trace = header_trace(&sse_response);
    assert_eq!(count_node(&sse_trace, "V3Router07OpaqueTargetHitOnce"), 1);
    assert_trace_tail(
        &sse_trace,
        &[
            "V3ProviderResp14Raw",
            "V3Resp15ClientPayload",
            "V3Server16HttpFrame",
        ],
    );
    assert_eq!(
        sse_response.headers()["content-type"].to_str().unwrap(),
        "text/event-stream"
    );
    let sse_body = sse_response.text().await.unwrap();
    assert_eq!(
        sse_body,
        "event: response.created\ndata: {\"id\":\"h2_sse\"}\n\ndata: [DONE]\n\n"
    );
    let sse_capture = next_capture(&mut success.captures, "sse success").await;
    assert_eq!(sse_capture.accept.as_deref(), Some("text/event-stream"));
    assert_eq!(sse_capture.body["model"], "wire-success");
    assert_eq!(sse_capture.body["stream"], true);
    assert_no_internal_wire_fields(&sse_capture.body);

    let reselect_response = client
        .post(format!("http://127.0.0.1:{}/v1/responses", ports.reselect))
        .json(&json!({
            "model": "client-test",
            "input": "target local reselection",
            "metadata": {"h2_case": "target_local_reselection"}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(reselect_response.status(), ReqwestStatusCode::OK);
    let reselect_trace = header_trace(&reselect_response);
    assert_eq!(
        count_node(&reselect_trace, "V3Router07OpaqueTargetHitOnce"),
        1
    );
    assert!(has_node(&reselect_trace, "V3TargetLocalReselected"));
    let reselect_body: Value = reselect_response.json().await.unwrap();
    assert_eq!(reselect_body, json!({"id":"h2_json","output_text":"ok"}));
    let first_failure = next_capture(&mut failure_a.captures, "reselect first failure").await;
    assert_eq!(
        first_failure.authorization.as_deref(),
        Some("Bearer h2-failure-a-secret")
    );
    assert_eq!(first_failure.body["model"], "wire-failure-a");
    let reselect_success = next_capture(&mut success.captures, "reselect success").await;
    assert_eq!(
        reselect_success.authorization.as_deref(),
        Some("Bearer h2-success-secret")
    );
    assert_eq!(reselect_success.body["model"], "wire-success");

    let exhausted_response = client
        .post(format!("http://127.0.0.1:{}/v1/responses", ports.exhausted))
        .json(&json!({
            "model": "client-test",
            "input": "default pool exhaustion",
            "metadata": {"h2_case": "default_pool_exhaustion"}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(exhausted_response.status(), ReqwestStatusCode::BAD_GATEWAY);
    assert_eq!(
        exhausted_response.headers()["x-routecodex-v3-error-chain"]
            .to_str()
            .unwrap(),
        "V3Error01SourceRaised,V3Error02Classified,V3Error03TargetLocalAction,V3Error04TargetExhaustionDecision,V3Error05ExecutionDecision,V3Error06ClientProjected"
    );
    let exhausted_trace = header_trace(&exhausted_response);
    assert_eq!(
        count_node(&exhausted_trace, "V3Router07OpaqueTargetHitOnce"),
        1
    );
    assert!(has_node(&exhausted_trace, "V3TargetLocalReselected"));
    let exhausted_body: Value = exhausted_response.json().await.unwrap();
    assert_eq!(exhausted_body["error"]["code"], "provider_transport_error");
    assert_eq!(exhausted_body["error"]["target_exhausted"], true);
    assert_eq!(exhausted_body["error"]["candidates_remaining"], 0);
    assert_eq!(exhausted_body["error"]["decision"], "project_client_error");
    let exhausted_first = next_capture(&mut failure_a.captures, "exhaustion first").await;
    assert_eq!(exhausted_first.body["model"], "wire-failure-a");
    let exhausted_second = next_capture(&mut failure_b.captures, "exhaustion second").await;
    assert_eq!(exhausted_second.body["model"], "wire-failure-b");

    let dry_run_response = client
        .post(format!(
            "http://127.0.0.1:{}/_routecodex/debug/dry-run",
            ports.success
        ))
        .json(&json!({
            "fixture_id": "h2-dry-run",
            "method": "POST",
            "path": "/v1/responses",
            "request_payload": {
                "model": "client-test",
                "input": "dry run",
                "authorization": "Bearer dry-run-request-secret"
            },
            "response_payload": {
                "id": "h2_dry_run",
                "api_key": "dry-run-response-secret"
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(dry_run_response.status(), ReqwestStatusCode::OK);
    let dry_run: Value = dry_run_response.json().await.unwrap();
    assert_eq!(dry_run["dry_run"]["terminal_effect"], "no_network_send");
    assert_eq!(dry_run["dry_run"]["provider_pipeline_executed"], true);
    assert_eq!(dry_run["dry_run"]["provider_network_send"], false);
    assert_eq!(dry_run["dry_run"]["stopped_before_network_send"], true);
    assert_eq!(dry_run["dry_run"]["stopped_before_provider_send"], true);
    let dry_nodes = dry_run["dry_run"]["node_ids"].as_array().unwrap();
    for node in [
        "V3Provider12ResponsesWirePayload",
        "V3Transport13ResponsesHttpRequest",
        "V3DryRunNoNetworkTerminalEffect",
        "V3ProviderResp14Raw",
        "V3Resp15ClientPayload",
        "V3Server16HttpFrame",
    ] {
        assert!(dry_nodes.iter().any(|value| value == node), "{node}");
    }
    let dry_run_serialized = serde_json::to_string(&dry_run).unwrap();
    assert!(!dry_run_serialized.contains("dry-run-request-secret"));
    assert!(!dry_run_serialized.contains("dry-run-response-secret"));
    sleep(Duration::from_millis(50)).await;
    assert_no_extra_capture(&mut success.captures, "success after dry run");
    assert_no_extra_capture(&mut failure_a.captures, "failure-a after dry run");
    assert_no_extra_capture(&mut failure_b.captures, "failure-b after dry run");

    let logs: Value = client
        .get(format!(
            "http://127.0.0.1:{}/_routecodex/debug/logs",
            ports.success
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let log_text = serde_json::to_string(&logs).unwrap();
    for node in [
        "V3Server03HttpRequestRaw",
        "V3Provider12ResponsesWirePayload",
        "V3Transport13ResponsesHttpRequest",
        "V3ProviderResp14Raw",
        "V3Resp15ClientPayload",
        "V3Server16HttpFrame",
    ] {
        assert!(log_text.contains(node), "{node}");
    }
    for secret in [
        "h2-success-secret",
        "h2-failure-a-secret",
        "h2-failure-b-secret",
        "dry-run-request-secret",
        "dry-run-response-secret",
    ] {
        assert!(!log_text.contains(secret), "{secret}");
    }
    let snapshots: Value = client
        .get(format!(
            "http://127.0.0.1:{}/_routecodex/debug/snapshots",
            ports.success
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(snapshots["snapshots"].as_array().unwrap().is_empty());

    let request_ids = collect_request_ids(&logs);
    let evidence_path = write_evidence_artifact(json!({
        "feature_id": "v3.responses_direct_h2_equivalence_harness",
        "command": "npm run test:v3-h2-p6-controlled-replay",
        "expected_exit_code": 0,
        "scenarios": H2_SCENARIOS,
        "config": config_path.display().to_string(),
        "ports": {
            "success": ports.success,
            "reselect": ports.reselect,
            "exhausted": ports.exhausted,
        },
        "controlled_upstreams": {
            "success": success.base_url,
            "failure_a": failure_a.base_url,
            "failure_b": failure_b.base_url,
        },
        "request_ids": request_ids,
        "payload_observations": {
            "json": {
                "client_request": json_request,
                "provider_wire_request": json_capture.body,
                "authorization_present": json_capture.authorization.is_some(),
                "provider_raw_response": {"id":"h2_json","output_text":"ok"},
                "client_response": json_client_body
            },
            "sse": {
                "client_request": sse_request,
                "provider_wire_request": sse_capture.body,
                "authorization_present": sse_capture.authorization.is_some(),
                "provider_raw_response": sse_body.clone(),
                "client_response": sse_body
            },
            "target_local_reselection": {
                "first_provider_wire_request": first_failure.body,
                "second_provider_wire_request": reselect_success.body,
                "client_response": reselect_body
            },
            "default_pool_exhaustion": {
                "first_provider_wire_request": exhausted_first.body,
                "second_provider_wire_request": exhausted_second.body,
                "client_response": exhausted_body
            },
            "dry_run": dry_run
        },
        "observations": {
            "json_trace": json_trace,
            "sse_trace": sse_trace,
            "reselect_trace": reselect_trace,
            "exhausted_trace": exhausted_trace,
            "json_provider_wire_model": json_capture.body["model"],
            "sse_provider_wire_model": sse_capture.body["model"],
            "dry_run_provider_pipeline_executed": dry_run["dry_run"]["provider_pipeline_executed"],
            "dry_run_provider_network_send": dry_run["dry_run"]["provider_network_send"]
        }
    }));
    println!(
        "H2 P6 controlled replay evidence: {}",
        evidence_path.display()
    );

    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

async fn controlled_responses_upstream(
    State(state): State<Arc<ProviderState>>,
    headers: HeaderMap,
    body: String,
) -> Response<Body> {
    let parsed = serde_json::from_str::<Value>(&body).unwrap_or_else(|_| json!({"raw": body}));
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
            body: parsed.clone(),
        })
        .unwrap();

    match &state.mode {
        ProviderMode::Success if parsed.get("stream").and_then(Value::as_bool) == Some(true) => {
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(
                    "event: response.created\ndata: {\"id\":\"h2_sse\"}\n\ndata: [DONE]\n\n",
                ))
                .unwrap()
        }
        ProviderMode::Success => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(r#"{"id":"h2_json","output_text":"ok"}"#))
            .unwrap(),
        ProviderMode::Failure { label } => Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"error":"controlled_{label}"}}"#)))
            .unwrap(),
    }
}

async fn start_controlled_upstream(mode: ProviderMode) -> ControlledUpstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_responses_upstream))
        .with_state(Arc::new(ProviderState {
            mode,
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
    ControlledUpstream {
        base_url: format!("http://{address}/v1"),
        captures: captures_rx,
        shutdown: Some(shutdown_tx),
    }
}

#[derive(Debug, Clone, Copy)]
struct H2Ports {
    success: u16,
    reselect: u16,
    exhausted: u16,
}

impl H2Ports {
    fn allocate() -> Self {
        Self {
            success: free_port(),
            reselect: free_port(),
            exhausted: free_port(),
        }
    }

    fn all(self) -> Vec<u16> {
        vec![self.success, self.reselect, self.exhausted]
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn write_h2_config(
    ports: &H2Ports,
    success: &ControlledUpstream,
    failure_a: &ControlledUpstream,
    failure_b: &ControlledUpstream,
) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "routecodex-v3-h2-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("config.h2.toml");
    fs::write(
        &path,
        format!(
            r#"
version = 3

[features]
responses_direct = true
debug_events = true

{hub_v1_declaration}

[debug]
log_console = false
snapshots = true
dry_run = true
retention = {{ raw_requests = 32, raw_responses = 32, events = 512 }}

[error.policies.target_pool_exhausted]
action = "project_client_error"

[servers.h2_success]
bind = "127.0.0.1"
port = {success_port}
routing_group = "h2_success"
endpoints = ["responses"]

{success_execution}

[servers.h2_reselect]
bind = "127.0.0.1"
port = {reselect_port}
routing_group = "h2_reselect"
endpoints = ["responses"]

{reselect_execution}

[servers.h2_exhausted]
bind = "127.0.0.1"
port = {exhausted_port}
routing_group = "h2_exhausted"
endpoints = ["responses"]

{exhausted_execution}

[providers.success]
type = "responses"
base_url = "{success_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "success", env = "ROUTECODEX_V3_H2_SUCCESS_KEY" }}] }}

[providers.success.models.test]
wire_name = "wire-success"
aliases = ["client-test"]
capabilities = ["text", "tools"]
supports_streaming = true
supports_thinking = true
thinking = "optional"
max_tokens = 4096
max_context_tokens = 128000

[providers.failure_a]
type = "responses"
base_url = "{failure_a_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "failure-a", env = "ROUTECODEX_V3_H2_FAILURE_A_KEY" }}] }}

[providers.failure_a.models.test]
wire_name = "wire-failure-a"
supports_streaming = true

[providers.failure_b]
type = "responses"
base_url = "{failure_b_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "failure-b", env = "ROUTECODEX_V3_H2_FAILURE_B_KEY" }}] }}

[providers.failure_b.models.test]
wire_name = "wire-failure-b"
supports_streaming = true

[forwarders.h2_success]
model = "test"
aliases = ["client-test"]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "success", model = "test", key = "success", priority = 1 }}
]

[forwarders.h2_reselect]
model = "test"
aliases = ["client-test"]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "failure_a", model = "test", key = "failure-a", priority = 1 }},
  {{ kind = "provider_model", provider = "success", model = "test", key = "success", priority = 2 }}
]

[forwarders.h2_exhausted]
model = "test"
aliases = ["client-test"]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "failure_a", model = "test", key = "failure-a", priority = 1 }},
  {{ kind = "provider_model", provider = "failure_b", model = "test", key = "failure-b", priority = 2 }}
]

[route_groups.h2_success.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "h2_success", priority = 1 }}]

[route_groups.h2_reselect.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "h2_reselect", priority = 1 }}]

[route_groups.h2_exhausted.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "h2_exhausted", priority = 1 }}]
"#,
            success_port = ports.success,
            reselect_port = ports.reselect,
            exhausted_port = ports.exhausted,
            success_base = success.base_url,
            failure_a_base = failure_a.base_url,
            failure_b_base = failure_b.base_url,
            hub_v1_declaration = hub_v1_test_declaration(),
            success_execution = hub_v1_server_execution("h2_success"),
            reselect_execution = hub_v1_server_execution("h2_reselect"),
            exhausted_execution = hub_v1_server_execution("h2_exhausted"),
        ),
    )
    .unwrap();
    path
}

fn start_cli_server(config_path: &Path, _ports: Vec<u16>) -> CliProcess {
    let mut child = Command::new(env!("CARGO_BIN_EXE_routecodex-v3"))
        .args(["server", "start", "--foreground", "--config"])
        .arg(config_path)
        .env("ROUTECODEX_V3_H2_SUCCESS_KEY", "h2-success-secret")
        .env("ROUTECODEX_V3_H2_FAILURE_A_KEY", "h2-failure-a-secret")
        .env("ROUTECODEX_V3_H2_FAILURE_B_KEY", "h2-failure-b-secret")
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    eprintln!(
        "H2 CLI pid={} binary={} config={}",
        child.id(),
        env!("CARGO_BIN_EXE_routecodex-v3"),
        config_path.display()
    );
    assert!(
        matches!(child.try_wait(), Ok(None)),
        "routecodex-v3 CLI server exited during startup"
    );
    CliProcess { child }
}

async fn wait_for_health(
    client: &reqwest::Client,
    cli: &mut CliProcess,
    port: u16,
    server_id: &str,
) {
    let mut last_observation = String::from("no health attempt");
    for _ in 0..80 {
        if let Some(status) = cli.child.try_wait().unwrap() {
            panic!("routecodex-v3 CLI exited before health on {port}: {status}");
        }
        match client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                let body: Value = response.json().await.unwrap();
                assert_eq!(body["server_id"], server_id);
                assert_eq!(body["port"], port);
                return;
            }
            Ok(response) => {
                last_observation = format!("HTTP {}", response.status());
            }
            Err(error) => {
                last_observation = error.to_string();
            }
        }
        sleep(Duration::from_millis(100)).await;
    }
    panic!(
        "routecodex-v3 CLI health did not become ready on {port}; pid={}; last={last_observation}",
        cli.child.id()
    );
}

async fn next_capture(
    captures: &mut mpsc::UnboundedReceiver<ProviderCapture>,
    label: &str,
) -> ProviderCapture {
    timeout(Duration::from_secs(2), captures.recv())
        .await
        .unwrap_or_else(|_| panic!("{label}: timed out waiting for controlled upstream capture"))
        .unwrap_or_else(|| panic!("{label}: controlled upstream capture channel closed"))
}

fn assert_no_extra_capture(captures: &mut mpsc::UnboundedReceiver<ProviderCapture>, label: &str) {
    match captures.try_recv() {
        Err(mpsc::error::TryRecvError::Empty) => {}
        other => panic!("{label}: expected no controlled upstream capture, got {other:?}"),
    }
}

fn header_trace(response: &reqwest::Response) -> Vec<String> {
    response
        .headers()
        .get("x-routecodex-v3-node-trace")
        .expect("node trace header")
        .to_str()
        .unwrap()
        .split(',')
        .map(ToOwned::to_owned)
        .collect()
}

fn count_node(trace: &[String], node: &str) -> usize {
    trace
        .iter()
        .filter(|candidate| candidate.as_str() == node)
        .count()
}

fn has_node(trace: &[String], node: &str) -> bool {
    trace.iter().any(|candidate| candidate == node)
}

fn assert_trace_tail(trace: &[String], expected: &[&str]) {
    assert!(
        trace.len() >= expected.len()
            && trace[trace.len() - expected.len()..]
                .iter()
                .map(String::as_str)
                .eq(expected.iter().copied()),
        "trace tail mismatch: {trace:?}"
    );
}

fn assert_no_internal_wire_fields(body: &Value) {
    let serialized = serde_json::to_string(body).unwrap();
    for forbidden in [
        "routecodex",
        "V3",
        "node_trace",
        "error_chain",
        "debug_node",
        "provider_pipeline_executed",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "provider wire payload leaked internal field marker {forbidden}: {serialized}"
        );
    }
}

fn collect_request_ids(logs: &Value) -> Vec<String> {
    logs["logs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["request_id"].as_str())
        .map(ToOwned::to_owned)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn write_evidence_artifact(value: Value) -> std::path::PathBuf {
    let dir =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/h2-p6-controlled-replay");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("latest-evidence.json");
    fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    path.canonicalize().unwrap()
}

async fn wait_ports_closed(client: &reqwest::Client, ports: &[u16]) {
    for port in ports {
        for _ in 0..40 {
            if client
                .get(format!("http://127.0.0.1:{port}/health"))
                .send()
                .await
                .is_err()
            {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
        assert!(
            client
                .get(format!("http://127.0.0.1:{port}/health"))
                .send()
                .await
                .is_err(),
            "routecodex-v3 CLI port {port} should close after scoped child termination"
        );
    }
}
