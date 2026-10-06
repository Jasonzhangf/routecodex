//! REQ02 R47 Direct SSE public HTTP acceptance.
//!
//! The tests drive the real public V3 Server and a real loopback HTTP
//! provider. Client requests use `stream = true`, and every assertion reads
//! the actual client SSE bytes or the actual provider request bytes. No
//! private runtime function is called as an acceptance oracle.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{collections::HashSet, net::SocketAddr, sync::Arc, time::Duration};
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

const RESPONSES_KEY_ENV: &str = "REQ02_R47_DIRECT_SSE_RESPONSES_KEY";
const CHAT_KEY_ENV: &str = "REQ02_R47_DIRECT_SSE_CHAT_KEY";
const FINAL_TEXT: &str = "REQ02_R47_DIRECT_SSE_FINAL";
const UNRELATED_TEXT: &str = "R47 unrelated text preserved";
const REASONING_TEXT: &str = "R47 reasoning summary preserved";
const INCOMPLETE_SENTINEL: &str = "R47_PARTIAL_SENTINEL";

const EXEC_REPEATS: usize = 2200;

fn exec_command() -> String {
    let mut command = String::with_capacity(EXEC_REPEATS * 40 + 64);
    for _ in 0..EXEC_REPEATS {
        command.push_str("echo \"literal $() and `backtick`\"\r\n");
    }
    command.push_str("printf '%s' 'REQ02_R47_EXEC_TAIL'");
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

const APPLY_PATCH: &str = "*** Begin Patch\n*** Add File: /tmp/req02-r47-direct-sse.txt\n+literal $() and `backtick`\n+second line\n*** End Patch\n";

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
// Public server manifest
// ---------------------------------------------------------------------------

fn direct_sse_manifest(
    server_port: u16,
    endpoint: &str,
    providers: &[(&str, &str, u32)],
    key_env: &str,
) -> V3Config05ManifestPublished {
    let provider_type = endpoint;
    let mut provider_blocks = String::new();
    let mut target_lines = Vec::new();
    for (name, base_url, priority) in providers {
        provider_blocks.push_str(&format!(
            r#"
[providers.{name}]
type = "{provider_type}"
base_url = "{base_url}"
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{key_env}" }}] }}
[providers.{name}.models.wire-model]
wire_name = "wire-model"
aliases = ["client-model"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
"#
        ));
        target_lines.push(format!(
            "{{ kind = \"provider_model\", provider = \"{name}\", model = \"wire-model\", key = \"key\", priority = {priority} }}"
        ));
    }
    let targets = target_lines.join(",\n  ");
    let source = format!(
        r#"
version = 3

{declaration}

[servers.direct_sse]
bind = "127.0.0.1"
port = {server_port}
routing_group = "direct_sse"
endpoints = ["{endpoint}"]

{execution}

{provider_blocks}

[route_groups.direct_sse.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["client-model"] }}
targets = [
  {targets}
]
[route_groups.direct_sse.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {targets}
]
"#,
        declaration = hub_v1_test_declaration(),
        execution = hub_v1_server_execution("direct_sse"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

// ---------------------------------------------------------------------------
// Real loopback provider
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProviderBehavior {
    Success,
    HttpFailure,
    IncompleteSse,
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

fn sse_response(body: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(body))
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

#[derive(Clone)]
struct ResponsesState {
    captures: mpsc::UnboundedSender<Value>,
    behavior: ProviderBehavior,
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
    match state.behavior {
        ProviderBehavior::HttpFailure => status_json(
            StatusCode::BAD_REQUEST,
            json!({
                "error": {
                    "message": "controlled responses SSE provider 400",
                    "type": "invalid_request_error",
                    "code": "req02_r47_controlled_responses_400"
                }
            }),
        ),
        ProviderBehavior::IncompleteSse => sse_response(responses_incomplete_sse(&body)),
        ProviderBehavior::Success => match validate_responses_wire(&body) {
            Ok(()) => sse_response(responses_success_sse(&body)),
            Err(message) => status_json(
                StatusCode::BAD_REQUEST,
                json!({
                    "error": {
                        "message": message,
                        "type": "invalid_request_error",
                        "code": "req02_r47_strict_responses_shape"
                    }
                }),
            ),
        },
    }
}

#[derive(Clone)]
struct ChatState {
    captures: mpsc::UnboundedSender<Value>,
    behavior: ProviderBehavior,
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
    match state.behavior {
        ProviderBehavior::HttpFailure => status_json(
            StatusCode::BAD_REQUEST,
            json!({
                "error": {
                    "message": "controlled chat SSE provider 400",
                    "type": "invalid_request_error",
                    "code": "req02_r47_controlled_chat_400"
                }
            }),
        ),
        ProviderBehavior::IncompleteSse => sse_response(chat_incomplete_sse(&body)),
        ProviderBehavior::Success => match validate_chat_wire(&body) {
            Ok(()) => sse_response(chat_success_sse(&body)),
            Err(message) => status_json(
                StatusCode::BAD_REQUEST,
                json!({
                    "error": {
                        "message": message,
                        "type": "invalid_request_error",
                        "code": "req02_r47_strict_chat_shape"
                    }
                }),
            ),
        },
    }
}

// ---------------------------------------------------------------------------
// Provider wire validation
// ---------------------------------------------------------------------------

fn find_flat_tool_name(tools: &[Value], suffix: &str) -> Option<String> {
    tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .find(|name| *name == suffix || name.contains(suffix))
        .map(str::to_owned)
}

fn wire_tool_name(tools: &[Value], suffix: &str) -> String {
    find_flat_tool_name(tools, suffix)
        .unwrap_or_else(|| panic!("provider wire must carry a flat tool for `{suffix}`: {tools:?}"))
}

fn expected_tool_arguments(name: &str) -> Result<String, String> {
    if name.contains("exec") {
        return Ok(exec_arguments());
    }
    if name.contains("apply_patch") {
        return Ok(patch_wire_arguments());
    }
    if name.contains("opaque_leaf") {
        return Ok(mcp_arguments());
    }
    Err(format!("unexpected emitted tool name `{name}`"))
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

fn validate_flat_tools(tools: &[Value], protocol: &str) -> Result<(), String> {
    if tools.len() != 3 {
        return Err(format!(
            "{protocol} strict provider expected 3 flat tools, got {tools:?}"
        ));
    }
    for tool in tools {
        if tool["type"] != "function" {
            return Err(format!(
                "{protocol} strict provider expected function tool, got {tool}"
            ));
        }
        let name = tool["name"]
            .as_str()
            .ok_or_else(|| format!("{protocol} strict provider tool missing name: {tool}"))?;
        if name.is_empty() || name.contains('.') {
            return Err(format!(
                "{protocol} strict provider tool must be one flat identifier: {name}"
            ));
        }
        if tool["parameters"]["type"] != "object" {
            return Err(format!(
                "{protocol} strict provider tool must carry an object schema: {tool}"
            ));
        }
    }
    let exec = find_flat_tool_name(tools, "exec")
        .ok_or_else(|| "strict provider missing exec tool".to_string())?;
    let patch = find_flat_tool_name(tools, "apply_patch")
        .ok_or_else(|| "strict provider missing apply_patch tool".to_string())?;
    let mcp = find_flat_tool_name(tools, "opaque_leaf")
        .ok_or_else(|| "strict provider missing opaque_leaf tool".to_string())?;
    if exec != "functions__exec"
        || patch != "functions__apply_patch"
        || mcp == "opaque_leaf"
        || !mcp.contains("opaque_leaf")
    {
        return Err(format!(
            "strict provider flattened names changed: exec={exec} patch={patch} mcp={mcp}"
        ));
    }
    Ok(())
}

fn validate_responses_wire(body: &Value) -> Result<(), String> {
    if body["stream"] != true {
        return Err("Responses strict provider requires stream=true".to_string());
    }
    let tools = body["tools"]
        .as_array()
        .ok_or_else(|| "Responses strict provider requires tools".to_string())?;
    validate_flat_tools(tools, "Responses")?;
    let Some(input) = body["input"].as_array() else {
        return Ok(());
    };
    let mut call_ids = HashSet::new();
    for item in input {
        if item["type"] != "function_call" {
            continue;
        }
        let call_id = item["call_id"]
            .as_str()
            .ok_or_else(|| format!("Responses tool call missing call_id: {item}"))?;
        let name = item["name"]
            .as_str()
            .ok_or_else(|| format!("Responses tool call missing name: {item}"))?;
        let expected = expected_tool_arguments(name)?;
        if item["arguments"] != expected {
            return Err(format!(
                "Responses follow-up tool bytes changed for {call_id}: {item}"
            ));
        }
        call_ids.insert(call_id.to_string());
    }
    for item in input {
        let Some(kind) = item["type"].as_str() else {
            continue;
        };
        if !kind.ends_with("_output") {
            continue;
        }
        let call_id = item["call_id"]
            .as_str()
            .ok_or_else(|| format!("Responses tool output missing call_id: {item}"))?;
        if !call_ids.contains(call_id) {
            return Err(format!(
                "Responses tool output is not paired with a call: {item}"
            ));
        }
    }
    Ok(())
}

fn validate_chat_wire(body: &Value) -> Result<(), String> {
    if body["stream"] != true {
        return Err("Chat strict provider requires stream=true".to_string());
    }
    let tools = body["tools"]
        .as_array()
        .ok_or_else(|| "Chat strict provider requires tools".to_string())?;
    let flat_tools = tools
        .iter()
        .map(|tool| {
            let name = tool["function"]["name"]
                .as_str()
                .ok_or_else(|| format!("Chat strict provider tool missing name: {tool}"))?;
            Ok(json!({
                "type": "function",
                "name": name,
                "parameters": tool["function"]["parameters"]
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    validate_flat_tools(&flat_tools, "Chat")?;
    let Some(messages) = body["messages"].as_array() else {
        return Ok(());
    };
    let mut call_ids = HashSet::new();
    for message in messages {
        if let Some(calls) = message["tool_calls"].as_array() {
            for call in calls {
                let call_id = call["id"]
                    .as_str()
                    .ok_or_else(|| format!("Chat tool call missing id: {call}"))?;
                let name = call["function"]["name"]
                    .as_str()
                    .ok_or_else(|| format!("Chat tool call missing function name: {call}"))?;
                let expected = expected_tool_arguments(name)?;
                if call["function"]["arguments"] != expected {
                    return Err(format!(
                        "Chat follow-up tool bytes changed for {call_id}: {call}"
                    ));
                }
                call_ids.insert(call_id.to_string());
            }
        }
        if message["role"] == "tool" {
            let call_id = message["tool_call_id"]
                .as_str()
                .ok_or_else(|| format!("Chat tool result missing tool_call_id: {message}"))?;
            if !call_ids.contains(call_id) {
                return Err(format!(
                    "Chat tool result is not paired with a call: {message}"
                ));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Responses SSE provider fixtures
// ---------------------------------------------------------------------------

fn push_sse_event(out: &mut String, event_name: &str, value: Value) {
    out.push_str("event: ");
    out.push_str(event_name);
    out.push('\n');
    out.push_str("data: ");
    out.push_str(&serde_json::to_string(&value).unwrap());
    out.push_str("\n\n");
}

fn push_sse_data(out: &mut String, value: Value) {
    out.push_str("data: ");
    out.push_str(&serde_json::to_string(&value).unwrap());
    out.push_str("\n\n");
}

fn responses_function_item(
    id: &str,
    call_id: &str,
    name: &str,
    arguments: &str,
    status: &str,
) -> Value {
    json!({
        "id": id,
        "type": "function_call",
        "call_id": call_id,
        "name": name,
        "status": status,
        "arguments": arguments
    })
}

fn responses_message_item(text: &str, status: &str) -> Value {
    json!({
        "id": "msg-r47",
        "type": "message",
        "role": "assistant",
        "status": status,
        "content": [{
            "type": "output_text",
            "text": text,
            "annotations": []
        }],
        "vendor_message_sibling": {"keep": "message"}
    })
}

fn responses_reasoning_item(text: &str, status: &str) -> Value {
    json!({
        "id": "reason-r47",
        "type": "reasoning",
        "status": status,
        "summary": [{
            "type": "summary_text",
            "text": text
        }],
        "vendor_reasoning_sibling": {"keep": "reasoning"}
    })
}

fn push_responses_tool(
    out: &mut String,
    output_index: usize,
    item_id: &str,
    call_id: &str,
    name: &str,
    arguments: &str,
) {
    push_sse_event(
        out,
        "response.output_item.added",
        json!({
            "type": "response.output_item.added",
            "output_index": output_index,
            "item": responses_function_item(item_id, call_id, name, "", "in_progress")
        }),
    );
    let midpoint = arguments.len() / 2;
    let (first, second) = arguments.split_at(midpoint);
    push_sse_event(
        out,
        "response.function_call_arguments.delta",
        json!({
            "type": "response.function_call_arguments.delta",
            "output_index": output_index,
            "item_id": item_id,
            "delta": first
        }),
    );
    push_sse_event(
        out,
        "response.function_call_arguments.delta",
        json!({
            "type": "response.function_call_arguments.delta",
            "output_index": output_index,
            "item_id": item_id,
            "delta": second
        }),
    );
    push_sse_event(
        out,
        "response.function_call_arguments.done",
        json!({
            "type": "response.function_call_arguments.done",
            "output_index": output_index,
            "item_id": item_id,
            "arguments": arguments
        }),
    );
    push_sse_event(
        out,
        "response.output_item.done",
        json!({
            "type": "response.output_item.done",
            "output_index": output_index,
            "item": responses_function_item(item_id, call_id, name, arguments, "completed")
        }),
    );
}

fn responses_success_sse(body: &Value) -> String {
    if responses_has_tool_output(body) {
        return responses_final_sse();
    }
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    let exec_name = wire_tool_name(&tools, "exec");
    let patch_name = wire_tool_name(&tools, "apply_patch");
    let mcp_name = wire_tool_name(&tools, "opaque_leaf");
    let exec_arguments = exec_arguments();
    let patch_arguments = patch_wire_arguments();
    let mcp_arguments = mcp_arguments();
    let mut out = String::new();
    push_sse_event(
        &mut out,
        "response.created",
        json!({
            "type": "response.created",
            "response": {"id": "resp_r47_tools", "status": "in_progress", "output": []}
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_item.added",
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": responses_message_item("", "in_progress")
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_text.delta",
        json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "content_index": 0,
            "item_id": "msg-r47",
            "delta": UNRELATED_TEXT,
            "vendor_delta_sibling": {"keep": "delta"}
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_text.done",
        json!({
            "type": "response.output_text.done",
            "output_index": 0,
            "content_index": 0,
            "item_id": "msg-r47",
            "text": UNRELATED_TEXT
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_item.done",
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": responses_message_item(UNRELATED_TEXT, "completed")
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_item.added",
        json!({
            "type": "response.output_item.added",
            "output_index": 1,
            "item": responses_reasoning_item("", "in_progress")
        }),
    );
    push_sse_event(
        &mut out,
        "response.reasoning_summary_text.delta",
        json!({
            "type": "response.reasoning_summary_text.delta",
            "output_index": 1,
            "item_id": "reason-r47",
            "summary_index": 0,
            "delta": REASONING_TEXT
        }),
    );
    push_sse_event(
        &mut out,
        "response.reasoning_summary_text.done",
        json!({
            "type": "response.reasoning_summary_text.done",
            "output_index": 1,
            "item_id": "reason-r47",
            "summary_index": 0,
            "text": REASONING_TEXT
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_item.done",
        json!({
            "type": "response.output_item.done",
            "output_index": 1,
            "item": responses_reasoning_item(REASONING_TEXT, "completed")
        }),
    );
    push_responses_tool(
        &mut out,
        2,
        "item-exec",
        "exec-call",
        &exec_name,
        &exec_arguments,
    );
    push_responses_tool(
        &mut out,
        3,
        "item-patch",
        "patch-call",
        &patch_name,
        &patch_arguments,
    );
    push_responses_tool(
        &mut out,
        4,
        "item-mcp",
        "mcp-call",
        &mcp_name,
        &mcp_arguments,
    );
    let output = vec![
        responses_message_item(UNRELATED_TEXT, "completed"),
        responses_reasoning_item(REASONING_TEXT, "completed"),
        responses_function_item(
            "item-exec",
            "exec-call",
            &exec_name,
            &exec_arguments,
            "completed",
        ),
        responses_function_item(
            "item-patch",
            "patch-call",
            &patch_name,
            &patch_arguments,
            "completed",
        ),
        responses_function_item(
            "item-mcp",
            "mcp-call",
            &mcp_name,
            &mcp_arguments,
            "completed",
        ),
    ];
    push_sse_event(
        &mut out,
        "response.completed",
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp_r47_tools",
                "status": "completed",
                "model": "wire-model",
                "output": output,
                "usage": {"input_tokens": 3, "output_tokens": 4, "total_tokens": 7},
                "vendor_terminal_sibling": {"keep": "terminal"}
            }
        }),
    );
    out
}

fn responses_final_sse() -> String {
    let mut out = String::new();
    push_sse_event(
        &mut out,
        "response.created",
        json!({
            "type": "response.created",
            "response": {"id": "resp_r47_final", "status": "in_progress", "output": []}
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_item.added",
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": responses_message_item("", "in_progress")
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_text.delta",
        json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "content_index": 0,
            "item_id": "msg-r47",
            "delta": FINAL_TEXT
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_text.done",
        json!({
            "type": "response.output_text.done",
            "output_index": 0,
            "content_index": 0,
            "item_id": "msg-r47",
            "text": FINAL_TEXT
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_item.done",
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": responses_message_item(FINAL_TEXT, "completed")
        }),
    );
    push_sse_event(
        &mut out,
        "response.completed",
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp_r47_final",
                "status": "completed",
                "model": "wire-model",
                "output": [responses_message_item(FINAL_TEXT, "completed")],
                "usage": {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8}
            }
        }),
    );
    out
}

fn responses_incomplete_sse(body: &Value) -> String {
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    let name = tools
        .first()
        .and_then(|tool| tool["name"].as_str())
        .unwrap_or("incomplete_tool")
        .to_string();
    let mut out = String::new();
    push_sse_event(
        &mut out,
        "response.created",
        json!({
            "type": "response.created",
            "response": {"id": "resp_r47_incomplete", "status": "in_progress", "output": []}
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_item.added",
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": responses_function_item(
                "item-incomplete",
                "incomplete-call",
                &name,
                "",
                "in_progress"
            )
        }),
    );
    push_sse_event(
        &mut out,
        "response.function_call_arguments.delta",
        json!({
            "type": "response.function_call_arguments.delta",
            "output_index": 0,
            "item_id": "item-incomplete",
            "delta": INCOMPLETE_SENTINEL
        }),
    );
    out
}

// ---------------------------------------------------------------------------
// Chat SSE provider fixtures
// ---------------------------------------------------------------------------

fn chat_chunk(delta: Value, finish_reason: Option<&str>) -> Value {
    json!({
        "id": "chatcmpl-r47",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "wire-model",
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason
        }]
    })
}

fn chat_has_tool_result(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages
            .iter()
            .any(|message| message["role"].as_str() == Some("tool"))
    })
}

fn chat_success_sse(body: &Value) -> String {
    let mut out = String::new();
    push_sse_data(
        &mut out,
        chat_chunk(json!({"role": "assistant", "content": null}), None),
    );
    if chat_has_tool_result(body) {
        push_sse_data(
            &mut out,
            chat_chunk(json!({"content": FINAL_TEXT}), Some("stop")),
        );
        out.push_str("data: [DONE]\n\n");
        return out;
    }
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    let calls = [
        (
            "exec-call",
            wire_tool_name(&tools, "exec"),
            exec_arguments(),
        ),
        (
            "patch-call",
            wire_tool_name(&tools, "apply_patch"),
            patch_wire_arguments(),
        ),
        (
            "mcp-call",
            wire_tool_name(&tools, "opaque_leaf"),
            mcp_arguments(),
        ),
    ];
    for (index, (call_id, name, arguments)) in calls.iter().enumerate() {
        let midpoint = arguments.len() / 2;
        let (first, second) = arguments.split_at(midpoint);
        push_sse_data(
            &mut out,
            chat_chunk(
                json!({
                    "tool_calls": [{
                        "index": index,
                        "id": call_id,
                        "type": "function",
                        "function": {"name": name, "arguments": first}
                    }]
                }),
                None,
            ),
        );
        push_sse_data(
            &mut out,
            chat_chunk(
                json!({
                    "tool_calls": [{
                        "index": index,
                        "id": call_id,
                        "function": {"arguments": second}
                    }]
                }),
                None,
            ),
        );
    }
    push_sse_data(&mut out, chat_chunk(json!({}), Some("tool_calls")));
    out.push_str("data: [DONE]\n\n");
    out
}

fn chat_incomplete_sse(body: &Value) -> String {
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    let name = tools
        .first()
        .and_then(|tool| tool["function"]["name"].as_str())
        .unwrap_or("incomplete_tool");
    let mut out = String::new();
    push_sse_data(
        &mut out,
        chat_chunk(
            json!({
                "tool_calls": [{
                    "index": 0,
                    "id": "incomplete-call",
                    "type": "function",
                    "function": {"name": name, "arguments": INCOMPLETE_SENTINEL}
                }]
            }),
            None,
        ),
    );
    out
}

// ---------------------------------------------------------------------------
// Client SSE readers
// ---------------------------------------------------------------------------

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

fn assert_no_error_events(events: &[Value], body: &str) {
    assert!(
        events.iter().all(|event| {
            !matches!(
                event["type"].as_str(),
                Some("error" | "response.failed" | "response.incomplete")
            )
        }),
        "client SSE must not carry error or incomplete events: {body}"
    );
}

fn responses_event<'a>(events: &'a [Value], event_type: &str) -> &'a Value {
    events
        .iter()
        .find(|event| event["type"] == event_type)
        .unwrap_or_else(|| panic!("client SSE must contain {event_type}: {events:?}"))
}

fn responses_completed<'a>(events: &'a [Value]) -> &'a Value {
    &responses_event(events, "response.completed")["response"]
}

fn responses_item_event<'a>(events: &'a [Value], event_type: &str, item_id: &str) -> &'a Value {
    events
        .iter()
        .find(|event| event["type"] == event_type && event["item"]["id"].as_str() == Some(item_id))
        .unwrap_or_else(|| {
            panic!("client SSE must contain {event_type} for item {item_id}: {events:?}")
        })
}

fn responses_terminal_item<'a>(terminal: &'a Value, item_id: &str) -> &'a Value {
    terminal["output"]
        .as_array()
        .unwrap_or_else(|| panic!("completed response must contain output: {terminal}"))
        .iter()
        .find(|item| item["id"].as_str() == Some(item_id))
        .unwrap_or_else(|| panic!("completed response must contain item {item_id}: {terminal}"))
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

fn assert_responses_tool(
    body: &str,
    item_id: &str,
    call_id: &str,
    expected_type: &str,
    namespace: &str,
    name: &str,
    payload_field: &str,
    expected_payload: &str,
) -> Value {
    let events = sse_data_events(body);
    assert_no_error_events(&events, body);
    let added = responses_item_event(&events, "response.output_item.added", item_id);
    let done = responses_item_event(&events, "response.output_item.done", item_id);
    let terminal = responses_completed(&events);
    let terminal_item = responses_terminal_item(terminal, item_id);
    for item in [&added["item"], &done["item"], terminal_item] {
        assert_eq!(item["type"], expected_type, "item identity changed: {item}");
        assert_eq!(
            item["namespace"], namespace,
            "item namespace changed: {item}"
        );
        assert_eq!(item["name"], name, "item name changed: {item}");
        assert_eq!(item["call_id"], call_id, "item call_id changed: {item}");
    }
    assert_eq!(done["item"][payload_field], expected_payload, "{done}");
    assert_eq!(
        terminal_item[payload_field], expected_payload,
        "terminal item changed: {terminal_item}"
    );

    let delta_event = if expected_type == "custom_tool_call" {
        "response.custom_tool_call_input.delta"
    } else {
        "response.function_call_arguments.delta"
    };
    let done_event = if expected_type == "custom_tool_call" {
        "response.custom_tool_call_input.done"
    } else {
        "response.function_call_arguments.done"
    };
    let delta = events
        .iter()
        .filter(|event| event["type"] == delta_event && event["item_id"].as_str() == Some(item_id))
        .filter_map(|event| event["delta"].as_str())
        .collect::<String>();
    assert_eq!(delta, expected_payload, "aggregated deltas changed: {body}");
    let done_event = events
        .iter()
        .find(|event| event["type"] == done_event && event["item_id"].as_str() == Some(item_id))
        .unwrap_or_else(|| panic!("client SSE must contain {done_event} for {item_id}: {body}"));
    assert_eq!(
        done_event[payload_field], expected_payload,
        "delta done payload changed: {done_event}"
    );
    terminal_item.clone()
}

fn assert_responses_unrelated(events: &[Value]) {
    let message = responses_item_event(events, "response.output_item.done", "msg-r47");
    assert_eq!(message["item"]["content"][0]["text"], UNRELATED_TEXT);
    assert_eq!(
        message["item"]["vendor_message_sibling"],
        json!({"keep": "message"})
    );
    let reasoning = responses_item_event(events, "response.output_item.done", "reason-r47");
    assert_eq!(reasoning["item"]["summary"][0]["text"], REASONING_TEXT);
    assert_eq!(
        reasoning["item"]["vendor_reasoning_sibling"],
        json!({"keep": "reasoning"})
    );
    let delta = events
        .iter()
        .find(|event| {
            event["type"] == "response.output_text.delta"
                && event["item_id"].as_str() == Some("msg-r47")
        })
        .expect("client SSE must preserve unrelated output text delta");
    assert_eq!(delta["delta"], UNRELATED_TEXT);
    assert_eq!(delta["vendor_delta_sibling"], json!({"keep": "delta"}));
    let terminal = responses_completed(events);
    assert_eq!(
        terminal["vendor_terminal_sibling"],
        json!({"keep": "terminal"})
    );
}

fn responses_input_item<'a>(body: &'a Value, call_id: &str) -> &'a Value {
    body["input"]
        .as_array()
        .unwrap_or_else(|| panic!("Responses provider request must contain input: {body}"))
        .iter()
        .find(|item| item["call_id"].as_str() == Some(call_id))
        .unwrap_or_else(|| panic!("Responses provider request must contain {call_id}: {body}"))
}

fn assert_responses_wire_acceptable(body: &Value) {
    assert_eq!(body["stream"], true, "provider request must stream: {body}");
    let tools = body["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("provider wire must carry tools: {body}"));
    validate_flat_tools(tools, "Responses").unwrap();
    assert_eq!(wire_tool_name(tools, "exec"), "functions__exec");
    assert_eq!(
        wire_tool_name(tools, "apply_patch"),
        "functions__apply_patch"
    );
    let mcp = wire_tool_name(tools, "opaque_leaf");
    assert_ne!(mcp, "opaque_leaf");
    assert!(mcp.contains("opaque_leaf"), "{mcp}");
}

fn assert_responses_followup_wire(first: &Value, followup: &Value) {
    assert_eq!(followup["tools"], first["tools"]);
    let exec = responses_input_item(followup, "exec-call");
    assert_eq!(exec["type"], "function_call");
    assert_eq!(exec["name"], "functions__exec");
    assert_eq!(exec["arguments"], exec_arguments());
    let patch = responses_input_item(followup, "patch-call");
    assert_eq!(patch["type"], "function_call");
    assert_eq!(patch["name"], "functions__apply_patch");
    assert_eq!(patch["arguments"], patch_wire_arguments());
    let mcp = responses_input_item(followup, "mcp-call");
    assert_eq!(
        mcp["name"],
        wire_tool_name(&first["tools"].as_array().unwrap(), "opaque_leaf")
    );
    assert_eq!(mcp["arguments"], mcp_arguments());
    for (call_id, expected_output) in [
        ("exec-call", "exec output"),
        ("patch-call", "patch output"),
        ("mcp-call", "mcp output"),
    ] {
        let output = followup["input"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| {
                item["call_id"].as_str() == Some(call_id)
                    && item["type"]
                        .as_str()
                        .is_some_and(|kind| kind.ends_with("_output"))
            })
            .unwrap_or_else(|| panic!("follow-up wire must contain {call_id} output: {followup}"));
        assert_eq!(output["output"], expected_output);
    }
}

fn materialize_chat_tool(body: &str, call_id: &str) -> Value {
    let mut result = json!({
        "id": call_id,
        "type": "function",
        "namespace": null,
        "name": null,
        "arguments": ""
    });
    for chunk in sse_data_events(body) {
        let Some(calls) = chunk["choices"][0]["delta"]["tool_calls"].as_array() else {
            continue;
        };
        for call in calls {
            if call["id"].as_str() != Some(call_id) {
                continue;
            }
            let (kind, tool) = if call.get("custom").is_some() {
                ("custom", &call["custom"])
            } else {
                ("function", &call["function"])
            };
            result["type"] = json!(kind);
            if tool.get("namespace").is_some() {
                result["namespace"] = tool["namespace"].clone();
            }
            if tool.get("name").is_some() {
                result["name"] = tool["name"].clone();
            }
            let argument_field = if kind == "custom" {
                "input"
            } else {
                "arguments"
            };
            if let Some(part) = tool[argument_field].as_str() {
                let current = result["arguments"].as_str().unwrap_or_default();
                result["arguments"] = json!(format!("{current}{part}"));
            }
        }
    }
    assert!(
        result["name"].is_string(),
        "client Chat SSE must carry a complete tool identity for {call_id}: {body}"
    );
    result
}

fn chat_tool_result_text<'a>(body: &'a Value, call_id: &str) -> String {
    let message = body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|message| {
            message["role"].as_str() == Some("tool")
                && message["tool_call_id"].as_str() == Some(call_id)
        })
        .unwrap_or_else(|| {
            panic!("Chat provider request must carry tool result {call_id}: {body}")
        });
    match &message["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<String>(),
        other => panic!("unsupported Chat tool result shape: {other:?}"),
    }
}

fn assert_chat_client_tool(
    body: &str,
    call_id: &str,
    expected_type: &str,
    namespace: &str,
    name: &str,
    expected_payload: &str,
) -> Value {
    let events = sse_data_events(body);
    assert!(
        events.iter().all(|event| event.get("error").is_none()),
        "Chat SSE must not carry error chunks: {body}"
    );
    assert!(
        body.contains("data: [DONE]"),
        "Chat SSE must close with [DONE]"
    );
    let call = materialize_chat_tool(body, call_id);
    assert_eq!(
        call["type"], expected_type,
        "client Chat type changed: {call}"
    );
    assert_eq!(
        call["namespace"], namespace,
        "client Chat namespace changed: {call}"
    );
    assert_eq!(call["name"], name, "client Chat name changed: {call}");
    assert_eq!(
        call["arguments"], expected_payload,
        "client Chat bytes changed: {call}"
    );
    if expected_type == "custom" {
        json!({
            "id": call_id,
            "type": "custom",
            "custom": {
                "namespace": namespace,
                "name": name,
                "input": expected_payload
            }
        })
    } else {
        json!({
            "id": call_id,
            "type": "function",
            "function": {
                "namespace": namespace,
                "name": name,
                "arguments": expected_payload
            }
        })
    }
}

fn assert_chat_wire_acceptable(body: &Value) {
    assert_eq!(
        body["stream"], true,
        "Chat provider request must stream: {body}"
    );
    let tools = body["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("Chat provider wire must carry tools: {body}"));
    let flat_tools = tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "name": tool["function"]["name"],
                "parameters": tool["function"]["parameters"]
            })
        })
        .collect::<Vec<_>>();
    validate_flat_tools(&flat_tools, "Chat").unwrap();
    assert_eq!(wire_tool_name(&flat_tools, "exec"), "functions__exec");
    assert_eq!(
        wire_tool_name(&flat_tools, "apply_patch"),
        "functions__apply_patch"
    );
    assert_ne!(wire_tool_name(&flat_tools, "opaque_leaf"), "opaque_leaf");
}

fn assert_chat_followup_wire(first: &Value, followup: &Value) {
    assert_eq!(followup["tools"], first["tools"]);
    let assistant = followup["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["tool_calls"].is_array())
        .unwrap_or_else(|| panic!("Chat follow-up must carry assistant tool calls: {followup}"));
    let mcp_wire_name = wire_tool_name(&first["tools"].as_array().unwrap(), "opaque_leaf");
    for (call_id, expected_name, expected_arguments) in [
        ("exec-call", "functions__exec", exec_arguments()),
        (
            "patch-call",
            "functions__apply_patch",
            patch_wire_arguments(),
        ),
        ("mcp-call", mcp_wire_name.as_str(), mcp_arguments()),
    ] {
        let call = assistant["tool_calls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|call| call["id"].as_str() == Some(call_id))
            .unwrap_or_else(|| panic!("Chat follow-up missing {call_id}: {followup}"));
        assert_eq!(call["function"]["name"], expected_name);
        assert_eq!(call["function"]["arguments"], expected_arguments);
    }
    for (call_id, expected_output) in [
        ("exec-call", "exec output"),
        ("patch-call", "patch output"),
        ("mcp-call", "mcp output"),
    ] {
        assert_eq!(
            chat_tool_result_text(followup, call_id),
            expected_output,
            "Chat follow-up tool result changed for {call_id}"
        );
    }
}

// ---------------------------------------------------------------------------
// Public HTTP helpers
// ---------------------------------------------------------------------------

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

async fn post_chat_sse(client: &reqwest::Client, endpoint: &str, body: Value) -> String {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Socket-free guard: both Direct SSE manifests compile before any listener is
/// started. This keeps a bind-restricted environment useful.
#[test]
fn req02_direct_sse_r47_manifests_compile() {
    let responses = direct_sse_manifest(
        47_401,
        "responses",
        &[("controlled", "http://127.0.0.1:9/v1", 1)],
        RESPONSES_KEY_ENV,
    );
    let responses_server = responses
        .servers
        .get("direct_sse")
        .expect("Responses manifest must publish the Direct SSE server");
    assert!(responses_server
        .endpoints
        .iter()
        .any(|endpoint| endpoint == "responses"));
    assert!(responses.providers.contains_key("controlled"));

    let chat = direct_sse_manifest(
        47_402,
        "openai_chat",
        &[("controlled", "http://127.0.0.1:9/v1", 1)],
        CHAT_KEY_ENV,
    );
    let chat_server = chat
        .servers
        .get("direct_sse")
        .expect("Chat manifest must publish the Direct SSE server");
    assert!(chat_server
        .endpoints
        .iter()
        .any(|endpoint| endpoint == "openai_chat"));
    assert!(chat.providers.contains_key("controlled"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn req02_direct_sse_r47_responses_inverse_and_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(RESPONSES_KEY_ENV, "req02-r47-direct-sse-responses-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: captures_tx,
            behavior: ProviderBehavior::Success,
            hold: None,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let handle = spawn_v3_server_aggregate(direct_sse_manifest(
        free_port(),
        "responses",
        &[(
            "controlled",
            &format!("http://127.0.0.1:{}/v1", upstream_addr.port()),
            1,
        )],
        RESPONSES_KEY_ENV,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let tools = direct_responses_tools();

    let first_body = post_responses_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "run every tool over responses sse"}],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let first_wire = recv_capture(&mut captures_rx).await;
    assert_responses_wire_acceptable(&first_wire);
    let first_events = sse_data_events(&first_body);
    assert_no_error_events(&first_events, &first_body);
    assert_responses_unrelated(&first_events);

    let exec_call = assert_responses_tool(
        &first_body,
        "item-exec",
        "exec-call",
        "function_call",
        "functions",
        "exec",
        "arguments",
        &exec_arguments(),
    );
    let patch_call = assert_responses_tool(
        &first_body,
        "item-patch",
        "patch-call",
        "custom_tool_call",
        "functions",
        "apply_patch",
        "input",
        APPLY_PATCH,
    );
    let mcp_call = assert_responses_tool(
        &first_body,
        "item-mcp",
        "mcp-call",
        "function_call",
        "mcp__demo__",
        "opaque_leaf",
        "arguments",
        &mcp_arguments(),
    );

    let followup_body = post_responses_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-model",
            "input": [
                {"role": "user", "content": "run every tool over responses sse"},
                exec_call,
                {"type": "function_call_output", "call_id": "exec-call", "output": "exec output"},
                patch_call,
                {"type": "custom_tool_call_output", "call_id": "patch-call", "output": "patch output"},
                mcp_call,
                {"type": "function_call_output", "call_id": "mcp-call", "output": "mcp output"}
            ],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let followup_events = sse_data_events(&followup_body);
    assert_no_error_events(&followup_events, &followup_body);
    assert_eq!(
        response_text(responses_completed(&followup_events)),
        FINAL_TEXT
    );
    let followup_wire = recv_capture(&mut captures_rx).await;
    assert_responses_followup_wire(&first_wire, &followup_wire);

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(RESPONSES_KEY_ENV);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn req02_direct_sse_r47_chat_inverse_and_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(CHAT_KEY_ENV, "req02-r47-direct-sse-chat-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(chat_upstream))
        .with_state(Arc::new(ChatState {
            captures: captures_tx,
            behavior: ProviderBehavior::Success,
            hold: None,
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let handle = spawn_v3_server_aggregate(direct_sse_manifest(
        free_port(),
        "openai_chat",
        &[(
            "controlled",
            &format!("http://127.0.0.1:{}/v1", upstream_addr.port()),
            1,
        )],
        CHAT_KEY_ENV,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let tools = direct_responses_tools();

    let first_body = post_chat_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-model",
            "messages": [{"role": "user", "content": "run every tool over chat sse"}],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let first_wire = recv_capture(&mut captures_rx).await;
    assert_chat_wire_acceptable(&first_wire);

    let exec_call = assert_chat_client_tool(
        &first_body,
        "exec-call",
        "function",
        "functions",
        "exec",
        &exec_arguments(),
    );
    let patch_call = assert_chat_client_tool(
        &first_body,
        "patch-call",
        "custom",
        "functions",
        "apply_patch",
        APPLY_PATCH,
    );
    let mcp_call = assert_chat_client_tool(
        &first_body,
        "mcp-call",
        "function",
        "mcp__demo__",
        "opaque_leaf",
        &mcp_arguments(),
    );

    let followup_body = post_chat_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-model",
            "messages": [
                {"role": "user", "content": "run every tool over chat sse"},
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [exec_call, patch_call, mcp_call]
                },
                {"role": "tool", "tool_call_id": "exec-call", "content": "exec output"},
                {"role": "tool", "tool_call_id": "patch-call", "content": "patch output"},
                {"role": "tool", "tool_call_id": "mcp-call", "content": "mcp output"}
            ],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let followup_events = sse_data_events(&followup_body);
    assert!(
        followup_events
            .iter()
            .any(|event| { event["choices"][0]["delta"]["content"].as_str() == Some(FINAL_TEXT) }),
        "Chat follow-up must deliver the final text: {followup_body}"
    );
    let followup_wire = recv_capture(&mut captures_rx).await;
    assert_chat_followup_wire(&first_wire, &followup_wire);

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(CHAT_KEY_ENV);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn req02_direct_sse_r47_failed_attempt_then_success_is_atomic() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(RESPONSES_KEY_ENV, "req02-r47-direct-sse-responses-secret");

    let (failing_tx, mut failing_rx) = mpsc::unbounded_channel();
    let failing_app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: failing_tx,
            behavior: ProviderBehavior::IncompleteSse,
            hold: None,
        }));
    let (failing_addr, failing_upstream) = spawn_upstream(failing_app).await;

    let (success_tx, mut success_rx) = mpsc::unbounded_channel();
    let success_app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: success_tx,
            behavior: ProviderBehavior::Success,
            hold: None,
        }));
    let (success_addr, success_upstream) = spawn_upstream(success_app).await;

    let handle = spawn_v3_server_aggregate(direct_sse_manifest(
        free_port(),
        "responses",
        &[
            (
                "failing",
                &format!("http://127.0.0.1:{}/v1", failing_addr.port()),
                2,
            ),
            (
                "success",
                &format!("http://127.0.0.1:{}/v1", success_addr.port()),
                1,
            ),
        ],
        RESPONSES_KEY_ENV,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let body = post_responses_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "recover before client commit"}],
            "tools": direct_responses_tools(),
            "stream": true
        }),
    )
    .await;
    let events = sse_data_events(&body);
    assert_no_error_events(&events, &body);
    assert!(
        !body.contains(INCOMPLETE_SENTINEL),
        "failed attempt partial bytes must not reach the client: {body}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "response.completed")
            .count(),
        1,
        "client must observe exactly one successful terminal: {body}"
    );
    assert_responses_unrelated(&events);
    assert_responses_tool(
        &body,
        "item-exec",
        "exec-call",
        "function_call",
        "functions",
        "exec",
        "arguments",
        &exec_arguments(),
    );
    assert_responses_tool(
        &body,
        "item-patch",
        "patch-call",
        "custom_tool_call",
        "functions",
        "apply_patch",
        "input",
        APPLY_PATCH,
    );
    assert_responses_tool(
        &body,
        "item-mcp",
        "mcp-call",
        "function_call",
        "mcp__demo__",
        "opaque_leaf",
        "arguments",
        &mcp_arguments(),
    );
    let failing = recv_capture(&mut failing_rx).await;
    assert_responses_wire_acceptable(&failing);
    let success = recv_capture(&mut success_rx).await;
    assert_responses_wire_acceptable(&success);

    handle.shutdown().await;
    failing_upstream.shutdown().await;
    success_upstream.shutdown().await;
    std::env::remove_var(RESPONSES_KEY_ENV);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn req02_direct_sse_r47_exhaustion_no_client_error() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(RESPONSES_KEY_ENV, "req02-r47-direct-sse-responses-secret");

    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    let first_app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: first_tx,
            behavior: ProviderBehavior::HttpFailure,
            hold: None,
        }));
    let (first_addr, first_upstream) = spawn_upstream(first_app).await;

    let (second_tx, mut second_rx) = mpsc::unbounded_channel();
    let second_app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: second_tx,
            behavior: ProviderBehavior::IncompleteSse,
            hold: None,
        }));
    let (second_addr, second_upstream) = spawn_upstream(second_app).await;

    let handle = spawn_v3_server_aggregate(direct_sse_manifest(
        free_port(),
        "responses",
        &[
            (
                "first",
                &format!("http://127.0.0.1:{}/v1", first_addr.port()),
                2,
            ),
            (
                "second",
                &format!("http://127.0.0.1:{}/v1", second_addr.port()),
                1,
            ),
        ],
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
        .header("accept", "text/event-stream")
        .json(&json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "exhaust every provider"}],
            "tools": direct_responses_tools(),
            "stream": true
        }))
        .send()
        .await;
    match result {
        Ok(response) => {
            assert!(
                !response.status().is_client_error() && !response.status().is_server_error(),
                "exhaustion must not produce a client error status: {}",
                response.status()
            );
            let text = response.text().await.unwrap_or_default();
            assert!(!text.contains("response.completed"), "{text}");
            assert!(!text.contains("response.failed"), "{text}");
            assert!(!text.contains(INCOMPLETE_SENTINEL), "{text}");
            assert!(!text.contains("\"error\""), "{text}");
        }
        Err(error) => assert!(
            error.is_request() || error.is_body() || error.is_decode() || error.is_timeout(),
            "expected an aborted client transport, got: {error}"
        ),
    }

    let first = recv_capture(&mut first_rx).await;
    assert_responses_wire_acceptable(&first);
    let second = recv_capture(&mut second_rx).await;
    assert_responses_wire_acceptable(&second);

    handle.shutdown().await;
    first_upstream.shutdown().await;
    second_upstream.shutdown().await;
    std::env::remove_var(RESPONSES_KEY_ENV);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn req02_direct_sse_r47_disconnect_does_not_poison_session() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(RESPONSES_KEY_ENV, "req02-r47-direct-sse-responses-secret");

    let hold = Arc::new(Mutex::new(()));
    let hold_guard = hold.lock().await;
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/responses", post(responses_upstream))
        .with_state(Arc::new(ResponsesState {
            captures: captures_tx,
            behavior: ProviderBehavior::Success,
            hold: Some(hold.clone()),
        }));
    let (upstream_addr, upstream) = spawn_upstream(app).await;

    let handle = spawn_v3_server_aggregate(direct_sse_manifest(
        free_port(),
        "responses",
        &[(
            "controlled",
            &format!("http://127.0.0.1:{}/v1", upstream_addr.port()),
            1,
        )],
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
        .header("accept", "text/event-stream")
        .header("session-id", "req02-r47-disconnected-session")
        .json(&json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "disconnect during sse"}],
            "tools": direct_responses_tools(),
            "stream": true
        }))
        .send();
    tokio::pin!(disconnected);
    tokio::select! {
        result = &mut disconnected => {
            panic!("held SSE request must not complete before client disconnect: {result:?}")
        }
        capture = recv_capture(&mut captures_rx) => {
            assert_responses_wire_acceptable(&capture);
        }
    }
    drop(disconnected);
    drop(hold_guard);

    let survivor_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let tools = direct_responses_tools();
    let survivor_body = post_responses_sse(
        &survivor_client,
        &endpoint,
        json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "survivor session over sse"}],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let survivor_events = sse_data_events(&survivor_body);
    assert_no_error_events(&survivor_events, &survivor_body);
    assert_responses_unrelated(&survivor_events);
    let survivor_exec = assert_responses_tool(
        &survivor_body,
        "item-exec",
        "exec-call",
        "function_call",
        "functions",
        "exec",
        "arguments",
        &exec_arguments(),
    );
    let survivor_wire = recv_capture(&mut captures_rx).await;
    assert_responses_wire_acceptable(&survivor_wire);

    let survivor_followup = post_responses_sse(
        &survivor_client,
        &endpoint,
        json!({
            "model": "client-model",
            "input": [
                {"role": "user", "content": "survivor session over sse"},
                survivor_exec,
                {"type": "function_call_output", "call_id": "exec-call", "output": "exec output"}
            ],
            "tools": tools,
            "stream": true
        }),
    )
    .await;
    let survivor_followup_events = sse_data_events(&survivor_followup);
    assert_no_error_events(&survivor_followup_events, &survivor_followup);
    assert_eq!(
        response_text(responses_completed(&survivor_followup_events)),
        FINAL_TEXT
    );
    let survivor_followup_wire = recv_capture(&mut captures_rx).await;
    assert_eq!(
        responses_input_item(&survivor_followup_wire, "exec-call")["arguments"],
        exec_arguments()
    );

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(RESPONSES_KEY_ENV);
}
