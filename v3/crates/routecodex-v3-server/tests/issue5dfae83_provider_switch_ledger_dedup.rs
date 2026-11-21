//! Public-entry black-box regression for canonical issue `5dfae83`.
//!
//! Stable test ID: `issue5dfae83_provider_switch_ledger_dedup`.
//!
//! Command:
//! `node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test issue5dfae83_provider_switch_ledger_dedup -- --nocapture`
//!
//! Real requests enter the listener. Provider `a` answers HTTP 503 and provider
//! `b` answers one of three legal business terminals: completed without a
//! finish reason, `requires_action` with a tool call, or streamed
//! `incomplete/content_filter`. Each switched request must retain exactly one
//! failed-attempt row, one switch, and one successful completion whose final
//! provider status and real finish reason replace the failed attempt metadata.
//! The same records must be visible through the Admin HTTP consumer. A final
//! request succeeds on provider `a`'s first attempt and must add no failure or
//! switch row, giving the same listener a zero-failure control.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
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

fn success_response(request: &Value) -> Value {
    match request["input"].as_str().unwrap_or_default() {
        "case:tool_calls" => json!({
            "id": "resp-5dfae83-tool-calls",
            "object": "response",
            "status": "requires_action",
            "model": "wire-b",
            "output": [{
                "id": "fc-5dfae83",
                "type": "function_call",
                "call_id": "call-5dfae83",
                "name": "SWITCHED_TOOL_CALL_OK",
                "arguments": "{}",
                "status": "completed"
            }],
            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
        }),
        _ => json!({
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
        }),
    }
}

fn content_filter_response() -> Response<Body> {
    let response = json!({
        "id": "resp-5dfae83-content-filter",
        "object": "response",
        "status": "incomplete",
        "model": "wire-b",
        "incomplete_details": {"reason": "content_filter"},
        "output": [{
            "id": "msg-5dfae83-filtered",
            "type": "message",
            "role": "assistant",
            "status": "incomplete",
            "content": [{
                "type": "output_text",
                "text": "SWITCHED_CONTENT_FILTER_OK",
                "annotations": []
            }]
        }],
        "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
    });
    let frame = format!(
        "event: response.incomplete\ndata: {}\n\n",
        json!({
            "type": "response.incomplete",
            "response": response
        })
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(frame))
        .unwrap()
}

async fn upstream(State(state): State<Arc<Upstream>>, Json(body): Json<Value>) -> Response<Body> {
    state.calls.fetch_add(1, Ordering::SeqCst);
    if state.fail.load(Ordering::SeqCst) {
        Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"message":"controlled provider failure","type":"server_error","code":"controlled_unavailable"}}"#,
            ))
            .unwrap()
    } else if body["input"].as_str() == Some("case:content_filter") {
        content_filter_response()
    } else {
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(success_response(&body).to_string()))
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
responses = {{ process = "direct", streaming = "client" }}
[providers.a.models.wire-a]
wire_name = "wire-a"
capabilities = ["text", "tools"]
supports_streaming = true
max_context_tokens = 128000

[providers.b]
type = "responses"
base_url = "http://127.0.0.1:{b_port}/v1"
default_model = "wire-b"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "client" }}
[providers.b.models.wire-b]
wire_name = "wire-b"
capabilities = ["text", "tools"]
supports_streaming = true
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

async fn get_json(client: &reqwest::Client, url: &str) -> (reqwest::StatusCode, Value) {
    let response = client.get(url).send().await.unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    let value = serde_json::from_str(&body)
        .unwrap_or_else(|error| panic!("{url} did not return JSON ({status}): {error}\n{body}"));
    (status, value)
}

fn completed_request_keys(rows: &[Value]) -> BTreeSet<String> {
    rows.iter()
        .filter(|row| row["event_type"] == "request.completed")
        .filter_map(|row| row["request_key"].as_str().map(str::to_string))
        .collect()
}

async fn wait_for_completed_count(path: &Path, expected: usize) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let rows = read_raw_rows(path);
        if completed_request_keys(&rows).len() >= expected || Instant::now() >= deadline {
            assert!(
                completed_request_keys(&rows).len() >= expected,
                "expected {expected} completed requests, got: {rows:#?}"
            );
            return rows;
        }
        sleep(Duration::from_millis(50)).await;
    }
}

fn completed_request_key_added(rows: &[Value], previous_keys: &BTreeSet<String>) -> String {
    let current = completed_request_keys(rows);
    let added: Vec<String> = current.difference(previous_keys).cloned().collect();
    assert_eq!(
        added.len(),
        1,
        "the request must add exactly one completed key, got {added:?}: {rows:#?}"
    );
    added[0].clone()
}

fn event_rows<'a>(rows: &'a [Value], request_key: &str, event_type: &str) -> Vec<&'a Value> {
    rows.iter()
        .filter(|row| row["request_key"] == request_key)
        .filter(|row| row["event_type"] == event_type)
        .collect()
}

fn sse_events(body: &str) -> Vec<Value> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|data| *data != "[DONE]")
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .collect()
}

async fn wait_for_admin_record(
    client: &reqwest::Client,
    list_url: &str,
    request_key: &str,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let (status, body) = get_json(client, list_url).await;
        assert_eq!(status, reqwest::StatusCode::OK, "records list: {body}");
        if let Some(row) = body["records"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["request_key"] == request_key))
        {
            return row.clone();
        }
        assert!(
            Instant::now() < deadline,
            "no completed record in admin list: {body}"
        );
        sleep(Duration::from_millis(50)).await;
    }
}

async fn assert_recovered_switch_ledger(
    client: &reqwest::Client,
    records_path: &Path,
    list_url: &str,
    previous_keys: &BTreeSet<String>,
    expected_response_status: &str,
    expected_finish_reason: Option<&str>,
) -> String {
    let rows = wait_for_completed_count(records_path, previous_keys.len() + 1).await;
    let request_key = completed_request_key_added(&rows, previous_keys);

    let failed_rows = event_rows(&rows, &request_key, "request.provider_attempt_failed");
    assert_eq!(
        failed_rows.len(),
        1,
        "one failed attempt must write exactly one failure row: {rows:#?}"
    );
    assert_eq!(failed_rows[0]["meta"]["provider_status"], 503);
    assert_eq!(failed_rows[0]["meta"]["provider_id"], "a");
    assert_eq!(failed_rows[0]["meta"]["provider"], "a:default:key:wire-a");
    assert_eq!(
        failed_rows[0]["meta"]["error_category"],
        "provider_http_503"
    );
    assert_eq!(
        failed_rows[0]["meta"]["error_detail"],
        "provider returned HTTP 503"
    );
    assert_eq!(
        failed_rows[0]["meta"]["observed_error"]["source"],
        "provider_attempt_failure"
    );
    assert_eq!(
        failed_rows[0]["meta"]["observed_error"]["external_error_kind"],
        "provider"
    );
    assert_eq!(
        failed_rows[0]["meta"]["observed_error"]["external_error_code"],
        "HTTP_503"
    );
    assert_eq!(
        failed_rows[0]["meta"]["observed_error"]["external_error_status"],
        503
    );

    let switch_rows = event_rows(&rows, &request_key, "request.provider_switched");
    assert_eq!(
        switch_rows.len(),
        1,
        "one switch must write exactly one switch row: {rows:#?}"
    );
    for field in [
        "provider_status",
        "error_category",
        "error_detail",
        "observed_error",
    ] {
        assert!(
            switch_rows[0]["meta"][field].is_null(),
            "the switch row must not repeat {field}: {switch_rows:?}"
        );
    }

    let completed_rows = event_rows(&rows, &request_key, "request.completed");
    assert_eq!(
        completed_rows.len(),
        1,
        "the switched request must complete exactly once"
    );
    assert_eq!(completed_rows[0]["result"], "success");
    let completed_meta = &completed_rows[0]["meta"];
    assert_eq!(completed_meta["provider_status"], 200);
    assert_eq!(completed_meta["provider_id"], "b");
    assert_eq!(completed_meta["provider"], "b:default:key:wire-b");
    assert_eq!(completed_meta["response_status"], expected_response_status);
    match expected_finish_reason {
        Some(reason) => assert_eq!(
            completed_meta["finish_reason"], reason,
            "the completed row must preserve the real final finish reason: {completed_rows:?}"
        ),
        None => assert!(
            completed_meta["finish_reason"].is_null(),
            "a completion without a final reason must not inherit the failed attempt: {completed_rows:?}"
        ),
    }
    for field in ["error_category", "error_detail", "observed_error"] {
        assert!(
            completed_meta[field].is_null(),
            "the completed row must not inherit {field}: {completed_rows:?}"
        );
    }

    let admin_row = wait_for_admin_record(client, list_url, &request_key).await;
    assert_eq!(admin_row["failed_attempts"], 1);
    assert_eq!(admin_row["meta"]["provider_status"], 200);
    assert_eq!(admin_row["meta"]["provider_id"], "b");
    assert_eq!(
        admin_row["meta"]["response_status"],
        expected_response_status
    );
    match expected_finish_reason {
        Some(reason) => assert_eq!(
            admin_row["meta"]["finish_reason"], reason,
            "admin must expose the real final finish reason: {admin_row}"
        ),
        None => assert!(
            admin_row["meta"]["finish_reason"].is_null(),
            "admin must not inherit the failed attempt finish reason: {admin_row}"
        ),
    }
    for field in ["error_category", "error_detail", "observed_error"] {
        assert!(
            admin_row["meta"][field].is_null(),
            "admin must not inherit {field}: {admin_row}"
        );
    }
    request_key
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
    let records_path = home
        .join("logs")
        .join(format!("server-v3-{server_port}.request-records.jsonl"));
    let list_url = format!("http://{admin_addr}/api/observability/records?range=all&page_size=50");
    let mut completed_keys = BTreeSet::new();
    for (input, marker, stream, expected_status, expected_finish_reason) in [
        (
            "case:missing_reason",
            "SWITCHED_BUSINESS_OK",
            false,
            "completed",
            None,
        ),
        (
            "case:tool_calls",
            "SWITCHED_TOOL_CALL_OK",
            false,
            "requires_action",
            Some("tool_calls"),
        ),
        (
            "case:content_filter",
            "SWITCHED_CONTENT_FILTER_OK",
            true,
            "incomplete",
            Some("content_filter"),
        ),
    ] {
        let response = client
            .post(format!("http://{server_addr}/v1/responses"))
            .json(&json!({
                "model": "client",
                "input": input,
                "stream": stream
            }))
            .send()
            .await
            .expect("the switched request must reach the real listener");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let client_body = response.text().await.unwrap();
        if stream {
            let events = sse_events(&client_body);
            let terminal = events
                .iter()
                .find(|event| event["type"] == "response.incomplete")
                .unwrap_or_else(|| panic!("missing SSE terminal: {client_body}"));
            assert_eq!(terminal["response"]["status"], expected_status);
            assert_eq!(
                terminal["response"]["incomplete_details"]["reason"],
                expected_finish_reason.unwrap()
            );
        } else {
            let client_json: Value = serde_json::from_str(&client_body).unwrap_or_else(|error| {
                panic!("switched response was not JSON: {error}\n{client_body}")
            });
            assert_eq!(client_json["status"], expected_status, "{client_body}");
        }
        assert!(
            client_body.contains(marker),
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
        let request_key = assert_recovered_switch_ledger(
            &client,
            &records_path,
            &list_url,
            &completed_keys,
            expected_status,
            expected_finish_reason,
        )
        .await;
        completed_keys.insert(request_key);
    }
    assert_eq!(
        a.calls.load(Ordering::SeqCst),
        3,
        "provider a must be attempted exactly once per switched request"
    );
    assert_eq!(
        b.calls.load(Ordering::SeqCst),
        3,
        "provider b must be attempted exactly once after each switch"
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
        4,
        "provider a must be attempted once per request"
    );
    assert_eq!(
        b.calls.load(Ordering::SeqCst),
        3,
        "the success control must not reach provider b"
    );

    let rows_after_control = wait_for_completed_count(&records_path, 4).await;
    let control_key = completed_request_key_added(&rows_after_control, &completed_keys);
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

    let control_row = wait_for_admin_record(&client, &list_url, &control_key).await;
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
