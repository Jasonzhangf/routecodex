//! Public-entry black-box regression for canonical issue `6a2766a`.
//!
//! Stable test IDs:
//! - `issue6a2766a_single_candidate_provider_error_passes_through`
//! - `issue6a2766a_multi_candidate_provider_error_not_projected`
//!
//! Command:
//! `node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test issue6a2766a_direct_provider_terminal_record -- --nocapture`
//!
//! The incident family (`/Volumes/Intel/playground/routecodex/.worker-runs/`
//! `patrol-400-502-latest-20261022-r1/incidents.tsv`, 18 rows) is a Responses
//! Direct request whose only candidate is `inxk:default:key1:deepseek-v4-pro`
//! and whose provider answers HTTP 400. The ledger kept the
//! `provider_attempt_failure` row (`action=terminal_default_floor_exhausted`,
//! `health_state=last_candidate_terminal`) but never wrote a terminal
//! `request.failed` row.
//!
//! The now-effective `routecodex-last-provider-failure-terminal-policy`
//! requirement retires the old single-candidate assertion: a sole or last
//! eligible candidate keeps its real typed Error, and its real provider
//! status/body passes through to the client with only the necessary protocol
//! conversion. This file proves both sides of that contract:
//! - single candidate: the provider HTTP 400 and its body reach the client
//!   unchanged, and exactly one terminal `request.failed` row is persisted;
//! - multi candidate: the failed candidate's provider error stays
//!   provider-private while a healthy sibling completes the client request.

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
const HEALTHY_MODEL: &str = "healthy-v1";
const PROVIDER_400_BODY: &str =
    r#"{"error":{"type":"provider_terminal_body","message":"controlled upstream 400 body"}}"#;
const HEALTHY_TEXT: &str = "multi-candidate healthy result";

struct ProviderCallCount(AtomicU64);

/// The controlled failing provider answers HTTP 400 with a real body. That is
/// the incident's provider failure shape; the fixture does not model its root
/// cause, which the issue leaves UNVERIFIED.
async fn terminal_400_upstream(State(calls): State<Arc<ProviderCallCount>>) -> Response<Body> {
    calls.0.fetch_add(1, Ordering::SeqCst);
    Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .header("content-type", "application/json")
        .body(Body::from(PROVIDER_400_BODY))
        .unwrap()
}

/// A healthy sibling candidate. The multi-candidate negative control proves the
/// request completes on this candidate instead of projecting the failed
/// candidate's provider error to the client.
async fn healthy_upstream(State(calls): State<Arc<ProviderCallCount>>) -> Response<Body> {
    calls.0.fetch_add(1, Ordering::SeqCst);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(format!(
            concat!(
                r#"{{"id":"resp_6a2766a_healthy","object":"response","status":"completed","#,
                r#""model":"{model}","output_text":"{text}","output":["#,
                r#"{{"id":"msg_6a2766a","type":"message","role":"assistant","#,
                r#""status":"completed","content":[{{"type":"output_text","text":"{text}","#,
                r#""annotations":[]}}]}}],"#,
                r#""usage":{{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}}"#,
            ),
            model = HEALTHY_MODEL,
            text = HEALTHY_TEXT,
        )))
        .unwrap()
}

/// Start one controlled provider on an ephemeral port. The caller owns the
/// returned shutdown sender; the server task ends when it fires.
async fn start_upstream(app: Router) -> (u16, tokio::sync::oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (port, shutdown_tx)
}

fn manifest(
    server_port: u16,
    primary_port: u16,
    healthy_port: Option<u16>,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    // Only the multi-candidate negative control adds a second, healthy provider.
    // It sits behind the failing candidate in priority order so the request must
    // fail over to it.
    let (healthy_provider, healthy_target) = match healthy_port {
        Some(port) => (
            format!(
                r#"
[providers.healthy]
type = "responses"
base_url = "http://127.0.0.1:{port}/v1"
default_model = "{model}"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "{auth_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "never" }}

[providers.healthy.models.{model}]
wire_name = "{model}"
capabilities = ["text"]
max_context_tokens = 128000
"#,
                port = port,
                model = HEALTHY_MODEL,
                auth_env = AUTH_ENV,
            ),
            format!(
                r#", {{ kind = "provider_model", provider = "healthy", model = "{model}", key = "key1", priority = 1 }}"#,
                model = HEALTHY_MODEL,
            ),
        ),
        None => (String::new(), String::new()),
    };
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
base_url = "http://127.0.0.1:{primary_port}/v1"
default_model = "{client_model}"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "{auth_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "never" }}

[providers.inxk.models.{client_model}]
wire_name = "{client_model}"
capabilities = ["text"]
max_context_tokens = 128000
{healthy_provider}
[debug]
log_console = false
snapshots = false

[route_groups.owned.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "inxk", model = "{client_model}", key = "key1", priority = 2 }}{healthy_target}]
"#,
        declaration = declaration,
        server_port = server_port,
        primary_port = primary_port,
        client_model = CLIENT_MODEL,
        auth_env = AUTH_ENV,
        healthy_provider = healthy_provider,
        healthy_target = healthy_target,
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

/// Read the request ledger until a terminal row lands, or give up after the
/// bounded wait. The caller asserts what must be present.
async fn wait_for_terminal_rows(path: &std::path::Path) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let rows = read_rows(path);
        if rows.iter().any(is_terminal) || Instant::now() >= deadline {
            return rows;
        }
        sleep(Duration::from_millis(50)).await;
    }
}

/// Split the client outcome into (status, body). A transport error has no status.
async fn client_outcome(
    response: Result<reqwest::Response, reqwest::Error>,
) -> (Option<reqwest::StatusCode>, String) {
    match response {
        Err(_) => (None, String::new()),
        Ok(response) => {
            let status = Some(response.status());
            match response.bytes().await {
                Ok(bytes) => (status, String::from_utf8_lossy(&bytes).into_owned()),
                Err(_) => (status, String::new()),
            }
        }
    }
}

#[tokio::test]
async fn issue6a2766a_single_candidate_provider_error_passes_through() {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    std::env::set_var(AUTH_ENV, "owned-fixture-secret");

    let calls = Arc::new(ProviderCallCount(AtomicU64::new(0)));
    let upstream = Router::new()
        .route("/v1/responses", post(terminal_400_upstream))
        .with_state(Arc::clone(&calls));
    let (primary_port, primary_shutdown) = start_upstream(upstream).await;
    let server_port = test_ports::free_port();
    let handle = spawn_v3_server_aggregate(manifest(server_port, primary_port, None))
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
            "input": "inxk 400 single-candidate passthrough regression",
            "stream": false
        }))
        .send()
        .await;
    let (client_status, client_body) = client_outcome(response).await;

    // The sole candidate is contacted exactly once, and its real provider status
    // and body pass through unchanged. This is the last-eligible passthrough that
    // the retired assertion used to reject.
    assert_eq!(
        calls.0.load(Ordering::SeqCst),
        1,
        "the sole candidate must be attempted exactly once"
    );
    assert_eq!(
        client_status,
        Some(reqwest::StatusCode::BAD_REQUEST),
        "the sole candidate's real provider HTTP 400 must pass through: {client_body:?}"
    );
    assert_eq!(
        client_body, PROVIDER_400_BODY,
        "the real provider body must reach the client unchanged"
    );

    let records_path = request_records_path(&home, server_port);
    let rows = wait_for_terminal_rows(&records_path).await;

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
        "[issue6a2766a] single-candidate event_types={:?}",
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
        "[issue6a2766a] single-candidate status={client_status:?} body={client_body:?} rows={} terminal_rows={}",
        rows.len(),
        terminal_rows.len()
    );
    eprintln!("[issue6a2766a] single-candidate terminal_row={terminal_row}");

    handle.shutdown().await;
    let _ = primary_shutdown.send(());
    std::env::remove_var(AUTH_ENV);
    drop(home_guard);
}

#[tokio::test]
async fn issue6a2766a_multi_candidate_provider_error_not_projected() {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    std::env::set_var(AUTH_ENV, "owned-fixture-secret");

    let failing_calls = Arc::new(ProviderCallCount(AtomicU64::new(0)));
    let failing_upstream = Router::new()
        .route("/v1/responses", post(terminal_400_upstream))
        .with_state(Arc::clone(&failing_calls));
    let (failing_port, failing_shutdown) = start_upstream(failing_upstream).await;

    let healthy_calls = Arc::new(ProviderCallCount(AtomicU64::new(0)));
    let healthy_route = Router::new()
        .route("/v1/responses", post(healthy_upstream))
        .with_state(Arc::clone(&healthy_calls));
    let (healthy_port, healthy_shutdown) = start_upstream(healthy_route).await;

    let server_port = test_ports::free_port();
    let handle = spawn_v3_server_aggregate(manifest(server_port, failing_port, Some(healthy_port)))
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
            "input": "inxk 400 multi-candidate failover regression",
            "stream": false
        }))
        .send()
        .await;
    let (client_status, client_body) = client_outcome(response).await;

    // Negative control: the failed candidate's provider error must never reach
    // the client while a healthy sibling is still eligible.
    eprintln!(
        "[issue6a2766a] multi-candidate attempts failing={} healthy={} status={client_status:?}",
        failing_calls.0.load(Ordering::SeqCst),
        healthy_calls.0.load(Ordering::SeqCst)
    );
    // The negative control is the client projection, not a per-candidate call
    // count: selecting a later candidate also submits the branch's detached
    // rescue round, so a failed identity can legitimately be attempted again.
    assert!(
        failing_calls.0.load(Ordering::SeqCst) >= 1,
        "the failing candidate must be attempted at least once"
    );
    assert!(
        healthy_calls.0.load(Ordering::SeqCst) >= 1,
        "the healthy sibling must serve the request at least once"
    );
    assert_eq!(
        client_status,
        Some(reqwest::StatusCode::OK),
        "a healthy sibling must complete the request: {client_body:?}"
    );
    assert!(
        client_body.contains(HEALTHY_TEXT),
        "the healthy candidate's business result must reach the client: {client_body:?}"
    );
    assert!(
        !client_body.contains("provider_terminal_body"),
        "the failed candidate's provider error must stay provider-private: {client_body:?}"
    );

    let records_path = request_records_path(&home, server_port);
    let rows = wait_for_terminal_rows(&records_path).await;
    assert!(
        !rows.is_empty(),
        "the request must leave at least one ledger row: {}",
        records_path.display()
    );
    eprintln!(
        "[issue6a2766a] multi-candidate event_types={:?}",
        rows.iter()
            .map(|row| row["event_type"].as_str().unwrap_or("?"))
            .collect::<Vec<_>>()
    );
    assert!(
        rows.iter().any(|row| {
            row["event_type"] == "request.provider_attempt_failed"
                && row["meta"]["observed_error"]["action"] == "switch_provider"
                && row["meta"]["observed_error"]["external_error_status"] == 400
        }),
        "the failed attempt must keep the real provider 400 internally: {rows:#?}"
    );

    let terminal_rows: Vec<&Value> = rows.iter().filter(|row| is_terminal(row)).collect();
    assert_eq!(
        terminal_rows.len(),
        1,
        "the recovered request must write exactly one terminal row: {rows:#?}"
    );
    assert_eq!(
        terminal_rows[0]["event_type"], "request.completed",
        "the recovered request is a completed terminal, not a provider failure"
    );
    assert_eq!(
        terminal_rows[0]["result"], "success",
        "the completed terminal must record the successful result"
    );
    assert!(
        !rows.iter().any(|row| row["event_type"] == "request.failed"),
        "a recovered request must not record a failed terminal: {rows:#?}"
    );

    eprintln!(
        "[issue6a2766a] multi-candidate status={client_status:?} body={client_body:?} rows={} terminal_rows={}",
        rows.len(),
        terminal_rows.len()
    );

    handle.shutdown().await;
    let _ = failing_shutdown.send(());
    let _ = healthy_shutdown.send(());
    std::env::remove_var(AUTH_ENV);
    drop(home_guard);
}
