//! Public-entry black-box regression for canonical issue `00feabc`.
//!
//! Stable test ID: `issue00feabc_inbound_codec_ledger_terminal_written_once`.
//!
//! Command:
//! `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test 00feabc_inbound_codec_ledger_terminal -- --nocapture`
//!
//! The defect: an inbound Anthropic Direct codec failure (the request body
//! cannot be standardized, e.g. `messages` is not an array) returns from the
//! runtime before the observability accumulator exists. The server records a
//! `request.started` row but never a terminal row, so the request ledger stays
//! open forever for that request key.
//!
//! This fixture drives the same public entry (`POST /v1/messages`, Direct
//! execution) with a malformed Anthropic body and asserts:
//! - the inbound codec failure never dispatches a provider attempt;
//! - the request ledger leaves a `request.started` row;
//! - exactly one terminal row (`request.failed`) is persisted, carrying the
//!   typed Error06 projection truth;
//! - the client is not shown a fabricated success or provider payload.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::time::{sleep, Instant};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const AUTH_ENV: &str = "V3_00FEABC_ANTHROPIC_KEY";
const CLIENT_MODEL: &str = "client-model";

struct ProviderCallCount(AtomicU64);

/// The controlled upstream is never expected to be contacted: the inbound codec
/// failure happens before route resolution and provider transport.
async fn ok_upstream(State(calls): State<Arc<ProviderCallCount>>) -> Response<Body> {
    calls.0.fetch_add(1, Ordering::SeqCst);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "msg_00feabc_unexpected",
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": "anthropic-wire",
                "stop_reason": null,
                "stop_sequence": null,
                "usage": {"input_tokens": 1, "output_tokens": 1}
            })
            .to_string(),
        ))
        .unwrap()
}

async fn start_upstream() -> (
    u16,
    Arc<ProviderCallCount>,
    tokio::sync::oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(ProviderCallCount(AtomicU64::new(0)));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = Router::new()
        .route("/v1/messages", post(ok_upstream))
        .with_state(Arc::clone(&calls));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (address.port(), calls, shutdown_tx)
}

fn manifest(server_port: u16, peer_port: u16) -> routecodex_v3_config::V3Config05ManifestPublished {
    // A skeleton-only Hub declaration keeps the config default Anthropic
    // binding (Direct), which is the lane that loses the terminal row on an
    // inbound codec failure.
    let declaration = "[pipelines.hub_v1]\nskeleton = \"hub_v1\"\n";
    let execution = hub_v1_fixture::hub_v1_server_execution("owned");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {server_port}
routing_group = "default"
endpoints = ["anthropic"]
{execution}
[providers.anthropic]
type = "anthropic"
base_url = "http://127.0.0.1:{peer_port}"
default_model = "anthropic-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{auth_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
request_timeout_ms = 2000
sse_first_frame_timeout_ms = 2000
[providers.anthropic.models.anthropic-wire]
wire_name = "anthropic-wire"
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "anthropic", model = "anthropic-wire", key = "key", priority = 1 }}]
[debug]
log_console = false
snapshots = false
"#,
        declaration = declaration,
        execution = execution,
        server_port = server_port,
        peer_port = peer_port,
        auth_env = AUTH_ENV,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn request_records_path(home: &std::path::Path, port: u16) -> PathBuf {
    home.join(".rcc")
        .join("logs")
        .join(format!("server-v3-{port}.request-records.jsonl"))
}

fn read_rows(path: &std::path::Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|line| line.get("row").cloned())
        .collect()
}

fn is_terminal(row: &Value) -> bool {
    matches!(
        row["event_type"].as_str(),
        Some("request.completed" | "request.failed" | "request.cancelled")
    )
}

#[tokio::test]
async fn issue00feabc_inbound_codec_ledger_terminal_written_once() {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    std::env::set_var(AUTH_ENV, "owned-fixture-secret");

    let (peer_port, calls, peer_shutdown) = start_upstream().await;
    let server_port = test_ports::free_port();
    let handle = spawn_v3_server_aggregate(manifest(server_port, peer_port))
        .await
        .unwrap();
    let listener_addr = handle.listeners[0].addr;

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    // `messages` is a string, not the required array: this is the inbound
    // Anthropic codec failure the issue describes.
    let response = client
        .post(format!("http://{listener_addr}/v1/messages"))
        .json(&json!({
            "model": CLIENT_MODEL,
            "max_tokens": 16,
            "stream": false,
            "messages": "not-an-array"
        }))
        .send()
        .await;

    // The inbound codec fails before route resolution: no provider attempt.
    assert_eq!(
        calls.0.load(Ordering::SeqCst),
        0,
        "the inbound codec failure must not dispatch a provider attempt"
    );
    let (client_status, client_body) = match response {
        Err(_) => (None, String::new()),
        Ok(response) => {
            let status = Some(response.status());
            let body = response
                .bytes()
                .await
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
            match body {
                Ok(body) => (status, body),
                Err(_) => (status, String::new()),
            }
        }
    };
    assert_ne!(
        client_status,
        Some(reqwest::StatusCode::OK),
        "the inbound codec failure must not fabricate client success"
    );

    let records_path = request_records_path(&home, server_port);
    let deadline = Instant::now() + Duration::from_secs(20);
    let rows = loop {
        let rows = read_rows(&records_path);
        if rows.iter().any(is_terminal) || Instant::now() >= deadline {
            break rows;
        }
        sleep(Duration::from_millis(50)).await;
    };

    assert!(
        rows.iter()
            .any(|row| row["event_type"] == "request.started"),
        "the request ledger must carry a started row: {rows:#?}"
    );
    let terminal_rows: Vec<&Value> = rows.iter().filter(|row| is_terminal(row)).collect();
    assert_eq!(
        terminal_rows.len(),
        1,
        "the inbound codec failure must write exactly one terminal row, not zero or two: {rows:#?}"
    );
    let terminal_row = terminal_rows[0];
    assert_eq!(
        terminal_row["event_type"], "request.failed",
        "an inbound codec failure is a failed terminal, not a fabricated success"
    );
    assert_eq!(
        terminal_row["result"], "error",
        "the terminal row must record the failed result"
    );
    assert_eq!(
        terminal_row["meta"]["observed_error"]["source"], "error06_projection",
        "the Direct lane holds the typed Error06 truth and must record it"
    );
    assert!(
        !rows
            .iter()
            .any(|row| row["event_type"] == "request.completed"),
        "the inbound codec failure must not fabricate request.completed: {rows:#?}"
    );

    eprintln!(
        "[00feabc] client_status={client_status:?} body={client_body:?} rows={} terminal_rows={}",
        rows.len(),
        terminal_rows.len()
    );
    eprintln!("[00feabc] terminal_row={terminal_row}");

    handle.shutdown().await;
    let _ = peer_shutdown.send(());
    std::env::remove_var(AUTH_ENV);
    drop(home_guard);
}
