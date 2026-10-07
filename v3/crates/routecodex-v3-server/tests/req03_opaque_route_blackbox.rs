//! REQ03 opaque-route public HTTP regression.
//!
//! The Virtual Router decides exactly one opaque route target; the Target
//! interpreter expands the concrete provider candidates inside that target.
//! This consumer drives the real aggregate server through the public HTTP
//! entries (`/v1/responses` and `/v1/chat/completions`) against a real loopback
//! upstream. It asserts three externally observable facts:
//!
//! 1. routing success: the request model selects the matched route pool and the
//!    ordered provider candidate inside it actually receives the request with
//!    the correct target wire model;
//! 2. payload transparency: the complete exec command, apply_patch string, MCP
//!    argument blob and paired `call_id` tool history survive the round trip;
//! 3. a reachable route/selection failure is observed through the typed Error
//!    evidence, never as a client error response.
//!
//! It mirrors the frozen req09 consumer's public build entry and loopback
//! upstream pattern. It never calls a private helper and never inspects typed
//! transport internals.

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

const REQ03_KEY_ENV: &str = "V3_REQ03_HTTP_KEY";
const RESPONSES_SAMPLE_DIR: &str = "openai-responses";

/// Isolated HOME so the aggregate server's sample store never touches the real
/// `~/.rcc`. Mirrors the frozen req09 consumer.
struct TestHomeGuard {
    previous: Option<OsString>,
    previous_key: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "routecodex-v3-req03-opaque-route-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("HOME");
        let previous_key = std::env::var_os(REQ03_KEY_ENV);
        std::env::set_var("HOME", &path);
        Self {
            previous,
            previous_key,
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
        if let Some(previous) = &self.previous {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(previous) = &self.previous_key {
            std::env::set_var(REQ03_KEY_ENV, previous);
        } else {
            std::env::remove_var(REQ03_KEY_ENV);
        }
        fs::remove_dir_all(&self.path).expect("remove this test's isolated HOME");
    }
}

/// One captured provider request, labelled with the upstream that received it.
#[derive(Debug)]
struct ProviderCapture {
    provider: &'static str,
    body: Value,
}

#[derive(Clone)]
struct CaptureState {
    provider: &'static str,
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

async fn capture_provider_request(
    State(state): State<Arc<CaptureState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            provider: state.provider,
            body: body.clone(),
        })
        .expect("capture receiver remains live");
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "id": "chatcmpl-req03-opaque-route",
                "object": "chat.completion",
                "created": 0,
                "model": "chat-wire",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "req03 opaque route fidelity ok"
                    },
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": 3,
                    "completion_tokens": 2,
                    "total_tokens": 5
                }
            }))
            .unwrap(),
        ))
        .unwrap()
}

/// Real loopback provider upstream. Each instance is a distinct provider target
/// with its own base URL, so "which upstream received the request" is the
/// externally observable proof of the selected candidate.
async fn start_capture_upstream(
    provider: &'static str,
    captures: mpsc::UnboundedSender<ProviderCapture>,
) -> (String, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(capture_provider_request))
        .with_state(Arc::new(CaptureState { provider, captures }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown_rx.await.expect("upstream shutdown signal");
            })
            .await
            .unwrap();
    });
    (format!("http://{address}/v1"), shutdown_tx, task)
}

/// Aggregate manifest with two providers and two explicit route pools.
///
/// * `responses_route` matches `entry_protocol = "responses"` + model
///   `req03-responses`; its targets are ordered `alpha` then `beta`.
/// * `chat_route` matches `entry_protocol = "openai_chat"` + model
///   `req03-chat`; its targets are ordered `beta` then `alpha`.
///
/// Pool target priority is descending numeric (higher number first), so the
/// `priority = 2` target is the primary candidate in each pool.
///
/// `max_context_tokens` bounds every candidate so the same manifest can drive
/// the success path (large window) or a reachable selection failure (small
/// window).
fn req03_opaque_route_manifest(
    server_port: u16,
    alpha_base_url: &str,
    beta_base_url: &str,
    max_context_tokens: u32,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let hub_v1_declaration = hub_v1_test_declaration().replace(direct_binding, relay_binding);
    let server_execution = hub_v1_server_execution("req03");
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}
[servers.req03]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req03"
endpoints = ["responses", "openai_chat"]
{server_execution}
[providers.alpha]
type = "openai_chat"
base_url = "{alpha_base_url}"
default_model = "alpha-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{REQ03_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.alpha.models.alpha-wire]
wire_name = "alpha-wire"
aliases = ["req03-responses"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = {max_context_tokens}
[providers.beta]
type = "openai_chat"
base_url = "{beta_base_url}"
default_model = "beta-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{REQ03_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.beta.models.beta-wire]
wire_name = "beta-wire"
aliases = ["req03-chat"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = {max_context_tokens}
[debug]
log_console = false
snapshots = true
dry_run = false
retention = {{ raw_requests = 8, raw_responses = 8, events = 64 }}
[route_groups.req03.pools.responses_route]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["req03-responses"] }}
targets = [{{ kind = "provider_model", provider = "alpha", model = "alpha-wire", key = "key", priority = 2 }}, {{ kind = "provider_model", provider = "beta", model = "beta-wire", key = "key", priority = 1 }}]
[route_groups.req03.pools.chat_route]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["req03-chat"] }}
targets = [{{ kind = "provider_model", provider = "beta", model = "beta-wire", key = "key", priority = 2 }}, {{ kind = "provider_model", provider = "alpha", model = "alpha-wire", key = "key", priority = 1 }}]
[route_groups.req03.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "alpha", model = "alpha-wire", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn read_json_file(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

/// Poll the sample root for the request directory that carries `request_marker`
/// in its persisted `request.json`.
async fn wait_for_sample_with_request_marker(
    samples_root: &Path,
    request_marker: &str,
) -> Option<PathBuf> {
    for _ in 0..400 {
        if let Ok(entries) = fs::read_dir(samples_root) {
            for entry in entries.flatten() {
                let path = entry.path().join("request.json");
                if fs::read_to_string(path)
                    .ok()
                    .is_some_and(|request| request.contains(request_marker))
                {
                    return Some(entry.path());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    None
}

fn find_chat_tool_call<'a>(body: &'a Value, call_id: &str) -> Option<&'a Value> {
    body["messages"]
        .as_array()?
        .iter()
        .flat_map(|message| {
            message
                .get("tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .find(|tool_call| tool_call["id"] == call_id)
}

fn find_chat_tool_result<'a>(body: &'a Value, call_id: &str) -> Option<&'a Value> {
    body["messages"]
        .as_array()?
        .iter()
        .find(|message| message["role"] == "tool" && message["tool_call_id"] == call_id)
}

/// The payload fragments that must survive any route/provider selection: a full
/// exec command, a complete apply_patch string, an opaque MCP argument blob, and
/// the paired `call_id` tool history.
struct ToolFidelityPayload {
    call_id: String,
    exec_command: String,
    apply_patch_text: String,
    opaque_mcp: String,
    tool_arguments: String,
    tool_result: String,
    tools: Value,
}

fn req03_tool_fidelity_payload() -> ToolFidelityPayload {
    let call_id = "call_req03_opaque_route".to_string();
    let exec_command = format!("exec-command-{}", "x".repeat(4096));
    let apply_patch_text =
        "*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch".to_string();
    let opaque_mcp = format!(
        "mcp__server__opaque_tool:{{\"blob\":\"{}\"}}",
        "mcp-value-".repeat(256)
    );
    let tool_arguments = json!({"cmd": exec_command, "reason": "req03 fidelity"}).to_string();
    let tool_result = format!("exec output:\n{apply_patch_text}\nopaque MCP:\n{opaque_mcp}");
    let tools = json!([{
        "type": "function",
        "name": "exec_command",
        "description": "Run a bounded command for the request.",
        "parameters": {
            "type": "object",
            "properties": {
                "cmd": {"type": "string"},
                "reason": {"type": "string"}
            },
            "required": ["cmd"]
        }
    }]);
    ToolFidelityPayload {
        call_id,
        exec_command,
        apply_patch_text,
        opaque_mcp,
        tool_arguments,
        tool_result,
        tools,
    }
}

/// Assert that the Chat-shaped upstream body preserves the complete tool
/// payload: declared tools, the paired assistant tool call, and the matched tool
/// result with the exec command, apply_patch string, and opaque MCP blob.
fn assert_chat_payload_fidelity(capture: &Value, payload: &ToolFidelityPayload) {
    let declared_tool = capture["tools"]
        .as_array()
        .and_then(|tools| {
            tools.iter().find(|tool| {
                tool["type"] == "function" && tool["function"]["name"] == "exec_command"
            })
        })
        .unwrap_or_else(|| panic!("the declared function tool must reach the upstream: {capture}"));
    assert_eq!(
        declared_tool["function"]["parameters"]["required"],
        json!(["cmd"]),
        "{capture}"
    );

    let assistant_call = find_chat_tool_call(capture, &payload.call_id).unwrap_or_else(|| {
        panic!(
            "assistant tool call {} must reach the upstream unchanged: {capture}",
            payload.call_id
        )
    });
    assert_eq!(assistant_call["type"], "function");
    assert_eq!(assistant_call["function"]["name"], "exec_command");
    assert_eq!(
        assistant_call["function"]["arguments"], payload.tool_arguments,
        "the tool-call arguments must be preserved byte-for-byte: {capture}"
    );
    assert!(
        assistant_call["function"]["arguments"]
            .as_str()
            .is_some_and(|arguments| arguments.contains(&payload.exec_command)),
        "the full exec command must survive routing: {capture}"
    );

    let tool_result_message =
        find_chat_tool_result(capture, &payload.call_id).unwrap_or_else(|| {
            panic!(
                "matched tool result {} must reach the upstream unchanged: {capture}",
                payload.call_id
            )
        });
    assert_eq!(
        tool_result_message["content"], payload.tool_result,
        "the matched tool result must be preserved: {capture}"
    );
    let result_content = tool_result_message["content"]
        .as_str()
        .expect("tool result content must stay a string");
    assert!(
        result_content.contains(&payload.apply_patch_text),
        "the complete apply_patch string must survive routing: {capture}"
    );
    assert!(
        result_content.contains(&payload.opaque_mcp),
        "the opaque MCP argument blob must survive routing: {capture}"
    );
}

#[tokio::test]
async fn req03_opaque_route_selects_ordered_provider_and_preserves_tool_payload_blackbox() {
    let _test_guard = TEST_LOCK.lock().await;
    let _home_guard = TestHomeGuard::new("success");
    std::env::set_var(REQ03_KEY_ENV, "req03-opaque-route-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (alpha_base_url, alpha_shutdown, alpha_task) =
        start_capture_upstream("alpha", captures_tx.clone()).await;
    let (beta_base_url, beta_shutdown, beta_task) =
        start_capture_upstream("beta", captures_tx.clone()).await;

    let manifest =
        req03_opaque_route_manifest(free_port(), &alpha_base_url, &beta_base_url, 128_000);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let addr = handle.listeners[0].addr;
    let client = reqwest::Client::new();

    // --- Entry 1: Responses. The model selects the `responses_route` pool; the
    //     higher-priority alpha candidate must win over beta.
    let responses_payload = req03_tool_fidelity_payload();
    let responses = client
        .post(format!("http://{addr}/v1/responses"))
        .json(&json!({
            "model": "req03-responses",
            "input": [
                {"role": "user", "content": "continue the tool round trip"},
                {
                    "type": "function_call",
                    "call_id": responses_payload.call_id,
                    "name": "exec_command",
                    "arguments": responses_payload.tool_arguments
                },
                {
                    "type": "function_call_output",
                    "call_id": responses_payload.call_id,
                    "output": responses_payload.tool_result
                }
            ],
            "tools": responses_payload.tools,
            "stream": false
        }))
        .send()
        .await
        .expect("Responses request must reach a client response");
    assert_eq!(responses.status(), StatusCode::OK);
    let responses_body: Value = responses.json().await.unwrap();
    assert_eq!(responses_body["status"], "completed", "{responses_body}");
    assert!(
        responses_body
            .to_string()
            .contains("req03 opaque route fidelity ok"),
        "the Responses client must receive the ordinary successful Chat result: {responses_body}"
    );

    let alpha_capture = timeout(Duration::from_secs(5), captures_rx.recv())
        .await
        .expect("the selected provider must be reached before the deadline")
        .expect("provider capture channel remains live");
    assert_eq!(
        alpha_capture.provider, "alpha",
        "the Responses model must route to the alpha candidate: {alpha_capture:?}"
    );
    assert_eq!(
        alpha_capture.body["model"], "alpha-wire",
        "the upstream must receive the selected target wire model: {}",
        alpha_capture.body
    );
    assert!(
        captures_rx.try_recv().is_err(),
        "the lower-priority beta candidate must not receive the Responses request"
    );
    assert_chat_payload_fidelity(&alpha_capture.body, &responses_payload);

    // --- Entry 2: Chat Completions. The model selects the `chat_route` pool; the
    //     higher-priority beta candidate must win over alpha.
    let chat_payload = req03_tool_fidelity_payload();
    let chat = client
        .post(format!("http://{addr}/v1/chat/completions"))
        .json(&json!({
            "model": "req03-chat",
            "messages": [
                {"role": "user", "content": "continue the tool round trip"},
                {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": chat_payload.call_id,
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "arguments": chat_payload.tool_arguments
                        }
                    }]
                },
                {
                    "role": "tool",
                    "tool_call_id": chat_payload.call_id,
                    "content": chat_payload.tool_result
                }
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "parameters": {
                        "type": "object",
                        "properties": {"cmd": {"type": "string"}},
                        "required": ["cmd"]
                    }
                }
            }],
            "stream": false
        }))
        .send()
        .await
        .expect("Chat Completions request must reach a client response");
    assert_eq!(chat.status(), StatusCode::OK);
    let chat_body: Value = chat.json().await.unwrap();
    assert_eq!(
        chat_body["choices"][0]["message"]["content"],
        "req03 opaque route fidelity ok"
    );

    let beta_capture = timeout(Duration::from_secs(5), captures_rx.recv())
        .await
        .expect("the selected provider must be reached before the deadline")
        .expect("provider capture channel remains live");
    assert_eq!(
        beta_capture.provider, "beta",
        "the Chat Completions model must route to the beta candidate: {beta_capture:?}"
    );
    assert_eq!(
        beta_capture.body["model"], "beta-wire",
        "the upstream must receive the selected target wire model: {}",
        beta_capture.body
    );
    assert!(
        captures_rx.try_recv().is_err(),
        "the lower-priority alpha candidate must not receive the Chat request"
    );
    assert_chat_payload_fidelity(&beta_capture.body, &chat_payload);

    let failures = timeout(Duration::from_secs(5), handle.shutdown())
        .await
        .expect("aggregate server shutdown must complete");
    assert!(
        failures.is_empty(),
        "sample persistence failures: {failures:?}"
    );
    alpha_shutdown.send(()).expect("alpha shutdown receiver");
    beta_shutdown.send(()).expect("beta shutdown receiver");
    timeout(Duration::from_secs(5), alpha_task)
        .await
        .expect("alpha shutdown must complete")
        .expect("alpha task must succeed");
    timeout(Duration::from_secs(5), beta_task)
        .await
        .expect("beta shutdown must complete")
        .expect("beta task must succeed");
}

#[tokio::test]
async fn req03_route_selection_failure_observes_typed_error_without_client_error_blackbox() {
    let _test_guard = TEST_LOCK.lock().await;
    let home_guard = TestHomeGuard::new("selection-failure");
    std::env::set_var(REQ03_KEY_ENV, "req03-opaque-route-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (alpha_base_url, alpha_shutdown, alpha_task) =
        start_capture_upstream("alpha", captures_tx.clone()).await;
    let (beta_base_url, beta_shutdown, beta_task) =
        start_capture_upstream("beta", captures_tx.clone()).await;

    // A window far smaller than the request forces a selection-time pool
    // exhaustion: no candidate is admitted, so no provider attempt exists and
    // the client boundary is a transport break. This is a reachable failure of
    // the same request-entry route path, not an invented anomaly.
    let request_marker = "REQ03_OPAQUE_ROUTE_SELECTION_FAILURE_MARKER";
    let manifest = req03_opaque_route_manifest(free_port(), &alpha_base_url, &beta_base_url, 2_000);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let addr = handle.listeners[0].addr;
    let client = reqwest::Client::new();

    let long_input = format!(
        "{request_marker} {}",
        "context window exhaustion probe ".repeat(600)
    );
    let client_observation = timeout(
        Duration::from_secs(5),
        client
            .post(format!("http://{addr}/v1/responses"))
            .json(&json!({
                "model": "req03-responses",
                "input": long_input,
                "stream": false
            }))
            .send(),
    )
    .await
    .expect("the failing request must reach a terminal transport outcome");

    // Client contract: a selection-time failure must never become an error
    // response, an error status, or a fabricated success.
    let client_error = client_observation.expect_err(
        "an exhausted route selection must close the non-streaming client without a payload",
    );
    assert!(
        !client_error.is_status(),
        "the client must never receive a projected HTTP error status: {client_error}"
    );

    // No candidate was admitted, so no provider transport happened.
    assert!(
        captures_rx.try_recv().is_err(),
        "a selection-time route failure must not contact any provider"
    );

    // Typed Error public observation: the projection stays provider-private
    // evidence on disk. We assert the typed artifact, not a client projection.
    let samples_root = home_guard.endpoint_samples_root(RESPONSES_SAMPLE_DIR, addr.port());
    let sample_dir = wait_for_sample_with_request_marker(&samples_root, request_marker)
        .await
        .expect("the route failure must leave typed Error evidence bound to the request");
    let request_json =
        read_json_file(&sample_dir.join("request.json")).expect("request.json must be parseable");
    assert!(
        serde_json::to_string(&request_json)
            .unwrap()
            .contains(request_marker),
        "the request artifact must bind the failing request: {request_json}"
    );
    let error_json =
        read_json_file(&sample_dir.join("error.json")).expect("error.json must be parseable");
    assert_eq!(
        error_json["object"], "routecodex.v3.error_evidence",
        "the failure must persist typed Error evidence: {error_json}"
    );
    let error_chain = error_json["error_chain"]
        .as_array()
        .unwrap_or_else(|| panic!("error_chain must be an array: {error_json}"));
    let chain_nodes: Vec<&str> = error_chain.iter().filter_map(Value::as_str).collect();
    assert!(
        chain_nodes.contains(&"V3Error01SourceRaised"),
        "the typed Error chain must retain its source node: {error_json}"
    );
    assert!(
        chain_nodes.contains(&"V3Error04TargetExhaustionDecision"),
        "the typed Error chain must retain the target-exhaustion decision: {error_json}"
    );
    assert!(
        error_json["status"]
            .as_u64()
            .is_some_and(|status| status >= 400),
        "the typed Error projection must carry an internal non-success status: {error_json}"
    );

    let failures = timeout(Duration::from_secs(5), handle.shutdown())
        .await
        .expect("aggregate server shutdown must complete");
    assert!(
        failures.is_empty(),
        "sample persistence failures: {failures:?}"
    );
    alpha_shutdown.send(()).expect("alpha shutdown receiver");
    beta_shutdown.send(()).expect("beta shutdown receiver");
    timeout(Duration::from_secs(5), alpha_task)
        .await
        .expect("alpha shutdown must complete")
        .expect("alpha task must succeed");
    timeout(Duration::from_secs(5), beta_task)
        .await
        .expect("beta shutdown must complete")
        .expect("beta task must succeed");
}
