//! Public-entry black box for native first-discovery on a Responses client with
//! an Anthropic target.
//!
//! The client declares the standard native `tool_search` discovery tool
//! (`execution = "client"`, `parameters = {query, limit}`) next to an ordinary
//! local function. One locally spawned controlled upstream validates the exact
//! declaration it received, answers with an Anthropic `tool_use`, and refuses to
//! answer when the declaration or the paired result is missing. The test then
//! drives the real client-side discovery and execution chain and checks the
//! native kind, the complete arguments and call id, the discovered declaration,
//! the actual safe handler receipt, and the matched follow-up.
//!
//! No live provider is contacted and no fallback channel is used.

use axum::{
    body::Body,
    extract::State,
    http::{StatusCode, Uri},
    response::Response,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{ffi::OsString, time::Duration};
use tokio::sync::{mpsc, oneshot};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
// The shared process-local home/lifetime owner. The lock outlives the home
// guard, so HOME restoration finishes before another public test can start a
// listener.
#[path = "support/fa22072_test_home.rs"]
mod test_home;
static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const CLIENT_MODEL: &str = "anthropic-native-discovery-client";
const WIRE_MODEL: &str = "anthropic-native-discovery-wire";

/// The standard native discovery declaration name. It is protocol data only:
/// the spelling alone never authorizes an undeclared call.
const NATIVE_SEARCH_NAME: &str = "tool_search";
const LOCAL_FUNCTION_NAME: &str = "local_note";

const SEARCH_CALL_ID: &str = "toolu_search_first_discovery";
const SEARCH_QUERY: &str = "namespace_probe echo_nonce";
const SEARCH_LIMIT: i64 = 4;

const DISCOVERED_NAMESPACE: &str = "namespace_probe";
const DISCOVERED_LEAF: &str = "echo_nonce";
const ECHO_CALL_ID: &str = "toolu_echo_nonce";
const NONCE: &str = "NS_ROUTE_CODEX_20261014_SAFE";

const TURN1_MARKER: &str = "native discovery turn one";
const TURN2_MARKER: &str = "native discovery turn two";
const TURN3_MARKER: &str = "native discovery turn three";
const CONTROL_MARKER: &str = "ordinary tool_search control";
const UNDECLARED_MARKER: &str = "undeclared call control";
const SERVER_MARKER: &str = "server execution control";
const OMITTED_MARKER: &str = "omitted execution control";

/// Capture and restore only this fixture's own provider auth value. The shared
/// `ServerTestLock`/`TestHomeGuard` own HOME; this guard touches nothing else.
struct NativeDiscoveryKeyGuard {
    previous: Option<OsString>,
}

impl NativeDiscoveryKeyGuard {
    fn install() -> Self {
        let previous = std::env::var_os("V3_NATIVE_DISCOVERY_KEY");
        std::env::set_var("V3_NATIVE_DISCOVERY_KEY", "fixture-key");
        Self { previous }
    }
}

impl Drop for NativeDiscoveryKeyGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("V3_NATIVE_DISCOVERY_KEY", value),
            None => std::env::remove_var("V3_NATIVE_DISCOVERY_KEY"),
        }
    }
}

fn manifest(
    server_port: u16,
    upstream_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let hub_v1_declaration =
        hub_v1_fixture::hub_v1_test_declaration().replace(direct_binding, relay_binding);
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}

[servers.native_discovery]
bind = "127.0.0.1"
port = {server_port}
routing_group = "native_discovery"
endpoints = ["responses"]
{server_execution}

[providers.native_discovery]
type = "anthropic"
base_url = "{upstream_base_url}"
default_model = "{wire_model}"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "V3_NATIVE_DISCOVERY_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}

[providers.native_discovery.models.{wire_model}]
wire_name = "{wire_model}"
aliases = ["{client_model}"]
supports_streaming = true
capabilities = ["text", "tools"]

[route_groups.native_discovery.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["{client_model}"] }}
targets = [{{ kind = "provider_model", provider = "native_discovery", model = "{wire_model}", key = "controlled", priority = 1 }}]

[route_groups.native_discovery.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "native_discovery", model = "{wire_model}", key = "controlled", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_declaration,
        server_execution = hub_v1_fixture::hub_v1_server_execution("native_discovery"),
        upstream_base_url = upstream_base_url,
        wire_model = WIRE_MODEL,
        client_model = CLIENT_MODEL,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap()
}

async fn send(
    client: &reqwest::Client,
    endpoint: &str,
    payload: &Value,
) -> Result<(StatusCode, String), String> {
    let response = client
        .post(endpoint)
        .json(payload)
        .send()
        .await
        .map_err(|error| format!("public Responses entry did not answer: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("public Responses entry body was unreadable: {error}"))?;
    Ok((status, text))
}

fn parsed(status: StatusCode, text: &str) -> Result<Value, String> {
    if status != StatusCode::OK {
        return Err(format!("public Responses entry returned {status}: {text}"));
    }
    serde_json::from_str(text).map_err(|error| format!("client body was not JSON: {error}: {text}"))
}

fn output_items(body: &Value) -> Result<Vec<Value>, String> {
    body["output"].as_array().cloned().ok_or_else(|| {
        format!("a Responses client must receive Responses output items, got: {body}")
    })
}

fn sse_events(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|data| *data != "[DONE]")
        .map(|data| {
            serde_json::from_str::<Value>(data)
                .map_err(|error| format!("client SSE frame was not JSON: {error}: {data}"))
        })
        .collect::<Result<Vec<Value>, String>>()
        .unwrap()
}

/// Extract the final Responses output items from either a JSON body or an SSE
/// stream. The SSE path requires exactly one completed terminal frame whose
/// output matches the streamed `output_item.done` items.
fn client_output_items(status: StatusCode, text: &str, stream: bool) -> Vec<Value> {
    if !stream {
        return output_items(&parsed(status, text).unwrap()).unwrap();
    }
    let events = sse_events(text);
    assert!(
        events
            .iter()
            .all(|event| !matches!(event["type"].as_str(), Some("error" | "response.failed"))),
        "a successful streaming control must not expose a failure: {events:?}"
    );
    let terminals: Vec<&Value> = events
        .iter()
        .filter(|event| {
            matches!(
                event["type"].as_str(),
                Some("response.completed" | "response.incomplete")
            )
        })
        .collect();
    assert_eq!(
        terminals.len(),
        1,
        "a streaming control must expose exactly one Responses terminal frame: {events:?}"
    );
    let terminal = terminals[0];
    assert_eq!(terminal["response"]["status"], "completed");
    assert_eq!(
        terminal["type"], "response.completed",
        "a control that returned business content must complete: {terminal}"
    );
    let output = terminal["response"]["output"]
        .as_array()
        .unwrap_or_else(|| panic!("terminal frame must carry Responses output: {terminal}"));
    let streamed: Vec<Value> = events
        .iter()
        .filter(|event| event["type"] == "response.output_item.done")
        .map(|event| event["item"].clone())
        .collect();
    assert_eq!(
        &streamed, output,
        "streamed output items must match the terminal snapshot: {events:?}"
    );
    output.clone()
}

fn call_arguments(item: &Value) -> Value {
    match &item["arguments"] {
        Value::String(text) => serde_json::from_str(text).expect("function arguments must be JSON"),
        other => other.clone(),
    }
}

fn discovery_tools() -> Value {
    json!([
        {
            "type": "tool_search",
            "execution": "client",
            "description": "native first discovery search",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "search query for deferred tools"},
                    "limit": {"type": "number", "description": "maximum number of tools to return"}
                },
                "required": ["query"],
                "additionalProperties": false
            }
        },
        {
            "type": "function",
            "name": LOCAL_FUNCTION_NAME,
            "description": "ordinary local note tool",
            "parameters": {"type": "object", "properties": {"note": {"type": "string"}}}
        }
    ])
}

/// The tools the safe discovery step surfaces for the next model call. They are
/// delivered to the runtime only through the real `tool_search_output` item.
fn discovered_tool_declarations() -> Value {
    json!([
        {
            "type": "namespace",
            "name": DISCOVERED_NAMESPACE,
            "tools": [{
                "type": "function",
                "name": DISCOVERED_LEAF,
                "description": "safe nonce echo handler",
                "parameters": {
                    "type": "object",
                    "properties": {"nonce": {"type": "string"}},
                    "required": ["nonce"],
                    "additionalProperties": false
                }
            }]
        }
    ])
}

/// The actual safe handler. Its output is derived from the arguments the model
/// really produced, so a fabricated success cannot pass.
fn execute_safe_handler(arguments: &Value) -> String {
    arguments
        .get("nonce")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn wire_tool<'a>(body: &'a Value, name: &str) -> Option<&'a Value> {
    body["tools"]
        .as_array()?
        .iter()
        .find(|tool| tool["name"].as_str() == Some(name))
}

/// The discovered declaration's provider wire name, taken from the declaration
/// the provider actually received. The allocator spelling is never an oracle:
/// the fixture matches the complete declared schema and uses the bound name.
fn discovered_wire_name(body: &Value) -> Option<&str> {
    let declarations = discovered_tool_declarations();
    let expected = &declarations[0]["tools"][0];
    let mut matches = body["tools"].as_array()?.iter().filter(|tool| {
        tool["description"] == expected["description"]
            && tool["input_schema"] == expected["parameters"]
    });
    let name = matches.next()?["name"].as_str()?;
    (matches.next().is_none() && !name.is_empty()).then_some(name)
}

fn wire_tool_has_property(body: &Value, name: &str, property: &str) -> bool {
    wire_tool(body, name)
        .and_then(|tool| tool.pointer(&format!("/input_schema/properties/{property}")))
        .is_some()
}

fn has_paired_tool_result(body: &Value, call_id: &str) -> bool {
    fn walk(value: &Value, call_id: &str) -> bool {
        match value {
            Value::Object(map) => {
                if map.get("type").and_then(Value::as_str) == Some("tool_result")
                    && map.get("tool_use_id").and_then(Value::as_str) == Some(call_id)
                {
                    return true;
                }
                map.values().any(|value| walk(value, call_id))
            }
            Value::Array(items) => items.iter().any(|value| walk(value, call_id)),
            _ => false,
        }
    }
    body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|message| walk(message, call_id))
}

fn contains_string(value: &Value, needle: &str) -> bool {
    match value {
        Value::Object(map) => map.values().any(|value| contains_string(value, needle)),
        Value::Array(items) => items.iter().any(|value| contains_string(value, needle)),
        Value::String(text) => text.contains(needle),
        _ => false,
    }
}

fn request_marker(body: &Value) -> String {
    let mut marker = String::new();
    collect_text(&body["messages"], &mut marker);
    marker
}

fn collect_text(value: &Value, text: &mut String) {
    match value {
        Value::Object(map) => {
            if let Some(part) = map.get("text").and_then(Value::as_str) {
                text.push_str(part);
            }
            if let Some(part) = map.get("content").and_then(Value::as_str) {
                text.push_str(part);
            }
            for value in map.values() {
                collect_text(value, text);
            }
        }
        Value::Array(items) => {
            for value in items {
                collect_text(value, text);
            }
        }
        _ => {}
    }
}

fn sse_event(kind: &str, data: Value) -> String {
    format!(
        "event: {kind}\ndata: {}\n\n",
        serde_json::to_string(&data).unwrap()
    )
}

/// Anthropic streaming wire. Tool arguments arrive as one `input_json_delta`
/// frame; the client-facing completed item must carry the full accumulated
/// arguments.
fn anthropic_sse(content: &[Value], stop_reason: &str) -> Response<Body> {
    let mut body = sse_event(
        "message_start",
        json!({"type":"message_start","message":{"id":"msg_native_discovery","type":"message","role":"assistant","model":WIRE_MODEL,"content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}),
    );
    for (index, block) in content.iter().enumerate() {
        match block["type"].as_str() {
            Some("tool_use") => {
                body.push_str(&sse_event(
                    "content_block_start",
                    json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":block["id"],"name":block["name"],"input":{}}}),
                ));
                body.push_str(&sse_event(
                    "content_block_delta",
                    json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":serde_json::to_string(&block["input"]).unwrap()}}),
                ));
            }
            Some("text") => {
                body.push_str(&sse_event(
                    "content_block_start",
                    json!({"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}}),
                ));
                body.push_str(&sse_event(
                    "content_block_delta",
                    json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":block["text"]}}),
                ));
            }
            _ => {}
        }
        body.push_str(&sse_event(
            "content_block_stop",
            json!({"type":"content_block_stop","index":index}),
        ));
    }
    body.push_str(&sse_event(
        "message_delta",
        json!({"type":"message_delta","delta":{"stop_reason":stop_reason},"usage":{"output_tokens":1}}),
    ));
    body.push_str(&sse_event("message_stop", json!({"type":"message_stop"})));
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

fn anthropic_json(content: &[Value], stop_reason: &str) -> Response<Body> {
    ok_json(json!({
        "id": "msg_native_discovery",
        "type": "message",
        "role": "assistant",
        "model": WIRE_MODEL,
        "content": content,
        "stop_reason": stop_reason
    }))
}

fn ok_json(value: Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap()
}

fn bad_request(message: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"error": {"message": message}}).to_string(),
        ))
        .unwrap()
}

fn tool_use(id: &str, name: &str, input: Value) -> Value {
    json!({"type": "tool_use", "id": id, "name": name, "input": input})
}

/// Answers only from the declaration and paired result the upstream actually
/// received. A missing declaration is a hard error, so the upstream never
/// fabricates an unconditional 200 answer.
fn answer(body: &Value) -> Response<Body> {
    let stream = body["stream"].as_bool() == Some(true);
    let reply = |content: Vec<Value>, stop_reason: &str| {
        if stream {
            anthropic_sse(&content, stop_reason)
        } else {
            anthropic_json(&content, stop_reason)
        }
    };
    let marker = request_marker(body);
    if marker.contains(UNDECLARED_MARKER) {
        return reply(
            vec![tool_use("toolu_undeclared", "not_declared_tool", json!({}))],
            "tool_use",
        );
    }
    if marker.contains(SERVER_MARKER) || marker.contains(OMITTED_MARKER) {
        if !wire_tool_has_property(body, NATIVE_SEARCH_NAME, "limit") {
            return bad_request("non-client tool_search declaration was not projected");
        }
        return reply(
            vec![tool_use(
                SEARCH_CALL_ID,
                NATIVE_SEARCH_NAME,
                json!({"query": SEARCH_QUERY, "limit": SEARCH_LIMIT}),
            )],
            "tool_use",
        );
    }
    if marker.contains(CONTROL_MARKER) {
        if !wire_tool_has_property(body, NATIVE_SEARCH_NAME, "scope") {
            return bad_request("ordinary tool_search declaration was not projected");
        }
        return reply(
            vec![tool_use(
                SEARCH_CALL_ID,
                NATIVE_SEARCH_NAME,
                json!({"query": SEARCH_QUERY, "limit": SEARCH_LIMIT}),
            )],
            "tool_use",
        );
    }
    if marker.contains(TURN1_MARKER) {
        if !wire_tool_has_property(body, NATIVE_SEARCH_NAME, "limit") {
            return bad_request("native tool_search declaration was not projected");
        }
        return reply(
            vec![tool_use(
                SEARCH_CALL_ID,
                NATIVE_SEARCH_NAME,
                json!({"query": SEARCH_QUERY, "limit": SEARCH_LIMIT}),
            )],
            "tool_use",
        );
    }
    if marker.contains(TURN2_MARKER) {
        let Some(discovered_wire) = discovered_wire_name(body) else {
            return bad_request("discovered tool was not promoted to the provider wire");
        };
        if !has_paired_tool_result(body, SEARCH_CALL_ID) {
            return bad_request("native tool_search paired result was not forwarded");
        }
        return reply(
            vec![tool_use(
                ECHO_CALL_ID,
                discovered_wire,
                json!({"nonce": NONCE}),
            )],
            "tool_use",
        );
    }
    if marker.contains(TURN3_MARKER) {
        if !has_paired_tool_result(body, ECHO_CALL_ID) {
            return bad_request("echo_nonce paired result was not forwarded");
        }
        if !contains_string(body, NONCE) {
            return bad_request("matched nonce value was not forwarded");
        }
        return reply(
            vec![json!({"type": "text", "text": "nonce accepted"})],
            "end_turn",
        );
    }
    bad_request("unrecognized native discovery fixture phase")
}

#[derive(Clone)]
struct UpstreamState {
    captures: mpsc::UnboundedSender<Value>,
}

async fn controlled_upstream(
    State(state): State<UpstreamState>,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(json!({"path": uri.path(), "body": body.clone()}))
        .unwrap();
    answer(&body)
}

async fn spawn_upstream() -> (String, mpsc::UnboundedReceiver<Value>, oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/messages", post(controlled_upstream))
        .with_state(UpstreamState {
            captures: captures_tx,
        });
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}"), captures_rx, shutdown_tx)
}

async fn capture(captures: &mut mpsc::UnboundedReceiver<Value>, label: &str) -> Value {
    match tokio::time::timeout(Duration::from_secs(5), captures.recv()).await {
        Ok(Some(value)) => {
            eprintln!("EVIDENCE_{label}_UPSTREAM={}", value["body"]);
            value
        }
        Ok(None) => panic!("{label}: upstream capture channel closed"),
        Err(_) => panic!("{label}: controlled upstream never received the request"),
    }
}

#[tokio::test]
async fn native_tool_search_first_discovery_round_trip_through_anthropic() {
    let _guard = TEST_LOCK.lock().await;
    let _key = NativeDiscoveryKeyGuard::install();
    let (base_url, mut captures, upstream_shutdown) = spawn_upstream().await;
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), &base_url))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = http_client();

    // Turn 1: the model calls the declared native discovery tool.
    let (status, text) = send(
        &client,
        &endpoint,
        &json!({
            "model": CLIENT_MODEL,
            "stream": false,
            "input": [{"role": "user", "content": TURN1_MARKER}],
            "tools": discovery_tools()
        }),
    )
    .await
    .unwrap();
    capture(&mut captures, "TURN1").await;
    let body = parsed(status, &text).unwrap();
    let items = output_items(&body).unwrap();
    let search_call = items
        .iter()
        .find(|item| item["type"] == "tool_search_call")
        .unwrap_or_else(|| {
            panic!(
                "client output must expose a tool_search_call for the declared native kind, got: {body}"
            )
        });
    assert_eq!(search_call["call_id"], SEARCH_CALL_ID);
    assert_eq!(search_call["execution"], "client");
    assert_eq!(search_call["arguments"]["query"], SEARCH_QUERY);
    assert_eq!(search_call["arguments"]["limit"], SEARCH_LIMIT);
    assert!(
        items
            .iter()
            .all(|item| !(item["type"] == "function_call" && item["name"] == NATIVE_SEARCH_NAME)),
        "native tool_search must not return as a generic function_call: {body}"
    );
    eprintln!("EVIDENCE_NATIVE_DISCOVERY_CALL={search_call}");

    // Turn 2: the client reports the discovered tools and the model calls the
    // discovered safe handler.
    let (status, text) = send(
        &client,
        &endpoint,
        &json!({
            "model": CLIENT_MODEL,
            "stream": false,
            "input": [
                search_call.clone(),
                {"type": "tool_search_output", "call_id": SEARCH_CALL_ID, "tools": discovered_tool_declarations()},
                {"role": "user", "content": TURN2_MARKER}
            ],
            "tools": discovery_tools()
        }),
    )
    .await
    .unwrap();
    capture(&mut captures, "TURN2").await;
    let body = parsed(status, &text).unwrap();
    let items = output_items(&body).unwrap();
    let echo_call = items
        .iter()
        .find(|item| item["type"] == "function_call")
        .unwrap_or_else(|| {
            panic!("client output must expose the discovered function_call, got: {body}")
        });
    assert_eq!(echo_call["namespace"], DISCOVERED_NAMESPACE);
    assert_eq!(echo_call["name"], DISCOVERED_LEAF);
    assert_eq!(echo_call["call_id"], ECHO_CALL_ID);
    let echo_arguments: Value =
        serde_json::from_str(echo_call["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(echo_arguments["nonce"], NONCE);
    let receipt = execute_safe_handler(&echo_arguments);
    assert_eq!(receipt, NONCE);
    eprintln!(
        "EVIDENCE_SAFE_HANDLER_RECEIPT call_id={} output={receipt}",
        echo_call["call_id"]
    );

    // Turn 3: the matched safe handler result goes back and the model completes.
    let (status, text) = send(
        &client,
        &endpoint,
        &json!({
            "model": CLIENT_MODEL,
            "stream": false,
            "input": [
                search_call.clone(),
                {"type": "tool_search_output", "call_id": SEARCH_CALL_ID, "tools": discovered_tool_declarations()},
                echo_call.clone(),
                {"type": "function_call_output", "call_id": ECHO_CALL_ID, "output": receipt},
                {"role": "user", "content": TURN3_MARKER}
            ],
            "tools": discovery_tools()
        }),
    )
    .await
    .unwrap();
    capture(&mut captures, "TURN3").await;
    let body = parsed(status, &text).unwrap();
    assert!(
        contains_string(&body, "nonce accepted"),
        "the matched follow-up must complete with the provider answer: {body}"
    );
    eprintln!("EVIDENCE_FINAL_RESPONSE={body}");

    handle.shutdown().await;
    upstream_shutdown.send(()).unwrap();
}

#[tokio::test]
async fn ordinary_tool_search_function_is_not_promoted_to_native_kind() {
    let _guard = TEST_LOCK.lock().await;
    let _key = NativeDiscoveryKeyGuard::install();
    let (base_url, mut captures, upstream_shutdown) = spawn_upstream().await;
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), &base_url))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = http_client();

    // (a) An ordinary function named `tool_search` keeps its ordinary kind.
    let (status, text) = send(
        &client,
        &endpoint,
        &json!({
            "model": CLIENT_MODEL,
            "stream": false,
            "input": [{"role": "user", "content": CONTROL_MARKER}],
            "tools": [{
                "type": "function",
                "name": NATIVE_SEARCH_NAME,
                "description": "ordinary control tool_search",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}, "scope": {"type": "string"}}
                }
            }]
        }),
    )
    .await
    .unwrap();
    capture(&mut captures, "CONTROL_ORDINARY").await;
    let body = parsed(status, &text).unwrap();
    let items = output_items(&body).unwrap();
    assert!(
        items
            .iter()
            .any(|item| item["type"] == "function_call" && item["name"] == NATIVE_SEARCH_NAME),
        "an ordinary tool_search function must stay a function_call: {body}"
    );
    assert!(
        items.iter().all(|item| item["type"] != "tool_search_call"),
        "an ordinary function must not be promoted to the native kind: {body}"
    );

    // (b) An undeclared provider call is forwarded verbatim, never promoted.
    let (status, text) = send(
        &client,
        &endpoint,
        &json!({
            "model": CLIENT_MODEL,
            "stream": false,
            "input": [{"role": "user", "content": UNDECLARED_MARKER}],
            "tools": discovery_tools()
        }),
    )
    .await
    .unwrap();
    capture(&mut captures, "CONTROL_UNDECLARED").await;
    let body = parsed(status, &text).unwrap();
    let items = output_items(&body).unwrap();
    assert!(
        items
            .iter()
            .any(|item| item["type"] == "function_call" && item["name"] == "not_declared_tool"),
        "an undeclared call must be forwarded verbatim as a function_call: {body}"
    );
    assert!(
        items.iter().all(|item| item["type"] != "tool_search_call"),
        "an undeclared call must not be promoted to the native kind: {body}"
    );

    handle.shutdown().await;
    upstream_shutdown.send(()).unwrap();
}

#[tokio::test]
async fn non_client_tool_search_controls_preserve_function_call_json_and_sse() {
    let controls = [
        ("server", Some("server"), false),
        ("server-sse", Some("server"), true),
        ("omitted", None, false),
        ("omitted-sse", None, true),
    ];
    for (label, execution, stream) in controls {
        let _guard = TEST_LOCK.lock().await;
        let _key = NativeDiscoveryKeyGuard::install();
        let (base_url, mut captures, upstream_shutdown) = spawn_upstream().await;
        let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), &base_url))
            .await
            .unwrap();
        let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
        let client = http_client();
        let marker = if execution.is_some() {
            SERVER_MARKER
        } else {
            OMITTED_MARKER
        };
        let mut tools = discovery_tools();
        if let Some(execution) = execution {
            tools[0]["execution"] = Value::String(execution.to_string());
        } else {
            tools[0].as_object_mut().unwrap().remove("execution");
        }
        let (status, text) = send(
            &client,
            &endpoint,
            &json!({
                "model": CLIENT_MODEL,
                "stream": stream,
                "input": [{"role": "user", "content": marker}],
                "tools": tools
            }),
        )
        .await
        .unwrap();
        let capture = capture(&mut captures, label).await;
        assert_eq!(status, StatusCode::OK, "{label}: upstream/public status");
        assert_eq!(capture["body"]["stream"], stream, "{label}: stream mode");
        assert!(
            wire_tool_has_property(&capture["body"], NATIVE_SEARCH_NAME, "limit"),
            "{label}: strict upstream must receive the declared search tool"
        );
        let items = client_output_items(status, &text, stream);
        let function_call = items
            .iter()
            .find(|item| item["type"] == "function_call")
            .unwrap_or_else(|| {
                panic!("{label}: non-client search must remain a function_call, got: {items:?}")
            });
        assert_eq!(function_call["name"], NATIVE_SEARCH_NAME, "{label}");
        assert_eq!(function_call["call_id"], SEARCH_CALL_ID, "{label}");
        let arguments = call_arguments(function_call);
        assert_eq!(arguments["query"], SEARCH_QUERY, "{label}");
        assert_eq!(arguments["limit"], SEARCH_LIMIT, "{label}");
        assert!(
            items.iter().all(|item| item["type"] != "tool_search_call"),
            "{label}: non-client search must not gain client-native authority: {items:?}"
        );
        handle.shutdown().await;
        upstream_shutdown.send(()).unwrap();
    }
}
