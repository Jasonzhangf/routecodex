//! REQ09 mixed-failure public consumer.
//!
//! This test drives one real aggregate `/v1/responses` request through a
//! same-protocol Direct pool. The first candidate returns a real loopback
//! HTTP 401. The second candidate fails locally because its auth environment
//! variable is absent, so no network request can be sent to it. The test then
//! proves that the aggregate still serves an independent healthy request.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, Mutex},
    time::timeout,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const FIRST_KEY_ENV: &str = "V3_REQ09_MIXED_FAILURE_FIRST_KEY";
const MISSING_KEY_ENV: &str = "V3_REQ09_MIXED_FAILURE_MISSING_KEY";
const HEALTHY_KEY_ENV: &str = "V3_REQ09_MIXED_FAILURE_HEALTHY_KEY";

const FAILURE_REQUEST_MARKER: &str = "REQ09_MIXED_FAILURE_OPAQUE_REQUEST_MARKER";
const HEALTHY_REQUEST_MARKER: &str = "REQ09_MIXED_FAILURE_HEALTHY_REQUEST_MARKER";
const HEALTHY_RESULT_MARKER: &str = "REQ09_MIXED_FAILURE_HEALTHY_RESULT_MARKER";

struct TestHomeGuard {
    previous_home: Option<OsString>,
    previous_first_key: Option<OsString>,
    previous_missing_key: Option<OsString>,
    previous_healthy_key: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "routecodex-v3-req09-mixed-failure-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        let previous_home = std::env::var_os("HOME");
        let previous_first_key = std::env::var_os(FIRST_KEY_ENV);
        let previous_missing_key = std::env::var_os(MISSING_KEY_ENV);
        let previous_healthy_key = std::env::var_os(HEALTHY_KEY_ENV);
        std::env::set_var("HOME", &path);
        std::env::set_var(FIRST_KEY_ENV, "req09-mixed-failure-first-secret");
        std::env::remove_var(MISSING_KEY_ENV);
        std::env::set_var(HEALTHY_KEY_ENV, "req09-mixed-failure-healthy-secret");
        Self {
            previous_home,
            previous_first_key,
            previous_missing_key,
            previous_healthy_key,
            path,
        }
    }

    fn samples_root(&self) -> PathBuf {
        self.path.join(".rcc").join("codex-samples")
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous_home {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(previous) = &self.previous_first_key {
            std::env::set_var(FIRST_KEY_ENV, previous);
        } else {
            std::env::remove_var(FIRST_KEY_ENV);
        }
        if let Some(previous) = &self.previous_missing_key {
            std::env::set_var(MISSING_KEY_ENV, previous);
        } else {
            std::env::remove_var(MISSING_KEY_ENV);
        }
        if let Some(previous) = &self.previous_healthy_key {
            std::env::set_var(HEALTHY_KEY_ENV, previous);
        } else {
            std::env::remove_var(HEALTHY_KEY_ENV);
        }
        fs::remove_dir_all(&self.path).expect("remove this test's isolated HOME");
    }
}

#[derive(Clone)]
struct CaptureState {
    captures: mpsc::UnboundedSender<Value>,
    status: StatusCode,
    response_body: Arc<Value>,
}

async fn capture_and_respond(
    State(state): State<Arc<CaptureState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(body)
        .expect("capture receiver remains live");
    Response::builder()
        .status(state.status)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&*state.response_body).expect("response fixture serializes"),
        ))
        .unwrap()
}

async fn start_json_upstream(
    path: &'static str,
    status: StatusCode,
    response_body: Value,
) -> (
    String,
    mpsc::UnboundedReceiver<Value>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route(path, post(capture_and_respond))
        .with_state(Arc::new(CaptureState {
            captures: captures_tx,
            status,
            response_body: Arc::new(response_body),
        }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown_rx.await.expect("upstream shutdown signal");
            })
            .await
            .unwrap();
    });
    (
        format!("http://{address}/v1"),
        captures_rx,
        shutdown_tx,
        task,
    )
}

fn responses_success(text: &str) -> Value {
    json!({
        "id": "resp_req09_mixed_failure_healthy",
        "object": "response",
        "created_at": 0,
        "status": "completed",
        "model": "responses-healthy-wire",
        "output": [{
            "id": "msg_req09_mixed_failure_healthy",
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{
                "type": "output_text",
                "text": text,
                "annotations": []
            }]
        }],
        "output_text": text
    })
}

fn req09_mixed_failure_manifest(
    server_port: u16,
    first_base_url: &str,
    missing_base_url: &str,
    healthy_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_test_declaration();
    let server_execution = hub_v1_server_execution("req09_mixed_failure");
    let source = format!(
        r#"
version = 3
{declaration}

[servers.req09_mixed_failure]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req09_mixed_failure"
endpoints = ["responses"]
{server_execution}

[providers.responses_401]
type = "responses"
base_url = "{first_base_url}"
default_model = "responses-401-wire"
auth = {{ type = "api_key", entries = [{{ alias = "first_key", env = "{FIRST_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always", transport = "http" }}
[providers.responses_401.models.responses-401-wire]
wire_name = "responses-401-wire"
aliases = ["req09-mixed-failure-client"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.responses_missing]
type = "responses"
base_url = "{missing_base_url}"
default_model = "responses-missing-wire"
auth = {{ type = "api_key", entries = [{{ alias = "missing_key", env = "{MISSING_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always", transport = "http" }}
[providers.responses_missing.models.responses-missing-wire]
wire_name = "responses-missing-wire"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.responses_healthy]
type = "responses"
base_url = "{healthy_base_url}"
default_model = "responses-healthy-wire"
auth = {{ type = "api_key", entries = [{{ alias = "healthy_key", env = "{HEALTHY_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always", transport = "http" }}
[providers.responses_healthy.models.responses-healthy-wire]
wire_name = "responses-healthy-wire"
aliases = ["req09-mixed-failure-healthy"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[debug]
log_console = true
snapshots = true
codex_samples = true
snapshot_stages = "client-request,client-response"
dry_run = false
retention = {{ raw_requests = 16, raw_responses = 16, events = 256 }}

[route_groups.req09_mixed_failure.pools.mixed_failure]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["req09-mixed-failure-client"] }}
targets = [
  {{ kind = "provider_model", provider = "responses_401", model = "responses-401-wire", key = "first_key", priority = 2 }},
  {{ kind = "provider_model", provider = "responses_missing", model = "responses-missing-wire", key = "missing_key", priority = 1 }}
]

[route_groups.req09_mixed_failure.pools.healthy]
selection = {{ strategy = "priority" }}
match = {{ precedence = 20, entry_protocol = "responses", models = ["req09-mixed-failure-healthy"] }}
targets = [{{ kind = "provider_model", provider = "responses_healthy", model = "responses-healthy-wire", key = "healthy_key", priority = 1 }}]

[route_groups.req09_mixed_failure.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "responses_missing", model = "responses-missing-wire", key = "missing_key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn read_json_file(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn find_sample_with_request_marker(root: &Path, marker: &str) -> Option<PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            if path.file_name().and_then(|name| name.to_str()) != Some("request.json") {
                continue;
            }
            let Some(request) = fs::read_to_string(&path).ok() else {
                continue;
            };
            if request.contains(marker) {
                return path.parent().map(Path::to_path_buf);
            }
        }
    }
    None
}

async fn wait_for_sample_with_request_marker(root: &Path, marker: &str) -> Option<PathBuf> {
    for _ in 0..400 {
        if let Some(path) = find_sample_with_request_marker(root, marker) {
            return Some(path);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    None
}

#[derive(Debug)]
enum ClientObservation {
    HeaderlessClose(String),
    Response {
        status: StatusCode,
        body: Result<String, String>,
    },
    Timeout,
}

async fn observe_responses_request(
    client: &reqwest::Client,
    url: String,
    body: Value,
) -> ClientObservation {
    match timeout(Duration::from_secs(10), client.post(url).json(&body).send()).await {
        Ok(Ok(response)) => {
            let status = response.status();
            let body = match timeout(Duration::from_secs(5), response.text()).await {
                Ok(Ok(body)) => Ok(body),
                Ok(Err(error)) => Err(error.to_string()),
                Err(_) => Err("client response body timed out".to_string()),
            };
            ClientObservation::Response { status, body }
        }
        Ok(Err(error)) => ClientObservation::HeaderlessClose(error.to_string()),
        Err(_) => ClientObservation::Timeout,
    }
}

async fn shutdown_upstream(
    shutdown: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
    label: &str,
) {
    shutdown.send(()).expect("upstream shutdown receiver");
    timeout(Duration::from_secs(5), task)
        .await
        .unwrap_or_else(|_| panic!("{label}: upstream shutdown timed out"))
        .unwrap_or_else(|error| panic!("{label}: upstream task failed: {error}"));
}

#[tokio::test]
async fn req09_mixed_external_401_then_missing_auth_preserves_local_terminal_evidence_blackbox() {
    let _test_guard = TEST_LOCK.lock().await;
    let home_guard = TestHomeGuard::new("responses");

    let (first_base_url, mut first_captures, first_shutdown, first_task) = start_json_upstream(
        "/v1/responses",
        StatusCode::UNAUTHORIZED,
        json!({
            "error": {
                "message": "req09 mixed-failure upstream authentication rejected",
                "type": "authentication_error",
                "code": "invalid_api_key"
            }
        }),
    )
    .await;
    let (missing_base_url, mut missing_captures, missing_shutdown, missing_task) =
        start_json_upstream(
            "/v1/responses",
            StatusCode::OK,
            responses_success("missing-auth candidate must never answer"),
        )
        .await;
    let (healthy_base_url, mut healthy_captures, healthy_shutdown, healthy_task) =
        start_json_upstream(
            "/v1/responses",
            StatusCode::OK,
            responses_success(HEALTHY_RESULT_MARKER),
        )
        .await;

    let diagnostic_log = home_guard.path.join("mixed-failure-events.log");
    let mut manifest = req09_mixed_failure_manifest(
        free_port(),
        &first_base_url,
        &missing_base_url,
        &healthy_base_url,
    );
    manifest.debug.log_file = Some(diagnostic_log.to_string_lossy().into_owned());
    let mut server_start_error = None;
    let handle = match spawn_v3_server_aggregate(manifest).await {
        Ok(handle) => Some(handle),
        Err(error) => {
            server_start_error = Some(error.to_string());
            None
        }
    };

    let mut client_observation = None;
    let mut sample_dir = None;
    let mut healthy_observation = None;

    if let Some(handle) = handle.as_ref() {
        let addr = handle.listeners[0].addr;
        let client = reqwest::Client::new();
        client_observation = Some(
            observe_responses_request(
                &client,
                format!("http://{addr}/v1/responses"),
                json!({
                    "model": "req09-mixed-failure-client",
                    "input": FAILURE_REQUEST_MARKER,
                    "stream": false
                }),
            )
            .await,
        );

        sample_dir =
            wait_for_sample_with_request_marker(&home_guard.samples_root(), FAILURE_REQUEST_MARKER)
                .await;

        healthy_observation = Some(
            observe_responses_request(
                &client,
                format!("http://{addr}/v1/responses"),
                json!({
                    "model": "req09-mixed-failure-healthy",
                    "input": HEALTHY_REQUEST_MARKER,
                    "stream": false
                }),
            )
            .await,
        );
    }

    let first_capture = timeout(Duration::from_secs(5), first_captures.recv())
        .await
        .ok()
        .flatten();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let first_extra = first_captures.try_recv().ok();
    let missing_capture = missing_captures.try_recv().ok();
    let healthy_capture = timeout(Duration::from_secs(5), healthy_captures.recv())
        .await
        .ok()
        .flatten();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let healthy_extra = healthy_captures.try_recv().ok();

    let shutdown_failures = if let Some(handle) = handle {
        timeout(Duration::from_secs(5), handle.shutdown())
            .await
            .expect("aggregate server shutdown must complete")
    } else {
        Vec::new()
    };

    shutdown_upstream(first_shutdown, first_task, "first 401 upstream").await;
    shutdown_upstream(missing_shutdown, missing_task, "missing-auth upstream").await;
    shutdown_upstream(healthy_shutdown, healthy_task, "healthy upstream").await;
    let request_json = sample_dir
        .as_ref()
        .and_then(|path| read_json_file(&path.join("request.json")));
    let provider_terminal = sample_dir
        .as_ref()
        .and_then(|path| read_json_file(&path.join("provider-terminal.json")));
    let diagnostic_events = fs::read_to_string(&diagnostic_log).expect("configured event log");
    drop(home_guard);

    assert!(
        server_start_error.is_none(),
        "aggregate server must start: {server_start_error:?}"
    );
    assert!(
        shutdown_failures.is_empty(),
        "sample persistence failures: {shutdown_failures:?}"
    );

    match client_observation.expect("failure request observation must be collected") {
        ClientObservation::HeaderlessClose(error) => {
            assert!(
                !error.is_empty(),
                "headerless client close must carry the transport error"
            );
        }
        ClientObservation::Response { status, body } => {
            panic!(
                "terminal local failure must not project an HTTP response or Provider error JSON: \
                 status={status}, body={body:?}"
            );
        }
        ClientObservation::Timeout => {
            panic!("terminal local failure must end the client transport before the deadline");
        }
    }

    let first_capture = first_capture.expect("first candidate must receive one real request");
    assert!(
        first_capture.to_string().contains(FAILURE_REQUEST_MARKER),
        "first upstream must receive the opaque request marker: {first_capture}"
    );
    assert_eq!(
        first_capture["model"], "responses-401-wire",
        "first upstream must receive its own wire model: {first_capture}"
    );
    assert!(
        first_extra.is_none(),
        "first upstream must receive exactly one request: {first_extra:?}"
    );
    assert!(
        missing_capture.is_none(),
        "missing-auth candidate must not send a network request: {missing_capture:?}"
    );

    let sample_dir = sample_dir.expect("request-bound sample must exist for the failed request");
    let request_json = request_json.expect("request.json must be parseable");
    assert!(
        request_json.to_string().contains(FAILURE_REQUEST_MARKER),
        "request.json must preserve the opaque marker: {request_json}"
    );
    let provider_terminal =
        provider_terminal.expect("request-bound provider-terminal.json must exist");
    assert_eq!(
        provider_terminal["kind"], "no_response",
        "a local missing-auth failure has no external HTTP witness: {provider_terminal}"
    );
    let request_id = sample_dir
        .file_name()
        .and_then(|name| name.to_str())
        .expect("the marker-bound sample directory identifies the request");
    let recorded_events: Vec<Value> = diagnostic_events
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event["request_id"] == request_id)
        .collect();
    for node in [
        "V3Error01SourceRaised",
        "V3Error02Classified",
        "V3Error03TargetLocalAction",
        "V3Error04TargetExhaustionDecision",
        "V3Error05ExecutionDecision",
        "V3Error06ClientProjected",
    ] {
        assert!(
            recorded_events.iter().any(|event| event["node_id"] == node),
            "the same request must traverse {node}: {recorded_events:?}"
        );
    }
    assert!(
        recorded_events.iter().any(|event| {
            event["event"] == "client_transport" && event["stage"] == "response_discarded"
        }),
        "the provider terminal must discard the client response: {recorded_events:?}"
    );
    let provider_event = diagnostic_events
        .lines()
        .find(|line| {
            line.contains(&format!("req={request_id} "))
                && line.contains("[provider-error]")
                && line.contains("type=provider_local_runtime_error ")
        })
        .expect("the provider failure diagnostic must match the sampled request ID");
    assert!(
        diagnostic_events.lines().any(|line| {
            line.contains(&format!("req={request_id} "))
                && line.contains("[provider-error]")
                && line.contains("externalStatus=401")
        }),
        "the first provider's real 401 must remain observable for the same request"
    );
    assert!(
        provider_event.contains("type=provider_local_runtime_error ")
            && provider_event.contains("internalCode=500-160"),
        "the original typed source and internal registry code must survive: {provider_event}"
    );
    assert!(
        provider_event.contains("auth handle missing_key has no secret"),
        "the original missing-auth cause must remain observable: {provider_event}"
    );
    assert!(
        !provider_event.contains("externalStatus=401")
            && !provider_event.contains("externalStatus=")
            && !provider_event.contains("network_error"),
        "a local failure must retain its source without an inherited external HTTP 401 witness: {provider_event}"
    );
    assert_eq!(
        recorded_events
            .iter()
            .filter(|event| event["node_id"] == "V3Error01SourceRaised")
            .count(),
        2,
        "each failed attempt must raise its own source for the same request: {recorded_events:?}"
    );
    assert!(
        provider_terminal.get("status").is_none(),
        "a no_response terminal must not project an external status: {provider_terminal}"
    );
    assert!(
        !provider_terminal
            .to_string()
            .contains("req09 mixed-failure upstream authentication rejected"),
        "the no_response terminal must not carry an earlier provider 401 body: {provider_terminal}"
    );
    let request_id_from_error = recorded_events
        .iter()
        .rev()
        .find(|event| event["node_id"] == "V3Error06ClientProjected")
        .and_then(|event| event["request_id"].as_str())
        .expect("the Error06 event must identify the sampled request");
    assert_eq!(
        request_id_from_error, request_id,
        "all final Error diagnostics must bind to the same request"
    );

    match healthy_observation.expect("healthy request observation must be collected") {
        ClientObservation::Response {
            status,
            body: Ok(body),
        } => {
            assert_eq!(status, StatusCode::OK, "{body}");
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["status"], "completed", "{body}");
            assert!(
                body.to_string().contains(HEALTHY_RESULT_MARKER),
                "independent healthy request must complete on the same aggregate: {body}"
            );
        }
        other => panic!("independent healthy request must return completed JSON: {other:?}"),
    }
    let healthy_capture = healthy_capture.expect("healthy upstream must receive one request");
    assert!(
        healthy_capture.to_string().contains(HEALTHY_REQUEST_MARKER),
        "healthy upstream must receive its request marker: {healthy_capture}"
    );
    assert_eq!(
        healthy_capture["model"], "responses-healthy-wire",
        "healthy upstream must receive its own wire model: {healthy_capture}"
    );
    assert!(
        healthy_extra.is_none(),
        "healthy upstream must receive exactly one request: {healthy_extra:?}"
    );
}
