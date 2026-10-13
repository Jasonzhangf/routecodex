use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{ffi::OsString, net::TcpListener, sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const CUSTOM_TOOL_WIRE_NAME: &str = "routecodex_custom__6170706c795f7061746368";
const ORDINARY_PREFIX_FUNCTION: &str = "routecodex_custom__apply_patch";
/// Wire name the compat owner derives when an ordinary function already owns
/// the reversible hex wire name (`routecodex_custom__6170706c795f7061746368`).
const CUSTOM_TOOL_HASH_WIRE_NAME: &str = "routecodex_custom__d634d6d4ac7f4701";
/// 37-char custom tool name whose reversible hex wire name is 93 chars, over
/// the 64-char provider function-name limit.
const LONG_CUSTOM_TOOL_NAME: &str = "custom_tool_name_with_thirty_three_ch";

struct CounterEnvironment {
    previous: Option<OsString>,
    _runtime: tempfile::TempDir,
}

impl CounterEnvironment {
    fn new() -> Self {
        let runtime = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
        std::env::set_var(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            runtime.path().join("request-id-counter.json"),
        );
        Self {
            previous,
            _runtime: runtime,
        }
    }
}

impl Drop for CounterEnvironment {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE", previous);
        } else {
            std::env::remove_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
        }
    }
}

#[derive(Clone, Copy)]
enum GatewayMode {
    JsonRoundTrip,
    SseMultiline,
    SseMalformed,
    AllowedToolsRoundTrip,
}

#[derive(Clone)]
struct StrictGateway {
    responses: Arc<Mutex<Vec<Value>>>,
    rejections: Arc<Mutex<Vec<String>>>,
    mode: GatewayMode,
    custom_wire_name: String,
    ordinary_wire_name: Option<String>,
}

fn reject_custom(item: &Value, captures: &[Value]) -> Option<String> {
    if let Some(input) = item["input"].as_array() {
        if input.iter().any(|entry| {
            matches!(
                entry["type"].as_str(),
                Some("custom_tool_call" | "custom_tool_call_output")
            )
        }) {
            return Some(format!(
                "strict responses gateway rejected custom input; captures={}",
                serde_json::to_string(captures).unwrap_or_default()
            ));
        }
    }
    if let Some(tools) = item["tools"].as_array() {
        if tools
            .iter()
            .any(|tool| tool["type"].as_str() == Some("custom"))
        {
            return Some(format!(
                "strict responses gateway rejected custom tool declaration; captures={}",
                serde_json::to_string(captures).unwrap_or_default()
            ));
        }
    }
    if item["tool_choice"]["type"].as_str() == Some("custom") {
        return Some(format!(
            "strict responses gateway rejected custom tool_choice; captures={}",
            serde_json::to_string(captures).unwrap_or_default()
        ));
    }
    None
}

fn verify_request(
    body: &Value,
    custom_wire_name: &str,
    ordinary_wire_name: Option<&str>,
) -> Option<String> {
    let tools = body["tools"].as_array()?;
    let required_contains = |tool: &Value, field: &str| {
        tool["parameters"]["required"]
            .as_array()
            .is_some_and(|required| required.iter().any(|value| value == field))
    };
    let custom_declaration = tools.iter().any(|tool| {
        tool["type"] == "function"
            && tool["name"] == custom_wire_name
            && required_contains(tool, "input")
    });
    let ordinary_declaration = ordinary_wire_name.is_none_or(|name| {
        tools.iter().any(|tool| {
            tool["type"] == "function" && tool["name"] == name && required_contains(tool, "cmd")
        })
    });
    let choice = body.pointer("/tool_choice/type") == Some(&json!("function"))
        && body.pointer("/tool_choice/name") == Some(&json!(custom_wire_name));
    if !(custom_declaration && ordinary_declaration && choice) {
        return Some(format!(
            "expected symmetric custom/ordinary function projection; custom={custom_declaration} ordinary={ordinary_declaration} choice={choice} tools={} tool_choice={}",
            serde_json::to_string(tools).unwrap_or_default(),
            serde_json::to_string(&body["tool_choice"]).unwrap_or_default()
        ));
    }

    let input = body["input"].as_array()?;
    let has_history = input
        .iter()
        .any(|entry| entry["type"] == "function_call_output");
    if !has_history {
        return (input
            .first()
            .is_some_and(|entry| entry["type"] == "message"))
        .then_some(())
        .map_or_else(
            || Some("first request must carry the original user message".to_string()),
            |_| None,
        );
    }

    let custom_call = input
        .iter()
        .find(|entry| entry["type"] == "function_call" && entry["call_id"] == "call_compat");
    let custom_output = input
        .iter()
        .find(|entry| entry["type"] == "function_call_output" && entry["call_id"] == "call_compat");
    let custom_paired = custom_call.is_some_and(|entry| {
        entry["name"] == custom_wire_name
            && entry["arguments"] == json!("{\"input\":\"*** Begin Patch\\n*** End Patch\"}")
    }) && custom_output
        .is_some_and(|entry| entry["output"] == "EXECUTED:patch");
    let ordinary_paired = ordinary_wire_name.is_none_or(|name| {
        let ordinary_call = input
            .iter()
            .find(|entry| entry["type"] == "function_call" && entry["call_id"] == "call_ordinary");
        let ordinary_output = input.iter().find(|entry| {
            entry["type"] == "function_call_output" && entry["call_id"] == "call_ordinary"
        });
        ordinary_call.is_some_and(|entry| {
            entry["name"] == name && entry["arguments"] == json!("{\"cmd\":\"pwd\"}")
        }) && ordinary_output.is_some_and(|entry| entry["output"] == "ORDINARY:ok")
    });
    if !(custom_paired && ordinary_paired) {
        return Some(format!(
            "history call/output pairing must preserve both custom and ordinary identities; input={}",
            serde_json::to_string(input).unwrap_or_default()
        ));
    }
    None
}

fn bad_request(message: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error": {
            "type": "invalid_request_error",
            "param": "input",
            "code": "invalid_request_error",
            "message": message
        }})),
    )
        .into_response()
}

/// Verify the projected `allowed_tools` choice references the same wire names as
/// the declarations: the custom tool follows its bound wire name while an
/// ordinary reference keeps its own name.
fn verify_allowed_tools_request(
    body: &Value,
    custom_wire_name: &str,
    ordinary_wire_name: &str,
) -> Option<String> {
    let choice = &body["tool_choice"];
    if choice["type"] != "allowed_tools" {
        return Some(format!("expected allowed_tools tool_choice, got {choice}"));
    }
    if choice["mode"] != "required" {
        return Some(format!("allowed_tools mode must be preserved: {choice}"));
    }
    let Some(tools) = choice["tools"].as_array() else {
        return Some(format!("allowed_tools must carry a tools list: {choice}"));
    };
    let custom_reference = tools
        .iter()
        .any(|tool| tool["type"] == "function" && tool["name"] == custom_wire_name);
    let ordinary_reference = tools
        .iter()
        .any(|tool| tool["type"] == "function" && tool["name"] == ordinary_wire_name);
    if custom_reference && ordinary_reference {
        None
    } else {
        Some(format!(
            "allowed_tools references must follow the projected wire names; custom={custom_reference} ordinary={ordinary_reference} choice={choice}"
        ))
    }
}

fn sse_frame(event: &Value, terminator: &str, multiline: bool) -> String {
    let event_type = event["type"].as_str().unwrap();
    let json = serde_json::to_string(event).unwrap();
    let data = if multiline {
        let split = json
            .find(",\"")
            .map(|index| index + 1)
            .unwrap_or(json.len() / 2);
        let (first, second) = json.split_at(split);
        format!("data: {first}{terminator}data: {second}{terminator}")
    } else {
        format!("data: {json}{terminator}")
    };
    format!("event: {event_type}{terminator}{data}{terminator}")
}

fn malformed_sse_frame() -> String {
    concat!(
        "event: response.output_item.done\r\n",
        "data: {\"type\":\"response.output_item.done\"\r\n",
        "data: malformed\r\n",
        "\r\n"
    )
    .to_string()
}

async fn responses_gateway(
    State(state): State<StrictGateway>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    assert_eq!(headers.get("authorization").unwrap(), "Bearer compat-key");
    state.responses.lock().await.push(body.clone());
    let captures = state.responses.lock().await.clone();
    if let Some(reason) = reject_custom(&body, &captures) {
        state.rejections.lock().await.push(reason.clone());
        return bad_request(reason);
    }
    let rejection = match state.mode {
        GatewayMode::AllowedToolsRoundTrip => verify_allowed_tools_request(
            &body,
            &state.custom_wire_name,
            state
                .ordinary_wire_name
                .as_deref()
                .unwrap_or(ORDINARY_PREFIX_FUNCTION),
        ),
        _ => verify_request(
            &body,
            &state.custom_wire_name,
            state.ordinary_wire_name.as_deref(),
        ),
    };
    if let Some(reason) = rejection {
        state.rejections.lock().await.push(reason.clone());
        return bad_request(reason);
    }
    let custom_wire_name = state.custom_wire_name.clone();
    let ordinary_wire_name = state
        .ordinary_wire_name
        .clone()
        .unwrap_or_else(|| ORDINARY_PREFIX_FUNCTION.to_string());

    match state.mode {
        GatewayMode::JsonRoundTrip => {
            let has_history = body["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["type"] == "function_call_output");
            if has_history {
                return (
                    StatusCode::OK,
                    Json(json!({
                        "id": "resp_roundtrip_2",
                        "object": "response",
                        "created_at": 2,
                        "status": "completed",
                        "model": "kimi-k3",
                        "output": [{
                            "id": "msg_final",
                            "type": "message",
                            "role": "assistant",
                            "status": "completed",
                            "content": [{"type": "output_text", "text": "receipt accepted"}]
                        }],
                        "usage": {"input_tokens": 2, "output_tokens": 2, "total_tokens": 4}
                    })),
                )
                    .into_response();
            }
            return (
                StatusCode::OK,
                Json(json!({
                    "id": "resp_roundtrip_1",
                    "object": "response",
                    "created_at": 1,
                    "status": "completed",
                    "model": "kimi-k3",
                    "output": [
                        {
                            "id": "fc_custom",
                            "type": "function_call",
                            "call_id": "call_compat",
                            "name": custom_wire_name,
                            "arguments": "{\"input\":\"*** Begin Patch\\n*** End Patch\"}",
                            "status": "completed"
                        },
                        {
                            "id": "fc_ordinary",
                            "type": "function_call",
                            "call_id": "call_ordinary",
                            "name": ordinary_wire_name,
                            "arguments": "{\"cmd\":\"pwd\"}",
                            "status": "completed"
                        }
                    ],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
                })),
            )
                .into_response();
        }
        GatewayMode::SseMultiline => {
            let events = [
                json!({"type":"response.created","response":{"id":"resp_compat","model":"kimi-k3","status":"in_progress","output":[]}}),
                json!({"type":"response.output_item.added","output_index":0,"item":{"id":"fc_compat","type":"function_call","call_id":"call_compat","name":custom_wire_name,"arguments":"","status":"in_progress"}}),
                json!({"type":"response.function_call_arguments.delta","item_id":"fc_compat","output_index":0,"delta":"{\"input\":\"*** Begin "}),
                json!({"type":"response.function_call_arguments.delta","item_id":"fc_compat","output_index":0,"delta":"Patch\\n*** End Patch\"}"}),
                json!({"type":"response.function_call_arguments.done","item_id":"fc_compat","output_index":0,"arguments":"{\"input\":\"*** Begin Patch\\n*** End Patch\"}"}),
                json!({"type":"response.output_item.done","output_index":0,"item":{"id":"fc_compat","type":"function_call","call_id":"call_compat","name":custom_wire_name,"arguments":"{\"input\":\"*** Begin Patch\\n*** End Patch\"}","status":"completed"}}),
                json!({"type":"response.completed","response":{"id":"resp_compat","model":"kimi-k3","status":"completed","output":[{"id":"fc_compat","type":"function_call","call_id":"call_compat","name":custom_wire_name,"arguments":"{\"input\":\"*** Begin Patch\\n*** End Patch\"}","status":"completed"}]}}),
            ];
            let terminator = "\r\n";
            let body = events
                .iter()
                .map(|event| sse_frame(event, terminator, true))
                .collect::<String>();
            return ([("content-type", "text/event-stream")], body).into_response();
        }
        GatewayMode::SseMalformed => {
            return (
                [("content-type", "text/event-stream")],
                malformed_sse_frame(),
            )
                .into_response();
        }
        GatewayMode::AllowedToolsRoundTrip => {
            return (
                StatusCode::OK,
                Json(json!({
                    "id": "resp_allowed_tools",
                    "object": "response",
                    "created_at": 1,
                    "status": "completed",
                    "model": "kimi-k3",
                    "output": [{
                        "id": "fc_custom",
                        "type": "function_call",
                        "call_id": "call_compat",
                        "name": custom_wire_name,
                        "arguments": "{\"input\":\"*** Begin Patch\\n*** End Patch\"}",
                        "status": "completed"
                    }],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
                })),
            )
                .into_response();
        }
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn manifest(
    port: u16,
    upstream: &str,
    streaming: &str,
    tool_thinking: bool,
    process: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("test");
    let features = if tool_thinking {
        "[features]\ntool_thinking = true\n"
    } else {
        ""
    };
    let source = format!(
        r#"
version = 3
{declaration}
{features}
[servers.test]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}

[providers.gateway]
type = "responses"
base_url = "{upstream}/v1"
default_model = "kimi-k3"
compatibility_profile = "responses:custom-tool-function"
responses = {{ process = "{process}", streaming = "{streaming}" }}
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_CUSTOM_TOOL_COMPAT_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.gateway.models."kimi-k3"]
wire_name = "kimi-k3"
capabilities = ["text", "tools", "reasoning"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "gateway", model = "kimi-k3", key = "key", priority = 1 }}]

[debug]
log_console = false
snapshots = false
dry_run = false
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn first_request(stream: bool) -> Value {
    json!({
        "model": "gateway.kimi-k3",
        "stream": stream,
        "tools": [
            {"type": "custom", "name": "apply_patch", "description": "Apply patch"},
            {"type": "function", "name": ORDINARY_PREFIX_FUNCTION, "parameters": {
                "type": "object",
                "properties": {"cmd": {"type": "string"}},
                "required": ["cmd"]
            }}
        ],
        "tool_choice": {"type": "custom", "name": "apply_patch"},
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "apply patch"}]}
        ]
    })
}

fn second_request(stream: bool) -> Value {
    json!({
        "model": "gateway.kimi-k3",
        "stream": stream,
        "tools": [
            {"type": "custom", "name": "apply_patch", "description": "Apply patch"},
            {"type": "function", "name": ORDINARY_PREFIX_FUNCTION, "parameters": {
                "type": "object",
                "properties": {"cmd": {"type": "string"}},
                "required": ["cmd"]
            }}
        ],
        "tool_choice": {"type": "custom", "name": "apply_patch"},
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "apply patch"}]},
            {"type": "custom_tool_call", "call_id": "call_compat", "name": "apply_patch", "input": "*** Begin Patch\n*** End Patch"},
            {"type": "custom_tool_call_output", "call_id": "call_compat", "output": "EXECUTED:patch"},
            {"type": "function_call", "call_id": "call_ordinary", "name": ORDINARY_PREFIX_FUNCTION, "arguments": "{\"cmd\":\"pwd\"}"},
            {"type": "function_call_output", "call_id": "call_ordinary", "output": "ORDINARY:ok"}
        ]
    })
}

fn collision_request(stream: bool) -> Value {
    json!({
        "model": "gateway.kimi-k3",
        "stream": stream,
        "tools": [
            {"type": "custom", "name": "apply_patch", "description": "Apply patch"},
            {"type": "function", "name": CUSTOM_TOOL_WIRE_NAME, "parameters": {
                "type": "object",
                "properties": {"cmd": {"type": "string"}},
                "required": ["cmd"]
            }}
        ],
        "tool_choice": {"type": "custom", "name": "apply_patch"},
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "apply patch"}]}
        ]
    })
}

fn long_name_request(stream: bool) -> Value {
    json!({
        "model": "gateway.kimi-k3",
        "stream": stream,
        "tools": [
            {"type": "custom", "name": LONG_CUSTOM_TOOL_NAME, "description": "Apply patch"}
        ],
        "tool_choice": {"type": "custom", "name": LONG_CUSTOM_TOOL_NAME},
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "apply patch"}]}
        ]
    })
}

fn allowed_tools_request(stream: bool) -> Value {
    json!({
        "model": "gateway.kimi-k3",
        "stream": stream,
        "tools": [
            {"type": "custom", "name": "apply_patch", "description": "Apply patch"},
            {"type": "function", "name": CUSTOM_TOOL_WIRE_NAME, "parameters": {
                "type": "object",
                "properties": {"cmd": {"type": "string"}},
                "required": ["cmd"]
            }}
        ],
        "tool_choice": {
            "type": "allowed_tools",
            "mode": "required",
            "tools": [
                {"type": "custom", "name": "apply_patch"},
                {"type": "function", "name": CUSTOM_TOOL_WIRE_NAME}
            ]
        },
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "apply patch"}]}
        ]
    })
}

/// The provider wire name the compat owner binds to a lone custom tool name.
/// This calls the same owner the runtime uses, so the test does not reimplement
/// the naming rule.
fn custom_tool_wire_name(name: &str) -> String {
    let binding = provider_compat_core::compile_custom_tool_function_binding(&json!({
        "tools": [{"type": "custom", "name": name}]
    }));
    binding
        .wire_name_for(name)
        .expect("custom tool declaration must produce a wire name")
        .to_string()
}

async fn start_gateway(
    mode: GatewayMode,
    custom_wire_name: &str,
    ordinary_wire_name: Option<&str>,
) -> (
    String,
    Arc<Mutex<Vec<Value>>>,
    Arc<Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let responses = Arc::new(Mutex::new(Vec::new()));
    let rejections = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn({
        let state = StrictGateway {
            responses: responses.clone(),
            rejections: rejections.clone(),
            mode,
            custom_wire_name: custom_wire_name.to_string(),
            ordinary_wire_name: ordinary_wire_name.map(str::to_string),
        };
        async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/v1/responses", post(responses_gateway))
                    .with_state(state),
            )
            .await
            .unwrap()
        }
    });
    (upstream, responses, rejections, task)
}

#[derive(Debug)]
struct ParsedSseEvent {
    name: String,
    data: Value,
}

fn parse_sse_events(body: &str) -> Vec<ParsedSseEvent> {
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .split("\n\n")
        .filter_map(|frame| {
            let name = frame.lines().find_map(|line| {
                line.strip_prefix("event:")
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
            })?;
            let data = frame
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(|line| line.strip_prefix(' ').unwrap_or(line))
                .collect::<Vec<_>>()
                .join("\n");
            let data = serde_json::from_str(&data).ok()?;
            Some(ParsedSseEvent {
                name: name.to_string(),
                data,
            })
        })
        .collect()
}

fn assert_single_data_line_per_frame(body: &str) {
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    for frame in normalized
        .split("\n\n")
        .filter(|frame| frame.contains("event:"))
    {
        assert_eq!(
            frame
                .lines()
                .filter(|line| line.starts_with("data:"))
                .count(),
            1,
            "custom SSE projection must emit one data line per frame: {frame}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn responses_custom_tool_function_compat_maps_request_and_response_publicly() {
    let _test_guard = TEST_LOCK.lock().await;
    let _counter = CounterEnvironment::new();
    std::env::set_var("V3_CUSTOM_TOOL_COMPAT_KEY", "compat-key");
    let (upstream, responses, _, upstream_task) = start_gateway(
        GatewayMode::JsonRoundTrip,
        CUSTOM_TOOL_WIRE_NAME,
        Some(ORDINARY_PREFIX_FUNCTION),
    )
    .await;
    let server =
        spawn_v3_server_aggregate(manifest(free_port(), &upstream, "never", false, "direct"))
            .await
            .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let url = format!("http://{}/v1/responses", server.listeners[0].addr);

    let first = client
        .post(&url)
        .json(&first_request(false))
        .send()
        .await
        .expect("first public /v1/responses request must reach the listener");
    let first_status = first.status();
    let first_body = first.text().await.expect("first response body");
    assert!(
        first_status.is_success(),
        "strict gateway must accept the first compatible request: {first_status} {first_body}"
    );
    let first: Value = serde_json::from_str(&first_body).expect("first response must be JSON");
    let output = first["output"].as_array().expect("response output array");
    assert_eq!(output.len(), 2);
    assert_eq!(output[0]["type"], "custom_tool_call");
    assert_eq!(output[0]["id"], "fc_custom");
    assert_eq!(output[0]["call_id"], "call_compat");
    assert_eq!(output[0]["name"], "apply_patch");
    assert_eq!(output[0]["input"], "*** Begin Patch\n*** End Patch");
    assert!(output[0].get("arguments").is_none());
    assert_eq!(output[1]["type"], "function_call");
    assert_eq!(output[1]["id"], "fc_ordinary");
    assert_eq!(output[1]["call_id"], "call_ordinary");
    assert_eq!(output[1]["name"], ORDINARY_PREFIX_FUNCTION);
    assert_eq!(output[1]["arguments"], "{\"cmd\":\"pwd\"}");

    let second = client
        .post(&url)
        .json(&second_request(false))
        .send()
        .await
        .expect("second public /v1/responses request must reach the listener");
    let second_status = second.status();
    let second_body = second.text().await.expect("second response body");
    assert!(
        second_status.is_success(),
        "strict gateway must accept the paired follow-up request: {second_status} {second_body}"
    );
    let second: Value = serde_json::from_str(&second_body).expect("second response must be JSON");
    assert_eq!(second["output"][0]["type"], "message");
    assert_eq!(
        second["output"][0]["content"][0]["text"],
        "receipt accepted"
    );
    assert_eq!(responses.lock().await.len(), 2);
    server.shutdown().await;
    upstream_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn responses_custom_tool_function_compat_maps_request_and_response_through_relay_publicly() {
    let _test_guard = TEST_LOCK.lock().await;
    let _counter = CounterEnvironment::new();
    std::env::set_var("V3_CUSTOM_TOOL_COMPAT_KEY", "compat-key");
    let (upstream, responses, _, upstream_task) = start_gateway(
        GatewayMode::JsonRoundTrip,
        CUSTOM_TOOL_WIRE_NAME,
        Some(ORDINARY_PREFIX_FUNCTION),
    )
    .await;
    // `process = "chat"` forces the Relay execution path for the same Responses
    // provider, so a missing Relay response binding handoff is observable here.
    let server =
        spawn_v3_server_aggregate(manifest(free_port(), &upstream, "never", false, "chat"))
            .await
            .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let url = format!("http://{}/v1/responses", server.listeners[0].addr);

    let first = client
        .post(&url)
        .json(&first_request(false))
        .send()
        .await
        .unwrap_or_else(|error| {
            let captured = responses.try_lock().map(|c| c.clone()).unwrap_or_default();
            panic!(
                "relay public /v1/responses request must reach the listener: {error}; captured={}",
                serde_json::to_string(&captured).unwrap_or_default()
            );
        });
    let first_status = first.status();
    let first_body = first.text().await.expect("relay first response body");
    assert!(
        first_status.is_success(),
        "strict gateway must accept the relay-compatible first request: {first_status} {first_body}"
    );
    let first: Value = serde_json::from_str(&first_body).expect("relay response must be JSON");
    let output = first["output"].as_array().expect("relay response output");
    assert_eq!(output[0]["type"], "custom_tool_call", "body={first_body}");
    assert_eq!(output[0]["call_id"], "call_compat");
    assert_eq!(output[0]["name"], "apply_patch");
    assert_eq!(output[0]["input"], "*** Begin Patch\n*** End Patch");
    assert!(output[0].get("arguments").is_none());
    assert_eq!(output[1]["type"], "function_call", "body={first_body}");
    assert_eq!(output[1]["name"], ORDINARY_PREFIX_FUNCTION);

    let second = client
        .post(&url)
        .json(&second_request(false))
        .send()
        .await
        .expect("relay paired follow-up must reach the listener");
    let second_status = second.status();
    let second_body = second.text().await.expect("relay second response body");
    assert!(
        second_status.is_success(),
        "strict gateway must accept the relay paired follow-up: {second_status} {second_body}"
    );
    let second: Value = serde_json::from_str(&second_body).expect("relay second response JSON");
    assert_eq!(second["output"][0]["type"], "message");
    assert_eq!(responses.lock().await.len(), 2);

    server.shutdown().await;
    upstream_task.abort();
}

/// The streamed projection must be correct whether the Responses provider runs
/// Direct or Relay (`responses.process = "chat"`): neither path may leak the
/// standard `apply_patch` function projection or the wire name, and both must
/// hand the client a `custom_tool_call` with the unwrapped input.
///
/// The Direct path streams `custom_tool_call_input.delta`/`.done` frames. The
/// Relay path buffers the provider attempt and replays it, so its tool frames
/// are `output_item.added`/`.done` with the complete item and no delta frames.
async fn run_custom_tool_sse_blackbox(process: &str, streaming_deltas: bool) {
    let _test_guard = TEST_LOCK.lock().await;
    let _counter = CounterEnvironment::new();
    std::env::set_var("V3_CUSTOM_TOOL_COMPAT_KEY", "compat-key");
    let (upstream, responses, rejections, upstream_task) = start_gateway(
        GatewayMode::SseMultiline,
        CUSTOM_TOOL_WIRE_NAME,
        Some(ORDINARY_PREFIX_FUNCTION),
    )
    .await;
    let server =
        spawn_v3_server_aggregate(manifest(free_port(), &upstream, "always", true, process))
            .await
            .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let reply = client
        .post(format!("http://{}/v1/responses", server.listeners[0].addr))
        .json(&first_request(true))
        .send()
        .await;
    let captured = responses.lock().await.clone();
    let rejection = captured
        .first()
        .and_then(|request| {
            verify_request(
                request,
                CUSTOM_TOOL_WIRE_NAME,
                Some(ORDINARY_PREFIX_FUNCTION),
            )
        })
        .or_else(|| {
            captured
                .first()
                .and_then(|request| reject_custom(request, &captured))
        });
    let reply = reply.unwrap_or_else(|error| {
        panic!(
            "public streamed /v1/responses request must reach the listener: {error}; rejection={rejection:?}; gateway_rejections={:?}; captures={captured:?}",
            rejections
                .try_lock()
                .map(|rejections| rejections.clone())
                .unwrap_or_default()
        )
    });
    let status = reply.status();
    let body = reply.text().await.unwrap();
    assert!(
        status.is_success(),
        "strict gateway must accept the SSE compatibility request: {status} {body}; rejection={rejection:?}"
    );
    assert!(!body.contains(CUSTOM_TOOL_WIRE_NAME), "{body}");
    assert!(!body.contains("response.function_call_arguments"), "{body}");
    assert_single_data_line_per_frame(&body);
    let events = parse_sse_events(&body);
    assert!(events.iter().all(|event| event.name == event.data["type"]));
    assert!(events.iter().all(|event| {
        event.data["type"]
            .as_str()
            .is_some_and(|event_type| !event_type.starts_with("response.function_call_arguments."))
    }));

    let added = events
        .iter()
        .find(|event| event.data["type"] == "response.output_item.added")
        .expect("added event");
    assert_eq!(added.data["output_index"], 0);
    assert_eq!(added.data["item"]["id"], "fc_compat");
    assert_eq!(added.data["item"]["type"], "custom_tool_call");
    assert_eq!(added.data["item"]["call_id"], "call_compat");
    assert_eq!(added.data["item"]["name"], "apply_patch");
    assert!(added.data["item"].get("arguments").is_none());
    if streaming_deltas {
        // Direct streams an empty input first, then the unwrapped input deltas.
        assert_eq!(added.data["item"]["input"], "");
        let deltas = events
            .iter()
            .filter(|event| event.data["type"] == "response.custom_tool_call_input.delta")
            .collect::<Vec<_>>();
        assert!(
            !deltas.is_empty(),
            "custom SSE projection must emit at least one input delta"
        );
        for delta in &deltas {
            assert_eq!(delta.data["item_id"], "fc_compat");
            assert_eq!(delta.data["output_index"], 0);
        }
        let projected_input = deltas
            .iter()
            .map(|event| event.data["delta"].as_str().unwrap_or_default())
            .collect::<String>();
        assert_eq!(projected_input, "*** Begin Patch\n*** End Patch");

        let input_done = events
            .iter()
            .find(|event| event.data["type"] == "response.custom_tool_call_input.done")
            .expect("custom input done event");
        assert_eq!(input_done.data["item_id"], "fc_compat");
        assert_eq!(input_done.data["output_index"], 0);
        assert_eq!(input_done.data["input"], "*** Begin Patch\n*** End Patch");
        assert!(input_done.data.get("arguments").is_none());
    } else {
        // The buffered Relay replay carries the complete item on the added frame.
        assert_eq!(
            added.data["item"]["input"],
            "*** Begin Patch\n*** End Patch"
        );
        assert!(
            events.iter().all(
                |event| !event.data["type"].as_str().is_some_and(
                    |event_type| event_type.starts_with("response.custom_tool_call_input.")
                )
            ),
            "buffered Relay replay must not fabricate delta frames: {body}"
        );
    }

    let item_done = events
        .iter()
        .find(|event| event.data["type"] == "response.output_item.done")
        .expect("item done event");
    assert_eq!(item_done.data["output_index"], 0);
    assert_eq!(item_done.data["item"]["id"], "fc_compat");
    assert_eq!(item_done.data["item"]["type"], "custom_tool_call");
    assert_eq!(item_done.data["item"]["call_id"], "call_compat");
    assert_eq!(item_done.data["item"]["name"], "apply_patch");
    assert_eq!(
        item_done.data["item"]["input"],
        "*** Begin Patch\n*** End Patch"
    );
    assert!(item_done.data["item"].get("arguments").is_none());

    let completed = events
        .iter()
        .find(|event| event.data["type"] == "response.completed")
        .expect("completed event");
    let completed_item = &completed.data["response"]["output"][0];
    assert_eq!(completed_item["id"], "fc_compat");
    assert_eq!(completed_item["type"], "custom_tool_call");
    assert_eq!(completed_item["call_id"], "call_compat");
    assert_eq!(completed_item["name"], "apply_patch");
    assert_eq!(completed_item["input"], "*** Begin Patch\n*** End Patch");
    assert!(completed_item.get("arguments").is_none());
    assert_eq!(responses.lock().await.len(), 1);
    assert!(rejections.lock().await.is_empty());
    server.shutdown().await;
    upstream_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn responses_custom_tool_function_compat_rewrites_provider_sse_publicly() {
    run_custom_tool_sse_blackbox("direct", true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn responses_custom_tool_function_compat_rewrites_provider_sse_through_relay_publicly() {
    run_custom_tool_sse_blackbox("chat", false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn responses_custom_tool_function_compat_avoids_ordinary_wire_name_collision_publicly() {
    let _test_guard = TEST_LOCK.lock().await;
    let _counter = CounterEnvironment::new();
    std::env::set_var("V3_CUSTOM_TOOL_COMPAT_KEY", "compat-key");
    let (upstream, responses, _, upstream_task) = start_gateway(
        GatewayMode::JsonRoundTrip,
        CUSTOM_TOOL_HASH_WIRE_NAME,
        Some(CUSTOM_TOOL_WIRE_NAME),
    )
    .await;
    let server =
        spawn_v3_server_aggregate(manifest(free_port(), &upstream, "never", false, "direct"))
            .await
            .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let reply = client
        .post(format!("http://{}/v1/responses", server.listeners[0].addr))
        .json(&collision_request(false))
        .send()
        .await
        .expect("collision public request must reach the listener");
    let status = reply.status();
    let body = reply.text().await.expect("collision response body");
    assert!(
        status.is_success(),
        "strict gateway must accept the collision request: {status} {body}"
    );

    let captured = responses.lock().await.clone();
    assert_eq!(captured.len(), 1, "one provider request expected");
    let tools = captured[0]["tools"]
        .as_array()
        .expect("provider tools array");
    let custom_wire = tools
        .iter()
        .find(|tool| {
            tool["type"] == "function"
                && tool["parameters"]["required"]
                    .as_array()
                    .is_some_and(|required| required.iter().any(|value| value == "input"))
        })
        .and_then(|tool| tool["name"].as_str())
        .expect("custom declaration must project to a provider function");
    assert_eq!(
        custom_wire, CUSTOM_TOOL_HASH_WIRE_NAME,
        "a declared ordinary function that owns the reversible wire name must force the custom tool onto the hashed wire name"
    );
    assert_eq!(
        captured[0].pointer("/tool_choice/name"),
        Some(&json!(CUSTOM_TOOL_HASH_WIRE_NAME)),
        "tool_choice must follow the custom tool onto its hashed wire name"
    );
    let ordinary_wire = tools
        .iter()
        .find(|tool| {
            tool["type"] == "function"
                && tool["parameters"]["required"]
                    .as_array()
                    .is_some_and(|required| required.iter().any(|value| value == "cmd"))
        })
        .and_then(|tool| tool["name"].as_str())
        .expect("ordinary declaration must stay a provider function");
    assert_eq!(
        ordinary_wire, CUSTOM_TOOL_WIRE_NAME,
        "the ordinary function must keep its own name, not be relabelled as the custom tool"
    );

    let output = serde_json::from_str::<Value>(&body).expect("collision response must be JSON");
    assert_eq!(
        output["output"][0]["type"], "custom_tool_call",
        "the hashed provider function name must map back to the custom tool call: {body}"
    );
    assert_eq!(output["output"][0]["name"], "apply_patch");
    assert_eq!(
        output["output"][0]["input"],
        "*** Begin Patch\n*** End Patch"
    );
    assert_eq!(
        output["output"][1]["type"], "function_call",
        "the ordinary function that owns the reversible name must stay a function_call: {body}"
    );
    assert_eq!(
        output["output"][1]["name"], CUSTOM_TOOL_WIRE_NAME,
        "body={body}"
    );

    server.shutdown().await;
    upstream_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn responses_custom_tool_function_compat_keeps_long_wire_name_within_provider_limit_publicly()
{
    let _test_guard = TEST_LOCK.lock().await;
    let _counter = CounterEnvironment::new();
    std::env::set_var("V3_CUSTOM_TOOL_COMPAT_KEY", "compat-key");
    let expected_wire = custom_tool_wire_name(LONG_CUSTOM_TOOL_NAME);
    let (upstream, responses, _, upstream_task) =
        start_gateway(GatewayMode::JsonRoundTrip, &expected_wire, None).await;
    let server =
        spawn_v3_server_aggregate(manifest(free_port(), &upstream, "never", false, "direct"))
            .await
            .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let reply = client
        .post(format!("http://{}/v1/responses", server.listeners[0].addr))
        .json(&long_name_request(false))
        .send()
        .await
        .expect("long-name public request must reach the listener");
    let status = reply.status();
    let body = reply.text().await.expect("long-name response body");
    assert!(
        status.is_success(),
        "strict gateway must accept the long-name request: {status} {body}"
    );

    let captured = responses.lock().await.clone();
    assert_eq!(captured.len(), 1, "one provider request expected");
    let wire = captured[0]["tools"][0]["name"]
        .as_str()
        .expect("long custom tool must project to a provider function");
    assert!(
        wire.len() <= 64,
        "the provider function name must stay within the 64-char limit: {wire}"
    );
    assert!(
        wire.starts_with("routecodex_custom__"),
        "long custom tool must still use the reserved compat wire prefix: {wire}"
    );
    assert_eq!(wire, expected_wire);

    let output = serde_json::from_str::<Value>(&body).expect("long-name response must be JSON");
    assert_eq!(
        output["output"][0]["type"], "custom_tool_call",
        "the short wire name must map back to the long custom tool call: {body}"
    );
    assert_eq!(output["output"][0]["name"], LONG_CUSTOM_TOOL_NAME);
    assert_eq!(
        output["output"][0]["input"],
        "*** Begin Patch\n*** End Patch"
    );

    server.shutdown().await;
    upstream_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn responses_custom_tool_function_compat_maps_allowed_tools_choice_publicly() {
    let _test_guard = TEST_LOCK.lock().await;
    let _counter = CounterEnvironment::new();
    std::env::set_var("V3_CUSTOM_TOOL_COMPAT_KEY", "compat-key");
    let (upstream, responses, _, upstream_task) = start_gateway(
        GatewayMode::AllowedToolsRoundTrip,
        CUSTOM_TOOL_HASH_WIRE_NAME,
        Some(CUSTOM_TOOL_WIRE_NAME),
    )
    .await;
    let server =
        spawn_v3_server_aggregate(manifest(free_port(), &upstream, "never", false, "direct"))
            .await
            .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let reply = client
        .post(format!("http://{}/v1/responses", server.listeners[0].addr))
        .json(&allowed_tools_request(false))
        .send()
        .await
        .expect("allowed_tools public request must reach the listener");
    let status = reply.status();
    let body = reply.text().await.expect("allowed_tools response body");
    assert!(
        status.is_success(),
        "strict gateway must accept the allowed_tools request: {status} {body}"
    );

    let captured = responses.lock().await.clone();
    assert_eq!(captured.len(), 1, "one provider request expected");
    let choice_tools = captured[0]["tool_choice"]["tools"]
        .as_array()
        .expect("allowed_tools tools array");
    assert_eq!(choice_tools[0]["type"], "function");
    assert_eq!(
        choice_tools[0]["name"], CUSTOM_TOOL_HASH_WIRE_NAME,
        "a custom allowed-tools reference must follow the bound wire name"
    );
    assert_eq!(choice_tools[1]["type"], "function");
    assert_eq!(
        choice_tools[1]["name"], CUSTOM_TOOL_WIRE_NAME,
        "an ordinary allowed-tools reference must keep its own name"
    );
    assert_eq!(
        captured[0]["tool_choice"]["mode"], "required",
        "allowed_tools mode must be preserved"
    );

    let output = serde_json::from_str::<Value>(&body).expect("allowed_tools response must be JSON");
    assert_eq!(
        output["output"][0]["type"], "custom_tool_call",
        "the custom allowed-tools wire reference must map back to a custom tool call: {body}"
    );
    assert_eq!(output["output"][0]["name"], "apply_patch");

    server.shutdown().await;
    upstream_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn responses_custom_tool_function_compat_rejects_malformed_provider_sse_publicly() {
    let _test_guard = TEST_LOCK.lock().await;
    let _counter = CounterEnvironment::new();
    std::env::set_var("V3_CUSTOM_TOOL_COMPAT_KEY", "compat-key");
    let (upstream, responses, rejections, upstream_task) = start_gateway(
        GatewayMode::SseMalformed,
        CUSTOM_TOOL_WIRE_NAME,
        Some(ORDINARY_PREFIX_FUNCTION),
    )
    .await;
    let server =
        spawn_v3_server_aggregate(manifest(free_port(), &upstream, "always", false, "direct"))
            .await
            .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let reply = client
        .post(format!("http://{}/v1/responses", server.listeners[0].addr))
        .json(&first_request(true))
        .send()
        .await
        .expect("malformed provider SSE request must reach the listener");
    let status = reply.status();
    match reply.text().await {
        Ok(body) => panic!(
            "malformed provider SSE must break the client transport without a readable body; got status={status} body={body}"
        ),
        Err(error) => {
            assert!(
                error.is_body() || error.is_decode(),
                "malformed provider SSE must break the client body transport instead of returning success: {error}"
            );
        }
    }
    assert_eq!(responses.lock().await.len(), 1);
    assert!(rejections.lock().await.is_empty());
    server.shutdown().await;
    upstream_task.abort();
}
