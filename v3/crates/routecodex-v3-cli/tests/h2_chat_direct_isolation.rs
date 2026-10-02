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

/// The OpenAI Chat Direct entry must give clients the same provider/client
/// isolation as the Responses Direct entry: provider errors never become a
/// client payload, and a no-response pool breaks the client transport instead
/// of answering with a fabricated status.
#[derive(Debug, Clone, Copy)]
struct ChatPorts {
    success: u16,
    reselect: u16,
    exhausted: u16,
}

impl ChatPorts {
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

#[derive(Debug, Clone)]
struct ProviderCapture {
    authorization: Option<String>,
    body: Value,
}

#[derive(Debug, Clone)]
enum ProviderMode {
    Success,
    /// HTTP 200 that opens a provider stream, emits one partial delta, and then
    /// ends without any terminal frame and without `[DONE]`. The provider
    /// attempt never reached a terminal state, so it is a failed attempt and
    /// must not be projected to the client.
    NonTerminalAttempt,
    RateLimited,
    UpstreamBadGateway,
    UpstreamServiceUnavailable,
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

struct ChatConfig {
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
async fn chat_direct_success_baseline_json_and_sse() {
    let mut success = start_controlled_upstream(ProviderMode::Success).await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config(&ports, &success, None, None);
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.success, "chat_success").await;

    let json_response = client
        .post(format!(
            "http://127.0.0.1:{}/v1/chat/completions",
            ports.success
        ))
        .json(
            &json!({"model":"client-test","messages":[{"role":"user","content":"json baseline"}]}),
        )
        .send()
        .await
        .unwrap();
    let json_status = json_response.status();
    let json_body_text = json_response.text().await.unwrap();
    assert_eq!(
        json_status,
        ReqwestStatusCode::OK,
        "chat json baseline body: {json_body_text}"
    );
    let json_body: Value = serde_json::from_str(&json_body_text).unwrap();
    assert_eq!(json_body["id"], "chat_json");
    assert_eq!(json_body["object"], "chat.completion");
    assert_eq!(
        json_body["choices"][0]["message"]["content"], "ok",
        "chat json baseline must pass the provider payload through"
    );
    assert_eq!(json_body["choices"][0]["finish_reason"], "stop");

    let capture = next_capture(&mut success.captures, "chat json success").await;
    assert_eq!(capture.body["model"], "wire-success");
    assert!(capture.body["messages"].is_array());

    let sse_response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", ports.success))
        .json(&json!({"model":"client-test","messages":[{"role":"user","content":"sse baseline"}],"stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(sse_response.status(), ReqwestStatusCode::OK);
    let sse_body = sse_response.text().await.unwrap();
    assert!(
        sse_body.contains("\"id\":\"chat_sse\""),
        "chat sse body must pass provider chunks through: {sse_body}"
    );
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

/// Parity with the Responses entry (`bug_705d624_real_http_429_retains_status_and_error_in_json_and_sse`):
/// a real upstream HTTP response is an external failure and keeps its real
/// status; only transport-level absence of a provider response breaks the
/// client transport. The chat entry must not rewrite this into an internal
/// `network_error` frame.
#[tokio::test]
async fn chat_direct_real_upstream_http_429_retains_status_and_error() {
    let success = start_controlled_upstream(ProviderMode::Success).await;
    let mut rate_a = start_controlled_upstream(ProviderMode::RateLimited).await;
    let mut rate_b = start_controlled_upstream(ProviderMode::RateLimited).await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config(&ports, &success, Some(&rate_a), Some(&rate_b));
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "chat_exhausted").await;

    for stream in [false, true] {
        let response = client
            .post(format!("http://127.0.0.1:{}/v1/chat/completions", ports.exhausted))
            .json(&json!({"model":"client-test","messages":[{"role":"user","content":"429 parity"}],"stream":stream}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            ReqwestStatusCode::TOO_MANY_REQUESTS,
            "stream={stream} a real upstream status must reach the client unchanged"
        );
        let body = response.text().await.unwrap();
        assert!(
            body.contains("rate_limit_error"),
            "stream={stream} the real external error must be preserved: {body}"
        );
        assert!(
            !body.contains("network_error"),
            "stream={stream} a real external failure must not be rewritten: {body}"
        );
    }
    next_capture(&mut rate_a.captures, "429 first upstream").await;
    next_capture(&mut rate_b.captures, "429 second upstream").await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

/// Parity with the Responses entry (`h2_p6_controlled_replay.rs`, "last real
/// upstream HTTP 503 response must retain its external error meaning"): when the
/// pool is exhausted and the last provider attempt was a real external 503, the
/// chat client must still receive that external status and error, not a
/// fabricated internal failure.
#[tokio::test]
async fn chat_direct_real_upstream_http_503_retains_status_and_error() {
    let success = start_controlled_upstream(ProviderMode::Success).await;
    let mut unavailable_a =
        start_controlled_upstream(ProviderMode::UpstreamServiceUnavailable).await;
    let mut unavailable_b =
        start_controlled_upstream(ProviderMode::UpstreamServiceUnavailable).await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config(&ports, &success, Some(&unavailable_a), Some(&unavailable_b));
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "chat_exhausted").await;

    for stream in [false, true] {
        let response = client
            .post(format!("http://127.0.0.1:{}/v1/chat/completions", ports.exhausted))
            .json(&json!({"model":"client-test","messages":[{"role":"user","content":"503 parity"}],"stream":stream}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            ReqwestStatusCode::SERVICE_UNAVAILABLE,
            "stream={stream} a terminal real upstream 503 must reach the client unchanged"
        );
        let body = response.text().await.unwrap();
        assert!(
            body.contains("upstream_unavailable"),
            "stream={stream} the real external error must be preserved: {body}"
        );
        assert!(
            !body.contains("network_error"),
            "stream={stream} a real external failure must not be rewritten: {body}"
        );
    }
    next_capture(&mut unavailable_a.captures, "503 first upstream").await;
    next_capture(&mut unavailable_b.captures, "503 second upstream").await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

#[tokio::test]
async fn chat_direct_pool_exhaustion_no_response_breaks_client_transport() {
    let success = start_controlled_upstream(ProviderMode::Success).await;
    let mut dead_a = start_no_response_upstream().await;
    let mut dead_b = start_no_response_upstream().await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config(&ports, &success, Some(&dead_a), Some(&dead_b));
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "chat_exhausted").await;

    assert_chat_no_front_http_headers(ports.exhausted).await;
    assert_chat_front_sse_transport_break(ports.exhausted).await;
    next_capture(&mut dead_a.captures, "first no-response transport").await;
    next_capture(&mut dead_b.captures, "second no-response transport").await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

#[tokio::test]
async fn chat_direct_upstream_http_502_is_not_forwarded_to_client() {
    let success = start_controlled_upstream(ProviderMode::Success).await;
    let mut bad_gateway_a = start_controlled_upstream(ProviderMode::UpstreamBadGateway).await;
    let mut bad_gateway_b = start_controlled_upstream(ProviderMode::UpstreamBadGateway).await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config(&ports, &success, Some(&bad_gateway_a), Some(&bad_gateway_b));
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "chat_exhausted").await;

    assert_chat_no_front_http_headers(ports.exhausted).await;
    assert_chat_front_sse_transport_break(ports.exhausted).await;
    next_capture(&mut bad_gateway_a.captures, "first upstream 502").await;
    next_capture(&mut bad_gateway_b.captures, "second upstream 502").await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

#[tokio::test]
async fn chat_direct_real_upstream_error_survives_as_transport_isolation_then_reselect_succeeds() {
    let mut success = start_controlled_upstream(ProviderMode::Success).await;
    let mut unavailable = start_controlled_upstream(ProviderMode::UpstreamServiceUnavailable).await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config(&ports, &success, Some(&unavailable), None);
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.reselect, "chat_reselect").await;

    let response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", ports.reselect))
        .json(&json!({"model":"client-test","messages":[{"role":"user","content":"failure then success"}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), ReqwestStatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["id"], "chat_json");
    assert_eq!(
        body["choices"][0]["message"]["content"], "ok",
        "recovery must serve the healthy provider payload: {body}"
    );
    let first = next_capture(&mut unavailable.captures, "reselect first failure").await;
    assert_eq!(first.body["model"], "wire-unavailable");
    let recovered = next_capture(&mut success.captures, "reselect success").await;
    assert_eq!(recovered.body["model"], "wire-success");
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

/// Parity with `bug_705d624_last_real_429_survives_later_transport_failure_and_reselection_succeeds`.
///
/// A provider first answers with a real 429 and a later candidate drops the
/// connection: the terminal projection must keep the last real external status
/// (429 + `rate_limit_error`) instead of collapsing to an internal
/// `network_error` frame, and a following request on the same session scope must
/// resume from the healthy candidate.
#[tokio::test]
async fn chat_direct_last_real_429_survives_later_transport_failure_and_reselect_succeeds() {
    let mut success = start_controlled_upstream(ProviderMode::Success).await;
    let mut rate = start_controlled_upstream(ProviderMode::RateLimited).await;
    let mut no_response = start_no_response_upstream().await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config(&ports, &success, Some(&rate), Some(&no_response));
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "chat_exhausted").await;
    wait_for_health(&client, &mut cli, ports.reselect, "chat_reselect").await;

    let failure_response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", ports.exhausted))
        .json(&json!({"model":"client-test","messages":[{"role":"user","content":"429 then no response"}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        failure_response.status(),
        ReqwestStatusCode::TOO_MANY_REQUESTS,
        "the last real upstream status must survive a later transport failure"
    );
    let body = failure_response.text().await.unwrap();
    assert!(
        body.contains("rate_limit_error"),
        "the real external error must be preserved: {body}"
    );
    assert!(
        !body.contains("network_error"),
        "an internal transport failure must not rewrite a real external 429: {body}"
    );
    next_capture(&mut rate.captures, "429 before transport failure").await;
    next_capture(&mut no_response.captures, "transport after 429").await;

    let success_response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", ports.reselect))
        .json(&json!({"model":"client-test","messages":[{"role":"user","content":"failure then success"}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        success_response.status(),
        ReqwestStatusCode::OK,
        "the session must recover from the healthy candidate"
    );
    let body: Value = success_response.json().await.unwrap();
    assert_eq!(body["id"], "chat_json");
    assert_eq!(body["choices"][0]["message"]["content"], "ok");
    let recovered = next_capture(&mut success.captures, "reselect success").await;
    assert_eq!(recovered.body["model"], "wire-success");
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
            body: parsed.clone(),
        })
        .unwrap();
    match &state.mode {
        ProviderMode::Success => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"id":"resp_json","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}"#,
            ))
            .unwrap(),
        ProviderMode::NonTerminalAttempt
            if parsed.get("stream").and_then(Value::as_bool) == Some(true) =>
        {
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
                ))
                .unwrap()
        }
        ProviderMode::NonTerminalAttempt => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(r#"{"id":"resp_partial","object":"response","output":["#))
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
        ProviderMode::UpstreamServiceUnavailable => Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"type":"upstream_unavailable","message":"controlled upstream 503"}}"#,
            ))
            .unwrap(),
    }
}

async fn start_controlled_responses_upstream(mode: ProviderMode) -> ControlledUpstream {
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

/// Cross-protocol parity: the live chat tiers lead with `responses`-type
/// providers, so the chat entry crosses into Hub Relay. The pool-empty terminal
/// must still break the client transport instead of answering with an error.
#[tokio::test]
async fn chat_relay_cross_protocol_pool_exhaustion_no_response_breaks_client_transport() {
    let success = start_controlled_responses_upstream(ProviderMode::Success).await;
    let mut dead_a = start_no_response_upstream().await;
    let mut dead_b = start_no_response_upstream().await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config_for_provider_type(
        &ports,
        "responses",
        &success,
        Some(&dead_a),
        Some(&dead_b),
    );
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "chat_exhausted").await;

    assert_chat_no_front_http_headers(ports.exhausted).await;
    assert_chat_front_sse_transport_break(ports.exhausted).await;
    next_capture(&mut dead_a.captures, "relay first no-response transport").await;
    next_capture(&mut dead_b.captures, "relay second no-response transport").await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

/// A real upstream 5xx on the cross-protocol lane is a provider failure that
/// must not become a client payload; the client transport breaks instead.
#[tokio::test]
async fn chat_relay_cross_protocol_upstream_http_502_is_not_forwarded_to_client() {
    let success = start_controlled_responses_upstream(ProviderMode::Success).await;
    let mut bad_gateway_a =
        start_controlled_responses_upstream(ProviderMode::UpstreamBadGateway).await;
    let mut bad_gateway_b =
        start_controlled_responses_upstream(ProviderMode::UpstreamBadGateway).await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config_for_provider_type(
        &ports,
        "responses",
        &success,
        Some(&bad_gateway_a),
        Some(&bad_gateway_b),
    );
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "chat_exhausted").await;

    assert_chat_no_front_http_headers(ports.exhausted).await;
    assert_chat_front_sse_transport_break(ports.exhausted).await;
    next_capture(&mut bad_gateway_a.captures, "relay first upstream 502").await;
    next_capture(&mut bad_gateway_b.captures, "relay second upstream 502").await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

/// Cross-protocol reselection: the first `responses`-type provider answers 503,
/// the chat entry must rotate to the healthy candidate and serve the response.
#[tokio::test]
async fn chat_relay_cross_protocol_error_then_reselect_succeeds() {
    let mut success = start_controlled_responses_upstream(ProviderMode::Success).await;
    let mut unavailable =
        start_controlled_responses_upstream(ProviderMode::UpstreamServiceUnavailable).await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config_for_provider_type(
        &ports,
        "responses",
        &success,
        Some(&unavailable),
        None,
    );
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.reselect, "chat_reselect").await;

    let response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", ports.reselect))
        .json(&json!({"model":"client-test","messages":[{"role":"user","content":"failure then success"}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), ReqwestStatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(
        body["choices"][0]["message"]["content"], "ok",
        "cross-protocol recovery must serve the healthy provider: {body}"
    );
    let first = next_capture(&mut unavailable.captures, "relay first failure").await;
    assert_eq!(first.body["model"], "wire-unavailable");
    let recovered = next_capture(&mut success.captures, "relay success").await;
    assert_eq!(recovered.body["model"], "wire-success");
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

/// The same terminal external 503 preservation on the cross-protocol lane: an
/// exhausted pool of `responses`-type providers must project the last real
/// external status and error to the chat client.
#[tokio::test]
async fn chat_relay_cross_protocol_real_upstream_http_503_retains_status_and_error() {
    let success = start_controlled_responses_upstream(ProviderMode::Success).await;
    let mut unavailable_a =
        start_controlled_responses_upstream(ProviderMode::UpstreamServiceUnavailable).await;
    let mut unavailable_b =
        start_controlled_responses_upstream(ProviderMode::UpstreamServiceUnavailable).await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config_for_provider_type(
        &ports,
        "responses",
        &success,
        Some(&unavailable_a),
        Some(&unavailable_b),
    );
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "chat_exhausted").await;

    for stream in [false, true] {
        let response = client
            .post(format!("http://127.0.0.1:{}/v1/chat/completions", ports.exhausted))
            .json(&json!({"model":"client-test","messages":[{"role":"user","content":"relay 503 parity"}],"stream":stream}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            ReqwestStatusCode::SERVICE_UNAVAILABLE,
            "stream={stream} a terminal real upstream 503 must reach the chat client unchanged"
        );
        let body = response.text().await.unwrap();
        assert!(
            body.contains("upstream_unavailable"),
            "stream={stream} the real external error must be preserved: {body}"
        );
        assert!(
            !body.contains("network_error"),
            "stream={stream} a real external failure must not be rewritten: {body}"
        );
    }
    next_capture(&mut unavailable_a.captures, "relay 503 first upstream").await;
    next_capture(&mut unavailable_b.captures, "relay 503 second upstream").await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

/// A provider that answers HTTP 200 but never reaches a terminal state is a
/// failed provider attempt, not client output. The Responses lane was explicitly
/// narrowed to this contract (`9eea26f3`, "stop projecting provider failure to
/// client after exhaustion"); the chat entry must isolate the same boundary
/// instead of forwarding the non-terminal provider payload.
#[tokio::test]
async fn chat_direct_incomplete_provider_terminal_breaks_client_transport() {
    let mut success = start_controlled_upstream(ProviderMode::Success).await;
    let mut incomplete_a = start_controlled_upstream(ProviderMode::NonTerminalAttempt).await;
    let mut incomplete_b = start_controlled_upstream(ProviderMode::NonTerminalAttempt).await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config(&ports, &success, Some(&incomplete_a), Some(&incomplete_b));
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "chat_exhausted").await;

    assert_chat_no_front_http_headers(ports.exhausted).await;
    assert_chat_front_sse_transport_break(ports.exhausted).await;
    next_capture(
        &mut incomplete_a.captures,
        "first incomplete provider terminal",
    )
    .await;
    next_capture(
        &mut incomplete_b.captures,
        "second incomplete provider terminal",
    )
    .await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

/// The same boundary on the cross-protocol lane: the chat entry relays to a
/// `responses`-type provider whose stream never reaches a terminal frame. The
/// client transport must break rather than receive the provider-derived frame.
#[tokio::test]
async fn chat_relay_cross_protocol_incomplete_provider_terminal_breaks_client_transport() {
    let mut success = start_controlled_responses_upstream(ProviderMode::Success).await;
    let mut incomplete_a =
        start_controlled_responses_upstream(ProviderMode::NonTerminalAttempt).await;
    let mut incomplete_b =
        start_controlled_responses_upstream(ProviderMode::NonTerminalAttempt).await;
    let ports = ChatPorts::allocate();
    let config = write_chat_config_for_provider_type(
        &ports,
        "responses",
        &success,
        Some(&incomplete_a),
        Some(&incomplete_b),
    );
    let client = reqwest::Client::new();
    let mut cli = start_cli_server(&config, ports.all());
    wait_for_health(&client, &mut cli, ports.exhausted, "chat_exhausted").await;

    assert_chat_no_front_http_headers(ports.exhausted).await;
    assert_chat_front_sse_transport_break(ports.exhausted).await;
    next_capture(
        &mut incomplete_a.captures,
        "relay first incomplete terminal",
    )
    .await;
    next_capture(
        &mut incomplete_b.captures,
        "relay second incomplete terminal",
    )
    .await;
    drop(cli);
    wait_ports_closed(&client, &ports.all()).await;
}

async fn assert_chat_no_front_http_headers(port: u16) {
    let response = read_chat_front_response(port, false).await;
    assert!(
        response.is_empty(),
        "a non-streaming client must observe zero HTTP response bytes on pool exhaustion, got {}",
        String::from_utf8_lossy(&response)
    );
}

/// A streaming client must observe an aborted transfer instead of a normal end
/// of stream or an error payload: the response head and one SSE comment frame
/// reach the transport and the chunked body never terminates.
async fn assert_chat_front_sse_transport_break(port: u16) {
    let response = read_chat_front_response(port, true).await;
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
    assert!(
        !text.contains("response.failed") && !text.contains("\"error\""),
        "streaming no-response must not carry a client error payload: {text:?}"
    );
}

async fn read_chat_front_response(port: u16, stream: bool) -> Vec<u8> {
    let payload = serde_json::to_string(&json!({
        "model":"client-test",
        "messages":[{"role":"user","content":"upstream no response"}],
        "stream":stream,
    }))
    .unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    // Keep the HTTP/1.1 default persistent connection so the response framing,
    // not the connection close, carries the transfer boundary.
    let request = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        payload.len(), payload
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut received = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match timeout(Duration::from_secs(60), socket.read(&mut buffer)).await {
            Ok(Ok(0)) | Ok(Err(_)) => break,
            Ok(Ok(count)) => received.extend_from_slice(&buffer[..count]),
            Err(_) => panic!(
                "front connection must terminate before timeout; received {} bytes: {:?}",
                received.len(),
                String::from_utf8_lossy(&received)
            ),
        }
    }
    received
}

async fn controlled_chat_upstream(
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
            body: parsed.clone(),
        })
        .unwrap();
    match &state.mode {
        ProviderMode::Success if parsed.get("stream").and_then(Value::as_bool) == Some(true) => {
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(
                    concat!(
                        "data: {\"id\":\"chat_sse\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"wire-success\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\n",
                        "data: {\"id\":\"chat_sse\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"wire-success\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                        "data: [DONE]\n\n",
                    ),
                ))
                .unwrap()
        }
        ProviderMode::Success => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"id":"chat_json","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}"#,
            ))
            .unwrap(),
        ProviderMode::NonTerminalAttempt
            if parsed.get("stream").and_then(Value::as_bool) == Some(true) =>
        {
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(
                    "data: {\"id\":\"chat_partial\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"wire-partial\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n",
                ))
                .unwrap()
        }
        ProviderMode::NonTerminalAttempt => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(r#"{"id":"chat_partial","object":"chat.completion","choices":["#))
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
        ProviderMode::UpstreamServiceUnavailable => Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"type":"upstream_unavailable","message":"controlled upstream 503"}}"#,
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
        .route("/v1/chat/completions", post(controlled_chat_upstream))
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

/// Accepts the connection and drops it without any response bytes: the request
/// never reaches a provider response stage, exercising the no-response lane.
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
                    captures_tx
                        .send(ProviderCapture {
                            authorization: None,
                            body: json!({"transport_connected": true}),
                        })
                        .unwrap();
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

fn write_chat_config(
    ports: &ChatPorts,
    success: &ControlledUpstream,
    failure_a: Option<&ControlledUpstream>,
    failure_b: Option<&ControlledUpstream>,
) -> ChatConfig {
    write_chat_config_for_provider_type(ports, "openai_chat", success, failure_a, failure_b)
}

/// Writes the chat-entry server config for the given provider wire type. A
/// `openai_chat` provider keeps the request on the same-protocol Direct lane; a
/// `responses` provider makes the chat entry cross into Hub Relay, which is the
/// lane the live chat tiers exercise through their `responses`-type providers.
fn write_chat_config_for_provider_type(
    ports: &ChatPorts,
    provider_type: &str,
    success: &ControlledUpstream,
    failure_a: Option<&ControlledUpstream>,
    failure_b: Option<&ControlledUpstream>,
) -> ChatConfig {
    // Console logging stays off by default so a green run is quiet; set
    // ROUTECODEX_CHAT_TEST_LOG_CONSOLE=1 to capture the runtime error chain.
    let log_console = std::env::var_os("ROUTECODEX_CHAT_TEST_LOG_CONSOLE").is_some();
    let config_dir = tempfile::Builder::new()
        .prefix("routecodex-v3-chat-")
        .tempdir()
        .unwrap();
    let path = config_dir.path().join("config.chat.toml");
    let failure_a_block = match failure_a {
        Some(upstream) => format!(
            r#"
[providers.failure_a]
type = "{provider_type}"
base_url = "{failure_a_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "failure-a", env = "ROUTECODEX_V3_CHAT_FAILURE_A_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000, probe_interval_ms = 1800000 }}

[providers.failure_a.models.test]
wire_name = "wire-unavailable"
supports_streaming = true
"#,
            failure_a_base = upstream.base_url,
        ),
        None => String::new(),
    };
    let failure_b_block = match failure_b {
        Some(upstream) => format!(
            r#"
[providers.failure_b]
type = "{provider_type}"
base_url = "{failure_b_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "failure-b", env = "ROUTECODEX_V3_CHAT_FAILURE_B_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000, probe_interval_ms = 1800000 }}

[providers.failure_b.models.test]
wire_name = "wire-unavailable-b"
supports_streaming = true
"#,
            failure_b_base = upstream.base_url,
        ),
        None => String::new(),
    };
    let success_target = r#"{ kind = "provider_model", provider = "success", model = "test", key = "success", priority = 1 }"#;
    let failure_a_target = r#"{ kind = "provider_model", provider = "failure_a", model = "test", key = "failure-a", priority = 1 }"#;
    let failure_b_target = r#"{ kind = "provider_model", provider = "failure_b", model = "test", key = "failure-b", priority = 1 }"#;
    // Reselect walks the cooled provider first and must recover on the healthy one.
    let reselect_forwarder_targets = match failure_a {
        Some(_) => format!("{failure_a_target},\n  {success_target}"),
        None => success_target.to_string(),
    };
    // The exhausted forwarder never includes the healthy provider: it must reach
    // the terminal pool state. The baseline-only case keeps one target because a
    // forwarder without targets is rejected at config load.
    let exhausted_forwarder_targets = match (failure_a, failure_b) {
        (Some(_), Some(_)) => format!("{failure_b_target},\n  {failure_a_target}"),
        (Some(_), None) => failure_a_target.to_string(),
        (None, Some(_)) => failure_b_target.to_string(),
        (None, None) => success_target.to_string(),
    };
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
log_console = {log_console}
snapshots = true
retention = {{ raw_requests = 32, raw_responses = 32, events = 512 }}

[error.policies.target_pool_exhausted]
action = "project_client_error"

[servers.chat_success]
bind = "127.0.0.1"
port = {success_port}
routing_group = "chat_success"
endpoints = ["openai_chat"]

{success_execution}

[servers.chat_reselect]
bind = "127.0.0.1"
port = {reselect_port}
routing_group = "chat_reselect"
endpoints = ["openai_chat"]

{reselect_execution}

[servers.chat_exhausted]
bind = "127.0.0.1"
port = {exhausted_port}
routing_group = "chat_exhausted"
endpoints = ["openai_chat"]

{exhausted_execution}

[providers.success]
type = "{provider_type}"
base_url = "{success_base}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "success", env = "ROUTECODEX_V3_CHAT_SUCCESS_KEY" }}] }}

[providers.success.models.test]
wire_name = "wire-success"
aliases = ["client-test"]
capabilities = ["text"]
supports_streaming = true
{failure_a_block}{failure_b_block}
[forwarders.chat_success]
model = "test"
aliases = ["client-test"]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "success", model = "test", key = "success", priority = 1 }}
]

[forwarders.chat_reselect]
model = "test"
aliases = ["client-test"]
selection = {{ strategy = "priority" }}
targets = [
  {reselect_forwarder_targets}
]

[forwarders.chat_exhausted]
model = "test"
aliases = ["client-test"]
selection = {{ strategy = "priority" }}
targets = [
  {exhausted_forwarder_targets}
]

[route_groups.chat_success.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "chat_success", priority = 1 }}]

[route_groups.chat_success.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["client-test"] }}
targets = [{{ kind = "forwarder", id = "chat_success", priority = 1 }}]

[route_groups.chat_reselect.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "chat_reselect", priority = 1 }}]

[route_groups.chat_reselect.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["client-test"] }}
targets = [{{ kind = "forwarder", id = "chat_reselect", priority = 1 }}]

[route_groups.chat_exhausted.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "chat_exhausted", priority = 1 }}]

[route_groups.chat_exhausted.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["client-test"] }}
targets = [{{ kind = "forwarder", id = "chat_exhausted", priority = 1 }}]
"#,
            success_port = ports.success,
            reselect_port = ports.reselect,
            exhausted_port = ports.exhausted,
            success_base = success.base_url,
            hub_v1_declaration = hub_v1_test_declaration(),
            success_execution = hub_v1_server_execution("chat_success"),
            reselect_execution = hub_v1_server_execution("chat_reselect"),
            exhausted_execution = hub_v1_server_execution("chat_exhausted"),
        ),
    )
    .unwrap();
    if let Ok(keep) = std::env::var("ROUTECODEX_CHAT_TEST_KEEP_CONFIG") {
        let _ = fs::copy(&path, &keep);
    }
    ChatConfig {
        path: path.clone(),
        _config_dir: config_dir,
    }
}

fn start_cli_server(config_path: &ChatConfig, _ports: Vec<u16>) -> CliProcess {
    let runtime_dir = tempfile::Builder::new()
        .prefix("chat-")
        .tempdir_in("/tmp")
        .expect("chat lifecycle temp directory must be available");
    let temp_dir = runtime_dir.path();
    let state_root = temp_dir.join("state");
    let binary = std::env::var("ROUTECODEX_CHAT_TEST_BINARY")
        .unwrap_or_else(|_| env!("CARGO_BIN_EXE_rccv3").to_string());
    let mut child = Command::new(&binary)
        .args(["server", "start", "--foreground", "--config"])
        .arg(&config_path.path)
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .env("ROUTECODEX_V3_CHAT_SUCCESS_KEY", "chat-success-secret")
        .env("ROUTECODEX_V3_CHAT_FAILURE_A_KEY", "chat-failure-a-secret")
        .env("ROUTECODEX_V3_CHAT_FAILURE_B_KEY", "chat-failure-b-secret")
        .env("TMPDIR", &temp_dir)
        .env("TMP", &temp_dir)
        .env("TEMP", &temp_dir)
        .env("ROUTECODEX_V3_STATE_DIR", &state_root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    eprintln!(
        "chat CLI pid={} binary={} config={}",
        child.id(),
        binary,
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

/// Budget for a foreground CLI server to answer `/health` on a cold start.
const HEALTH_READY_TIMEOUT: Duration = Duration::from_secs(60);

async fn wait_for_health(
    client: &reqwest::Client,
    cli: &mut CliProcess,
    port: u16,
    server_id: &str,
) {
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

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
