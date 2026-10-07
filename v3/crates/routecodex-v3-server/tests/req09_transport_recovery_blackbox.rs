//! REQ09 transport-recovery public consumer.
//!
//! This consumer drives the real aggregate server through all four enabled
//! model-entry protocols. Each request selects a pool whose first candidate
//! fails locally before an HTTP request can be sent. The second candidate must
//! be selected and must receive exactly one real loopback request.
//!
//! The test is deliberately black-box: it uses public HTTP entries, real
//! loopback upstreams, the real config compiler, and the aggregate listener.
//! It does not call runtime helpers directly or inspect private state.

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

const HEALTHY_KEY_ENV: &str = "V3_REQ09_RECOVERY_HEALTHY_KEY";
const MISSING_KEY_ENV: &str = "V3_REQ09_RECOVERY_MISSING_KEY";

const RESPONSES_MARKER: &str = "REQ09_RECOVERY_RESPONSES_REQUEST_TEXT";
const CHAT_MARKER: &str = "REQ09_RECOVERY_CHAT_REQUEST_TEXT";
const ANTHROPIC_MARKER: &str = "REQ09_RECOVERY_ANTHROPIC_REQUEST_TEXT";
const GEMINI_MARKER: &str = "REQ09_RECOVERY_GEMINI_REQUEST_TEXT";
const TOOL_SCHEMA_MARKER: &str = "REQ09_RECOVERY_TOOL_SCHEMA_TEXT";

/// Isolated HOME so samples and diagnostics cannot touch the operator's real
/// `~/.rcc`.
struct TestHomeGuard {
    previous_home: Option<OsString>,
    previous_healthy_key: Option<OsString>,
    previous_missing_key: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "routecodex-v3-req09-recovery-{label}-{}-{}",
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
        std::env::set_var(HEALTHY_KEY_ENV, "req09-recovery-healthy-secret");
        std::env::remove_var(MISSING_KEY_ENV);
        Self {
            previous_home,
            previous_healthy_key,
            previous_missing_key,
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
struct CaptureState {
    captures: mpsc::UnboundedSender<Value>,
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
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&*state.response_body).expect("response fixture serializes"),
        ))
        .unwrap()
}

async fn start_json_upstream(
    path: &'static str,
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
    (format!("http://{address}"), captures_rx, shutdown_tx, task)
}

async fn start_bad_upstream() -> (
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
        .fallback(capture_and_respond)
        .with_state(Arc::new(CaptureState {
            captures: captures_tx,
            response_body: Arc::new(json!({"unexpected": true})),
        }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown_rx.await.expect("bad upstream shutdown signal");
            })
            .await
            .unwrap();
    });
    (format!("http://{address}"), captures_rx, shutdown_tx, task)
}

fn chat_response(text: &str) -> Value {
    json!({
        "id": "chatcmpl-req09-recovery",
        "object": "chat.completion",
        "created": 0,
        "model": "healthy-chat-wire",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
    })
}

fn anthropic_response(text: &str) -> Value {
    json!({
        "id": "msg_req09_recovery",
        "type": "message",
        "role": "assistant",
        "model": "healthy-anthropic-wire",
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": null,
        "usage": {"input_tokens": 3, "output_tokens": 2}
    })
}

fn gemini_response(text: &str) -> Value {
    json!({
        "candidates": [{
            "index": 0,
            "finishReason": "STOP",
            "content": {"role": "model", "parts": [{"text": text}]}
        }],
        "usageMetadata": {
            "promptTokenCount": 3,
            "candidatesTokenCount": 2,
            "totalTokenCount": 5
        }
    })
}

/// Build a manifest with explicit Relay bindings for the two entry protocols
/// whose shared fixture default is Direct. Anthropic and Gemini are already
/// Relay entries in the shared fixture.
fn req09_recovery_manifest(
    server_port: u16,
    bad_base_url: &str,
    healthy_responses_base_url: &str,
    healthy_chat_base_url: &str,
    healthy_anthropic_base_url: &str,
    healthy_gemini_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let responses_direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let responses_relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let chat_direct = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
    let chat_relay = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#;

    let declaration = hub_v1_test_declaration()
        .replace(responses_direct, responses_relay)
        .replace(chat_direct, chat_relay);
    let server_execution = hub_v1_server_execution("req09_recovery");
    let source = format!(
        r#"
version = 3
{declaration}

[servers.req09_recovery]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req09_recovery"
endpoints = ["responses", "anthropic", "gemini", "openai_chat"]
{server_execution}

[providers.bad_responses]
type = "openai_chat"
base_url = "{bad_base_url}/v1"
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
type = "openai_chat"
base_url = "{healthy_responses_base_url}/v1"
default_model = "healthy-responses-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{HEALTHY_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.healthy_responses.models.healthy-responses-wire]
wire_name = "healthy-responses-wire"
aliases = ["req09-recovery-responses"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.bad_chat]
type = "openai_chat"
base_url = "{bad_base_url}/v1"
default_model = "bad-chat-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{MISSING_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.bad_chat.models.bad-chat-wire]
wire_name = "bad-chat-wire"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.healthy_chat]
type = "openai_chat"
base_url = "{healthy_chat_base_url}/v1"
default_model = "healthy-chat-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{HEALTHY_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.healthy_chat.models.healthy-chat-wire]
wire_name = "healthy-chat-wire"
aliases = ["req09-recovery-chat"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.bad_anthropic]
type = "anthropic"
base_url = "{bad_base_url}"
default_model = "bad-anthropic-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{MISSING_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.bad_anthropic.models.bad-anthropic-wire]
wire_name = "bad-anthropic-wire"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.healthy_anthropic]
type = "anthropic"
base_url = "{healthy_anthropic_base_url}"
default_model = "healthy-anthropic-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{HEALTHY_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.healthy_anthropic.models.healthy-anthropic-wire]
wire_name = "healthy-anthropic-wire"
aliases = ["req09-recovery-anthropic"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.bad_gemini]
type = "gemini"
base_url = "{bad_base_url}/v1beta"
default_model = "bad-gemini-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{MISSING_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.bad_gemini.models.bad-gemini-wire]
wire_name = "bad-gemini-wire"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.healthy_gemini]
type = "gemini"
base_url = "{healthy_gemini_base_url}/v1beta"
default_model = "healthy-gemini-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{HEALTHY_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.healthy_gemini.models.healthy-gemini-wire]
wire_name = "healthy-gemini-wire"
aliases = ["req09-recovery-gemini"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[debug]
log_console = false
snapshots = true
codex_samples = true
snapshot_stages = "client-request,client-response"
dry_run = false
retention = {{ raw_requests = 16, raw_responses = 16, events = 256 }}

[route_groups.req09_recovery.pools.responses]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["req09-recovery-responses"] }}
targets = [
  {{ kind = "provider_model", provider = "bad_responses", model = "bad-responses-wire", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "healthy_responses", model = "healthy-responses-wire", key = "key", priority = 1 }}
]

[route_groups.req09_recovery.pools.chat]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["req09-recovery-chat"] }}
targets = [
  {{ kind = "provider_model", provider = "bad_chat", model = "bad-chat-wire", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "healthy_chat", model = "healthy-chat-wire", key = "key", priority = 1 }}
]

[route_groups.req09_recovery.pools.anthropic]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "anthropic", models = ["req09-recovery-anthropic"] }}
targets = [
  {{ kind = "provider_model", provider = "bad_anthropic", model = "bad-anthropic-wire", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "healthy_anthropic", model = "healthy-anthropic-wire", key = "key", priority = 1 }}
]

[route_groups.req09_recovery.pools.gemini]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "gemini", models = ["req09-recovery-gemini"] }}
targets = [
  {{ kind = "provider_model", provider = "bad_gemini", model = "bad-gemini-wire", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "healthy_gemini", model = "healthy-gemini-wire", key = "key", priority = 1 }}
]

[route_groups.req09_recovery.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "healthy_responses", model = "healthy-responses-wire", key = "key", priority = 1 }}]
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

async fn wait_for_json_file(path: &Path) -> Option<Value> {
    for _ in 0..40 {
        if let Some(value) = read_json_file(path) {
            return Some(value);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    None
}

/// The failed attempt must be observable in request-bound evidence when the
/// runtime emits it. Successful recovery must still leave the request sample.
async fn assert_request_bound_diagnostics(home: &TestHomeGuard, marker: &str) {
    let sample_dir = wait_for_sample_with_request_marker(&home.samples_root(), marker)
        .await
        .unwrap_or_else(|| {
            panic!(
                "request-specific sample must bind marker {marker} under {:?}",
                home.samples_root()
            )
        });
    let request_json =
        read_json_file(&sample_dir.join("request.json")).expect("request.json must be parseable");
    assert!(
        request_json.to_string().contains(marker),
        "request.json must contain the request marker {marker}: {request_json}"
    );

    if let Some(error_json) = wait_for_json_file(&sample_dir.join("error.json")).await {
        assert_eq!(
            error_json["object"], "routecodex.v3.error_evidence",
            "request-bound Error evidence must keep its typed object: {error_json}"
        );
        if let (Some(request_id), Some(error_request_id)) = (
            request_json["request_id"].as_str(),
            error_json["request_id"].as_str(),
        ) {
            assert_eq!(
                request_id, error_request_id,
                "request-bound Error evidence must carry the same request id"
            );
        }
        let chain = error_json["error_chain"]
            .as_array()
            .unwrap_or_else(|| panic!("error_chain must be an array: {error_json}"));
        assert!(
            chain.iter().any(|node| node == "V3Error01SourceRaised"),
            "typed Error evidence must retain its source node: {error_json}"
        );
    }

    if let Some(provider_terminal) =
        wait_for_json_file(&sample_dir.join("provider-terminal.json")).await
    {
        if let (Some(request_id), Some(terminal_request_id)) = (
            request_json["request_id"].as_str(),
            provider_terminal["request_id"].as_str(),
        ) {
            assert_eq!(
                request_id, terminal_request_id,
                "provider-terminal evidence must bind the same request id"
            );
        }
    }
}

async fn assert_one_healthy_capture(
    captures: &mut mpsc::UnboundedReceiver<Value>,
    label: &str,
    request_marker: &str,
    tool_marker: &str,
) -> Value {
    let capture = timeout(Duration::from_secs(5), captures.recv())
        .await
        .unwrap_or_else(|_| panic!("{label}: healthy upstream was not called"))
        .unwrap_or_else(|| panic!("{label}: healthy upstream capture channel closed"));
    let serialized = capture.to_string();
    assert!(
        serialized.contains(request_marker),
        "{label}: request text must reach the healthy upstream intact: {capture}"
    );
    assert!(
        serialized.contains(tool_marker),
        "{label}: tool schema text must reach the healthy upstream intact: {capture}"
    );
    assert!(
        serialized.contains("req09_lookup"),
        "{label}: tool name must reach the healthy upstream intact: {capture}"
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        captures.try_recv().is_err(),
        "{label}: healthy upstream must be called exactly once"
    );
    capture
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
async fn req09_recovery_four_public_protocols_reselect_after_local_first_candidate_failure_blackbox(
) {
    let _test_guard = TEST_LOCK.lock().await;
    let home_guard = TestHomeGuard::new("four-protocols");

    let (bad_base_url, mut bad_captures, bad_shutdown, bad_task) = start_bad_upstream().await;
    let (healthy_responses_base_url, mut responses_captures, responses_shutdown, responses_task) =
        start_json_upstream(
            "/v1/chat/completions",
            chat_response("req09 responses recovery ok"),
        )
        .await;
    let (healthy_chat_base_url, mut chat_captures, chat_shutdown, chat_task) = start_json_upstream(
        "/v1/chat/completions",
        chat_response("req09 chat recovery ok"),
    )
    .await;
    let (healthy_anthropic_base_url, mut anthropic_captures, anthropic_shutdown, anthropic_task) =
        start_json_upstream(
            "/v1/messages",
            anthropic_response("req09 anthropic recovery ok"),
        )
        .await;
    let (healthy_gemini_base_url, mut gemini_captures, gemini_shutdown, gemini_task) =
        start_json_upstream(
            "/v1beta/models/healthy-gemini-wire:generateContent",
            gemini_response("req09 gemini recovery ok"),
        )
        .await;

    let mut manifest = req09_recovery_manifest(
        free_port(),
        &bad_base_url,
        &healthy_responses_base_url,
        &healthy_chat_base_url,
        &healthy_anthropic_base_url,
        &healthy_gemini_base_url,
    );
    manifest.debug.log_file = Some(
        home_guard
            .path
            .join("recovery-events.jsonl")
            .to_string_lossy()
            .into_owned(),
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let addr = handle.listeners[0].addr;
    let client = reqwest::Client::new();

    // Responses entry, explicitly pinned to Relay in the real config.
    let responses = client
        .post(format!("http://{addr}/v1/responses"))
        .json(&json!({
            "model": "req09-recovery-responses",
            "input": RESPONSES_MARKER,
            "tools": [{
                "type": "function",
                "name": "req09_lookup",
                "description": TOOL_SCHEMA_MARKER,
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"]
                }
            }],
            "stream": false
        }))
        .send()
        .await
        .expect("Responses entry must return a client response");
    assert_eq!(responses.status(), StatusCode::OK);
    let responses_body: Value = responses.json().await.unwrap();
    assert_eq!(responses_body["status"], "completed", "{responses_body}");
    assert!(
        responses_body
            .to_string()
            .contains("req09 responses recovery ok"),
        "Responses entry must return the healthy upstream text: {responses_body}"
    );
    assert_no_client_error_body("Responses", &responses_body);
    let _responses_capture = assert_one_healthy_capture(
        &mut responses_captures,
        "Responses",
        RESPONSES_MARKER,
        TOOL_SCHEMA_MARKER,
    )
    .await;
    assert_request_bound_diagnostics(&home_guard, RESPONSES_MARKER).await;

    // OpenAI Chat entry, also explicitly pinned to Relay in the real config.
    let chat = client
        .post(format!("http://{addr}/v1/chat/completions"))
        .json(&json!({
            "model": "req09-recovery-chat",
            "messages": [{"role": "user", "content": CHAT_MARKER}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "req09_lookup",
                    "description": TOOL_SCHEMA_MARKER,
                    "parameters": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"]
                    }
                }
            }],
            "stream": false
        }))
        .send()
        .await
        .expect("OpenAI Chat entry must return a client response");
    assert_eq!(chat.status(), StatusCode::OK);
    let chat_body: Value = chat.json().await.unwrap();
    assert_eq!(
        chat_body["choices"][0]["message"]["content"], "req09 chat recovery ok",
        "{chat_body}"
    );
    assert_no_client_error_body("OpenAI Chat", &chat_body);
    let _chat_capture = assert_one_healthy_capture(
        &mut chat_captures,
        "OpenAI Chat",
        CHAT_MARKER,
        TOOL_SCHEMA_MARKER,
    )
    .await;
    assert_request_bound_diagnostics(&home_guard, CHAT_MARKER).await;

    // Anthropic Messages entry.
    let anthropic = client
        .post(format!("http://{addr}/v1/messages"))
        .json(&json!({
            "model": "req09-recovery-anthropic",
            "max_tokens": 64,
            "messages": [{"role": "user", "content": ANTHROPIC_MARKER}],
            "tools": [{
                "name": "req09_lookup",
                "description": TOOL_SCHEMA_MARKER,
                "input_schema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"]
                }
            }],
            "stream": false
        }))
        .send()
        .await
        .expect("Anthropic entry must return a client response");
    assert_eq!(anthropic.status(), StatusCode::OK);
    let anthropic_body: Value = anthropic.json().await.unwrap();
    assert_eq!(
        anthropic_body["content"][0]["text"], "req09 anthropic recovery ok",
        "{anthropic_body}"
    );
    assert_no_client_error_body("Anthropic", &anthropic_body);
    let _anthropic_capture = assert_one_healthy_capture(
        &mut anthropic_captures,
        "Anthropic",
        ANTHROPIC_MARKER,
        TOOL_SCHEMA_MARKER,
    )
    .await;
    assert_request_bound_diagnostics(&home_guard, ANTHROPIC_MARKER).await;

    // Gemini generateContent entry.
    let gemini = client
        .post(format!(
            "http://{addr}/v1beta/models/req09-recovery-gemini/generateContent"
        ))
        .json(&json!({
            "contents": [{"role": "user", "parts": [{"text": GEMINI_MARKER}]}],
            "tools": [{
                "functionDeclarations": [{
                    "name": "req09_lookup",
                    "description": TOOL_SCHEMA_MARKER,
                    "parameters": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"]
                    }
                }]
            }],
            "stream": false
        }))
        .send()
        .await
        .expect("Gemini entry must return a client response");
    assert_eq!(gemini.status(), StatusCode::OK);
    let gemini_body: Value = gemini.json().await.unwrap();
    assert_eq!(
        gemini_body["candidates"][0]["content"]["parts"][0]["text"], "req09 gemini recovery ok",
        "{gemini_body}"
    );
    assert_no_client_error_body("Gemini", &gemini_body);
    let _gemini_capture = assert_one_healthy_capture(
        &mut gemini_captures,
        "Gemini",
        GEMINI_MARKER,
        TOOL_SCHEMA_MARKER,
    )
    .await;
    assert_request_bound_diagnostics(&home_guard, GEMINI_MARKER).await;

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        bad_captures.try_recv().is_err(),
        "a locally failed first candidate must never send an HTTP request"
    );

    let failures = timeout(Duration::from_secs(5), handle.shutdown())
        .await
        .expect("aggregate server shutdown must complete");
    assert!(
        failures.is_empty(),
        "sample persistence failures: {failures:?}"
    );

    shutdown_upstream(bad_shutdown, bad_task, "bad upstream").await;
    shutdown_upstream(responses_shutdown, responses_task, "Responses upstream").await;
    shutdown_upstream(chat_shutdown, chat_task, "OpenAI Chat upstream").await;
    shutdown_upstream(anthropic_shutdown, anthropic_task, "Anthropic upstream").await;
    shutdown_upstream(gemini_shutdown, gemini_task, "Gemini upstream").await;
}
