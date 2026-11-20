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
        "ordinary-visible-secret-token" => {
            let text = "ordinary secret remains visible";
            vec![
                delta(0, 0, text),
                text_done(0, 0, text),
                completed(json!([message(text)])),
            ]
        }
        "failed-attempt-reasoning-before-seal" if model != "wire-recover" => {
            let label = dsml_close();
            let full = format!(
                "<thinking>failed-attempt-reasoning</thinking>failed-attempt-visible\n{label}\n"
            );
            vec![
                delta(0, 0, &full),
                text_done(0, 0, &full),
                completed(json!([message(&full)])),
            ]
        }
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
        // The public proof that a declared-tool request projects its first
        // business delta before the provider terminal. The fixture upstream
        // holds the terminal back 500ms; the gate under test decides whether
        // the delta reaches the client socket during that hold.
        "tool-request-progressive" => vec![
            delta(0, 0, "early-progressive-text"),
            text_done(0, 0, "early-progressive-text"),
            completed(json!([message("early-progressive-text")])),
        ],
        // A declared-tool request whose first output text is already tool
        // markup the complete-attempt DSML owner harvests. The commit probe
        // must never certify this prefix, because the terminal rewrite would
        // then have to change an already-flushed client frame.
        "tool-declared-markup" => {
            let call = "<tool_call>write_file<arg_key>path</arg_key><arg_value>/tmp/out.txt</arg_value></tool_call>";
            vec![
                delta(0, 0, call),
                text_done(0, 0, call),
                completed(json!([message(call)])),
            ]
        }
        // The demonstrated malformed alternate opener. It is a declared-tool
        // harvest entry point even though it never contains `<tool_call>`, so
        // the declared-tool probe extension must hold it until the owner
        // harvests the whole alternate invocation at the terminal.
        "tool-alternate-opener-markup" => {
            let call = "Done.\n<|exec_command\">\n<cmd>printf 42</cmd>\n</exec_command>";
            vec![
                delta(0, 0, call),
                text_done(0, 0, call),
                completed(json!([message(call)])),
            ]
        }
        // The declared fullwidth envelope written on one line. The standalone
        // OPEN label of the base marker set is line-scoped, so only the
        // declared-tool INVOKE extension catches this harvest shape.
        "tool-one-line-fullwidth-markup" => {
            let call = "Go.\n<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name=\"write_file\"><｜｜DSML｜｜ parameter name=\"path\" string=\"true\">/tmp/out.txt</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>";
            vec![
                delta(0, 0, call),
                text_done(0, 0, call),
                completed(json!([message(call)])),
            ]
        }
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
    // The progressive case holds every frame after the first 500ms apart, so
    // the delta can only reach the client before the terminal if the gate
    // under test projects it during the provider hold.
    let delay = if input == "tool-request-progressive" {
        Some(Duration::from_millis(500))
    } else {
        None
    };
    let stream = stream::unfold(
        (frames.into_iter(), delay, 0usize),
        |(mut frames, delay, index)| async move {
            let frame = match frames.next() {
                Some(frame) => frame,
                None => return None,
            };
            if index > 0 {
                if let Some(delay) = delay {
                    tokio::time::sleep(delay).await;
                }
            }
            Some((
                Ok::<_, Infallible>(Bytes::from(frame)),
                (frames, delay, index + 1),
            ))
        },
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
    raw_request_body(entry, session, body).await
}

async fn raw_request_body(
    entry: &Entry,
    session: &str,
    body: String,
) -> (Vec<u8>, std::io::Result<usize>) {
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

/// Read the public stream incrementally and record when the first projected
/// business delta and the terminal event reach the socket.
///
/// The gate under test decides the projection moment, not the byte content, so
/// a whole-body read cannot observe it. Every provider attempt is buffered and
/// released at the terminal unless the first-frame commit gate opens; the
/// arrival gap between the first business delta and `response.completed` is the
/// only public proof of progressive projection.
async fn timed_request(entry: &Entry, session: &str, input: &str, tools: Value) -> TimedWire {
    let body = json!({
        "model": "test",
        "input": input,
        "stream": true,
        "tools": tools
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

    let started = std::time::Instant::now();
    let mut wire = Vec::new();
    let mut first_delta_at = None;
    let mut completed_at = None;
    loop {
        let mut chunk = [0u8; 4096];
        let count = match timeout(Duration::from_secs(8), socket.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(count)) => count,
            Ok(Err(_)) => break,
            Err(_) => break,
        };
        wire.extend_from_slice(&chunk[..count]);
        let seen = String::from_utf8_lossy(&wire);
        if first_delta_at.is_none() && seen.contains("response.output_text.delta") {
            first_delta_at = Some(started.elapsed());
        }
        if completed_at.is_none() && seen.contains("response.completed") {
            completed_at = Some(started.elapsed());
        }
    }
    TimedWire {
        wire,
        first_delta_at,
        completed_at,
    }
}

struct TimedWire {
    wire: Vec<u8>,
    first_delta_at: Option<Duration>,
    completed_at: Option<Duration>,
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

fn collect_message_output_text(item: &Value, texts: &mut Vec<String>) {
    if item["type"] != "message" {
        return;
    }
    if let Some(text) = item["text"].as_str() {
        texts.push(text.to_owned());
    }
    for part in item["content"].as_array().into_iter().flatten() {
        if part["type"] == "output_text" {
            if let Some(text) = part["text"].as_str() {
                texts.push(text.to_owned());
            }
        }
    }
}

fn projected_visible_text_values(wire: &[u8]) -> Vec<String> {
    let mut texts = Vec::new();
    for event in response_sse_events(&decoded_chunked_body(wire)) {
        match event["type"].as_str() {
            Some("response.output_text.delta") => {
                if let Some(delta) = event["delta"].as_str() {
                    texts.push(delta.to_owned());
                }
            }
            Some("response.output_text.done") => {
                if let Some(text) = event["text"].as_str() {
                    texts.push(text.to_owned());
                }
            }
            Some("response.content_part.added" | "response.content_part.done") => {
                if event.pointer("/part/type").and_then(Value::as_str) == Some("output_text") {
                    if let Some(text) = event.pointer("/part/text").and_then(Value::as_str) {
                        texts.push(text.to_owned());
                    }
                }
            }
            Some("response.output_item.added" | "response.output_item.done") => {
                collect_message_output_text(&event["item"], &mut texts);
            }
            Some(
                "response.created"
                | "response.in_progress"
                | "response.queued"
                | "response.completed"
                | "response.incomplete",
            ) => {
                for item in event
                    .pointer("/response/output")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    collect_message_output_text(item, &mut texts);
                }
            }
            _ => {}
        }
    }
    texts
}

fn terminal_reasoning_summary_texts(wire: &[u8]) -> Vec<String> {
    let events = response_sse_events(&decoded_chunked_body(wire));
    let Some(terminal) = events.iter().rev().find(|event| {
        matches!(
            event["type"].as_str(),
            Some("response.completed" | "response.incomplete")
        )
    }) else {
        return Vec::new();
    };
    let mut texts = Vec::new();
    for item in terminal
        .pointer("/response/output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "reasoning")
    {
        for part in item["summary"].as_array().into_iter().flatten() {
            if part["type"] == "summary_text" {
                if let Some(text) = part["text"].as_str() {
                    texts.push(text.to_owned());
                }
            }
        }
    }
    texts
}

fn reasoning_summary_event_texts(wire: &[u8], event_type: &str) -> Vec<String> {
    response_sse_events(&decoded_chunked_body(wire))
        .into_iter()
        .filter(|event| event["type"] == event_type)
        .filter_map(|event| {
            event["text"].as_str().map(str::to_owned).or_else(|| {
                (event_type == "response.reasoning_summary_text.delta")
                    .then(|| event["delta"].as_str().map(str::to_owned))
                    .flatten()
            })
        })
        .collect()
}

fn assert_governed_thinking(
    wire: &[u8],
    text: &str,
    expected_visible: &[&str],
    expected_reasoning: &[&str],
) {
    assert!(
        !text.contains("<thinking>") && !text.contains("</thinking>") && !text.contains("<thin"),
        "governance markers must not reach the client: {text}"
    );

    let visible = projected_visible_text_values(wire);
    assert!(
        !visible.is_empty(),
        "client received no visible business text: {text}"
    );
    assert!(
        visible.iter().all(|value| {
            !value.contains("<thinking>")
                && !value.contains("</thinking>")
                && !value.contains("<thin")
                && !value.contains("</thin")
                && expected_reasoning
                    .iter()
                    .all(|reasoning| !value.contains(reasoning))
        }),
        "governed thinking body reached a visible text carrier: {visible:?}"
    );
    assert_eq!(
        completed_output_texts(wire),
        expected_visible,
        "the terminal response must contain exactly the legitimate visible output"
    );

    let reasoning_deltas =
        reasoning_summary_event_texts(wire, "response.reasoning_summary_text.delta");
    let reasoning_done =
        reasoning_summary_event_texts(wire, "response.reasoning_summary_text.done");
    let terminal_reasoning = terminal_reasoning_summary_texts(wire);
    for (name, values) in [
        ("reasoning delta", &reasoning_deltas),
        ("reasoning done", &reasoning_done),
        ("terminal reasoning summary", &terminal_reasoning),
    ] {
        assert_eq!(
            values, expected_reasoning,
            "{name} must faithfully carry the governed thinking body"
        );
    }
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

/// A fully buffered Relay attempt that fails before its request-level seal must
/// not hand the client a single provider business byte. The listener may have
/// accepted the SSE transport, so the client observes the transport head and a
/// detectable body break, never semantic content or an error payload.
fn assert_pre_seal_failure_delivered_no_business(wire: &[u8], ended: &std::io::Result<usize>) {
    let text = wire_text(wire);
    assert!(
        !text.contains("response.created"),
        "a pre-seal failure must not deliver a response head: {text}"
    );
    assert!(
        !text.contains("response.output_text.delta") && !text.contains("response.completed"),
        "a pre-seal failure must not deliver business frames: {text}"
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
}

#[tokio::test]
async fn thinking_governance_projects_reasoning_and_preserves_committed_prefix() {
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

    // Full buffering lets the complete-attempt thinking owner project the
    // governed result before any byte reaches the client. The tags are control
    // syntax; the enclosed model reasoning is legitimate deliverable content.
    assert!(text.contains("committed-prefix"), "{text}");
    assert!(text.contains("response.completed"), "{text}");
    assert!(
        text.ends_with("0\r\n\r\n"),
        "the governed attempt must seal normally: {text}"
    );
    assert_eq!(completed_output_texts(&wire), vec!["committed-prefix "]);
    assert_governed_thinking(&wire, &text, &["committed-prefix "], &["secret"]);
    assert_no_client_error(&text);
    assert!(ended.is_ok(), "unexpected transport ending: {ended:?}");
    entry.stop().await;
}

#[tokio::test]
async fn ordinary_visible_secret_token_is_preserved() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, ended) = raw_request(
        &entry,
        "849ed8f-ordinary-secret",
        "ordinary-visible-secret-token",
    )
    .await;
    let text = wire_text(&wire);
    let expected = "ordinary secret remains visible";

    assert_eq!(completed_output_texts(&wire), vec![expected]);
    let visible = projected_visible_text_values(&wire);
    assert!(
        visible.iter().all(|value| value == expected),
        "ordinary visible text must not be rewritten: {visible:?}"
    );
    assert!(
        reasoning_summary_event_texts(&wire, "response.reasoning_summary_text.delta").is_empty(),
        "untagged business text must not be fabricated as reasoning: {text}"
    );
    assert!(terminal_reasoning_summary_texts(&wire).is_empty(), "{text}");
    assert_no_client_error(&text);
    assert!(ended.is_ok(), "unexpected transport ending: {ended:?}");
    entry.stop().await;
}

#[tokio::test]
async fn split_orphan_before_seal_delivers_no_business_bytes() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, _) = raw_request(&entry, "849ed8f-orphan-after", "split-orphan-after-commit").await;
    let text = wire_text(&wire);
    eprintln!("849ed8f orphan-after wire={text}");

    assert_pre_seal_failure_delivered_no_business(&wire, &std::io::Result::Ok(0));
    assert!(!text.contains("tool_calls"), "{text}");
    assert!(
        !text.contains("hello"),
        "the buffered business text must not reach the client: {text}"
    );
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
async fn failed_attempt_reasoning_is_not_projected_before_recovery() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start(true).await;
    let (wire, _) = raw_request(
        &entry,
        "849ed8f-failed-attempt-reasoning",
        "failed-attempt-reasoning-before-seal",
    )
    .await;
    let text = wire_text(&wire);
    eprintln!("849ed8f failed-attempt-reasoning wire={text}");

    let first = entry.captures.recv().await.expect("first provider attempt");
    let second = entry.captures.recv().await.expect("recovery attempt");
    assert_eq!(first["model"], "wire-849ed8f");
    assert_eq!(second["model"], "wire-recover");
    assert_eq!(first["input"], "failed-attempt-reasoning-before-seal");
    assert_eq!(second["input"], "failed-attempt-reasoning-before-seal");
    assert!(
        entry.captures.try_recv().is_err(),
        "exactly two provider attempts are expected"
    );

    assert_eq!(completed_output_texts(&wire), vec!["recovered"]);
    assert!(
        projected_visible_text_values(&wire)
            .iter()
            .all(|value| value == "recovered"),
        "the failed attempt's visible text must not reach the client: {text}"
    );
    assert!(
        !text.contains("failed-attempt-reasoning")
            && !text.contains("failed-attempt-visible")
            && !text.contains("<thinking>")
            && !text.contains("</thinking>"),
        "the failed attempt's reasoning or governed marker text leaked: {text}"
    );
    assert!(
        reasoning_summary_event_texts(&wire, "response.reasoning_summary_text.delta").is_empty()
            && reasoning_summary_event_texts(&wire, "response.reasoning_summary_text.done")
                .is_empty()
            && terminal_reasoning_summary_texts(&wire).is_empty(),
        "the failed attempt's reasoning must not be projected: {text}"
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
async fn snapshot_carrier_collision_projects_reasoning_and_completes() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, ended) =
        raw_request(&entry, "849ed8f-snapshot-marker", "snapshot-split-marker").await;
    let text = wire_text(&wire);

    // Full buffering rewrites the complete attempt before any byte reaches
    // the client. The thinking body moves into the governed reasoning item;
    // the split marker never appears as a literal tag in visible text.
    assert!(text.contains("safe-prefix"), "{text}");
    assert!(text.contains("response.completed"), "{text}");
    assert!(
        text.ends_with("0\r\n\r\n"),
        "the governed attempt must seal normally: {text}"
    );
    assert_eq!(
        completed_output_texts(&wire),
        vec!["safe-prefix  tail", "ordinary"]
    );
    assert_governed_thinking(
        &wire,
        &text,
        &["safe-prefix  tail", "ordinary"],
        &["secret"],
    );
    assert_no_client_error(&text);
    assert!(ended.is_ok(), "unexpected transport ending: {ended:?}");
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
    // The committed prefix is the first visible delta. The DSML owner removes
    // the bare close residue from the held tail while keeping the delivered
    // frame byte-identical, so the attempt now completes instead of breaking
    // the transport: the append-only precondition of the post-commit failure
    // path (the owner cannot project the tail without rewriting a flushed
    // frame) does not hold for this shape.
    assert!(
        text.contains("response.completed"),
        "the preserved-prefix rewrite must complete the attempt: {text}"
    );
    assert!(
        text.ends_with("0\r\n\r\n"),
        "the completed attempt must end the chunked body: {text}"
    );
    assert_eq!(
        text.matches("\"delta\":\"hello\\n\"").count(),
        1,
        "the delivered prefix must not be re-emitted: {text}"
    );
    let events = response_sse_events(&decoded_chunked_body(&wire));
    let terminal = events
        .iter()
        .find(|event| event["type"] == "response.completed")
        .expect("terminal event");
    let output = terminal["response"]["output"].as_array().unwrap();
    assert_eq!(output[0]["content"][0]["text"], "hello\n", "{terminal}");
    assert_eq!(output[1]["content"][0]["text"], "ordinary", "{terminal}");
    assert_no_client_error(&text);
    assert!(ended.is_ok(), "unexpected transport ending: {ended:?}");
    entry.stop().await;
}

#[tokio::test]
async fn clean_probe_terminal_acceptance_failure_before_seal_delivers_no_business_bytes() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, ended) = raw_request(
        &entry,
        "849ed8f-clean-terminal-failure",
        "clean-probe-terminal-empty",
    )
    .await;
    let text = wire_text(&wire);

    assert!(
        !text.contains("clean-prefix"),
        "the buffered prefix must not reach the client: {text}"
    );
    assert_pre_seal_failure_delivered_no_business(&wire, &ended);
    entry.stop().await;
}

#[tokio::test]
async fn interleaved_carriers_project_reasoning_and_complete() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    let (wire, ended) = raw_request(&entry, "849ed8f-interleaved", "interleaved-thinking").await;
    let text = wire_text(&wire);
    eprintln!("849ed8f interleaved wire={text}");

    // Full buffering rewrites the complete attempt before any byte reaches
    // the client. The thinking body moves into the governed reasoning item;
    // the interleaved split marker never appears as a literal tag.
    assert!(text.contains("safe-prefix"), "{text}");
    assert!(text.contains("response.completed"), "{text}");
    assert!(
        text.ends_with("0\r\n\r\n"),
        "a fully buffered governed attempt must seal normally: {text}"
    );
    let events = response_sse_events(&decoded_chunked_body(&wire));
    let terminal = events
        .iter()
        .find(|event| event["type"] == "response.completed")
        .expect("terminal event");
    let output = terminal["response"]["output"].as_array().unwrap();
    assert_eq!(
        output[0]["content"][0]["text"], "safe-prefix  tail",
        "{terminal}"
    );
    assert_eq!(output[0]["content"][1]["text"], "other", "{terminal}");
    assert_governed_thinking(&wire, &text, &["safe-prefix  tail", "other"], &["secret"]);
    assert_no_client_error(&text);
    assert!(ended.is_ok(), "unexpected transport ending: {ended:?}");
    entry.stop().await;
}

#[tokio::test]
async fn declared_tool_request_buffers_business_delta_until_provider_terminal() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    // The DSH harness always declares tools and omits `tool_choice`, so a
    // declared-tool request is the normal live shape. The declared name is a
    // plain function tool, like the harness injected tools.
    let tools = json!([{
        "type": "function",
        "name": "write_file",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"]
        }
    }]);
    let timed = timed_request(
        &entry,
        "849ed8f-tool-first-frame",
        "tool-request-progressive",
        tools,
    )
    .await;
    let text = wire_text(&timed.wire);

    assert!(text.contains("early-progressive-text"), "{text}");
    let first_delta_at = timed
        .first_delta_at
        .expect("the first business delta must reach the client");
    let completed_at = timed
        .completed_at
        .expect("the attempt must project its terminal");
    let lead = completed_at.saturating_sub(first_delta_at);
    assert!(
        lead < Duration::from_millis(100),
        "provider business content must remain buffered until the complete attempt is accepted; measured delta={first_delta_at:?} terminal={completed_at:?} lead={lead:?}"
    );
    assert_no_client_error(&text);
    entry.stop().await;
}

#[tokio::test]
async fn declared_tool_text_markup_is_held_then_harvested_without_leak() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    // The same declaration shape the first-frame test uses. The provider text
    // is a serialized declaration-shaped call, which the complete-attempt DSML
    // owner harvests into a real function_call item. If the commit probe ever
    // certified the raw markup prefix, the terminal rewrite would have to
    // change already-flushed client frames and the transport would break.
    let tools = json!([{
        "type": "function",
        "name": "write_file",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"]
        }
    }]);
    let timed = timed_request(&entry, "849ed8f-tool-markup", "tool-declared-markup", tools).await;
    let text = wire_text(&timed.wire);

    assert!(
        text.contains("response.completed"),
        "the harvested attempt must complete normally: {text}"
    );
    assert!(
        text.contains("function_call") && text.contains("write_file"),
        "the declared call must reach the client as a function_call: {text}"
    );
    for residue in ["<tool_call>", "</tool_call>", "<arg_key>", "<arg_value>"] {
        assert!(
            !text.contains(residue),
            "harvested markup residue {residue:?} leaked to the client: {text}"
        );
    }
    assert_no_client_error(&text);
    entry.stop().await;
}

#[tokio::test]
async fn declared_tool_alternate_opener_is_held_then_harvested_without_leak() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    // The alternate opener `<|name">` is a DSML harvest entry point that does
    // not contain `<tool_call>`. The probe extension must hold the prefix for
    // the declared-tool request, or the terminal rewrite would have to change
    // an already-flushed frame containing the raw opener.
    let tools = json!([{
        "type": "function",
        "name": "exec_command",
        "parameters": {
            "type": "object",
            "properties": {"cmd": {"type": "string"}},
            "required": ["cmd"]
        }
    }]);
    let timed = timed_request(
        &entry,
        "849ed8f-tool-alternate",
        "tool-alternate-opener-markup",
        tools,
    )
    .await;
    let text = wire_text(&timed.wire);

    assert!(
        text.contains("response.completed"),
        "the harvested attempt must complete normally: {text}"
    );
    assert!(
        text.contains("function_call") && text.contains("exec_command"),
        "the alternate call must reach the client as a function_call: {text}"
    );
    for residue in ["<|exec_command\">", "<cmd>", "</cmd>", "</exec_command>"] {
        assert!(
            !text.contains(residue),
            "harvested alternate residue {residue:?} leaked to the client: {text}"
        );
    }
    assert_no_client_error(&text);
    entry.stop().await;
}

#[tokio::test]
async fn declared_tool_one_line_fullwidth_markup_is_held_then_harvested_without_leak() {
    let _guard = TEST_LOCK.lock().await;
    let entry = start(false).await;
    // The declared fullwidth envelope on one line does not equal the standalone
    // OPEN label, so the base line-scoped marker never matches it. The
    // declared-tool INVOKE marker must hold it instead.
    let tools = json!([{
        "type": "function",
        "name": "write_file",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"]
        }
    }]);
    let timed = timed_request(
        &entry,
        "849ed8f-tool-fullwidth",
        "tool-one-line-fullwidth-markup",
        tools,
    )
    .await;
    let text = wire_text(&timed.wire);

    assert!(
        text.contains("response.completed"),
        "the harvested attempt must complete normally: {text}"
    );
    assert!(
        text.contains("function_call") && text.contains("write_file"),
        "the one-line envelope call must reach the client as a function_call: {text}"
    );
    for residue in [
        "<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} calls>",
        "<\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} invoke",
    ] {
        assert!(
            !text.contains(residue),
            "harvested fullwidth residue {residue:?} leaked to the client: {text}"
        );
    }
    assert_no_client_error(&text);
    entry.stop().await;
}

#[allow(dead_code)]
fn _keep_base_link_used(entry: &Entry) -> String {
    entry.base()
}
