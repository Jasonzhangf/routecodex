//! REQ02 R54 public SSE regression for the architecture-review P1 findings on
//! the Direct successful-SSE inverse.
//!
//! Both tests drive the real public V3 Server (`spawn_v3_server_aggregate`) and
//! a real loopback HTTP provider. Every assertion reads actual client SSE bytes
//! or the actual provider request bytes. No private runtime function is called
//! as an acceptance oracle.
//!
//! Finding 1 — Chat tool identity is per choice, not per response:
//! a Chat provider answers `n = 2` with two choices that each number their own
//! `tool_calls[].index` from 0. Each choice's name-less continuation fragment
//! must be restored from its own choice's declaration.
//!
//! Finding 2 — the client-visible free-form custom input must be the root
//! `input` member of the provider's function envelope: a nested member with the
//! same name must never be published, and the delta stream must agree with the
//! terminal input.

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

const RESPONSES_KEY_ENV: &str = "REQ02_R54_DIRECT_SSE_RESPONSES_KEY";
const CHAT_KEY_ENV: &str = "REQ02_R54_DIRECT_SSE_CHAT_KEY";

const APPLY_PATCH: &str = "*** Begin Patch\n*** Add File: /tmp/req02-r54-direct-sse.txt\n+literal $() and `backtick`\n+second line\n*** End Patch\n";
const NESTED_DECOY_INPUT: &str = "REQ02_R54_NESTED_DECOY_INPUT";

fn exec_arguments() -> String {
    serde_json::to_string(&json!({
        "cmd": "printf '%s' 'REQ02_R54_EXEC_TAIL'",
        "cwd": "/workspace/routecodex",
        "yield_time_ms": 1000
    }))
    .unwrap()
}

fn patch_wire_arguments() -> String {
    serde_json::to_string(&json!({"input": APPLY_PATCH})).unwrap()
}

/// The provider answers the runtime's own free-form envelope, but declares an
/// unrelated nested member that also carries an `input` key *before* the root
/// member. Only the root member is the client's free-form tool input.
fn patch_decoy_wire_arguments() -> String {
    serde_json::to_string(&json!({
        "extra": {"input": NESTED_DECOY_INPUT},
        "input": APPLY_PATCH
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

#[derive(Clone)]
struct SseProviderState {
    captures: mpsc::UnboundedSender<Value>,
    responder: fn(&Value) -> String,
}

async fn controlled_sse_upstream(
    State(state): State<Arc<SseProviderState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.captures.send(body.clone()).unwrap();
    sse_response((state.responder)(&body))
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

async fn recv_capture(captures: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), captures.recv())
        .await
        .expect("real HTTP upstream must receive the provider request")
        .expect("provider capture channel must remain open")
}

// ---------------------------------------------------------------------------
// Provider wire names
// ---------------------------------------------------------------------------

/// Chat provider tools are `{"type":"function","function":{"name":..}}`;
/// Responses provider tools are flat. Read whichever shape the wire carries.
fn provider_tool_name(tool: &Value) -> Option<&str> {
    tool["function"]["name"]
        .as_str()
        .or_else(|| tool["name"].as_str())
}

fn provider_tool_name_containing(tools: &[Value], suffix: &str) -> String {
    tools
        .iter()
        .filter_map(provider_tool_name)
        .find(|name| *name == suffix || name.contains(suffix))
        .unwrap_or_else(|| panic!("provider wire must carry a flat tool for `{suffix}`: {tools:?}"))
        .to_string()
}

// ---------------------------------------------------------------------------
// Provider SSE fixtures
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

fn chat_chunk(choices: Value) -> Value {
    json!({
        "id": "chatcmpl-r54",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "wire-model",
        "choices": choices
    })
}

fn chat_choice(index: u64, delta: Value, finish_reason: Option<&str>) -> Value {
    json!({"index": index, "delta": delta, "finish_reason": finish_reason})
}

/// Two choices. Each choice numbers its own tool-call index from 0 and declares
/// a different tool; the second fragment of each call omits the name, so only a
/// choice-scoped identity can restore it.
fn chat_multi_choice_sse(body: &Value) -> String {
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    let patch_name = provider_tool_name_containing(&tools, "apply_patch");
    let exec_name = provider_tool_name_containing(&tools, "exec");
    let patch_arguments = patch_wire_arguments();
    let exec_arguments = exec_arguments();
    let (patch_first, patch_second) = patch_arguments.split_at(patch_arguments.len() / 2);
    let (exec_first, exec_second) = exec_arguments.split_at(exec_arguments.len() / 2);
    let mut out = String::new();
    push_sse_data(
        &mut out,
        chat_chunk(json!([
            chat_choice(0, json!({"role": "assistant", "content": null}), None),
            chat_choice(1, json!({"role": "assistant", "content": null}), None)
        ])),
    );
    push_sse_data(
        &mut out,
        chat_chunk(json!([
            chat_choice(
                0,
                json!({"tool_calls": [{
                    "index": 0,
                    "id": "choice-0-call",
                    "type": "function",
                    "function": {"name": patch_name, "arguments": patch_first}
                }]}),
                None
            ),
            chat_choice(
                1,
                json!({"tool_calls": [{
                    "index": 0,
                    "id": "choice-1-call",
                    "type": "function",
                    "function": {"name": exec_name, "arguments": exec_first}
                }]}),
                None
            )
        ])),
    );
    push_sse_data(
        &mut out,
        chat_chunk(json!([
            chat_choice(
                0,
                json!({"tool_calls": [{
                    "index": 0,
                    "id": "choice-0-call",
                    "function": {"arguments": patch_second}
                }]}),
                None
            ),
            chat_choice(
                1,
                json!({"tool_calls": [{
                    "index": 0,
                    "id": "choice-1-call",
                    "function": {"arguments": exec_second}
                }]}),
                None
            )
        ])),
    );
    push_sse_data(
        &mut out,
        chat_chunk(json!([
            chat_choice(0, json!({}), Some("tool_calls")),
            chat_choice(1, json!({}), Some("tool_calls"))
        ])),
    );
    out.push_str("data: [DONE]\n\n");
    out
}

/// The Responses provider streams the runtime's free-form envelope for the
/// declared custom tool, with a nested decoy `input` member ahead of the root
/// member. The envelope is split across two delta fragments.
fn responses_custom_decoy_sse(body: &Value) -> String {
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    let patch_name = provider_tool_name_containing(&tools, "apply_patch");
    let envelope = patch_decoy_wire_arguments();
    let midpoint = envelope.len() / 2;
    let (first, second) = envelope.split_at(midpoint);
    let item = |arguments: &str, status: &str| {
        json!({
            "id": "item-r54-patch",
            "type": "function_call",
            "call_id": "r54-patch-call",
            "name": patch_name,
            "status": status,
            "arguments": arguments
        })
    };
    let mut out = String::new();
    push_sse_event(
        &mut out,
        "response.created",
        json!({
            "type": "response.created",
            "response": {"id": "resp_r54", "status": "in_progress", "output": []}
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_item.added",
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": item("", "in_progress")
        }),
    );
    for fragment in [first, second] {
        push_sse_event(
            &mut out,
            "response.function_call_arguments.delta",
            json!({
                "type": "response.function_call_arguments.delta",
                "output_index": 0,
                "item_id": "item-r54-patch",
                "delta": fragment
            }),
        );
    }
    push_sse_event(
        &mut out,
        "response.function_call_arguments.done",
        json!({
            "type": "response.function_call_arguments.done",
            "output_index": 0,
            "item_id": "item-r54-patch",
            "arguments": envelope
        }),
    );
    push_sse_event(
        &mut out,
        "response.output_item.done",
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": item(&envelope, "completed")
        }),
    );
    push_sse_event(
        &mut out,
        "response.completed",
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp_r54",
                "status": "completed",
                "model": "wire-model",
                "output": [item(&envelope, "completed")]
            }
        }),
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
    assert!(
        events.iter().all(|event| event.get("error").is_none()),
        "client SSE must not carry error payloads: {body}"
    );
}

/// Rebuild one client Chat tool call from the SSE chunks of exactly one choice.
fn materialize_chat_tool_in_choice(body: &str, choice_index: u64, call_id: &str) -> Value {
    let mut result = json!({
        "id": call_id,
        "type": "function",
        "namespace": null,
        "name": null,
        "arguments": ""
    });
    for chunk in sse_data_events(body) {
        let Some(choice) = chunk["choices"]
            .as_array()
            .and_then(|choices| {
                choices
                    .iter()
                    .find(|choice| choice["index"].as_u64() == Some(choice_index))
            })
            .cloned()
        else {
            continue;
        };
        let Some(calls) = choice["delta"]["tool_calls"].as_array() else {
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
        "client Chat SSE must carry a complete tool identity for {call_id} in choice {choice_index}: {body}"
    );
    result
}

fn responses_item_event<'a>(events: &'a [Value], event_type: &str, item_id: &str) -> &'a Value {
    events
        .iter()
        .find(|event| event["type"] == event_type && event["item"]["id"].as_str() == Some(item_id))
        .unwrap_or_else(|| {
            panic!("client SSE must contain {event_type} for item {item_id}: {events:?}")
        })
}

// ---------------------------------------------------------------------------
// Public HTTP helpers
// ---------------------------------------------------------------------------

async fn post_sse(client: &reqwest::Client, endpoint: &str, body: Value) -> String {
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

/// Finding 1: a Chat provider answers `n = 2`; both choices number their own
/// tool-call index from 0 with different tools. Each choice's name-less
/// continuation fragment must keep its own choice's identity, namespace and
/// complete payload.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn req02_direct_sse_r54_chat_multi_choice_tool_identity() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(CHAT_KEY_ENV, "req02-r54-direct-sse-chat-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(controlled_sse_upstream))
        .with_state(Arc::new(SseProviderState {
            captures: captures_tx,
            responder: chat_multi_choice_sse,
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

    let body = post_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-model",
            "messages": [{"role": "user", "content": "answer with two choices"}],
            "tools": direct_responses_tools(),
            "stream": true,
            "n": 2
        }),
    )
    .await;
    let wire = recv_capture(&mut captures_rx).await;
    assert_eq!(
        wire["n"], 2,
        "the client's `n` must survive to the Chat provider wire: {wire}"
    );

    let events = sse_data_events(&body);
    assert_no_error_events(&events, &body);
    assert!(
        body.contains("data: [DONE]"),
        "Chat SSE must close with [DONE]: {body}"
    );
    assert_eq!(
        events
            .iter()
            .filter_map(|event| event["choices"][0]["delta"]["role"].as_str())
            .count(),
        1,
        "client SSE must preserve the streamed Chat shape: {body}"
    );

    let custom = materialize_chat_tool_in_choice(&body, 0, "choice-0-call");
    assert_eq!(
        custom["type"], "custom",
        "choice 0 declared the custom tool: {custom}"
    );
    assert_eq!(
        custom["namespace"], "functions",
        "choice 0 namespace changed: {custom}"
    );
    assert_eq!(
        custom["name"], "apply_patch",
        "choice 0 tool name changed: {custom}"
    );
    assert_eq!(
        custom["arguments"], APPLY_PATCH,
        "choice 0 free-form input changed: {custom}"
    );

    let function = materialize_chat_tool_in_choice(&body, 1, "choice-1-call");
    assert_eq!(
        function["type"], "function",
        "choice 1 declared the function tool: {function}"
    );
    assert_eq!(
        function["namespace"], "functions",
        "choice 1 namespace changed: {function}"
    );
    assert_eq!(
        function["name"], "exec",
        "choice 1 tool name changed: {function}"
    );
    assert_eq!(
        function["arguments"],
        exec_arguments(),
        "choice 1 arguments changed: {function}"
    );

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(CHAT_KEY_ENV);
}

/// Finding 2: the provider envelope carries a nested decoy `input` before the
/// root `input`. The client delta stream and the terminal custom input must both
/// publish the root member.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn req02_direct_sse_r54_responses_custom_input_root_member() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(RESPONSES_KEY_ENV, "req02-r54-direct-sse-responses-secret");

    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_sse_upstream))
        .with_state(Arc::new(SseProviderState {
            captures: captures_tx,
            responder: responses_custom_decoy_sse,
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

    let body = post_sse(
        &client,
        &endpoint,
        json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "apply the patch"}],
            "tools": direct_responses_tools(),
            "stream": true
        }),
    )
    .await;
    let wire = recv_capture(&mut captures_rx).await;
    assert_eq!(
        wire["tools"]
            .as_array()
            .map(|tools| provider_tool_name_containing(tools, "apply_patch")),
        Some("functions__apply_patch".to_string()),
        "the declared custom tool must reach the provider as its emitted function envelope: {wire}"
    );

    let events = sse_data_events(&body);
    assert_no_error_events(&events, &body);

    let deltas: String = events
        .iter()
        .filter(|event| {
            event["type"] == "response.custom_tool_call_input.delta"
                && event["item_id"] == "item-r54-patch"
        })
        .filter_map(|event| event["delta"].as_str())
        .collect();
    assert_eq!(
        deltas, APPLY_PATCH,
        "custom-input deltas must publish the root `input` member: {body}"
    );

    let done = events
        .iter()
        .find(|event| {
            event["type"] == "response.custom_tool_call_input.done"
                && event["item_id"] == "item-r54-patch"
        })
        .unwrap_or_else(|| panic!("client SSE must contain the custom input done event: {body}"));
    assert_eq!(
        done["input"], APPLY_PATCH,
        "custom-input done must agree with the delta stream: {done}"
    );

    let item = responses_item_event(&events, "response.output_item.done", "item-r54-patch");
    assert_eq!(
        item["item"]["type"], "custom_tool_call",
        "the declared custom tool must keep its client kind: {item}"
    );
    assert_eq!(
        item["item"]["namespace"], "functions",
        "the declared namespace changed: {item}"
    );
    assert_eq!(
        item["item"]["name"], "apply_patch",
        "the declared tool name changed: {item}"
    );
    assert_eq!(
        item["item"]["input"], APPLY_PATCH,
        "the terminal custom input must be the root member: {item}"
    );

    handle.shutdown().await;
    upstream.shutdown().await;
    std::env::remove_var(RESPONSES_KEY_ENV);
}
