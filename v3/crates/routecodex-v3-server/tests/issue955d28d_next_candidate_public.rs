//! issue955d28d: Relay -> Direct next-candidate identity through public HTTP.
//!
//! The main cases use one provider with a Chat interface followed by a Responses
//! sibling in strict priority order. The Chat interface records the projected
//! request and drops the connection before a response head. The Responses sibling
//! then receives the actual retry, validates the preserved tool history, returns
//! a real function call, and accepts the client's paired follow-up as a new
//! request. A lower-priority decoy records any incorrect final selection.
//!
//! This is a test-owned loopback fixture. It does not read production config or
//! credentials and does not touch the live listeners.

use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const KEY_ENV: &str = "ISSUE955D28D_FIXTURE_KEY";
const FIXTURE_KEY: &str = "owned-issue955d28d-key";
const CLIENT_MODEL: &str = "issue955d28d-client";
const CHAT_MODEL: &str = "issue955d28d-chat";
const RESPONSES_MODEL: &str = "issue955d28d-responses";
const DECOY_MODEL: &str = "issue955d28d-decoy";
const TOOL_NAME: &str = "add";
const HISTORY_CALL_ID: &str = "call_955d28d_history";
const NEW_CALL_ID: &str = "call_955d28d_add";
const REQUEST_MARKER: &str = "issue955d28d current request";
const HISTORY_ARGUMENTS: &str = "{\"a\":7,\"b\":8}";
const NEW_ARGUMENTS: &str = "{\"a\":2,\"b\":3}";
const B_KEY: &str = "multi:responses:key1:issue955d28d-responses";
const FAILED_ATTEMPT_FILE: &str = "provider-failed-attempts.json";

#[derive(Clone, Debug)]
struct Capture {
    path: String,
    body: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChatBehavior {
    Healthy,
    PreHeadDrop,
}

struct ChatPeer {
    behavior: Mutex<ChatBehavior>,
    captures: Mutex<Vec<Capture>>,
}

impl ChatPeer {
    fn new() -> Self {
        Self {
            behavior: Mutex::new(ChatBehavior::PreHeadDrop),
            captures: Mutex::new(Vec::new()),
        }
    }

    async fn set_behavior(&self, behavior: ChatBehavior) {
        *self.behavior.lock().await = behavior;
    }

    async fn captures(&self) -> Vec<Capture> {
        self.captures.lock().await.clone()
    }

    async fn clear(&self) {
        self.captures.lock().await.clear();
    }
}

struct ResponsesPeer {
    label: &'static str,
    captures: Mutex<Vec<Capture>>,
}

impl ResponsesPeer {
    fn new(label: &'static str) -> Self {
        Self {
            label,
            captures: Mutex::new(Vec::new()),
        }
    }

    async fn captures(&self) -> Vec<Capture> {
        self.captures.lock().await.clone()
    }

    async fn clear(&self) {
        self.captures.lock().await.clear();
    }
}

async fn serve_chat(listener: TcpListener, peer: Arc<ChatPeer>) {
    loop {
        let Ok((mut socket, _)) = listener.accept().await else {
            continue;
        };
        let peer = peer.clone();
        tokio::spawn(async move {
            let Some((head, body)) = read_http_request(&mut socket).await else {
                return;
            };
            let path = request_path(&head);
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            peer.captures.lock().await.push(Capture {
                path: path.clone(),
                body: body.clone(),
            });
            match *peer.behavior.lock().await {
                ChatBehavior::PreHeadDrop => drop(socket),
                ChatBehavior::Healthy => {
                    let _ = write_chat_success(&mut socket).await;
                }
            }
        });
    }
}

async fn serve_responses(listener: TcpListener, peer: Arc<ResponsesPeer>) {
    loop {
        let Ok((mut socket, _)) = listener.accept().await else {
            continue;
        };
        let peer = peer.clone();
        tokio::spawn(async move {
            let Some((head, body)) = read_http_request(&mut socket).await else {
                return;
            };
            let path = request_path(&head);
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            peer.captures.lock().await.push(Capture {
                path,
                body: body.clone(),
            });
            if peer.label == "decoy" {
                let _ = write_responses_business(&mut socket, "decoy business result").await;
                return;
            }
            let _ = write_responses_business_or_call(&mut socket, &body).await;
        });
    }
}

fn request_path(head: &str) -> String {
    head.lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default()
        .to_string()
}

async fn read_http_request(socket: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    while buffer.len() < head_end + content_length {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Some((head, buffer[head_end..head_end + content_length].to_vec()))
}

async fn write_chat_success(socket: &mut TcpStream) -> std::io::Result<()> {
    let body = json!({
        "id": "chatcmpl_issue955d28d",
        "object": "chat.completion",
        "model": CHAT_MODEL,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "healthy chat provider result"},
            "finish_reason": "stop"
        }]
    })
    .to_string();
    write_json_response(socket, &body).await
}

async fn write_responses_business_or_call(
    socket: &mut TcpStream,
    body: &Value,
) -> std::io::Result<()> {
    let stream = body["stream"].as_bool() == Some(true);
    let followup = body["input"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["type"] == "function_call_output" && item["call_id"] == NEW_CALL_ID)
    });
    if followup {
        if stream {
            write_responses_business_sse(socket, "add result received").await
        } else {
            write_responses_business(socket, "add result received").await
        }
    } else {
        if stream {
            write_responses_call_sse(socket).await
        } else {
            let response = json!({
                "id": "resp_issue955d28d_call",
                "status": "completed",
                "output": [{
                    "type": "function_call",
                    "call_id": NEW_CALL_ID,
                    "name": TOOL_NAME,
                    "arguments": NEW_ARGUMENTS
                }]
            })
            .to_string();
            write_json_response(socket, &response).await
        }
    }
}

fn response_call_item(status: &str) -> Value {
    json!({
        "id": "item_issue955d28d_call",
        "type": "function_call",
        "status": status,
        "call_id": NEW_CALL_ID,
        "name": TOOL_NAME,
        "arguments": if status == "in_progress" { "" } else { NEW_ARGUMENTS }
    })
}

async fn write_responses_call_sse(socket: &mut TcpStream) -> std::io::Result<()> {
    let events = [
        json!({
            "type": "response.created",
            "response": {
                "id": "resp_issue955d28d_call",
                "status": "in_progress",
                "model": RESPONSES_MODEL,
                "output": []
            }
        }),
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": response_call_item("in_progress")
        }),
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": response_call_item("completed")
        }),
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp_issue955d28d_call",
                "status": "completed",
                "model": RESPONSES_MODEL,
                "output": [response_call_item("completed")]
            }
        }),
    ]
    .iter()
    .map(|event| {
        format!(
            "event: {}\ndata: {}\n\n",
            event["type"].as_str().unwrap(),
            event
        )
    })
    .collect::<String>()
        + "data: [DONE]\n\n";
    write_sse_response(socket, &events).await
}

async fn write_responses_business_sse(socket: &mut TcpStream, text: &str) -> std::io::Result<()> {
    let events = [
        json!({
            "type": "response.created",
            "response": {
                "id": "resp_issue955d28d_done",
                "status": "in_progress",
                "model": RESPONSES_MODEL,
                "output": []
            }
        }),
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp_issue955d28d_done",
                "status": "completed",
                "model": RESPONSES_MODEL,
                "output_text": text,
                "output": [{"type": "output_text", "text": text}]
            }
        }),
    ]
    .iter()
    .map(|event| {
        format!(
            "event: {}\ndata: {}\n\n",
            event["type"].as_str().unwrap(),
            event
        )
    })
    .collect::<String>()
        + "data: [DONE]\n\n";
    write_sse_response(socket, &events).await
}

async fn write_responses_business(socket: &mut TcpStream, text: &str) -> std::io::Result<()> {
    let response = json!({
        "id": "resp_issue955d28d_done",
        "status": "completed",
        "output_text": text,
        "output": [{"type": "output_text", "text": text}]
    })
    .to_string();
    write_json_response(socket, &response).await
}

async fn write_sse_response(socket: &mut TcpStream, body: &str) -> std::io::Result<()> {
    socket
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        )
        .await?;
    socket.flush().await
}

async fn write_json_response(socket: &mut TcpStream, body: &str) -> std::io::Result<()> {
    socket
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        )
        .await?;
    socket.flush().await
}

fn manifest(
    server_port: u16,
    chat_port: u16,
    responses_port: u16,
    decoy_port: u16,
    b_only: bool,
) -> V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let declaration =
        hub_v1_fixture::hub_v1_test_declaration().replace(direct_binding, relay_binding);
    let execution = hub_v1_fixture::hub_v1_server_execution("owned");
    let targets = if b_only {
        format!(
            r#"[{{ kind = "provider_model", provider = "multi", model = "{RESPONSES_MODEL}", key = "key1", interface = "responses", priority = 2 }}]"#
        )
    } else {
        format!(
            r#"[{{ kind = "provider_model", provider = "multi", model = "{CHAT_MODEL}", key = "key1", interface = "chat", priority = 3 }}, {{ kind = "provider_model", provider = "multi", model = "{RESPONSES_MODEL}", key = "key1", interface = "responses", priority = 2 }}, {{ kind = "provider_model", provider = "other", model = "{DECOY_MODEL}", key = "key2", interface = "responses", priority = 1 }}]"#
        )
    };
    let source = format!(
        r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {server_port}
routing_group = "owned"
endpoints = ["responses"]
{execution}
[providers.multi]
default_model = "{RESPONSES_MODEL}"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.multi.models.{CHAT_MODEL}]
wire_name = "{CHAT_MODEL}"
capabilities = ["text", "tools"]
supports_streaming = true
[providers.multi.models.{RESPONSES_MODEL}]
wire_name = "{RESPONSES_MODEL}"
capabilities = ["text", "tools"]
supports_streaming = true
[providers.multi.interfaces.chat]
type = "openai_chat"
base_url = "http://127.0.0.1:{chat_port}/v1"
[providers.multi.interfaces.responses]
type = "responses"
base_url = "http://127.0.0.1:{responses_port}/v1"
[providers.other]
default_model = "{DECOY_MODEL}"
auth = {{ type = "api_key", entries = [{{ alias = "key2", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.other.interfaces.responses]
type = "responses"
base_url = "http://127.0.0.1:{decoy_port}/v1"
[providers.other.models.{DECOY_MODEL}]
wire_name = "{DECOY_MODEL}"
capabilities = ["text", "tools"]
supports_streaming = true
[route_groups.owned.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["{CLIENT_MODEL}"] }}
targets = {targets}
[route_groups.owned.pools.default]
selection = {{ strategy = "priority" }}
targets = {targets}
[debug]
log_console = false
snapshots = true
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn initial_request(stream: bool) -> Value {
    json!({
        "model": CLIENT_MODEL,
        "stream": stream,
        "input": [
            {"role": "user", "content": REQUEST_MARKER},
            {"type": "function_call", "call_id": HISTORY_CALL_ID, "name": TOOL_NAME, "arguments": HISTORY_ARGUMENTS},
            {"type": "function_call_output", "call_id": HISTORY_CALL_ID, "output": "15"}
        ],
        "tools": [{
            "type": "function",
            "name": TOOL_NAME,
            "description": "Add two integers.",
            "parameters": {
                "type": "object",
                "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                "required": ["a", "b"],
                "additionalProperties": false
            }
        }]
    })
}

fn execute_add(call: &Value) -> String {
    assert_eq!(call["name"], TOOL_NAME);
    let arguments = call["arguments"]
        .as_str()
        .expect("function call arguments string");
    let arguments: Value = serde_json::from_str(arguments).expect("function call arguments JSON");
    let a = arguments["a"].as_i64().expect("integer argument a");
    let b = arguments["b"].as_i64().expect("integer argument b");
    (a + b).to_string()
}

fn assert_tool_declaration(tool: &Value) {
    assert_eq!(tool["name"], TOOL_NAME);
    assert_eq!(tool["description"], "Add two integers.");
    assert_eq!(
        tool["parameters"],
        json!({
            "type": "object",
            "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
            "required": ["a", "b"],
            "additionalProperties": false
        })
    );
}

fn followup_request(original: &Value, call: &Value, client_output: &str) -> Value {
    let mut input = original["input"]
        .as_array()
        .expect("original request input")
        .clone();
    input.push(json!({
        "type": "function_call",
        "call_id": call["call_id"],
        "name": call["name"],
        "arguments": call["arguments"]
    }));
    input.push(json!({
        "type": "function_call_output",
        "call_id": call["call_id"],
        "output": client_output
    }));
    json!({
        "model": CLIENT_MODEL,
        "stream": false,
        "input": input,
        "tools": [{
            "type": "function",
            "name": TOOL_NAME,
            "description": "Add two integers.",
            "parameters": {
                "type": "object",
                "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                "required": ["a", "b"],
                "additionalProperties": false
            }
        }]
    })
}

fn assert_chat_wire(capture: &Capture) {
    assert_eq!(capture.path, "/v1/chat/completions");
    assert_eq!(capture.body["model"], CHAT_MODEL);
    assert_tool_declaration(&capture.body["tools"][0]["function"]);
    assert_eq!(
        capture.body["messages"][1]["tool_calls"][0]["id"],
        HISTORY_CALL_ID
    );
    assert_eq!(
        capture.body["messages"][1]["tool_calls"][0]["function"]["arguments"],
        HISTORY_ARGUMENTS
    );
    assert_eq!(capture.body["messages"][2]["tool_call_id"], HISTORY_CALL_ID);
    assert_eq!(capture.body["messages"][2]["content"], "15");
}

fn assert_responses_initial_wire(capture: &Capture) {
    assert_eq!(capture.path, "/v1/responses");
    assert_eq!(capture.body["model"], RESPONSES_MODEL);
    assert_tool_declaration(&capture.body["tools"][0]);
    let input = capture.body["input"]
        .as_array()
        .expect("responses input array");
    assert!(input
        .iter()
        .any(|item| item["role"] == "user" && item.to_string().contains(REQUEST_MARKER)));
    assert!(input.iter().any(|item| item["type"] == "function_call"
        && item["call_id"] == HISTORY_CALL_ID
        && item["arguments"] == HISTORY_ARGUMENTS));
    assert!(input
        .iter()
        .any(|item| item["type"] == "function_call_output"
            && item["call_id"] == HISTORY_CALL_ID
            && item["output"] == "15"));
    assert!(!capture.body.to_string().contains("next_provider_key"));
    assert!(!capture.body.to_string().contains("diagnostic_source"));
}

fn assert_followup_wire(capture: &Capture) {
    assert_eq!(capture.path, "/v1/responses");
    assert_tool_declaration(&capture.body["tools"][0]);
    let input = capture.body["input"]
        .as_array()
        .expect("follow-up input array");
    assert!(input
        .iter()
        .any(|item| item["role"] == "user" && item.to_string().contains(REQUEST_MARKER)));
    assert!(input.iter().any(|item| item["type"] == "function_call"
        && item["call_id"] == HISTORY_CALL_ID
        && item["arguments"] == HISTORY_ARGUMENTS));
    assert!(input
        .iter()
        .any(|item| item["type"] == "function_call_output"
            && item["call_id"] == HISTORY_CALL_ID
            && item["output"] == "15"));
    assert!(input.iter().any(|item| item["type"] == "function_call"
        && item["call_id"] == NEW_CALL_ID
        && item["arguments"] == NEW_ARGUMENTS));
    assert!(input
        .iter()
        .any(|item| item["type"] == "function_call_output"
            && item["call_id"] == NEW_CALL_ID
            && item["output"] == "5"));
}

fn record_capture(label: &str, request_id: Option<&str>, port: u16, capture: &Capture) {
    let tool = if capture.body["tools"][0]["function"].is_object() {
        &capture.body["tools"][0]["function"]["name"]
    } else {
        &capture.body["tools"][0]["name"]
    };
    let call_ids = capture.body["input"]
        .as_array()
        .map(|input| {
            input
                .iter()
                .filter_map(|item| item["call_id"].as_str())
                .collect::<Vec<_>>()
        })
        .or_else(|| {
            capture.body["messages"].as_array().map(|messages| {
                messages
                    .iter()
                    .flat_map(|message| {
                        message["tool_calls"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|call| call["id"].as_str())
                    })
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_default();
    println!(
        "wire label={label}{} port={port} path={} model={} tool={} call_ids={call_ids:?} marker_present={}",
        request_id.map(|id| format!(" request_id={id}")).unwrap_or_default(),
        capture.path,
        capture.body["model"].as_str().unwrap_or_default(),
        tool.as_str().unwrap_or_default(),
        capture.body.to_string().contains(REQUEST_MARKER)
    );
}

fn decode_json_response(raw: &str) -> Value {
    serde_json::from_str(raw)
        .unwrap_or_else(|error| panic!("client JSON body: {error}; raw={raw:?}"))
}

fn request_dirs(port: u16) -> BTreeSet<String> {
    let path = PathBuf::from(std::env::var("HOME").unwrap())
        .join(".rcc")
        .join("codex-samples")
        .join("openai-responses")
        .join("ports")
        .join(port.to_string());
    std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect()
}

async fn wait_new_request_dir(port: u16, before: &BTreeSet<String>) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(request_id) = request_dirs(port).difference(before).next() {
            return request_id.clone();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "new request sample must appear"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn wait_failed_attempt(port: u16, request_id: &str) -> Value {
    let path = PathBuf::from(std::env::var("HOME").unwrap())
        .join(".rcc")
        .join("codex-samples")
        .join("openai-responses")
        .join("ports")
        .join(port.to_string())
        .join(request_id)
        .join(FAILED_ATTEMPT_FILE);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str(&raw) {
                return value;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "failed-attempt evidence {path:?} must appear"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn public_json_request(client: &reqwest::Client, endpoint: &str, body: Value) -> String {
    let response = tokio::time::timeout(
        Duration::from_secs(15),
        client.post(endpoint).json(&body).send(),
    )
    .await
    .expect("public request must finish")
    .expect("public client must receive its provider result");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    response.text().await.unwrap()
}

#[tokio::test]
async fn issue955d28d_relay_transport_failure_preserves_next_candidate_json_sse_and_controls() {
    let (_home, _lock) = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, FIXTURE_KEY);

    let chat_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let chat_port = chat_listener.local_addr().unwrap().port();
    let responses_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let responses_port = responses_listener.local_addr().unwrap().port();
    let decoy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let decoy_port = decoy_listener.local_addr().unwrap().port();
    let chat = Arc::new(ChatPeer::new());
    let responses = Arc::new(ResponsesPeer::new("responses"));
    let decoy = Arc::new(ResponsesPeer::new("decoy"));
    let chat_task = tokio::spawn(serve_chat(chat_listener, chat.clone()));
    let responses_task = tokio::spawn(serve_responses(responses_listener, responses.clone()));
    let decoy_task = tokio::spawn(serve_responses(decoy_listener, decoy.clone()));

    let handle = spawn_v3_server_aggregate(manifest(
        test_ports::free_port(),
        chat_port,
        responses_port,
        decoy_port,
        false,
    ))
    .await
    .unwrap();
    let port = handle.listeners[0].addr.port();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    // B-only control: the same public tool path must work without introducing A.
    let control_handle = spawn_v3_server_aggregate(manifest(
        test_ports::free_port(),
        chat_port,
        responses_port,
        decoy_port,
        true,
    ))
    .await
    .unwrap();
    let control_endpoint = format!("http://{}/v1/responses", control_handle.listeners[0].addr);
    let control_port = control_handle.listeners[0].addr.port();
    let control_request = initial_request(false);
    let control_body =
        public_json_request(&client, &control_endpoint, control_request.clone()).await;
    let control: Value = decode_json_response(&control_body);
    assert_eq!(control["output"][0]["call_id"], NEW_CALL_ID);
    assert_eq!(control["output"][0]["arguments"], NEW_ARGUMENTS);
    let control_output = execute_add(&control["output"][0]);
    assert_eq!(control_output, "5");
    let control_followup = public_json_request(
        &client,
        &control_endpoint,
        followup_request(&control_request, &control["output"][0], &control_output),
    )
    .await;
    let control_followup: Value = decode_json_response(&control_followup);
    assert_eq!(control_followup["output_text"], "add result received");
    let control_captures = responses.captures().await;
    assert_eq!(
        control_captures.len(),
        2,
        "B-only control must complete both turns"
    );
    assert_responses_initial_wire(&control_captures[0]);
    assert_followup_wire(&control_captures[1]);
    record_capture("b_only_initial", None, control_port, &control_captures[0]);
    record_capture("b_only_followup", None, control_port, &control_captures[1]);
    assert!(
        chat.captures().await.is_empty(),
        "B-only control must not reach A"
    );
    assert!(
        decoy.captures().await.is_empty(),
        "B-only control must not reach C"
    );
    control_handle.shutdown().await;

    for stream in [false, true] {
        chat.clear().await;
        responses.clear().await;
        decoy.clear().await;
        chat.set_behavior(ChatBehavior::PreHeadDrop).await;
        let before = request_dirs(port);
        let original = initial_request(stream);
        let body = public_json_request(&client, &endpoint, original.clone()).await;
        assert!(!body.contains("diagnostic_source") && !body.contains("switch_provider"));
        let response: Value = if stream {
            let event = body
                .lines()
                .filter_map(|line| line.strip_prefix("data: "))
                .filter(|data| *data != "[DONE]")
                .filter_map(|data| serde_json::from_str::<Value>(data).ok())
                .find(|event| event["type"] == "response.completed")
                .expect("client SSE completion");
            event["response"].clone()
        } else {
            decode_json_response(&body)
        };
        assert_eq!(response["output"][0]["call_id"], NEW_CALL_ID);
        let client_output = execute_add(&response["output"][0]);
        assert_eq!(client_output, "5");
        let request_id = wait_new_request_dir(port, &before).await;
        let evidence = wait_failed_attempt(port, &request_id).await;
        println!(
            "failure label=main_{} request_id={request_id} provider_id={} model_id={} auth_alias={} action={} next_provider_key={}",
            if stream { "sse" } else { "json" },
            evidence["attempts"][0]["provider_id"].as_str().unwrap_or_default(),
            evidence["attempts"][0]["model_id"].as_str().unwrap_or_default(),
            evidence["attempts"][0]["auth_alias"].as_str().unwrap_or_default(),
            evidence["attempts"][0]["action"].as_str().unwrap_or_default(),
            evidence["attempts"][0]["next_provider_key"].as_str().unwrap_or_default()
        );
        let attempt = &evidence["attempts"][0];
        assert_eq!(attempt["provider_id"], "multi");
        assert_eq!(attempt["model_id"], CHAT_MODEL);
        assert_eq!(attempt["auth_alias"], "key1");
        assert_eq!(attempt["action"], "switch_provider");
        assert_eq!(attempt["next_provider_key"], B_KEY);
        assert_eq!(attempt["provider_status"], Value::Null);

        let a = chat.captures().await;
        assert_eq!(a.len(), 1, "A must receive exactly one complete Chat wire");
        assert_chat_wire(&a[0]);
        let b = responses.captures().await;
        assert_eq!(
            b.len(),
            1,
            "B must receive the actual next wire; captures={b:?}"
        );
        assert_responses_initial_wire(&b[0]);
        record_capture(
            if stream {
                "main_sse_initial"
            } else {
                "main_json_initial"
            },
            Some(&request_id),
            port,
            &a[0],
        );
        record_capture(
            if stream {
                "main_sse_next"
            } else {
                "main_json_next"
            },
            Some(&request_id),
            port,
            &b[0],
        );
        assert!(
            decoy.captures().await.is_empty(),
            "the lower-priority C decoy must not receive the request"
        );

        let followup_body = public_json_request(
            &client,
            &endpoint,
            followup_request(&original, &response["output"][0], &client_output),
        )
        .await;
        let followup: Value = decode_json_response(&followup_body);
        assert_eq!(followup["output_text"], "add result received");
        let followup_captures = responses.captures().await;
        assert_eq!(followup_captures.len(), 2);
        let followup_capture = &followup_captures[1];
        assert_followup_wire(followup_capture);
        assert!(decoy.captures().await.is_empty());
        record_capture(
            if stream {
                "main_sse_followup"
            } else {
                "main_json_followup"
            },
            None,
            port,
            followup_capture,
        );
    }

    // A-healthy control: no transport failure means no switch to the sibling.
    chat.clear().await;
    responses.clear().await;
    decoy.clear().await;
    chat.set_behavior(ChatBehavior::Healthy).await;
    let healthy_body = public_json_request(&client, &endpoint, initial_request(false)).await;
    let healthy: Value = decode_json_response(&healthy_body);
    assert!(
        healthy.to_string().contains("healthy chat provider result"),
        "{healthy}"
    );
    record_capture("healthy_a_initial", None, port, &chat.captures().await[0]);
    assert_eq!(chat.captures().await.len(), 1);
    assert!(
        responses.captures().await.is_empty(),
        "healthy A must not switch to B"
    );
    assert!(
        decoy.captures().await.is_empty(),
        "healthy A must not switch to C"
    );

    handle.shutdown().await;
    chat_task.abort();
    responses_task.abort();
    decoy_task.abort();
    std::env::remove_var(KEY_ENV);
}
