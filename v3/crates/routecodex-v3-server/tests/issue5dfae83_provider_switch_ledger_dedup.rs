//! Public-entry black-box regression for canonical issue `5dfae83`.
//!
//! Stable test ID: `issue5dfae83_provider_switch_ledger_dedup`.
//!
//! Command:
//! `node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test issue5dfae83_provider_switch_ledger_dedup -- --nocapture`
//!
//! A real request enters the listener. Provider `a` answers HTTP 503 and
//! provider `b` answers business 200, so the runtime records one failed
//! attempt, switches once, and completes. The raw request-records lifecycle
//! stream must contain exactly one `request.provider_attempt_failed` line; the
//! `request.provider_switched` line must not repeat the failed attempt's
//! `provider_status`, `error_category`, `error_detail`, or `observed_error`.
//! The admin HTTP surface must see the same request as one failed attempt that
//! ends completed. A second request then succeeds on provider `a`'s first
//! attempt and must add no failure or switch row and count zero failed
//! attempts, giving the dedup a same-listener success control.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::time::{sleep, Duration, Instant};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const PROVIDER_KEY_ENV: &str = "ISSUE_5DFAE83_KEY";

struct Upstream {
    calls: AtomicUsize,
    fail: AtomicBool,
}

async fn upstream(State(state): State<Arc<Upstream>>, Json(_body): Json<Value>) -> Response<Body> {
    state.calls.fetch_add(1, Ordering::SeqCst);
    if state.fail.load(Ordering::SeqCst) {
        Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"message":"controlled provider failure","type":"server_error","code":"controlled_unavailable"}}"#,
            ))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "id": "resp-5dfae83",
                    "object": "response",
                    "status": "completed",
                    "model": "wire-b",
                    "output": [{
                        "id": "msg-5dfae83",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [{
                            "type": "output_text",
                            "text": "SWITCHED_BUSINESS_OK",
                            "annotations": []
                        }]
                    }],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
                })
                .to_string(),
            ))
            .unwrap()
    }
}

async fn start_upstream(fail: bool) -> (u16, Arc<Upstream>, tokio::sync::oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Arc::new(Upstream {
        calls: AtomicUsize::new(0),
        fail: AtomicBool::new(fail),
    });
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(Arc::clone(&state));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (port, state, shutdown_tx)
}

fn temp_home() -> PathBuf {
    let dir = env::temp_dir().join(format!(
        "rcc-issue5dfae83-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn config_source(server_port: u16, admin_port: u16, a_port: u16, b_port: u16) -> String {
    format!(
        r#"
version = 3
{declaration}

[servers.main]
bind = "127.0.0.1"
port = {server_port}
routing_group = "default"
endpoints = ["responses"]
{execution}

[admin_webui]
enabled = true
bind = "127.0.0.1"
port = {admin_port}

[providers.a]
type = "responses"
base_url = "http://127.0.0.1:{a_port}/v1"
default_model = "wire-a"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "never" }}
[providers.a.models.wire-a]
wire_name = "wire-a"
capabilities = ["text", "tools"]
max_context_tokens = 128000

[providers.b]
type = "responses"
base_url = "http://127.0.0.1:{b_port}/v1"
default_model = "wire-b"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "never" }}
[providers.b.models.wire-b]
wire_name = "wire-b"
capabilities = ["text", "tools"]
max_context_tokens = 128000

[debug]
log_console = false
snapshots = false
dry_run = false

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "a", model = "wire-a", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "b", model = "wire-b", key = "key", priority = 1 }}
]
"#,
        declaration = hub_v1_fixture::hub_v1_test_declaration(),
        execution = hub_v1_fixture::hub_v1_server_execution("main"),
    )
}

fn read_raw_rows(path: &Path) -> Vec<Value> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|line| line.get("row").cloned())
        .collect()
}

fn has_terminal(rows: &[Value]) -> bool {
    rows.iter().any(|row| {
        matches!(
            row["event_type"].as_str(),
            Some("request.completed" | "request.failed" | "request.cancelled")
        )
    })
}

async fn get_json(client: &reqwest::Client, url: &str) -> (reqwest::StatusCode, Value) {
    let response = client.get(url).send().await.unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    let value = serde_json::from_str(&body)
        .unwrap_or_else(|error| panic!("{url} did not return JSON ({status}): {error}\n{body}"));
    (status, value)
}

#[tokio::test]
async fn issue5dfae83_provider_switch_ledger_dedup() {
    let _guard = TEST_LOCK.lock().await;
    env::set_var(PROVIDER_KEY_ENV, "controlled-switch-dedup-secret");
    let home = temp_home();
    let previous_home = env::var_os("HOME");
    env::set_var("HOME", &home);

    let (a_port, a, a_shutdown) = start_upstream(true).await;
    let (b_port, b, b_shutdown) = start_upstream(false).await;
    let server_port = test_ports::free_port();
    let admin_port = test_ports::free_port();
    let config_path = home.join("config.v3.toml");
    fs::write(
        &config_path,
        config_source(server_port, admin_port, a_port, b_port),
    )
    .unwrap();

    let snapshot = V3ConfigStore::new(&config_path)
        .load_snapshot_with_source_identity()
        .unwrap();
    let handle = spawn_v3_server_aggregate_with_admin(
        snapshot.manifest,
        snapshot.admin_webui,
        Some(config_path),
    )
    .await
    .unwrap();
    let server_addr = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "main")
        .expect("aggregate exposes the main listener")
        .addr;
    let admin_addr = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "admin_webui")
        .expect("aggregate exposes the admin listener")
        .addr;

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let response = client
        .post(format!("http://{server_addr}/v1/responses"))
        .json(&json!({
            "model": "client",
            "input": "controlled request",
            "stream": false
        }))
        .send()
        .await
        .expect("the switched request must reach the real listener");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let client_body = response.text().await.unwrap();
    assert!(
        client_body.contains("SWITCHED_BUSINESS_OK"),
        "the switched provider's business body must reach the client: {client_body}"
    );
    assert!(
        !client_body.contains("controlled provider failure"),
        "the failed provider's error message must not reach the client: {client_body}"
    );
    assert!(
        !client_body.contains("controlled_unavailable"),
        "the failed provider's error code must not reach the client: {client_body}"
    );
    assert_eq!(
        a.calls.load(Ordering::SeqCst),
        1,
        "provider a must be attempted exactly once"
    );
    assert_eq!(
        b.calls.load(Ordering::SeqCst),
        1,
        "provider b must be attempted exactly once after the switch"
    );

    // Public request-records store: one failed attempt, one switch, one
    // completed lifecycle line. The switch line must not repeat failure fields.
    let records_path = home
        .join("logs")
        .join(format!("server-v3-{server_port}.request-records.jsonl"));
    let deadline = Instant::now() + Duration::from_secs(20);
    let rows = loop {
        let rows = read_raw_rows(&records_path);
        if has_terminal(&rows) || Instant::now() >= deadline {
            break rows;
        }
        sleep(Duration::from_millis(50)).await;
    };
    assert!(
        !rows.is_empty(),
        "the request must leave request-records rows: {}",
        records_path.display()
    );

    let failed_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| row["event_type"] == "request.provider_attempt_failed")
        .collect();
    assert_eq!(
        failed_rows.len(),
        1,
        "one failed attempt must write exactly one failure row: {rows:#?}"
    );
    assert_eq!(
        failed_rows[0]["meta"]["provider_status"], 503,
        "the failed row must carry the real upstream status: {failed_rows:?}"
    );
    assert_eq!(
        failed_rows[0]["meta"]["provider_id"], "a",
        "the failed attempt must identify provider a: {failed_rows:?}"
    );
    assert_eq!(
        failed_rows[0]["meta"]["provider"], "a:default:key:wire-a",
        "the failed attempt must retain its exact provider identity: {failed_rows:?}"
    );
    assert_eq!(
        failed_rows[0]["meta"]["error_category"], "provider_http_503",
        "the failed row must retain its exact HTTP error category: {failed_rows:?}"
    );
    assert_eq!(
        failed_rows[0]["meta"]["error_detail"], "provider returned HTTP 503",
        "the failed row must retain its exact provider failure detail: {failed_rows:?}"
    );
    assert_eq!(
        failed_rows[0]["meta"]["observed_error"]["source"], "provider_attempt_failure",
        "the failed row must retain its typed source: {failed_rows:?}"
    );
    assert_eq!(
        failed_rows[0]["meta"]["observed_error"]["external_error_kind"], "provider",
        "the failed row must retain its typed provider error kind: {failed_rows:?}"
    );
    assert_eq!(
        failed_rows[0]["meta"]["observed_error"]["external_error_code"], "HTTP_503",
        "the failed row must retain its typed upstream error code: {failed_rows:?}"
    );
    assert_eq!(
        failed_rows[0]["meta"]["observed_error"]["external_error_status"], 503,
        "the failed row must retain its typed upstream status: {failed_rows:?}"
    );
    let first_request_key = failed_rows[0]["request_key"]
        .as_str()
        .expect("the failed row carries a request_key")
        .to_string();

    let switch_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| row["event_type"] == "request.provider_switched")
        .collect();
    assert_eq!(
        switch_rows.len(),
        1,
        "one switch must write exactly one switch row: {rows:#?}"
    );
    assert!(
        switch_rows[0]["meta"]["provider_status"].is_null(),
        "the switch row must not repeat provider_status: {switch_rows:?}"
    );
    assert!(
        switch_rows[0]["meta"]["error_category"].is_null(),
        "the switch row must not repeat error_category"
    );
    assert!(
        switch_rows[0]["meta"]["error_detail"].is_null(),
        "the switch row must not repeat error_detail"
    );
    assert!(
        switch_rows[0]["meta"]["observed_error"].is_null(),
        "the switch row must not repeat observed_error"
    );

    let completed_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| row["event_type"] == "request.completed")
        .collect();
    assert_eq!(
        completed_rows.len(),
        1,
        "the switched request must complete exactly once"
    );
    assert_eq!(
        completed_rows[0]["result"], "success",
        "the switched request must complete successfully: {completed_rows:?}"
    );
    let completed_meta = &completed_rows[0]["meta"];
    assert_eq!(
        completed_meta["provider_status"], 200,
        "the completed row must carry the final provider status: {completed_rows:?}"
    );
    assert_eq!(
        completed_meta["response_status"], "completed",
        "the completed row must carry the final response status: {completed_rows:?}"
    );
    assert!(
        completed_meta["finish_reason"].is_null(),
        "a Responses completion without a protocol finish reason must not inherit the prior attempt error: {completed_rows:?}"
    );
    assert!(
        completed_meta["error_category"].is_null(),
        "the completed row must not inherit the prior attempt error category: {completed_rows:?}"
    );
    assert!(
        completed_meta["error_detail"].is_null(),
        "the completed row must not inherit the prior attempt error detail: {completed_rows:?}"
    );
    assert!(
        completed_meta["observed_error"].is_null(),
        "the completed row must not inherit the prior attempt observation: {completed_rows:?}"
    );

    // Admin HTTP surface: the same request is one failed attempt that ends
    // completed. This is the public consumer comparison the handoff requires.
    let list_url = format!("http://{admin_addr}/api/observability/records?range=all&page_size=50");
    let admin_deadline = Instant::now() + Duration::from_secs(20);
    let row = loop {
        let (status, body) = get_json(&client, &list_url).await;
        assert_eq!(status, reqwest::StatusCode::OK, "records list: {body}");
        if let Some(row) = body["records"].as_array().and_then(|rows| {
            rows.iter()
                .find(|row| row["request_key"] == first_request_key.as_str())
        }) {
            break row.clone();
        }
        assert!(
            Instant::now() < admin_deadline,
            "no completed record in admin list: {body}"
        );
        sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(
        row["failed_attempts"], 1,
        "admin consumption must count one failed attempt: {row}"
    );
    assert_eq!(
        row["meta"]["provider_status"], 200,
        "admin must expose the final provider status: {row}"
    );
    assert_eq!(
        row["meta"]["response_status"], "completed",
        "admin must expose the final response status: {row}"
    );
    assert!(
        row["meta"]["finish_reason"].is_null(),
        "admin must not inherit the failed attempt finish reason: {row}"
    );
    assert!(
        row["meta"]["error_category"].is_null(),
        "admin must not inherit the failed attempt category: {row}"
    );
    assert!(
        row["meta"]["error_detail"].is_null(),
        "admin must not inherit the failed attempt detail: {row}"
    );
    assert!(
        row["meta"]["observed_error"].is_null(),
        "admin must not inherit the failed attempt observation: {row}"
    );

    // Success control: the second request succeeds on provider a's first
    // attempt. It must add no failure or switch row, and the admin consumer
    // must count zero failed attempts for it.
    a.fail.store(false, Ordering::SeqCst);
    let control_response = client
        .post(format!("http://{server_addr}/v1/responses"))
        .json(&json!({
            "model": "client",
            "input": "success control request",
            "stream": false
        }))
        .send()
        .await
        .expect("the success control request must reach the real listener");
    assert_eq!(control_response.status(), reqwest::StatusCode::OK);
    let control_body = control_response.text().await.unwrap();
    assert!(
        control_body.contains("SWITCHED_BUSINESS_OK"),
        "the control provider's business body must reach the client: {control_body}"
    );
    assert_eq!(
        a.calls.load(Ordering::SeqCst),
        2,
        "provider a must be attempted once per request"
    );
    assert_eq!(
        b.calls.load(Ordering::SeqCst),
        1,
        "the success control must not reach provider b"
    );

    let control_deadline = Instant::now() + Duration::from_secs(20);
    let rows_after_control = loop {
        let rows = read_raw_rows(&records_path);
        let completed = rows
            .iter()
            .filter(|row| row["event_type"] == "request.completed")
            .count();
        if completed >= 2 || Instant::now() >= control_deadline {
            break rows;
        }
        sleep(Duration::from_millis(50)).await;
    };
    let mut request_keys: Vec<String> = rows_after_control
        .iter()
        .filter_map(|row| row["request_key"].as_str().map(str::to_string))
        .collect();
    request_keys.sort();
    request_keys.dedup();
    assert_eq!(
        request_keys.len(),
        2,
        "the listener must record exactly two independent requests: {rows_after_control:#?}"
    );
    let control_key = request_keys
        .iter()
        .find(|key| **key != first_request_key)
        .expect("the control request has its own request_key")
        .clone();
    let control_rows: Vec<&Value> = rows_after_control
        .iter()
        .filter(|row| row["request_key"] == control_key.as_str())
        .collect();
    assert!(
        control_rows
            .iter()
            .all(|row| row["event_type"] != "request.provider_attempt_failed"),
        "a first-attempt success must not write a failure row: {control_rows:#?}"
    );
    assert!(
        control_rows
            .iter()
            .all(|row| row["event_type"] != "request.provider_switched"),
        "a first-attempt success must not write a switch row: {control_rows:#?}"
    );
    assert_eq!(
        control_rows
            .iter()
            .filter(|row| row["event_type"] == "request.completed")
            .count(),
        1,
        "the success control must complete exactly once"
    );

    let control_admin_deadline = Instant::now() + Duration::from_secs(20);
    let control_row = loop {
        let (status, body) = get_json(&client, &list_url).await;
        assert_eq!(status, reqwest::StatusCode::OK, "records list: {body}");
        if let Some(row) = body["records"].as_array().and_then(|records| {
            records
                .iter()
                .find(|row| row["request_key"] == control_key.as_str())
        }) {
            break row.clone();
        }
        assert!(
            Instant::now() < control_admin_deadline,
            "no success-control record in admin list: {body}"
        );
        sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(
        control_row["failed_attempts"], 0,
        "admin consumption must count zero failed attempts for a first-attempt success: {control_row}"
    );

    let _samples_cleanup = fs::remove_dir_all(&home);
    if let Some(previous_home) = previous_home {
        env::set_var("HOME", previous_home);
    } else {
        env::remove_var("HOME");
    }
    let _ = a_shutdown.send(());
    let _ = b_shutdown.send(());
    handle.shutdown().await;
}
