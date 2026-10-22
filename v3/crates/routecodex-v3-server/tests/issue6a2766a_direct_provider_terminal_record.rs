//! Public-entry black-box regression for canonical issue `6a2766a`.
//!
//! Stable test ID: `issue6a2766a_direct_provider_terminal_record_written_once`.
//!
//! Command:
//! `node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test issue6a2766a_direct_provider_terminal_record -- --nocapture`
//!
//! The incident family (`/Volumes/Intel/playground/routecodex/.worker-runs/`
//! `patrol-400-502-latest-20261022-r1/incidents.tsv`, 18 rows) is a Responses
//! Direct request whose only candidate is `inxk:default:key1:deepseek-v4-pro`
//! and whose provider answers HTTP 400 with an empty body. The ledger kept the
//! `provider_attempt_failure` row (`action=terminal_default_floor_exhausted`,
//! `health_state=last_candidate_terminal`) but never wrote a terminal
//! `request.failed` row.
//!
//! This fixture reproduces the same public entry with a controlled provider
//! that always answers HTTP 400 with an empty body. It asserts:
//! - the provider attempt row carries the incident signature;
//! - exactly one terminal row (`request.failed`) is persisted;
//! - the client observes a transport break, not a fabricated provider HTTP
//!   status, error payload, or success.

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

const AUTH_ENV: &str = "ISSUE_6A2766A_INXK_KEY";
const CLIENT_MODEL: &str = "deepseek-v4-pro";

struct ProviderCallCount(AtomicU64);

/// The controlled provider always answers HTTP 400 with an empty body. That is
/// the incident's provider response shape; the fixture does not model its root
/// cause, which the issue leaves UNVERIFIED.
async fn empty_400_upstream(State(calls): State<Arc<ProviderCallCount>>) -> Response<Body> {
    calls.0.fetch_add(1, Ordering::SeqCst);
    Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .body(Body::empty())
        .unwrap()
}

async fn start_empty_400_upstream() -> (
    u16,
    Arc<ProviderCallCount>,
    tokio::sync::oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(ProviderCallCount(AtomicU64::new(0)));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(empty_400_upstream))
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
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let source = format!(
        r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {server_port}
routing_group = "owned"
endpoints = ["responses"]

[servers.owned.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]

[providers.inxk]
type = "responses"
base_url = "http://127.0.0.1:{peer_port}/v1"
default_model = "{client_model}"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "{auth_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "never" }}

[providers.inxk.models.{client_model}]
wire_name = "{client_model}"
capabilities = ["text"]
max_context_tokens = 128000

[debug]
log_console = false
snapshots = false

[route_groups.owned.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "inxk", model = "{client_model}", key = "key1", priority = 1 }}]
"#,
        declaration = declaration,
        server_port = server_port,
        peer_port = peer_port,
        client_model = CLIENT_MODEL,
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
async fn issue6a2766a_direct_provider_terminal_record_written_once() {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    std::env::set_var(AUTH_ENV, "owned-fixture-secret");

    let (peer_port, calls, peer_shutdown) = start_empty_400_upstream().await;
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
    let response = client
        .post(format!("http://{listener_addr}/v1/responses"))
        .json(&json!({
            "model": CLIENT_MODEL,
            "input": "inxk 400 empty-body terminal-row regression",
            "stream": false
        }))
        .send()
        .await;

    // The provider is contacted exactly once and the client boundary must not
    // fabricate a provider HTTP status, an error payload, or a success.
    assert_eq!(
        calls.0.load(Ordering::SeqCst),
        1,
        "the sole candidate must be attempted exactly once"
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
        Some(reqwest::StatusCode::BAD_REQUEST),
        "a provider HTTP 400 must never be projected as the client status"
    );
    assert!(
        !client_body.contains("\"error\"") && !client_body.contains("400"),
        "the provider error payload must not reach the client: {client_body:?}"
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
        !rows.is_empty(),
        "the request must leave at least one ledger row: {}",
        records_path.display()
    );
    let attempt_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| row["event_type"] == "request.provider_attempt_failed")
        .collect();
    eprintln!(
        "[issue6a2766a] event_types={:?}",
        rows.iter()
            .map(|row| row["event_type"].as_str().unwrap_or("?"))
            .collect::<Vec<_>>()
    );
    assert!(
        attempt_rows.iter().any(|row| {
            row["meta"]["observed_error"]["action"] == "terminal_default_floor_exhausted"
                && row["meta"]["observed_error"]["health_state"] == "last_candidate_terminal"
        }),
        "the exhausted floor must keep the incident attempt signature: {rows:#?}"
    );

    let terminal_rows: Vec<&Value> = rows.iter().filter(|row| is_terminal(row)).collect();
    assert_eq!(
        terminal_rows.len(),
        1,
        "the exhausted floor must write exactly one terminal row, not zero or two: {rows:#?}"
    );
    let terminal_row = terminal_rows[0];
    assert_eq!(
        terminal_row["event_type"], "request.failed",
        "a provider exhaustion is a failed terminal, not a fabricated success"
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
        "the exhausted floor must not fabricate request.completed: {rows:#?}"
    );

    eprintln!(
        "[issue6a2766a] client_status={client_status:?} body={client_body:?} rows={} terminal_rows={}",
        rows.len(),
        terminal_rows.len()
    );
    eprintln!("[issue6a2766a] terminal_row={terminal_row}");

    handle.shutdown().await;
    let _ = peer_shutdown.send(());
    std::env::remove_var(AUTH_ENV);
    drop(home_guard);
}
