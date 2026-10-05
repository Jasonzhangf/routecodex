// bug908e8aa public blackbox: goaichat Anthropic long tool names must map only
// under the anthropic:goaichat profile and must be restored before the client.
//
// Run: npm --prefix v3 run test:v3-goaichat-long-tool-names
use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

// Aggregate servers resolve process-level runtime paths. Serialize this test
// process's environment changes, just as the existing Server black-box suite
// serializes its aggregate fixtures.
static TEST_LOCK: Mutex<()> = Mutex::new(());

struct CounterEnvironment {
    previous: Option<OsString>,
    counter_path: PathBuf,
}

impl CounterEnvironment {
    fn new() -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let counter_path = std::env::temp_dir().join(format!(
            "routecodex-goaichat-long-names-{}-{}.json",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let previous = std::env::var_os("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
        std::env::set_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE", &counter_path);
        Self {
            previous,
            counter_path,
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
        let _ = std::fs::remove_file(&self.counter_path);
    }
}

const GOAICHAT: &str = "anthropic:goaichat";
const GLM: &str = "chat:glm";
const MATH_NAMESPACE: &str = "mcp__codex_apps__codex_math";
const MATH_TOOL: &str = "_long_namespace_math_add_exact19_23_42";
const MATH_CUSTOM: &str = "_long_namespace_math_evaluate_exact19_23_42";
const MATH_PREFIX_64: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MATH_PREFIX_65: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
const FLAT_MCP_TOOL: &str =
    "mcp__routecodex__goaichat___defense_factory_long_workflow_exact19_23_42_name";

fn math_schema() -> Value {
    json!({
        "type":"object",
        "properties":{"a":{"type":"integer","description":"first addend"},"b":{"type":"integer","description":"second addend"}},
        "required":["a","b"],
        "additionalProperties":false
    })
}

fn execute_custom_add(input: &Value) -> String {
    let (a, b) = input.as_str().unwrap().split_once('+').unwrap();
    (a.parse::<i64>().unwrap() + b.parse::<i64>().unwrap()).to_string()
}

fn collision_fixture() -> (String, String) {
    let source = format!(
        "mcp__codex_apps__math___sha_allocator_collision_source_{}",
        "x".repeat(70)
    );
    let alias = provider_compat_core::namespace_tools::openai_chat_namespace_wire_name(&source);
    assert_eq!(alias.len(), 64);
    assert_ne!(alias, source);
    (source, alias)
}

#[derive(Clone)]
struct Gateway {
    strict: bool,
    captures: Arc<Mutex<Vec<Value>>>,
}

fn bad_request(reason: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"type":"error","error":{"type":"invalid_request_error","message":format!("invalid function name: {reason}")}})
                .to_string(),
        ))
        .unwrap()
}

fn tool_names(body: &Value) -> BTreeSet<String> {
    body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .map(str::to_owned)
        .collect()
}

async fn provider(State(state): State<Gateway>, Json(body): Json<Value>) -> Response<Body> {
    state.captures.lock().unwrap().push(body.clone());
    let tools = body["tools"].as_array().unwrap();
    let names = tool_names(&body);
    if state.strict
        && tools
            .iter()
            .any(|tool| tool["name"].as_str().map_or(true, |n| n.len() > 64))
    {
        return bad_request("declaration longer than 64");
    }
    if tools.len() != names.len() {
        return bad_request("duplicate declaration");
    }
    for tool in tools {
        if tool
            .get("input_schema")
            .and_then(Value::as_object)
            .is_none()
        {
            return bad_request("malformed tool schema");
        }
    }
    for message in body["messages"].as_array().unwrap() {
        for block in message["content"].as_array().into_iter().flatten() {
            if block["type"] == "tool_use" {
                let name = block["name"].as_str().unwrap();
                if !names.contains(name) {
                    return bad_request("history name not declared");
                }
            }
        }
    }
    if let Some(choice) = body.get("tool_choice").and_then(Value::as_object) {
        if let Some(name) = choice.get("name").and_then(Value::as_str) {
            if !names.contains(name) {
                return bad_request("forced choice not declared");
            }
        }
    }
    let receipt_ok = body["messages"].as_array().unwrap().iter().any(|message| {
        message["role"] == "user"
            && message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|block| {
                    block["type"] == "tool_result"
                        && block["tool_use_id"] == "call_math"
                        && block["content"].to_string().contains("42")
                })
    });
    if receipt_ok {
        let blocks: Vec<&Value> = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|message| message["content"].as_array().into_iter().flatten())
            .collect();
        for (id, input) in [
            ("call_math", json!({"a":19,"b":23})),
            ("call_custom", json!({"input":"19+23"})),
            ("call_flat", json!({"a":19,"b":23})),
            ("call_plain", json!({"a":20,"b":22})),
            ("call_plain_custom", json!({"input":"20+22"})),
        ] {
            if id.starts_with("call_plain")
                && !tools.iter().any(|tool| {
                    tool["description"]
                        .as_str()
                        .is_some_and(|description| description.starts_with("plain collision"))
                })
            {
                continue;
            }
            if !blocks.iter().any(|block| {
                block["type"] == "tool_use" && block["id"] == id && block["input"] == input
            }) || !blocks.iter().any(|block| {
                block["type"] == "tool_result"
                    && block["tool_use_id"] == id
                    && block["content"].to_string().contains("42")
            }) {
                return bad_request("followup must preserve every executed call and receipt");
            }
        }
        return json_response(
            json!({"id":"msg_terminal","type":"message","role":"assistant","model":"glm-5.3",
                "content":[{"type":"text","text":"receipt accepted:42"}],"stop_reason":"end_turn",
                "usage":{"input_tokens":20,"output_tokens":8}}),
            body["stream"].as_bool().unwrap_or(false),
        );
    }
    let find_name = |description: &str| -> String {
        tools
            .iter()
            .find(|tool| {
                tool.get("description")
                    .and_then(Value::as_str)
                    .is_some_and(|value| {
                        value == description || value.starts_with(&format!("{description}\n"))
                    })
            })
            .unwrap()["name"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let math = find_name("math evaluator");
    let custom = find_name("custom evaluator");
    let flat = find_name("flat long evaluator");
    let mut content = vec![
        json!({"type":"tool_use","id":"call_math","name":math,"input":{"a":19,"b":23}}),
        json!({"type":"tool_use","id":"call_custom","name":custom,"input":{"input":"19+23"}}),
        json!({"type":"tool_use","id":"call_flat","name":flat,"input":{"a":19,"b":23}}),
    ];
    if tools.iter().any(|tool| {
        tool.get("description").and_then(Value::as_str) == Some("plain collision function")
    }) {
        let plain = find_name("plain collision function");
        content.push(
            json!({"type":"tool_use","id":"call_plain","name":plain,"input":{"a":20,"b":22}}),
        );
    }
    if tools.iter().any(|tool| {
        tool.get("description")
            .and_then(Value::as_str)
            .is_some_and(|description| description.starts_with("plain collision custom\n"))
    }) {
        let plain_custom = find_name("plain collision custom");
        content.push(json!({"type":"tool_use","id":"call_plain_custom","name":plain_custom,"input":{"input":"20+22"}}));
    }
    json_response(
        json!({"id":"msg_tools","type":"message","role":"assistant","model":"glm-5.3",
            "content":content,"stop_reason":"tool_use",
            "usage":{"input_tokens":20,"output_tokens":8}}),
        body["stream"].as_bool().unwrap_or(false),
    )
}

fn json_response(message: Value, stream: bool) -> Response<Body> {
    if stream {
        let mut sse = String::new();
        sse.push_str("event: message_start\ndata: ");
        sse.push_str(&json!({"type":"message_start","message":{"id":"msg_goaichat","type":"message","role":"assistant","model":"glm-5.3","content":[],"usage":{"input_tokens":20}}}).to_string());
        sse.push_str("\n\n");
        for (index, block) in message["content"].as_array().unwrap().iter().enumerate() {
            let block_type = block["type"].as_str().unwrap();
            if block_type == "tool_use" {
                let id = block["id"].as_str().unwrap();
                let name = block["name"].as_str().unwrap();
                let input = block["input"].clone();
                sse.push_str("event: content_block_start\ndata: ");
                sse.push_str(&json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":id,"name":name,"input":{}}}).to_string());
                sse.push_str("\n\n");
                sse.push_str("event: content_block_delta\ndata: ");
                sse.push_str(&json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":input.to_string()}}).to_string());
                sse.push_str("\n\n");
                sse.push_str(
                    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":",
                );
                sse.push_str(&index.to_string());
                sse.push_str("}\n\n");
            } else {
                sse.push_str("event: content_block_start\ndata: ");
                sse.push_str(&json!({"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}}).to_string());
                sse.push_str("\n\n");
                sse.push_str("event: content_block_delta\ndata: ");
                sse.push_str(&json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":block["text"]}}).to_string());
                sse.push_str("\n\n");
                sse.push_str(
                    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":",
                );
                sse.push_str(&index.to_string());
                sse.push_str("}\n\n");
            }
        }
        sse.push_str("event: message_delta\ndata: ");
        sse.push_str(&json!({"type":"message_delta","delta":{"stop_reason":message["stop_reason"]},"usage":{"output_tokens":8}}).to_string());
        sse.push_str("\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(sse))
            .unwrap()
    } else {
        Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(message.to_string()))
            .unwrap()
    }
}

fn manifest(
    port: u16,
    upstream: &str,
    profile: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("goaichat");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.goaichat]
bind = "127.0.0.1"
port = {port}
routing_group = "goaichat"
endpoints = ["responses", "anthropic"]
{execution}
[providers.gateway]
type = "anthropic"
base_url = "{upstream}"
default_model = "glm-5.3"
compatibility_profile = "{profile}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_GOAICHAT_LONG_NAMES_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.gateway.models."glm-5.3"]
wire_name = "glm-5.3"
aliases = ["goaichat-client"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[route_groups.goaichat.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "gateway", model = "glm-5.3", key = "key", priority = 1 }}]
[debug]
log_console = false
snapshots = true
dry_run = true
retention = {{ raw_requests = 8, raw_responses = 8, events = 64 }}
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn responses_request(stream: bool, collision: bool) -> Value {
    let mut request = json!({
        "model":"gateway.glm-5.3",
        "stream":stream,
        "input":[{"role":"user","content":"calculate"}],
        "tools":[
            {"type":"function","name":FLAT_MCP_TOOL,"description":"flat long evaluator","parameters":math_schema()},
            {"type":"function","name":format!("{MATH_NAMESPACE}.{MATH_TOOL}"),"description":"math evaluator","parameters":math_schema()},
            {"type":"custom","name":format!("{MATH_NAMESPACE}.{MATH_CUSTOM}"),"description":"custom evaluator","format":{"type":"text"}},
            {"type":"function","name":MATH_PREFIX_64,"description":"boundary 64","parameters":{"type":"object","properties":{}}},
            {"type":"function","name":MATH_PREFIX_65,"description":"boundary 65","parameters":{"type":"object","properties":{}}}
        ],
        "tool_choice":{"type":"function","name":format!("{MATH_NAMESPACE}.{MATH_TOOL}")}
    });
    if collision {
        let (collision_source, collision_alias) = collision_fixture();
        request["tools"].as_array_mut().unwrap().push(json!({
            "type":"function","name":collision_alias,"description":"plain collision function","parameters":math_schema()
        }));
        request["tools"].as_array_mut().unwrap().push(json!({
            "type":"custom","name":collision_source,"description":"plain collision custom","format":{"type":"text"}
        }));
    }
    request
}

fn messages_request(stream: bool) -> Value {
    json!({
        "model":"gateway.glm-5.3",
        "stream":stream,
        "max_tokens":4096,
        "messages":[{"role":"user","content":[{"type":"text","text":"calculate"}]}],
        "tools":[
            {"name":FLAT_MCP_TOOL,"description":"flat long evaluator","input_schema":math_schema()},
            {"name":format!("{MATH_NAMESPACE}__{MATH_TOOL}"),"description":"math evaluator","input_schema":math_schema()},
            {"name":format!("{MATH_NAMESPACE}__{MATH_CUSTOM}"),"description":"custom evaluator","input_schema":{"type":"object","properties":{"input":{"type":"string"}},"required":["input"],"additionalProperties":false}},
            {"name":MATH_PREFIX_64,"description":"boundary 64","input_schema":{"type":"object","properties":{}}},
            {"name":MATH_PREFIX_65,"description":"boundary 65","input_schema":{"type":"object","properties":{}}}
        ],
        "tool_choice":{"type":"tool","name":format!("{MATH_NAMESPACE}__{MATH_TOOL}")}
    })
}

async fn response_value(response: reqwest::Response, stream: bool, anthropic: bool) -> Value {
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "first provider attempt must be accepted"
    );
    let text = response
        .text()
        .await
        .expect("read accepted provider response");
    if anthropic {
        if stream {
            let events: Vec<Value> = text
                .lines()
                .filter_map(|line| line.strip_prefix("data: "))
                .filter(|data| *data != "[DONE]")
                .filter_map(|data| serde_json::from_str::<Value>(data).ok())
                .collect();
            assert!(!events
                .iter()
                .any(|event| matches!(event["type"].as_str(), Some("error" | "response.failed"))));
            let mut message = json!({"id":"msg_sse","type":"message","role":"assistant","model":"glm-5.3","content":[],"stop_reason":null,"usage":{"input_tokens":20,"output_tokens":8}});
            for event in events {
                match event["type"].as_str() {
                    Some("content_block_start") => {
                        let block = event["content_block"].clone();
                        message["content"].as_array_mut().unwrap().push(block);
                    }
                    Some("content_block_delta") => {
                        if event["delta"]["type"] == "input_json_delta" {
                            let index = event["index"].as_u64().unwrap() as usize;
                            let partial = event["delta"]["partial_json"].as_str().unwrap();
                            let parsed: Value = serde_json::from_str(partial).unwrap();
                            message["content"][index]["input"] = parsed;
                        }
                    }
                    Some("message_delta") => {
                        if let Some(stop) = event["delta"]["stop_reason"].as_str() {
                            message["stop_reason"] = json!(stop);
                        }
                    }
                    _ => {}
                }
            }
            return message;
        }
        return serde_json::from_str(&text).unwrap();
    }
    if stream {
        let events: Vec<Value> = text
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter(|data| *data != "[DONE]")
            .filter_map(|data| serde_json::from_str::<Value>(data).ok())
            .collect();
        assert!(!events
            .iter()
            .any(|event| matches!(event["type"].as_str(), Some("error" | "response.failed"))));
        return events
            .into_iter()
            .find(|event| event["type"] == "response.completed")
            .expect("real Responses completed event")["response"]
            .clone();
    }
    serde_json::from_str(&text).unwrap()
}

async fn run_responses_round_trip(stream: bool, profile: &str, strict: bool, collision: bool) {
    let captures = Arc::new(Mutex::new(Vec::new()));
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let router = Router::new()
        .route("/v1/messages", post(provider))
        .with_state(Gateway {
            strict,
            captures: captures.clone(),
        });
    let peer = tokio::spawn(async move { axum::serve(upstream, router).await.unwrap() });
    let handle = spawn_v3_server_aggregate(manifest(
        test_ports::free_port(),
        &format!("http://{upstream_addr}"),
        profile,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let mut payload = responses_request(stream, collision);
    let first_response = client.post(&endpoint).json(&payload).send().await;
    if first_response.is_err() {
        handle.shutdown().await;
        peer.abort();
        panic!(
            "strict upstream must accept the first provider request: {:?}; captures={:?}",
            first_response,
            captures.lock().unwrap()
        );
    }
    let first = response_value(first_response.unwrap(), stream, false).await;
    let output = first["output"].as_array().unwrap();
    let math = output
        .iter()
        .find(|item| item["call_id"] == "call_math")
        .unwrap();
    assert_eq!(math["type"], "function_call");
    assert_eq!(math["name"], MATH_TOOL);
    assert_eq!(math["namespace"], MATH_NAMESPACE);
    let args: Value = serde_json::from_str(math["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(args, json!({"a":19,"b":23}));
    assert_eq!(
        args["a"].as_i64().unwrap() + args["b"].as_i64().unwrap(),
        42
    );
    let custom = output
        .iter()
        .find(|item| item["call_id"] == "call_custom")
        .unwrap();
    assert_eq!(custom["type"], "custom_tool_call");
    assert_eq!(custom["name"], format!("{MATH_NAMESPACE}.{MATH_CUSTOM}"));
    assert!(custom.get("namespace").is_none());
    assert_eq!(custom["input"], "19+23");
    let custom_result = execute_custom_add(&custom["input"]);
    assert_eq!(custom_result, "42");
    let flat = output
        .iter()
        .find(|item| item["call_id"] == "call_flat")
        .unwrap();
    assert_eq!(flat["type"], "function_call");
    let flat_dispatch = format!(
        "{}__{}",
        flat["namespace"].as_str().unwrap().replace('.', "__"),
        flat["name"].as_str().unwrap()
    );
    assert_eq!(flat_dispatch, FLAT_MCP_TOOL);
    let mut history = payload["input"].as_array().unwrap().clone();
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
    history.push(json!({"type":"function_call_output","call_id":"call_math","output":"42"}));
    history.push(
        json!({"type":"custom_tool_call_output","call_id":"call_custom","output":custom_result}),
    );
    history.push(json!({"type":"function_call_output","call_id":"call_flat","output":"42"}));
    if collision {
        let plain = output
            .iter()
            .find(|item| item["call_id"] == "call_plain")
            .unwrap();
        assert_eq!(plain["type"], "function_call");
        assert_eq!(plain["name"], collision_fixture().1);
        assert!(plain.get("namespace").is_none());
        history.push(json!({"type":"function_call_output","call_id":"call_plain","output":"42"}));
        let plain_custom = output
            .iter()
            .find(|item| item["call_id"] == "call_plain_custom")
            .unwrap();
        assert_eq!(plain_custom["type"], "custom_tool_call");
        assert_eq!(plain_custom["name"], collision_fixture().0);
        assert!(plain_custom.get("namespace").is_none());
        let result = execute_custom_add(&plain_custom["input"]);
        assert_eq!(result, "42");
        history.push(
            json!({"type":"custom_tool_call_output","call_id":"call_plain_custom","output":result}),
        );
    }
    payload["input"] = json!(history);
    payload["stream"] = json!(false);
    let final_response = client.post(&endpoint).json(&payload).send().await.unwrap();
    let final_value = response_value(final_response, false, false).await;
    assert_eq!(final_value["status"], "completed");
    assert!(final_value.to_string().contains("42"));
    handle.shutdown().await;
    peer.abort();
    let captures = captures.lock().unwrap();
    assert_eq!(
        captures.len(),
        2,
        "one accepted provider attempt per turn; captures={captures:?}"
    );
    if strict {
        for capture in captures.iter() {
            let names = tool_names(capture);
            assert!(
                names.iter().all(|name| name.len() <= 64),
                "goaichat wire names must be <=64; {names:?}"
            );
            assert_eq!(names.len(), capture["tools"].as_array().unwrap().len());
        }
    } else {
        for capture in captures.iter() {
            assert!(
                capture["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["name"] == FLAT_MCP_TOOL),
                "generic chat:glm must preserve the long flat name"
            );
        }
    }
}

async fn run_messages_round_trip(stream: bool) {
    let captures = Arc::new(Mutex::new(Vec::new()));
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let router = Router::new()
        .route("/v1/messages", post(provider))
        .with_state(Gateway {
            strict: true,
            captures: captures.clone(),
        });
    let peer = tokio::spawn(async move { axum::serve(upstream, router).await.unwrap() });
    let handle = spawn_v3_server_aggregate(manifest(
        test_ports::free_port(),
        &format!("http://{upstream_addr}"),
        GOAICHAT,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let mut payload = messages_request(stream);
    let first_response = client.post(&endpoint).json(&payload).send().await;
    if first_response.is_err() {
        handle.shutdown().await;
        peer.abort();
        panic!(
            "goaichat Messages upstream must accept first request: {:?}; captures={:?}",
            first_response,
            captures.lock().unwrap()
        );
    }
    let first = response_value(first_response.unwrap(), stream, true).await;
    let math = first["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["type"] == "tool_use" && block["id"] == "call_math")
        .unwrap();
    assert_eq!(math["name"], format!("{MATH_NAMESPACE}__{MATH_TOOL}"));
    assert_eq!(math["input"], json!({"a":19,"b":23}));
    let flat = first["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["type"] == "tool_use" && block["id"] == "call_flat")
        .unwrap();
    assert_eq!(flat["name"], FLAT_MCP_TOOL);
    assert_eq!(flat["input"], json!({"a":19,"b":23}));
    let custom = first["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["id"] == "call_custom")
        .unwrap();
    assert_eq!(custom["name"], format!("{MATH_NAMESPACE}__{MATH_CUSTOM}"));
    let custom_result = execute_custom_add(&custom["input"]["input"]);
    assert_eq!(custom_result, "42");
    let messages = payload["messages"].as_array_mut().unwrap();
    messages.push(json!({"role":"assistant","content":first["content"]}));
    messages.push(json!({"role":"user","content":[
        {"type":"tool_result","tool_use_id":"call_math","content":"42"},
        {"type":"tool_result","tool_use_id":"call_custom","content":custom_result},
        {"type":"tool_result","tool_use_id":"call_flat","content":"42"}
    ]}));
    payload["stream"] = json!(false);
    let final_response = client.post(&endpoint).json(&payload).send().await.unwrap();
    let final_value = response_value(final_response, false, true).await;
    assert!(
        final_value.to_string().contains("receipt accepted:42"),
        "{final_value}"
    );
    handle.shutdown().await;
    peer.abort();
    let captures = captures.lock().unwrap();
    assert_eq!(
        captures.len(),
        2,
        "one accepted provider attempt per Messages turn; captures={captures:?}"
    );
    for capture in captures.iter() {
        let names = tool_names(capture);
        assert!(
            names.iter().all(|name| name.len() <= 64),
            "Messages goaichat wire names must be <=64; {names:?}"
        );
    }
}

#[tokio::test]
async fn goaichat_long_tool_names_public_http_regression() {
    let _test_guard = TEST_LOCK.lock().unwrap();
    let _counter_environment = CounterEnvironment::new();
    std::env::set_var("V3_GOAICHAT_LONG_NAMES_KEY", "controlled-external-peer");
    run_responses_round_trip(false, GOAICHAT, true, true).await;
    run_responses_round_trip(true, GOAICHAT, true, true).await;
    run_messages_round_trip(false).await;
    run_messages_round_trip(true).await;
    run_responses_round_trip(false, GLM, false, false).await;
    std::env::remove_var("V3_GOAICHAT_LONG_NAMES_KEY");
}
