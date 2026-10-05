use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use axum::response::{IntoResponse, Response};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{ffi::OsString, net::TcpListener, sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

// Aggregate servers resolve process-level runtime paths. Isolate the declared
// counter source and serialize this test process's environment changes, just as
// the existing Server black-box suite serializes its aggregate fixtures.
static TEST_LOCK: Mutex<()> = Mutex::const_new(());

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

#[derive(Clone)]
struct Gateway {
    strict: bool,
    long_call: bool,
    captures: Arc<Mutex<Vec<Value>>>,
}

// External HTTP peer reproduces the captured 115-message gateway regression:
// adding an empty-parameters function envelope makes the first
// attempt fail. The original native declaration and complete history pass.
async fn provider(
    State(state): State<Gateway>,
    Json(body): Json<Value>,
) -> Response {
    state.captures.lock().await.push(body.clone());
    let hosted = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["type"] == "web_search_20250305")
        .expect("hosted declaration must survive projection");
    let blocks: Vec<&Value> = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["content"].as_array().unwrap())
        .collect();
    let historical_call = blocks.iter().any(|block| block["type"] == "tool_use");
    // These clients declare ordinary tools without private extensions. The
    // hosted adjustment must not add a second protocol shape to those tools.
    let mixed_native = body["tools"].as_array().unwrap().iter().any(|tool| {
        tool.get("input_schema").is_some()
            && (tool.get("type").is_some() || tool.get("function").is_some())
    });
    let names: Vec<&str> = body["tools"].as_array().unwrap().iter()
        .filter_map(|tool| tool["name"].as_str()).collect();
    let invalid_names = names.iter().any(|name| name.len() > 64)
        || names.iter().collect::<std::collections::BTreeSet<_>>().len() != names.len();
    if state.strict && invalid_names {
        return (StatusCode::BAD_REQUEST, Json(json!({"type":"error","error":{
            "type":"invalid_request_error","message":"invalid function name"
        }}))).into_response();
    }
    if state.strict
        && historical_call
        && (hosted["function"] == json!({"name":"web_search","parameters":{}}) || mixed_native)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"type":"error","error":{
                "type":"invalid_request_error","message":"invalid function name"
            }})),
        ).into_response();
    }
    let call_name = if state.long_call {
        body["tools"].as_array().unwrap().iter()
            .find(|tool| tool["description"] == "long-tool-target").unwrap()["name"].as_str().unwrap()
    } else { "exec_command" };
    if state.long_call && body["tool_choice"]["name"] != call_name {
        return (StatusCode::BAD_REQUEST, Json(json!({"type":"error","error":{
            "type":"invalid_request_error","message":"forced tool choice mismatch"
        }}))).into_response();
    }
    let receipt = blocks.iter().any(|block| {
        block["type"] == "tool_result"
            && block["tool_use_id"] == "call_next"
            && block["content"].to_string().contains("EXECUTED:42")
    });
    if receipt && state.long_call && !blocks.iter().any(|block|
        block["type"] == "tool_use" && block["id"] == "call_next"
        && block["name"] == call_name && block["input"] == json!({"value":41})) {
        return (StatusCode::BAD_REQUEST, Json(json!({"type":"error","error":{
            "type":"invalid_request_error","message":"followup tool identity mismatch"
        }}))).into_response();
    }
    let (content, stop) = if receipt {
        (
            json!([{"type":"text","text":"receipt accepted:42"}]),
            "end_turn",
        )
    } else {
        (
            json!([{"type":"tool_use","id":"call_next","name":call_name,
            "input":{"value":41}}]),
            "tool_use",
        )
    };
    if state.long_call && body["stream"] == true {
        let start = json!({"type":"message_start","message":{"id":"msg_gateway","type":"message","role":"assistant","model":"glm-5.3","content":[],"stop_reason":null,"usage":{"input_tokens":20,"output_tokens":0}}});
        let block = json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_next","name":call_name,"input":{}}});
        let delta = json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"value\":41}"}});
        let terminal = json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":8}});
        let sse = format!("event: message_start\ndata: {start}\n\nevent: content_block_start\ndata: {block}\n\nevent: content_block_delta\ndata: {delta}\n\nevent: content_block_stop\ndata: {{\"type\":\"content_block_stop\",\"index\":0}}\n\nevent: message_delta\ndata: {terminal}\n\nevent: message_stop\ndata: {{\"type\":\"message_stop\"}}\n\n");
        return (StatusCode::OK, [("content-type", "text/event-stream")], sse).into_response();
    }
    (
        StatusCode::OK,
        Json(
            json!({"id":"msg_gateway","type":"message","role":"assistant",
        "model":"glm-5.3","content":content,"stop_reason":stop,
        "usage":{"input_tokens":20,"output_tokens":8}}),
        ),
    ).into_response()
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
    profile: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("test");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.test]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses", "openai_chat", "anthropic"]
{execution}
[providers.gateway]
type = "anthropic"
base_url = "{upstream}"
default_model = "glm-5.3"
compatibility_profile = "{profile}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_GOAICHAT_BLACKBOX_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.gateway.models."glm-5.3"]
wire_name = "glm-5.3"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[route_groups.default.pools.default]
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

fn request(endpoint: &str, stream: bool) -> Value {
    let schema =
        json!({"type":"object","properties":{"value":{"type":"integer"}},"required":["value"]});
    let mut request = match endpoint {
        "/v1/responses" => json!({"model":"gateway.glm-5.3","stream":stream,
            "tools":[{"type":"web_search"},{"type":"function","name":"exec_command","parameters":schema}],
            "input":[{"role":"user","content":"continue the calculation"},
                {"type":"function_call","call_id":"call_old","name":"exec_command","arguments":"{\"value\":1}"},
                {"type":"function_call_output","call_id":"call_old","output":"EXECUTED:2"}]}),
        "/v1/chat/completions" => json!({"model":"gateway.glm-5.3","stream":stream,
            "tools":[{"type":"web_search"},{"type":"function","function":{"name":"exec_command","parameters":schema}}],
            "messages":[{"role":"user","content":"continue the calculation"},
                {"role":"assistant","content":null,"tool_calls":[{"id":"call_old","type":"function",
                    "function":{"name":"exec_command","arguments":"{\"value\":1}"}}]},
                {"role":"tool","tool_call_id":"call_old","content":"EXECUTED:2"}]}),
        "/v1/messages" => json!({"model":"gateway.glm-5.3","stream":stream,"max_tokens":4096,
            "tools":[{"type":"web_search_20250305","name":"web_search"},
                {"name":"exec_command","input_schema":schema}],
            "messages":[{"role":"user","content":[{"type":"text","text":"continue the calculation"}]},
                {"role":"assistant","content":[{"type":"tool_use","id":"call_old","name":"exec_command","input":{"value":1}}]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_old","content":"EXECUTED:2"}]}]}),
        _ => unreachable!(),
    };
    let stdin_schema = json!({"type":"object","properties":{
        "session_id":{"type":"integer"},"yield_time_ms":{"type":"integer"}
    },"required":["session_id"]});
    request["tools"].as_array_mut().unwrap().push(match endpoint {
        "/v1/responses" => json!({"type":"function","name":"write_stdin","parameters":stdin_schema}),
        "/v1/chat/completions" => json!({"type":"function","function":{"name":"write_stdin","parameters":stdin_schema}}),
        "/v1/messages" => json!({"name":"write_stdin","input_schema":stdin_schema}),
        _ => unreachable!(),
    });
    // Match the failing request's large inventory, including names that must
    // retain their identity and schemas through the private wire representation.
    for index in 0..377 {
        let name = format!(
            "mcp__codex_apps__codex_security_cloud___defense_factory_workflow_repositories_{index}"
        );
        request["tools"]
            .as_array_mut()
            .unwrap()
            .push(match endpoint {
                "/v1/responses" => json!({"type":"function","name":name,"parameters":schema}),
                "/v1/chat/completions" => {
                    json!({"type":"function","function":{"name":name,"parameters":schema}})
                }
                "/v1/messages" => json!({"name":name,"input_schema":schema}),
                _ => unreachable!(),
            });
    }
    // A real session can retain calls after its current tool inventory changes.
    // This history must survive without introducing a callable update_plan tool.
    match endpoint {
        "/v1/responses" => request["input"].as_array_mut().unwrap().extend([
            json!({"type":"function_call","call_id":"call_stdin","name":"write_stdin","arguments":"{\"session_id\":71177,\"yield_time_ms\":3000}"}),
            json!({"type":"function_call_output","call_id":"call_stdin","output":"STDIN_COMPLETED"}),
            json!({"type":"function_call","call_id":"call_retired","name":"update_plan","arguments":"{\"plan\":[]}"}),
            json!({"type":"function_call_output","call_id":"call_retired","output":"PLAN_SAVED"}),
        ]),
        "/v1/chat/completions" => request["messages"].as_array_mut().unwrap().extend([
            json!({"role":"assistant","content":null,"tool_calls":[{"id":"call_stdin","type":"function","function":{"name":"write_stdin","arguments":"{\"session_id\":71177,\"yield_time_ms\":3000}"}}]}),
            json!({"role":"tool","tool_call_id":"call_stdin","content":"STDIN_COMPLETED"}),
            json!({"role":"assistant","content":null,"tool_calls":[{"id":"call_retired","type":"function","function":{"name":"update_plan","arguments":"{\"plan\":[]}"}}]}),
            json!({"role":"tool","tool_call_id":"call_retired","content":"PLAN_SAVED"}),
        ]),
        "/v1/messages" => request["messages"].as_array_mut().unwrap().extend([
            json!({"role":"assistant","content":[{"type":"tool_use","id":"call_stdin","name":"write_stdin","input":{"session_id":71177,"yield_time_ms":3000}}]}),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"call_stdin","content":"STDIN_COMPLETED"}]}),
            json!({"role":"assistant","content":[{"type":"tool_use","id":"call_retired","name":"update_plan","input":{"plan":[]}}]}),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"call_retired","content":"PLAN_SAVED"}]}),
        ]),
        _ => unreachable!(),
    }
    request
}

async fn run_round_trip(endpoint: &str, stream: bool, profile: &str, strict: bool) {
    run_round_trip_with_long_call(endpoint, stream, profile, strict, false).await;
}

async fn run_round_trip_with_long_call(endpoint: &str, stream: bool, profile: &str, strict: bool, long_call: bool) {
    let _test_guard = TEST_LOCK.lock().await;
    let _counter_environment = CounterEnvironment::new();
    std::env::set_var("V3_GOAICHAT_BLACKBOX_KEY", "controlled-external-peer");
    let captures = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/v1/messages", post(provider))
        .with_state(Gateway {
            strict,
            long_call,
            captures: captures.clone(),
        });
    let peer = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let handle = spawn_v3_server_aggregate(manifest(free_port(), &upstream, profile))
        .await
        .unwrap();
    let url = format!("http://{}{endpoint}", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let mut payload = request(endpoint, stream);
    let original_call_name = if long_call {
        let name = "mcp__codex_apps__codex_security_cloud___defense_factory_workflow_repositories_0";
        let target = &mut payload["tools"][3];
        match endpoint {
            "/v1/chat/completions" => target["function"]["description"] = json!("long-tool-target"),
            _ => target["description"] = json!("long-tool-target"),
        }
        payload["tool_choice"] = match endpoint {
            "/v1/responses" => json!({"type":"function","name":name}),
            "/v1/chat/completions" => json!({"type":"function","function":{"name":name}}),
            "/v1/messages" => json!({"type":"tool","name":name}),
            _ => unreachable!(),
        };
        name
    } else { "exec_command" };
    let first = client.post(&url).json(&payload).send().await;
    // Always release the server on a red run, before making assertions.
    if first.is_err() {
        handle.shutdown().await;
        peer.abort();
        panic!("first provider attempt must accept hosted tools with history: {first:?}; captures={:?}", captures.lock().await);
    }
    let first = first.unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let wire = first.text().await.unwrap();
    let response: Value = if stream && endpoint == "/v1/messages" {
        assert!(!wire.contains("event: error"), "{wire}");
        let events: Vec<Value> = wire.lines().filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str(data).ok()).collect();
        assert!(events.iter().any(|event| event["type"] == "message_stop"));
        let mut message = events.iter().find(|event| event["type"] == "message_start").unwrap()["message"].clone();
        let mut block = events.iter().find(|event| event["type"] == "content_block_start").unwrap()["content_block"].clone();
        let arguments: String = events.iter().filter_map(|event| event.pointer("/delta/partial_json").and_then(Value::as_str)).collect();
        if !arguments.is_empty() { block["input"] = serde_json::from_str(&arguments).unwrap(); }
        message["content"] = json!([block]);
        message
    } else if stream && endpoint == "/v1/chat/completions" {
        assert!(wire.lines().any(|line| line == "data: [DONE]"), "{wire}");
        let chunks: Vec<Value> = wire.lines().filter_map(|line| line.strip_prefix("data: "))
            .filter(|data| *data != "[DONE]")
            .map(|data| serde_json::from_str(data).expect("valid Chat SSE JSON")).collect();
        assert!(chunks.iter().any(|chunk| chunk.pointer("/choices/0/finish_reason").and_then(Value::as_str) == Some("tool_calls")), "{wire}");
        let calls: Vec<&Value> = chunks.iter().filter_map(|chunk| chunk.pointer("/choices/0/delta/tool_calls/0")).collect();
        let name: String = calls.iter().filter_map(|call| call.pointer("/function/name").and_then(Value::as_str)).collect();
        let arguments: String = calls.iter().filter_map(|call| call.pointer("/function/arguments").and_then(Value::as_str)).collect();
        let id = calls.iter().find_map(|call| call.get("id").and_then(Value::as_str)).expect("tool call id");
        json!({"choices":[{"message":{"role":"assistant","tool_calls":[{"type":"function","id":id,"function":{"name":name,"arguments":arguments}}]}}]})
    } else if stream {
        assert!(
            !wire.contains("response.failed") && !wire.contains("event: error"),
            "{wire}"
        );
        wire.lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str::<Value>(data).ok())
            .find(|event| event["type"] == "response.completed")
            .expect("real Responses terminal event")["response"]
            .clone()
    } else {
        serde_json::from_str(&wire).unwrap()
    };
    let (name, id, arguments) = match endpoint {
        "/v1/responses" => {
            let call = response["output"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["type"] == "function_call")
                .unwrap();
            (
                if let Some(namespace) = call["namespace"].as_str() {
                    json!(format!("{}__{}", namespace.replacen('.', "__", 1), call["name"].as_str().unwrap()))
                } else { call["name"].clone() },
                call["call_id"].clone(),
                serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
            )
        }
        "/v1/chat/completions" => {
            let call = &response["choices"][0]["message"]["tool_calls"][0];
            (
                call["function"]["name"].clone(),
                call["id"].clone(),
                serde_json::from_str::<Value>(call["function"]["arguments"].as_str().unwrap())
                    .unwrap(),
            )
        }
        "/v1/messages" => {
            let call = response["content"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["type"] == "tool_use")
                .unwrap();
            (
                call["name"].clone(),
                call["id"].clone(),
                call["input"].clone(),
            )
        }
        _ => unreachable!(),
    };
    assert_eq!(name, original_call_name, "endpoint={endpoint} stream={stream} response={response}");
    assert_eq!(id, "call_next");
    assert_eq!(arguments, json!({"value":41}));
    // Actual public consumer execution and receipt, then a matching next turn.
    let executed = arguments["value"].as_i64().unwrap() + 1;
    let receipt = format!("EXECUTED:{executed}");
    payload["stream"] = json!(false);
    match endpoint {
        "/v1/responses" => {
            let input = payload["input"].as_array_mut().unwrap();
            input.extend(response["output"].as_array().unwrap().iter().cloned());
            input.push(json!({"type":"function_call_output","call_id":id,"output":receipt}));
        }
        "/v1/chat/completions" => {
            let messages = payload["messages"].as_array_mut().unwrap();
            messages.push(response["choices"][0]["message"].clone());
            messages.push(json!({"role":"tool","tool_call_id":id,"content":receipt}));
        }
        "/v1/messages" => {
            let messages = payload["messages"].as_array_mut().unwrap();
            messages.push(json!({"role":"assistant","content":response["content"]}));
            messages.push(json!({"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":receipt}]}));
        }
        _ => unreachable!(),
    }
    let final_response = client.post(&url).json(&payload).send().await.unwrap();
    assert_eq!(final_response.status(), StatusCode::OK);
    let final_wire = final_response.text().await.unwrap();
    handle.shutdown().await;
    peer.abort();
    assert!(final_wire.contains("receipt accepted:42"), "{final_wire}");
    let captures = captures.lock().await;
    assert_eq!(
        captures.len(),
        2,
        "one accepted provider attempt per client turn; switching/retry must not hide regression"
    );
    for capture in captures.iter() {
        assert_eq!(capture["model"], "glm-5.3");
        let hosted = capture["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["type"] == "web_search_20250305")
            .unwrap();
        assert_eq!(hosted["name"], "web_search");
        assert!(
            hosted.get("function").is_none(),
            "native hosted declaration gained a synthetic function envelope"
        );
        assert_eq!(capture["tools"].as_array().unwrap().len(), 380);
        for tool in capture["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|tool| tool.get("input_schema").is_some())
        {
            assert!(
                tool.get("function").is_none(),
                "ordinary tool gained a private envelope"
            );
            assert!(
                tool.get("type").is_none(),
                "ordinary tool gained another protocol type"
            );
        }
        let native = capture["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "exec_command")
            .unwrap();
        assert_eq!(
            native["input_schema"]["properties"]["value"]["type"],
            "integer"
        );
        let stdin = capture["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "write_stdin")
            .unwrap();
        assert_eq!(stdin["input_schema"]["required"], json!(["session_id"]));
        for index in 0..377 {
            let name = format!("mcp__codex_apps__codex_security_cloud___defense_factory_workflow_repositories_{index}");
            let wire_name = if profile == "anthropic:goaichat" {
                provider_compat_core::namespace_tools::openai_chat_namespace_wire_name(&name)
            } else {
                name.clone()
            };
            assert!(
                capture["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["name"] == wire_name
                        && tool["input_schema"] == native["input_schema"]),
                "lost declaration {name}"
            );
        }
        let blocks: Vec<&Value> = capture["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|message| message["content"].as_array().unwrap())
            .collect();
        assert!(blocks.iter().any(|block| block["type"] == "tool_use"
            && block["id"] == "call_old"
            && block["input"] == json!({"value":1})));
        assert!(blocks.iter().any(|block| block["type"] == "tool_result"
            && block["tool_use_id"] == "call_old"
            && block["content"].to_string().contains("EXECUTED:2")));
        assert!(blocks.iter().any(|block| block["type"] == "tool_use"
            && block["id"] == "call_retired"
            && block["name"] == "update_plan"
            && block["input"] == json!({"plan":[]})));
        assert!(blocks.iter().any(|block| block["type"] == "tool_result"
            && block["tool_use_id"] == "call_retired"
            && block["content"].to_string().contains("PLAN_SAVED")));
        assert!(blocks.iter().any(|block| block["type"] == "tool_use"
            && block["id"] == "call_stdin"
            && block["name"] == "write_stdin"
            && block["input"] == json!({"session_id":71177,"yield_time_ms":3000})));
        assert!(blocks.iter().any(|block| block["type"] == "tool_result"
            && block["tool_use_id"] == "call_stdin"
            && block["content"].to_string().contains("STDIN_COMPLETED")));
    }
    eprintln!("{endpoint} stream={stream} profile={profile}: attempts=2 execution={receipt} followup=accepted");
}

// Stable IDs; the mapped provider-compat gate executes this real HTTP suite.
#[tokio::test]
async fn goaichat_responses_hosted_history_round_trip_blackbox() {
    run_round_trip("/v1/responses", false, "anthropic:goaichat", true).await;
}
#[tokio::test]
async fn goaichat_responses_sse_hosted_history_round_trip_blackbox() {
    run_round_trip("/v1/responses", true, "anthropic:goaichat", true).await;
}
#[tokio::test]
async fn goaichat_chat_hosted_history_round_trip_blackbox() {
    run_round_trip("/v1/chat/completions", false, "anthropic:goaichat", true).await;
}
#[tokio::test]
async fn goaichat_messages_hosted_history_round_trip_blackbox() {
    run_round_trip("/v1/messages", false, "anthropic:goaichat", true).await;
}
#[tokio::test]
async fn generic_glm_anthropic_hosted_history_preserved_blackbox() {
    run_round_trip("/v1/responses", false, "chat:glm", false).await;
}

#[tokio::test]
async fn goaichat_long_flat_names_round_trip_json_and_provider_sse() {
    for (endpoint, stream) in [("/v1/responses", false), ("/v1/responses", true),
        ("/v1/chat/completions", false), ("/v1/chat/completions", true), ("/v1/messages", false), ("/v1/messages", true)] {
        run_round_trip_with_long_call(endpoint, stream, "anthropic:goaichat", true, true).await;
    }
}
