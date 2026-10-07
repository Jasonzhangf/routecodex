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

const CHAT_KEY_ENV: &str = "REQ02_RUNTIME_TOOL_CHAT_KEY";
const ANTHROPIC_KEY_ENV: &str = "REQ02_RUNTIME_TOOL_ANTHROPIC_KEY";
const CHAT_FINAL_TEXT: &str = "REQ02_CHAT_FINAL_TEXT";
const ANTHROPIC_FINAL_TEXT: &str = "REQ02_ANTHROPIC_FINAL_TEXT";

const EXEC_ARGUMENTS: &str = r#"{"cmd":"printf '%s\n' 'REQ02_EXEC_HEAD_SENTINEL'\nprintf '%s' 'REQ02_EXEC_TAIL_SENTINEL'","cwd":"/workspace/routecodex","yield_time_ms":1000}"#;
const EXEC_OUTPUT: &str = "exec output line 1\nexec output line 2\nREQ02_EXEC_OUTPUT_TAIL_SENTINEL";

const APPLY_PATCH: &str = "*** Begin Patch\n*** Add File: /tmp/req02-runtime-tools.txt\n+\u{4e2d}\u{6587} literal $() and `backtick`\n*** Update File: /tmp/req02-runtime-tools.txt\n@@\n-old\n+new\n*** End Patch\n";
const PATCH_OUTPUT: &str =
    "apply patch output line 1\n\u{4e2d}\u{6587}\nREQ02_PATCH_OUTPUT_TAIL_SENTINEL";

const MCP_FUNCTION_ARGUMENTS: &str =
    r#"{"opaque":{"items":[1,2,3],"text":"mcp-opaque"},"request_id":"mcp-req-1"}"#;
const MCP_FUNCTION_OUTPUT: &str =
    "mcp function output line 1\nmcp function output line 2\nREQ02_MCP_FUNCTION_OUTPUT_TAIL";
const MCP_CUSTOM_INPUT: &str =
    "mcp custom free-form input\nliteral $() and `backtick`\nREQ02_MCP_CUSTOM_INPUT_TAIL";
const MCP_CUSTOM_OUTPUT: &str =
    "mcp custom output line 1\nmcp custom output line 2\nREQ02_MCP_CUSTOM_OUTPUT_TAIL";

#[derive(Debug)]
struct ProviderCapture {
    body: Value,
}

#[derive(Clone)]
struct CaptureState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

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

fn capture(state: &CaptureState, body: Value) {
    state
        .captures
        .send(ProviderCapture { body })
        .expect("provider capture channel must remain open");
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

async fn recv_capture(captures: &mut mpsc::UnboundedReceiver<ProviderCapture>) -> ProviderCapture {
    tokio::time::timeout(Duration::from_secs(5), captures.recv())
        .await
        .expect("real HTTP upstream must receive the provider request")
        .expect("provider capture channel must remain open")
}

fn response_output_item<'a>(body: &'a Value, item_type: &str) -> &'a Value {
    body["output"]
        .as_array()
        .unwrap_or_else(|| panic!("Responses body must contain output array: {body}"))
        .iter()
        .find(|item| item["type"] == item_type)
        .unwrap_or_else(|| panic!("Responses body must contain {item_type}: {body}"))
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

fn sse_data_events(body: &str) -> Vec<Value> {
    body.split("\n\n")
        .filter_map(|frame| {
            let data = frame
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim_start)
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                return None;
            }
            Some(
                serde_json::from_str(&data)
                    .unwrap_or_else(|error| panic!("SSE data must be JSON: {error}: {data}")),
            )
        })
        .collect()
}

fn sse_completed_response(body: &str) -> Value {
    let events = sse_data_events(body);
    assert!(
        events
            .iter()
            .all(|event| { event["type"] != "error" && event["type"] != "response.failed" }),
        "SSE body must not carry client error events: {body}"
    );
    events
        .into_iter()
        .find(|event| event["type"] == "response.completed")
        .unwrap_or_else(|| panic!("SSE body must complete: {body}"))["response"]
        .clone()
}

async fn post_responses_sse(client: &reqwest::Client, endpoint: &str, body: Value) -> String {
    let response = client
        .post(endpoint)
        .header("accept", "text/event-stream")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("text/event-stream")
    );
    response.text().await.unwrap()
}

fn functions_exec_tools() -> Value {
    json!([{
        "type": "namespace",
        "name": "functions",
        "description": "Functions namespace.",
        "tools": [{
            "type": "function",
            "name": "exec",
            "description": "Run a command.",
            "strict": false,
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
        }]
    }])
}

fn functions_apply_patch_tools() -> Value {
    json!([{
        "type": "namespace",
        "name": "functions",
        "description": "Functions namespace.",
        "tools": [{
            "type": "custom",
            "name": "apply_patch",
            "description": "Apply a free-form patch.",
            "format": {"type": "text"}
        }]
    }])
}

fn mcp_function_tools() -> Value {
    json!([{
        "type": "namespace",
        "name": "mcp__demo__",
        "description": "MCP demo namespace.",
        "tools": [{
            "type": "function",
            "name": "opaque_leaf",
            "description": "Opaque MCP function.",
            "strict": false,
            "parameters": {
                "type": "object",
                "properties": {
                    "payload": {"type": "string"}
                },
                "required": ["payload"],
                "additionalProperties": true
            }
        }]
    }])
}

fn mcp_custom_tools() -> Value {
    json!([{
        "type": "namespace",
        "name": "mcp__demo__",
        "description": "MCP demo namespace.",
        "tools": [{
            "type": "custom",
            "name": "opaque_leaf",
            "description": "Opaque MCP custom tool.",
            "format": {"type": "text"}
        }]
    }])
}

#[derive(Clone, Copy)]
enum ChatMode {
    Exec,
    McpSchemaDriven,
}

#[derive(Clone)]
struct ChatState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
    mode: ChatMode,
    hold: Option<Arc<Mutex<()>>>,
}

fn chat_has_tool_result(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages
            .iter()
            .any(|message| message["role"].as_str() == Some("tool"))
    })
}

fn chat_emitted_tool_name(body: &Value) -> String {
    body.pointer("/tools/0/function/name")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("Chat request must carry an emitted function name: {body}"))
        .to_string()
}

fn chat_custom_wrapper(body: &Value) -> bool {
    let Some(parameters) = body.pointer("/tools/0/function/parameters") else {
        return false;
    };
    let required = parameters
        .get("required")
        .and_then(Value::as_array)
        .is_some_and(|values| values.len() == 1 && values[0] == "input");
    let properties = parameters
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(|values| values.len() == 1 && values.contains_key("input"));
    required && properties
}

fn chat_tool_call_id(mode: ChatMode, custom_wrapper: bool) -> &'static str {
    match (mode, custom_wrapper) {
        (ChatMode::Exec, _) => "call_runtime_exec",
        (ChatMode::McpSchemaDriven, false) => "call_mcp_function",
        (ChatMode::McpSchemaDriven, true) => "call_mcp_custom",
    }
}

fn chat_tool_completion(alias: &str, call_id: &str, arguments: &str) -> Value {
    json!({
        "id": format!("chatcmpl-{call_id}"),
        "object": "chat.completion",
        "created": 1,
        "model": "wire-model",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": alias,
                        "arguments": arguments
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
    })
}

fn chat_final_completion(text: &str) -> Value {
    json!({
        "id": "chatcmpl-runtime-tools-final",
        "object": "chat.completion",
        "created": 2,
        "model": "wire-model",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}
    })
}

async fn chat_tool_upstream(
    State(state): State<Arc<ChatState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture(
        &CaptureState {
            captures: state.captures.clone(),
        },
        body.clone(),
    );
    assert_wire_omits_responses_include("openai_chat", &body);

    if let Some(hold) = &state.hold {
        let _hold = hold.lock().await;
    }

    if chat_has_tool_result(&body) {
        return json_response(chat_final_completion(CHAT_FINAL_TEXT));
    }

    let custom_wrapper = chat_custom_wrapper(&body);
    let call_id = chat_tool_call_id(state.mode, custom_wrapper);
    let alias = chat_emitted_tool_name(&body);
    let arguments = match state.mode {
        ChatMode::Exec => EXEC_ARGUMENTS.to_string(),
        ChatMode::McpSchemaDriven if custom_wrapper => {
            json!({"input": MCP_CUSTOM_INPUT}).to_string()
        }
        ChatMode::McpSchemaDriven => MCP_FUNCTION_ARGUMENTS.to_string(),
    };
    json_response(chat_tool_completion(&alias, call_id, &arguments))
}

async fn chat_failure_upstream(
    State(state): State<Arc<CaptureState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    assert_wire_omits_responses_include("openai_chat", &body);
    capture(state.as_ref(), body);
    status_json(
        StatusCode::BAD_REQUEST,
        json!({
            "error": {
                "message": "controlled provider 400",
                "type": "invalid_request_error",
                "code": "req02_controlled_provider_400"
            }
        }),
    )
}

async fn anthropic_custom_upstream(
    State(state): State<Arc<CaptureState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture(state.as_ref(), body.clone());
    assert_wire_omits_responses_include("anthropic", &body);

    if anthropic_has_tool_result(&body) {
        return json_response(anthropic_final_message(ANTHROPIC_FINAL_TEXT));
    }

    let alias = body
        .pointer("/tools/0/name")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("Anthropic request must carry an emitted tool name: {body}"));
    json_response(json!({
        "id": "msg_runtime_tools",
        "type": "message",
        "role": "assistant",
        "model": "anthropic-wire",
        "content": [{
            "type": "tool_use",
            "id": "call_custom_patch",
            "name": alias,
            "input": {"input": APPLY_PATCH}
        }],
        "stop_reason": "tool_use",
        "stop_sequence": null,
        "usage": {"input_tokens": 3, "output_tokens": 2}
    }))
}

fn anthropic_has_tool_result(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages.iter().any(|message| {
            message["content"].as_array().is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| part["type"].as_str() == Some("tool_result"))
            })
        })
    })
}

fn anthropic_final_message(text: &str) -> Value {
    json!({
        "id": "msg_runtime_tools_final",
        "type": "message",
        "role": "assistant",
        "model": "anthropic-wire",
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": null,
        "usage": {"input_tokens": 5, "output_tokens": 3}
    })
}

fn chat_assistant_tool_call<'a>(body: &'a Value, call_id: &str) -> &'a Value {
    body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["tool_calls"].as_array().into_iter().flatten())
        .find(|tool_call| tool_call["id"] == call_id)
        .unwrap_or_else(|| panic!("Chat provider request must carry tool call {call_id}: {body}"))
}

fn chat_tool_result_text<'a>(body: &'a Value, call_id: &str) -> String {
    let message = body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|message| {
            message["role"].as_str() == Some("tool") && message["tool_call_id"] == call_id
        })
        .unwrap_or_else(|| {
            panic!("Chat provider request must carry tool result {call_id}: {body}")
        });
    content_text(&message["content"])
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<String>(),
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        other => panic!("unsupported tool result content shape: {other:?}"),
    }
}

fn anthropic_content_part<'a>(body: &'a Value, call_id: &str, part_type: &str) -> &'a Value {
    body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .find(|part| {
            part["type"] == part_type
                && match part_type {
                    "tool_use" => part["id"] == call_id,
                    "tool_result" => part["tool_use_id"] == call_id,
                    _ => false,
                }
        })
        .unwrap_or_else(|| {
            panic!("Anthropic provider request must carry {part_type} {call_id}: {body}")
        })
}

fn anthropic_tool_result_text(body: &Value, call_id: &str) -> String {
    let part = anthropic_content_part(body, call_id, "tool_result");
    content_text(&part["content"])
}

/// The Responses `include` selector has no Chat/Anthropic wire equivalent.
/// The standard outbound projection must drop it before the provider sees the
/// request instead of leaking an unmapped Responses field into the wire.
fn assert_wire_omits_responses_include(protocol: &str, body: &Value) {
    assert!(
        body.get("include").is_none(),
        "{protocol} provider wire must not carry the Responses include field: {body}"
    );
}

const RESPONSES_DIRECT_BINDING: &str = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
const RESPONSES_RELAY_BINDING: &str = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;

fn responses_relay_declaration() -> String {
    hub_v1_test_declaration().replace(RESPONSES_DIRECT_BINDING, RESPONSES_RELAY_BINDING)
}

fn single_provider_manifest(
    server_port: u16,
    provider_type: &str,
    base_url: &str,
    key_env: &str,
) -> V3Config05ManifestPublished {
    let declaration = responses_relay_declaration();
    let execution = hub_v1_server_execution("req02_runtime_tools");
    let model_extra = if provider_type == "anthropic" {
        "supports_thinking = false"
    } else {
        ""
    };
    let source = format!(
        r#"
version = 3

{declaration}

[servers.req02_runtime_tools]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req02_runtime_tools"
endpoints = ["responses"]

{execution}

[providers.controlled]
type = "{provider_type}"
base_url = "{base_url}"
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{key_env}" }}] }}
responses = {{ process = "chat", streaming = "always" }}
[providers.controlled.models.wire-model]
wire_name = "wire-model"
aliases = ["client-tool"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
{model_extra}

[route_groups.req02_runtime_tools.pools.client_tool]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-tool"] }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "wire-model", key = "key", priority = 1 }}]
[route_groups.req02_runtime_tools.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "wire-model", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn failover_manifest(
    server_port: u16,
    failing_base_url: &str,
    success_base_url: &str,
    key_env: &str,
) -> V3Config05ManifestPublished {
    let declaration = responses_relay_declaration();
    let execution = hub_v1_server_execution("req02_runtime_tools");
    let source = format!(
        r#"
version = 3

{declaration}

[servers.req02_runtime_tools]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req02_runtime_tools"
endpoints = ["responses"]

{execution}

[providers.failing]
type = "openai_chat"
base_url = "{failing_base_url}"
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{key_env}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}
[providers.failing.models.wire-model]
wire_name = "wire-model"
aliases = ["client-tool"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[providers.success]
type = "openai_chat"
base_url = "{success_base_url}"
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{key_env}" }}] }}
responses = {{ process = "chat", streaming = "always" }}
[providers.success.models.wire-model]
wire_name = "wire-model"
aliases = ["client-tool"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.req02_runtime_tools.pools.client_tool]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-tool"] }}
targets = [
  {{ kind = "provider_model", provider = "failing", model = "wire-model", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "success", model = "wire-model", key = "key", priority = 1 }}
]
[route_groups.req02_runtime_tools.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "failing", model = "wire-model", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "success", model = "wire-model", key = "key", priority = 1 }}
]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

#[tokio::test]
async fn req02_responses_chat_function_round_trip_preserves_identity_and_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(CHAT_KEY_ENV, "req02-chat-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(chat_tool_upstream))
        .with_state(Arc::new(ChatState {
            captures: captures_tx,
            mode: ChatMode::Exec,
            hold: None,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let manifest = single_provider_manifest(
        free_port(),
        "openai_chat",
        &format!("http://127.0.0.1:{}/v1", upstream_addr.port()),
        CHAT_KEY_ENV,
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let tools = functions_exec_tools();

    let first = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [{"role": "user", "content": "run exec"}],
            "tools": tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body: Value = first.json().await.unwrap();
    let call = response_output_item(&first_body, "function_call").clone();
    assert_eq!(call["namespace"], "functions");
    assert_eq!(call["name"], "exec");
    assert_eq!(call["call_id"], "call_runtime_exec");
    assert_eq!(call["arguments"], EXEC_ARGUMENTS);

    let first_capture = recv_capture(&mut captures_rx).await;
    let alias = chat_emitted_tool_name(&first_capture.body);
    assert_ne!(alias, "exec");
    assert!(alias.contains("functions"), "{alias}");
    assert_eq!(first_capture.body["messages"][0]["content"], "run exec");

    let second = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [
                {"role": "user", "content": "run exec"},
                call,
                {
                    "type": "function_call_output",
                    "call_id": "call_runtime_exec",
                    "output": EXEC_OUTPUT
                }
            ],
            "tools": tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second_body: Value = second.json().await.unwrap();
    assert_eq!(response_text(&second_body), CHAT_FINAL_TEXT);

    let second_capture = recv_capture(&mut captures_rx).await;
    let assistant_call = chat_assistant_tool_call(&second_capture.body, "call_runtime_exec");
    assert_eq!(assistant_call["function"]["name"], alias);
    assert_eq!(assistant_call["function"]["arguments"], EXEC_ARGUMENTS);
    assert_eq!(
        chat_tool_result_text(&second_capture.body, "call_runtime_exec"),
        EXEC_OUTPUT
    );

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(CHAT_KEY_ENV);
}

#[tokio::test]
async fn req02_responses_anthropic_custom_round_trip_preserves_patch_and_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(ANTHROPIC_KEY_ENV, "req02-anthropic-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/messages", post(anthropic_custom_upstream))
        .with_state(Arc::new(CaptureState {
            captures: captures_tx,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let manifest = single_provider_manifest(
        free_port(),
        "anthropic",
        &format!("http://127.0.0.1:{}", upstream_addr.port()),
        ANTHROPIC_KEY_ENV,
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let tools = functions_apply_patch_tools();

    let first = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [{"role": "user", "content": "apply the patch"}],
            "tools": tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body: Value = first.json().await.unwrap();
    let call = response_output_item(&first_body, "custom_tool_call").clone();
    assert_eq!(call["namespace"], "functions");
    assert_eq!(call["name"], "apply_patch");
    assert_eq!(call["call_id"], "call_custom_patch");
    assert_eq!(call["input"], APPLY_PATCH);

    let first_capture = recv_capture(&mut captures_rx).await;
    let alias = first_capture.body["tools"][0]["name"]
        .as_str()
        .unwrap_or_else(|| {
            panic!(
                "Anthropic request must carry emitted tool: {}",
                first_capture.body
            )
        });
    assert_ne!(alias, "apply_patch");
    assert!(alias.contains("functions"), "{alias}");

    let second = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [
                {"role": "user", "content": "apply the patch"},
                call,
                {
                    "type": "custom_tool_call_output",
                    "call_id": "call_custom_patch",
                    "output": PATCH_OUTPUT
                }
            ],
            "tools": tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second_body: Value = second.json().await.unwrap();
    assert_eq!(
        response_text(&second_body),
        ANTHROPIC_FINAL_TEXT,
        "{second_body}"
    );

    let second_capture = recv_capture(&mut captures_rx).await;
    let tool_use = anthropic_content_part(&second_capture.body, "call_custom_patch", "tool_use");
    assert_eq!(tool_use["name"], alias);
    assert_eq!(tool_use["input"], json!({"input": APPLY_PATCH}));
    assert_eq!(
        anthropic_tool_result_text(&second_capture.body, "call_custom_patch"),
        PATCH_OUTPUT
    );

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(ANTHROPIC_KEY_ENV);
}

#[tokio::test]
async fn req02_responses_mcp_kind_isolation_and_failover_round_trip() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(CHAT_KEY_ENV, "req02-chat-secret");

    let (failing_tx, mut failing_rx) = mpsc::unbounded_channel();
    let failing_app = Router::new()
        .route("/v1/chat/completions", post(chat_failure_upstream))
        .with_state(Arc::new(CaptureState {
            captures: failing_tx,
        }));
    let (failing_addr, failing_upstream) = spawn_upstream(failing_app).await;

    let (success_tx, mut success_rx) = mpsc::unbounded_channel();
    let success_app = Router::new()
        .route("/v1/chat/completions", post(chat_tool_upstream))
        .with_state(Arc::new(ChatState {
            captures: success_tx,
            mode: ChatMode::McpSchemaDriven,
            hold: None,
        }));
    let (success_addr, success_upstream) = spawn_upstream(success_app).await;

    let manifest = failover_manifest(
        free_port(),
        &format!("http://127.0.0.1:{}/v1", failing_addr.port()),
        &format!("http://127.0.0.1:{}/v1", success_addr.port()),
        CHAT_KEY_ENV,
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::new();

    let function_tools = mcp_function_tools();
    let function_first = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [{"role": "user", "content": "mcp function kind"}],
            "tools": function_tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(function_first.status(), StatusCode::OK);
    let function_first_body: Value = function_first.json().await.unwrap();
    assert!(
        function_first_body.get("error").is_none(),
        "{function_first_body}"
    );
    let function_call = response_output_item(&function_first_body, "function_call").clone();
    assert_eq!(function_call["namespace"], "mcp__demo__");
    assert_eq!(function_call["name"], "opaque_leaf");
    assert_eq!(function_call["call_id"], "call_mcp_function");
    assert_eq!(function_call["arguments"], MCP_FUNCTION_ARGUMENTS);

    let failing_capture = recv_capture(&mut failing_rx).await;
    assert!(!chat_custom_wrapper(&failing_capture.body));
    let function_success_capture = recv_capture(&mut success_rx).await;
    assert!(!chat_custom_wrapper(&function_success_capture.body));
    let function_alias = chat_emitted_tool_name(&function_success_capture.body);
    assert_ne!(function_alias, "opaque_leaf");
    assert!(function_alias.contains("opaque_leaf"), "{function_alias}");

    let function_second = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [
                {"role": "user", "content": "mcp function kind"},
                function_call,
                {
                    "type": "function_call_output",
                    "call_id": "call_mcp_function",
                    "output": MCP_FUNCTION_OUTPUT
                }
            ],
            "tools": function_tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(function_second.status(), StatusCode::OK);
    let function_second_body: Value = function_second.json().await.unwrap();
    assert_eq!(response_text(&function_second_body), CHAT_FINAL_TEXT);
    let function_followup_capture = recv_capture(&mut success_rx).await;
    assert_eq!(
        chat_tool_result_text(&function_followup_capture.body, "call_mcp_function"),
        MCP_FUNCTION_OUTPUT
    );

    let custom_tools = mcp_custom_tools();
    let custom_first = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [{"role": "user", "content": "mcp custom kind"}],
            "tools": custom_tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(custom_first.status(), StatusCode::OK);
    let custom_first_body: Value = custom_first.json().await.unwrap();
    assert!(
        custom_first_body.get("error").is_none(),
        "{custom_first_body}"
    );
    let custom_call = response_output_item(&custom_first_body, "custom_tool_call").clone();
    assert_eq!(custom_call["namespace"], "mcp__demo__");
    assert_eq!(custom_call["name"], "opaque_leaf");
    assert_eq!(custom_call["call_id"], "call_mcp_custom");
    assert_eq!(custom_call["input"], MCP_CUSTOM_INPUT);

    let custom_success_capture = recv_capture(&mut success_rx).await;
    assert!(chat_custom_wrapper(&custom_success_capture.body));
    let custom_alias = chat_emitted_tool_name(&custom_success_capture.body);
    assert_ne!(custom_alias, "opaque_leaf");
    assert!(custom_alias.contains("opaque_leaf"), "{custom_alias}");

    let custom_second = client
        .post(&endpoint)
        .json(&json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [
                {"role": "user", "content": "mcp custom kind"},
                custom_call,
                {
                    "type": "custom_tool_call_output",
                    "call_id": "call_mcp_custom",
                    "output": MCP_CUSTOM_OUTPUT
                }
            ],
            "tools": custom_tools,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(custom_second.status(), StatusCode::OK);
    let custom_second_body: Value = custom_second.json().await.unwrap();
    assert_eq!(response_text(&custom_second_body), CHAT_FINAL_TEXT);
    let custom_followup_capture = recv_capture(&mut success_rx).await;
    assert_eq!(
        chat_tool_result_text(&custom_followup_capture.body, "call_mcp_custom"),
        MCP_CUSTOM_OUTPUT
    );

    handle.shutdown().await;
    failing_upstream.shutdown().await;
    success_upstream.shutdown().await;
    std::env::remove_var(CHAT_KEY_ENV);
}

#[tokio::test]
async fn req02_responses_sse_function_exec_round_trip_preserves_identity_and_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(CHAT_KEY_ENV, "req02-chat-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(chat_tool_upstream))
        .with_state(Arc::new(ChatState {
            captures: captures_tx,
            mode: ChatMode::Exec,
            hold: None,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let manifest = single_provider_manifest(
        free_port(),
        "openai_chat",
        &format!("http://127.0.0.1:{}/v1", upstream_addr.port()),
        CHAT_KEY_ENV,
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let tools = functions_exec_tools();

    let first_body = post_responses_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [{"role": "user", "content": "run exec over sse"}],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let first_response = sse_completed_response(&first_body);
    let call = response_output_item(&first_response, "function_call").clone();
    assert_eq!(call["namespace"], "functions");
    assert_eq!(call["name"], "exec");
    assert_eq!(call["call_id"], "call_runtime_exec");
    assert_eq!(call["arguments"], EXEC_ARGUMENTS);

    let first_capture = recv_capture(&mut captures_rx).await;
    let alias = chat_emitted_tool_name(&first_capture.body);
    assert_ne!(alias, "exec");
    assert!(alias.contains("functions"), "{alias}");
    assert_eq!(
        first_capture.body["messages"][0]["content"],
        "run exec over sse"
    );

    let second_body = post_responses_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [
                {"role": "user", "content": "run exec over sse"},
                call,
                {
                    "type": "function_call_output",
                    "call_id": "call_runtime_exec",
                    "output": EXEC_OUTPUT
                }
            ],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let second_response = sse_completed_response(&second_body);
    assert_eq!(response_text(&second_response), CHAT_FINAL_TEXT);

    let second_capture = recv_capture(&mut captures_rx).await;
    let assistant_call = chat_assistant_tool_call(&second_capture.body, "call_runtime_exec");
    assert_eq!(assistant_call["function"]["name"], alias);
    assert_eq!(assistant_call["function"]["arguments"], EXEC_ARGUMENTS);
    assert_eq!(
        chat_tool_result_text(&second_capture.body, "call_runtime_exec"),
        EXEC_OUTPUT
    );

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(CHAT_KEY_ENV);
}

#[tokio::test]
async fn req02_responses_sse_anthropic_custom_round_trip_preserves_patch_and_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(ANTHROPIC_KEY_ENV, "req02-anthropic-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/messages", post(anthropic_custom_upstream))
        .with_state(Arc::new(CaptureState {
            captures: captures_tx,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let manifest = single_provider_manifest(
        free_port(),
        "anthropic",
        &format!("http://127.0.0.1:{}", upstream_addr.port()),
        ANTHROPIC_KEY_ENV,
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let tools = functions_apply_patch_tools();

    let first_body = post_responses_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [{"role": "user", "content": "apply the patch over sse"}],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let first_response = sse_completed_response(&first_body);
    let call = response_output_item(&first_response, "custom_tool_call").clone();
    assert_eq!(call["namespace"], "functions");
    assert_eq!(call["name"], "apply_patch");
    assert_eq!(call["call_id"], "call_custom_patch");
    assert_eq!(call["input"], APPLY_PATCH);

    let first_capture = recv_capture(&mut captures_rx).await;
    let alias = first_capture.body["tools"][0]["name"]
        .as_str()
        .unwrap_or_else(|| {
            panic!(
                "Anthropic request must carry emitted tool: {}",
                first_capture.body
            )
        });
    assert_ne!(alias, "apply_patch");
    assert!(alias.contains("functions"), "{alias}");

    let second_body = post_responses_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [
                {"role": "user", "content": "apply the patch over sse"},
                call,
                {
                    "type": "custom_tool_call_output",
                    "call_id": "call_custom_patch",
                    "output": PATCH_OUTPUT
                }
            ],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let second_response = sse_completed_response(&second_body);
    assert_eq!(response_text(&second_response), ANTHROPIC_FINAL_TEXT);

    let second_capture = recv_capture(&mut captures_rx).await;
    let tool_use = anthropic_content_part(&second_capture.body, "call_custom_patch", "tool_use");
    assert_eq!(tool_use["name"], alias);
    assert_eq!(tool_use["input"], json!({"input": APPLY_PATCH}));
    assert_eq!(
        anthropic_tool_result_text(&second_capture.body, "call_custom_patch"),
        PATCH_OUTPUT
    );

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(ANTHROPIC_KEY_ENV);
}

#[tokio::test]
async fn req02_responses_sse_mcp_kind_isolation_preserves_identity_and_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(CHAT_KEY_ENV, "req02-chat-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(chat_tool_upstream))
        .with_state(Arc::new(ChatState {
            captures: captures_tx,
            mode: ChatMode::McpSchemaDriven,
            hold: None,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let manifest = single_provider_manifest(
        free_port(),
        "openai_chat",
        &format!("http://127.0.0.1:{}/v1", upstream_addr.port()),
        CHAT_KEY_ENV,
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    let function_tools = mcp_function_tools();
    let function_first_body = post_responses_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [{"role": "user", "content": "mcp function kind over sse"}],
            "tools": function_tools,
            "stream": true
        }),
    )
    .await;
    let function_first_response = sse_completed_response(&function_first_body);
    let function_call = response_output_item(&function_first_response, "function_call").clone();
    assert_eq!(function_call["namespace"], "mcp__demo__");
    assert_eq!(function_call["name"], "opaque_leaf");
    assert_eq!(function_call["call_id"], "call_mcp_function");
    assert_eq!(function_call["arguments"], MCP_FUNCTION_ARGUMENTS);

    let function_capture = recv_capture(&mut captures_rx).await;
    assert!(!chat_custom_wrapper(&function_capture.body));
    let function_alias = chat_emitted_tool_name(&function_capture.body);
    assert_ne!(function_alias, "opaque_leaf");
    assert!(function_alias.contains("opaque_leaf"), "{function_alias}");

    let function_second_body = post_responses_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [
                {"role": "user", "content": "mcp function kind over sse"},
                function_call,
                {
                    "type": "function_call_output",
                    "call_id": "call_mcp_function",
                    "output": MCP_FUNCTION_OUTPUT
                }
            ],
            "tools": function_tools,
            "stream": true
        }),
    )
    .await;
    let function_second_response = sse_completed_response(&function_second_body);
    assert_eq!(response_text(&function_second_response), CHAT_FINAL_TEXT);
    let function_followup_capture = recv_capture(&mut captures_rx).await;
    assert_eq!(
        chat_tool_result_text(&function_followup_capture.body, "call_mcp_function"),
        MCP_FUNCTION_OUTPUT
    );

    let custom_tools = mcp_custom_tools();
    let custom_first_body = post_responses_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [{"role": "user", "content": "mcp custom kind over sse"}],
            "tools": custom_tools,
            "stream": true
        }),
    )
    .await;
    let custom_first_response = sse_completed_response(&custom_first_body);
    let custom_call = response_output_item(&custom_first_response, "custom_tool_call").clone();
    assert_eq!(custom_call["namespace"], "mcp__demo__");
    assert_eq!(custom_call["name"], "opaque_leaf");
    assert_eq!(custom_call["call_id"], "call_mcp_custom");
    assert_eq!(custom_call["input"], MCP_CUSTOM_INPUT);

    let custom_capture = recv_capture(&mut captures_rx).await;
    assert!(chat_custom_wrapper(&custom_capture.body));
    let custom_alias = chat_emitted_tool_name(&custom_capture.body);
    assert_ne!(custom_alias, "opaque_leaf");
    assert!(custom_alias.contains("opaque_leaf"), "{custom_alias}");

    let custom_second_body = post_responses_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [
                {"role": "user", "content": "mcp custom kind over sse"},
                custom_call,
                {
                    "type": "custom_tool_call_output",
                    "call_id": "call_mcp_custom",
                    "output": MCP_CUSTOM_OUTPUT
                }
            ],
            "tools": custom_tools,
            "stream": true
        }),
    )
    .await;
    let custom_second_response = sse_completed_response(&custom_second_body);
    assert_eq!(response_text(&custom_second_response), CHAT_FINAL_TEXT);
    let custom_followup_capture = recv_capture(&mut captures_rx).await;
    assert_eq!(
        chat_tool_result_text(&custom_followup_capture.body, "call_mcp_custom"),
        MCP_CUSTOM_OUTPUT
    );

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(CHAT_KEY_ENV);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn req02_responses_client_disconnect_does_not_poison_followup_session() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(CHAT_KEY_ENV, "req02-chat-secret");

    let hold = Arc::new(Mutex::new(()));
    let hold_guard = hold.lock().await;
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(chat_tool_upstream))
        .with_state(Arc::new(ChatState {
            captures: captures_tx,
            mode: ChatMode::Exec,
            hold: Some(hold.clone()),
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let manifest = single_provider_manifest(
        free_port(),
        "openai_chat",
        &format!("http://127.0.0.1:{}/v1", upstream_addr.port()),
        CHAT_KEY_ENV,
    );
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let disconnected_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let disconnected = disconnected_client
        .post(&endpoint)
        .header("accept", "text/event-stream")
        .header("session-id", "req02-disconnected-session")
        .json(&json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [{"role": "user", "content": "disconnect during exec"}],
            "tools": functions_exec_tools(),
            "stream": true
        }))
        .send();
    tokio::pin!(disconnected);
    tokio::select! {
        result = &mut disconnected => {
            panic!("held request must not complete before client disconnect: {result:?}")
        }
        capture = recv_capture(&mut captures_rx) => {
            assert!(!chat_has_tool_result(&capture.body));
            assert_eq!(capture.body["stream"], true);
        }
    }
    drop(disconnected);
    drop(hold_guard);

    let survivor_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let tools = functions_exec_tools();
    let survivor_first_body = post_responses_sse(
        &survivor_client,
        &endpoint,
        json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [{"role": "user", "content": "survivor session runs exec"}],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let survivor_first_response = sse_completed_response(&survivor_first_body);
    let survivor_call = response_output_item(&survivor_first_response, "function_call").clone();
    assert_eq!(survivor_call["namespace"], "functions");
    assert_eq!(survivor_call["name"], "exec");
    assert_eq!(survivor_call["call_id"], "call_runtime_exec");
    assert_eq!(survivor_call["arguments"], EXEC_ARGUMENTS);

    let survivor_capture = recv_capture(&mut captures_rx).await;
    let survivor_alias = chat_emitted_tool_name(&survivor_capture.body);
    assert_eq!(
        survivor_capture.body["messages"][0]["content"],
        "survivor session runs exec"
    );

    let survivor_second_body = post_responses_sse(
        &survivor_client,
        &endpoint,
        json!({
            "model": "client-tool",
            "include": ["reasoning.encrypted_content"],
            "input": [
                {"role": "user", "content": "survivor session runs exec"},
                survivor_call,
                {
                    "type": "function_call_output",
                    "call_id": "call_runtime_exec",
                    "output": EXEC_OUTPUT
                }
            ],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let survivor_second_response = sse_completed_response(&survivor_second_body);
    assert_eq!(response_text(&survivor_second_response), CHAT_FINAL_TEXT);

    let survivor_followup_capture = recv_capture(&mut captures_rx).await;
    let survivor_assistant_call =
        chat_assistant_tool_call(&survivor_followup_capture.body, "call_runtime_exec");
    assert_eq!(survivor_assistant_call["function"]["name"], survivor_alias);
    assert_eq!(
        survivor_assistant_call["function"]["arguments"],
        EXEC_ARGUMENTS
    );
    assert_eq!(
        chat_tool_result_text(&survivor_followup_capture.body, "call_runtime_exec"),
        EXEC_OUTPUT
    );

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(CHAT_KEY_ENV);
}
