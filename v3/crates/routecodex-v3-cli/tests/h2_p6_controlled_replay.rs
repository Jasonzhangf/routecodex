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
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, oneshot},
    time::{sleep, timeout},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

/// Budget for a foreground CLI server to answer `/health` on a cold start.
/// Generous on purpose: managed startup (config load, hooks sidecar, aggregate
/// bind) has been measured at over 10s on a loaded host, and a slow host is not
/// a broken server.
const HEALTH_READY_TIMEOUT: Duration = Duration::from_secs(60);

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
    CustomToolCall { input: String },
    Failure { label: &'static str },
    RateLimited,
    UpstreamBadGateway,
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
    _runtime_dir: TempDir,
}

struct H2Config {
    path: PathBuf,
    _config_dir: TempDir,
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
async fn bug_705d624_real_http_429_never_reaches_the_client() {
    let success = start_controlled_upstream(ProviderMode::Success).await;
    let mut rate_a = start_controlled_upstream(ProviderMode::RateLimited).await;
    let mut rate_b = start_controlled_upstream(ProviderMode::RateLimited).await;
    let ports = H2Ports::allocate();
    let config = write_h2_config(&ports, &success, &rate_a, &rate_b, "");
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "h2_exhausted").await;

    // The provider pool is exhausted, so both client lanes observe a transport break.
    // The real upstream 429 stays in the typed Error chain: the client never receives
    // the provider status, a provider header, or a provider error body.
    assert_no_front_http_headers(ports.exhausted, false).await;
    assert_front_sse_transport_break(ports.exhausted).await;
    next_capture(&mut rate_a.captures, "429 first upstream").await;
    next_capture(&mut rate_b.captures, "429 second upstream").await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

#[tokio::test]
async fn bug_705d624_last_provider_failure_never_reaches_the_client_and_reselection_succeeds() {
    let success = start_controlled_upstream(ProviderMode::Success).await;
    let mut rate = start_controlled_upstream(ProviderMode::RateLimited).await;
    let mut no_response = start_no_response_upstream().await;
    let ports = H2Ports::allocate();
    let config = write_h2_config(&ports, &success, &rate, &no_response, "");
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "h2_exhausted").await;
    wait_for_health(&client, &mut cli, ports.reselect, "h2_reselect").await;

    // Every candidate on the exhausted lane fails: the last real 429 and the later
    // transport failure both stay in the typed Error chain, and the client boundary is a
    // transport break instead of a provider status or a provider error body.
    assert_no_front_http_headers(ports.exhausted, false).await;
    next_capture(&mut rate.captures, "429 before transport failure").await;
    next_capture(&mut no_response.captures, "transport after 429").await;

    let success_response = client
        .post(format!("http://127.0.0.1:{}/v1/responses", ports.reselect))
        .json(&json!({"model":"client-test","input":"failure then success"}))
        .send()
        .await
        .unwrap();
    assert_eq!(success_response.status(), ReqwestStatusCode::OK);
    assert_eq!(
        success_response.json::<Value>().await.unwrap(),
        json!({"id":"h2_json","output_text":"ok"})
    );
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

#[tokio::test]
async fn bug_705d624_all_provider_no_response_breaks_streaming_client_transport() {
    let success = start_controlled_upstream(ProviderMode::Success).await;
    let mut no_response_a = start_no_response_upstream().await;
    let mut no_response_b = start_no_response_upstream().await;
    let ports = H2Ports::allocate();
    let config = write_h2_config(&ports, &success, &no_response_a, &no_response_b, "");
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "h2_exhausted").await;

    assert_no_front_http_headers(ports.exhausted, false).await;
    assert_front_sse_transport_break(ports.exhausted).await;
    next_capture(&mut no_response_a.captures, "first no-response transport").await;
    next_capture(&mut no_response_b.captures, "second no-response transport").await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

#[tokio::test]
async fn bug_705d624_real_upstream_http_502_is_not_forwarded_to_client() {
    let success = start_controlled_upstream(ProviderMode::Success).await;
    let mut bad_gateway_a = start_controlled_upstream(ProviderMode::UpstreamBadGateway).await;
    let mut bad_gateway_b = start_controlled_upstream(ProviderMode::UpstreamBadGateway).await;
    let ports = H2Ports::allocate();
    let config = write_h2_config(&ports, &success, &bad_gateway_a, &bad_gateway_b, "");
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "h2_exhausted").await;

    assert_no_front_http_headers(ports.exhausted, false).await;
    assert_front_sse_transport_break(ports.exhausted).await;
    next_capture(
        &mut bad_gateway_a.captures,
        "first actual HTTP 502 upstream",
    )
    .await;
    next_capture(
        &mut bad_gateway_b.captures,
        "second actual HTTP 502 upstream",
    )
    .await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

#[tokio::test]
async fn bug_705d624_aborted_provider_stream_never_projects_network_error_to_client() {
    let success = start_controlled_upstream(ProviderMode::Success).await;
    let mut aborted_a = start_aborted_sse_upstream().await;
    let mut aborted_b = start_aborted_sse_upstream().await;
    let ports = H2Ports::allocate();
    let config = write_h2_config(&ports, &success, &aborted_a, &aborted_b, "");
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "h2_exhausted").await;

    // An aborted provider stream is a provider transport failure. It must stay in the
    // typed Error chain: the client must never receive HTTP 502, a `network_error`
    // code, or a `response.failed` frame.
    assert_no_front_http_headers(ports.exhausted, false).await;
    assert_front_sse_transport_break(ports.exhausted).await;
    next_capture(&mut aborted_a.captures, "first aborted provider stream").await;
    next_capture(&mut aborted_b.captures, "second aborted provider stream").await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

async fn assert_no_front_http_headers(port: u16, stream: bool) {
    assert!(
        !stream,
        "only a non-streaming client is closed without HTTP response bytes"
    );
    let response = read_front_response(port, stream).await;
    assert!(
        response.is_empty(),
        "stream={stream} expected zero HTTP response bytes, got {}",
        String::from_utf8_lossy(&response)
    );
}

/// A streaming client must observe an aborted transfer instead of a normal end of
/// stream: the response head and one SSE comment frame reach the transport, the body
/// keeps chunked framing, and the transfer never terminates with the final chunk. That
/// incomplete chunked body is the transport failure a client retries, so provider
/// exhaustion does not end the session.
async fn assert_front_sse_transport_break(port: u16) {
    let response = read_front_response(port, true).await;
    let text = String::from_utf8_lossy(&response).into_owned();
    assert!(
        text.starts_with("HTTP/1.1 200"),
        "streaming no-response must write the response head: {text:?}"
    );
    assert!(
        text.to_ascii_lowercase()
            .contains("content-type: text/event-stream"),
        "streaming no-response must keep the SSE boundary: {text:?}"
    );
    assert!(
        text.to_ascii_lowercase()
            .contains("transfer-encoding: chunked"),
        "streaming no-response must frame the break as an incomplete chunked body: {text:?}"
    );
    assert!(
        text.contains(": routecodex provider transport break"),
        "streaming no-response must flush the SSE boundary frame before breaking: {text:?}"
    );
    assert!(
        !text.ends_with("0\r\n\r\n"),
        "streaming no-response must abort the transfer instead of terminating it: {text:?}"
    );
}

async fn read_front_response(port: u16, stream: bool) -> Vec<u8> {
    let payload = serde_json::to_string(
        &json!({"model":"client-test","input":"upstream no response","stream":stream}),
    )
    .unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    // Keep the HTTP/1.1 default persistent connection so the response framing, not the
    // connection close, carries the transfer boundary: a close-delimited EOF would
    // otherwise be indistinguishable from an aborted transfer.
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        payload.len(), payload
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut received = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match timeout(Duration::from_secs(10), socket.read(&mut buffer)).await {
            Ok(Ok(0)) | Ok(Err(_)) => break,
            Ok(Ok(count)) => received.extend_from_slice(&buffer[..count]),
            Err(_) => panic!("front connection must terminate before timeout"),
        }
    }
    received
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
    let config_path = write_h2_config(&ports, &success, &failure_a, &failure_b, "");

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
    // Responses -> Responses is same-protocol Direct.  ReqInbound preserves the
    // client protocol field; Chat-canonical projection belongs to Relay/provider
    // protocol conversion and must not be invented on the Direct path.
    assert_eq!(
        json_capture.body["input"],
        json!("json baseline"),
        "same-protocol Direct must preserve the Responses input field shape"
    );
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
    assert_eq!(
        sse_response.headers()["content-type"].to_str().unwrap(),
        "text/event-stream"
    );
    let sse_body = sse_response.text().await.unwrap();
    assert!(sse_body.contains(
        "event: response.created\ndata: {\"type\":\"response.created\",\"id\":\"h2_sse\"}"
    ));
    assert!(sse_body.contains(
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}"
    ));
    // The terminal event carries the materialized usage counters, and JSON key
    // order is not part of the protocol, so compare the decoded payload instead
    // of a byte-exact line. output_tokens must be present: a client that cannot
    // parse it retries the stream instead of seeing a valid terminal response.
    let completed = sse_data_payload(&sse_body, "response.completed");
    assert_eq!(completed["type"], json!("response.completed"));
    assert_eq!(completed["response"]["id"], json!("h2_sse"));
    assert_eq!(completed["response"]["status"], json!("completed"));
    assert!(
        completed["response"]["usage"]["output_tokens"].is_u64(),
        "terminal event must materialize numeric usage: {completed}"
    );
    assert!(!sse_body.contains("data: [DONE]"), "{sse_body}");
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

    // The exhausted lane has no eligible candidate left, so the client boundary is a
    // transport break. The last real upstream 503 stays in the typed Error chain: the
    // client never receives a provider status, a provider error code, or a provider body.
    assert_no_front_http_headers(ports.exhausted, false).await;
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
    let dry_run_status = dry_run_response.status();
    let dry_run_body_text = dry_run_response.text().await.unwrap();
    assert_eq!(
        dry_run_status,
        ReqwestStatusCode::OK,
        "dry-run response body: {dry_run_body_text}"
    );
    let dry_run: Value = serde_json::from_str(&dry_run_body_text).unwrap();
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
    assert!(dry_run_serialized.contains("dry-run-request-secret"));
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
    let live_snapshots = snapshots["snapshots"].as_array().unwrap();
    assert!(
        !live_snapshots.is_empty(),
        "snapshots=true must retain live snapshots for the controlled replay harness"
    );
    assert!(serde_json::to_string(&snapshots)
        .unwrap()
        .contains("\"live\":true"));

    let request_ids = collect_request_ids(&logs);
    let evidence_path = write_evidence_artifact(json!({
        "feature_id": "v3.responses_direct_h2_equivalence_harness",
        "command": "npm run test:v3-h2-p6-controlled-replay",
        "expected_exit_code": 0,
        "scenarios": H2_SCENARIOS,
        "config": config_path.path.display().to_string(),
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
                "client_transport_break": "zero HTTP response bytes; no provider status, code, or body"
            },
            "dry_run": dry_run
        },
        "observations": {
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

#[tokio::test]
async fn responses_relay_sse_preserves_json_looking_apply_patch_input() {
    // This is freeform text, even though it parses as JSON and names a field
    // used by the legacy apply_patch wrapper.
    let input = r#"{ "patch": "keep \u4e2d exactly", "input": "literal" }"#.to_string();
    let mut success = start_controlled_upstream(ProviderMode::CustomToolCall {
        input: input.clone(),
    })
    .await;
    let failure_a = start_controlled_upstream(ProviderMode::Failure { label: "failure-a" }).await;
    let failure_b = start_controlled_upstream(ProviderMode::Failure { label: "failure-b" }).await;
    let ports = H2Ports::allocate();
    let config_path = write_h2_config(
        &ports,
        &success,
        &failure_a,
        &failure_b,
        "responses = { process = \"chat\", streaming = \"client\" }",
    );
    let client = reqwest::Client::new();
    let tools = json!([{"type":"custom","name":"apply_patch","format":{"type":"text"}}]);
    let mut cli = start_cli_server(&config_path, ports.all());
    wait_for_health(&client, &mut cli, ports.success, "h2_success").await;

    let response = client
        .post(format!("http://127.0.0.1:{}/v1/responses", ports.success))
        .json(&json!({"model":"client-test", "input":"make a patch", "tools":tools, "stream":true}))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    assert_eq!(status, ReqwestStatusCode::OK, "{body}");
    let added = sse_data_payload(&body, "response.output_item.added");
    assert_eq!(
        added["item"]["input"].as_str(),
        Some(input.as_str()),
        "{body}"
    );
    let completed = sse_data_payload(&body, "response.completed");
    let item = &completed["response"]["output"][0];
    assert_eq!(item["type"], "custom_tool_call", "{body}");
    assert_eq!(item["name"], "apply_patch", "{body}");
    assert_eq!(item["call_id"], "call_patch", "{body}");
    assert_eq!(item["input"].as_str(), Some(input.as_str()), "{body}");
    let capture = next_capture(&mut success.captures, "apply_patch SSE").await;
    assert_eq!(capture.body["stream"], true);
    assert!(
        capture.body["tools"]
            .as_array()
            .is_some_and(|items| items.iter().any(|entry| { entry["name"] == "apply_patch" })),
        "provider tool declaration changed: {:?}",
        capture.body
    );

    for output in [
        "patch rejected: context mismatch in /tmp/含 空格.txt\r\nold",
        "Success. Updated /tmp/含 空格.txt\r\n",
    ] {
        let followup = client
            .post(format!("http://127.0.0.1:{}/v1/responses", ports.success))
            .json(&json!({
                "model":"client-test", "stream":false, "tools":tools,
                "input":[
                    {"role":"user","content":"make a patch"},
                    item,
                    {"type":"custom_tool_call_output","call_id":"call_patch","output":output}
                ]
            }))
            .send()
            .await
            .unwrap();
        let status = followup.status();
        let body = followup.text().await.unwrap();
        assert_eq!(status, ReqwestStatusCode::OK, "{body}");
        let followup_capture = next_capture(&mut success.captures, "apply_patch followup").await;
        assert!(
            followup_capture.body["input"]
                .as_array()
                .is_some_and(|items| items.iter().any(|entry| {
                    entry["call_id"] == "call_patch" && entry["output"] == output
                })),
            "provider-bound output changed: {:?}",
            followup_capture.body
        );
        assert!(
            followup_capture.body["input"]
                .as_array()
                .is_some_and(|items| items.iter().any(|entry| {
                    entry["type"] == "custom_tool_call"
                        && entry["name"] == "apply_patch"
                        && entry["call_id"] == "call_patch"
                        && entry["input"] == input
                })),
            "provider-bound call changed: {:?}",
            followup_capture.body
        );
    }

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
        ProviderMode::CustomToolCall { input } => {
            if parsed["input"].as_array().is_some_and(|items| items.iter().any(|entry| {
                entry["type"] == "custom_tool_call_output" && entry["call_id"] == "call_patch"
            })) {
                return Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"id":"resp_patch_followup","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}"#))
                    .unwrap();
            }
            let item = json!({
                "type": "custom_tool_call", "id": "item_patch", "call_id": "call_patch",
                "name": "apply_patch", "input": input
            });
            let added = json!({"type":"response.output_item.added", "output_index":0, "item":item});
            let completed = json!({
                "type":"response.completed",
                "response":{"id":"resp_patch", "status":"completed", "output":[item]}
            });
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(format!(
                    "event: response.output_item.added\ndata: {added}\n\nevent: response.completed\ndata: {completed}\n\ndata: [DONE]\n\n"
                )))
                .unwrap()
        }
        ProviderMode::Success if parsed.get("stream").and_then(Value::as_bool) == Some(true) => {
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(
                    "event: response.created\ndata: {\"type\":\"response.created\",\"id\":\"h2_sse\"}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"h2_sse\",\"status\":\"completed\"}}\n\ndata: [DONE]\n\n",
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
        ProviderMode::RateLimited => Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"type":"rate_limit_error","code":"rate_limit_error","message":"controlled rate limit"}}"#,
            ))
            .unwrap(),
        ProviderMode::UpstreamBadGateway => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"type":"upstream_gateway_error","message":"controlled upstream 502"}}"#,
            ))
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

async fn start_no_response_upstream() -> ControlledUpstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    let (socket, _) = accepted.unwrap();
                    captures_tx.send(ProviderCapture {
                        authorization: None,
                        accept: None,
                        body: json!({"transport_connected": true}),
                    }).unwrap();
                    drop(socket);
                }
            }
        }
    });
    ControlledUpstream {
        base_url: format!("http://{address}/v1"),
        captures: captures_rx,
        shutdown: Some(shutdown_tx),
    }
}

/// A provider that commits an SSE response head and one frame, then aborts the body.
/// The runtime reads an incomplete provider stream, which is a provider transport
/// failure and must stay provider-private.
async fn start_aborted_sse_upstream() -> ControlledUpstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    let (mut socket, _) = accepted.unwrap();
                    captures_tx.send(ProviderCapture {
                        authorization: None,
                        accept: None,
                        body: json!({"transport_connected": true}),
                    }).unwrap();
                    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
                    let frame = "event: response.created\ndata: {\"type\":\"response.created\",\"id\":\"h2_aborted\"}\n\n";
                    let chunk = format!("{:x}\r\n{}\r\n", frame.len(), frame);
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(chunk.as_bytes()).await;
                    // Abort the body: no terminating chunk and no `[DONE]`.
                    drop(socket);
                }
            }
        }
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

/// Return the decoded `data:` payload for the named SSE event.
fn sse_data_payload(body: &str, event: &str) -> Value {
    let header = format!("event: {event}\n");
    let start = body
        .find(&header)
        .unwrap_or_else(|| panic!("missing SSE event {event} in {body}"));
    let rest = &body[start + header.len()..];
    let data = rest
        .strip_prefix("data: ")
        .unwrap_or_else(|| panic!("event {event} has no data line in {body}"));
    let line = data
        .split('\n')
        .next()
        .expect("data line is terminated by a newline");
    serde_json::from_str(line)
        .unwrap_or_else(|error| panic!("event {event} data is not JSON: {error}; {line}"))
}

fn write_h2_config(
    ports: &H2Ports,
    success: &ControlledUpstream,
    failure_a: &ControlledUpstream,
    failure_b: &ControlledUpstream,
    success_responses_config: &str,
) -> H2Config {
    let config_dir = tempfile::Builder::new()
        .prefix("routecodex-v3-h2-")
        .tempdir()
        .unwrap();
    let path = config_dir.path().join("config.h2.toml");
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
{success_responses_config}
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
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000, probe_interval_ms = 1800000 }}

[providers.failure_a.models.test]
wire_name = "wire-failure-a"
supports_streaming = true

[providers.failure_a_reselect]
type = "responses"
base_url = "{failure_a_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "failure-a", env = "ROUTECODEX_V3_H2_FAILURE_A_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000, probe_interval_ms = 1800000 }}

[providers.failure_a_reselect.models.test]
wire_name = "wire-failure-a"
supports_streaming = true

[providers.failure_b]
type = "responses"
base_url = "{failure_b_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "failure-b", env = "ROUTECODEX_V3_H2_FAILURE_B_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000, probe_interval_ms = 1800000 }}

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
  {{ kind = "provider_model", provider = "failure_a_reselect", model = "test", key = "failure-a", priority = 2 }},
  {{ kind = "provider_model", provider = "success", model = "test", key = "success", priority = 1 }}
]

[forwarders.h2_exhausted]
model = "test"
aliases = ["client-test"]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "failure_a", model = "test", key = "failure-a", priority = 2 }},
  {{ kind = "provider_model", provider = "failure_b", model = "test", key = "failure-b", priority = 1 }}
]

[route_groups.h2_success.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "h2_success", priority = 1 }}]

[route_groups.h2_success.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-test"] }}
targets = [{{ kind = "forwarder", id = "h2_success", priority = 1 }}]

[route_groups.h2_reselect.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "h2_reselect", priority = 1 }}]

[route_groups.h2_reselect.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-test"] }}
targets = [{{ kind = "forwarder", id = "h2_reselect", priority = 1 }}]

[route_groups.h2_exhausted.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "h2_exhausted", priority = 1 }}]

[route_groups.h2_exhausted.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-test"] }}
targets = [{{ kind = "forwarder", id = "h2_exhausted", priority = 1 }}]
"#,
            success_port = ports.success,
            reselect_port = ports.reselect,
            exhausted_port = ports.exhausted,
            success_base = success.base_url,
            success_responses_config = success_responses_config,
            failure_a_base = failure_a.base_url,
            failure_b_base = failure_b.base_url,
            hub_v1_declaration = hub_v1_test_declaration(),
            success_execution = hub_v1_server_execution("h2_success"),
            reselect_execution = hub_v1_server_execution("h2_reselect"),
            exhausted_execution = hub_v1_server_execution("h2_exhausted"),
        ),
    )
    .unwrap();
    H2Config {
        path,
        _config_dir: config_dir,
    }
}

fn start_cli_server(config_path: &H2Config, _ports: Vec<u16>) -> CliProcess {
    let runtime_dir = tempfile::Builder::new()
        .prefix("h2-")
        .tempdir_in("/tmp")
        .expect("H2 lifecycle temp directory must be available");
    let temp_dir = runtime_dir.path();
    let state_root = temp_dir.join("state");
    let mut child = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args(["server", "start", "--foreground", "--config"])
        .arg(&config_path.path)
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .env("ROUTECODEX_V3_H2_SUCCESS_KEY", "h2-success-secret")
        .env("ROUTECODEX_V3_H2_FAILURE_A_KEY", "h2-failure-a-secret")
        .env("ROUTECODEX_V3_H2_FAILURE_B_KEY", "h2-failure-b-secret")
        .env("TMPDIR", &temp_dir)
        .env("TMP", &temp_dir)
        .env("TEMP", &temp_dir)
        .env("ROUTECODEX_V3_STATE_DIR", &state_root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    eprintln!(
        "H2 CLI pid={} binary={} config={}",
        child.id(),
        env!("CARGO_BIN_EXE_rccv3"),
        config_path.path.display()
    );
    assert!(
        matches!(child.try_wait(), Ok(None)),
        "rccv3 CLI server exited during startup"
    );
    CliProcess {
        child,
        _runtime_dir: runtime_dir,
    }
}

async fn wait_for_health(
    client: &reqwest::Client,
    cli: &mut CliProcess,
    port: u16,
    server_id: &str,
) {
    // A fixed iteration count made this a wall-clock budget under 8s, which a
    // loaded machine exceeds: startup has been measured at 10.46s while the
    // server is healthy throughout. Wait on a deadline instead so slow hosts
    // are not reported as broken servers.
    let mut last_observation;
    let deadline = Instant::now() + HEALTH_READY_TIMEOUT;
    loop {
        if let Some(status) = cli.child.try_wait().unwrap() {
            panic!("rccv3 CLI exited before health on {port}: {status}");
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
        if Instant::now() >= deadline {
            panic!(
                "rccv3 CLI health did not become ready on {port} within {:?}; pid={}; last={last_observation}",
                HEALTH_READY_TIMEOUT,
                cli.child.id()
            );
        }
        sleep(Duration::from_millis(100)).await;
    }
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
            "rccv3 CLI port {port} should close after scoped child termination"
        );
    }
}
