//! REQ09 Direct same-protocol local-failure public consumer.
//!
//! This consumer drives the real aggregate server through the public
//! `/v1/responses` entry with a **Direct** Responses binding and two
//! same-protocol `responses` providers. It proves two externally observable
//! facts:
//!
//! 1. a first candidate whose auth env is missing fails locally before any
//!    network request, and the runtime reselects the second loopback candidate;
//!    the client receives the healthy native Responses result, the healthy
//!    upstream sees the complete exec / free-text apply_patch / MCP tool history
//!    exactly once, and the bad upstream is never contacted;
//! 2. a single missing-auth candidate with no healthy fallback aborts the client
//!    transport without any provider error JSON, while the request-bound typed
//!    diagnostics keep the typed `provider_local_runtime_error` source and its
//!    internal registry code without an external HTTP witness. The public Error
//!    consumer separately verifies the internal `598` classification.
//!
//! The test is deliberately black-box: it uses the public HTTP entry, real
//! loopback upstreams, the real config compiler, and the aggregate listener. It
//! never calls a private runtime helper or inspects typed transport internals.

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

const HEALTHY_KEY_ENV: &str = "V3_REQ09_DIRECT_LOCAL_FAILURE_HEALTHY_KEY";
const MISSING_KEY_ENV: &str = "V3_REQ09_DIRECT_LOCAL_FAILURE_MISSING_KEY";
const CLIENT_MODEL: &str = "req09-direct-local-failure";
const REQUEST_MARKER: &str = "REQ09_DIRECT_LOCAL_FAILURE_REQUEST_MARKER";
const HEALTHY_RESPONSE_TEXT: &str = "req09 direct local failure recovery ok";
const RESPONSES_SAMPLE_DIR: &str = "openai-responses";

/// Isolated HOME so the aggregate server's sample store and diagnostics never
/// touch the operator's real `~/.rcc`.
struct TestHomeGuard {
    previous_home: Option<OsString>,
    previous_healthy_key: Option<OsString>,
    previous_missing_key: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "routecodex-v3-req09-direct-local-failure-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        let previous_home = std::env::var_os("HOME");
        let previous_healthy_key = std::env::var_os(HEALTHY_KEY_ENV);
        let previous_missing_key = std::env::var_os(MISSING_KEY_ENV);
        std::env::set_var("HOME", &path);
        std::env::set_var(HEALTHY_KEY_ENV, "req09-direct-local-failure-healthy-secret");
        std::env::remove_var(MISSING_KEY_ENV);
        Self {
            previous_home,
            previous_healthy_key,
            previous_missing_key,
            path,
        }
    }

    /// `<HOME>/.rcc/codex-samples/<endpoint-dir>/ports/<port>`.
    fn endpoint_samples_root(&self, endpoint_dir: &str, port: u16) -> PathBuf {
        self.path
            .join(".rcc")
            .join("codex-samples")
            .join(endpoint_dir)
            .join("ports")
            .join(port.to_string())
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous_home {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(previous) = &self.previous_healthy_key {
            std::env::set_var(HEALTHY_KEY_ENV, previous);
        } else {
            std::env::remove_var(HEALTHY_KEY_ENV);
        }
        if let Some(previous) = &self.previous_missing_key {
            std::env::set_var(MISSING_KEY_ENV, previous);
        } else {
            std::env::remove_var(MISSING_KEY_ENV);
        }
        fs::remove_dir_all(&self.path).expect("remove this test's isolated HOME");
    }
}

#[derive(Clone)]
struct ResponsesUpstreamState {
    captures: mpsc::UnboundedSender<Value>,
    text: Arc<str>,
}

/// Real loopback provider upstream. It records every provider request so
/// "which upstream received the request" is the externally observable proof of
/// the selected candidate, and answers with a native Responses terminal JSON
/// (or the SSE equivalent when the wire asks for streaming).
async fn capture_responses_request(
    State(state): State<Arc<ResponsesUpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let stream = body.get("stream").and_then(Value::as_bool) == Some(true);
    state
        .captures
        .send(body)
        .expect("capture receiver remains live");
    let text = state.text.to_string();
    if stream {
        let sse = format!(
            "event: response.created\n\
             data: {{\"type\":\"response.created\",\"response\":{{\"id\":\"resp_req09_direct_local_failure\",\"status\":\"in_progress\"}}}}\n\n\
             event: response.completed\n\
             data: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_req09_direct_local_failure\",\"status\":\"completed\",\"output\":[{{\"type\":\"output_text\",\"text\":\"{text}\"}}]}}}}\n\n\
             data: [DONE]\n\n"
        );
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(sse))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "id": "resp_req09_direct_local_failure",
                    "object": "response",
                    "status": "completed",
                    "output_text": text.clone(),
                    "output": [{"type": "output_text", "text": text}]
                }))
                .unwrap(),
            ))
            .unwrap()
    }
}

/// The first candidate uses missing env auth, so its base URL must never be
/// reached. This upstream exists only so an accidental HTTP attempt is
/// observable instead of silently failing.
async fn capture_bad_request(
    State(state): State<Arc<ResponsesUpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(body)
        .expect("bad capture receiver remains live");
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "id": "resp_req09_bad_unexpected",
                "status": "completed",
                "output": [{"type": "output_text", "text": "bad upstream must never be reached"}]
            }))
            .unwrap(),
        ))
        .unwrap()
}

async fn start_responses_upstream(
    text: &str,
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
        .route("/v1/responses", post(capture_responses_request))
        .with_state(Arc::new(ResponsesUpstreamState {
            captures: captures_tx,
            text: Arc::from(text),
        }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown_rx
                    .await
                    .expect("responses upstream shutdown signal");
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

/// Aggregate manifest with two same-protocol `responses` providers and a
/// Direct Responses entry. The `responses` pool orders the missing-auth
/// `bad_responses` candidate first (priority 2) and, when `healthy_fallback` is
/// set, the loopback `healthy_responses` candidate second (priority 1). When
/// `healthy_fallback` is unset, neither the `responses` pool nor the default
/// pool has any healthy candidate.
fn req09_direct_local_failure_manifest(
    server_port: u16,
    bad_base_url: &str,
    healthy_base_url: &str,
    healthy_fallback: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let hub_v1_declaration = hub_v1_test_declaration();
    let server_execution = hub_v1_server_execution("req09_direct_local_failure");
    let pool_extra = if healthy_fallback {
        ",\n  { kind = \"provider_model\", provider = \"healthy_responses\", model = \"healthy-responses-wire\", key = \"key\", priority = 1 }"
    } else {
        ""
    };
    let default_targets = if healthy_fallback {
        "[{ kind = \"provider_model\", provider = \"healthy_responses\", model = \"healthy-responses-wire\", key = \"key\", priority = 1 }]"
    } else {
        "[{ kind = \"provider_model\", provider = \"bad_responses\", model = \"bad-responses-wire\", key = \"key\", priority = 1 }]"
    };
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}

[servers.req09_direct_local_failure]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req09_direct_local_failure"
endpoints = ["responses"]
{server_execution}

[providers.bad_responses]
type = "responses"
base_url = "{bad_base_url}"
default_model = "bad-responses-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{MISSING_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.bad_responses.models.bad-responses-wire]
wire_name = "bad-responses-wire"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.healthy_responses]
type = "responses"
base_url = "{healthy_base_url}"
default_model = "healthy-responses-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{HEALTHY_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.healthy_responses.models.healthy-responses-wire]
wire_name = "healthy-responses-wire"
aliases = ["{CLIENT_MODEL}"]
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

[route_groups.req09_direct_local_failure.pools.responses]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["{CLIENT_MODEL}"] }}
targets = [{{ kind = "provider_model", provider = "bad_responses", model = "bad-responses-wire", key = "key", priority = 2 }}{pool_extra}]

[route_groups.req09_direct_local_failure.pools.default]
selection = {{ strategy = "priority" }}
targets = {default_targets}
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

/// The exact native Responses public request shape: an ordinary `exec_command`
/// function declaration, a native free-text `custom` `apply_patch` declaration,
/// and an ordinary MCP function declaration, each paired with its full
/// call/output history.
fn direct_tool_fidelity_request() -> Value {
    json!({
        "model": CLIENT_MODEL,
        "stream": false,
        "tools": [
            {"type": "function", "name": "exec_command", "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}, "required": ["cmd"]}},
            {"type": "custom", "name": "apply_patch", "format": {"type": "text"}},
            {"type": "function", "name": "mcp__req09__opaque_tool", "parameters": {"type": "object", "properties": {"opaque": {"type": "string"}}, "required": ["opaque"]}}
        ],
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": REQUEST_MARKER}]},
            {"type": "function_call", "call_id": "call_req09_direct_exec", "name": "exec_command", "arguments": "{\"cmd\":\"printf '%s\\n' 'REQ09_DIRECT_LOCAL_FAILURE_EXEC'\\nprintf '%s\\n' 'REQ09_DIRECT_LOCAL_FAILURE_EXEC_TAIL'\"}"},
            {"type": "function_call_output", "call_id": "call_req09_direct_exec", "output": "REQ09_DIRECT_LOCAL_FAILURE_EXEC\nREQ09_DIRECT_LOCAL_FAILURE_EXEC_TAIL\n"},
            {"type": "custom_tool_call", "call_id": "call_req09_direct_patch", "name": "apply_patch", "input": "*** Begin Patch\n*** Add File: req09.txt\n+REQ09_DIRECT_LOCAL_FAILURE_PATCH\n+REQ09_DIRECT_LOCAL_FAILURE_PATCH_TAIL\n*** End Patch\n"},
            {"type": "custom_tool_call_output", "call_id": "call_req09_direct_patch", "output": "Success. Updated the following files:\nA req09.txt\n"},
            {"type": "function_call", "call_id": "call_req09_direct_mcp", "name": "mcp__req09__opaque_tool", "arguments": "{\"opaque\":\"REQ09_DIRECT_LOCAL_FAILURE_MCP_ARGUMENT_TAIL\"}"},
            {"type": "function_call_output", "call_id": "call_req09_direct_mcp", "output": "{\"opaque\":\"REQ09_DIRECT_LOCAL_FAILURE_MCP_RESULT_TAIL\"}"}
        ]
    })
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

fn find_responses_tool<'a>(body: &'a Value, name: &str) -> Option<&'a Value> {
    body["tools"]
        .as_array()?
        .iter()
        .find(|tool| tool["name"] == name)
}

fn find_responses_input<'a>(body: &'a Value, item_type: &str, call_id: &str) -> Option<&'a Value> {
    body["input"]
        .as_array()?
        .iter()
        .find(|item| item["type"] == item_type && item["call_id"] == call_id)
}

/// Assert the healthy same-protocol provider received the complete Responses
/// request: the request marker, the full tool declarations, and every paired
/// call/output item.
fn assert_same_protocol_tool_fidelity(capture: &Value) {
    assert_eq!(
        capture["model"], "healthy-responses-wire",
        "the upstream must receive the selected target wire model: {capture}"
    );
    assert!(
        capture.to_string().contains(REQUEST_MARKER),
        "the request marker must reach the healthy upstream intact: {capture}"
    );

    let exec_tool = find_responses_tool(capture, "exec_command").unwrap_or_else(|| {
        panic!("the exec_command function declaration must reach the healthy upstream: {capture}")
    });
    assert_eq!(exec_tool["type"], "function", "{capture}");
    assert_eq!(
        exec_tool["parameters"]["required"],
        json!(["cmd"]),
        "{capture}"
    );

    let patch_tool = find_responses_tool(capture, "apply_patch").unwrap_or_else(|| {
        panic!(
            "the native free-text apply_patch declaration must reach the healthy upstream: {capture}"
        )
    });
    assert_eq!(
        patch_tool["type"], "custom",
        "apply_patch must stay the native custom/free-text tool: {capture}"
    );
    assert_eq!(patch_tool["format"]["type"], "text", "{capture}");

    let mcp_tool = find_responses_tool(capture, "mcp__req09__opaque_tool").unwrap_or_else(|| {
        panic!("the MCP function declaration must reach the healthy upstream: {capture}")
    });
    assert_eq!(mcp_tool["type"], "function", "{capture}");

    let exec_call = find_responses_input(capture, "function_call", "call_req09_direct_exec")
        .unwrap_or_else(|| {
            panic!("the paired exec_command call must reach the healthy upstream: {capture}")
        });
    assert_eq!(exec_call["name"], "exec_command", "{capture}");
    assert!(
        exec_call["arguments"]
            .as_str()
            .is_some_and(|arguments| arguments.contains("REQ09_DIRECT_LOCAL_FAILURE_EXEC")),
        "the exec command string must be preserved: {capture}"
    );

    let exec_result =
        find_responses_input(capture, "function_call_output", "call_req09_direct_exec")
            .unwrap_or_else(|| {
                panic!("the matched exec_command result must reach the healthy upstream: {capture}")
            });
    assert!(
        exec_result["output"]
            .as_str()
            .is_some_and(|output| output.contains("REQ09_DIRECT_LOCAL_FAILURE_EXEC_TAIL")),
        "the matched exec result must be preserved: {capture}"
    );

    let patch_call = find_responses_input(capture, "custom_tool_call", "call_req09_direct_patch")
        .unwrap_or_else(|| {
            panic!(
                "the native free-text apply_patch call must reach the healthy upstream: {capture}"
            )
        });
    assert_eq!(patch_call["name"], "apply_patch", "{capture}");
    assert!(
        patch_call["input"].as_str().is_some_and(|input| {
            input.contains("*** Begin Patch")
                && input.contains("REQ09_DIRECT_LOCAL_FAILURE_PATCH_TAIL")
        }),
        "the complete free-text apply_patch body must be preserved: {capture}"
    );

    let patch_result = find_responses_input(
        capture,
        "custom_tool_call_output",
        "call_req09_direct_patch",
    )
    .unwrap_or_else(|| {
        panic!("the matched apply_patch result must reach the healthy upstream: {capture}")
    });
    assert!(
        patch_result["output"]
            .as_str()
            .is_some_and(|output| output.contains("A req09.txt")),
        "the matched apply_patch result must be preserved: {capture}"
    );

    let mcp_call = find_responses_input(capture, "function_call", "call_req09_direct_mcp")
        .unwrap_or_else(|| {
            panic!("the MCP function call must reach the healthy upstream: {capture}")
        });
    assert_eq!(mcp_call["name"], "mcp__req09__opaque_tool", "{capture}");
    assert!(
        mcp_call["arguments"].as_str().is_some_and(
            |arguments| arguments.contains("REQ09_DIRECT_LOCAL_FAILURE_MCP_ARGUMENT_TAIL")
        ),
        "the MCP argument payload must be preserved: {capture}"
    );

    let mcp_result = find_responses_input(capture, "function_call_output", "call_req09_direct_mcp")
        .unwrap_or_else(|| {
            panic!("the matched MCP function result must reach the healthy upstream: {capture}")
        });
    assert!(
        mcp_result["output"]
            .as_str()
            .is_some_and(|output| output.contains("REQ09_DIRECT_LOCAL_FAILURE_MCP_RESULT_TAIL")),
        "the matched MCP result must be preserved: {capture}"
    );
}

fn assert_no_client_error_body(label: &str, body: &Value) {
    assert!(
        body.get("error").is_none() || body["error"].is_null(),
        "{label}: client body must not contain an error object: {body}"
    );
    assert!(
        body["type"] != "error",
        "{label}: client body must not be an error envelope: {body}"
    );
    assert!(
        !body.to_string().contains("response.failed"),
        "{label}: client body must not contain response.failed: {body}"
    );
    assert!(
        !body.to_string().contains("event: error"),
        "{label}: client body must not contain an SSE error event: {body}"
    );
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
async fn req09_direct_same_protocol_reselects_after_missing_auth_first_candidate_blackbox() {
    assert_direct_reselects_after_local_failure(false).await;
}

#[tokio::test]
async fn req09_direct_same_protocol_reselects_after_invalid_url_constructor_blackbox() {
    assert_direct_reselects_after_local_failure(true).await;
}

async fn assert_direct_reselects_after_local_failure(invalid_url: bool) {
    let _test_guard = TEST_LOCK.lock().await;
    let home_guard = TestHomeGuard::new("reselect");

    let (bad_base_url, mut bad_captures, bad_shutdown, bad_task) =
        start_bad_responses_upstream().await;
    let (healthy_base_url, mut healthy_captures, healthy_shutdown, healthy_task) =
        start_responses_upstream(HEALTHY_RESPONSE_TEXT).await;

    let failed_base_url = if invalid_url {
        "::not-a-url::"
    } else {
        &bad_base_url
    };
    let manifest =
        req09_direct_local_failure_manifest(free_port(), failed_base_url, &healthy_base_url, true);
    let handle = spawn_v3_server_aggregate(manifest)
        .await
        .expect("aggregate server must start");
    let addr = handle.listeners[0].addr;
    let client = reqwest::Client::new();

    let request = direct_tool_fidelity_request();
    let response = timeout(
        Duration::from_secs(10),
        client
            .post(format!("http://{addr}/v1/responses"))
            .json(&request)
            .send(),
    )
    .await;
    let observation = match response {
        Ok(Ok(response)) => {
            let status = response.status();
            Ok((status, response.json::<Value>().await))
        }
        Ok(Err(error)) => Err(error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let capture = timeout(Duration::from_secs(5), healthy_captures.recv()).await;
    let extra_capture = timeout(Duration::from_millis(100), healthy_captures.recv()).await;
    let bad_capture = bad_captures.try_recv().ok();
    let failures = timeout(Duration::from_secs(5), handle.shutdown())
        .await
        .expect("aggregate server shutdown must complete");
    shutdown_upstream(bad_shutdown, bad_task, "bad upstream").await;
    shutdown_upstream(healthy_shutdown, healthy_task, "healthy upstream").await;
    drop(home_guard);

    assert!(
        failures.is_empty(),
        "sample persistence failures: {failures:?}"
    );
    let (status, body) = observation
        .expect("the healthy second candidate must return a client response before the deadline");
    assert_eq!(status, StatusCode::OK);
    let body = body.expect("client body must be JSON");
    assert_eq!(body["status"], "completed", "{body}");
    assert!(
        body.to_string().contains(HEALTHY_RESPONSE_TEXT),
        "the client must receive the healthy native Responses completed text: {body}"
    );
    assert_no_client_error_body("Direct responses", &body);

    let capture = capture
        .expect("the healthy candidate must be reached before the deadline")
        .expect("healthy capture channel remains live");
    assert_same_protocol_tool_fidelity(&capture);
    assert!(
        extra_capture.is_err(),
        "the healthy upstream must be called exactly once"
    );

    // The first candidate fails locally before any HTTP attempt, so the bad
    // upstream cannot have been contacted.
    assert!(
        bad_capture.is_none(),
        "the missing-auth first candidate must never send an HTTP request"
    );
}

#[tokio::test]
async fn req09_direct_single_missing_auth_candidate_aborts_without_provider_error_blackbox() {
    let _test_guard = TEST_LOCK.lock().await;
    let home_guard = TestHomeGuard::new("single-candidate");

    let (bad_base_url, mut bad_captures, bad_shutdown, bad_task) =
        start_bad_responses_upstream().await;
    let (healthy_base_url, mut healthy_captures, healthy_shutdown, healthy_task) =
        start_responses_upstream(HEALTHY_RESPONSE_TEXT).await;

    let mut manifest =
        req09_direct_local_failure_manifest(free_port(), &bad_base_url, &healthy_base_url, false);
    let diagnostic_log = home_guard
        .path
        .join("req09-direct-local-failure-events.log");
    manifest.debug.log_file = Some(diagnostic_log.to_string_lossy().into_owned());

    let handle = spawn_v3_server_aggregate(manifest)
        .await
        .expect("aggregate server must start");
    let addr = handle.listeners[0].addr;
    let client = reqwest::Client::new();

    let request = direct_tool_fidelity_request();
    let observation = timeout(
        Duration::from_secs(5),
        client
            .post(format!("http://{addr}/v1/responses"))
            .json(&request)
            .send(),
    )
    .await
    .expect(
        "the single missing-auth request must reach a terminal transport outcome before the deadline",
    );

    let client_error = observation.expect_err(
        "a missing-auth local failure must close the non-streaming client without a payload",
    );
    assert!(
        !client_error.is_status(),
        "the client must never receive a projected HTTP error status: {client_error}"
    );

    assert!(
        bad_captures.try_recv().is_err(),
        "a missing-auth local construction failure must never contact the provider"
    );
    assert!(
        healthy_captures.try_recv().is_err(),
        "the manifest has no healthy fallback candidate to contact"
    );

    let samples_root = home_guard.endpoint_samples_root(RESPONSES_SAMPLE_DIR, addr.port());
    let sample_dir = wait_for_sample_with_request_marker(&samples_root, REQUEST_MARKER)
        .await
        .expect(
            "the local failure must leave request-bound typed Error evidence bound to the marker",
        );
    let request_json =
        read_json_file(&sample_dir.join("request.json")).expect("request.json must be parseable");
    assert!(
        request_json.to_string().contains(REQUEST_MARKER),
        "request.json must bind the failing request: {request_json}"
    );

    let failures = timeout(Duration::from_secs(5), handle.shutdown())
        .await
        .expect("aggregate server shutdown must complete");
    assert!(
        failures.is_empty(),
        "sample persistence failures: {failures:?}"
    );
    shutdown_upstream(bad_shutdown, bad_task, "bad upstream").await;
    shutdown_upstream(healthy_shutdown, healthy_task, "healthy upstream").await;

    // The ProviderTerminal path persists provider-private terminal evidence;
    // it does not produce an error.json client projection. Verify the actual
    // public diagnostics after lifecycle teardown has flushed them.
    let provider_terminal = read_json_file(&sample_dir.join("provider-terminal.json"))
        .expect("the provider terminal must be captured");
    assert_eq!(
        provider_terminal["kind"], "no_response",
        "a local missing-auth failure has no external HTTP witness: {provider_terminal}"
    );
    let diagnostic_events = fs::read_to_string(&diagnostic_log).expect("configured event log");
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
        .find(|event| {
            event.contains(&format!("req={request_id} ")) && event.contains("[provider-error]")
        })
        .expect("the provider failure diagnostic must match the sampled request ID");
    assert!(
        provider_event.contains("type=provider_local_runtime_error ")
            && provider_event.contains("internalCode=500-160"),
        "the original typed source and internal registry code must survive: {provider_event}"
    );
    assert!(
        provider_event.contains("auth handle key has no secret"),
        "the original missing-auth cause must remain observable: {provider_event}"
    );
    assert!(
        !provider_event.contains("externalStatus=") && !provider_event.contains("network_error"),
        "a local failure must retain its source without an invented external HTTP status: {provider_event}"
    );
    drop(home_guard);
}

async fn start_bad_responses_upstream() -> (
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
        .fallback(capture_bad_request)
        .with_state(Arc::new(ResponsesUpstreamState {
            captures: captures_tx,
            text: Arc::from("unused"),
        }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown_rx
                    .await
                    .expect("bad responses upstream shutdown signal");
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
