//! Public-entry blackbox: the request id success counter must move only for a
//! delivered normal response and never for an error terminal, and must reload
//! from the persisted file after a server restart.
//!
//! `ROUTECODEX_REQUEST_ID_COUNTER_FILE` points the aggregate at a fixture file
//! so every assertion reads the exact state the live listener published.

use axum::{
    body::{Body, Bytes},
    extract::Json,
    http::StatusCode,
    response::Response,
    routing::post,
    Router,
};
use futures_util::stream;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

use tokio::sync::oneshot;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

const PROVIDER_KEY_ENV: &str = "V3_REQUEST_COUNT_SUCCESS_KEY";

static COUNTER_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct CounterEnvironment {
    _guard: std::sync::MutexGuard<'static, ()>,
    previous: Option<OsString>,
    previous_home: Option<OsString>,
    directory: PathBuf,
}

impl CounterEnvironment {
    fn new() -> Self {
        let guard = COUNTER_ENV_LOCK.lock().unwrap();
        let directory = std::env::temp_dir().join(format!(
            "rcc-req-count-success-{}-{}",
            std::process::id(),
            test_ports::free_port()
        ));
        std::fs::create_dir(&directory).unwrap();
        let previous = std::env::var_os("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &directory);
        std::env::set_var(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            directory.join("request-id-counter.json"),
        );
        Self {
            _guard: guard,
            previous,
            previous_home,
            directory,
        }
    }

    fn counter_file(&self) -> PathBuf {
        self.directory.join("request-id-counter.json")
    }
}

impl Drop for CounterEnvironment {
    fn drop(&mut self) {
        if let Some(previous_home) = &self.previous_home {
            std::env::set_var("HOME", previous_home);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(previous) = &self.previous {
            std::env::set_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE", previous);
        } else {
            std::env::remove_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
        }
        // Server tasks may still be settling sample files after shutdown; a
        // leaked temp directory must not turn into a test failure.
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

async fn upstream_chat(Json(body): Json<Value>) -> Response<Body> {
    if body.get("force_error").and_then(Value::as_bool) == Some(true) {
        // A provider HTTP error must stay in the typed Error chain; the client
        // transport terminates instead of receiving this payload.
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error": {"message": "upstream boom", "type": "server_error"}}).to_string(),
            ))
            .unwrap();
    }
    // Message content is preserved by every protocol projection, so a business
    // content marker is a stable way to drive the provider error terminal from
    // an Anthropic Messages client request whose other fields are remapped.
    let asks_for_provider_error =
        body.get("messages")
            .and_then(Value::as_array)
            .is_some_and(|messages| {
                messages.iter().any(|message| {
                    message.get("content").and_then(Value::as_str) == Some("provider-boom")
                })
            });
    if asks_for_provider_error {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error": {"message": "upstream boom", "type": "server_error"}}).to_string(),
            ))
            .unwrap();
    }
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let mut frames = Vec::new();
        frames.push(
            format!(
                "data: {}\n\n",
                json!({
                    "id": "chatcmpl-stream",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "wire-model",
                    "choices": [{"index": 0, "delta": {"role": "assistant", "content": "ok"}, "finish_reason": null}]
                })
            )
        );
        frames.push(format!(
            "data: {}\n\n",
            json!({
                "id": "chatcmpl-stream",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "wire-model",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]
            })
        ));
        frames.push("data: [DONE]\n\n".to_string());
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream::iter(
                frames
                    .into_iter()
                    .map(|frame| Ok::<_, Infallible>(Bytes::from(frame))),
            )))
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "chatcmpl-success",
                "object": "chat.completion",
                "model": "wire-model",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "ok"},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
            })
            .to_string(),
        ))
        .unwrap()
}

fn manifest(
    server_port: u16,
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("count");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.count]
bind = "127.0.0.1"
port = {server_port}
routing_group = "count"
endpoints = ["responses", "anthropic"]
{execution}
[providers.count]
type = "openai_chat"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_REQUEST_COUNT_SUCCESS_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "client" }}
[providers.count.models.wire-model]
wire_name = "wire-model"
aliases = ["count-client"]
capabilities = ["text"]
supports_streaming = true
[debug]
log_console = false
[route_groups.count.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["count-client"] }}
targets = [{{ kind = "provider_model", provider = "count", model = "wire-model", key = "key", priority = 1 }}]
[route_groups.count.pools.anthropic]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "anthropic", models = ["count-client"] }}
targets = [{{ kind = "provider_model", provider = "count", model = "wire-model", key = "key", priority = 1 }}]
[route_groups.count.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "count", model = "wire-model", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn read_counter(file: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()
}

/// The success commit runs on the terminal console path, so a blackbox reads
/// the persisted file through a bounded wait instead of assuming the write
/// already happened when the client body ended.
async fn wait_for_total(file: &Path, expected: u64) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if file.exists() {
            let counter = read_counter(file);
            if counter["totalCount"] == json!(expected) {
                return counter;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "request counter never reached totalCount={expected}: {}",
                file.exists()
                    .then(|| read_counter(file).to_string())
                    .unwrap_or_else(|| "<missing>".to_string())
            );
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// The persisted WebUI/observability store the live-mock matrix correlates to:
/// a `request.completed` row in this file is the delivered success terminal.
fn request_records_path(home: &Path, port: u16) -> PathBuf {
    home.join(".rcc")
        .join("logs")
        .join(format!("server-v3-{port}.request-records.jsonl"))
}

fn read_request_record_rows(path: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|line| line.get("row").cloned())
        .collect()
}

async fn spawn_server(upstream_port: u16) -> (V3ServerAggregateHandle, String) {
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), upstream_port))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    (handle, endpoint)
}

#[tokio::test]
async fn request_count_anthropic_relay_sse_counts_only_on_completion() {
    let counter_environment = CounterEnvironment::new();
    std::env::set_var(PROVIDER_KEY_ENV, "fixture-key");
    let counter_file = counter_environment.counter_file();

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new().route("/v1/chat/completions", post(upstream_chat)),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await
        .unwrap();
    });

    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);

    // A correctly delivered Anthropic relay SSE stream is a delivered success
    // terminal and must count exactly once: the relay lane commits at the stream
    // terminal, not when the response head is handed to the client.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let completed = client
        .post(format!("{base}/v1/messages"))
        .json(&json!({
            "model": "count-client",
            "max_tokens": 64,
            "messages": [{"role": "user", "content": "hello"}],
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        completed.status(),
        200,
        "relay SSE must complete: {completed:?}"
    );
    let completed_body = completed.text().await.unwrap();
    assert!(
        completed_body.contains("message_stop"),
        "relay SSE must deliver the Anthropic terminal event, got: {completed_body}"
    );
    let after_completed = wait_for_total(&counter_file, 1).await;
    assert_eq!(after_completed["windowCount"], json!(1));
    let after_completed_sequence = after_completed["sequence"].as_u64().unwrap();

    // The drop/disconnect terminal of the same finalizer is locked
    // deterministically at the committed-stream layer by the
    // `relay_sse_console_finalizer_commits_count_only_on_completed_terminal`
    // unit test, which drops the wrapped stream before its terminal frame and
    // asserts totalCount/windowCount stay 0 while only sequence advanced. A
    // socket-level blackbox cannot observe that terminal reliably here: the
    // Relay lane fully buffers the provider attempt and replays the committed
    // body in one write, so a client close races a completed write into the
    // kernel buffer instead of a real mid-stream disconnect.

    // A provider HTTP error on the relay lane must never count.
    let provider_error = client
        .post(format!("{base}/v1/messages"))
        .json(&json!({
            "model": "count-client",
            "max_tokens": 64,
            "messages": [{"role": "user", "content": "provider-boom"}],
            "stream": true
        }))
        .send()
        .await;
    if let Ok(response) = provider_error {
        // The single eligible candidate is exhausted, so the client transport
        // breaks without a provider error payload and without a success terminal.
        let body = response.text().await.unwrap_or_default();
        assert!(
            !body.contains("upstream boom"),
            "provider error payload must not reach the client, got: {body}"
        );
        assert!(
            !body.contains("message_stop"),
            "an exhausted relay must not deliver a success terminal, got body: {body}"
        );
    } else {
        // A transport break with no response head is the same error terminal.
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after_provider_error = read_counter(&counter_file);
    assert_eq!(
        after_provider_error["totalCount"],
        json!(1),
        "a relay provider error must not count: {after_provider_error}"
    );
    assert_eq!(after_provider_error["windowCount"], json!(1));
    assert_eq!(
        after_provider_error["sequence"],
        json!(after_completed_sequence + 1),
        "the relay provider error still consumed one allocation sequence"
    );

    assert!(handle.shutdown().await.is_empty());
    let _ = shutdown_tx.send(());
    std::env::remove_var(PROVIDER_KEY_ENV);
}

#[tokio::test]
async fn request_count_success_only_public_blackbox() {
    let counter_environment = CounterEnvironment::new();
    std::env::set_var(PROVIDER_KEY_ENV, "fixture-key");
    let counter_file = counter_environment.counter_file();

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new().route("/v1/chat/completions", post(upstream_chat)),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await
        .unwrap();
    });

    let (handle, endpoint) = spawn_server(upstream_addr.port()).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    // The counter file is created lazily by the first request allocation, so
    // the pre-request assertion is only that no stale state exists.
    assert!(!counter_file.exists());

    // A delivered non-streaming response commits both counts exactly once.
    let success = client
        .post(&endpoint)
        .json(&json!({"model": "count-client", "input": "hello", "stream": false}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        success.status(),
        200,
        "success request must complete: {success:?}"
    );
    let after_success = wait_for_total(&counter_file, 1).await;
    assert_eq!(after_success["windowCount"], json!(1));
    assert_eq!(after_success["sequence"], json!(1));
    assert_eq!(after_success["version"], json!(2));

    // An error terminal (malformed JSON admission) must not count. The listener
    // may reject with a client 4xx or break the transport without a payload;
    // either is an error terminal and neither may move the success counters.
    if let Ok(response) = client
        .post(&endpoint)
        .header("content-type", "application/json")
        .body("this-is-not-json")
        .send()
        .await
    {
        assert!(
            !response.status().is_success(),
            "malformed JSON must be an error terminal, got {}",
            response.status()
        );
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after_error = read_counter(&counter_file);
    assert_eq!(after_error["totalCount"], json!(1), "error must not count");
    assert_eq!(after_error["windowCount"], json!(1), "error must not count");
    // The error request still consumed an allocation sequence (proving it went
    // through the request-identity entry), yet never committed a success.
    assert_eq!(after_error["sequence"], json!(2));

    // A delivered streaming (SSE) response is a success terminal too.
    let streamed = client
        .post(&endpoint)
        .json(&json!({"model": "count-client", "input": "stream it", "stream": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        streamed.status(),
        200,
        "streaming success request must complete: {streamed:?}"
    );
    let streamed_body = streamed.text().await.unwrap();
    assert!(
        streamed_body.contains("response.completed") || streamed_body.contains("output_text"),
        "streaming success must deliver the projected client payload, got: {streamed_body}"
    );
    let after_stream = wait_for_total(&counter_file, 2).await;
    assert_eq!(after_stream["windowCount"], json!(2));
    assert_eq!(after_stream["sequence"], json!(3));

    // A provider HTTP error must never surface to the client as an error payload
    // and must never count.
    if let Ok(response) = client
        .post(&endpoint)
        .json(&json!({"model": "count-client", "input": "boom", "force_error": true}))
        .send()
        .await
    {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        assert!(
            !status.is_success(),
            "provider error must not project a success response, got {status}"
        );
        assert!(
            !body.contains("upstream boom"),
            "provider error payload must not reach the client, got: {body}"
        );
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after_provider_error = read_counter(&counter_file);
    assert_eq!(
        after_provider_error["totalCount"],
        json!(2),
        "provider error must not count"
    );
    assert_eq!(
        after_provider_error["windowCount"],
        json!(2),
        "provider error must not count"
    );
    assert_eq!(
        after_provider_error["sequence"],
        json!(4),
        "provider error must still consume one allocation sequence"
    );

    // Restart the aggregate against the same persisted counter file: the counts
    // must reload, not reset, and the next success continues from 3.
    assert!(handle.shutdown().await.is_empty());
    let (restarted, endpoint) = spawn_server(upstream_addr.port()).await;
    let success = client
        .post(&endpoint)
        .json(&json!({"model": "count-client", "input": "hello again", "stream": false}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        success.status(),
        200,
        "restarted success request must complete: {success:?}"
    );
    let after_restart = wait_for_total(&counter_file, 3).await;
    assert_eq!(after_restart["windowCount"], json!(3));
    assert_eq!(after_restart["sequence"], json!(5));
    assert_eq!(after_restart["version"], json!(2));

    assert!(restarted.shutdown().await.is_empty());
    let _ = shutdown_tx.send(());
    std::env::remove_var(PROVIDER_KEY_ENV);
}

/// An Anthropic relay lane answers JSON as well as SSE. Both closeouts carry a
/// runtime stream observation, so the success count and the delivered
/// `request.completed` terminal must follow the client body shape, not the
/// presence of that observation. A JSON closeout that stays uncounted is
/// invisible to the SSE-only test and was a real regression: the live-mock
/// matrix correlates a case through this terminal row.
#[tokio::test]
async fn request_count_anthropic_relay_json_counts_and_writes_completed_terminal() {
    let counter_environment = CounterEnvironment::new();
    std::env::set_var(PROVIDER_KEY_ENV, "fixture-key");
    let counter_file = counter_environment.counter_file();
    let home = counter_environment.directory.clone();

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new().route("/v1/chat/completions", post(upstream_chat)),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await
        .unwrap();
    });

    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let port = handle.listeners[0].addr.port();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    let response = client
        .post(format!("{base}/v1/messages"))
        .json(&json!({
            "model": "count-client",
            "max_tokens": 64,
            "messages": [{"role": "user", "content": "hello"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        200,
        "a non-stream Anthropic relay success must complete: {response:?}"
    );
    let body = response.text().await.unwrap();
    assert!(
        body.contains("\"type\":\"message\"") || body.contains("\"content\""),
        "a non-stream Anthropic response must carry the projected message: {body}"
    );

    // The count commits exactly once for a non-stream success.
    let after_success = wait_for_total(&counter_file, 1).await;
    assert_eq!(after_success["windowCount"], json!(1));
    assert_eq!(after_success["sequence"], json!(1));
    assert_eq!(after_success["version"], json!(2));

    // The same success must also publish its delivered terminal row, because the
    // live-mock matrix correlates a relay case through `request.completed`. A
    // count without the terminal would count a response the reviewer cannot see
    // as delivered.
    let records_path = request_records_path(&home, port);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let rows = loop {
        let rows = read_request_record_rows(&records_path);
        if rows
            .iter()
            .any(|row| row["event_type"] == "request.completed")
            || tokio::time::Instant::now() >= deadline
        {
            break rows;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    let completed_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| row["event_type"] == "request.completed")
        .collect();
    assert_eq!(
        completed_rows.len(),
        1,
        "a non-stream Anthropic relay success must write exactly one request.completed terminal: {rows:#?}"
    );
    assert_eq!(completed_rows[0]["result"], "success", "{rows:#?}");
    assert!(
        !rows.iter().any(|row| row["event_type"] == "request.failed"),
        "a delivered non-stream success must not also write a failed terminal: {rows:#?}"
    );

    assert!(handle.shutdown().await.is_empty());
    let _ = shutdown_tx.send(());
    std::env::remove_var(PROVIDER_KEY_ENV);
}
