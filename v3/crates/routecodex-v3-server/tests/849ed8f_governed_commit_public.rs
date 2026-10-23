//! Public-entry regressions for the Direct Responses first-frame commit gate.
//!
//! These tests use a real HTTP listener and a raw client socket. They cover the
//! governance cases that cannot be established by the private collector:
//! semantic terminal ordering, bare close-residue removal, pre-commit recovery,
//! and interleaved output carriers.

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::StatusCode,
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::stream;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{convert::Infallible, time::Duration};
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
const PROVIDER_KEY_ENV: &str = "D849ED8F_GOVERNED_COMMIT_KEY";

fn dsml_close() -> &'static str {
    // Exact standalone label removed by the registered DSML owner without any
    // tool declaration (`tool_markup_parser::ORPHAN_TOOL_CLOSE`).
    "</\u{FF5C}DSML\u{FF5C}tool_calls>"
}

fn sse(kind: &str, data: Value) -> String {
    format!("event: {kind}\ndata: {data}\n\n")
}

fn delta(output_index: usize, content_index: usize, text: &str) -> String {
    sse(
        "response.output_text.delta",
        json!({
            "type": "response.output_text.delta",
            "item_id": "msg_849ed8f_0",
            "output_index": output_index,
            "content_index": content_index,
            "delta": text
        }),
    )
}

fn delta_as(output_index: usize, content_index: usize, item_id: &str, text: &str) -> String {
    sse(
        "response.output_text.delta",
        json!({
            "type": "response.output_text.delta",
            "item_id": item_id,
            "output_index": output_index,
            "content_index": content_index,
            "delta": text
        }),
    )
}

fn text_done(output_index: usize, content_index: usize, text: &str) -> String {
    sse(
        "response.output_text.done",
        json!({
            "type": "response.output_text.done",
            "item_id": "msg_849ed8f_0",
            "output_index": output_index,
            "content_index": content_index,
            "text": text
        }),
    )
}

fn text_done_as(output_index: usize, content_index: usize, item_id: &str, text: &str) -> String {
    sse(
        "response.output_text.done",
        json!({
            "type": "response.output_text.done",
            "item_id": item_id,
            "output_index": output_index,
            "content_index": content_index,
            "text": text
        }),
    )
}

fn completed(output: Value) -> String {
    sse(
        "response.completed",
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp_849ed8f",
                "object": "response",
                "status": "completed",
                "model": "wire-849ed8f",
                "output": output
            }
        }),
    )
}

fn in_progress(output: Value) -> String {
    sse(
        "response.in_progress",
        json!({
            "type": "response.in_progress",
            "response": {
                "id": "resp_849ed8f",
                "object": "response",
                "status": "in_progress",
                "model": "wire-849ed8f",
                "output": output
            }
        }),
    )
}

fn message(text: &str) -> Value {
    message_with_id(text, "msg_849ed8f_0")
}

fn message_with_id(text: &str, item_id: &str) -> Value {
    json!({
        "id": item_id,
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}]
    })
}

fn scenario(input: &str, model: &str) -> Vec<String> {
    match input {
        "post-commit-thinking-failure" => vec![
            delta(0, 0, "committed-prefix"),
            delta(0, 0, "<thinking>secret</thinking>"),
            completed(json!([message(
                "committed-prefix <thinking>secret</thinking>"
            )])),
        ],
        "split-orphan-before-commit" if model != "wire-recover" => {
            let label = dsml_close();
            let (head, tail) = label.split_at(2);
            let full = label.to_owned();
            vec![
                delta(0, 0, head),
                delta(0, 0, tail),
                text_done(0, 0, &full),
                completed(json!([message(&full)])),
            ]
        }
        "split-orphan-after-commit" => {
            let label = dsml_close();
            let (head, tail) = label.split_at(2);
            let full = format!("hello\n{label}\n");
            vec![
                delta(0, 0, "hello\n"),
                delta(0, 0, head),
                delta(0, 0, tail),
                text_done(0, 0, &full),
                completed(json!([message(&full)])),
            ]
        }
        "bare-residue-newline" => {
            let close = "</\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} calls>";
            let full = format!("hello\n>\n{close}");
            vec![
                delta(0, 0, "hello\n>\n"),
                delta(0, 0, close),
                text_done(0, 0, &full),
                completed(json!([message(&full)])),
            ]
        }
        "interleaved-thinking" => {
            let first = "safe-prefix <thinking>secret</thinking> tail";
            vec![
                delta(0, 0, "safe-prefix "),
                delta(0, 0, "<thin"),
                delta(0, 1, "other"),
                delta(0, 0, "king>secret</thinking> tail"),
                text_done(0, 0, first),
                text_done(0, 1, "other"),
                completed(json!([
                    {
                        "id": "msg_849ed8f_0",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {"type": "output_text", "text": first, "annotations": []},
                            {"type": "output_text", "text": "other", "annotations": []}
                        ]
                    }
                ])),
            ]
        }
        "snapshot-split-marker" => {
            let full = "safe-prefix <thinking>secret</thinking> tail";
            vec![
                delta(0, 0, "safe-prefix "),
                delta(0, 0, "<thin"),
                delta_as(1, 0, "msg_849ed8f_1", "ordinary "),
                in_progress(json!([
                    message_with_id("safe-prefix <thin", "msg_849ed8f_0"),
                    message_with_id("ordinary", "msg_849ed8f_1")
                ])),
                delta(0, 0, "king>secret</thinking> tail"),
                text_done(0, 0, full),
                text_done_as(0, 1, "msg_849ed8f_1", "ordinary"),
                completed(json!([
                    message_with_id(full, "msg_849ed8f_0"),
                    message_with_id("ordinary", "msg_849ed8f_1")
                ])),
            ]
        }
        "snapshot-bare-residue" => {
            let close = "</\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} calls>";
            let full = format!("hello\n>\n{close}");
            vec![
                delta(0, 0, "hello\n"),
                delta(0, 0, ">\n"),
                delta_as(1, 0, "msg_849ed8f_1", "ordinary "),
                in_progress(json!([
                    message_with_id("hello\n>\n", "msg_849ed8f_0"),
                    message_with_id("ordinary", "msg_849ed8f_1")
                ])),
                delta(0, 0, close),
                text_done(0, 0, &full),
                text_done_as(0, 1, "msg_849ed8f_1", "ordinary"),
                completed(json!([
                    message_with_id(&full, "msg_849ed8f_0"),
                    message_with_id("ordinary", "msg_849ed8f_1")
                ])),
            ]
        }
        "clean-probe-terminal-empty" => vec![
            in_progress(json!([message("clean-prefix")])),
            completed(json!([])),
        ],
        _ if model == "wire-recover" => vec![completed(json!([message("recovered")]))],
        _ => vec![completed(json!([message("sibling-success")]))],
    }
}

async fn upstream(
    State(captures): State<mpsc::UnboundedSender<Value>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let _ = captures.send(body.clone());
    let input = body["input"].as_str().unwrap_or_default();
    let model = body["model"].as_str().unwrap_or_default();
    let frames = scenario(input, model);
    let stream = stream::iter(
        frames
            .into_iter()
            .map(|frame| Ok::<_, Infallible>(Bytes::from(frame))),
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(stream))
        .unwrap()
}

struct Entry {
    handle: V3ServerAggregateHandle,
    captures: mpsc::UnboundedReceiver<Value>,
    shutdown: oneshot::Sender<()>,
    peer: tokio::task::JoinHandle<()>,
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
        std::env::remove_var(PROVIDER_KEY_ENV);
    }
}

async fn start(recovery: bool) -> Entry {
    std::env::set_var(PROVIDER_KEY_ENV, "owned-fixture-key");
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
    let execution = format!(
        "{}\nattempt_store = {{ residence_timeout_ms = 5000 }}\n",
        hub_v1_fixture::hub_v1_server_execution("owned")
    );
    let port = test_ports::free_port();
    let backup_target = if recovery {
        ",{kind=\"provider_model\",provider=\"recovery\",model=\"test\",key=\"key\",priority=1}"
    } else {
        ""
    };
    let recovery_provider = if recovery {
        format!(
            r#"
[providers.recovery]
type = "responses"
base_url = "http://{upstream_addr}/v1"
default_model = "test"
auth = {{type="api_key",entries=[{{alias="key",env="D849ED8F_GOVERNED_COMMIT_KEY"}}]}}
responses = {{process="direct",streaming="always"}}
request_timeout_ms = 5000
sse_first_frame_timeout_ms = 5000
[providers.recovery.models.test]
wire_name = "wire-recover"
capabilities = ["text"]
supports_streaming = true
"#
        )
    } else {
        String::new()
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
auth = {{type="api_key",entries=[{{alias="key",env="D849ED8F_GOVERNED_COMMIT_KEY"}}]}}
responses = {{process="direct",streaming="always"}}
request_timeout_ms = 5000
sse_first_frame_timeout_ms = 5000
[providers.test.models.test]
wire_name = "wire-849ed8f"
capabilities = ["text"]
supports_streaming = true
{recovery_provider}
[route_groups.default.pools.default]
selection = {{strategy="priority"}}
targets = [{{kind="provider_model",provider="test",model="test",key="key",priority=2}}{backup_target}]
[debug]
log_console = false
snapshots = true
"#
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    Entry {
        handle: spawn_v3_server_aggregate(manifest).await.unwrap(),
        captures: received,
        shutdown,
        peer,
    }
}

async fn raw_request(
    entry: &Entry,
    session: &str,
    input: &str,
) -> (Vec<u8>, std::io::Result<usize>) {
    let body = json!({
        "model": "test",
        "input": input,
        "stream": true
    })
    .to_string();
    let mut socket = TcpStream::connect(entry.handle.listeners[0].addr)
        .await
        .unwrap();
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: {session}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut wire = Vec::new();
    let ended = timeout(Duration::from_secs(8), socket.read_to_end(&mut wire))
        .await
        .expect("public request must terminate before the fixture watchdog");
    (wire, ended)
}

fn wire_text(wire: &[u8]) -> String {
    String::from_utf8_lossy(wire).into_owned()
}

fn decoded_chunked_body(wire: &[u8]) -> String {
    let header_end = wire
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("HTTP response headers");
    let body = &wire[header_end + 4..];
    let mut cursor = 0;
    let mut decoded = Vec::new();
    while cursor < body.len() {
        let line_end = body[cursor..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| cursor + offset)
            .expect("chunk size line");
        let size_line = std::str::from_utf8(&body[cursor..line_end])
            .unwrap()
            .trim_end_matches('\r');
        let size = usize::from_str_radix(size_line.split(';').next().unwrap_or(""), 16)
            .expect("chunk size");
        cursor = line_end + 1;
        if size == 0 {
            break;
        }
        let chunk_end = cursor + size;
        decoded.extend_from_slice(&body[cursor..chunk_end]);
        cursor = chunk_end + 2;
    }
    String::from_utf8(decoded).unwrap()
}

fn response_sse_events(body: &str) -> Vec<Value> {
    body.split("\n\n")
        .filter_map(|event| {
            let payload = event
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim))
                .collect::<Vec<_>>()
                .join("\n");
            (!payload.is_empty())
                .then(|| serde_json::from_str(&payload).ok())
                .flatten()
        })
        .collect()
}

fn completed_output_texts(wire: &[u8]) -> Vec<String> {
    let events = response_sse_events(&decoded_chunked_body(wire));
    let completed = events
        .iter()
        .rev()
        .find(|event| event["type"] == "response.completed")
        .and_then(|event| event.pointer("/response/output"))
        .and_then(Value::as_array)
        .expect("completed response output");
    let mut texts = Vec::new();
    for item in completed {
        if item["type"] == "message" {
            if let Some(text) = item["text"].as_str() {
                texts.push(text.to_owned());
                continue;
            }
            if let Some(content) = item.pointer("/content").and_then(Value::as_array) {
                for part in content {
                    if part["type"] == "output_text" {
                        if let Some(text) = part["text"].as_str() {
                            texts.push(text.to_owned());
                        }
                    }
                }
            }
        }
    }
    texts
}

/// Concatenate the client-visible text carried by the projected delta events.
///
/// The wire body is JSON, so the DSML label and a `>\n` residue only appear in
/// the decoded delta values; a raw substring scan over the chunked body cannot
/// see them.
fn projected_delta_text(wire: &[u8]) -> String {
    let mut text = String::new();
    for event in response_sse_events(&decoded_chunked_body(wire)) {
        match event["type"].as_str() {
            Some("response.output_text.delta") => {
                if let Some(delta) = event["delta"].as_str() {
                    text.push_str(delta);
                }
            }
            Some("response.output_text.done") => {
                if let Some(done) = event["text"].as_str() {
                    text.push_str(done);
                }
            }
            _ => {}
        }
    }
    text
}

fn assert_no_client_error(text: &str) {
    assert!(
        !text.contains("\"error\"")
            && !text.contains("network_error")
            && !text.contains("598")
            && !text.contains("599")
            && !text.contains("502"),
        "client received a provider/proxy error payload: {text}"
    );
}

#[tokio::test]
async fn post_commit_thinking_governance_breaks_before_completion() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, ended) = raw_request(
        &entry,
        "849ed8f-post-commit-thinking",
        "post-commit-thinking-failure",
    )
    .await;
    let text = wire_text(&wire);
    eprintln!("849ed8f post-terminal wire={text}");

    assert!(text.contains("committed-prefix"), "{text}");
    assert!(
        !text.contains("<thinking>") && !text.contains("secret"),
        "{text}"
    );
    assert!(!text.contains("response.completed"), "{text}");
    assert!(
        !text.ends_with("0\r\n\r\n"),
        "normal chunked completion leaked: {text}"
    );
    assert_no_client_error(&text);
    assert!(
        ended.is_ok()
            || ended
                .as_ref()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset),
        "unexpected transport ending: {ended:?}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn split_orphan_after_clean_commit_does_not_leak_label_or_completion() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, _) = raw_request(&entry, "849ed8f-orphan-after", "split-orphan-after-commit").await;
    let text = wire_text(&wire);
    eprintln!("849ed8f orphan-after wire={text}");

    assert!(text.contains("hello"), "{text}");
    assert!(!text.contains("tool_calls"), "{text}");
    assert!(!text.contains("response.completed"), "{text}");
    assert!(
        !text.ends_with("0\r\n\r\n"),
        "normal chunked completion leaked: {text}"
    );
    assert_no_client_error(&text);
    entry.stop().await;
}

#[tokio::test]
async fn split_orphan_before_commit_recovers_without_leaking() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start(true).await;
    let (wire, _) = raw_request(
        &entry,
        "849ed8f-orphan-before",
        "split-orphan-before-commit",
    )
    .await;
    let text = wire_text(&wire);
    eprintln!("849ed8f orphan-before wire={text}");
    let first = entry.captures.recv().await.expect("first provider attempt");
    let second = entry.captures.recv().await.expect("recovery attempt");
    assert_eq!(first["model"], "wire-849ed8f");
    assert_eq!(second["model"], "wire-recover");
    assert_eq!(first["input"], "split-orphan-before-commit");
    assert_eq!(second["input"], "split-orphan-before-commit");
    assert!(
        entry.captures.try_recv().is_err(),
        "exactly two provider attempts are expected"
    );

    assert!(text.contains("recovered"), "{text}");
    assert!(text.contains("response.completed"), "{text}");
    assert!(!text.contains("tool_calls"), "{text}");
    assert!(
        !text.contains("<thinking>") && !text.contains("</thinking>") && !text.contains("secret"),
        "the governed marker body must never reach the client: {text}"
    );
    assert_no_client_error(&text);
    entry.stop().await;
}

#[tokio::test]
async fn bare_residue_newline_is_removed_before_projection() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, _) = raw_request(&entry, "849ed8f-residue", "bare-residue-newline").await;
    let text = wire_text(&wire);
    eprintln!("849ed8f residue wire={text}");

    assert!(text.contains("hello"), "{text}");
    assert!(text.contains("response.completed"), "{text}");
    assert!(!text.contains("DSML"), "{text}");
    assert_eq!(completed_output_texts(&wire), vec!["hello\n"]);
    assert_no_client_error(&text);
    entry.stop().await;
}

#[tokio::test]
async fn snapshot_carrier_collision_does_not_release_split_marker_early() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, ended) =
        raw_request(&entry, "849ed8f-snapshot-marker", "snapshot-split-marker").await;
    let text = wire_text(&wire);

    assert!(text.contains("safe-prefix"), "{text}");
    assert!(!text.contains("<thin"), "{text}");
    assert!(!text.contains("<thinking>"), "{text}");
    assert!(!text.contains("</thinking>"), "{text}");
    assert!(!text.contains("secret"), "{text}");
    assert!(
        !text.contains("response.completed"),
        "the bounded truncation must not project completion: {text}"
    );
    assert!(
        !text.ends_with("0\r\n\r\n"),
        "normal chunked completion leaked: {text}"
    );
    assert_no_client_error(&text);
    assert!(
        ended.is_ok()
            || ended
                .as_ref()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset),
        "unexpected transport ending: {ended:?}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn snapshot_carrier_collision_does_not_release_bare_residue_early() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, ended) =
        raw_request(&entry, "849ed8f-snapshot-residue", "snapshot-bare-residue").await;
    let text = wire_text(&wire);
    let projected = projected_delta_text(&wire);

    assert!(text.contains("hello"), "{text}");
    assert!(
        !projected.contains('>'),
        "the bare close residue must never reach the client: {projected:?}"
    );
    assert!(
        !projected.contains("DSML"),
        "the close label must never reach the client: {projected:?}"
    );
    assert!(
        !text.contains('>') && !text.contains("DSML"),
        "any projected event form must not carry the residue or label: {text}"
    );
    assert!(
        !text.contains("response.completed"),
        "the bounded truncation must not project completion: {text}"
    );
    assert!(
        !text.ends_with("0\r\n\r\n"),
        "normal chunked completion leaked: {text}"
    );
    assert_no_client_error(&text);
    assert!(
        ended.is_ok()
            || ended
                .as_ref()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset),
        "unexpected transport ending: {ended:?}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn clean_probe_terminal_acceptance_failure_never_projects_completion() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, ended) = raw_request(
        &entry,
        "849ed8f-clean-terminal-failure",
        "clean-probe-terminal-empty",
    )
    .await;
    let text = wire_text(&wire);

    assert!(text.contains("clean-prefix"), "{text}");
    assert!(!text.contains("response.completed"), "{text}");
    assert!(
        !text.ends_with("0\r\n\r\n"),
        "normal chunked completion leaked: {text}"
    );
    assert_no_client_error(&text);
    assert!(
        ended.is_ok()
            || ended
                .as_ref()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset),
        "unexpected transport ending: {ended:?}"
    );
    entry.stop().await;
}

#[tokio::test]
async fn interleaved_carriers_hold_thinking_marker_without_leaking() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, ended) = raw_request(&entry, "849ed8f-interleaved", "interleaved-thinking").await;
    let text = wire_text(&wire);
    eprintln!("849ed8f interleaved wire={text}");

    assert!(text.contains("safe-prefix"), "{text}");
    assert!(!text.contains("<thinking>"), "{text}");
    assert!(!text.contains("</thinking>"), "{text}");
    assert!(!text.contains("secret"), "{text}");
    assert!(!text.contains("response.completed"), "{text}");
    assert!(
        !text.ends_with("0\r\n\r\n"),
        "normal chunked completion leaked: {text}"
    );
    assert_no_client_error(&text);
    assert!(
        ended.is_ok()
            || ended
                .as_ref()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset),
        "unexpected transport ending: {ended:?}"
    );
    entry.stop().await;
}

#[allow(dead_code)]
fn _keep_base_link_used(entry: &Entry) -> String {
    entry.base()
}
