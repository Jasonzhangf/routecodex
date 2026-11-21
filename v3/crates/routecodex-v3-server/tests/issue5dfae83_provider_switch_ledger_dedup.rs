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
//! The SSE case stalls provider `a` before headers with live logging enabled.
//! The admin HTTP surface must see the same request as one failed attempt that
//! ends completed. A second request then succeeds on provider `a`'s first
//! attempt and must add no failure or switch row and count zero failed
//! attempts, giving the dedup a same-listener success control.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use futures_util::FutureExt;
use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::{spawn_v3_server_aggregate_with_admin, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{
    env,
    ffi::OsString,
    fs,
    net::{SocketAddr, TcpListener as StdTcpListener},
    panic::{self, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::{
    task::JoinHandle,
    time::{sleep, Duration, Instant},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const PROVIDER_KEY_ENV: &str = "ISSUE_5DFAE83_KEY";

struct Upstream {
    calls: AtomicUsize,
    fail: AtomicBool,
    stall_before_error: bool,
    default_usage: Value,
    usage_rules: Vec<(String, Value)>,
}

async fn upstream(State(state): State<Arc<Upstream>>, Json(body): Json<Value>) -> Response<Body> {
    state.calls.fetch_add(1, Ordering::SeqCst);
    if state.fail.load(Ordering::SeqCst) {
        if state.stall_before_error {
            sleep(Duration::from_secs(1)).await;
        }
        Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"message":"controlled provider failure","type":"server_error","code":"controlled_unavailable"}}"#,
            ))
            .unwrap()
    } else {
        let input = body["input"].as_str().unwrap_or_default();
        let usage = state
            .usage_rules
            .iter()
            .find(|(marker, _)| input.contains(marker))
            .map(|(_, usage)| usage.clone())
            .unwrap_or_else(|| state.default_usage.clone());
        let completed = json!({
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
                    "usage": usage
        });
        let (content_type, body) = if body["stream"] == true {
            let frame = json!({"type": "response.completed", "response": completed});
            (
                "text/event-stream",
                format!("event: response.completed\ndata: {frame}\n\n"),
            )
        } else {
            ("application/json", completed.to_string())
        };
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", content_type)
            .body(Body::from(body))
            .unwrap()
    }
}

async fn start_upstream(
    fail: bool,
    stall_before_error: bool,
) -> (
    u16,
    Arc<Upstream>,
    tokio::sync::oneshot::Sender<()>,
    JoinHandle<()>,
) {
    start_upstream_with_usage(
        fail,
        stall_before_error,
        json!({"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}),
        Vec::new(),
    )
    .await
}

async fn start_upstream_with_usage(
    fail: bool,
    stall_before_error: bool,
    default_usage: Value,
    usage_rules: Vec<(String, Value)>,
) -> (
    u16,
    Arc<Upstream>,
    tokio::sync::oneshot::Sender<()>,
    JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Arc::new(Upstream {
        calls: AtomicUsize::new(0),
        fail: AtomicBool::new(fail),
        stall_before_error,
        default_usage,
        usage_rules,
    });
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(Arc::clone(&state));
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (port, state, shutdown_tx, task)
}

struct EnvironmentVarGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvironmentVarGuard {
    fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let previous = env::var_os(key);
        env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvironmentVarGuard {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.take() {
            env::set_var(self.key, previous);
        } else {
            env::remove_var(self.key);
        }
    }
}

struct TestHome {
    path: PathBuf,
    removed: Arc<AtomicBool>,
    _home_env: EnvironmentVarGuard,
}

impl TestHome {
    fn new(prefix: &str) -> Self {
        let path = env::temp_dir().join(format!(
            "rcc-{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self {
            path: path.clone(),
            removed: Arc::new(AtomicBool::new(false)),
            _home_env: EnvironmentVarGuard::set("HOME", path),
        }
    }

    fn removal_receipt(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.removed)
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        self.removed
            .store(fs::remove_dir_all(&self.path).is_ok(), Ordering::SeqCst);
    }
}

fn config_source(
    home: &Path,
    server_port: u16,
    admin_port: u16,
    a_port: u16,
    b_port: u16,
    stream: bool,
) -> String {
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
sse_first_frame_timeout_ms = 200
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = {stream}, failure_threshold = 10, cooldown_ms = 3600000 }}
responses = {{ process = "direct", streaming = "{streaming}" }}
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
responses = {{ process = "direct", streaming = "{streaming}" }}
[providers.b.models.wire-b]
wire_name = "wire-b"
capabilities = ["text", "tools"]
max_context_tokens = 128000

[debug]
log_console = true
log_file = {log_file:?}
snapshots = false
dry_run = false

[route_groups.default.pools.thinking]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, required_capabilities = ["thinking"] }}
targets = [
  {{ kind = "provider_model", provider = "a", model = "wire-a", key = "key", priority = 1 }}
]

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "a", model = "wire-a", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "b", model = "wire-b", key = "key", priority = 1 }}
]
"#,
        declaration = hub_v1_fixture::hub_v1_test_declaration(),
        execution = hub_v1_fixture::hub_v1_server_execution("main"),
        streaming = if stream { "always" } else { "never" },
        log_file = home
            .join("logs")
            .join(format!("server-v3-{server_port}.log"))
            .display()
            .to_string(),
    )
}

fn two_listener_config_source(
    home: &Path,
    primary_port: u16,
    control_port: u16,
    admin_port: u16,
    a_port: u16,
    b_port: u16,
) -> String {
    format!(
        r#"
version = 3
{declaration}

[servers.primary]
bind = "127.0.0.1"
port = {primary_port}
routing_group = "primary"
endpoints = ["responses"]
{primary_execution}

[servers.control]
bind = "127.0.0.1"
port = {control_port}
routing_group = "control"
endpoints = ["responses"]
{control_execution}

[admin_webui]
enabled = true
bind = "127.0.0.1"
port = {admin_port}

[providers.a]
type = "responses"
base_url = "http://127.0.0.1:{a_port}/v1"
default_model = "wire-a"
sse_first_frame_timeout_ms = 200
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 10, cooldown_ms = 3600000 }}
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
log_console = true
log_file = {log_file:?}
snapshots = false
dry_run = false

[route_groups.primary.pools.thinking]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, required_capabilities = ["thinking"] }}
targets = [
  {{ kind = "provider_model", provider = "a", model = "wire-a", key = "key", priority = 1 }}
]

[route_groups.primary.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "a", model = "wire-a", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "b", model = "wire-b", key = "key", priority = 1 }}
]

[route_groups.control.pools.thinking]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, required_capabilities = ["thinking"] }}
targets = [
  {{ kind = "provider_model", provider = "b", model = "wire-b", key = "key", priority = 1 }}
]

[route_groups.control.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "b", model = "wire-b", key = "key", priority = 1 }}
]
"#,
        declaration = hub_v1_fixture::hub_v1_test_declaration(),
        primary_execution = hub_v1_fixture::hub_v1_server_execution("primary"),
        control_execution = hub_v1_fixture::hub_v1_server_execution("control"),
        log_file = home
            .join("logs")
            .join("server-v3-two-listener.log")
            .display()
            .to_string(),
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
    assert_provider_switch_ledger_dedup(false).await;
}

#[tokio::test]
async fn issue5dfae83_provider_switch_ledger_dedup_sse() {
    assert_provider_switch_ledger_dedup(true).await;
}

async fn assert_provider_switch_ledger_dedup(stream: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _provider_key =
        EnvironmentVarGuard::set(PROVIDER_KEY_ENV, "controlled-switch-dedup-secret");
    let home = TestHome::new("issue5dfae83-switch");

    let (a_port, a, a_shutdown, a_task) = start_upstream(true, stream).await;
    let (b_port, b, b_shutdown, b_task) = start_upstream(false, false).await;
    let server_port = test_ports::free_port();
    let admin_port = test_ports::free_port();
    let config_path = home.path.join("config.v3.toml");
    fs::write(
        &config_path,
        config_source(&home.path, server_port, admin_port, a_port, b_port, stream),
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
            "stream": stream
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
    if stream {
        assert!(
            client_body
                .lines()
                .filter_map(|line| line.strip_prefix("data: "))
                .filter_map(|body| serde_json::from_str::<Value>(body).ok())
                .filter(|frame| frame["type"] == "response.completed")
                .count()
                == 1,
            "the recovered SSE request must deliver its completed terminal: {client_body}"
        );
    }
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
        .path
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
        "one failed attempt must write exactly one failure row"
    );
    assert_eq!(
        failed_rows[0]["meta"]["provider_id"], "a",
        "the failure must belong to the failed provider"
    );
    let meta = &failed_rows[0]["meta"];
    assert_eq!(meta["pool"], "thinking");
    if stream {
        assert!(meta["provider_status"].is_null());
        assert_eq!(meta["error_category"], "provider_response_header_timeout");
        assert_eq!(meta["observed_error"]["external_error_kind"], "transport");
    } else {
        assert_eq!(meta["provider_status"], 503);
        assert_eq!(meta["error_category"], "provider_http_503");
    }
    assert!(
        failed_rows[0]["meta"]["error_detail"].is_string(),
        "the failed row must carry the error detail"
    );
    assert!(
        failed_rows[0]["meta"]["observed_error"].is_object(),
        "the failed row must carry the typed observed error"
    );

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
        rows.iter()
            .filter(|row| row["event_type"] == "request.started")
            .count(),
        1,
        "the request starts once across live observation and closeout"
    );
    let console_log = fs::read_to_string(
        home.path
            .join("logs")
            .join(format!("server-v3-{server_port}.log")),
    )
    .unwrap();
    assert_eq!(console_log.matches("[provider-error]").count(), 1);

    // Admin HTTP surface: the same request is one failed attempt that ends
    // completed. This is the public consumer comparison the handoff requires.
    let list_url = format!("http://{admin_addr}/api/observability/records?range=all&page_size=50");
    let admin_deadline = Instant::now() + Duration::from_secs(20);
    let row = loop {
        let (status, body) = get_json(&client, &list_url).await;
        assert_eq!(status, reqwest::StatusCode::OK, "records list: {body}");
        if let Some(row) = body["records"].as_array().and_then(|rows| {
            rows.iter()
                .find(|row| row["result"] == "success" || row["status"] == "completed")
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
    assert_eq!(row["request_key"], failed_rows[0]["request_key"]);
    assert_eq!(row["switches"], 1);
    assert_eq!(row["meta"]["pool"], "default");

    // The independent success control must add no failure or switch row.
    // JSON can directly reuse A. The timeout case may select either live key
    // while the observation probe is pending.
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
    let a_calls = a.calls.load(Ordering::SeqCst);
    let b_calls = b.calls.load(Ordering::SeqCst);
    assert_eq!(a_calls + b_calls, 3, "the control adds exactly one send");
    if !stream {
        assert_eq!(a_calls, 2, "an independent JSON request may use A again");
    }

    let first_request_key = failed_rows[0]["request_key"]
        .as_str()
        .expect("the failed row carries a request_key")
        .to_string();
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

    handle.shutdown().await;
    let _ = a_shutdown.send(());
    let _ = b_shutdown.send(());
    a_task.await.unwrap();
    b_task.await.unwrap();
}

struct PublicUsageFixture {
    config_path: PathBuf,
    primary_port: u16,
    control_port: u16,
    admin_port: u16,
    handle: Option<V3ServerAggregateHandle>,
}

impl PublicUsageFixture {
    async fn start(
        config_path: PathBuf,
        primary_port: u16,
        control_port: u16,
        admin_port: u16,
    ) -> Self {
        let handle =
            spawn_isolated_aggregate(&config_path, &[primary_port, control_port], admin_port).await;
        Self {
            config_path,
            primary_port,
            control_port,
            admin_port,
            handle: Some(handle),
        }
    }

    fn server_addr(&self, server_id: &str) -> SocketAddr {
        self.handle
            .as_ref()
            .expect("public usage fixture has an aggregate")
            .listeners
            .iter()
            .find(|listener| listener.server_id == server_id)
            .unwrap_or_else(|| panic!("aggregate exposes listener {server_id}"))
            .addr
    }

    fn admin_addr(&self) -> SocketAddr {
        self.server_addr("admin_webui")
    }

    async fn shutdown_aggregate(&mut self) -> bool {
        if let Some(handle) = self.handle.take() {
            handle.shutdown().await;
        }
        wait_for_ports_released(&[self.primary_port, self.control_port, self.admin_port]).await
    }

    async fn restart_same_config(&mut self) {
        assert!(
            self.shutdown_aggregate().await,
            "aggregate shutdown must release all isolated listener ports"
        );
        self.handle = Some(
            spawn_isolated_aggregate(
                &self.config_path,
                &[self.primary_port, self.control_port],
                self.admin_port,
            )
            .await,
        );
    }
}

async fn spawn_isolated_aggregate(
    config_path: &Path,
    expected_business_ports: &[u16],
    expected_admin_port: u16,
) -> V3ServerAggregateHandle {
    let snapshot = V3ConfigStore::new(config_path)
        .load_snapshot_with_source_identity()
        .unwrap();
    let handle = spawn_v3_server_aggregate_with_admin(
        snapshot.manifest,
        snapshot.admin_webui,
        Some(config_path.to_path_buf()),
    )
    .await
    .unwrap();

    let mut business_ports = handle
        .listeners
        .iter()
        .filter(|listener| listener.server_id != "admin_webui")
        .map(|listener| listener.addr.port())
        .collect::<Vec<_>>();
    business_ports.sort_unstable();
    let mut expected_business_ports = expected_business_ports.to_vec();
    expected_business_ports.sort_unstable();
    assert_eq!(
        business_ports, expected_business_ports,
        "each isolated business listener must bind its declared port"
    );
    let admin_port = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "admin_webui")
        .expect("aggregate exposes its isolated admin listener")
        .addr
        .port();
    assert_eq!(
        admin_port, expected_admin_port,
        "admin must bind its isolated declared port"
    );
    handle
}

async fn wait_for_ports_released(ports: &[u16]) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let all_released = ports.iter().all(|port| {
            StdTcpListener::bind(("127.0.0.1", *port))
                .map(|listener| drop(listener))
                .is_ok()
        });
        if all_released {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        sleep(Duration::from_millis(25)).await;
    }
}

async fn query_public_usage(
    client: &reqwest::Client,
    admin_addr: SocketAddr,
    ports: &[u16],
    provider_id: Option<&str>,
) -> (reqwest::StatusCode, Value) {
    let mut url =
        reqwest::Url::parse(&format!("http://{admin_addr}/api/observability/records")).unwrap();
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("page", "1")
            .append_pair("page_size", "20")
            .append_pair("view", "all")
            .append_pair("calendar_period", "all")
            .append_pair("timezone", "UTC")
            .append_pair("ports", &serde_json::to_string(ports).unwrap());
        if let Some(provider_id) = provider_id {
            query.append_pair(
                "provider_ids",
                &serde_json::to_string(&[provider_id]).unwrap(),
            );
        }
    }
    get_json(client, url.as_str()).await
}

async fn wait_for_public_usage(
    client: &reqwest::Client,
    admin_addr: SocketAddr,
    ports: &[u16],
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let (status, body) = query_public_usage(client, admin_addr, ports, None).await;
        assert_eq!(
            status,
            reqwest::StatusCode::OK,
            "provider usage query must succeed: {body}"
        );
        let usage = &body["provider_usage"];
        if usage["coverage"]["source"] == "durable_facts"
            && usage["summary"]["request_count"] == 2
            && usage["summary"]["failed_attempt_count"] == 1
            && usage["summary"]["success_count"] == 2
        {
            return usage.clone();
        }
        assert!(
            Instant::now() < deadline,
            "durable provider usage facts did not settle: {body}"
        );
        sleep(Duration::from_millis(50)).await;
    }
}

fn assert_usage_totals(
    value: &Value,
    request_count: u64,
    failed_attempt_count: u64,
    success_count: u64,
    effective_input_tokens: u64,
    output_tokens: Option<u64>,
    reported_total_tokens: Option<u64>,
) {
    assert_eq!(value["request_count"], request_count, "{value}");
    assert_eq!(
        value["failed_attempt_count"], failed_attempt_count,
        "{value}"
    );
    assert_eq!(value["success_count"], success_count, "{value}");
    assert_eq!(
        value["effective_input_tokens"], effective_input_tokens,
        "{value}"
    );
    assert_eq!(
        value["output_tokens"],
        output_tokens.map_or(Value::Null, Value::from),
        "{value}"
    );
    assert_eq!(
        value["reported_total_tokens"],
        reported_total_tokens.map_or(Value::Null, Value::from),
        "{value}"
    );
}

fn provider_usage_entry<'a>(usage: &'a Value, provider_id: &str) -> &'a Value {
    usage["by_provider"]
        .as_array()
        .expect("provider usage by_provider array")
        .iter()
        .find(|entry| entry["provider_id"] == provider_id)
        .unwrap_or_else(|| panic!("missing provider usage entry for {provider_id}: {usage}"))
}

async fn run_two_listener_public_usage(fixture: &mut PublicUsageFixture) -> Value {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let primary_addr = fixture.server_addr("primary");
    let control_addr = fixture.server_addr("control");

    let primary_response = client
        .post(format!("http://{primary_addr}/v1/responses"))
        .json(&json!({
            "model": "client",
            "input": "primary-request",
            "stream": false
        }))
        .send()
        .await
        .expect("primary request must reach the isolated listener");
    assert_eq!(primary_response.status(), reqwest::StatusCode::OK);
    assert!(
        primary_response
            .text()
            .await
            .unwrap()
            .contains("SWITCHED_BUSINESS_OK"),
        "primary request must recover from provider A to provider B"
    );

    let control_response = client
        .post(format!("http://{control_addr}/v1/responses"))
        .json(&json!({
            "model": "client",
            "input": "control-request",
            "stream": false
        }))
        .send()
        .await
        .expect("control request must reach the second isolated listener");
    assert_eq!(control_response.status(), reqwest::StatusCode::OK);
    assert!(
        control_response
            .text()
            .await
            .unwrap()
            .contains("SWITCHED_BUSINESS_OK"),
        "control listener must return its controlled provider response"
    );

    let admin_addr = fixture.admin_addr();
    let ports = [fixture.primary_port, fixture.control_port];
    let all_usage = wait_for_public_usage(&client, admin_addr, &ports).await;
    assert_eq!(all_usage["coverage"]["source"], "durable_facts");
    assert_usage_totals(&all_usage["summary"], 2, 1, 2, 138, Some(22), Some(160));

    let provider_a = provider_usage_entry(&all_usage, "a");
    assert_usage_totals(provider_a, 0, 1, 0, 0, None, None);
    let provider_b = provider_usage_entry(&all_usage, "b");
    assert_usage_totals(provider_b, 2, 0, 2, 138, Some(22), Some(160));

    let (status, all_records) = query_public_usage(&client, admin_addr, &ports, None).await;
    assert_eq!(
        status,
        reqwest::StatusCode::OK,
        "public records body: {all_records}"
    );
    let records = all_records["records"]
        .as_array()
        .expect("public records array");
    assert_eq!(
        records
            .iter()
            .filter(|row| row["result"] == "failed-attempt"
                && row["meta"]["provider_id"] == "a"
                && row["scope"]["port"] == fixture.primary_port)
            .count(),
        1,
        "the failed attempt must belong to provider A on the primary port: {all_records}"
    );
    assert_eq!(
        records
            .iter()
            .filter(|row| row["result"] == "success" && row["meta"]["provider_id"] == "b")
            .count(),
        2,
        "both logical requests and successful usage must belong to provider B: {all_records}"
    );

    let (status, primary_b_only) =
        query_public_usage(&client, admin_addr, &[fixture.primary_port], Some("b")).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{primary_b_only}");
    assert_usage_totals(
        &primary_b_only["provider_usage"]["summary"],
        1,
        0,
        1,
        101,
        Some(17),
        Some(118),
    );
    assert_eq!(primary_b_only["total"], 1);

    let (status, control_b_only) =
        query_public_usage(&client, admin_addr, &[fixture.control_port], Some("b")).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{control_b_only}");
    assert_usage_totals(
        &control_b_only["provider_usage"]["summary"],
        1,
        0,
        1,
        37,
        Some(5),
        Some(42),
    );
    assert_eq!(control_b_only["total"], 1);

    let (status, provider_b_both_ports) =
        query_public_usage(&client, admin_addr, &ports, Some("b")).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{provider_b_both_ports}");
    assert_usage_totals(
        &provider_b_both_ports["provider_usage"]["summary"],
        2,
        0,
        2,
        138,
        Some(22),
        Some(160),
    );

    let (status, primary_a_only) =
        query_public_usage(&client, admin_addr, &[fixture.primary_port], Some("a")).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{primary_a_only}");
    assert_usage_totals(
        &primary_a_only["provider_usage"]["summary"],
        0,
        1,
        0,
        0,
        None,
        None,
    );

    let (status, wrong_port_empty) =
        query_public_usage(&client, admin_addr, &[fixture.control_port], Some("a")).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{wrong_port_empty}");
    assert_usage_totals(
        &wrong_port_empty["provider_usage"]["summary"],
        0,
        0,
        0,
        0,
        None,
        None,
    );
    assert_eq!(
        wrong_port_empty["provider_usage"]["by_provider"],
        json!([]),
        "provider A on the control-only port must be a real empty intersection"
    );
    assert_eq!(wrong_port_empty["total"], 0);
    assert_eq!(wrong_port_empty["records"], json!([]));

    fixture.restart_same_config().await;
    let reopened_usage = wait_for_public_usage(&client, admin_addr, &ports).await;
    assert_eq!(reopened_usage["coverage"]["source"], "durable_facts");
    assert_eq!(
        reopened_usage["summary"], all_usage["summary"],
        "reopening the same isolated config must retain the exact cumulative summary"
    );
    assert_eq!(
        reopened_usage["by_provider"], all_usage["by_provider"],
        "reopening must not recount or move provider attribution"
    );
    reopened_usage
}

#[tokio::test]
async fn provider_usage_two_listeners_public_intersection_and_restart() {
    let _guard = TEST_LOCK.lock().await;
    let _provider_key =
        EnvironmentVarGuard::set(PROVIDER_KEY_ENV, "controlled-provider-usage-secret");
    let home = TestHome::new("issue5dfae83-public-usage");
    let home_path = home.path.clone();
    let home_removal_receipt = home.removal_receipt();

    let (a_port, a, a_shutdown, a_task) = start_upstream(true, false).await;
    let (b_port, b, b_shutdown, b_task) = start_upstream_with_usage(
        false,
        false,
        json!({"input_tokens": 101, "output_tokens": 17, "total_tokens": 118}),
        vec![(
            "control-request".to_string(),
            json!({"input_tokens": 37, "output_tokens": 5, "total_tokens": 42}),
        )],
    )
    .await;
    let primary_port = test_ports::free_port();
    let control_port = test_ports::free_port();
    let admin_port = test_ports::free_port();
    let config_path = home.path.join("config.v3.toml");
    fs::write(
        &config_path,
        two_listener_config_source(
            &home.path,
            primary_port,
            control_port,
            admin_port,
            a_port,
            b_port,
        ),
    )
    .unwrap();

    let mut fixture =
        PublicUsageFixture::start(config_path, primary_port, control_port, admin_port).await;
    let outcome = AssertUnwindSafe(run_two_listener_public_usage(&mut fixture))
        .catch_unwind()
        .await;
    let server_ports_released = fixture.shutdown_aggregate().await;

    let _ = a_shutdown.send(());
    let _ = b_shutdown.send(());
    let a_task_ok = a_task.await.is_ok();
    let b_task_ok = b_task.await.is_ok();
    let upstream_ports_released = wait_for_ports_released(&[a_port, b_port]).await;
    let provider_call_counts = (
        a.calls.load(Ordering::SeqCst),
        b.calls.load(Ordering::SeqCst),
    );
    drop(home);
    let home_removed = home_removal_receipt.load(Ordering::SeqCst);

    if let Err(payload) = outcome {
        eprintln!(
            "public usage test panicked; cleanup receipts: server_ports_released={server_ports_released} upstream_ports_released={upstream_ports_released} home_removed={home_removed} a_task_ok={a_task_ok} b_task_ok={b_task_ok} provider_calls={provider_call_counts:?}"
        );
        panic::resume_unwind(payload);
    }

    assert!(
        server_ports_released,
        "normal close must release every isolated business and admin port"
    );
    assert!(
        upstream_ports_released,
        "normal close must release both controlled upstream ports"
    );
    assert!(a_task_ok, "provider A fixture task must complete normally");
    assert!(b_task_ok, "provider B fixture task must complete normally");
    assert!(
        home_removed,
        "normal close must remove {}",
        home_path.display()
    );
    assert_eq!(
        provider_call_counts,
        (1, 2),
        "provider A serves only the failed primary attempt, while provider B serves the recovered request and the control request"
    );
}
