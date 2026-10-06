//! REQ02 R44 Direct JSON public HTTP acceptance.
//!
//! These tests drive the real public Server (`spawn_v3_server_aggregate`) with
//! a real loopback HTTP provider. A Direct JSON attempt is buffered, its
//! same-request actual `AttemptContext` is published, the registered Direct
//! JSON hook runs through `ResponseProjectionView`, and the original client
//! declarations are inverted from the successful emission only.
//!
//! Nothing here mocks private runtime calls. The provider wire is asserted on
//! the bytes the loopback provider actually received, and the client response
//! is asserted on the bytes the public client actually received.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    sync::{mpsc, oneshot, Mutex},
    task::JoinHandle,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const RESPONSES_KEY_ENV: &str = "REQ02_R44_DIRECT_JSON_RESPONSES_KEY";
const CHAT_KEY_ENV: &str = "REQ02_R44_DIRECT_JSON_CHAT_KEY";
const FINAL_TEXT: &str = "REQ02_R44_DIRECT_JSON_FINAL";

// The exec command must stay well above 70KB, keep CRLF line endings, and keep
// the literal shell `$()` / backtick sequences byte-for-byte.
const EXEC_REPEATS: usize = 2200;

fn exec_command() -> String {
    let mut command = String::with_capacity(EXEC_REPEATS * 40 + 64);
    for _ in 0..EXEC_REPEATS {
        command.push_str("echo \"literal $() and `backtick`\"\r\n");
    }
    command.push_str("printf '%s' 'REQ02_R44_EXEC_TAIL'");
    command
}

fn exec_arguments() -> String {
    serde_json::to_string(&json!({
        "cmd": exec_command(),
        "cwd": "/workspace/routecodex",
        "yield_time_ms": 1000
    }))
    .unwrap()
}

const APPLY_PATCH: &str = "*** Begin Patch\n*** Add File: /tmp/req02-r44-direct-json.txt\n+literal $() and `backtick`\n+second line\n*** End Patch\n";

fn patch_wire_arguments() -> String {
    serde_json::to_string(&json!({"input": APPLY_PATCH})).unwrap()
}

fn mcp_arguments() -> String {
    serde_json::to_string(&json!({
        "query": "nested mcp arguments",
        "filters": {
            "labels": ["required", "runtime"],
            "nested": {"keep": [1, null, true, {"value": "opaque"}]}
        },
        "cursor": null
    }))
    .unwrap()
}

fn direct_responses_tools() -> Value {
    json!([
        {
            "type": "namespace",
            "name": "functions",
            "description": "Functions namespace.",
            "tools": [
                {
                    "type": "function",
                    "name": "exec",
                    "description": "Run a command.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "cmd": {"type": "string"},
                            "cwd": {"type": "string"},
                            "yield_time_ms": {"type": "number"}
                        },
                        "required": ["cmd"],
                        "additionalProperties": false
                    }
                },
                {
                    "type": "custom",
                    "name": "apply_patch",
                    "description": "Apply a free-form patch.",
                    "format": {"type": "text"}
                }
            ]
        },
        {
            "type": "namespace",
            "name": "mcp__demo__",
            "description": "MCP demo namespace.",
            "tools": [
                {
                    "type": "function",
                    "name": "opaque_leaf",
                    "description": "Opaque MCP function.",
                    "parameters": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "additionalProperties": true
                    }
                }
            ]
        }
    ])
}

// ---------------------------------------------------------------------------
// Loopback provider peers
// ---------------------------------------------------------------------------

struct UpstreamPeer {
    shutdown: Option<oneshot::Sender<()>>,
    join: JoinHandle<()>,
}

impl UpstreamPeer {
    async fn shutdown(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        tokio::time::timeout(Duration::from_secs(3), self.join)
            .await
            .expect("controlled upstream must stop after graceful shutdown")
            .expect("controlled upstream task must not panic");
    }
}

async fn spawn_upstream(app: Router) -> (SocketAddr, UpstreamPeer) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (
        address,
        UpstreamPeer {
            shutdown: Some(shutdown_tx),
            join,
        },
    )
}

fn json_response(body: Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

fn status_json(status: StatusCode, body: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

async fn recv_capture(captures: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), captures.recv())
        .await
        .expect("real HTTP upstream must receive the provider request")
        .expect("provider capture channel must remain open")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum UpstreamBehavior {
    EmitTools,
    Fail,
}

#[derive(Clone)]
struct ResponsesState {
    captures: mpsc::UnboundedSender<Value>,
    behavior: UpstreamBehavior,
    hold: Option<Arc<Mutex<()>>>,
}

async fn responses_upstream(
    State(state): State<Arc<ResponsesState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.captures.send(body.clone()).unwrap();
    if let Some(hold) = &state.hold {
        let _hold = hold.lock().await;
    }
    if state.behavior == UpstreamBehavior::Fail {
        return status_json(
            StatusCode::BAD_REQUEST,
            json!({
                "error": {
                    "message": "controlled responses provider 400",
                    "type": "invalid_request_error",
                    "code": "req02_r44_controlled_responses_400"
                }
            }),
        );
    }
    if responses_has_tool_output(&body) {
        return json_response(json!({
            "id": "resp_r44_final",
            "status": "completed",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": FINAL_TEXT}]
            }]
        }));
    }
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    let exec_name = responses_wire_tool_name(&tools, "exec");
    let patch_name = responses_wire_tool_name(&tools, "apply_patch");
    let mcp_name = responses_wire_tool_name(&tools, "opaque_leaf");
    json_response(json!({
        "id": "resp_r44_tools",
        "status": "completed",
        "output": [
            {
                "type": "function_call",
                "id": "item-exec",
                "call_id": "exec-call",
                "name": exec_name,
                "arguments": exec_arguments()
            },
            {
                "type": "function_call",
                "id": "item-patch",
                "call_id": "patch-call",
                "name": patch_name,
                "arguments": patch_wire_arguments()
            },
            {
                "type": "function_call",
                "id": "item-mcp",
                "call_id": "mcp-call",
                "name": mcp_name,
                "arguments": mcp_arguments()
            }
        ]
    }))
}

fn responses_has_tool_output(body: &Value) -> bool {
    body["input"].as_array().is_some_and(|items| {
        items.iter().any(|item| {
            item["type"]
                .as_str()
                .is_some_and(|kind| kind.ends_with("_output"))
        })
    })
}

fn responses_wire_tool_name(tools: &[Value], suffix: &str) -> String {
    tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .find(|name| *name == suffix || name.contains(suffix))
        .unwrap_or_else(|| {
            panic!("provider wire must carry a flattened function for `{suffix}`: {tools:?}")
        })
        .to_string()
}

#[derive(Clone)]
struct ChatState {
    captures: mpsc::UnboundedSender<Value>,
    behavior: UpstreamBehavior,
    hold: Option<Arc<Mutex<()>>>,
}

async fn chat_upstream(
    State(state): State<Arc<ChatState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.captures.send(body.clone()).unwrap();
    if let Some(hold) = &state.hold {
        let _hold = hold.lock().await;
    }
    if state.behavior == UpstreamBehavior::Fail {
        return status_json(
            StatusCode::BAD_REQUEST,
            json!({
                "error": {
                    "message": "controlled chat provider 400",
                    "type": "invalid_request_error",
                    "code": "req02_r44_controlled_chat_400"
                }
            }),
        );
    }
    if chat_has_tool_result(&body) {
        return json_response(chat_completion(
            json!({
                "role": "assistant",
                "content": FINAL_TEXT
            }),
            "stop",
        ));
    }
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    let exec_name = chat_wire_tool_name(&tools, "exec");
    let patch_name = chat_wire_tool_name(&tools, "apply_patch");
    let mcp_name = chat_wire_tool_name(&tools, "opaque_leaf");
    json_response(chat_completion(
        json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [
                {
                    "id": "exec-call",
                    "type": "function",
                    "function": {"name": exec_name, "arguments": exec_arguments()}
                },
                {
                    "id": "patch-call",
                    "type": "function",
                    "function": {"name": patch_name, "arguments": patch_wire_arguments()}
                },
                {
                    "id": "mcp-call",
                    "type": "function",
                    "function": {"name": mcp_name, "arguments": mcp_arguments()}
                }
            ]
        }),
        "tool_calls",
    ))
}

fn chat_completion(message: Value, finish_reason: &str) -> Value {
    json!({
        "id": "chatcmpl-r44",
        "object": "chat.completion",
        "created": 1,
        "model": "wire-model",
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
    })
}

fn chat_has_tool_result(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages
            .iter()
            .any(|message| message["role"].as_str() == Some("tool"))
    })
}

fn chat_wire_tool_name(tools: &[Value], suffix: &str) -> String {
    tools
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .find(|name| *name == suffix || name.contains(suffix))
        .unwrap_or_else(|| {
            panic!("chat provider wire must carry a flattened function for `{suffix}`: {tools:?}")
        })
        .to_string()
}

// ---------------------------------------------------------------------------
// Client-response readers
// ---------------------------------------------------------------------------

fn response_item_by_call_id<'a>(body: &'a Value, call_id: &str) -> &'a Value {
    body["output"]
        .as_array()
        .unwrap_or_else(|| panic!("Responses body must contain an output array: {body}"))
        .iter()
        .find(|item| item["call_id"] == call_id)
        .unwrap_or_else(|| panic!("Responses body must contain call_id {call_id}: {body}"))
}

fn response_text(body: &Value) -> String {
    if let Some(text) = body["output_text"].as_str() {
        return text.to_string();
    }
    body["output"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| {
            item["text"].as_str().into_iter().chain(
                item["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|content| content["text"].as_str()),
            )
        })
        .collect::<String>()
}

fn chat_tool_call_by_id<'a>(body: &'a Value, call_id: &str) -> &'a Value {
    body["choices"][0]["message"]["tool_calls"]
        .as_array()
        .unwrap_or_else(|| panic!("Chat body must contain tool_calls: {body}"))
        .iter()
        .find(|call| call["id"] == call_id)
        .unwrap_or_else(|| panic!("Chat body must contain tool call {call_id}: {body}"))
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

fn responses_manifest(
    server_port: u16,
    upstream_port: u16,
    key_env: &str,
) -> V3Config05ManifestPublished {
    compile(
        server_port,
        "responses",
        &format!("http://127.0.0.1:{upstream_port}/v1"),
        key_env,
    )
}

fn chat_manifest(
    server_port: u16,
    upstream_port: u16,
    key_env: &str,
) -> V3Config05ManifestPublished {
    compile(
        server_port,
        "openai_chat",
        &format!("http://127.0.0.1:{upstream_port}/v1"),
        key_env,
    )
}

fn compile(
    server_port: u16,
    endpoint: &str,
    base_url: &str,
    key_env: &str,
) -> V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{declaration}

[servers.direct_json]
bind = "127.0.0.1"
port = {server_port}
routing_group = "direct_json"
endpoints = ["{endpoint}"]

{execution}

[providers.controlled]
type = "{provider_type}"
base_url = "{base_url}"
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{key_env}" }}] }}
[providers.controlled.models.wire-model]
wire_name = "wire-model"
aliases = ["client-model"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.direct_json.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["client-model"] }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "wire-model", key = "key", priority = 1 }}]
[route_groups.direct_json.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "wire-model", key = "key", priority = 1 }}]
"#,
        declaration = hub_v1_test_declaration(),
        execution = hub_v1_server_execution("direct_json"),
        provider_type = endpoint,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn failover_manifest(
    server_port: u16,
    endpoint: &str,
    failing_base_url: &str,
    success_base_url: &str,
    key_env: &str,
) -> V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{declaration}

[servers.direct_json]
bind = "127.0.0.1"
port = {server_port}
routing_group = "direct_json"
endpoints = ["{endpoint}"]

{execution}

[providers.failing]
type = "{provider_type}"
base_url = "{failing_base_url}"
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{key_env}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.failing.models.wire-model]
wire_name = "wire-model"
aliases = ["client-model"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.success]
type = "{provider_type}"
base_url = "{success_base_url}"
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{key_env}" }}] }}
[providers.success.models.wire-model]
wire_name = "wire-model"
aliases = ["client-model"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.direct_json.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["client-model"] }}
targets = [
  {{ kind = "provider_model", provider = "failing", model = "wire-model", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "success", model = "wire-model", key = "key", priority = 1 }}
]
[route_groups.direct_json.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "failing", model = "wire-model", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "success", model = "wire-model", key = "key", priority = 1 }}
]
"#,
        declaration = hub_v1_test_declaration(),
        execution = hub_v1_server_execution("direct_json"),
        provider_type = endpoint,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

// ---------------------------------------------------------------------------
// Provider-wire assertions
// ---------------------------------------------------------------------------

fn assert_responses_wire_acceptable(wire: &Value) {
    let tools = wire["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("provider wire must carry tools: {wire}"));
    assert_eq!(tools.len(), 3, "flattened declarations: {tools:?}");
    for tool in tools {
        assert_eq!(
            tool["type"], "function",
            "provider wire tools must be flattened functions: {tool}"
        );
        let name = tool["name"]
            .as_str()
            .unwrap_or_else(|| panic!("provider tool must carry a name: {tool}"));
        assert!(!name.is_empty());
        assert!(
            !name.contains('.'),
            "provider function names must be a single flat identifier: {name}"
        );
        assert_eq!(
            tool["parameters"]["type"], "object",
            "provider function must carry an object schema: {tool}"
        );
    }
    let exec = responses_wire_tool_name(tools, "exec");
    let patch = responses_wire_tool_name(tools, "apply_patch");
    let mcp = responses_wire_tool_name(tools, "opaque_leaf");
    assert_eq!(exec, "functions__exec");
    assert_eq!(patch, "functions__apply_patch");
    assert_ne!(mcp, "opaque_leaf");
    assert!(mcp.contains("opaque_leaf"), "{mcp}");
}

fn assert_chat_wire_acceptable(wire: &Value) {
    let tools = wire["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("provider wire must carry tools: {wire}"));
    assert_eq!(tools.len(), 3, "flattened declarations: {tools:?}");
    for tool in tools {
        assert_eq!(
            tool["type"], "function",
            "chat provider tools must be flattened functions: {tool}"
        );
        assert!(
            tool["function"]["name"].is_string(),
            "chat provider function must carry a name: {tool}"
        );
        assert_eq!(
            tool["function"]["parameters"]["type"], "object",
            "chat provider function must carry an object schema: {tool}"
        );
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Socket-free guard: the Direct JSON manifests must compile and select the
/// Direct binding for both entry protocols. This runs even where loopback bind
/// is denied, so config authoring regressions surface before the HTTP cases.
#[test]
fn req02_direct_json_manifests_compile() {
    let responses = responses_manifest(46_401, 9_999, RESPONSES_KEY_ENV);
    let server = responses
        .servers
        .get("direct_json")
        .expect("responses manifest must publish the direct_json server");
    assert_eq!(server.endpoints.len(), 1);
    assert!(server
        .endpoints
        .iter()
        .any(|endpoint| endpoint == "responses"));
    assert!(responses.providers.contains_key("controlled"));

    let chat = chat_manifest(46_402, 9_999, CHAT_KEY_ENV);
    let chat_server = chat
        .servers
        .get("direct_json")
        .expect("chat manifest must publish the direct_json server");
    assert!(chat_server
        .endpoints
        .iter()
        .any(|endpoint| endpoint == "openai_chat"));
    assert!(chat.providers.contains_key("controlled"));

    let failover = failover_manifest(
        46_403,
        "responses",
        "http://127.0.0.1:9/v1",
        "http://127.0.0.1:9/v1",
        RESPONSES_KEY_ENV,
    );
    assert!(failover.providers.contains_key("failing"));
    assert!(failover.providers.contains_key("success"));
}

#[tokio::test]
async fn req02_direct_json_responses_successful_inverse_and_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(RESPONSES_KEY_ENV, "req02-r44-direct-json-responses-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: captures_tx,
            behavior: UpstreamBehavior::EmitTools,
            hold: None,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let handle = spawn_v3_server_aggregate(responses_manifest(
        free_port(),
        upstream_addr.port(),
        RESPONSES_KEY_ENV,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let tools = direct_responses_tools();

    let first = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "run every tool"}],
            "tools": tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body: Value = first.json().await.unwrap();
    assert!(first_body.get("error").is_none(), "{first_body}");

    // The real provider wire must be acceptable to the provider.
    let first_wire = recv_capture(&mut captures_rx).await;
    assert_responses_wire_acceptable(&first_wire);
    assert!(first_wire["input"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["role"] == "user"));

    // Client response restores the original namespace/name/kind plus identity.
    let exec_call = response_item_by_call_id(&first_body, "exec-call").clone();
    assert_eq!(exec_call["type"], "function_call");
    assert_eq!(exec_call["namespace"], "functions");
    assert_eq!(exec_call["name"], "exec");
    assert_eq!(exec_call["id"], "item-exec");
    assert_eq!(exec_call["arguments"], exec_arguments());
    assert!(
        exec_call["arguments"].as_str().unwrap().len() >= 70_000,
        "exec command must stay above 70KB"
    );
    assert!(exec_call["arguments"].as_str().unwrap().contains("\\r\\n"));
    assert!(exec_call["arguments"].as_str().unwrap().contains("$()"));
    assert!(exec_call["arguments"].as_str().unwrap().contains('`'));

    let patch_call = response_item_by_call_id(&first_body, "patch-call").clone();
    assert_eq!(patch_call["type"], "custom_tool_call");
    assert_eq!(patch_call["namespace"], "functions");
    assert_eq!(patch_call["name"], "apply_patch");
    assert_eq!(patch_call["id"], "item-patch");
    assert_eq!(patch_call["input"], APPLY_PATCH);

    let mcp_call = response_item_by_call_id(&first_body, "mcp-call").clone();
    assert_eq!(mcp_call["type"], "function_call");
    assert_eq!(mcp_call["namespace"], "mcp__demo__");
    assert_eq!(mcp_call["name"], "opaque_leaf");
    assert_eq!(mcp_call["id"], "item-mcp");
    assert_eq!(mcp_call["arguments"], mcp_arguments());

    // Follow-up: send the corresponding tool outputs and succeed.
    let followup = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-model",
            "input": [
                {"role": "user", "content": "run every tool"},
                exec_call,
                {"type": "function_call_output", "call_id": "exec-call", "output": "exec output"},
                patch_call,
                {"type": "custom_tool_call_output", "call_id": "patch-call", "output": "patch output"},
                mcp_call,
                {"type": "function_call_output", "call_id": "mcp-call", "output": "mcp output"}
            ],
            "tools": tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(followup.status(), StatusCode::OK);
    let followup_body: Value = followup.json().await.unwrap();
    assert_eq!(response_text(&followup_body), FINAL_TEXT);

    let followup_wire = recv_capture(&mut captures_rx).await;
    assert_eq!(followup_wire["tools"], first_wire["tools"]);
    let history = followup_wire["input"].as_array().unwrap();
    let exec_history = history
        .iter()
        .find(|item| item["call_id"] == "exec-call" && item["type"] == "function_call")
        .unwrap_or_else(|| panic!("follow-up wire must carry the exec call: {followup_wire}"));
    assert_eq!(exec_history["name"], "functions__exec");
    assert_eq!(exec_history["namespace"], "functions");
    assert_eq!(exec_history["arguments"], exec_arguments());
    let patch_history = history
        .iter()
        .find(|item| item["call_id"] == "patch-call")
        .unwrap_or_else(|| panic!("follow-up wire must carry the patch call: {followup_wire}"));
    assert_eq!(patch_history["name"], "functions__apply_patch");
    assert_eq!(patch_history["namespace"], "functions");
    assert!(
        history
            .iter()
            .any(|item| item["call_id"] == "exec-call" && item["type"] == "function_call_output"),
        "follow-up wire must carry the exec output: {followup_wire}"
    );
    assert!(
        history
            .iter()
            .any(|item| item["call_id"] == "mcp-call" && item["type"] == "function_call_output"),
        "follow-up wire must carry the mcp output: {followup_wire}"
    );

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(RESPONSES_KEY_ENV);
}

#[tokio::test]
async fn req02_direct_json_chat_successful_inverse_and_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(CHAT_KEY_ENV, "req02-r44-direct-json-chat-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(chat_upstream))
        .with_state(Arc::new(ChatState {
            captures: captures_tx,
            behavior: UpstreamBehavior::EmitTools,
            hold: None,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let handle = spawn_v3_server_aggregate(chat_manifest(
        free_port(),
        upstream_addr.port(),
        CHAT_KEY_ENV,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let tools = direct_responses_tools();

    let first = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-model",
            "messages": [{"role": "user", "content": "run every tool"}],
            "tools": tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body: Value = first.json().await.unwrap();

    let first_wire = recv_capture(&mut captures_rx).await;
    assert_chat_wire_acceptable(&first_wire);

    let exec_call = chat_tool_call_by_id(&first_body, "exec-call").clone();
    assert_eq!(exec_call["type"], "function");
    assert_eq!(exec_call["function"]["namespace"], "functions");
    assert_eq!(exec_call["function"]["name"], "exec");
    assert_eq!(exec_call["function"]["arguments"], exec_arguments());

    let patch_call = chat_tool_call_by_id(&first_body, "patch-call").clone();
    assert_eq!(patch_call["type"], "custom");
    assert_eq!(patch_call["custom"]["namespace"], "functions");
    assert_eq!(patch_call["custom"]["name"], "apply_patch");
    assert_eq!(patch_call["custom"]["input"], APPLY_PATCH);

    let mcp_call = chat_tool_call_by_id(&first_body, "mcp-call").clone();
    assert_eq!(mcp_call["type"], "function");
    assert_eq!(mcp_call["function"]["namespace"], "mcp__demo__");
    assert_eq!(mcp_call["function"]["name"], "opaque_leaf");
    assert_eq!(mcp_call["function"]["arguments"], mcp_arguments());

    let followup = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-model",
            "messages": [
                {"role": "user", "content": "run every tool"},
                {"role": "assistant", "content": null, "tool_calls": [exec_call, patch_call, mcp_call]},
                {"role": "tool", "tool_call_id": "exec-call", "content": "exec output"},
                {"role": "tool", "tool_call_id": "patch-call", "content": "patch output"},
                {"role": "tool", "tool_call_id": "mcp-call", "content": "mcp output"}
            ],
            "tools": tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(followup.status(), StatusCode::OK);
    let followup_body: Value = followup.json().await.unwrap();
    assert_eq!(
        followup_body["choices"][0]["message"]["content"],
        FINAL_TEXT
    );

    let followup_wire = recv_capture(&mut captures_rx).await;
    assert_eq!(followup_wire["tools"], first_wire["tools"]);
    let messages = followup_wire["messages"].as_array().unwrap();
    let assistant = messages
        .iter()
        .find(|message| message["tool_calls"].is_array())
        .unwrap_or_else(|| panic!("follow-up wire must carry the assistant call: {followup_wire}"));
    let calls = assistant["tool_calls"].as_array().unwrap();
    let exec_wire = calls
        .iter()
        .find(|call| call["id"] == "exec-call")
        .expect("exec call in follow-up wire");
    assert_eq!(exec_wire["function"]["name"], "functions__exec");
    assert_eq!(exec_wire["function"]["arguments"], exec_arguments());

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(CHAT_KEY_ENV);
}

#[tokio::test]
async fn req02_direct_json_provider_failure_then_second_success() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(RESPONSES_KEY_ENV, "req02-r44-direct-json-responses-secret");

    let (failing_tx, mut failing_rx) = mpsc::unbounded_channel();
    let failing_app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: failing_tx,
            behavior: UpstreamBehavior::Fail,
            hold: None,
        }));
    let (failing_addr, failing_upstream) = spawn_upstream(failing_app).await;

    let (success_tx, mut success_rx) = mpsc::unbounded_channel();
    let success_app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: success_tx,
            behavior: UpstreamBehavior::EmitTools,
            hold: None,
        }));
    let (success_addr, success_upstream) = spawn_upstream(success_app).await;

    let handle = spawn_v3_server_aggregate(failover_manifest(
        free_port(),
        "responses",
        &format!("http://127.0.0.1:{}/v1", failing_addr.port()),
        &format!("http://127.0.0.1:{}/v1", success_addr.port()),
        RESPONSES_KEY_ENV,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::new();

    let response = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "recover from a provider failure"}],
            "tools": direct_responses_tools(),
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert!(body.get("error").is_none(), "{body}");

    // Both providers must have been attempted, in priority order.
    let failing_capture = recv_capture(&mut failing_rx).await;
    assert_responses_wire_acceptable(&failing_capture);
    let success_capture = recv_capture(&mut success_rx).await;
    assert_responses_wire_acceptable(&success_capture);

    // The client must observe the successful attempt's emission only.
    let exec_call = response_item_by_call_id(&body, "exec-call").clone();
    assert_eq!(exec_call["namespace"], "functions");
    assert_eq!(exec_call["name"], "exec");
    assert_eq!(exec_call["arguments"], exec_arguments());
    let patch_call = response_item_by_call_id(&body, "patch-call").clone();
    assert_eq!(patch_call["type"], "custom_tool_call");
    assert_eq!(patch_call["input"], APPLY_PATCH);
    let mcp_call = response_item_by_call_id(&body, "mcp-call").clone();
    assert_eq!(mcp_call["namespace"], "mcp__demo__");
    assert_eq!(mcp_call["arguments"], mcp_arguments());
    assert!(
        success_rx.try_recv().is_err(),
        "a single request must not issue extra successful attempts"
    );

    handle.shutdown().await;
    failing_upstream.shutdown().await;
    success_upstream.shutdown().await;
    std::env::remove_var(RESPONSES_KEY_ENV);
}

#[tokio::test]
async fn req02_direct_json_complete_exhaustion_no_client_error() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(RESPONSES_KEY_ENV, "req02-r44-direct-json-responses-secret");

    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    let first_app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: first_tx,
            behavior: UpstreamBehavior::Fail,
            hold: None,
        }));
    let (first_addr, first_upstream) = spawn_upstream(first_app).await;

    let (second_tx, mut second_rx) = mpsc::unbounded_channel();
    let second_app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: second_tx,
            behavior: UpstreamBehavior::Fail,
            hold: None,
        }));
    let (second_addr, second_upstream) = spawn_upstream(second_app).await;

    let handle = spawn_v3_server_aggregate(failover_manifest(
        free_port(),
        "responses",
        &format!("http://127.0.0.1:{}/v1", first_addr.port()),
        &format!("http://127.0.0.1:{}/v1", second_addr.port()),
        RESPONSES_KEY_ENV,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    let result = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "exhaust every provider"}],
            "tools": direct_responses_tools(),
            "stream": false
        }))
        .send()
        .await;
    match result {
        Ok(response) => panic!(
            "route-pool exhaustion must not produce a client HTTP response, got {}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        ),
        Err(error) => assert!(
            error.is_request() || error.is_body() || error.is_decode(),
            "expected an aborted client transport, got: {error}"
        ),
    }

    // Both candidates must have been attempted before exhaustion.
    let first_capture = recv_capture(&mut first_rx).await;
    assert_responses_wire_acceptable(&first_capture);
    let second_capture = recv_capture(&mut second_rx).await;
    assert_responses_wire_acceptable(&second_capture);

    handle.shutdown().await;
    first_upstream.shutdown().await;
    second_upstream.shutdown().await;
    std::env::remove_var(RESPONSES_KEY_ENV);
}

#[tokio::test]
async fn req02_direct_json_client_disconnect_does_not_poison_followup_session() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(RESPONSES_KEY_ENV, "req02-r44-direct-json-responses-secret");

    let hold = Arc::new(Mutex::new(()));
    let hold_guard = hold.lock().await;
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: captures_tx,
            behavior: UpstreamBehavior::EmitTools,
            hold: Some(hold.clone()),
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let handle = spawn_v3_server_aggregate(responses_manifest(
        free_port(),
        upstream_addr.port(),
        RESPONSES_KEY_ENV,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);

    let disconnected_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let disconnected = disconnected_client
        .post(&endpoint)
        .header("session-id", "req02-r44-disconnected-session")
        .json(&json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "disconnect mid-attempt"}],
            "tools": direct_responses_tools(),
            "stream": false
        }))
        .send();
    tokio::pin!(disconnected);
    tokio::select! {
        result = &mut disconnected => {
            panic!("held request must not complete before client disconnect: {result:?}")
        }
        capture = recv_capture(&mut captures_rx) => {
            assert_responses_wire_acceptable(&capture);
        }
    }
    drop(disconnected);
    drop(hold_guard);

    // An independent session must still succeed after the disconnect.
    let survivor_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let tools = direct_responses_tools();
    let survivor = survivor_client
        .post(&endpoint)
        .header("session-id", "req02-r44-survivor-session")
        .json(&json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "survivor session runs tools"}],
            "tools": tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(survivor.status(), StatusCode::OK);
    let survivor_body: Value = survivor.json().await.unwrap();
    let survivor_exec = response_item_by_call_id(&survivor_body, "exec-call").clone();
    assert_eq!(survivor_exec["namespace"], "functions");
    assert_eq!(survivor_exec["name"], "exec");
    assert_eq!(survivor_exec["arguments"], exec_arguments());

    let survivor_capture = recv_capture(&mut captures_rx).await;
    assert_responses_wire_acceptable(&survivor_capture);

    let survivor_followup = survivor_client
        .post(&endpoint)
        .header("session-id", "req02-r44-survivor-session")
        .json(&json!({
            "model": "client-model",
            "input": [
                {"role": "user", "content": "survivor session runs tools"},
                survivor_exec,
                {"type": "function_call_output", "call_id": "exec-call", "output": "exec output"}
            ],
            "tools": tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(survivor_followup.status(), StatusCode::OK);
    let survivor_followup_body: Value = survivor_followup.json().await.unwrap();
    assert_eq!(response_text(&survivor_followup_body), FINAL_TEXT);

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(RESPONSES_KEY_ENV);
}
