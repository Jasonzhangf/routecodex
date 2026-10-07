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

const REQ09_KEY_ENV: &str = "V3_REQ09_HTTP_R2_KEY";

struct TestHomeGuard {
    previous: Option<OsString>,
    previous_key: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "routecodex-v3-req09-http-r2-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("HOME");
        let previous_key = std::env::var_os(REQ09_KEY_ENV);
        std::env::set_var("HOME", &path);
        Self {
            previous,
            previous_key,
            path,
        }
    }

    fn codex_samples_root(&self, port: u16) -> PathBuf {
        self.path
            .join(".rcc")
            .join("codex-samples")
            .join("openai-responses")
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
            std::env::set_var(REQ09_KEY_ENV, previous);
        } else {
            std::env::remove_var(REQ09_KEY_ENV);
        }
        fs::remove_dir_all(&self.path).expect("remove this test's isolated HOME");
    }
}

#[derive(Clone)]
struct ChatCaptureState {
    captures: mpsc::UnboundedSender<Value>,
}

async fn capture_chat_request(
    State(state): State<Arc<ChatCaptureState>>,
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
            serde_json::to_vec(&json!({
                "id": "chatcmpl-req09-http-r2",
                "object": "chat.completion",
                "created": 0,
                "model": "chat-wire",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "req09 transport fidelity ok"
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

async fn start_chat_capture_upstream() -> (
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
        .route("/v1/chat/completions", post(capture_chat_request))
        .with_state(Arc::new(ChatCaptureState {
            captures: captures_tx,
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

fn req09_responses_relay_to_openai_chat_manifest(
    server_port: u16,
    provider_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let hub_v1_declaration = hub_v1_test_declaration().replace(direct_binding, relay_binding);
    let server_execution = hub_v1_server_execution("req09");
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}
[servers.req09]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req09"
endpoints = ["responses"]
{server_execution}
[providers.upstream]
type = "openai_chat"
base_url = "{provider_base_url}"
default_model = "chat-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{REQ09_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.upstream.models.chat-wire]
wire_name = "chat-wire"
aliases = ["req09-client"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[debug]
log_console = false
snapshots = true
snapshot_stages = "client-request,client-response"
dry_run = false
retention = {{ raw_requests = 8, raw_responses = 8, events = 64 }}
[route_groups.req09.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["req09-client"] }}
targets = [{{ kind = "provider_model", provider = "upstream", model = "chat-wire", key = "key", priority = 1 }}]
[route_groups.req09.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "upstream", model = "chat-wire", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn read_json_file(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

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

#[tokio::test]
async fn req09_invalid_base_url_preserves_typed_cause_without_client_error_blackbox() {
    let _test_guard = TEST_LOCK.lock().await;
    let home_guard = TestHomeGuard::new("invalid-base-url");
    std::env::set_var(REQ09_KEY_ENV, "req09-http-r2-secret");
    let request_marker = "REQ09_INVALID_BASE_URL_REQUEST_MARKER";
    let mut manifest =
        req09_responses_relay_to_openai_chat_manifest(free_port(), "not-a-valid-base-url");
    let diagnostic_log = home_guard.path.join("request-events.log");
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
    let mut request_json = None;
    let mut error_json = None;
    let mut provider_terminal_json = None;
    let mut diagnostic_events = None;

    if let Some(handle) = handle {
        let addr = handle.listeners[0].addr;
        let client = reqwest::Client::new();
        client_observation = Some(
            match timeout(
                Duration::from_secs(5),
                client
                    .post(format!("http://{addr}/v1/responses"))
                    .json(&json!({
                        "model": "req09-client",
                        "input": request_marker,
                        "stream": false
                    }))
                    .send(),
            )
            .await
            {
                Ok(Ok(response)) => {
                    let status = response.status();
                    let body = response.text().await.expect("client response body");
                    Ok((status, body))
                }
                Ok(Err(error)) => Err(error.to_string()),
                Err(_) => Err("client request timed out".to_string()),
            },
        );

        let samples_root = home_guard.codex_samples_root(addr.port());
        sample_dir = wait_for_sample_with_request_marker(&samples_root, request_marker).await;
        if let Some(path) = sample_dir.as_ref() {
            request_json = read_json_file(&path.join("request.json"));
            error_json = read_json_file(&path.join("error.json"));
            provider_terminal_json = read_json_file(&path.join("provider-terminal.json"));
        }

        let failures = timeout(Duration::from_secs(5), handle.shutdown())
            .await
            .expect("aggregate server shutdown must complete");
        assert!(
            failures.is_empty(),
            "sample persistence failures: {failures:?}"
        );
        diagnostic_events =
            Some(fs::read_to_string(&diagnostic_log).expect("configured event log"));
    }

    drop(home_guard);

    assert!(
        server_start_error.is_none(),
        "aggregate server must start: {server_start_error:?}"
    );
    let client_observation = client_observation.expect("server observation must be collected");
    assert!(
        client_observation.is_err(),
        "invalid provider base_url must abort the client transport, not return a response: {client_observation:?}"
    );
    if let Err(error) = &client_observation {
        assert!(
            error != "client request timed out",
            "client transport must abort before the deadline"
        );
    }

    sample_dir.expect(
        "configured diagnostics must bind the request marker; current base has no source-loss artifact",
    );
    let request_json = request_json.expect("request.json must be parseable");
    assert!(
        serde_json::to_string(&request_json)
            .unwrap()
            .contains(request_marker),
        "request marker must bind the request artifact: {request_json}"
    );
    let error_json = error_json.expect("error.json must be parseable");
    let diagnostic_events = diagnostic_events.expect("request event log must be collected");
    let projected_event = diagnostic_events
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|event| {
            event["request_id"] == error_json["request_id"]
                && event["node_id"] == "V3Error06ClientProjected"
                && event["event"] == "projected"
        })
        .expect("Error06 event must match the sampled request ID");
    assert_eq!(
        projected_event.pointer("/details/body/error/code").and_then(Value::as_str),
        Some("provider_local_runtime_error"),
        "typed InvalidBaseUrl source must retain the local-runtime classification: {projected_event}"
    );
    assert!(
        projected_event
            .pointer("/details/body/error/message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("invalid Responses base URL")),
        "original InvalidBaseUrl cause must remain observable in diagnostics: {projected_event}"
    );
    assert_eq!(
        error_json["status"], 598,
        "request-lane runtime failure must stay on the 598/non-network classification: {error_json}"
    );
    assert!(
        error_json["error_chain"]
            .as_array()
            .is_some_and(|chain| chain.iter().any(|node| node == "V3Error01SourceRaised")),
        "error chain must retain its typed source node: {error_json}"
    );
    if let Some(observability) = error_json
        .get("observability")
        .filter(|value| !value.is_null())
    {
        assert!(
            observability.get("provider_status").is_none()
                || observability["provider_status"].is_null(),
            "a local InvalidBaseUrl failure must not fabricate an upstream HTTP status: {observability}"
        );
    }
    assert!(
        provider_terminal_json
            .as_ref()
            .map_or(true, |terminal| terminal["kind"] != "external_http"),
        "a local InvalidBaseUrl failure must not create a fake external HTTP witness: {provider_terminal_json:?}"
    );
}

#[tokio::test]
async fn req09_responses_relay_to_openai_chat_preserves_tool_history_blackbox() {
    let _test_guard = TEST_LOCK.lock().await;
    let home_guard = TestHomeGuard::new("tool-history");
    std::env::set_var(REQ09_KEY_ENV, "req09-http-r2-secret");
    let (provider_base_url, mut captures, upstream_shutdown, upstream_task) =
        start_chat_capture_upstream().await;
    let manifest = req09_responses_relay_to_openai_chat_manifest(free_port(), &provider_base_url);
    let mut server_start_error = None;
    let handle = match spawn_v3_server_aggregate(manifest).await {
        Ok(handle) => Some(handle),
        Err(error) => {
            server_start_error = Some(error.to_string());
            None
        }
    };

    let call_id = "call_req09_transport_fidelity";
    let long_exec = format!("exec-command-{}", "x".repeat(4096));
    let apply_patch_text =
        "*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch";
    let opaque_mcp = format!(
        "mcp__server__opaque_tool:{{\"blob\":\"{}\"}}",
        "mcp-value-".repeat(256)
    );
    let tool_arguments = json!({"cmd": long_exec, "reason": "req09 fidelity"}).to_string();
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

    let mut client_observation = None;
    let mut upstream_capture = None;

    if let Some(handle) = handle {
        let addr = handle.listeners[0].addr;
        let client = reqwest::Client::new();
        client_observation = Some(
            match timeout(
                Duration::from_secs(10),
                client
                    .post(format!("http://{addr}/v1/responses"))
                    .json(&json!({
                        "model": "req09-client",
                        "input": [
                            {"role": "user", "content": "continue the tool round trip"},
                            {
                                "type": "function_call",
                                "call_id": call_id,
                                "name": "exec_command",
                                "arguments": tool_arguments
                            },
                            {
                                "type": "function_call_output",
                                "call_id": call_id,
                                "output": tool_result
                            }
                        ],
                        "tools": tools,
                        "stream": false
                    }))
                    .send(),
            )
            .await
            {
                Ok(Ok(response)) => {
                    let status = response.status();
                    let body = response.text().await.expect("client response body");
                    Ok((status, body))
                }
                Ok(Err(error)) => Err(error.to_string()),
                Err(_) => Err("client request timed out".to_string()),
            },
        );
        upstream_capture = timeout(Duration::from_secs(5), captures.recv())
            .await
            .ok()
            .flatten();

        let failures = timeout(Duration::from_secs(5), handle.shutdown())
            .await
            .expect("aggregate server shutdown must complete");
        assert!(
            failures.is_empty(),
            "sample persistence failures: {failures:?}"
        );
    }

    upstream_shutdown
        .send(())
        .expect("upstream shutdown receiver");
    timeout(Duration::from_secs(5), upstream_task)
        .await
        .expect("upstream shutdown must complete")
        .expect("upstream task must succeed");
    drop(home_guard);

    assert!(
        server_start_error.is_none(),
        "aggregate server must start: {server_start_error:?}"
    );
    let (status, client_body) = client_observation
        .expect("client observation must be collected")
        .expect("successful tool-history request must return a client response");
    assert_eq!(status, StatusCode::OK, "{client_body}");
    let client_body: Value = serde_json::from_str(&client_body).unwrap();
    assert_eq!(client_body["status"], "completed", "{client_body}");
    assert!(
        client_body
            .to_string()
            .contains("req09 transport fidelity ok"),
        "Responses client must receive the ordinary successful Chat result: {client_body}"
    );

    let upstream_capture = upstream_capture.expect("provider request must reach loopback upstream");
    let declared_tool = upstream_capture["tools"]
        .as_array()
        .and_then(|tools| {
            tools.iter().find(|tool| {
                tool["type"] == "function" && tool["function"]["name"] == "exec_command"
            })
        })
        .expect("declared function tool must reach the Chat upstream");
    assert_eq!(
        declared_tool["function"]["parameters"]["required"],
        json!(["cmd"]),
        "{upstream_capture}"
    );

    let assistant_call = find_chat_tool_call(&upstream_capture, call_id).unwrap_or_else(|| {
        panic!(
            "assistant tool call {call_id} must reach the upstream unchanged: {upstream_capture}"
        )
    });
    assert_eq!(assistant_call["type"], "function");
    assert_eq!(assistant_call["function"]["name"], "exec_command");
    assert_eq!(
        assistant_call["function"]["arguments"], tool_arguments,
        "tool-call arguments must be preserved byte-for-byte: {upstream_capture}"
    );

    let tool_result_message = find_chat_tool_result(&upstream_capture, call_id)
        .unwrap_or_else(|| panic!("matched tool result {call_id} must reach the upstream unchanged: {upstream_capture}"));
    assert_eq!(
        tool_result_message["content"], tool_result,
        "matched tool result must preserve the exec, apply_patch, and opaque MCP strings: {upstream_capture}"
    );
    assert!(
        tool_result_message["content"]
            .as_str()
            .is_some_and(
                |content| content.contains(apply_patch_text) && content.contains(&opaque_mcp)
            ),
        "tool result must retain the full apply_patch and opaque MCP payloads: {upstream_capture}"
    );
}
