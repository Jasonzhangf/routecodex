// Public HTTP blackbox: a provider-configured responses:deepseek-console-go
// profile must preserve complete tool history and add the reasoning entries
// required by the upstream for every tool segment.
//
// Run: cargo test --locked --manifest-path v3/Cargo.toml \
//   -p routecodex-v3-server --test deepseek_configured_compat_blackbox -- --nocapture

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const PROFILE: &str = "responses:deepseek-console-go";
const AUTH_ENV: &str = "V3_DEEPSEEK_CONFIGURED_COMPAT_KEY";

#[derive(Clone)]
struct UpstreamState {
    captures: mpsc::UnboundedSender<Value>,
}

async fn controlled_upstream(
    State(state): State<Arc<UpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.captures.send(body.clone()).unwrap();

    if let Some(call_id) = missing_reasoning_before_tool_segment(&body) {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "error": {
                        "type": "invalid_request_error",
                        "message": format!(
                            "The reasoning_text in the thinking mode must be passed back to the API for {call_id}."
                        )
                    }
                })
                .to_string(),
            ))
            .unwrap();
    }

    if body["tools"][0]["name"] == "echo_function" {
        let receipt = body["input"].as_array().unwrap().iter().find(|item| {
            item["call_id"] == "call_function" && item["type"] == "function_call_output"
        });
        let output = if let Some(receipt) = receipt {
            json!([{"type":"message", "role":"assistant", "content":[
                {"type":"output_text", "text":receipt["output"], "annotations":[]}
            ]}])
        } else {
            json!([{"type":"function_call", "name":"echo_function", "call_id":"call_function",
                "id":"tool_function", "arguments":"{\"input\":\"FUNCTION_INPUT_OK\"}", "status":"completed"}])
        };
        let response = json!({"id":"resp_function", "object":"response", "status":"completed", "output":output});
        let (content_type, bytes) = if body["stream"] == true {
            let terminal = json!({"type":"response.completed", "response":response});
            (
                "text/event-stream",
                format!("event: response.completed\ndata: {terminal}\n\n"),
            )
        } else {
            ("application/json", response.to_string())
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", content_type)
            .body(Body::from(bytes))
            .unwrap();
    }

    if body["stream"] == true {
        let receipt =
            body["input"].as_array().unwrap().iter().find(|item| {
                item["call_id"] == "call_echo" && item["type"] == "function_call_output"
            });
        let output = if let Some(receipt) = receipt {
            json!([{"type":"message", "role":"assistant", "content":[
                {"type":"output_text", "text":receipt["output"], "annotations":[]}
            ]}])
        } else {
            json!([{"type":"function_call", "name":"echo_custom", "call_id":"call_echo",
                "id":"tool_echo", "arguments":"{\"input\":\"CUSTOM_ECHO_OK\"}", "status":"completed"}])
        };
        // Official Responses may return the call only in this terminal event.
        let terminal = json!({"type":"response.completed", "response":{
            "id":"resp_echo", "object":"response", "status":"completed", "output":output
        }});
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(format!(
                "event: response.completed\ndata: {terminal}\n\n"
            )))
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "resp_configured_deepseek_compat",
                "object": "response",
                "status": "completed",
                "model": body.get("model").cloned().unwrap_or(Value::Null),
                "output": [{
                    "id": "msg_configured_deepseek_compat",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{
                        "type": "output_text",
                        "text": "configured deepseek compat accepted",
                        "annotations": []
                    }]
                }],
                "output_text": "configured deepseek compat accepted"
            })
            .to_string(),
        ))
        .unwrap()
}

fn missing_reasoning_before_tool_segment(body: &Value) -> Option<String> {
    let mut reasoning_seen = false;
    for item in body
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(Value::as_str) {
            Some("message") if item.get("role").and_then(Value::as_str) == Some("user") => {
                reasoning_seen = false;
            }
            Some("reasoning") => {
                reasoning_seen = true;
            }
            Some("function_call" | "custom_tool_call") if !reasoning_seen => {
                return Some(
                    item.get("call_id")
                        .and_then(Value::as_str)
                        .unwrap_or("<missing-call-id>")
                        .to_string(),
                );
            }
            _ => {}
        }
    }
    None
}

fn assert_reasoning_covers_tool_segments(input: &[Value]) {
    for pair in input.windows(2) {
        let output = matches!(
            pair[0].get("type").and_then(Value::as_str),
            Some("function_call_output" | "custom_tool_call_output")
        );
        let next_call = matches!(
            pair[1].get("type").and_then(Value::as_str),
            Some("function_call" | "custom_tool_call")
        );
        assert!(
            !(output && next_call),
            "upstream received an output->call junction without reasoning: {pair:?}"
        );
    }

    for item in input {
        let call_id = match item.get("type").and_then(Value::as_str) {
            Some("function_call" | "custom_tool_call") => item
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or("<missing-call-id>"),
            _ => continue,
        };
        assert!(
            input.iter().any(|candidate| {
                candidate.get("type").and_then(Value::as_str) == Some("reasoning")
                    && candidate
                        .pointer("/content/0/text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.is_empty())
            }),
            "tool segment {call_id} has no non-empty reasoning text"
        );
    }
}

fn assert_preserved_history(upstream_input: &[Value], expected_input: &[Value]) {
    let upstream_without_reasoning = upstream_input
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) != Some("reasoning"))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(
        upstream_without_reasoning, expected_input,
        "the profile must preserve calls, arguments, receipts, and user boundaries"
    );
}

fn assert_one_attempt(captures: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    let capture = captures
        .try_recv()
        .expect("the provider must be called once");
    assert!(
        captures.try_recv().is_err(),
        "a successful shape-compatible request must not switch or retry"
    );
    capture
}

fn request_input(case: &str) -> Value {
    json!([
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": format!("inspect-{case}")}]
        },
        {
            "type": "function_call",
            "call_id": "call_inspect_1",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"pwd\",\"reason\":\"first function receipt\"}"
        },
        {
            "type": "function_call_output",
            "call_id": "call_inspect_1",
            "output": "/tmp/configured-deepseek"
        },
        {
            "type": "function_call",
            "call_id": "call_inspect_2",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"ls\",\"reason\":\"second function receipt\"}"
        },
        {
            "type": "function_call_output",
            "call_id": "call_inspect_2",
            "output": "src tests"
        },
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": format!("apply-{case}")}]
        },
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "applying patch"}]
        },
        {
            "type": "custom_tool_call",
            "call_id": "call_apply_patch",
            "name": "apply_patch",
            "input": "*** Begin Patch\n*** Update File: demo.txt\n@@\n-old\n+new\n*** End Patch"
        },
        {
            "type": "custom_tool_call_output",
            "call_id": "call_apply_patch",
            "output": "Success. Updated demo.txt"
        },
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": format!("continue-{case}")}]
        }
    ])
}

fn manifest(
    server_port: u16,
    upstream_port: u16,
    compatibility_profile: Option<&str>,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("compat");
    let compatibility_profile = compatibility_profile
        .map(|profile| format!("compatibility_profile = \"{profile}\"\n"))
        .unwrap_or_default();
    let source = format!(
        r#"
version = 3
{declaration}
[servers.compat]
bind = "127.0.0.1"
port = {server_port}
routing_group = "compat"
endpoints = ["responses"]
{execution}
[providers.shared_deepseek]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "deepseek-flash"
{compatibility_profile}auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{AUTH_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.shared_deepseek.models."deepseek-flash"]
wire_name = "deepseek-flash"
aliases = ["gpt-5.5"]
capabilities = ["text", "tools", "reasoning"]
supports_streaming = true
supports_thinking = true
thinking = "optional"
max_tokens = 4096
max_context_tokens = 128000
[providers.shared_deepseek.models."deepseek-v4.1-flash"]
wire_name = "deepseek-v4.1-flash"
capabilities = ["text", "tools", "reasoning"]
supports_streaming = true
supports_thinking = true
thinking = "optional"
max_tokens = 4096
max_context_tokens = 128000
[providers.shared_deepseek.models."wb-deepseek-v4.1-flash"]
wire_name = "wb-deepseek-v4.1-flash"
capabilities = ["text", "tools", "reasoning"]
supports_streaming = true
supports_thinking = true
thinking = "optional"
max_tokens = 4096
max_context_tokens = 128000
[providers.shared_deepseek.models."global:deepseek-v4.1-flash-sg"]
wire_name = "global:deepseek-v4.1-flash-sg"
capabilities = ["text", "tools", "reasoning"]
supports_streaming = true
supports_thinking = true
thinking = "optional"
max_tokens = 4096
max_context_tokens = 128000
[route_groups.compat.pools.gpt55]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["gpt-5.5"] }}
targets = [{{ kind = "provider_model", provider = "shared_deepseek", model = "deepseek-flash", key = "key", priority = 1 }}]
[route_groups.compat.pools.v41_flash]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["deepseek-v4.1-flash"] }}
targets = [{{ kind = "provider_model", provider = "shared_deepseek", model = "deepseek-v4.1-flash", key = "key", priority = 1 }}]
[route_groups.compat.pools.wb_v41_flash]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["wb-deepseek-v4.1-flash"] }}
targets = [{{ kind = "provider_model", provider = "shared_deepseek", model = "wb-deepseek-v4.1-flash", key = "key", priority = 1 }}]
[route_groups.compat.pools.global_v41_flash]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["global:deepseek-v4.1-flash-sg"] }}
targets = [{{ kind = "provider_model", provider = "shared_deepseek", model = "global:deepseek-v4.1-flash-sg", key = "key", priority = 1 }}]
[route_groups.compat.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "shared_deepseek", model = "deepseek-flash", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

#[tokio::test]
async fn configured_deepseek_compat_covers_routed_official_and_v41_aliases() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, "configured-deepseek-compat-secret");

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (upstream_shutdown_tx, upstream_shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_upstream))
        .with_state(Arc::new(UpstreamState {
            captures: captures_tx,
        }));
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = upstream_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let handle = spawn_v3_server_aggregate(manifest(
        test_ports::free_port(),
        upstream_addr.port(),
        Some(PROFILE),
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    for (case, requested_model, wire_model) in [
        ("gpt55", "gpt-5.5", "deepseek-flash"),
        ("v41", "deepseek-v4.1-flash", "deepseek-v4.1-flash"),
        ("wb", "wb-deepseek-v4.1-flash", "wb-deepseek-v4.1-flash"),
        (
            "global",
            "global:deepseek-v4.1-flash-sg",
            "global:deepseek-v4.1-flash-sg",
        ),
    ] {
        let input = request_input(case);
        let response = client
            .post(&endpoint)
            .json(&json!({
                "model": requested_model,
                "reasoning": {"effort": "medium"},
                "input": input,
                "stream": false
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "{requested_model}: upstream must accept the first attempt"
        );
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["status"], "completed", "{requested_model}: {body}");

        let capture = assert_one_attempt(&mut captures_rx);
        assert_eq!(capture["model"], wire_model, "{requested_model}");
        let upstream_input = capture["input"].as_array().unwrap();
        assert_reasoning_covers_tool_segments(upstream_input);
        assert_preserved_history(upstream_input, input.as_array().unwrap());
    }

    let initial = json!([{"type":"message", "role":"user", "content":"echo"}]);
    for stream in [false, true] {
        let tools = json!([{"type":"function", "name":"echo_function", "parameters":{
            "type":"object", "properties":{"input":{"type":"string"}}, "required":["input"]
        }}]);
        let response = client
            .post(&endpoint)
            .json(&json!({
                "model":"gpt-5.5", "input":initial, "tools":tools, "stream":stream,
                "reasoning":{"effort":"medium"}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let raw = response.text().await.unwrap();
        let response: Value = if stream {
            serde_json::from_str::<Value>(
                raw.lines()
                    .find_map(|line| line.strip_prefix("data:"))
                    .unwrap(),
            )
            .unwrap()["response"]
                .clone()
        } else {
            serde_json::from_str(&raw).unwrap()
        };
        let call = &response["output"][0];
        assert_eq!(
            call["type"], "function_call",
            "ordinary input parameter must preserve dispatch type: {call}"
        );
        assert_eq!(call["name"], "echo_function");
        assert_eq!(call["call_id"], "call_function");
        let arguments: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
        let result = arguments["input"].as_str().unwrap();
        assert_eq!(result, "FUNCTION_INPUT_OK");
        assert_one_attempt(&mut captures_rx);
        let followup = client
            .post(&endpoint)
            .json(&json!({
                "model":"gpt-5.5", "tools":tools, "stream":stream, "reasoning":{"effort":"medium"}, "input":[initial[0], call,
                    {"type":"function_call_output", "call_id":"call_function", "output":result}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(followup.status(), StatusCode::OK);
        let raw = followup.text().await.unwrap();
        let response: Value = if stream {
            serde_json::from_str::<Value>(
                raw.lines()
                    .find_map(|line| line.strip_prefix("data:"))
                    .unwrap(),
            )
            .unwrap()["response"]
                .clone()
        } else {
            serde_json::from_str(&raw).unwrap()
        };
        assert_eq!(response["output"][0]["content"][0]["text"], result);
        assert_one_attempt(&mut captures_rx);
    }
    let tools = json!([{"type":"custom", "name":"echo_custom"}]);
    let first = client
        .post(&endpoint)
        .json(&json!({
            "model":"gpt-5.5", "input":initial, "tools":tools,
            "stream":true, "reasoning":{"effort":"medium"}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_text = first.text().await.unwrap();
    let terminal: Value = serde_json::from_str(
        first_text
            .lines()
            .find_map(|line| line.strip_prefix("data:"))
            .unwrap(),
    )
    .unwrap();
    let call = &terminal["response"]["output"][0];
    assert_eq!(call["type"], "custom_tool_call");
    assert_eq!(call["name"], "echo_custom");
    assert_eq!(call["call_id"], "call_echo");
    assert_eq!(call["input"], "CUSTOM_ECHO_OK");
    let sent = assert_one_attempt(&mut captures_rx);
    assert_eq!(sent["tools"][0]["type"], "function");
    // The client executes echo using the decoded custom input, then returns its
    // matching receipt through the same public entry.
    let result = call["input"].as_str().unwrap().to_string();
    let followup = client
        .post(&endpoint)
        .json(&json!({
            "model":"gpt-5.5", "tools":tools, "stream":true,
            "reasoning":{"effort":"medium"}, "input":[
                initial[0], call,
                {"type":"custom_tool_call_output", "call_id":"call_echo", "output":result}
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(followup.status(), StatusCode::OK);
    let followup_text = followup.text().await.unwrap();
    let terminal: Value = serde_json::from_str(
        followup_text
            .lines()
            .find_map(|line| line.strip_prefix("data:"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        terminal["response"]["output"][0]["content"][0]["text"],
        "CUSTOM_ECHO_OK"
    );
    let sent = assert_one_attempt(&mut captures_rx);
    let receipt = sent["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .unwrap();
    assert_eq!(receipt["call_id"], "call_echo");
    assert_eq!(receipt["output"], "CUSTOM_ECHO_OK");

    handle.shutdown().await;
    let unconfigured = spawn_v3_server_aggregate(manifest(
        test_ports::free_port(),
        upstream_addr.port(),
        None,
    ))
    .await
    .unwrap();
    let input = request_input("profile-absent");
    let rejected = client
        .post(format!(
            "http://{}/v1/responses",
            unconfigured.listeners[0].addr
        ))
        .json(&json!({"model":"gpt-5.5", "input":input,
            "reasoning":{"effort":"medium"}, "stream":false}))
        .send()
        .await;
    if let Ok(response) = rejected {
        assert!(
            response.status().is_client_error() || response.status().is_server_error(),
            "upstream rejection must not become success"
        );
    }
    let sent = assert_one_attempt(&mut captures_rx);
    assert_eq!(
        sent["input"], input,
        "provider without the profile must preserve the original history"
    );
    unconfigured.shutdown().await;
    upstream_shutdown_tx.send(()).unwrap();
    std::env::remove_var(AUTH_ENV);
}
