use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
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
    captures: Arc<Mutex<Vec<Value>>>,
}

// External HTTP peer reproduces the observed Goaichat gateway contract. It
// rejects the combined history + hosted shape, rather than blindly returning
// 200 as the historical GLM internal-transport fixture did.
async fn provider(
    State(state): State<Gateway>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
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
    if state.strict
        && historical_call
        && (hosted["function"]["name"] != hosted["name"]
            || !hosted["function"]["parameters"].is_object()
            || mixed_native)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"type":"error","error":{
                "type":"invalid_request_error","message":"invalid function name"
            }})),
        );
    }
    let receipt = blocks.iter().any(|block| {
        block["type"] == "tool_result"
            && block["tool_use_id"] == "call_next"
            && block["content"].to_string().contains("EXECUTED:42")
    });
    let (content, stop) = if receipt {
        (
            json!([{"type":"text","text":"receipt accepted:42"}]),
            "end_turn",
        )
    } else {
        (
            json!([{"type":"tool_use","id":"call_next","name":"exec_command",
            "input":{"value":41}}]),
            "tool_use",
        )
    };
    (
        StatusCode::OK,
        Json(
            json!({"id":"msg_gateway","type":"message","role":"assistant",
        "model":"glm-5.3","content":content,"stop_reason":stop,
        "usage":{"input_tokens":20,"output_tokens":8}}),
        ),
    )
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
    // not be truncated or replaced just because the hosted profile is active.
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
    let response: Value = if stream {
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
                call["name"].clone(),
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
    assert_eq!(name, "exec_command");
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
            assert!(
                capture["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["name"] == name
                        && tool["input_schema"] == native["input_schema"]),
                "lost declaration {name}"
            );
        }
        if strict {
            assert_eq!(
                hosted["function"],
                json!({"name":"web_search","parameters":{}})
            );
        } else {
            assert!(
                hosted.get("function").is_none(),
                "generic Anthropic must remain standard"
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
