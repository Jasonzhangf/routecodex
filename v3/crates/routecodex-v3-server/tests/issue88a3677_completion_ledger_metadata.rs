//! Public-entry regression for canonical issue `88a3677`.
//!
//! Stable test ID: `issue88a3677_completion_ledger_metadata`.
//!
//! Command:
//! `node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test issue88a3677_completion_ledger_metadata -- --nocapture`
//!
//! A real SSE request enters the listener. Provider `a` returns a real HTTP
//! 503, provider `b` returns a completed Responses business response, and the
//! runtime switches once. The failed-attempt row keeps its own 503 evidence,
//! while the completed row keeps only the successful terminal metadata. The
//! admin records API must expose the same clean completed row.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use futures_util::FutureExt;
use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use serde_json::{json, Value};
use std::{
    env,
    ffi::OsString,
    fs,
    net::TcpListener as StdTcpListener,
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

const PROVIDER_KEY_ENV: &str = "ISSUE_88A3677_KEY";
const COMPLETION_TEXT: &str = "ISSUE_88A3677_COMPLETED_BUSINESS_OK";

#[derive(Clone, Copy)]
enum UpstreamMode {
    Http503,
    Completed,
}

struct Upstream {
    calls: AtomicUsize,
    mode: UpstreamMode,
}

async fn upstream(State(state): State<Arc<Upstream>>, Json(_body): Json<Value>) -> Response<Body> {
    state.calls.fetch_add(1, Ordering::SeqCst);
    match state.mode {
        UpstreamMode::Http503 => Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"message":"controlled completion-ledger failure","type":"server_error","code":"controlled_unavailable"}}"#,
            ))
            .unwrap(),
        UpstreamMode::Completed => {
            let completed = json!({
                "id": "resp-88a3677",
                "object": "response",
                "status": "completed",
                "model": "wire-b",
                "output": [{
                    "id": "msg-88a3677",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{
                        "type": "output_text",
                        "text": COMPLETION_TEXT,
                        "annotations": []
                    }]
                }],
                "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
            });
            let frame = json!({"type": "response.completed", "response": completed});
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(format!(
                    "event: response.completed\ndata: {frame}\n\n"
                )))
                .unwrap()
        }
    }
}

async fn start_upstream(
    mode: UpstreamMode,
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
        mode,
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
    fn new() -> Self {
        let path = env::temp_dir().join(format!(
            "rcc-issue88a3677-{}-{}",
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
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always" }}
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
responses = {{ process = "direct", streaming = "always" }}
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
        log_file = home
            .join("logs")
            .join(format!("server-v3-{server_port}.log"))
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

async fn assert_completion_ledger_metadata(
    server_addr: std::net::SocketAddr,
    admin_addr: std::net::SocketAddr,
    records_path: &Path,
    a: &Upstream,
    b: &Upstream,
) {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let response = client
        .post(format!("http://{server_addr}/v1/responses"))
        .json(&json!({
            "model": "client",
            "input": "controlled completion-ledger request",
            "stream": true
        }))
        .send()
        .await
        .expect("the switched request must reach the real listener");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let client_body = response.text().await.unwrap();
    assert!(
        client_body.contains(COMPLETION_TEXT),
        "provider b's business body must reach the client: {client_body}"
    );
    assert!(
        client_body
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|body| serde_json::from_str::<Value>(body).ok())
            .any(|frame| frame["type"] == "response.completed"),
        "the recovered SSE request must deliver one completed terminal: {client_body}"
    );
    assert_eq!(a.calls.load(Ordering::SeqCst), 1);
    assert_eq!(b.calls.load(Ordering::SeqCst), 1);

    let deadline = Instant::now() + Duration::from_secs(20);
    let rows = loop {
        let rows = read_raw_rows(records_path);
        if has_terminal(&rows) || Instant::now() >= deadline {
            break rows;
        }
        sleep(Duration::from_millis(50)).await;
    };

    let failed_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| row["event_type"] == "request.provider_attempt_failed")
        .collect();
    assert_eq!(failed_rows.len(), 1, "one failed attempt row: {rows:#?}");
    let failed = failed_rows[0];
    assert_eq!(failed["meta"]["provider_id"], "a");
    assert_eq!(failed["meta"]["provider_status"], 503);
    assert_eq!(failed["meta"]["error_category"], "provider_http_503");
    assert!(failed["meta"]["error_detail"].is_string());
    assert!(failed["meta"]["observed_error"].is_object());

    let completed_rows: Vec<&Value> = rows
        .iter()
        .filter(|row| row["event_type"] == "request.completed")
        .collect();
    assert_eq!(
        completed_rows.len(),
        1,
        "the switched request must complete exactly once: {rows:#?}"
    );
    let completed = completed_rows[0];
    assert_eq!(completed["result"], "success");
    assert_eq!(completed["failed_attempts"], 1);
    assert_eq!(completed["switches"], 1);
    assert_eq!(completed["meta"]["provider_status"], 200);
    assert_eq!(completed["meta"]["response_status"], "completed");
    assert_eq!(completed["meta"]["finish_reason"], "stop");
    assert!(completed["meta"]["error_category"].is_null());
    assert!(completed["meta"]["error_detail"].is_null());
    assert!(completed["meta"]["observed_error"].is_null());

    let request_key = completed["request_key"]
        .as_str()
        .expect("completed row has a request_key");
    let list_url = format!("http://{admin_addr}/api/observability/records?range=all&page_size=50");
    let admin_deadline = Instant::now() + Duration::from_secs(20);
    let admin_row = loop {
        let (status, body) = get_json(&client, &list_url).await;
        assert_eq!(status, reqwest::StatusCode::OK, "records list: {body}");
        if let Some(row) = body["records"]
            .as_array()
            .and_then(|records| records.iter().find(|row| row["request_key"] == request_key))
        {
            break row.clone();
        }
        assert!(
            Instant::now() < admin_deadline,
            "completed row did not reach admin records: {body}"
        );
        sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(admin_row["result"], "success");
    assert_eq!(admin_row["failed_attempts"], 1);
    assert_eq!(admin_row["switches"], 1);
    assert_eq!(admin_row["meta"]["provider_status"], 200);
    assert_eq!(admin_row["meta"]["response_status"], "completed");
    assert_eq!(admin_row["meta"]["finish_reason"], "stop");
    assert!(admin_row["meta"]["error_category"].is_null());
    assert!(admin_row["meta"]["error_detail"].is_null());
    assert!(admin_row["meta"]["observed_error"].is_null());
}

fn wait_for_port_released(port: u16) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if StdTcpListener::bind(("127.0.0.1", port)).is_ok() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[tokio::test]
async fn issue88a3677_completion_ledger_metadata() {
    let _guard = TEST_LOCK.lock().await;
    let _provider_key =
        EnvironmentVarGuard::set(PROVIDER_KEY_ENV, "controlled-completion-ledger-secret");
    let home = TestHome::new();

    let (a_port, a, a_shutdown, a_task) = start_upstream(UpstreamMode::Http503).await;
    let (b_port, b, b_shutdown, b_task) = start_upstream(UpstreamMode::Completed).await;
    let server_port = test_ports::free_port();
    let admin_port = test_ports::free_port();
    let config_path = home.path.join("config.v3.toml");
    fs::write(
        &config_path,
        config_source(&home.path, server_port, admin_port, a_port, b_port),
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
    let records_path = home
        .path
        .join("logs")
        .join(format!("server-v3-{server_port}.request-records.jsonl"));

    let outcome = AssertUnwindSafe(assert_completion_ledger_metadata(
        server_addr,
        admin_addr,
        &records_path,
        &a,
        &b,
    ))
    .catch_unwind()
    .await;

    handle.shutdown().await;
    let _ = a_shutdown.send(());
    let _ = b_shutdown.send(());
    let a_task_ok = a_task.await.is_ok();
    let b_task_ok = b_task.await.is_ok();
    let server_released = wait_for_port_released(server_port);
    let admin_released = wait_for_port_released(admin_port);
    let a_released = wait_for_port_released(a_port);
    let b_released = wait_for_port_released(b_port);
    let home_removed = Arc::clone(&home.removed);
    drop(home);

    if let Err(payload) = outcome {
        eprintln!(
            "completion-ledger test panicked; cleanup: server={server_released} admin={admin_released} a={a_released} b={b_released} a_task={a_task_ok} b_task={b_task_ok}"
        );
        panic::resume_unwind(payload);
    }
    assert!(server_released, "business listener port must be released");
    assert!(admin_released, "admin listener port must be released");
    assert!(a_released && b_released, "upstream ports must be released");
    assert!(
        a_task_ok && b_task_ok,
        "upstream tasks must complete normally"
    );
    assert!(
        home_removed.load(Ordering::SeqCst),
        "temporary home must be removed"
    );
}
