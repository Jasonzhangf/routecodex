//! Public HTTP response regression. Run:
//! CARGO_NET_OFFLINE=true cargo test --locked --manifest-path v3/Cargo.toml
//! -p routecodex-v3-server --test no_response_adjudication_blackbox -- --nocapture
//!
//! Native error fixtures are representative protocol fixtures, NOT the QSA
//! sample: its retained body=[] does not identify its original native event.
use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());
const KEY_ENV: &str = "V3_NO_RESPONSE_TEST_KEY";

struct ProviderState {
    status: StatusCode,
    content_type: &'static str,
    body: String,
    captures: mpsc::UnboundedSender<Value>,
}

async fn controlled_upstream(
    State(state): State<Arc<ProviderState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.captures.send(body.clone()).unwrap();
    // Independently pinned candidate: this asserts listener isolation without
    // assuming recovery of the failed provider identity.
    if body["model"] == "wire-independent" {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(response_sse(&text_response("independent ok"))))
            .unwrap();
    }
    Response::builder()
        .status(state.status)
        .header("content-type", state.content_type)
        .body(Body::from(state.body.clone()))
        .unwrap()
}

fn text_response(text: &str) -> Value {
    json!({"id":"resp_control","object":"response","status":"completed","model":"wire-test",
        "output":[{"id":"msg_control","type":"message","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":text,"annotations":[]}]}]})
}

fn sse(event: &str, value: &Value) -> String {
    format!("event: {event}\ndata: {value}\n\n")
}

fn response_sse(response: &Value) -> String {
    let event = if response["status"] == "incomplete" {
        "response.incomplete"
    } else {
        "response.completed"
    };
    sse(event, &json!({"type":event,"response":response}))
}

async fn start_entry(
    kind: &str,
    process: &str,
    status: StatusCode,
    content_type: &'static str,
    body: String,
) -> (
    String,
    V3ServerAggregateHandle,
    mpsc::UnboundedReceiver<Value>,
    oneshot::Sender<()>,
) {
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("public regression requires loopback sockets");
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_upstream))
        .route("/v1/chat/completions", post(controlled_upstream))
        .route("/v1/messages", post(controlled_upstream))
        .with_state(Arc::new(ProviderState {
            status,
            content_type,
            body,
            captures: captures_tx,
        }));
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("a");
    let port = test_ports::free_port();
    // Anthropic's transport appends /v1/messages; Responses and Chat append
    // their endpoint to an API base that already includes /v1.
    let provider_base_url = if kind == "anthropic" {
        format!("http://{upstream_addr}")
    } else {
        format!("http://{upstream_addr}/v1")
    };
    let source = format!(
        r#"
version = 3
{declaration}
[servers.a]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses", "openai_chat", "anthropic"]
{execution}
[providers.test]
type = "{kind}"
base_url = "{provider_base_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "{process}", streaming = "always" }}
[providers.test.models.test]
wire_name = "wire-test"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[providers.independent]
type = "responses"
base_url = "http://{upstream_addr}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always" }}
[providers.independent.models.test]
wire_name = "wire-independent"
capabilities = ["text", "tools"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    (
        format!("http://{}/v1/responses", handle.listeners[0].addr),
        handle,
        captures_rx,
        shutdown_tx,
    )
}

async fn stop_entry(handle: V3ServerAggregateHandle, shutdown: oneshot::Sender<()>) {
    handle.shutdown().await;
    let _ = shutdown.send(());
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap()
}

async fn post_request(
    client: &reqwest::Client,
    endpoint: &str,
    model: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    client.post(endpoint).json(&json!({"model":model,"input":"controlled response regression","stream":true,
        "tools":[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}]})).send().await
}

fn events(body: &str) -> Vec<Value> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim))
        .filter(|data| !data.is_empty() && *data != "[DONE]")
        .map(|data| serde_json::from_str(data).expect("client SSE must preserve valid JSON"))
        .collect()
}

async fn assert_one_attempt(captures: &mut mpsc::UnboundedReceiver<Value>, wire_model: &str) {
    let request = tokio::time::timeout(Duration::from_secs(2), captures.recv())
        .await
        .expect("real upstream attempt")
        .unwrap();
    assert_eq!(request["model"], wire_model);
    assert!(
        matches!(
            captures.try_recv(),
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
        ),
        "exactly one upstream attempt per request"
    );
}

async fn successful_transfer(
    result: Result<reqwest::Response, reqwest::Error>,
) -> (String, String) {
    let response = result.expect("representable response must reach client");
    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response.headers()["content-type"]
        .to_str()
        .unwrap()
        .to_string();
    let body = response
        .text()
        .await
        .expect("successful transfer must finish");
    (content_type, body)
}

async fn successful_body(result: Result<reqwest::Response, reqwest::Error>) -> String {
    let (content_type, body) = successful_transfer(result).await;
    assert!(content_type.starts_with("text/event-stream"));
    assert!(!events(&body).iter().any(|event| matches!(
        event["type"].as_str(),
        Some("error" | "response.failed" | "response.error")
    )));
    body
}

/// Stable RED ID: content_filter and unknown incomplete reasons must survive
/// Direct and explicit Relay, including partial output and the actual reason.
#[tokio::test]
async fn responses_incomplete_semantics_survive_direct_and_relay() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for process in ["direct", "chat"] {
        for reason in [
            "content_filter",
            "provider_specific_reason",
            "max_output_tokens",
        ] {
            let mut expected = text_response("retained partial text");
            expected["status"] = json!("incomplete");
            expected["incomplete_details"] = json!({"reason":reason});
            expected["output"][0]["status"] = json!("incomplete");
            for content_type in ["text/event-stream", "application/json"] {
                let upstream = if content_type == "application/json" {
                    expected.to_string()
                } else {
                    response_sse(&expected)
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("responses", process, StatusCode::OK, content_type, upstream).await;
                let (actual_content_type, body) =
                    successful_transfer(post_request(&client(), &endpoint, "test.test").await)
                        .await;
                stop_entry(handle, shutdown).await;
                assert_one_attempt(&mut captures, "wire-test").await;
                let terminal_response = if actual_content_type.starts_with("application/json") {
                    assert_eq!(process, "direct", "Relay must project the requested SSE");
                    assert_eq!(
                        content_type, "application/json",
                        "Direct preserves upstream framing"
                    );
                    let response: Value = serde_json::from_str(&body).expect("valid client JSON");
                    assert!(
                        response.get("error").is_none(),
                        "no client error envelope: {body}"
                    );
                    response
                } else {
                    assert!(actual_content_type.starts_with("text/event-stream"));
                    let payloads = events(&body);
                    assert!(
                        !payloads.iter().any(|event| matches!(
                            event["type"].as_str(),
                            Some(
                                "error"
                                    | "response.failed"
                                    | "response.error"
                                    | "response.completed"
                            )
                        )),
                        "incomplete cannot become failure or completed: {body}"
                    );
                    payloads
                        .iter()
                        .find(|event| event["type"] == "response.incomplete")
                        .expect("preserve incomplete terminal")["response"]
                        .clone()
                };
                assert_eq!(
                    terminal_response["status"], "incomplete",
                    "{process}/{reason}: {body}"
                );
                assert_eq!(
                    terminal_response["incomplete_details"],
                    expected["incomplete_details"]
                );
                assert_eq!(terminal_response["output"], expected["output"]);
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn responses_refusal_text_and_tool_controls_preserve_output() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let mut refusal = text_response("placeholder");
    refusal["output"][0]["content"] =
        json!([{"type":"refusal","refusal":"provider declined this request"}]);
    let mut tool = text_response("placeholder");
    tool["output"] = json!([{"type":"function_call","id":"fc_control","call_id":"call_control","name":"lookup","arguments":"{\"q\":\"retained\"}","status":"completed"}]);
    for process in ["direct", "chat"] {
        for expected in [&refusal, &text_response("ordinary successful text"), &tool] {
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "responses",
                process,
                StatusCode::OK,
                "text/event-stream",
                response_sse(expected),
            )
            .await;
            let body = successful_body(post_request(&client(), &endpoint, "test.test").await).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            let payloads = events(&body);
            let terminal = payloads
                .iter()
                .find(|event| event["type"] == "response.completed")
                .expect("control completes");
            assert_eq!(
                terminal["response"]["output"], expected["output"],
                "{process}: {body}"
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// Stable public regression ID: Responses-wire refusal and content_filter keep
/// their representable content and terminal semantics on Chat/Anthropic entries.
#[tokio::test]
async fn responses_wire_representation_survives_chat_and_anthropic_entries() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for entry in ["openai_chat", "anthropic"] {
        for streaming in [false, true] {
            for case in [
                "plain",
                "refusal",
                "content_filter",
                "max_output_tokens",
                "provider_specific_reason",
                "missing_details",
                "null_details",
                "empty_reason",
                "numeric_reason",
                "unknown_details",
                "whitespace_reason",
                "empty_completed",
            ] {
                let mut expected = text_response("NATIVE_OK");
                expected["usage"] = json!({"input_tokens":3,"output_tokens":2,"total_tokens":5});
                if case == "refusal" {
                    expected["output"][0]["content"] =
                        json!([{"type":"refusal","refusal":"NATIVE_REFUSAL"}]);
                } else if case != "plain" {
                    expected["status"] = json!("incomplete");
                    expected["incomplete_details"] = json!({"reason":case});
                    match case {
                        "missing_details" => {
                            expected
                                .as_object_mut()
                                .unwrap()
                                .remove("incomplete_details");
                        }
                        "null_details" => expected["incomplete_details"] = Value::Null,
                        "empty_reason" => expected["incomplete_details"] = json!({"reason":""}),
                        "numeric_reason" => expected["incomplete_details"] = json!({"reason":42}),
                        "unknown_details" => {
                            expected["incomplete_details"] = json!({"opaque":true})
                        }
                        "whitespace_reason" => {
                            expected["incomplete_details"] = json!({"reason":" content_filter "})
                        }
                        "empty_completed" => {
                            expected["status"] = json!("completed");
                            expected["output"] = json!([]);
                            expected
                                .as_object_mut()
                                .unwrap()
                                .remove("incomplete_details");
                        }
                        _ => {}
                    }
                }
                // Non-streaming provider requests require JSON. Streaming
                // requests may return either JSON or SSE under the transport contract.
                let upstream_types: &[&str] = if streaming {
                    &["application/json", "text/event-stream"]
                } else {
                    &["application/json"]
                };
                for &upstream_type in upstream_types {
                    let upstream = if upstream_type == "application/json" {
                        expected.to_string()
                    } else {
                        response_sse(&expected)
                    };
                    let (responses_endpoint, handle, mut captures, shutdown) =
                        start_entry("responses", "chat", StatusCode::OK, upstream_type, upstream)
                            .await;
                    let path = if entry == "openai_chat" {
                        "/v1/chat/completions"
                    } else {
                        "/v1/messages"
                    };
                    let endpoint = format!(
                        "{}{path}",
                        responses_endpoint.trim_end_matches("/v1/responses")
                    );
                    let mut request = json!({"model":"test.test", "stream":streaming,
                        "messages":[{"role":"user","content":"representation regression"}]});
                    if entry == "anthropic" {
                        request["max_tokens"] = json!(128);
                    } else if streaming {
                        request["stream_options"] = json!({"include_usage":true});
                    }
                    let (content_type, body) =
                        successful_transfer(client().post(endpoint).json(&request).send().await)
                            .await;
                    stop_entry(handle, shutdown).await;
                    assert_one_attempt(&mut captures, "wire-test").await;
                    assert!(!body.contains("\"error\""), "{entry}/{case}: {body}");
                    let expected_text = if case == "refusal" {
                        "NATIVE_REFUSAL"
                    } else if case == "empty_completed" {
                        ""
                    } else {
                        "NATIVE_OK"
                    };
                    let expected_finish = match (entry, case) {
                        ("openai_chat", "content_filter") => "content_filter",
                        ("openai_chat", "max_output_tokens") => "length",
                        ("openai_chat", _) => "stop",
                        (_, "content_filter") => "refusal",
                        (_, "max_output_tokens") => "max_tokens",
                        _ => "end_turn",
                    };
                    if content_type.starts_with("application/json") {
                        let payload: Value = serde_json::from_str(&body).unwrap();
                        if entry == "openai_chat" {
                            let message = &payload["choices"][0]["message"];
                            assert_eq!(
                                message[if case == "refusal" {
                                    "refusal"
                                } else {
                                    "content"
                                }],
                                expected_text
                            );
                            assert_eq!(payload["choices"][0]["finish_reason"], expected_finish);
                            assert_eq!(payload["id"], "resp_control");
                            assert_eq!(payload["usage"]["prompt_tokens"], 3);
                            assert_eq!(payload["usage"]["completion_tokens"], 2);
                        } else {
                            if case == "empty_completed" {
                                assert_eq!(payload["content"], json!([]));
                            } else {
                                assert_eq!(payload["content"][0]["text"], expected_text);
                            }
                            assert_eq!(payload["stop_reason"], expected_finish);
                            assert_eq!(payload["id"], "msg_control");
                            assert_eq!(payload["usage"]["input_tokens"], 3);
                            assert_eq!(payload["usage"]["output_tokens"], 2);
                        }
                    } else {
                        assert!(content_type.starts_with("text/event-stream"));
                        let payloads = events(&body);
                        if entry == "openai_chat" {
                            let field = if case == "refusal" {
                                "refusal"
                            } else {
                                "content"
                            };
                            let text = payloads
                                .iter()
                                .filter_map(|event| event["choices"][0]["delta"][field].as_str())
                                .collect::<String>();
                            assert_eq!(text, expected_text, "{entry}/{case}: {body}");
                            assert!(payloads.iter().any(|event| event["choices"][0]
                                ["finish_reason"]
                                == expected_finish));
                            assert!(payloads
                                .iter()
                                .any(|event| event["usage"]["prompt_tokens"] == 3
                                    && event["usage"]["completion_tokens"] == 2));
                            assert!(body.contains("data: [DONE]"));
                        } else {
                            let text = payloads
                                .iter()
                                .filter_map(|event| event["delta"]["text"].as_str())
                                .collect::<String>();
                            assert_eq!(text, expected_text, "{entry}/{case}: {body}");
                            assert!(payloads
                                .iter()
                                .any(|event| event["delta"]["stop_reason"] == expected_finish));
                            assert!(payloads.iter().any(|event| event["type"] == "message_stop"));
                            assert!(payloads
                                .iter()
                                .any(|event| event["message"]["usage"]["input_tokens"] == 3));
                        }
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_content_filter_and_refusal_keep_representable_semantics() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let pure_refusal_sse = format!(
        "{}{}data: [DONE]\n\n",
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","refusal":"provider declined this request"},"finish_reason":null}]})
        ),
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]})
        )
    );
    let mixed_refusal_sse = format!(
        "{}{}data: [DONE]\n\n",
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"content":"partial text","refusal":"provider declined this request"},"finish_reason":null}]})
        ),
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]})
        ),
    );
    let refusal_json = json!({"id":"chat_control","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"partial text","refusal":"provider declined this request"},"finish_reason":"content_filter"}]}).to_string();
    for (content_type, upstream, expected_text) in [
        ("text/event-stream", pure_refusal_sse, None),
        ("text/event-stream", mixed_refusal_sse, Some("partial text")),
        ("application/json", refusal_json, Some("partial text")),
    ] {
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "openai_chat",
            "chat",
            StatusCode::OK,
            content_type,
            upstream,
        )
        .await;
        let body = successful_body(post_request(&client(), &endpoint, "test.test").await).await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        let payloads = events(&body);
        let terminal = payloads
            .iter()
            .find(|event| event["type"] == "response.incomplete")
            .expect("content_filter maps to incomplete");
        assert_eq!(
            terminal["response"]["incomplete_details"]["reason"],
            "content_filter"
        );
        assert!(
            terminal["response"]["output"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["content"]
                    .as_array()
                    .is_some_and(|parts| parts.iter().any(|part| part["type"] == "refusal"
                        && part["refusal"] == "provider declined this request"))),
            "retain refusal: {body}"
        );
        assert!(!payloads
            .iter()
            .any(|event| event["type"] == "response.completed"));
        if let Some(expected_text) = expected_text {
            assert!(
                terminal["response"]["output"]
                    .to_string()
                    .contains(expected_text),
                "co-located text must survive: {body}"
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_refusal_remains_provider_output() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let upstream = [
        sse("message_start", &json!({"type":"message_start","message":{"id":"msg_refusal","type":"message","role":"assistant","model":"wire-test","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}})),
        sse("content_block_start", &json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})),
        sse("content_block_delta", &json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"provider declined this request"}})),
        sse("content_block_stop", &json!({"type":"content_block_stop","index":0})),
        sse("message_delta", &json!({"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null},"usage":{"output_tokens":5}})),
        sse("message_stop", &json!({"type":"message_stop"})),
    ].concat();
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "anthropic",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        upstream,
    )
    .await;
    let body = successful_body(post_request(&client(), &endpoint, "test.test").await).await;
    stop_entry(handle, shutdown).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    let payloads = events(&body);
    let terminal = payloads
        .iter()
        .find(|event| event["type"] == "response.incomplete")
        .expect("Anthropic refusal maps to incomplete/content_filter");
    assert!(
        terminal["response"]
            .to_string()
            .contains("provider declined this request"),
        "retain refusal content: {body}"
    );
    assert_eq!(
        terminal["response"]["incomplete_details"]["reason"],
        "content_filter"
    );
    assert!(
        !payloads
            .iter()
            .any(|event| event["type"] == "response.completed"),
        "refusal must not become a completed turn: {body}"
    );
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_sse_preserves_each_responses_output_item_without_repetition() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let message = |text: &str| text_response(text)["output"][0].clone();
    let reasoning =
        json!({"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]});
    let tool = json!({"type":"function_call","call_id":"call_item","name":"lookup","arguments":"{\"q\":\"alpha\"}"});
    for layout in 0..4 {
        let (items, mut upstream, expected, expected_reasoning, has_tool) = match layout {
            0 => (vec![message("body")], String::new(), "body", "", false),
            1 => (
                vec![message("first"), message("second")],
                sse(
                    "response.output_text.delta",
                    &json!({"type":"response.output_text.delta","output_index":0,"delta":"first"}),
                ),
                "firstsecond",
                "",
                false,
            ),
            2 => (
                vec![tool.clone(), message("body")],
                String::new(),
                "body",
                "",
                true,
            ),
            _ => (
                vec![reasoning.clone(), message("body")],
                sse(
                    "response.reasoning_summary_text.delta",
                    &json!({"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"thinking"}),
                ),
                "bodyextra",
                "thinking",
                false,
            ),
        };
        for (index, item) in items.iter().enumerate() {
            upstream.push_str(&sse(
                "response.output_item.done",
                &json!({"type":"response.output_item.done","output_index":index,"item":item}),
            ));
        }
        let mut output = if layout == 0 { vec![] } else { items };
        if layout == 3 {
            output.push(message("extra"));
        }
        upstream.push_str(&response_sse(&json!({"status":"incomplete","output":output,"usage":{"input_tokens":3,"output_tokens":2}})));
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "responses",
            "chat",
            StatusCode::OK,
            "text/event-stream",
            upstream,
        )
        .await;
        let endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
        let response = client().post(&endpoint).json(&json!({"model":"test.test","messages":[{"role":"user","content":"indexed output"}],"stream":true,"stream_options":{"include_usage":true}})).send().await;
        let body = successful_body(response).await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        let frames = events(&body);
        let text = |field: &str| {
            frames
                .iter()
                .filter_map(|frame| frame["choices"][0]["delta"][field].as_str())
                .collect::<String>()
        };
        assert_eq!(text("content"), expected, "layout {layout}: {body}");
        assert_eq!(
            text("reasoning_content"),
            expected_reasoning,
            "layout {layout}: {body}"
        );
        let calls: Vec<_> = frames
            .iter()
            .filter_map(|frame| frame["choices"][0]["delta"]["tool_calls"].as_array())
            .flatten()
            .collect();
        assert_eq!(
            calls.len(),
            usize::from(has_tool),
            "layout {layout}: {body}"
        );
        if has_tool {
            assert_eq!(calls[0]["function"]["arguments"], tool["arguments"]);
        }
        assert!(
            frames
                .iter()
                .any(|frame| frame["choices"][0]["finish_reason"]
                    == if has_tool { "tool_calls" } else { "stop" }),
            "{body}"
        );
        assert!(
            frames
                .iter()
                .any(|frame| frame["usage"]["total_tokens"] == 5),
            "{body}"
        );
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_sse_multiple_reasoning_summary_parts_are_returned_once() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let item = json!({"type":"reasoning","summary":[{"type":"summary_text","text":"A"},{"type":"summary_text","text":"B"}]});
    let upstream = [
        sse("response.reasoning_summary_text.delta", &json!({"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"A"})),
        sse("response.reasoning_summary_text.delta", &json!({"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":1,"delta":"B"})),
        sse("response.output_item.done", &json!({"type":"response.output_item.done","output_index":0,"item":item})),
        response_sse(&json!({"status":"completed","output":[item]})),
    ].concat();
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "responses",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        upstream,
    )
    .await;
    let response = client().post(endpoint.replace("/v1/responses", "/v1/chat/completions")).json(&json!({"model":"test.test","messages":[{"role":"user","content":"summary"}],"stream":true})).send().await;
    let body = successful_body(response).await;
    stop_entry(handle, shutdown).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    assert_eq!(
        events(&body)
            .iter()
            .filter_map(|frame| frame["choices"][0]["delta"]["reasoning_content"].as_str())
            .collect::<String>(),
        "A\nB",
        "{body}"
    );
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_entry_retains_chat_text_and_refusal_together() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let upstream = format!(
        "{}{}data: [DONE]\n\n",
        sse(
            "message",
            &json!({"id":"chat_mixed","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"content":" partial answer ","refusal":" cannot continue ","reasoning_content":" preserved reasoning "},"finish_reason":null}]})
        ),
        sse(
            "message",
            &json!({"id":"chat_mixed","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]})
        )
    );
    for stream in [false, true] {
        let (content_type, wire) = if stream {
            ("text/event-stream", upstream.clone())
        } else {
            ("application/json", json!({"id":"chat_mixed","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":" partial answer ","refusal":" cannot continue ","reasoning_content":" preserved reasoning "},"finish_reason":"content_filter"}]}).to_string())
        };
        let (endpoint, handle, mut captures, shutdown) =
            start_entry("openai_chat", "chat", StatusCode::OK, content_type, wire).await;
        let response = client().post(endpoint.replace("/v1/responses", "/v1/messages")).json(&json!({"model":"test.test","messages":[{"role":"user","content":"mixed refusal"}],"max_tokens":128,"stream":stream})).send().await;
        let (content_type, body) = successful_transfer(response).await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        let text = if content_type.starts_with("application/json") {
            let payload: Value = serde_json::from_str(&body).unwrap();
            payload["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|block| block["text"].as_str())
                .collect::<String>()
        } else {
            events(&body)
                .iter()
                .filter_map(|frame| {
                    frame["delta"]["text"]
                        .as_str()
                        .or_else(|| frame["content_block"]["text"].as_str())
                })
                .collect::<String>()
        };
        assert_eq!(
            text, " partial answer  cannot continue ",
            "stream={stream}: {body}"
        );
        let thinking = if content_type.starts_with("application/json") {
            let payload: Value = serde_json::from_str(&body).unwrap();
            payload["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|block| block["thinking"].as_str())
                .collect::<String>()
        } else {
            events(&body)
                .iter()
                .filter_map(|frame| frame["delta"]["thinking"].as_str())
                .collect::<String>()
        };
        assert_eq!(thinking, " preserved reasoning ", "stream={stream}: {body}");
    }
    std::env::remove_var(KEY_ENV);
}

async fn assert_incomplete_transport(result: Result<reqwest::Response, reqwest::Error>) {
    match result {
        Err(error) => assert!(
            !error.is_timeout() && !error.is_connect(),
            "must terminate admitted request, not time out/connect fail: {error}"
        ),
        Ok(mut response) => {
            assert_eq!(response.status(), StatusCode::OK, "no client HTTP error");
            let mut body = Vec::new();
            let incomplete = loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                    Ok(None) => break false,
                    Err(error) => {
                        assert!(!error.is_timeout(), "failure terminates promptly");
                        break true;
                    }
                }
            };
            let body = String::from_utf8(body).unwrap();
            assert!(
                !body.contains("provider secret error body")
                    && !body.contains("QSA pooled hold")
                    && !body.contains("controlled native error")
                    && !body.contains("response.failed")
                    && !body.contains("response.completed")
                    && !body.contains("event: error")
                    && !body.contains("\"error\""),
                "failure leaked or became fake success: {body}"
            );
            assert!(
                incomplete,
                "terminal failure requires incomplete transfer: {body}"
            );
        }
    }
}

/// HTTP500 and native HTTP200 SSE errors are distinct failure controls. Neither
/// may become a client error or a fabricated completion; independent traffic lives.
#[tokio::test]
async fn genuine_http_and_native_sse_errors_break_transport_without_client_error() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for (kind, process) in [
        ("responses", "direct"),
        ("responses", "chat"),
        ("openai_chat", "chat"),
        ("anthropic", "chat"),
    ] {
        let mut failures = vec![
            (
                StatusCode::BAD_GATEWAY,
                "application/json",
                json!({"error":{"type":"server_error","message":"QSA pooled hold 46846 rows; resizing to 20480 would cut them"}})
                    .to_string(),
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "application/json",
                json!({"error":{"type":"server_error","message":"provider secret error body"}})
                    .to_string(),
            ),
            (
                StatusCode::OK,
                "text/event-stream",
                sse(
                    "error",
                    &json!({"type":"error","error":{"type":"server_error","message":"controlled native error"}}),
                ),
            ),
        ];
        if kind == "responses" {
            failures.push((StatusCode::OK, "text/event-stream", sse("response.failed",
                &json!({"type":"response.failed","response":{"id":"resp_failed","status":"failed","error":{"code":"server_error","message":"controlled native error"},"output":[]}}))));
        } else if kind == "openai_chat" {
            failures.push((
                StatusCode::OK,
                "text/event-stream",
                format!(
                    "data: {}\n\n",
                    json!({"error":{"type":"server_error","message":"controlled native error"}})
                ),
            ));
        }
        for (status, content_type, upstream) in failures {
            let (endpoint, handle, mut captures, shutdown) =
                start_entry(kind, process, status, content_type, upstream).await;
            let client = client();
            assert_incomplete_transport(post_request(&client, &endpoint, "test.test").await).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            let body =
                successful_body(post_request(&client, &endpoint, "independent.test").await).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-independent").await;
            let payloads = events(&body);
            let terminal = payloads
                .iter()
                .find(|event| event["type"] == "response.completed")
                .expect("independent request completes");
            assert_eq!(
                terminal["response"]["output"],
                text_response("independent ok")["output"]
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}
