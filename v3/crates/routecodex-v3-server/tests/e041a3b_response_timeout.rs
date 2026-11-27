//! Public Responses regressions for setup deadlines, progressing streams,
//! rolling idle timeouts, cancellation, failover and counter persistence.
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::StatusCode,
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, oneshot},
    time::timeout,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();
const RESIDENCE_RESELECT_MS: u64 = 1_500;

fn completed() -> Value {
    json!({
        "id": "resp_e041a3b_sibling",
        "object": "response",
        "status": "completed",
        "model": "wire-e041a3b",
        "output": [{
            "id": "msg_e041a3b_sibling",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{
                "type": "output_text",
                "text": "sibling-success",
                "annotations": []
            }]
        }]
    })
}

async fn upstream(
    State(captures): State<mpsc::UnboundedSender<Value>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let _ = captures.send(body.clone());
    let input = body["input"].as_str().unwrap_or_default();
    let residence_case = body["input"]
        .as_str()
        .or_else(|| body["input"][0]["content"][0]["text"].as_str());
    if let Some(
        case @ ("recovery-before-residence"
        | "recovery-after-residence"
        | "successor-first-frame-timeout"
        | "successor-idle-timeout"),
    ) = residence_case
    {
        let after_deadline = case == "recovery-after-residence";
        let model = body["model"].as_str().unwrap();
        if model == "wire-recover"
            && matches!(
                case,
                "successor-first-frame-timeout" | "successor-idle-timeout"
            )
        {
            let body = if case == "successor-first-frame-timeout" {
                Body::from_stream(stream::pending::<Result<Bytes, Infallible>>())
            } else {
                let event = json!({
                    "type":"response.output_text.delta",
                    "delta":"unsuccessful-successor-prefix",
                    "item_id":"msg_failed_successor",
                    "output_index":0,
                    "content_index":0,
                    "sequence_number":0
                });
                let frame = format!("event: response.output_text.delta\ndata: {event}\n\n");
                Body::from_stream(
                    stream::iter([Ok::<_, Infallible>(Bytes::from(frame))])
                        .chain(stream::pending()),
                )
            };
            return Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(body)
                .unwrap();
        }
        let frames = if matches!(model, "wire-recover" | "wire-third") {
            let mut response = completed();
            response["model"] = json!(model);
            let terminal = json!({"type":"response.completed","response":response});
            let delta = json!({
                "type":"response.output_text.delta",
                "delta":"sibling-success",
                "item_id":"msg_e041a3b_sibling",
                "output_index":0,
                "content_index":0,
                "sequence_number":0
            });
            stream::once(async move {
                if after_deadline {
                    tokio::time::sleep(Duration::from_millis(80)).await;
                }
                Ok::<_, Infallible>(Bytes::from(format!(
                    "event: response.output_text.delta\ndata: {delta}\n\nevent: response.completed\ndata: {terminal}\n\n"
                )))
            })
            .boxed()
        } else {
            let progress_count = if case == "recovery-before-residence" {
                2
            } else {
                21
            };
            let upstream_started = Instant::now();
            stream::iter(0..=progress_count)
                .then(move |index| {
                    let captures = captures.clone();
                    async move {
                        if index > 0 {
                            tokio::time::sleep(Duration::from_millis(90)).await;
                        }
                        if index == progress_count {
                            let _ = captures.send(json!({
                                "fixture": "malformed_terminal_after_progress",
                                "elapsed_ms": upstream_started.elapsed().as_millis()
                            }));
                            return Ok(Bytes::from_static(
                                b"event: response.completed\ndata: invalid\n\n",
                            ));
                        }
                        let event = json!({
                            "type": "response.output_text.delta",
                            "delta": "unsuccessful-provider-prefix",
                            "item_id": "msg_failed_residence",
                            "output_index": 0,
                            "content_index": 0,
                            "sequence_number": index
                        });
                        Ok(Bytes::from(format!(
                            "event: response.output_text.delta\ndata: {event}\n\n"
                        )))
                    }
                })
                .boxed()
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(frames))
            .unwrap();
    }
    if input == "continuous-provider-stream" {
        let mut frames: Vec<_> = ["sibling", "-", "success"]
            .into_iter()
            .enumerate()
            .map(|(index, delta)| {
                let value = json!({
                    "type": "response.output_text.delta", "delta": delta,
                    "item_id": "msg_e041a3b_sibling", "output_index": 0,
                    "content_index": 0, "sequence_number": index
                });
                format!("event: response.output_text.delta\ndata: {value}\n\n")
            })
            .collect();
        frames.push(format!(
            "event: response.completed\ndata: {}\n\n",
            json!({"type":"response.completed","response":completed()})
        ));
        let stream =
            stream::iter(frames.into_iter().enumerate()).then(|(index, frame)| async move {
                if index > 0 {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                Ok::<_, Infallible>(Bytes::from(frame))
            });
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream))
            .unwrap();
    }
    if input.contains("committed-deadline") {
        let delta = json!({
            "type": "response.output_text.delta",
            "delta": "committed-business-delta",
            "item_id": "msg_e041a3b_committed",
            "output_index": 0,
            "content_index": 0,
            "sequence_number": 1
        });
        let frame = format!("event: response.output_text.delta\ndata: {delta}\n\n");
        let stream = stream::once(async move { Ok::<_, Infallible>(Bytes::from(frame)) })
            .chain(stream::pending());
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream))
            .unwrap();
    }

    if input.contains("deadline") && body["model"] != "wire-recover" {
        // The initial SSE guard waits for the provider's first semantic event
        // Emit one semantic frame to start the rolling idle guard. A reasoning
        // delta carries no visible business payload, so the client stays
        // uncommitted and the attempt can be recovered if the provider stalls.
        let reasoning = json!({
            "type": "response.reasoning_summary_text.delta",
            "delta": "deadline-reasoning",
            "item_id": "rs_e041a3b_deadline",
            "output_index": 0,
            "summary_index": 0,
            "sequence_number": 1
        });
        let frame = format!("event: response.reasoning_summary_text.delta\ndata: {reasoning}\n\n");
        let stream = stream::once(async move { Ok::<_, Infallible>(Bytes::from(frame)) })
            .chain(stream::pending());
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream))
            .unwrap();
    }

    let frame = format!(
        "event: response.completed\ndata: {}\n\n",
        json!({"type":"response.completed","response":completed()})
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(frame))
        .unwrap()
}

struct Entry {
    handle: V3ServerAggregateHandle,
    shutdown: oneshot::Sender<()>,
    peer: tokio::task::JoinHandle<()>,
    captures: mpsc::UnboundedReceiver<Value>,
}

impl Entry {
    fn base(&self) -> String {
        format!("http://{}", self.handle.listeners[0].addr)
    }

    async fn stop(self) {
        assert!(self.handle.shutdown().await.is_empty());
        let _ = self.shutdown.send(());
        timeout(Duration::from_secs(10), self.peer)
            .await
            .unwrap()
            .unwrap();
        std::env::remove_var("E041A3B_DEADLINE_KEY");
    }
}

async fn start() -> Entry {
    start_with(250, 5000, false, false).await
}

async fn start_with(residence_ms: u64, timeout_ms: u64, recovery: bool, health: bool) -> Entry {
    start_with_budgets(
        residence_ms,
        timeout_ms,
        timeout_ms,
        recovery,
        health,
        "direct",
    )
    .await
}

async fn start_with_budgets(
    residence_ms: u64,
    timeout_ms: u64,
    first_byte_ms: u64,
    recovery: bool,
    health: bool,
    process: &str,
) -> Entry {
    start_with_targets(
        residence_ms,
        timeout_ms,
        first_byte_ms,
        if recovery { 2 } else { 1 },
        health,
        process,
    )
    .await
}

async fn start_with_targets(
    residence_ms: u64,
    timeout_ms: u64,
    first_byte_ms: u64,
    candidate_count: usize,
    health: bool,
    process: &str,
) -> Entry {
    std::env::set_var("E041A3B_DEADLINE_KEY", "owned-fixture-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = listener.local_addr().unwrap();
    let (shutdown, stop) = oneshot::channel();
    let (captures, received) = mpsc::unbounded_channel();
    let peer = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/responses", post(upstream))
                .with_state(captures),
        )
        .with_graceful_shutdown(async {
            let _ = stop.await;
        })
        .await
        .unwrap();
    });

    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    hub_v1_fixture::pin_test_process_refill_off();
    let execution = format!(
        r#"
[servers.owned.execution]
allowed_modes = ["{process}"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{ residence_timeout_ms = {residence_ms} }}
"#
    );
    let port = test_ports::free_port();
    let backup_target = if candidate_count >= 2 {
        ",{kind=\"provider_model\",provider=\"test\",model=\"recover\",key=\"key\",priority=1}"
    } else {
        ""
    };
    let (third_model, third_target) = if candidate_count == 3 {
        (
            r#"[providers.test.models.third]
wire_name = "wire-third"
capabilities = ["text"]
supports_streaming = true"#,
            ",{kind=\"provider_model\",provider=\"test\",model=\"third\",key=\"key\",priority=0}",
        )
    } else {
        ("", "")
    };
    let source = format!(
        r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
[providers.test]
type = "responses"
base_url = "http://{upstream_addr}/v1"
default_model = "test"
auth = {{type="api_key",entries=[{{alias="key",env="E041A3B_DEADLINE_KEY"}}]}}
health = {{enabled={health},failure_threshold=1,cooldown_ms=5000}}
responses = {{process="{process}",streaming="client"}}
request_timeout_ms = {timeout_ms}
sse_first_frame_timeout_ms = {first_byte_ms}
[providers.test.models.test]
wire_name = "wire-e041a3b"
capabilities = ["text"]
supports_streaming = true
[providers.test.models.recover]
wire_name = "wire-recover"
capabilities = ["text"]
supports_streaming = true
{third_model}
[route_groups.default.pools.default]
selection = {{strategy="priority"}}
targets = [{{kind="provider_model",provider="test",model="test",key="key",priority=2}}{backup_target}{third_target}]
[debug]
log_console = false
snapshots = true
"#
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    Entry {
        handle: spawn_v3_server_aggregate(manifest).await.unwrap(),
        shutdown,
        peer,
        captures: received,
    }
}

async fn public_logs(entry: &Entry) -> Value {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{}/_routecodex/debug/logs", entry.base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn raw_deadline_request(entry: &Entry) -> (Vec<u8>, Duration, std::io::Result<usize>) {
    let body = json!({
        "model": "test.test",
        "input": "deadline-never-terminal",
        "stream": true
    })
    .to_string();
    let mut socket = TcpStream::connect(entry.handle.listeners[0].addr)
        .await
        .unwrap();
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: e041a3b-deadline\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let started = Instant::now();
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut wire = Vec::new();
    let ended = timeout(Duration::from_secs(8), socket.read_to_end(&mut wire))
        .await
        .expect("deadline request must terminate before the fixture watchdog");
    (wire, started.elapsed(), ended)
}

async fn raw_committed_request(entry: &Entry) -> (Vec<u8>, Duration, std::io::Result<usize>) {
    let body = json!({
        "model": "test.test",
        "input": "committed-deadline",
        "stream": true
    })
    .to_string();
    let mut socket = TcpStream::connect(entry.handle.listeners[0].addr)
        .await
        .unwrap();
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: e041a3b-committed\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let started = Instant::now();
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut wire = Vec::new();
    let ended = timeout(Duration::from_secs(8), socket.read_to_end(&mut wire))
        .await
        .expect("committed deadline request must terminate before the fixture watchdog");
    (wire, started.elapsed(), ended)
}

#[tokio::test]
async fn idle_timeout_terminates_uncommitted_direct_sse_with_typed_error_and_survives() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start_with_budgets(5_000, 5_000, 250, false, false, "direct").await;

    let (wire, elapsed, ended) = raw_deadline_request(&entry).await;
    let wire_text = String::from_utf8_lossy(&wire);
    let logs = public_logs(&entry).await;
    let projected_chains = logs["logs"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["node_id"] == "V3Error06ClientProjected")
        .map(|event| event["details"]["error_chain"].clone())
        .collect::<Vec<_>>();
    let projected_text = serde_json::to_string(&projected_chains).unwrap();
    let logs_text = serde_json::to_string(&logs).unwrap();
    let typed_deadline = logs_text.contains("residence deadline")
        || logs_text.contains("direct_sse_attempt_store_rejected")
        || logs_text.contains("provider_response_sse_stream");
    let six_node_chain = projected_chains.iter().any(|chain| {
        chain.as_array().is_some_and(|nodes| {
            nodes.len() == 6
                && nodes.first() == Some(&json!("V3Error01SourceRaised"))
                && nodes.last() == Some(&json!("V3Error06ClientProjected"))
        })
    });

    eprintln!(
        "e041a3b-red elapsed_ms={} wire_bytes={} wire={} ended={ended:?}",
        elapsed.as_millis(),
        wire.len(),
        wire_text
    );
    eprintln!("e041a3b-red typed_deadline={typed_deadline}");
    eprintln!("e041a3b-red chains={projected_text}");

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let response = client
        .post(format!("{}/v1/responses", entry.base()))
        .header("x-session-id", "e041a3b-deadline")
        .json(&json!({
            "model": "test.test",
            "input": "healthy-sibling",
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let sibling = response.text().await.unwrap();
    assert!(sibling.contains("sibling-success"));
    assert!(sibling.contains("response.completed"));
    eprintln!("e041a3b-red sibling={sibling}");

    assert!(
        elapsed <= Duration::from_millis(2000),
        "idle request took {elapsed:?}; expected the 250ms provider idle timeout"
    );
    assert!(
        elapsed >= Duration::from_millis(200),
        "idle request ended before the declared 250ms provider idle timeout: {elapsed:?}"
    );
    assert!(
        six_node_chain,
        "public diagnostics did not retain the V3Error01 -> V3Error06 typed chain: {projected_text}"
    );
    assert!(
        ended.is_ok()
            || ended
                .as_ref()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset),
        "client transport ended abnormally without an acceptable reset: {ended:?}"
    );
    assert!(
        wire.is_empty()
            || (wire_text.starts_with("HTTP/1.1 200") && wire_text.contains("text/event-stream")),
        "unexpected client transport framing: {wire_text}"
    );
    assert!(
        !wire_text.contains("deadline-business-delta")
            && !wire_text.contains("response.completed")
            && !wire_text.contains("\"status\":\"completed\""),
        "client received fake business success: {wire_text}"
    );
    assert!(
        !wire_text.contains("\"error\"")
            && !wire_text.contains("network_error")
            && !wire_text.contains("598")
            && !wire_text.contains("599")
            && !wire_text.contains("502"),
        "client received a provider/proxy error payload: {wire_text}"
    );
    assert!(
        !wire.ends_with(b"0\r\n\r\n"),
        "client received a normal chunked completion: {wire_text}"
    );

    entry.stop().await;
}

async fn cooldown_pool(entry: &Entry) -> Value {
    reqwest::Client::new()
        .get(format!("{}/_routecodex/health/cooldown-pool", entry.base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn provider_timeout_recovers_while_residence_remains() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_with(15000, 150, true, true).await;
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(12))
        .build()
        .unwrap()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"input":"deadline-first-provider","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(
        body.contains("sibling-success") && body.contains("response.completed"),
        "{body}"
    );
    assert!(
        !body.contains("deadline-business-delta") && !body.contains("\"error\""),
        "{body}"
    );
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-e041a3b"
    );
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-recover"
    );
    assert!(entry.captures.try_recv().is_err());
    eprintln!("e041a3b-recovery two-dispatches completed=true");
    entry.stop().await;
}

#[tokio::test]
async fn continuous_responses_stream_has_no_wall_clock_deadline_after_first_frame() {
    let _guard = TEST_LOCK.lock().await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let first_byte_ms = 500;
    for (process, residence_ms, whole_request_ms) in [
        ("direct", 5_000, 500),
        ("direct", 500, 2_500),
        ("relay", 5_000, 500),
        ("relay", 500, 2_500),
    ] {
        let mut entry = start_with_budgets(
            residence_ms,
            whole_request_ms,
            first_byte_ms,
            true,
            false,
            process,
        )
        .await;
        let response = client
            .post(format!("{}/v1/responses", entry.base()))
            .json(&json!({"input":"continuous-provider-stream","stream":true}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let wire = response.text().await.unwrap_or_else(|error| {
            panic!("{process} continuous stream ended with request budget {whole_request_ms}ms and residence {residence_ms}ms: {error}")
        });
        let payload_event = if process == "direct" {
            "event: response.output_text.delta"
        } else {
            "event: response.output_item.done"
        };
        assert!(wire.contains(payload_event), "{process}: {wire}");
        assert!(wire.contains("sibling-success"), "{wire}");
        assert_eq!(
            wire.matches("event: response.completed").count(),
            1,
            "{wire}"
        );
        assert_eq!(entry.captures.try_recv().unwrap()["model"], "wire-e041a3b");
        assert!(entry.captures.try_recv().is_err());
        entry.stop().await;
    }
}

#[tokio::test]
async fn json_responses_request_accepts_progressing_upstream_sse_past_both_deadlines() {
    let _guard = TEST_LOCK.lock().await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let mut entry = start_with_budgets(500, 500, 500, true, false, "relay").await;
    let response = client
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"input":"continuous-provider-stream","stream":false}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/json");
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["status"], "completed", "{body}");
    assert_eq!(body["id"], "resp_e041a3b_sibling", "{body}");
    assert_eq!(
        body["output"][0]["content"][0]["text"], "sibling-success",
        "{body}"
    );
    let dispatched = entry.captures.try_recv().unwrap();
    assert_eq!(dispatched["model"], "wire-e041a3b");
    assert_ne!(dispatched["stream"], true, "{dispatched}");
    assert!(entry.captures.try_recv().is_err());
    entry.stop().await;
}

#[tokio::test]
async fn issue0026412_relay_reselects_after_progressing_attempt_fails_past_residence() {
    let _guard = TEST_LOCK.lock().await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    for (input, after_deadline) in [
        ("recovery-before-residence", false),
        ("recovery-after-residence", true),
    ] {
        let mut entry =
            start_with_budgets(RESIDENCE_RESELECT_MS, 5_000, 600, true, false, "relay").await;
        let response = client
            .post(format!("{}/v1/responses", entry.base()))
            .json(&json!({"input":input,"stream":true}))
            .send()
            .await;
        let result = match response {
            Ok(response) => response.text().await,
            Err(error) => Err(error),
        };
        let mut ledger = Vec::new();
        while let Ok(event) = entry.captures.try_recv() {
            ledger.push(event);
        }
        entry.stop().await;

        assert_eq!(ledger[0]["model"], "wire-e041a3b", "{ledger:?}");
        assert_eq!(ledger[1]["fixture"], "malformed_terminal_after_progress");
        assert_eq!(
            ledger[1]["elapsed_ms"].as_u64().unwrap() >= RESIDENCE_RESELECT_MS,
            after_deadline,
            "{ledger:?}"
        );
        let attempts: Vec<_> = ledger
            .iter()
            .filter_map(|event| event["model"].as_str())
            .collect();
        assert_eq!(
            attempts,
            ["wire-e041a3b", "wire-recover"],
            "eligible fallback must run exactly once after {input}; client result: {result:?}"
        );
        let wire = result.unwrap_or_else(|error| {
            panic!("client did not complete for {input}; attempt ledger: {ledger:?}: {error}")
        });
        assert!(wire.contains("sibling-success"), "{wire}");
        assert_eq!(wire.matches("event: response.completed").count(), 1);
        assert!(!wire.contains("unsuccessful-provider-prefix"));
    }
}

#[tokio::test]
async fn issue0026412_relay_successor_timeouts_keep_exact_error_and_recovery() {
    let _guard = TEST_LOCK.lock().await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    for (input, candidate_count) in [
        ("successor-first-frame-timeout", 3),
        ("successor-idle-timeout", 2),
    ] {
        let mut entry = start_with_targets(
            RESIDENCE_RESELECT_MS,
            5_000,
            600,
            candidate_count,
            false,
            "relay",
        )
        .await;
        let port = entry.handle.listeners[0].addr.port();
        let mut response = client
            .post(format!("{}/v1/responses", entry.base()))
            .json(&json!({"input":input,"stream":true}))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let mut wire = Vec::new();
        let transport_failed = loop {
            match response.chunk().await {
                Ok(Some(bytes)) => wire.extend_from_slice(&bytes),
                Ok(None) => break false,
                Err(_) => break true,
            }
        };
        let attempts: Vec<String> = std::iter::from_fn(|| entry.captures.try_recv().ok())
            .filter_map(|event| event["model"].as_str().map(str::to_owned))
            .collect();
        entry.stop().await;

        let path = std::path::PathBuf::from(std::env::var_os("HOME").unwrap())
            .join(".rcc/logs")
            .join(format!("server-v3-{port}.request-records.jsonl"));
        let rows: Vec<_> = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["row"].clone())
            .collect();
        let failed_successor = rows
            .iter()
            .find(|row| {
                row["event_type"] == "request.provider_attempt_failed"
                    && row["meta"]["wire_model"] == "wire-recover"
            })
            .unwrap_or_else(|| panic!("missing failed successor attempt for {input}: {rows:?}"));
        let meta = &failed_successor["meta"];
        assert_eq!(meta["error_category"], "provider_transport_error");
        assert_eq!(meta["observed_error"]["external_error_kind"], "provider");
        assert_eq!(
            meta["observed_error"]["external_error_code"],
            "provider_transport_error"
        );
        assert!(meta["observed_error"]["external_error_status"].is_null());
        assert!(
            meta["error_detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("idle timeout (no frame within 600ms)")),
            "the successor must apply its own declared stream timeout: {failed_successor}"
        );

        let wire = String::from_utf8(wire).unwrap();
        assert_eq!(status, StatusCode::OK);
        assert!(!wire.contains("unsuccessful-provider-prefix"), "{wire}");
        assert!(!wire.contains("unsuccessful-successor-prefix"), "{wire}");
        assert!(!wire.contains("event: error"), "{wire}");
        if candidate_count == 3 {
            assert_eq!(attempts, ["wire-e041a3b", "wire-recover", "wire-third"]);
            assert!(!transport_failed, "{wire}");
            assert!(wire.contains("sibling-success"), "{wire}");
            assert_eq!(wire.matches("event: response.completed").count(), 1);
        } else {
            assert_eq!(attempts, ["wire-e041a3b", "wire-recover"]);
            assert!(transport_failed, "{wire}");
            assert!(!wire.contains("event: response.completed"), "{wire}");
        }
    }
}

#[tokio::test]
async fn request_counter_write_failure_preserves_responses_and_counts() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start().await;
    let counter_dir = std::path::PathBuf::from(std::env::var_os("HOME").unwrap())
        .join(".rcc")
        .join("state");
    let counter_file = counter_dir.join("request-id-counter.json");
    let counter_temp = counter_file.with_extension(format!("json.tmp.{}", std::process::id()));
    std::fs::create_dir_all(&counter_temp).unwrap();

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    for input in [
        "counter-write-fault-first",
        "counter-write-fault-second",
        "counter-writable",
    ] {
        if input == "counter-writable" {
            assert!(!counter_file.exists());
            std::fs::remove_dir(&counter_temp).unwrap();
        }
        let response = client
            .post(format!("{}/v1/responses", entry.base()))
            .json(&json!({"input":input,"stream":true}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.text().await.unwrap();
        assert!(
            body.contains("sibling-success") && body.contains("response.completed"),
            "{body}"
        );
        assert_eq!(entry.captures.try_recv().unwrap()["input"], input);
    }
    let state: Value = serde_json::from_slice(&std::fs::read(counter_file).unwrap()).unwrap();
    assert_eq!(state["totalCount"], 3);
    assert_eq!(state["windowCount"], 3);
    entry.stop().await;
}

#[tokio::test]
async fn expired_request_never_dispatches_or_cools_backup_candidate() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_with_budgets(250, 5_000, 500, true, true, "direct").await;
    let body = json!({"input":"deadline-no-backup-budget","stream":true}).to_string();
    let mut socket = TcpStream::connect(entry.handle.listeners[0].addr)
        .await
        .unwrap();
    socket.write_all(format!("POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    let mut wire = Vec::new();
    let _ = timeout(Duration::from_secs(2), socket.read_to_end(&mut wire))
        .await
        .expect("expired residence must not wait for recovery admission");
    assert!(!String::from_utf8_lossy(&wire).contains("response.completed"));
    assert!(!String::from_utf8_lossy(&wire).contains("\"error\""));
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-e041a3b"
    );
    assert!(
        entry.captures.try_recv().is_err(),
        "expired request dispatched backup"
    );
    let pool = cooldown_pool(&entry).await;
    let entries = pool["entries"].as_array().unwrap();
    assert!(
        entries.is_empty(),
        "pre-cool observation must not commit cooldown: {pool}"
    );
    assert!(
        entries.iter().all(|item| item["model_id"] != "recover"),
        "unattempted backup cooled: {pool}"
    );
    let response = reqwest::Client::new()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"input":"deadline-no-backup-budget","stream":true}))
        .send()
        .await
        .unwrap();
    // One failed attempt is below the real cooldown threshold. A fresh
    // request selects the same eligible identity and reaches its own timeout;
    // it does not inherit a synthetic pre-cool hold from the earlier request.
    assert!(
        response.text().await.is_err(),
        "the repeated incomplete attempt must break transport"
    );
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-e041a3b"
    );
    assert!(entry.captures.try_recv().is_err());
    let response = reqwest::Client::new()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"model":"test.recover","input":"healthy-sibling","stream":true}))
        .send()
        .await
        .unwrap();
    assert!(response.text().await.unwrap().contains("sibling-success"));
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-recover"
    );
    eprintln!("e041a3b-deadline backup-dispatched=false cooldown={pool}");
    entry.stop().await;
}

#[tokio::test]
async fn client_disconnect_releases_activity_without_provider_cooldown() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_with(15000, 5000, false, true).await;
    let response = reqwest::Client::new()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"model":"test.test","input":"deadline-client-cancel","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    timeout(Duration::from_secs(2), entry.captures.recv())
        .await
        .unwrap()
        .unwrap();
    drop(response);
    let preparation = timeout(Duration::from_secs(2), entry.handle.prepare_exec_attempt())
        .await
        .expect("client cancellation leaked active runtime work")
        .unwrap();
    drop(preparation);
    let pool = cooldown_pool(&entry).await;
    assert_eq!(
        pool["entries"].as_array().unwrap().len(),
        0,
        "client cancellation cooled provider: {pool}"
    );
    let response = reqwest::Client::new()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"model":"test.test","input":"healthy-sibling","stream":true}))
        .send()
        .await
        .unwrap();
    assert!(response.text().await.unwrap().contains("sibling-success"));
    eprintln!("e041a3b-client-cancel released=true cooldown=[] sibling=completed");
    entry.stop().await;
}

#[tokio::test]
async fn idle_timeout_after_unaccepted_business_frame_breaks_transport_without_backup_dispatch() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start_with_budgets(250, 5_000, 600, true, true, "direct").await;

    let (wire, elapsed, ended) = raw_committed_request(&entry).await;
    let wire_text = String::from_utf8_lossy(&wire);

    eprintln!(
        "e041a3b-committed elapsed_ms={} wire_bytes={} wire={} ended={ended:?}",
        elapsed.as_millis(),
        wire.len(),
        wire_text
    );

    assert!(
        elapsed <= Duration::from_millis(2000),
        "committed stream took {elapsed:?}; expected the 600ms provider idle timeout"
    );
    assert!(
        elapsed >= Duration::from_millis(500),
        "committed stream ended before the provider idle window: {elapsed:?}"
    );
    assert!(
        wire_text.starts_with("HTTP/1.1 200") && wire_text.contains("text/event-stream"),
        "unexpected client transport framing: {wire_text}"
    );
    assert!(
        !wire_text.contains("committed-business-delta"),
        "client received an unaccepted attempt prefix: {wire_text}"
    );
    assert!(
        !wire_text.contains("response.completed")
            && !wire_text.contains("\"status\":\"completed\"")
            && !wire_text.contains("\"error\"")
            && !wire_text.contains("network_error")
            && !wire_text.contains("598")
            && !wire_text.contains("599")
            && !wire_text.contains("502"),
        "client received fake success or a provider/proxy error payload: {wire_text}"
    );
    assert!(
        !wire.ends_with(b"0\r\n\r\n"),
        "committed transport must break, not fake a normal chunked completion: {wire_text}"
    );
    assert!(
        ended.is_ok()
            || ended
                .as_ref()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset),
        "client transport ended abnormally without an acceptable reset: {ended:?}"
    );
    assert_eq!(
        entry.captures.recv().await.unwrap()["model"],
        "wire-e041a3b"
    );
    assert!(
        entry.captures.try_recv().is_err(),
        "committed first frame dispatched backup after the client channel committed"
    );

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let response = client
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"model":"test.recover","input":"healthy-sibling","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let sibling = response.text().await.unwrap();
    assert!(sibling.contains("sibling-success"));
    assert!(sibling.contains("response.completed"));
    eprintln!("e041a3b-committed sibling={sibling}");

    entry.stop().await;
}
