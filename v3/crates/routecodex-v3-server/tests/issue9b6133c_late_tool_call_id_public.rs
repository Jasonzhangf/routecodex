//! Public-entry regression for OpenAI Chat tool-call IDs that arrive late.
//!
//! The controlled upstream emits two interleaved tool calls. Their names and
//! argument fragments arrive before their IDs. The upstream accepts a follow-up
//! only when the submitted history contains the complete calls and their local
//! execution results.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use futures_util::stream;
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{collections::VecDeque, convert::Infallible, net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot, Mutex},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

use test_home::ServerTestLock;

static TEST_LOCK: ServerTestLock = ServerTestLock::new();
const PROVIDER_KEY_ENV: &str = "LATE_TOOL_CALL_ID_PUBLIC_KEY";
const CLIENT_MODEL: &str = "late-tool-id-client";
const WIRE_MODEL: &str = "late-tool-id-wire";
const ADD_NAME: &str = "late_add";
const JOIN_NAME: &str = "late_join";
const ADD_CALL_ID: &str = "call_late_add";
const JOIN_CALL_ID: &str = "call_late_join";
const ADD_ARGUMENTS: &str = r#"{"a":17,"b":25}"#;
const JOIN_ARGUMENTS: &str = r#"{"left":"late","right":"id"}"#;

#[derive(Debug)]
struct ProviderCapture {
    body: Value,
    rejection: Option<String>,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
    plans: Arc<Mutex<VecDeque<Vec<String>>>>,
}

fn chat_frame(delta: Value, finish_reason: Option<&str>) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id":"chatcmpl_late_tool_id",
            "object":"chat.completion.chunk",
            "created":1,
            "model":WIRE_MODEL,
            "choices":[{"index":0,"delta":delta,"finish_reason":finish_reason}]
        })
    )
}

fn first_plan() -> Vec<String> {
    vec![
        chat_frame(
            json!({"tool_calls":[
                {"index":0,"function":{"name":ADD_NAME,"arguments":""}},
                {"index":0,"function":{"name":JOIN_NAME,"arguments":""}}
            ]}),
            None,
        ),
        chat_frame(
            json!({"tool_calls":[
                {"index":0,"id":ADD_CALL_ID,"type":"function","function":{"name":ADD_NAME,"arguments":ADD_ARGUMENTS}},
                {"index":0,"id":JOIN_CALL_ID,"type":"function","function":{"name":JOIN_NAME,"arguments":JOIN_ARGUMENTS}}
            ]}),
            None,
        ),
        chat_frame(json!({}), Some("tool_calls")),
        "data: [DONE]\n\n".to_owned(),
    ]
}

fn second_plan() -> Vec<String> {
    vec![
        chat_frame(
            json!({"role":"assistant","content":"both tools matched"}),
            None,
        ),
        chat_frame(json!({}), Some("stop")),
        "data: [DONE]\n\n".to_owned(),
    ]
}

fn expected_tool_history() -> Value {
    json!([
        {"role":"assistant","tool_calls":[
            {
                "id":ADD_CALL_ID,
                "type":"function",
                "function":{"name":ADD_NAME,"arguments":ADD_ARGUMENTS}
            },
            {
                "id":JOIN_CALL_ID,
                "type":"function",
                "function":{"name":JOIN_NAME,"arguments":JOIN_ARGUMENTS}
            }
        ]},
        {"role":"tool","tool_call_id":ADD_CALL_ID,"content":"42"},
        {"role":"tool","tool_call_id":JOIN_CALL_ID,"content":"late id"}
    ])
}

fn submitted_tool_history(body: &Value) -> Value {
    Value::Array(
        body["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|message| {
                message.get("tool_calls").is_some()
                    || (message.get("role").and_then(Value::as_str) == Some("tool")
                        && message.get("tool_call_id").is_some())
            })
            .cloned()
            .collect(),
    )
}

fn validate_followup(body: &Value) -> Result<(), String> {
    if body["tool_choice"] != "none" {
        return Ok(());
    }
    if submitted_tool_history(body) != expected_tool_history() {
        return Err(format!(
            "controlled upstream history mismatch; submitted={}; expected={}",
            serde_json::to_string(&body["messages"]).unwrap(),
            expected_tool_history()
        ));
    }
    Ok(())
}

async fn upstream(State(state): State<ProviderState>, Json(body): Json<Value>) -> Response<Body> {
    let rejection = validate_followup(&body).err();
    let _ = state
        .captures
        .send(ProviderCapture {
            body: body.clone(),
            rejection: rejection.clone(),
        })
        .expect("provider request capture");
    if let Some(error) = rejection {
        eprintln!("LATE_TOOL_ID_FIXTURE_REJECTION={error}");
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(json!({"error":{"message":error}}).to_string()))
            .expect("controlled upstream error response");
    }

    let frames = state
        .plans
        .lock()
        .await
        .pop_front()
        .unwrap_or_else(second_plan);
    let frames = stream::unfold(
        (frames.into_iter(), 0_usize),
        |(mut frames, index)| async move {
            let Some(frame) = frames.next() else {
                return None;
            };
            if index > 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Some((Ok::<_, Infallible>(frame.into_bytes()), (frames, index + 1)))
        },
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(frames))
        .expect("controlled upstream SSE response")
}

async fn start_upstream() -> (
    SocketAddr,
    mpsc::UnboundedReceiver<ProviderCapture>,
    oneshot::Sender<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown, shutdown_rx) = oneshot::channel();
    let state = ProviderState {
        captures: captures_tx,
        plans: Arc::new(Mutex::new(VecDeque::from([first_plan(), second_plan()]))),
    };
    tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/chat/completions", post(upstream))
                .with_state(state),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
        .unwrap();
    });
    (address, captures_rx, shutdown)
}

fn manifest(upstream: SocketAddr) -> V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let declaration =
        hub_v1_fixture::hub_v1_test_declaration().replace(direct_binding, relay_binding);
    let execution = format!(
        "{}\nattempt_store = {{ residence_timeout_ms = 5000 }}\n",
        hub_v1_fixture::hub_v1_server_execution("owned")
    );
    let port = test_ports::free_port();
    let source = format!(
        r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
[providers.relay]
type = "openai_chat"
base_url = "http://{upstream}/v1"
default_model = "{WIRE_MODEL}"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}
request_timeout_ms = 10000
sse_first_frame_timeout_ms = 10000
[providers.relay.models.{WIRE_MODEL}]
wire_name = "{WIRE_MODEL}"
aliases = ["{CLIENT_MODEL}"]
capabilities = ["text","tools"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "relay", model = "{WIRE_MODEL}", key = "controlled", priority = 1 }}]
[debug]
log_console = false
snapshots = true
"#,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn client_tools() -> Value {
    json!([
        {
            "type":"function",
            "name":ADD_NAME,
            "description":"Return the sum of a and b.",
            "parameters":{
                "type":"object",
                "properties":{"a":{"type":"integer"},"b":{"type":"integer"}},
                "required":["a","b"],
                "additionalProperties":false
            }
        },
        {
            "type":"function",
            "name":JOIN_NAME,
            "description":"Join left and right with one space.",
            "parameters":{
                "type":"object",
                "properties":{"left":{"type":"string"},"right":{"type":"string"}},
                "required":["left","right"],
                "additionalProperties":false
            }
        }
    ])
}

fn execute_local_tool(name: &str, arguments: &str) -> String {
    let arguments: Value = serde_json::from_str(arguments)
        .unwrap_or_else(|error| panic!("tool arguments must be complete JSON: {error}"));
    match name {
        ADD_NAME => {
            let a = arguments["a"].as_i64().expect("add a");
            let b = arguments["b"].as_i64().expect("add b");
            (a + b).to_string()
        }
        JOIN_NAME => {
            let left = arguments["left"].as_str().expect("join left");
            let right = arguments["right"].as_str().expect("join right");
            format!("{left} {right}")
        }
        other => panic!("unexpected tool name: {other}"),
    }
}

fn response_sse_events(body: &str) -> Vec<Value> {
    body.split("\n\n")
        .filter_map(|event| {
            let payload = event
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim))
                .collect::<Vec<_>>()
                .join("\n");
            (!payload.is_empty())
                .then(|| serde_json::from_str(&payload).ok())
                .flatten()
        })
        .collect()
}

fn completed_response(events: &[Value]) -> &Value {
    events
        .iter()
        .rev()
        .find(|event| event["type"] == "response.completed")
        .and_then(|event| event.get("response"))
        .expect("client response must complete")
}

fn function_calls(response: &Value) -> Vec<&Value> {
    response["output"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "function_call")
        .collect()
}

fn assert_delivered_calls(response: &Value) {
    let calls = function_calls(response);
    assert_eq!(calls.len(), 2, "client must receive both calls: {response}");
    let add = calls
        .iter()
        .find(|call| call["call_id"] == ADD_CALL_ID)
        .expect("late add ID must reach the client");
    let join = calls
        .iter()
        .find(|call| call["call_id"] == JOIN_CALL_ID)
        .expect("late join ID must reach the client");
    assert_eq!(add["name"], ADD_NAME);
    assert_eq!(add["arguments"], json!(ADD_ARGUMENTS));
    assert_eq!(join["name"], JOIN_NAME);
    assert_eq!(join["arguments"], json!(JOIN_ARGUMENTS));
}

async fn request_answer(client: &reqwest::Client, endpoint: &str, body: Value) -> String {
    let response = tokio::time::timeout(Duration::from_secs(10), async {
        client
            .post(endpoint)
            .header("X-Session-Id", "late-tool-id-public")
            .json(&body)
            .send()
            .await
    })
    .await
    .expect("public request must finish")
    .expect("public response must be received");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::OK,
        "public response must be HTTP 200"
    );
    assert!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .starts_with("text/event-stream"),
        "the Responses client requested SSE"
    );
    tokio::time::timeout(Duration::from_secs(10), response.text())
        .await
        .expect("client SSE body must finish")
        .expect("client SSE body must decode")
}

async fn received_capture(
    captures: &mut mpsc::UnboundedReceiver<ProviderCapture>,
    label: &str,
) -> ProviderCapture {
    tokio::time::timeout(Duration::from_secs(10), captures.recv())
        .await
        .unwrap_or_else(|_| panic!("the controlled upstream must receive the {label} request"))
        .expect("the controlled upstream capture channel must remain open")
}

#[tokio::test]
async fn responses_relay_preserves_late_tool_call_ids_through_execution_and_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(PROVIDER_KEY_ENV, "owned-fixture-key");
    let (upstream, mut captures, upstream_shutdown) = start_upstream().await;
    let handle = spawn_v3_server_aggregate(manifest(upstream)).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::new();

    let request = json!({
        "model":CLIENT_MODEL,
        "stream":true,
        "input":[{"role":"user","content":[
            {"type":"input_text","text":"Call both tools."}
        ]}],
        "tools":client_tools(),
        "tool_choice":"auto"
    });
    let first_body = request_answer(&client, &endpoint, request).await;
    let first_upstream = received_capture(&mut captures, "first").await;
    assert_eq!(first_upstream.body["stream"], json!(true));
    eprintln!("LATE_TOOL_ID_UPSTREAM_RAW_FIRST={}", first_plan().concat());
    eprintln!("LATE_TOOL_ID_CLIENT_RAW_FIRST={first_body}");

    let first_events = response_sse_events(&first_body);
    let first_response = completed_response(&first_events);
    assert_delivered_calls(first_response);

    let add_call = function_calls(first_response)
        .into_iter()
        .find(|call| call["call_id"] == ADD_CALL_ID)
        .expect("add call");
    let join_call = function_calls(first_response)
        .into_iter()
        .find(|call| call["call_id"] == JOIN_CALL_ID)
        .expect("join call");
    let add_output = execute_local_tool(
        add_call["name"].as_str().expect("add name"),
        add_call["arguments"].as_str().expect("add arguments"),
    );
    let join_output = execute_local_tool(
        join_call["name"].as_str().expect("join name"),
        join_call["arguments"].as_str().expect("join arguments"),
    );
    assert_eq!(add_output, "42");
    assert_eq!(join_output, "late id");

    let mismatched_followup = json!({
        "model":CLIENT_MODEL,
        "stream":true,
        "input":[
            {"type":"function_call","call_id":ADD_CALL_ID,"name":ADD_NAME,"arguments":ADD_ARGUMENTS},
            {"type":"function_call","call_id":JOIN_CALL_ID,"name":JOIN_NAME,"arguments":JOIN_ARGUMENTS},
            {"type":"function_call_output","call_id":ADD_CALL_ID,"output":add_output},
            {"type":"function_call_output","call_id":JOIN_CALL_ID,"output":"wrong late id"}
        ],
        "tools":client_tools(),
        "tool_choice":"none"
    });
    let rejected_response = client
        .post(&endpoint)
        .header("X-Session-Id", "late-tool-id-public-mismatch")
        .json(&mismatched_followup)
        .send()
        .await
        .expect("mismatched follow-up must reach the public entry");
    assert_eq!(rejected_response.status(), reqwest::StatusCode::OK);
    assert!(
        rejected_response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .starts_with("text/event-stream"),
        "mismatched follow-up must use the client SSE boundary"
    );
    let rejected_body = tokio::time::timeout(Duration::from_secs(10), rejected_response.text())
        .await
        .expect("mismatched follow-up must settle");
    let rejected_body = rejected_body.unwrap_or_else(|error| error.to_string());
    assert!(
        !rejected_body.contains("response.completed")
            && !rejected_body.contains("controlled upstream history mismatch"),
        "mismatched follow-up must not complete or expose the provider rejection: {rejected_body}"
    );
    let rejected_upstream = received_capture(&mut captures, "mismatched follow-up").await;
    assert!(
        rejected_upstream
            .rejection
            .as_deref()
            .is_some_and(|reason| reason.contains("controlled upstream history mismatch")),
        "controlled provider must reject mismatched paired tool history"
    );
    let mut expected_mismatched_history = expected_tool_history();
    expected_mismatched_history[2]["content"] = json!("wrong late id");
    assert_eq!(
        submitted_tool_history(&rejected_upstream.body),
        expected_mismatched_history,
        "the provider must receive the non-empty history with the mismatched result"
    );

    let followup = json!({
        "model":CLIENT_MODEL,
        "stream":true,
        "input":[
            {"type":"function_call","call_id":ADD_CALL_ID,"name":ADD_NAME,"arguments":ADD_ARGUMENTS},
            {"type":"function_call","call_id":JOIN_CALL_ID,"name":JOIN_NAME,"arguments":JOIN_ARGUMENTS},
            {"type":"function_call_output","call_id":ADD_CALL_ID,"output":add_output},
            {"type":"function_call_output","call_id":JOIN_CALL_ID,"output":join_output}
        ],
        "tools":client_tools(),
        "tool_choice":"none"
    });
    let second_body = request_answer(&client, &endpoint, followup).await;
    let second_upstream = received_capture(&mut captures, "follow-up").await;
    assert!(
        second_upstream.rejection.is_none(),
        "the complete paired history must be accepted by the controlled upstream"
    );
    assert_eq!(
        submitted_tool_history(&second_upstream.body),
        expected_tool_history()
    );
    eprintln!("LATE_TOOL_ID_UPSTREAM_RAW_SECOND={}", second_upstream.body);

    let second_events = response_sse_events(&second_body);
    let second_response = completed_response(&second_events);
    let answer = second_response["output"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "output_text")
        .filter_map(|part| part["text"].as_str())
        .collect::<String>();
    assert_eq!(answer, "both tools matched", "{second_response}");

    assert!(
        tokio::time::timeout(Duration::from_millis(150), captures.recv())
            .await
            .is_err(),
        "unexpected extra provider request"
    );
    handle.shutdown().await;
    let _ = upstream_shutdown.send(());
    std::env::remove_var(PROVIDER_KEY_ENV);
}
