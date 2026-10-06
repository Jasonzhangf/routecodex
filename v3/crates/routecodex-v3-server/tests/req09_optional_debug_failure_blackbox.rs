//! REQ09 optional-Debug-failure public consumer.
//!
//! This consumer drives one real aggregate `/v1/chat/completions` relay request
//! through a Chat-to-Responses relay pool. The first candidate returns a real
//! loopback HTTP 401. The second, lower-priority candidate fails locally because
//! its auth environment variable is absent, so no network request can be sent
//! to it.
//!
//! The diagnostic sink is a configured, writable file when the request starts.
//! After the first candidate captures the opaque marker but before its 401 is
//! released, the test replaces the configured log path with a directory. The
//! next Diagnostic write is the changed observer seam:
//! `record_and_emit_v3_error_projection` records the `V3Error06ClientProjected`
//! node event. That write fails for real, exercises the optional Debug failure
//! path, and must not replace the original provider terminal, leak either the
//! provider error body or the Debug failure payload, or poison the listener.
//! Removing the blocker restores the sink so a new independent request can
//! complete with a real 200.
//!
//! Coverage is intentionally one public OpenAI Chat relay request plus one
//! independent healthy request. The four Relay branches share the same Server
//! terminal-diagnostic helper; those branches remain covered by the frozen
//! four-entry consumers outside this worker scope.

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

const FIRST_KEY_ENV: &str = "V3_REQ09_OPTIONAL_DEBUG_FAILURE_FIRST_KEY";
const MISSING_KEY_ENV: &str = "V3_REQ09_OPTIONAL_DEBUG_FAILURE_MISSING_KEY";
const HEALTHY_KEY_ENV: &str = "V3_REQ09_OPTIONAL_DEBUG_FAILURE_HEALTHY_KEY";

const FAILURE_REQUEST_MARKER: &str = "REQ09_OPTIONAL_DEBUG_FAILURE_FAILURE_MARKER";
const HEALTHY_REQUEST_MARKER: &str = "REQ09_OPTIONAL_DEBUG_FAILURE_HEALTHY_MARKER";
const HEALTHY_RESULT_MARKER: &str = "REQ09_OPTIONAL_DEBUG_FAILURE_HEALTHY_RESULT";
const PROVIDER_ERROR_MARKER: &str = "REQ09_OPTIONAL_DEBUG_FAILURE_PROVIDER_ERROR";
const DEBUG_FAILURE_MARKER: &str = "REQ09_OPTIONAL_DEBUG_FAILURE_DIAGNOSTIC_SINK";

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
            "routecodex-v3-req09-optional-debug-failure-{label}-{}-{}",
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
        std::env::set_var(FIRST_KEY_ENV, "req09-optional-debug-failure-first-secret");
        std::env::remove_var(MISSING_KEY_ENV);
        std::env::set_var(
            HEALTHY_KEY_ENV,
            "req09-optional-debug-failure-healthy-secret",
        );
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
    release: Arc<Mutex<Option<oneshot::Receiver<()>>>>,
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
    let release = state.release.lock().await.take();
    if let Some(release) = release {
        release.await.expect("the gated upstream is released");
    }
    Response::builder()
        .status(state.status)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&*state.response_body).expect("response fixture serializes"),
        ))
        .unwrap()
}

#[allow(clippy::type_complexity)]
async fn start_gated_json_upstream(
    path: &'static str,
    status: StatusCode,
    response_body: Value,
) -> (
    String,
    mpsc::UnboundedReceiver<Value>,
    oneshot::Sender<()>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (release_tx, release_rx) = oneshot::channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route(path, post(capture_and_respond))
        .with_state(Arc::new(CaptureState {
            captures: captures_tx,
            release: Arc::new(Mutex::new(Some(release_rx))),
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
        release_tx,
        shutdown_tx,
        task,
    )
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
            release: Arc::new(Mutex::new(None)),
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
        "id": "resp_req09_optional_debug_failure_healthy",
        "object": "response",
        "created_at": 0,
        "status": "completed",
        "model": "relay-healthy-wire",
        "output": [{
            "id": "msg_req09_optional_debug_failure_healthy",
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

fn req09_optional_debug_failure_manifest(
    server_port: u16,
    first_base_url: &str,
    missing_base_url: &str,
    healthy_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let chat_direct = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
    let chat_relay = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#;
    let declaration = hub_v1_test_declaration().replace(chat_direct, chat_relay);
    let server_execution = hub_v1_server_execution("req09_optional_debug_failure");
    let source = format!(
        r#"
version = 3
{declaration}

[servers.req09_optional_debug_failure]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req09_optional_debug_failure"
endpoints = ["openai_chat"]
{server_execution}

[providers.relay_401]
type = "responses"
base_url = "{first_base_url}"
default_model = "relay-401-wire"
auth = {{ type = "api_key", entries = [{{ alias = "first_key", env = "{FIRST_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always", transport = "http" }}
[providers.relay_401.models.relay-401-wire]
wire_name = "relay-401-wire"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.relay_missing]
type = "responses"
base_url = "{missing_base_url}"
default_model = "relay-missing-wire"
auth = {{ type = "api_key", entries = [{{ alias = "missing_key", env = "{MISSING_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always", transport = "http" }}
[providers.relay_missing.models.relay-missing-wire]
wire_name = "relay-missing-wire"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.relay_healthy]
type = "responses"
base_url = "{healthy_base_url}"
default_model = "relay-healthy-wire"
auth = {{ type = "api_key", entries = [{{ alias = "healthy_key", env = "{HEALTHY_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always", transport = "http" }}
[providers.relay_healthy.models.relay-healthy-wire]
wire_name = "relay-healthy-wire"
aliases = ["req09-optional-debug-failure-healthy"]
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

[route_groups.req09_optional_debug_failure.pools.mixed]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["req09-optional-debug-failure-client"] }}
targets = [
  {{ kind = "provider_model", provider = "relay_401", model = "relay-401-wire", key = "first_key", priority = 2 }},
  {{ kind = "provider_model", provider = "relay_missing", model = "relay-missing-wire", key = "missing_key", priority = 1 }}
]

[route_groups.req09_optional_debug_failure.pools.healthy]
selection = {{ strategy = "priority" }}
match = {{ precedence = 20, entry_protocol = "openai_chat", models = ["req09-optional-debug-failure-healthy"] }}
targets = [{{ kind = "provider_model", provider = "relay_healthy", model = "relay-healthy-wire", key = "healthy_key", priority = 1 }}]

[route_groups.req09_optional_debug_failure.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "relay_missing", model = "relay-missing-wire", key = "missing_key", priority = 1 }}]
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

async fn wait_for_json_file(path: &Path) -> Value {
    for _ in 0..400 {
        if let Some(value) = read_json_file(path) {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for parseable JSON at {}", path.display());
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

async fn observe_chat_request(
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
async fn req09_optional_debug_sink_failure_keeps_provider_terminal_and_healthy_request_blackbox() {
    let _test_guard = TEST_LOCK.lock().await;
    let home_guard = TestHomeGuard::new("chat-relay");

    let (first_base_url, mut first_captures, first_release, first_shutdown, first_task) =
        start_gated_json_upstream(
            "/v1/responses",
            StatusCode::UNAUTHORIZED,
            json!({
                "error": {
                    "message": PROVIDER_ERROR_MARKER,
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

    // Keep the real Debug failure cause identifiable in the server's
    // out-of-band console line without inventing a private error channel.
    let diagnostic_log = home_guard.path.join(format!("{DEBUG_FAILURE_MARKER}.log"));
    let mut manifest = req09_optional_debug_failure_manifest(
        free_port(),
        &first_base_url,
        &missing_base_url,
        &healthy_base_url,
    );
    manifest.debug.log_file = Some(diagnostic_log.to_string_lossy().into_owned());
    let handle = spawn_v3_server_aggregate(manifest)
        .await
        .expect("aggregate server must start");
    let addr = handle.listeners[0].addr;
    let client = reqwest::Client::new();

    let failure_request = tokio::spawn({
        let client = client.clone();
        async move {
            observe_chat_request(
                &client,
                format!("http://{addr}/v1/chat/completions"),
                json!({
                    "model": "req09-optional-debug-failure-client",
                    "messages": [{"role": "user", "content": FAILURE_REQUEST_MARKER}],
                    "stream": false
                }),
            )
            .await
        }
    });

    let first_capture = timeout(Duration::from_secs(5), first_captures.recv())
        .await
        .expect("the first provider attempt must arrive")
        .expect("the first provider attempt must be captured");
    assert!(
        first_capture.to_string().contains(FAILURE_REQUEST_MARKER),
        "first upstream must receive the opaque request marker: {first_capture}"
    );
    assert_eq!(
        first_capture["model"], "relay-401-wire",
        "first upstream must receive its own wire model: {first_capture}"
    );

    fs::remove_file(&diagnostic_log).expect("remove the live debug sink before blocking it");
    fs::create_dir(&diagnostic_log).expect("replace the debug sink with a directory");
    assert!(
        diagnostic_log.is_dir(),
        "the configured Debug sink path must be blocked for the real failure: {diagnostic_log:?}"
    );

    first_release
        .send(())
        .expect("release the gated first provider response");
    let failure_observation = timeout(Duration::from_secs(15), failure_request)
        .await
        .expect("failure request task must finish")
        .expect("failure request task must not panic");

    let sample_dir =
        wait_for_sample_with_request_marker(&home_guard.samples_root(), FAILURE_REQUEST_MARKER)
            .await
            .expect("request-bound sample must exist for the failed request");
    let request_id = sample_dir
        .file_name()
        .and_then(|name| name.to_str())
        .expect("the marker-bound sample directory identifies the request");
    let provider_terminal = wait_for_json_file(&sample_dir.join("provider-terminal.json")).await;
    assert_eq!(
        provider_terminal["kind"], "no_response",
        "a local missing-auth failure has no external HTTP witness: {provider_terminal}"
    );
    assert!(
        provider_terminal.get("status").is_none(),
        "a no_response terminal must not project an external status: {provider_terminal}"
    );
    assert!(
        !provider_terminal
            .to_string()
            .contains(PROVIDER_ERROR_MARKER),
        "the no_response terminal must not inherit the earlier provider error body: \
         {provider_terminal}"
    );
    let error_evidence = wait_for_json_file(&sample_dir.join("error.json")).await;
    assert_eq!(
        error_evidence["object"], "routecodex.v3.error_evidence",
        "error.json must be the typed error-evidence artifact: {error_evidence}"
    );
    assert_eq!(
        error_evidence["status"], 598,
        "a ProviderLocalFailure terminal must keep its internal typed 598 status: {error_evidence}"
    );
    assert_eq!(
        error_evidence["request_id"], request_id,
        "error.json must bind to the failed request: {error_evidence}"
    );
    assert_eq!(
        error_evidence["error_chain"],
        json!([
            "V3Error01SourceRaised",
            "V3Error02Classified",
            "V3Error03TargetLocalAction",
            "V3Error04TargetExhaustionDecision",
            "V3Error05ExecutionDecision",
            "V3Error06ClientProjected"
        ]),
        "error.json must keep the complete typed Error chain in order: {error_evidence}"
    );

    fs::remove_dir(&diagnostic_log).expect("unblock the optional Debug sink for a new request");

    let healthy_observation = observe_chat_request(
        &client,
        format!("http://{addr}/v1/chat/completions"),
        json!({
            "model": "req09-optional-debug-failure-healthy",
            "messages": [{"role": "user", "content": HEALTHY_REQUEST_MARKER}],
            "stream": false
        }),
    )
    .await;

    let debug_logs_response = timeout(
        Duration::from_secs(10),
        client
            .get(format!("http://{addr}/_routecodex/debug/logs"))
            .send(),
    )
    .await
    .expect("debug logs request must not hang")
    .expect("debug logs request must reach the listener");
    let debug_logs_status = debug_logs_response.status();
    let debug_logs: Value = debug_logs_response
        .json()
        .await
        .expect("debug logs response must be JSON");
    assert_eq!(
        debug_logs_status,
        StatusCode::OK,
        "the optional sink failure must not break the debug endpoint"
    );
    let recorded_events = debug_logs["logs"]
        .as_array()
        .expect("debug logs must expose an event array");
    let error06_event = recorded_events
        .iter()
        .find(|event| {
            event["request_id"] == request_id && event["node_id"] == "V3Error06ClientProjected"
        })
        .expect("the failed Debug sink must still record the request-bound Error06 observer event");
    assert_eq!(
        error06_event["details"]["status"], 598,
        "the Error06 observer event must retain the typed terminal status: {error06_event}"
    );
    let error06_chain = error06_event["details"]["error_chain"].to_string();
    assert!(
        error06_chain.contains("V3Error01SourceRaised")
            && error06_chain.contains("V3Error06ClientProjected"),
        "the Error06 observer event must retain the typed cause chain: {error06_event}"
    );

    let first_extra = first_captures.try_recv().ok();
    let missing_capture = missing_captures.try_recv().ok();
    let healthy_capture = timeout(Duration::from_secs(5), healthy_captures.recv())
        .await
        .expect("healthy upstream must receive its request")
        .expect("healthy upstream capture");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let healthy_extra = healthy_captures.try_recv().ok();

    let shutdown_failures = timeout(Duration::from_secs(5), handle.shutdown())
        .await
        .expect("aggregate server shutdown must complete");

    shutdown_upstream(first_shutdown, first_task, "first gated 401 upstream").await;
    shutdown_upstream(missing_shutdown, missing_task, "missing-auth upstream").await;
    shutdown_upstream(healthy_shutdown, healthy_task, "healthy upstream").await;
    drop(home_guard);

    assert!(
        shutdown_failures.is_empty(),
        "sample persistence failures: {shutdown_failures:?}"
    );
    assert!(
        first_extra.is_none(),
        "first upstream must receive exactly one request: {first_extra:?}"
    );
    assert!(
        missing_capture.is_none(),
        "missing-auth candidate must not send a network request: {missing_capture:?}"
    );
    assert_eq!(
        healthy_capture["model"], "relay-healthy-wire",
        "healthy upstream must receive its own wire model: {healthy_capture}"
    );
    assert!(
        healthy_extra.is_none(),
        "healthy upstream must receive exactly one request: {healthy_extra:?}"
    );

    match failure_observation {
        ClientObservation::HeaderlessClose(error) => {
            assert!(
                !error.is_empty(),
                "headerless close must carry the real transport error"
            );
        }
        ClientObservation::Response { status, body } => {
            panic!(
                "provider terminal with a failing Debug sink must not return an HTTP response or payload: \
                 status={status}, body={body:?}"
            );
        }
        ClientObservation::Timeout => {
            panic!("provider terminal must end the client transport before the deadline");
        }
    }

    match healthy_observation {
        ClientObservation::Response {
            status,
            body: Ok(body),
        } => {
            assert_eq!(status, StatusCode::OK, "{body}");
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(
                body["choices"][0]["message"]["content"], HEALTHY_RESULT_MARKER,
                "independent healthy request must complete on the same aggregate: {body}"
            );
            assert!(
                !body.to_string().contains(PROVIDER_ERROR_MARKER)
                    && !body.to_string().contains(DEBUG_FAILURE_MARKER),
                "healthy response must not carry provider or Debug failure payload: {body}"
            );
        }
        other => panic!("independent healthy request must return completed JSON: {other:?}"),
    }
}
