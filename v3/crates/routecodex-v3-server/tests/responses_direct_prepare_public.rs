//! Public-entry black box for the relocated Responses Direct pre-send preparation.
//!
//! Stable test IDs:
//! `responses_direct_prepare_tool_thinking_enabled_and_continuation_through_public_entry`
//! and `responses_direct_prepare_memory_guidance_idempotent_through_public_entry`.
//!
//! Both tests enter the real HTTP `/v1/responses` endpoint of a spawned
//! aggregate server with a Responses Direct binding and reach a locally spawned
//! controlled Responses upstream. No live provider is contacted.
//!
//! They pin the behavior owned by
//! `v3/crates/routecodex-v3-runtime/src/hooks.rs::responses_direct_prepare_before_send`
//! after the removal of the retired Responses direct protocol codec:
//! - tool-thinking schema governance is applied once per request and is visible
//!   in the provider-bound wire payload;
//! - the client keeps the original tool identity and complete arguments;
//! - an output-only tool continuation is not re-governed;
//! - memory raw-capture guidance is injected exactly once even when a request
//!   reselects a provider after a candidate failure.

use axum::{
    body::Body,
    extract::State,
    http::{StatusCode, Uri},
    response::Response,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{ffi::OsString, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const KEY_ENV: &str = "V3_RESPONSES_DIRECT_PREP_KEY";
const CLIENT_MODEL: &str = "prep-client";
const FOLLOWUP_MODEL: &str = "prep-followup";
const WIRE_MODEL: &str = "prep_wire";
const MEMORY_MARKER: &str = "routecodex.memory.raw-entry.v1";
const TOOL_NAME: &str = "acceptance_add";
const CALL_ID: &str = "call_add_1";
const WIRE_ARGUMENTS: &str =
    r#"{"a":17,"b":25,"reason":"compute the sum","goal_alignment_confidence":100}"#;

/// The aggregate server persists debug samples under `$HOME/.rcc`. Point HOME
/// at a temporary directory so a test run never touches the operator's live
/// sample tree.
struct TestHomeGuard {
    previous: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "routecodex-responses-direct-prep-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &path);
        Self { previous, path }
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[derive(Debug)]
struct ProviderCapture {
    path: String,
    body: Value,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

fn capture(state: &ProviderState, uri: &Uri, body: Value) {
    state
        .captures
        .send(ProviderCapture {
            path: uri.path().to_string(),
            body,
        })
        .unwrap();
}

async fn failing_upstream(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture(&state, &uri, body);
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"error":{"type":"server_error","message":"controlled candidate failure"}}"#,
        ))
        .unwrap()
}

async fn succeeding_upstream(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    let followup = body["input"].as_array().is_some_and(|items| {
        !items.is_empty()
            && items
                .iter()
                .all(|item| item["type"] == "function_call_output")
    });
    let validation = followup.then(|| {
        let item = body["input"][0].clone();
        let expected_output = execute_client_tool(TOOL_NAME, WIRE_ARGUMENTS);
        if item["call_id"].as_str() == Some(CALL_ID)
            && item["output"].as_str() == Some(expected_output.as_str())
        {
            Ok(())
        } else {
            Err(json!({
                "error": {
                    "type": "invalid_request_error",
                    "message":
                        "controlled upstream validation failed: paired call_id or computed output mismatch"
                }
            }))
        }
    });
    capture(&state, &uri, body);
    let output = if let Some(Err(error)) = validation {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(error.to_string()))
            .unwrap();
    } else if followup {
        json!([{
            "type":"message","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":"42"}]
        }])
    } else {
        json!([{
            "type":"function_call","call_id":CALL_ID,"name":TOOL_NAME,
            "arguments":WIRE_ARGUMENTS
        }])
    };
    let response = json!({
        "id": if followup { "resp_followup" } else { "resp_call" },
        "object": "response",
        "status": "completed",
        "model": WIRE_MODEL,
        "output": output
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(response.to_string()))
        .unwrap()
}

fn execute_client_tool(name: &str, arguments: &str) -> String {
    assert_eq!(name, TOOL_NAME, "unexpected client tool name");
    let args: Value = serde_json::from_str(arguments)
        .unwrap_or_else(|error| panic!("client tool arguments must be valid JSON: {error}"));
    let a = args["a"].as_i64().expect("acceptance_add a");
    let b = args["b"].as_i64().expect("acceptance_add b");
    (a + b).to_string()
}

struct Upstream {
    addr: SocketAddr,
    captures: mpsc::UnboundedReceiver<ProviderCapture>,
    shutdown: oneshot::Sender<()>,
}

async fn start_upstream() -> Upstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (captures_tx, captures) = mpsc::unbounded_channel();
    let (shutdown, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/fail/v1/responses", post(failing_upstream))
        .route("/ok/v1/responses", post(succeeding_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    Upstream {
        addr,
        captures,
        shutdown,
    }
}

fn direct_manifest(upstream: SocketAddr) -> V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("a");
    let port = test_ports::free_port();
    let source = format!(
        r#"
version = 3
{declaration}
[servers.a]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}

[providers.retry_fail]
type = "responses"
base_url = "http://{upstream}/fail/v1"
default_model = "{WIRE_MODEL}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.retry_fail.models.{WIRE_MODEL}]
wire_name = "{WIRE_MODEL}"
aliases = ["prep-fail-internal"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.retry_ok]
type = "responses"
base_url = "http://{upstream}/ok/v1"
default_model = "{WIRE_MODEL}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.retry_ok.models.{WIRE_MODEL}]
wire_name = "{WIRE_MODEL}"
aliases = ["{CLIENT_MODEL}", "{FOLLOWUP_MODEL}"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.retry]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["{CLIENT_MODEL}"] }}
targets = [
  {{ kind = "provider_model", provider = "retry_fail", model = "{WIRE_MODEL}", key = "key", priority = 3 }},
  {{ kind = "provider_model", provider = "retry_ok", model = "{WIRE_MODEL}", key = "key", priority = 1 }},
]

[route_groups.default.pools.followup]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["{FOLLOWUP_MODEL}"] }}
targets = [{{ kind = "provider_model", provider = "retry_ok", model = "{WIRE_MODEL}", key = "key", priority = 1 }}]

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "retry_ok", model = "{WIRE_MODEL}", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn client_tools() -> Value {
    json!([{
        "type": "function",
        "name": TOOL_NAME,
        "description": "Return the sum of the two integer arguments.",
        "parameters": {
            "type": "object",
            "properties": {
                "a": {"type": "integer"},
                "b": {"type": "integer"}
            },
            "required": ["a", "b"],
            "additionalProperties": false
        }
    }])
}

fn client_input() -> Value {
    json!([{
        "role": "user",
        "content": [{
            "type": "input_text",
            "text": "Call acceptance_add exactly once with a=17 and b=25."
        }]
    }])
}

async fn recv_capture(captures: &mut mpsc::UnboundedReceiver<ProviderCapture>) -> ProviderCapture {
    tokio::time::timeout(Duration::from_secs(10), captures.recv())
        .await
        .expect("provider attempt must reach the controlled upstream")
        .expect("controlled upstream must capture the provider request")
}

fn required_count(capture: &ProviderCapture, field: &str) -> usize {
    capture.body["tools"][0]["parameters"]["required"]
        .as_array()
        .map(|required| {
            required
                .iter()
                .filter(|value| value.as_str() == Some(field))
                .count()
        })
        .unwrap_or(0)
}

fn occurrences(haystack: &str, needle: &str) -> usize {
    haystack.match_indices(needle).count()
}

#[tokio::test]
async fn responses_direct_prepare_tool_thinking_enabled_and_continuation_through_public_entry() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("tool-thinking");
    std::env::set_var(KEY_ENV, "prep-secret");
    let mut upstream = start_upstream().await;
    let mut manifest = direct_manifest(upstream.addr);
    manifest
        .servers
        .get_mut("a")
        .expect("declared server")
        .features
        .insert("tool_thinking".to_string(), true);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let tools = client_tools();
    let request = json!({
        "model": CLIENT_MODEL,
        "stream": false,
        "input": client_input(),
        "tools": tools,
        "tool_choice": "auto"
    });

    let response = client
        .post(&endpoint)
        .json(&request)
        .send()
        .await
        .expect("public Responses request must complete");
    assert_eq!(response.status(), reqwest::StatusCode::OK);

    // The first candidate fails with a provider HTTP error; the request must
    // reselect the second candidate without exposing the failure to the client.
    let first = recv_capture(&mut upstream.captures).await;
    let second = recv_capture(&mut upstream.captures).await;
    assert!(first.path.starts_with("/fail/"), "{}", first.path);
    assert!(second.path.starts_with("/ok/"), "{}", second.path);
    for (label, capture) in [("first", &first), ("second", &second)] {
        assert_eq!(capture.body["model"], WIRE_MODEL, "{label}");
        assert_eq!(capture.body["tools"][0]["name"], TOOL_NAME, "{label}");
        let properties = &capture.body["tools"][0]["parameters"]["properties"];
        assert_eq!(
            properties["reason"]["type"], "string",
            "{label}: {properties}"
        );
        assert_eq!(
            properties["goal_alignment_confidence"]["type"], "integer",
            "{label}: {properties}"
        );
        for field in ["a", "b", "reason", "goal_alignment_confidence"] {
            assert_eq!(
                required_count(capture, field),
                1,
                "{label}: {field} required once"
            );
        }
        assert_eq!(capture.body["input"], request["input"], "{label}: input");
    }
    assert_eq!(
        first.body["tools"], second.body["tools"],
        "the reselected attempt must reuse the same single governance result"
    );

    let body: Value = response.json().await.expect("JSON client response");
    assert_eq!(body["status"], "completed");
    let call = body["output"]
        .as_array()
        .expect("client output")
        .iter()
        .find(|item| item["type"] == "function_call")
        .expect("client must receive the function call");
    assert_eq!(call["name"], TOOL_NAME);
    assert_eq!(call["call_id"], CALL_ID);
    let arguments: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(arguments, json!({"a": 17, "b": 25}));
    assert!(
        !body.to_string().contains("goal_alignment_confidence"),
        "internal governance fields must not reach the client: {body}"
    );

    // The client executes the call and answers with an output-only continuation.
    let computed_output = execute_client_tool(
        call["name"].as_str().unwrap(),
        call["arguments"].as_str().unwrap(),
    );
    assert_eq!(
        computed_output, "42",
        "acceptance_add(17, 25) must compute 42"
    );
    let followup_input = json!([{
        "type": "function_call_output",
        "call_id": call["call_id"],
        "output": computed_output
    }]);
    let followup = json!({
        "model": FOLLOWUP_MODEL,
        "stream": false,
        "input": followup_input,
        "tools": tools,
        "tool_choice": "none"
    });
    let response = client
        .post(&endpoint)
        .json(&followup)
        .send()
        .await
        .expect("public follow-up request must complete");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let capture = recv_capture(&mut upstream.captures).await;
    assert!(capture.path.starts_with("/ok/"), "{}", capture.path);
    assert_eq!(capture.body["input"], followup["input"], "tool result");
    assert_eq!(
        capture.body["tools"], followup["tools"],
        "an output-only continuation must not be re-governed"
    );
    let body: Value = response.json().await.expect("JSON follow-up response");
    assert_eq!(body["output"][0]["content"][0]["text"], "42");
    assert!(
        tokio::time::timeout(Duration::from_millis(150), upstream.captures.recv())
            .await
            .is_err(),
        "unexpected extra provider attempt"
    );

    handle.shutdown().await;
    let _ = upstream.shutdown.send(());
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn responses_direct_prepare_memory_guidance_idempotent_through_public_entry() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("memory");
    std::env::set_var(KEY_ENV, "prep-secret");
    let mut upstream = start_upstream().await;
    let memory_root = std::env::temp_dir().join(format!(
        "routecodex-responses-direct-prep-memory-root-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&memory_root);
    std::fs::create_dir_all(&memory_root).unwrap();
    let mut manifest = direct_manifest(upstream.addr);
    manifest.memory_raw_capture.enabled = true;
    manifest.memory_raw_capture.project_root = memory_root.clone();
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let tools = client_tools();
    let request = json!({
        "model": CLIENT_MODEL,
        "stream": false,
        "instructions": "keep this instruction",
        "input": client_input(),
        "tools": tools,
        "tool_choice": "auto"
    });

    let response = client
        .post(&endpoint)
        .json(&request)
        .send()
        .await
        .expect("public Responses request must complete");
    assert_eq!(response.status(), reqwest::StatusCode::OK);

    let first = recv_capture(&mut upstream.captures).await;
    let second = recv_capture(&mut upstream.captures).await;
    assert!(first.path.starts_with("/fail/"), "{}", first.path);
    assert!(second.path.starts_with("/ok/"), "{}", second.path);
    for (label, capture) in [("first", &first), ("second", &second)] {
        let instructions = capture.body["instructions"]
            .as_str()
            .unwrap_or_else(|| panic!("{label}: memory guidance must stay on instructions"));
        assert!(
            instructions.starts_with("keep this instruction"),
            "{label}: client instructions must be preserved: {instructions}"
        );
        assert!(
            instructions.contains(MEMORY_MARKER),
            "{label}: memory guidance marker must be present: {instructions}"
        );
        assert_eq!(
            occurrences(instructions, "Missing memory is normal."),
            1,
            "{label}: memory guidance must be injected exactly once: {instructions}"
        );
        assert_eq!(
            capture.body["tools"], request["tools"],
            "{label}: tool-thinking is disabled, tools must pass unchanged"
        );
    }
    assert_eq!(
        first.body["instructions"], second.body["instructions"],
        "a reselected attempt must not duplicate memory guidance"
    );
    assert_eq!(first.body["input"], request["input"], "first input");
    assert_eq!(second.body["input"], request["input"], "second input");

    let body: Value = response.json().await.expect("JSON client response");
    let call = body["output"]
        .as_array()
        .expect("client output")
        .iter()
        .find(|item| item["type"] == "function_call")
        .expect("client must receive the function call");
    assert_eq!(call["name"], TOOL_NAME);
    assert_eq!(call["call_id"], CALL_ID);

    handle.shutdown().await;
    let _ = upstream.shutdown.send(());
    let _ = std::fs::remove_dir_all(&memory_root);
    std::env::remove_var(KEY_ENV);
}
