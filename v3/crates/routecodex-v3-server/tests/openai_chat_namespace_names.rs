use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc, time::Duration};
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

#[tokio::test]
async fn responses_chat_long_namespace_names_round_trip_on_first_attempt_json_and_sse() {
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
