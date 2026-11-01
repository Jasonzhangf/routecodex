use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

const NAMESPACE: &str = "mcp__codex_apps__codex_security_cloud";
const TOOL: &str = "_defense_factory_environments_search";
const CUSTOM: &str = "_defense_factory_environments_execute";
const COLLIDING_PLAIN_NAME: &str =
    "4d38cd95f8d6372ca282b6e42f30027fba935d6101a6373e0b8de162aead306b";
const COLLIDING_PLAIN_CUSTOM: &str =
    "80a662fbb9b3fbb362dcfcd35d46859f517a5ca297457df631b99265925f6296";
const SCHEMA_NAMESPACE: &str = "mcp__codex_apps__chatgpt_space";
const SCHEMA_TOOL: &str = "apply_page_changes";
const SCHEMA_WIRE_TOOL: &str = "mcp__codex_apps__chatgpt_space__apply_page_changes";
const SCHEMA_SEARCH_CALL_ID: &str = "call_replace_block_schema";
const SCHEMA_DISCOVERED_CALL_ID: &str = "call_apply_replace_block";
const SCHEMA_FINAL_TEXT: &str = "SCHEMA_REPLACE_BLOCK_COMPLETED";

static COUNTER_ENVIRONMENT: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct CounterEnvironment {
    _guard: std::sync::MutexGuard<'static, ()>,
    previous: Option<std::ffi::OsString>,
    previous_home: Option<std::ffi::OsString>,
    directory: std::path::PathBuf,
}

impl CounterEnvironment {
    fn new() -> Self {
        let guard = COUNTER_ENVIRONMENT.lock().unwrap();
        let directory = std::env::temp_dir().join(format!(
            "rcc-chat-names-{}-{}",
            std::process::id(),
            test_ports::free_port()
        ));
        std::fs::create_dir(&directory).unwrap();
        let previous = std::env::var_os("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &directory);
        std::env::set_var(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            directory.join("request-id-counter.json"),
        );
        Self {
            _guard: guard,
            previous,
            previous_home,
            directory,
        }
    }
}

impl Drop for CounterEnvironment {
    fn drop(&mut self) {
        if let Some(previous_home) = &self.previous_home {
            std::env::set_var("HOME", previous_home);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(previous) = &self.previous {
            std::env::set_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE", previous);
        } else {
            std::env::remove_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
        }
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

async fn strict_chat(
    State(captures): State<Arc<mpsc::UnboundedSender<Value>>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    captures.send(body.clone()).unwrap();
    let tools = body["tools"].as_array().unwrap();
    let names = tools
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap())
        .collect::<HashSet<_>>();
    if names.iter().any(|name| name.len() > 64) || names.len() != tools.len() {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"message":"invalid function name"}}"#,
            ))
            .unwrap();
    }
    assert_eq!(names.len(), tools.len(), "declarations must not collide");
    for message in body["messages"].as_array().unwrap() {
        for call in message["tool_calls"].as_array().into_iter().flatten() {
            assert!(
                names.contains(call["function"]["name"].as_str().unwrap()),
                "history must match declarations"
            );
        }
    }
    let selected = body
        .pointer("/tool_choice/function/name")
        .and_then(Value::as_str)
        .unwrap();
    assert!(
        names.contains(selected),
        "forced choice must match declarations"
    );
    let custom = tools
        .iter()
        .find(|tool| tool["function"]["description"] == "custom evaluator")
        .unwrap()["function"]["name"]
        .as_str()
        .unwrap();
    let followup = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["role"] == "tool" && message["content"] == "42");
    let message = if followup {
        json!({"role":"assistant","content":"42"})
    } else {
        let mut message = json!({"role":"assistant","content":null,"tool_calls":[
            {"id":"call_math","type":"function","function":{"name":selected,"arguments":"{\"a\":19,\"b\":23}"}},
            {"id":"call_custom","type":"function","function":{"name":custom,"arguments":"{\"input\":\"19+23\"}"}}
        ]});
        if tools
            .iter()
            .any(|tool| tool["function"]["description"] == "plain evaluator")
        {
            message["tool_calls"].as_array_mut().unwrap().push(json!({
                "id":"call_plain","type":"function",
                "function":{"name":COLLIDING_PLAIN_NAME,"arguments":"{\"a\":20,\"b\":22}"}
            }));
            message["tool_calls"].as_array_mut().unwrap().push(json!({
                "id":"call_plain_custom","type":"function",
                "function":{"name":COLLIDING_PLAIN_CUSTOM,"arguments":"{\"input\":\"20+22\"}"}
            }));
        }
        message
    };
    let finish = if followup { "stop" } else { "tool_calls" };
    if body["stream"] == true {
        let chunk = json!({"id":"chatcmpl-name","object":"chat.completion.chunk","model":"wire-model","choices":[{"index":0,"delta":message,"finish_reason":finish}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}});
        return Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(format!("data: {chunk}\n\ndata: [DONE]\n\n")))
            .unwrap();
    }
    Response::builder().header("content-type", "application/json").body(Body::from(json!({"id":"chatcmpl-name","object":"chat.completion","model":"wire-model","choices":[{"index":0,"message":message,"finish_reason":finish}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}).to_string())).unwrap()
}

struct SchemaChatFixture {
    attempts: AtomicUsize,
    events: mpsc::UnboundedSender<Result<Value, String>>,
}

fn schema_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "changes": {
                "type": "array",
                "items": {"$ref": "#/$defs/_ReplaceBlock"}
            }
        },
        "$defs": {
            "_ReplaceBlock": {
                "type": "object",
                "properties": {
                    "block_id": {"type": "string"},
                    "operation": {"type": "string", "enum": ["replace"]},
                    "content": {"type": "string"}
                },
                "required": ["block_id", "operation", "content"],
                "additionalProperties": false
            }
        },
        "required": ["changes"],
        "additionalProperties": false
    })
}

fn schema_tools() -> Value {
    json!([{
        "type": "namespace",
        "name": SCHEMA_NAMESPACE,
        "tools": [{
            "type": "function",
            "name": SCHEMA_TOOL,
            "parameters": schema_parameters()
        }]
    }])
}

fn schema_request(stream: bool) -> Value {
    json!({
        "model": "name-client",
        "stream": stream,
        "input": [
            {"role": "user", "content": "Find the page editing tool."},
            {
                "type": "tool_search_call",
                "call_id": SCHEMA_SEARCH_CALL_ID,
                "execution": "client",
                "arguments": {"query": "replace block"}
            },
            {
                "type": "tool_search_output",
                "id": "tso_replace_block_schema",
                "call_id": SCHEMA_SEARCH_CALL_ID,
                "status": "completed",
                "execution": "client",
                "tools": schema_tools()
            },
            {"role": "user", "content": "Continue with the discovered tool."}
        ]
    })
}

fn schema_arguments() -> Value {
    json!({
        "changes": [{
            "block_id": "block_1",
            "operation": "replace",
            "content": "Schema round trip verified"
        }]
    })
}

fn schema_tool_output() -> Value {
    json!({
        "block_id": "block_1",
        "operation": "replace",
        "content": "Schema round trip verified",
        "status": "replaced"
    })
}

fn schema_messages(body: &Value) -> Result<&[Value], String> {
    body["messages"]
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| format!("provider messages must be an array: {body}"))
}

fn validate_schema_declaration(body: &Value) -> Result<(), String> {
    let tools = body["tools"]
        .as_array()
        .ok_or_else(|| format!("provider tools must be an array: {body}"))?;
    let declarations = tools
        .iter()
        .filter(|tool| {
            tool.pointer("/function/name").and_then(Value::as_str) == Some(SCHEMA_WIRE_TOOL)
        })
        .collect::<Vec<_>>();
    if declarations.len() != 1 {
        return Err(format!(
            "expected one promoted {SCHEMA_WIRE_TOOL} declaration, found {}: {body}",
            declarations.len()
        ));
    }
    let declaration = declarations[0];
    if declaration["type"] != "function" {
        return Err(format!(
            "promoted discovered tool must be a function declaration: {declaration}"
        ));
    }
    let parameters = &declaration["function"]["parameters"];
    if parameters != &schema_parameters() {
        return Err(format!(
            "promoted declaration changed the complete schema: {parameters}"
        ));
    }
    Ok(())
}

fn schema_tool_pair(
    body: &Value,
    call_id: &str,
    expected_name: &str,
) -> Result<(Value, Value), String> {
    let messages = schema_messages(body)?;
    let calls = messages
        .iter()
        .enumerate()
        .flat_map(|(message_index, message)| {
            message["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(move |call| call["id"] == call_id)
                .map(move |call| (message_index, call))
        })
        .collect::<Vec<_>>();
    if calls.len() != 1 {
        return Err(format!(
            "expected one {call_id} assistant tool call, found {}: {body}",
            calls.len()
        ));
    }
    let (call_index, call) = calls[0];
    if messages[call_index]["role"] != "assistant" {
        return Err(format!(
            "{call_id} tool call must be carried by an assistant message: {body}"
        ));
    }
    if call["type"] != "function" {
        return Err(format!(
            "{call_id} matched tool call must have type function: {call}"
        ));
    }
    let name = call["function"]["name"]
        .as_str()
        .ok_or_else(|| format!("{call_id} call name must be a string: {call}"))?;
    if name != expected_name {
        return Err(format!(
            "{call_id} call name changed from {expected_name}: {call}"
        ));
    }
    let arguments = call["function"]["arguments"]
        .as_str()
        .ok_or_else(|| format!("{call_id} arguments must be JSON text: {call}"))
        .and_then(|arguments| {
            serde_json::from_str(arguments)
                .map_err(|error| format!("{call_id} arguments are invalid JSON: {error}"))
        })?;
    let outputs = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message["role"] == "tool" && message["tool_call_id"] == call_id)
        .collect::<Vec<_>>();
    if outputs.len() != 1 {
        return Err(format!(
            "expected one paired result for {call_id}, found {}: {body}",
            outputs.len()
        ));
    }
    let (output_index, output) = outputs[0];
    if output_index != call_index + 1 {
        return Err(format!(
            "{call_id} result must immediately follow its assistant call: {body}"
        ));
    }
    let output = output["content"]
        .as_str()
        .ok_or_else(|| format!("{call_id} result must preserve text content: {output}"))
        .and_then(|content| {
            serde_json::from_str(content)
                .map_err(|error| format!("{call_id} result is invalid JSON: {error}: {content}"))
        })?;
    Ok((arguments, output))
}

fn validate_schema_search_history(body: &Value) -> Result<(), String> {
    let (arguments, catalog) = schema_tool_pair(body, SCHEMA_SEARCH_CALL_ID, "tool_search")?;
    if arguments != json!({"query": "replace block"}) {
        return Err(format!(
            "tool-search call arguments changed on the provider wire: {arguments}"
        ));
    }
    if catalog != schema_tools() {
        return Err(format!(
            "complete tool-search catalog changed on the provider wire: {catalog}"
        ));
    }
    Ok(())
}

fn validate_schema_first_provider_request(body: &Value) -> Result<(), String> {
    validate_schema_declaration(body)?;
    validate_schema_search_history(body)?;
    if body.to_string().contains(SCHEMA_DISCOVERED_CALL_ID) {
        return Err("first provider request already contained the discovered call".to_string());
    }
    Ok(())
}

fn validate_schema_followup_provider_request(body: &Value) -> Result<(), String> {
    validate_schema_declaration(body)?;
    validate_schema_search_history(body)?;
    let (arguments, output) = schema_tool_pair(body, SCHEMA_DISCOVERED_CALL_ID, SCHEMA_WIRE_TOOL)?;
    if arguments != schema_arguments() {
        return Err(format!(
            "discovered call arguments changed in follow-up history: {arguments}"
        ));
    }
    if output != schema_tool_output() {
        return Err(format!(
            "matching discovered call result changed in follow-up history: {output}"
        ));
    }
    Ok(())
}

async fn schema_chat(
    State(fixture): State<Arc<SchemaChatFixture>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let attempt = fixture.attempts.fetch_add(1, Ordering::SeqCst) + 1;
    let validation = if attempt % 2 == 1 {
        validate_schema_first_provider_request(&body)
    } else {
        validate_schema_followup_provider_request(&body)
    };
    if let Err(reason) = validation {
        let reason = format!("provider attempt {attempt} rejected: {reason}");
        let _ = fixture.events.send(Err(reason.clone()));
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error": {"message": reason}}).to_string(),
            ))
            .unwrap();
    }
    let _ = fixture.events.send(Ok(body.clone()));
    let message = if attempt % 2 == 1 {
        json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": SCHEMA_DISCOVERED_CALL_ID,
                "type": "function",
                "function": {
                    "name": SCHEMA_WIRE_TOOL,
                    "arguments": schema_arguments().to_string()
                }
            }]
        })
    } else {
        json!({"role": "assistant", "content": SCHEMA_FINAL_TEXT})
    };
    let finish = if attempt % 2 == 1 {
        "tool_calls"
    } else {
        "stop"
    };
    let usage = json!({"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5});
    if body["stream"] == true {
        let chunk = json!({
            "id": "chatcmpl-schema",
            "object": "chat.completion.chunk",
            "model": "wire-model",
            "choices": [{"index": 0, "delta": message, "finish_reason": finish}],
            "usage": usage
        });
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(format!("data: {chunk}\n\ndata: [DONE]\n\n")))
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "chatcmpl-schema",
                "object": "chat.completion",
                "model": "wire-model",
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": usage
            })
            .to_string(),
        ))
        .unwrap()
}

async fn receive_schema_provider_request(
    rx: &mut mpsc::UnboundedReceiver<Result<Value, String>>,
) -> Result<Value, String> {
    let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .map_err(|_| "the controlled upstream did not receive the provider attempt".to_string())?
        .ok_or_else(|| "the provider capture closed unexpectedly".to_string())?;
    event
}

fn execute_replace_block_call(call: &Value) -> Result<String, String> {
    if call["type"] != "function_call" {
        return Err(format!("discovered tool call type changed: {call}"));
    }
    if call["call_id"] != SCHEMA_DISCOVERED_CALL_ID {
        return Err(format!("discovered tool call id changed: {call}"));
    }
    if call["name"] != SCHEMA_TOOL {
        return Err(format!("discovered tool leaf name changed: {call}"));
    }
    if call["namespace"] != SCHEMA_NAMESPACE {
        return Err(format!("discovered tool namespace changed: {call}"));
    }
    let arguments: Value = serde_json::from_str(
        call["arguments"]
            .as_str()
            .ok_or_else(|| format!("discovered call arguments must be JSON text: {call}"))?,
    )
    .map_err(|error| format!("discovered call arguments are invalid JSON: {error}"))?;
    if arguments != schema_arguments() {
        return Err(format!(
            "the client did not receive the complete discovered call arguments: {arguments}"
        ));
    }
    let change = &arguments["changes"][0];
    let mut blocks = BTreeMap::new();
    blocks.insert(
        change["block_id"]
            .as_str()
            .ok_or_else(|| format!("replacement block_id must be text: {change}"))?
            .to_string(),
        change["content"]
            .as_str()
            .ok_or_else(|| format!("replacement content must be text: {change}"))?
            .to_string(),
    );
    if blocks.get("block_1").map(String::as_str) != Some("Schema round trip verified") {
        return Err("the safe local consumer did not apply the requested replacement".to_string());
    }
    Ok(schema_tool_output().to_string())
}

fn request(stream: bool, collision: bool) -> Value {
    let mut request = json!({"model":"name-client","stream":stream,"input":[{"role":"user","content":"calculate"}],
        "tools":[
            {"type":"namespace","name":"n","tools":[
                {"type":"function","name":"a".repeat(61),"parameters":{"type":"object","properties":{}}},
                {"type":"function","name":"a".repeat(62),"parameters":{"type":"object","properties":{}}}
            ]},
            {"type":"namespace","name":NAMESPACE,"tools":[
                {"type":"function","name":TOOL,"description":"math evaluator","parameters":{"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"integer"}},"required":["a","b"],"additionalProperties":false}},
                {"type":"function","name":format!("{TOOL}_other"),"description":"same prefix","parameters":{"type":"object","properties":{}}},
                {"type":"custom","name":CUSTOM,"description":"custom evaluator","format":{"type":"text"}}
            ]}
        ],"tool_choice":{"type":"function","name":format!("{NAMESPACE}.{TOOL}")}});
    if collision {
        request["tools"].as_array_mut().unwrap().push(json!({
            "type":"function","name":COLLIDING_PLAIN_NAME,"description":"plain evaluator",
            "parameters":{"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"integer"}},"required":["a","b"],"additionalProperties":false}
        }));
        request["tools"].as_array_mut().unwrap().push(json!({
            "type":"custom","name":COLLIDING_PLAIN_CUSTOM,"description":"plain custom evaluator",
            "format":{"type":"text"}
        }));
    }
    request
}

async fn response_body(response: reqwest::Response, stream: bool) -> Value {
    assert_eq!(response.status(), StatusCode::OK);
    let text = response
        .text()
        .await
        .expect("first provider attempt must be accepted");
    if !stream {
        return serde_json::from_str(&text).unwrap();
    }
    let events = text
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .collect::<Vec<_>>();
    assert!(!events
        .iter()
        .any(|event| matches!(event["type"].as_str(), Some("error" | "response.failed"))));
    events
        .into_iter()
        .find(|event| event["type"] == "response.completed")
        .expect("a real completed event")["response"]
        .clone()
}

#[derive(Clone)]
struct ShellDispatchFixture {
    events: Arc<mpsc::UnboundedSender<Result<(usize, Value), String>>>,
    arguments: Arc<String>,
    attempts: Arc<AtomicUsize>,
}

async fn shell_dispatch_chat(
    State(fixture): State<ShellDispatchFixture>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let attempt = fixture.attempts.fetch_add(1, Ordering::SeqCst) + 1;
    let validation = validate_shell_provider_attempt(&body, attempt, &fixture.arguments);
    if let Err(reason) = validation {
        let _ = fixture.events.send(Err(reason.clone()));
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error": {"message": reason}}).to_string(),
            ))
            .unwrap();
    }
    let _ = fixture.events.send(Ok((attempt, body.clone())));
    let followup = attempt == 2;
    let message = if followup {
        json!({"role":"assistant","content":"SHELL_DISPATCH_DONE"})
    } else {
        let tool_name = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == "functions__exec_command")
            .unwrap()["function"]["name"]
            .as_str()
            .unwrap();
        json!({"role":"assistant","content":null,"tool_calls":[{
            "id":"call_shell_dispatch",
            "type":"function",
            "function":{"name":tool_name,"arguments":fixture.arguments.as_str()}
        }]})
    };
    let finish = if followup { "stop" } else { "tool_calls" };
    let usage = json!({"prompt_tokens":2,"completion_tokens":3,"total_tokens":5});
    if body["stream"] == true {
        let chunk = json!({"id":"chatcmpl-shell","object":"chat.completion.chunk","model":"wire-model","choices":[{"index":0,"delta":message,"finish_reason":finish}],"usage":usage});
        return Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(format!("data: {chunk}\n\ndata: [DONE]\n\n")))
            .unwrap();
    }
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"id":"chatcmpl-shell","object":"chat.completion","model":"wire-model","choices":[{"index":0,"message":message,"finish_reason":finish}],"usage":usage})
                .to_string(),
        ))
        .unwrap()
}

fn validate_shell_provider_attempt(
    body: &Value,
    attempt: usize,
    arguments: &str,
) -> Result<(), String> {
    if !matches!(attempt, 1 | 2) {
        return Err(format!(
            "provider attempt {attempt} is a retry or switch around the failed roundtrip"
        ));
    }
    let tools = body["tools"]
        .as_array()
        .ok_or_else(|| format!("provider tools must be an array: {body}"))?;
    let declarations = tools
        .iter()
        .filter(|tool| tool["function"]["name"] == "functions__exec_command")
        .collect::<Vec<_>>();
    if declarations.len() != 1 {
        return Err(format!(
            "provider attempt {attempt} lost the declared functions__exec_command tool: {body}"
        ));
    }
    if attempt == 1 {
        if body.to_string().contains("call_shell_dispatch") {
            return Err(format!(
                "first provider attempt unexpectedly contains shell history: {body}"
            ));
        }
        return Ok(());
    }
    let messages = body["messages"]
        .as_array()
        .ok_or_else(|| format!("follow-up messages must be an array: {body}"))?;
    let calls = messages
        .iter()
        .enumerate()
        .flat_map(|(message_index, message)| {
            message["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(move |call| call["id"] == "call_shell_dispatch")
                .map(move |call| (message_index, call))
        })
        .collect::<Vec<_>>();
    let [(call_index, call)] = calls.as_slice() else {
        return Err(format!(
            "provider attempt 2 must contain exactly one shell call, found {}: {body}",
            calls.len()
        ));
    };
    if call["function"]["name"] != "functions__exec_command" {
        return Err(format!(
            "provider attempt 2 changed shell history identity: {call}"
        ));
    }
    if call["function"]["arguments"] != arguments {
        return Err(format!(
            "provider attempt 2 changed shell arguments: {call}"
        ));
    }
    let outputs = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            message["role"] == "tool" && message["tool_call_id"] == "call_shell_dispatch"
        })
        .collect::<Vec<_>>();
    let [(output_index, output)] = outputs.as_slice() else {
        return Err(format!(
            "provider attempt 2 must contain exactly one paired shell output: {body}"
        ));
    };
    if *output_index != call_index + 1 {
        return Err(format!(
            "provider attempt 2 did not keep the shell output adjacent to its call: {body}"
        ));
    }
    if output["content"] != "SHELL_MARKER_WRITTEN" {
        return Err(format!(
            "provider attempt 2 changed the marker readback: {output}"
        ));
    }
    Ok(())
}

struct ShellMarker {
    directory: std::path::PathBuf,
    path: std::path::PathBuf,
    value: String,
}

impl ShellMarker {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "rcc-shell-dispatch-{}-{}",
            std::process::id(),
            test_ports::free_port()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("marker.txt");
        let value = "SHELL_MARKER_WRITTEN".to_string();
        Self {
            directory,
            path,
            value,
        }
    }

    fn command(&self) -> String {
        format!("printf '%s' '{}' > '{}'", self.value, self.path.display())
    }
}

impl Drop for ShellMarker {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

async fn receive_shell_provider_attempt(
    rx: &mut mpsc::UnboundedReceiver<Result<(usize, Value), String>>,
) -> Result<(usize, Value), String> {
    tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .map_err(|_| "the controlled upstream did not validate a provider attempt".to_string())?
        .ok_or_else(|| "the controlled upstream capture closed unexpectedly".to_string())?
}

async fn run_namespace_shell_dispatch(stream: bool) {
    let marker = ShellMarker::new();
    let arguments = format!(
        r#"{{ "max_output_tokens" : 4096, "cmd" : "{}", "yield_time_ms" : 321 }}"#,
        marker.command()
    );
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let attempts = Arc::new(AtomicUsize::new(0));
    let fixture = ShellDispatchFixture {
        events: Arc::new(tx),
        arguments: Arc::new(arguments.clone()),
        attempts: attempts.clone(),
    };
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(shell_dispatch_chat))
        .with_state(fixture);
    let upstream_task = tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let tool = json!({
        "type":"namespace",
        "name":"functions",
        "tools":[{
            "type":"function",
            "name":"exec_command",
            "description":"Runs a namespace-declared shell command.",
            "parameters":{
                "type":"object",
                "properties":{
                    "cmd":{"type":"string"},
                    "yield_time_ms":{"type":"integer"},
                    "max_output_tokens":{"type":"integer"}
                },
                "required":["cmd"],
                "additionalProperties":false
            },
            "strict":false
        }]
    });
    let mut request = json!({
        "model":"name-client",
        "stream":stream,
        "input":[{"role":"user","content":"use the declared shell tool"}],
        "tools":[tool],
        "tool_choice":{"type":"function","name":"functions.exec_command"}
    });
    let first_send = client.post(&endpoint).json(&request).send();
    let (first_response, first_capture) =
        tokio::join!(first_send, receive_shell_provider_attempt(&mut rx));
    let (_, first_wire) =
        first_capture.expect("the first provider request must pass strict validation");
    let first = response_body(
        first_response.expect("the controlled first provider attempt must be accepted"),
        stream,
    )
    .await;
    let call = first["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["call_id"] == "call_shell_dispatch")
        .expect("the client must receive the shell call");
    assert_eq!(call["type"], "function_call");
    assert_eq!(call["namespace"], "functions");
    assert_eq!(call["name"], "exec_command");
    assert_eq!(call["arguments"], arguments);

    assert_eq!(first_wire["tools"].as_array().unwrap().len(), 1);
    assert_eq!(
        first_wire["tools"][0]["function"]["name"],
        "functions__exec_command"
    );
    assert_eq!(
        first_wire["tool_choice"]["function"]["name"],
        "functions__exec_command"
    );

    let parsed_arguments: Value =
        serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
    let executed = std::process::Command::new("/bin/sh")
        .args(["-c", parsed_arguments["cmd"].as_str().unwrap()])
        .output()
        .expect("the client shell consumer must start");
    assert!(
        executed.status.success(),
        "client shell consumer failed: {executed:?}"
    );
    assert_eq!(std::fs::read_to_string(&marker.path).unwrap(), marker.value);

    request["input"].as_array_mut().unwrap().push(json!({
        "type":"function_call",
        "name":"exec_command",
        "call_id":"call_shell_dispatch",
        "arguments": arguments.clone()
    }));
    request["input"].as_array_mut().unwrap().push(json!({
        "type":"function_call_output",
        "call_id":"call_shell_dispatch",
        "output":marker.value.clone()
    }));
    let followup_send = client.post(&endpoint).json(&request).send();
    let (followup_response, followup_capture) =
        tokio::join!(followup_send, receive_shell_provider_attempt(&mut rx));
    let (attempt, followup_wire) = followup_capture
        .unwrap_or_else(|reason| panic!("the paired follow-up failed strict validation: {reason}"));
    assert_eq!(attempt, 2);
    let followup = response_body(
        followup_response.expect("the paired follow-up must reach the provider"),
        stream,
    )
    .await;
    assert_eq!(followup["status"], "completed");
    assert_eq!(
        followup["output"][0]["content"][0]["text"],
        "SHELL_DISPATCH_DONE"
    );

    assert_eq!(followup_wire["tools"], first_wire["tools"]);
    let history_call = followup_wire["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["tool_calls"].as_array().into_iter().flatten())
        .find(|item| item["id"] == "call_shell_dispatch")
        .expect("paired history must retain the shell call");
    assert_eq!(history_call["function"]["name"], "functions__exec_command");
    assert_eq!(history_call["function"]["arguments"], arguments);
    assert!(followup_wire["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["role"] == "tool"
            && message["tool_call_id"] == "call_shell_dispatch"
            && message["content"] == "SHELL_MARKER_WRITTEN"));
    handle.shutdown().await;
    let _ = shutdown_tx.send(());
    upstream_task.await.unwrap();
    assert_eq!(
        attempts.load(Ordering::SeqCst),
        2,
        "the roundtrip must use exactly two provider attempts"
    );
}

#[tokio::test]
async fn responses_namespace_shell_dispatch_roundtrip_json_sse() {
    let _counter_environment = CounterEnvironment::new();
    std::env::set_var("V3_CHAT_NAME_TEST_KEY", "fixture-key");
    for stream in [false, true] {
        run_namespace_shell_dispatch(stream).await;
    }
    std::env::remove_var("V3_CHAT_NAME_TEST_KEY");
}

struct CustomLeafHistoryFixture {
    captures: mpsc::UnboundedSender<Result<Value, String>>,
}

fn validate_custom_leaf_history(body: &Value) -> Result<(), String> {
    let tools = body["tools"]
        .as_array()
        .ok_or_else(|| format!("provider tools must be an array: {body}"))?;
    let indexed_tools = tools.iter().enumerate().collect::<Vec<_>>();
    let [(tool_index, tool)] = indexed_tools.as_slice() else {
        return Err(format!(
            "custom leaf history must expose exactly one declaration: {body}"
        ));
    };
    let name = tool["function"]["name"]
        .as_str()
        .ok_or_else(|| format!("custom leaf declaration must have a name: {tool}"))?;
    if *tool_index != 0 || name != "functions__apply_patch" {
        return Err(format!(
            "custom leaf declaration lost its namespace identity: {tool}"
        ));
    }
    let messages = body["messages"]
        .as_array()
        .ok_or_else(|| format!("provider messages must be an array: {body}"))?;
    let calls = messages
        .iter()
        .enumerate()
        .flat_map(|(index, message)| {
            message["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
                .map(move |call| (index, call))
        })
        .filter(|(_, call)| call["id"] == "call_custom_leaf")
        .collect::<Vec<_>>();
    let [(call_index, call)] = calls.as_slice() else {
        return Err(format!(
            "custom leaf history must contain exactly one call: {body}"
        ));
    };
    if *call_index != 1
        || call["function"]["name"] != "functions__apply_patch"
        || call["function"]["arguments"] != r#"{"input":"patch"}"#
    {
        return Err(format!(
            "custom leaf history changed identity or arguments: {call}"
        ));
    }
    let outputs = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            message["role"] == "tool" && message["tool_call_id"] == "call_custom_leaf"
        })
        .collect::<Vec<_>>();
    let [(output_index, output)] = outputs.as_slice() else {
        return Err(format!(
            "custom leaf history must contain exactly one paired output: {body}"
        ));
    };
    if *output_index != call_index + 1 || output["content"] != "patch applied" {
        return Err(format!(
            "custom leaf history changed or separated its paired output: {output}"
        ));
    }
    Ok(())
}

async fn custom_leaf_history_chat(
    State(fixture): State<Arc<CustomLeafHistoryFixture>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    if body
        .get("tools")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty)
    {
        return Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "id":"chatcmpl-probe",
                    "object":"chat.completion",
                    "model":"wire-model",
                    "choices":[{
                        "index":0,
                        "message":{"role":"assistant","content":"probe"},
                        "finish_reason":"stop"
                    }]
                })
                .to_string(),
            ))
            .unwrap();
    }
    if let Err(reason) = validate_custom_leaf_history(&body) {
        let _ = fixture.captures.send(Err(reason.clone()));
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(json!({"error":{"message":reason}}).to_string()))
            .unwrap();
    }
    let _ = fixture.captures.send(Ok(body.clone()));
    let message = json!({"role":"assistant","content":"CUSTOM_LEAF_HISTORY_DONE"});
    let usage = json!({"prompt_tokens":2,"completion_tokens":3,"total_tokens":5});
    if body["stream"] == true {
        let chunk = json!({
            "id":"chatcmpl-custom-leaf",
            "object":"chat.completion.chunk",
            "model":"wire-model",
            "choices":[{"index":0,"delta":message,"finish_reason":"stop"}],
            "usage":usage
        });
        return Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(format!("data: {chunk}\n\ndata: [DONE]\n\n")))
            .unwrap();
    }
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id":"chatcmpl-custom-leaf",
                "object":"chat.completion",
                "model":"wire-model",
                "choices":[{"index":0,"message":message,"finish_reason":"stop"}],
                "usage":usage
            })
            .to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn responses_custom_leaf_history_keeps_kind_json_sse() {
    let _counter_environment = CounterEnvironment::new();
    std::env::set_var("V3_CHAT_NAME_TEST_KEY", "fixture-key");
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (capture_tx, mut capture_rx) = mpsc::unbounded_channel();
    let fixture = Arc::new(CustomLeafHistoryFixture {
        captures: capture_tx,
    });
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(custom_leaf_history_chat))
        .with_state(fixture);
    let upstream_task = tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap();
    for stream in [false, true] {
        let request = json!({
            "model":"name-client",
            "stream":stream,
            "input":[
                {"role":"user","content":"apply the patch"},
                {
                    "type":"custom_tool_call",
                    "call_id":"call_custom_leaf",
                    "name":"apply_patch",
                    "input":"patch"
                },
                {
                    "type":"custom_tool_call_output",
                    "call_id":"call_custom_leaf",
                    "output":"patch applied"
                },
                {"role":"user","content":"continue"}
            ],
            "tools":[{
                "type":"namespace",
                "name":"functions",
                "tools":[{
                    "type":"custom",
                    "name":"apply_patch",
                    "description":"Patches a workspace file.",
                    "format":{"type":"text"}
                }]
            }]
        });
        let response = client.post(&endpoint).json(&request).send().await.unwrap();
        let completed = read_recovery_response(response, stream).await.unwrap();
        assert_eq!(completed["status"], "completed");
        assert!(completed.to_string().contains("CUSTOM_LEAF_HISTORY_DONE"));
        let provider = tokio::time::timeout(Duration::from_secs(2), capture_rx.recv())
            .await
            .expect("the provider attempt must complete")
            .expect("the provider capture must stay open");
        provider.unwrap_or_else(|reason| panic!("custom leaf history failed: {reason}"));
    }
    handle.shutdown().await;
    let _ = shutdown_tx.send(());
    upstream_task.await.unwrap();
    std::env::remove_var("V3_CHAT_NAME_TEST_KEY");
}

#[tokio::test]
async fn responses_chat_long_namespace_names_round_trip_on_first_attempt_json_and_sse() {
    let _counter_environment = CounterEnvironment::new();
    std::env::set_var("V3_CHAT_NAME_TEST_KEY", "fixture-key");
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(strict_chat))
        .with_state(Arc::new(tx));
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    for (stream, collision) in [(false, false), (true, false), (false, true), (true, true)] {
        let mut input = request(stream, collision);
        let first_response = client.post(&endpoint).json(&input).send().await;
        assert!(
            first_response.is_ok(),
            "strict provider must accept the first request: {first_response:?}; captured: {:?}",
            rx.try_recv()
        );
        let first = response_body(first_response.unwrap(), stream).await;
        let output = first["output"].as_array().unwrap();
        let call = output
            .iter()
            .find(|item| item["type"] == "function_call")
            .unwrap();
        assert_eq!(call["namespace"], NAMESPACE);
        assert_eq!(call["name"], TOOL);
        assert_eq!(call["call_id"], "call_math");
        let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
        let result = args["a"].as_i64().unwrap() + args["b"].as_i64().unwrap();
        assert_eq!(result, 42);
        let custom = output
            .iter()
            .find(|item| item["type"] == "custom_tool_call")
            .unwrap();
        assert_eq!(custom["namespace"], NAMESPACE);
        assert_eq!(custom["name"], CUSTOM);
        assert_eq!(custom["input"], "19+23");
        assert_eq!(custom["call_id"], "call_custom");
        let plain_output = if collision {
            let plain = output
                .iter()
                .find(|item| item["call_id"] == "call_plain")
                .unwrap();
            assert_eq!(plain["type"], "function_call");
            assert_eq!(plain["name"], COLLIDING_PLAIN_NAME);
            assert!(plain.get("namespace").is_none());
            let args: Value = serde_json::from_str(plain["arguments"].as_str().unwrap()).unwrap();
            let value = args["a"].as_i64().unwrap() + args["b"].as_i64().unwrap();
            assert_eq!(value, 42);
            let plain_custom = output
                .iter()
                .find(|item| item["call_id"] == "call_plain_custom")
                .unwrap();
            assert_eq!(plain_custom["type"], "custom_tool_call");
            assert_eq!(plain_custom["name"], COLLIDING_PLAIN_CUSTOM);
            assert!(plain_custom.get("namespace").is_none());
            let operands = plain_custom["input"]
                .as_str()
                .unwrap()
                .split('+')
                .map(|value| value.parse::<i64>().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(operands.iter().sum::<i64>(), 42);
            Some(
                json!({"type":"function_call_output","call_id":"call_plain","output":value.to_string()}),
            )
        } else {
            None
        };
        let first_wire = rx.recv().await.unwrap();
        assert_eq!(
            first_wire["tools"].as_array().unwrap().len(),
            if collision { 7 } else { 5 }
        );
        if collision {
            assert_eq!(
                first_wire["tools"][5]["function"]["name"],
                COLLIDING_PLAIN_NAME
            );
            assert_ne!(
                first_wire["tools"][2]["function"]["name"],
                COLLIDING_PLAIN_NAME
            );
            assert_eq!(
                first_wire["tools"][6]["function"]["name"],
                COLLIDING_PLAIN_CUSTOM
            );
            assert_ne!(
                first_wire["tools"][4]["function"]["name"],
                COLLIDING_PLAIN_CUSTOM
            );
        }
        assert_eq!(
            first_wire["tools"][0]["function"]["name"],
            format!("n__{}", "a".repeat(61))
        );
        assert_eq!(
            first_wire["tools"][0]["function"]["name"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        assert_eq!(
            first_wire["tools"][2]["function"]["parameters"],
            input["tools"][1]["tools"][0]["parameters"]
        );
        let history = input["input"].as_array_mut().unwrap();
        history.extend(
            output
                .iter()
                .filter(|item| {
                    matches!(
                        item["type"].as_str(),
                        Some("function_call" | "custom_tool_call")
                    )
                })
                .cloned(),
        );
        history.push(json!({"type":"function_call_output","call_id":"call_math","output":result.to_string()}));
        history
            .push(json!({"type":"custom_tool_call_output","call_id":"call_custom","output":"42"}));
        if let Some(plain_output) = plain_output {
            history.push(plain_output);
            history.push(json!({"type":"custom_tool_call_output","call_id":"call_plain_custom","output":"42"}));
        }
        let followup = response_body(
            client.post(&endpoint).json(&input).send().await.unwrap(),
            stream,
        )
        .await;
        assert_eq!(followup["status"], "completed");
        assert!(followup.to_string().contains("42"));
        let followup_wire = rx.recv().await.unwrap();
        assert_eq!(followup_wire["tools"], first_wire["tools"]);
        assert!(
            rx.try_recv().is_err(),
            "no switching or additional attempts may conceal shape failure"
        );
    }
    handle.shutdown().await;
    shutdown_tx.send(()).unwrap();
    std::env::remove_var("V3_CHAT_NAME_TEST_KEY");
}

#[tokio::test]
async fn responses_tool_search_output_preserves_replace_block_schema_on_first_provider_attempt() {
    let _counter_environment = CounterEnvironment::new();
    std::env::set_var("V3_CHAT_NAME_TEST_KEY", "fixture-key");
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let fixture = Arc::new(SchemaChatFixture {
        attempts: AtomicUsize::new(0),
        events: tx,
    });
    let upstream_fixture = fixture.clone();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let upstream_task = tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new()
                .route("/v1/chat/completions", post(schema_chat))
                .with_state(upstream_fixture),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await
        .unwrap();
    });
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let outcome: Result<(), String> = async {
        for (case_index, stream) in [false, true].into_iter().enumerate() {
            let attempts = fixture.attempts.load(Ordering::SeqCst);
            if attempts != case_index * 2 {
                return Err(format!(
                    "previous JSON/SSE case ended with {attempts} provider attempts, expected {}",
                    case_index * 2
                ));
            }
            let mut request = schema_request(stream);
            let first_response = client.post(&endpoint).json(&request).send().await;
            let first_wire = receive_schema_provider_request(&mut rx).await?;
            let attempts = fixture.attempts.load(Ordering::SeqCst);
            if attempts != case_index * 2 + 1 {
                return Err(format!(
                    "the first client request produced {attempts} provider attempts, expected {}",
                    case_index * 2 + 1
                ));
            }
            let (_, catalog) = schema_tool_pair(&first_wire, SCHEMA_SEARCH_CALL_ID, "tool_search")?;
            if catalog != schema_tools() {
                return Err(format!(
                    "the complete client schema catalog changed on the provider wire: {catalog}"
                ));
            }
            let first = read_recovery_response(
                first_response.map_err(|error| {
                    format!("the accepted first attempt did not return: {error}")
                })?,
                stream,
            )
            .await?;
            if first["status"] != "completed" {
                return Err(format!(
                    "the first client response did not complete: {first}"
                ));
            }
            let call = first["output"]
                .as_array()
                .and_then(|items| items.iter().find(|item| item["type"] == "function_call"))
                .ok_or_else(|| {
                    format!("the provider's discovered tool call did not reach the client: {first}")
                })?;
            let tool_output = execute_replace_block_call(call)?;
            if rx.try_recv().is_ok() {
                return Err("the first client response hid a retry or provider switch".to_string());
            }

            request["input"]
                .as_array_mut()
                .ok_or_else(|| "the schema request input must remain an array".to_string())?
                .push(call.clone());
            request["input"]
                .as_array_mut()
                .ok_or_else(|| "the schema request input must remain an array".to_string())?
                .push(json!({
                    "type": "function_call_output",
                    "call_id": SCHEMA_DISCOVERED_CALL_ID,
                    "output": tool_output
                }));
            let followup_response = client.post(&endpoint).json(&request).send().await;
            let followup_wire = receive_schema_provider_request(&mut rx).await?;
            let attempts = fixture.attempts.load(Ordering::SeqCst);
            if attempts != case_index * 2 + 2 {
                return Err(format!(
                    "the follow-up request produced {attempts} provider attempts, expected {}",
                    case_index * 2 + 2
                ));
            }
            validate_schema_followup_provider_request(&followup_wire)?;
            let followup = read_recovery_response(
                followup_response
                    .map_err(|error| format!("the accepted follow-up did not return: {error}"))?,
                stream,
            )
            .await?;
            if followup["status"] != "completed" {
                return Err(format!(
                    "the follow-up client response did not complete: {followup}"
                ));
            }
            if !followup.to_string().contains(SCHEMA_FINAL_TEXT) {
                return Err(format!(
                    "the final provider answer did not reach the client: {followup}"
                ));
            }
            if rx.try_recv().is_ok() {
                return Err("the follow-up hid a retry or provider switch".to_string());
            }
        }
        let attempts = fixture.attempts.load(Ordering::SeqCst);
        if attempts != 4 {
            return Err(format!(
                "JSON and SSE required {attempts} provider attempts, expected exactly 4"
            ));
        }
        Ok(())
    }
    .await;

    handle.shutdown().await;
    let _ = shutdown_tx.send(());
    upstream_task.await.unwrap();
    std::env::remove_var("V3_CHAT_NAME_TEST_KEY");
    assert!(
        outcome.is_ok(),
        "schema tool round trip failed: {outcome:?}"
    );
}

fn manifest(
    server_port: u16,
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let declaration = hub_v1_fixture::hub_v1_test_declaration().replace(direct, relay);
    let execution = hub_v1_fixture::hub_v1_server_execution("names");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.names]
bind = "127.0.0.1"
port = {server_port}
routing_group = "names"
endpoints = ["responses"]
{execution}
[providers.names]
type = "openai_chat"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_CHAT_NAME_TEST_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "client" }}
[providers.names.models.wire-model]
wire_name = "wire-model"
aliases = ["name-client"]
capabilities = ["text", "tools"]
supports_streaming = true
[debug]
log_console = false
[route_groups.names.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["name-client"] }}
targets = [{{ kind = "provider_model", provider = "names", model = "wire-model", key = "key", priority = 1 }}]
[route_groups.names.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "names", model = "wire-model", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

struct RecoveryFixture {
    raw: std::sync::Mutex<String>,
    turn: std::sync::atomic::AtomicUsize,
    captures: mpsc::UnboundedSender<Value>,
}

async fn discovered_custom_chat(Json(body): Json<Value>) -> Response<Body> {
    let custom = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["function"]["description"] == "discovered JavaScript")
        .unwrap();
    let name = custom["function"]["name"].as_str().unwrap();
    let followup = body["messages"].as_array().unwrap().iter().any(|message| {
        message["role"] == "tool"
            && message["tool_call_id"] == "call_discovered"
            && message["content"] == "DISCOVERY_OK"
    });
    let message = if followup {
        let history = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|message| message["tool_calls"].as_array().into_iter().flatten())
            .find(|call| call["id"] == "call_discovered")
            .unwrap();
        assert_eq!(history["function"]["name"], name);
        let arguments: Value =
            serde_json::from_str(history["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(arguments["input"], "text(\"DISCOVERY_OK\");");
        json!({"role":"assistant","content":"DISCOVERY_DONE"})
    } else {
        json!({"role":"assistant","content":null,"tool_calls":[{
            "id":"call_discovered","type":"function","function":{
                "name":name,"arguments":"{\"input\":\"text(\\\"DISCOVERY_OK\\\");\"}"
            }
        }]})
    };
    let finish = if followup { "stop" } else { "tool_calls" };
    if body["stream"] == true {
        let chunk = json!({"id":"chatcmpl-discovered","object":"chat.completion.chunk","model":"wire-model","choices":[{"index":0,"delta":message,"finish_reason":finish}]});
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(format!("data: {chunk}\n\ndata: [DONE]\n\n")))
            .unwrap()
    } else {
        Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(json!({"id":"chatcmpl-discovered","object":"chat.completion","model":"wire-model","choices":[{"index":0,"message":message,"finish_reason":finish}]}).to_string()))
            .unwrap()
    }
}

#[tokio::test]
async fn responses_discovered_custom_tools_restore_kind_and_identity_json_and_sse() {
    let _counter_environment = CounterEnvironment::new();
    std::env::set_var("V3_CHAT_NAME_TEST_KEY", "fixture-key");
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let upstream_task = tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new().route("/v1/chat/completions", post(discovered_custom_chat)),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await
        .unwrap();
    });
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap();
    let mut failures = Vec::new();
    for stream in [false, true] {
        for namespace in [
            None,
            Some("functions".to_string()),
            Some("long_namespace_".repeat(6)),
        ] {
            for source in ["tools", "additional_tools", "tool_search_output"] {
                let custom = json!({"type":"custom","name":"exec","description":"discovered JavaScript","format":{"type":"text"}});
                let declaration = if let Some(namespace) = &namespace {
                    json!({"type":"namespace","name":namespace,"tools":[custom]})
                } else {
                    custom
                };
                let mut request = json!({"model":"name-client","stream":stream,"input":[
                    {"role":"user","content":"Use the declared exec tool."}
                ]});
                match source {
                    "tools" => request["tools"] = json!([declaration]),
                    "additional_tools" => request["input"]
                        .as_array_mut()
                        .unwrap()
                        .insert(0, json!({"type":"additional_tools","tools":[declaration]})),
                    "tool_search_output" => {
                        request["tools"] = json!([{"type":"tool_search","execution":"client"}]);
                        request["input"] = json!([
                        {"type":"tool_search_call","call_id":"call_search","execution":"client","arguments":{"query":"exec"}},
                        {"type":"tool_search_output","call_id":"call_search","execution":"client","tools":[declaration]},
                        {"role":"user","content":"Use the discovered exec tool."}
                            ]);
                    }
                    _ => unreachable!(),
                }
                let response = client.post(&endpoint).json(&request).send().await.unwrap();
                let output = read_recovery_response(response, stream).await.unwrap();
                let call = output["output"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["call_id"] == "call_discovered")
                    .unwrap();
                if call["type"] != "custom_tool_call"
                    || call["name"] != "exec"
                    || call.get("namespace").and_then(Value::as_str) != namespace.as_deref()
                    || call["input"] != "text(\"DISCOVERY_OK\");"
                {
                    failures.push(format!(
                        "stream={stream} namespace={namespace:?} source={source}: {call}"
                    ));
                    continue;
                }
                let executed = std::process::Command::new("node")
                .args(["-e", "new Function('text', process.argv[1])(value => process.stdout.write(String(value)));", call["input"].as_str().unwrap()])
                .output().unwrap();
                assert!(
                    executed.status.success(),
                    "JavaScript tool failed: {executed:?}"
                );
                let result = String::from_utf8(executed.stdout).unwrap();
                assert_eq!(result, "DISCOVERY_OK");
                request["input"].as_array_mut().unwrap().push(call.clone());
                request["input"].as_array_mut().unwrap().push(json!({"type":"custom_tool_call_output","call_id":"call_discovered","output":result}));
                let followup = read_recovery_response(
                    client.post(&endpoint).json(&request).send().await.unwrap(),
                    stream,
                )
                .await
                .unwrap();
                assert_eq!(followup["status"], "completed");
                assert!(followup.to_string().contains("DISCOVERY_DONE"));
            }
        }
    }
    handle.shutdown().await;
    let _ = shutdown_tx.send(());
    upstream_task.await.unwrap();
    std::env::remove_var("V3_CHAT_NAME_TEST_KEY");
    assert!(
        failures.is_empty(),
        "discovered custom identity lost: {}",
        failures.join("\n")
    );
}

async fn recoverable_chat_call(
    State(state): State<Arc<RecoveryFixture>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    use std::sync::atomic::Ordering;
    // Startup/recovery probes are separate from the business consumer.
    let probe = body
        .get("tools")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    let turn = if probe {
        2
    } else {
        state.turn.fetch_add(1, Ordering::SeqCst) % 3
    };
    if !probe {
        state.captures.send(body.clone()).unwrap();
    }
    let (call_id, arguments) = if turn == 0 {
        ("call_bad", state.raw.lock().unwrap().clone())
    } else {
        (
            "call_fixed",
            r#"{"input":"text(\"RECOVERED\");"}"#.to_string(),
        )
    };
    let message = if turn == 2 {
        json!({"role":"assistant","content":"RECOVERY_COMPLETED"})
    } else {
        let tool = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["description"] == "JavaScript evaluator")
            .unwrap();
        let tool_name = tool["function"]["name"].as_str().unwrap();
        json!({"role":"assistant","content":null,"tool_calls":[{"id":call_id,"type":"function","function":{"name":tool_name,"arguments":arguments}}]})
    };
    let finish = if turn == 2 { "stop" } else { "tool_calls" };
    let usage = json!({"prompt_tokens":2,"completion_tokens":3,"total_tokens":5});
    if body["stream"] != true {
        return Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "id":"chatcmpl-recovery","object":"chat.completion","model":"wire-model",
                    "choices":[{"index":0,"message":message,"finish_reason":finish}],"usage":usage
                })
                .to_string(),
            ))
            .unwrap();
    }
    let mut events = Vec::new();
    if turn == 2 {
        events.push(json!({"id":"chatcmpl-recovery","object":"chat.completion.chunk","model":"wire-model","choices":[{"index":0,"delta":message,"finish_reason":finish}],"usage":usage}));
    } else {
        let split = arguments.len() / 2;
        let tool_name = message["tool_calls"][0]["function"]["name"]
            .as_str()
            .unwrap();
        events.push(json!({"id":"chatcmpl-recovery","object":"chat.completion.chunk","model":"wire-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":call_id,"type":"function","function":{"name":tool_name,"arguments":&arguments[..split]}}]},"finish_reason":null}]}));
        events.push(json!({"id":"chatcmpl-recovery","object":"chat.completion.chunk","model":"wire-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":&arguments[split..]}}]},"finish_reason":null}]}));
        events.push(json!({"id":"chatcmpl-recovery","object":"chat.completion.chunk","model":"wire-model","choices":[{"index":0,"delta":{},"finish_reason":finish}],"usage":usage}));
    }
    let mut wire = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    wire.push_str("data: [DONE]\n\n");
    let pieces = wire
        .as_bytes()
        .chunks(11)
        .map(|part| Ok::<_, std::io::Error>(part.to_vec()))
        .collect::<Vec<_>>();
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(futures_util::stream::iter(pieces)))
        .unwrap()
}

async fn read_recovery_response(
    response: reqwest::Response,
    stream: bool,
) -> Result<Value, String> {
    if response.status() != StatusCode::OK {
        return Err(format!("unexpected client status {}", response.status()));
    }
    let text = response
        .text()
        .await
        .map_err(|error| format!("client transfer failed: {error}"))?;
    if !stream {
        return serde_json::from_str(&text)
            .map_err(|error| format!("client JSON: {error}; {text}"));
    }
    let mut completed = None;
    for data in text.lines().filter_map(|line| line.strip_prefix("data: ")) {
        if data == "[DONE]" {
            continue;
        }
        let event: Value =
            serde_json::from_str(data).map_err(|error| format!("client SSE JSON: {error}"))?;
        if matches!(event["type"].as_str(), Some("error" | "response.failed")) {
            return Err(format!("proxy emitted client error: {event}"));
        }
        if event["type"] == "response.completed" {
            completed = Some(event["response"].clone());
        }
    }
    completed.ok_or_else(|| format!("missing client completion: {text}"))
}

#[tokio::test]
async fn invalid_custom_arguments_reach_client_and_recover_json_and_sse() {
    let _counter_environment = CounterEnvironment::new();
    std::env::set_var("V3_CUSTOM_RECOVERY_TEST_KEY", "fixture-key");
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let fixture = Arc::new(RecoveryFixture {
        raw: std::sync::Mutex::new(String::new()),
        turn: std::sync::atomic::AtomicUsize::new(0),
        captures: tx,
    });
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(recoverable_chat_call))
        .with_state(fixture.clone());
    let upstream_task = tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let mut compiled = manifest(test_ports::free_port(), upstream_addr.port());
    compiled.providers.get_mut("names").unwrap().auth.entries[0].env =
        Some("V3_CUSTOM_RECOVERY_TEST_KEY".to_string());
    compiled
        .providers
        .get_mut("names")
        .unwrap()
        .health
        .as_mut()
        .unwrap()
        .enabled = true;
    let handle = spawn_v3_server_aggregate(compiled).await.unwrap();
    let proxy_addr = handle.listeners[0].addr;
    let endpoint = format!("http://{proxy_addr}/v1/responses");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap();
    let outcome: Result<(), String> = async {
        let cases = [
            (r#"{"arguments":"{\"cmd\":\"DIAGNOSTIC_ONLY\"}","name":"functions__exec"}"#, None),
            (r#"{"input":42}"#, Some(json!(42))), (" null \n", None), ("[1,2]", None), ("", None),
            ("  {\"input\":  \n", None), ("  text(\"ORIGINAL\");\n", None),
            (r#"{"input":"text(\"ORIGINAL\");"}"#, Some(json!("text(\"ORIGINAL\");"))),
            (r#""text(\"ORIGINAL\");""#, Some(json!("text(\"ORIGINAL\");"))),
        ];
        for stream in [false, true] {
          for discovered in [false, true] {
            for (raw, unwrapped) in &cases {
                *fixture.raw.lock().unwrap() = raw.to_string();
                let expected = unwrapped.clone().unwrap_or_else(|| json!(raw));
                let mut request = json!({"model":"name-client","stream":stream,"input":[{"role":"user","content":"Use the declared tool; correct any tool error."}],"tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec","description":"JavaScript evaluator","format":{"type":"text"}}]}]});
                if discovered {
                    let declarations = request["tools"].take();
                    request["tools"] = json!([{"type":"tool_search","execution":"client"}]);
                    let history = request["input"].as_array_mut().unwrap();
                    history.insert(0, json!({"type":"tool_search_call","call_id":"call_search","execution":"client","arguments":{"query":"exec"}}));
                    history.insert(1, json!({"type":"tool_search_output","call_id":"call_search","execution":"client","tools":declarations}));
                }
                for (turn, id, input) in [(0, "call_bad", expected.clone()), (1, "call_fixed", json!("text(\"RECOVERED\");"))] {
                    let sent = client.post(&endpoint).json(&request).send().await.map_err(|error| error.to_string())?;
                    let response = read_recovery_response(sent, stream).await?;
                    let call = response["output"].as_array().and_then(|items| items.iter().find(|item| item["type"] == "custom_tool_call")).ok_or_else(|| format!("missing client tool call: {response}"))?;
                    if response["status"] != "completed" || call["name"] != "exec" || call["namespace"] != "functions" || call["call_id"] != id || call["input"] != input {
                        return Err(format!("tool input/identity changed for {raw:?}: {response}"));
                    }
                    let wire = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.map_err(|error| error.to_string())?.ok_or("fixture capture closed")?;
                    if turn == 1 && !wire["messages"].as_array().unwrap().iter().any(|message| message["role"] == "tool" && message["tool_call_id"] == "call_bad" && message["content"] == "Tool validation failed; correct the input.") {
                        return Err(format!("client tool-error result was lost: {wire}"));
                    }
                    if turn == 1 && !wire["messages"].as_array().unwrap().iter().flat_map(|message| message["tool_calls"].as_array().into_iter().flatten()).any(|call| call["id"] == "call_bad" && serde_json::from_str::<Value>(call["function"]["arguments"].as_str().unwrap()).unwrap()["input"] == expected) {
                        return Err(format!("original invalid input was lost from follow-up history: {wire}"));
                    }
                    request["input"].as_array_mut().unwrap().push(call.clone());
                    request["input"].as_array_mut().unwrap().push(json!({"type":"custom_tool_call_output","call_id":id,"output":if turn == 0 { "Tool validation failed; correct the input." } else { "TOOL_OK" }}));
                }
                let sent = client.post(&endpoint).json(&request).send().await.map_err(|error| error.to_string())?;
                let complete = read_recovery_response(sent, stream).await?;
                if complete["status"] != "completed" || !complete.to_string().contains("RECOVERY_COMPLETED") { return Err(format!("recovery failed: {complete}")); }
                tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.map_err(|error| error.to_string())?.ok_or("fixture capture closed")?;
                if rx.try_recv().is_ok() { return Err("extra provider attempt concealed a response error".to_string()); }
            }
          }
        }
        Ok(())
    }.await;
    eprintln!(
        "business attempts={}, result={outcome:?}",
        fixture.turn.load(std::sync::atomic::Ordering::SeqCst)
    );
    handle.shutdown().await;
    let _ = shutdown_tx.send(());
    upstream_task.await.unwrap();
    std::env::remove_var("V3_CUSTOM_RECOVERY_TEST_KEY");
    assert!(
        tokio::net::TcpStream::connect(proxy_addr).await.is_err(),
        "proxy fixture remained open"
    );
    assert!(
        tokio::net::TcpStream::connect(upstream_addr).await.is_err(),
        "provider fixture remained open"
    );
    assert!(outcome.is_ok(), "public recovery regression: {outcome:?}");
}
