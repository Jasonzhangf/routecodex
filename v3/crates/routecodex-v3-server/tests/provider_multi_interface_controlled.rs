use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    response::Response,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{net::TcpListener, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug)]
struct ProviderCapture {
    path: String,
    body: Value,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

async fn controlled_responses_upstream(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            path: uri.path().to_string(),
            body: body.clone(),
        })
        .unwrap();

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"id":"resp_direct_interface","status":"completed","output_text":"direct-interface","output":[{"type":"output_text","text":"direct-interface"}]}"#,
        ))
        .unwrap()
}

async fn controlled_responses_failure_upstream(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            path: uri.path().to_string(),
            body: body.clone(),
        })
        .unwrap();

    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"error":{"type":"server_error","message":"controlled sibling failure"}}"#,
        ))
        .unwrap()
}

async fn controlled_openai_chat_upstream(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            path: uri.path().to_string(),
            body: body.clone(),
        })
        .unwrap();

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "id": "chatcmpl_multi_interface",
                "object": "chat.completion",
                "model": "wire-model",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "relay-interface"},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
            }))
            .unwrap(),
        ))
        .unwrap()
}

const INVALID_TOOL_ARGUMENTS: &str = r#"{"q":"unterminated"#;
const TOOL_NAMESPACE: &str = "functions";
const TOOL_NAME: &str = "lookup";
const CHAT_PROVIDER_TOOL_NAME: &str = "functions__lookup";

fn controlled_json_response(value: Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap()
}

async fn controlled_responses_tool_upstream(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            path: uri.path().to_string(),
            body: body.clone(),
        })
        .unwrap();

    let is_follow_up = body["input"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["type"] == "function_call_output")
    });
    if is_follow_up {
        return controlled_json_response(json!({
            "id": "resp_direct_tool_follow_up",
            "status": "completed",
            "output_text": "direct-follow-up",
            "output": [{"type": "output_text", "text": "direct-follow-up"}]
        }));
    }

    controlled_json_response(json!({
        "id": "resp_direct_tool_call",
        "status": "requires_action",
        "output": [{
            "type": "function_call",
            "id": "fc_direct_invalid_arguments",
            "call_id": "call_direct_invalid_arguments",
            "namespace": TOOL_NAMESPACE,
            "name": TOOL_NAME,
            "arguments": INVALID_TOOL_ARGUMENTS
        }]
    }))
}

async fn controlled_openai_chat_tool_upstream(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            path: uri.path().to_string(),
            body: body.clone(),
        })
        .unwrap();

    let is_follow_up = body["messages"]
        .as_array()
        .is_some_and(|messages| messages.iter().any(|message| message["role"] == "tool"));
    if is_follow_up {
        return controlled_json_response(json!({
            "id": "chatcmpl_relay_tool_follow_up",
            "object": "chat.completion",
            "model": "wire-model",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "relay-follow-up"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
        }));
    }

    controlled_json_response(json!({
        "id": "chatcmpl_relay_tool_call",
        "object": "chat.completion",
        "model": "wire-model",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_relay_invalid_arguments",
                    "type": "function",
                    "function": {
                        "name": CHAT_PROVIDER_TOOL_NAME,
                        "arguments": INVALID_TOOL_ARGUMENTS
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
    }))
}

fn client_events(body: &str) -> Vec<Value> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim))
        .filter(|data| !data.is_empty() && *data != "[DONE]")
        .map(|data| serde_json::from_str(data).expect("client SSE must carry valid JSON"))
        .collect()
}

async fn next_provider_capture(
    captures: &mut mpsc::UnboundedReceiver<ProviderCapture>,
    label: &str,
) -> ProviderCapture {
    tokio::time::timeout(Duration::from_secs(2), captures.recv())
        .await
        .unwrap_or_else(|_| panic!("{label} provider request must arrive"))
        .unwrap_or_else(|| panic!("{label} provider capture channel must remain open"))
}

#[tokio::test]
async fn responses_entry_routes_pinned_interfaces_to_independent_endpoints() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_MULTI_INTERFACE_KEY", "controlled-multi-secret");

    let responses_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let responses_addr = responses_listener.local_addr().unwrap();
    let chat_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let chat_addr = chat_listener.local_addr().unwrap();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let provider_state = Arc::new(ProviderState {
        captures: captures_tx,
    });
    let (responses_shutdown_tx, responses_shutdown_rx) = oneshot::channel();
    let (chat_shutdown_tx, chat_shutdown_rx) = oneshot::channel();

    let responses_app = Router::new()
        .route("/v1/responses", post(controlled_responses_upstream))
        .with_state(Arc::clone(&provider_state));
    tokio::spawn(async move {
        axum::serve(responses_listener, responses_app)
            .with_graceful_shutdown(async move {
                let _ = responses_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let chat_app = Router::new()
        .route(
            "/v1/chat/completions",
            post(controlled_openai_chat_upstream),
        )
        .with_state(provider_state);
    tokio::spawn(async move {
        axum::serve(chat_listener, chat_app)
            .with_graceful_shutdown(async move {
                let _ = chat_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        responses_addr.port(),
        chat_addr.port(),
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let chat_endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);
    let client = reqwest::Client::new();

    let direct_response = client
        .post(&endpoint)
        .json(&json!({
            "model": "direct-client",
            "input": "direct request"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(direct_response.status(), StatusCode::OK);
    let direct_body: Value = direct_response.json().await.unwrap();
    assert_eq!(direct_body["output_text"], "direct-interface");
    let direct_capture = tokio::time::timeout(Duration::from_secs(2), captures_rx.recv())
        .await
        .expect("direct interface request must reach the responses endpoint")
        .unwrap();
    assert_eq!(direct_capture.path, "/v1/responses");
    assert_eq!(direct_capture.body["model"], "wire-model");

    let relay_response = client
        .post(&chat_endpoint)
        .json(&json!({
            "model": "relay-client",
            "messages": [{"role": "user", "content": "relay request"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(relay_response.status(), StatusCode::OK);
    let relay_body: Value = relay_response.json().await.unwrap();
    assert_eq!(
        relay_body["choices"][0]["message"]["content"],
        "relay-interface"
    );
    let relay_capture = tokio::time::timeout(Duration::from_secs(2), captures_rx.recv())
        .await
        .expect("relay interface request must reach the chat endpoint")
        .unwrap();
    assert_eq!(relay_capture.path, "/v1/chat/completions");
    assert_eq!(relay_capture.body["model"], "wire-model");
    assert_eq!(
        relay_capture.body["messages"][0]["content"],
        "relay request"
    );

    let logs: Value = client
        .get(format!(
            "http://{}/_routecodex/debug/logs",
            handle.listeners[0].addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let execution_modes = logs["logs"]
        .as_array()
        .expect("debug logs array")
        .iter()
        .filter(|event| event["node_id"] == "V3Server03HttpRequestRaw")
        .filter_map(|event| event["details"]["execution_mode"].as_str())
        .collect::<Vec<_>>();
    assert!(
        execution_modes.contains(&"direct"),
        "responses interface request must resolve Direct: {execution_modes:?}"
    );
    assert!(
        execution_modes.contains(&"relay"),
        "chat interface request must resolve Relay: {execution_modes:?}"
    );

    handle.shutdown().await;
    responses_shutdown_tx.send(()).unwrap();
    chat_shutdown_tx.send(()).unwrap();
    std::env::remove_var("V3_MULTI_INTERFACE_KEY");
}

#[tokio::test]
async fn responses_entry_reselects_sibling_interface_and_preserves_sibling_health() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(
        "V3_MULTI_INTERFACE_FAILURE_KEY",
        "controlled-multi-failure-secret",
    );

    let failure_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let failure_addr = failure_listener.local_addr().unwrap();
    let success_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let success_addr = success_listener.local_addr().unwrap();
    let (failure_tx, mut failure_rx) = mpsc::unbounded_channel();
    let (success_tx, mut success_rx) = mpsc::unbounded_channel();
    let failure_state = Arc::new(ProviderState {
        captures: failure_tx,
    });
    let success_state = Arc::new(ProviderState {
        captures: success_tx,
    });
    let (failure_shutdown_tx, failure_shutdown_rx) = oneshot::channel();
    let (success_shutdown_tx, success_shutdown_rx) = oneshot::channel();

    let failure_app = Router::new()
        .route("/v1/responses", post(controlled_responses_failure_upstream))
        .with_state(failure_state);
    tokio::spawn(async move {
        axum::serve(failure_listener, failure_app)
            .with_graceful_shutdown(async move {
                let _ = failure_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let success_app = Router::new()
        .route("/v1/responses", post(controlled_responses_upstream))
        .with_state(success_state);
    tokio::spawn(async move {
        axum::serve(success_listener, success_app)
            .with_graceful_shutdown(async move {
                let _ = success_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let handle = spawn_v3_server_aggregate(multi_interface_failure_manifest(
        free_port(),
        failure_addr.port(),
        success_addr.port(),
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::new();

    let first_response = client
        .post(&endpoint)
        .json(&json!({
            "model": "direct-client",
            "input": "reselect sibling"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first_response.status(), StatusCode::OK);
    let first_body: Value = first_response.json().await.unwrap();
    assert_eq!(first_body["output_text"], "direct-interface");

    let failure_capture = tokio::time::timeout(Duration::from_secs(2), failure_rx.recv())
        .await
        .expect("the failed interface must be attempted")
        .unwrap();
    assert_eq!(failure_capture.path, "/v1/responses");
    let success_capture = tokio::time::timeout(Duration::from_secs(2), success_rx.recv())
        .await
        .expect("the sibling interface must receive the reselected request")
        .unwrap();
    assert_eq!(success_capture.path, "/v1/responses");

    let pool: Value = client
        .get(format!(
            "http://{}/_routecodex/health/cooldown-pool",
            handle.listeners[0].addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entries = pool["entries"].as_array().expect("cooldown entries");
    assert!(
        entries
            .iter()
            .any(|entry| { entry["provider_id"] == "multi" && entry["interface_id"] == "failure" }),
        "the failed interface must remain cooled: {entries:?}"
    );
    assert!(
        entries.iter().all(|entry| {
            !(entry["provider_id"] == "multi" && entry["interface_id"] == "success")
        }),
        "the successful sibling interface must not inherit the failure cooldown: {entries:?}"
    );

    let second_response = client
        .post(&endpoint)
        .json(&json!({
            "model": "direct-client",
            "input": "stay on healthy sibling",
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second_response.status(), StatusCode::OK);
    assert!(
        second_response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream")),
        "streaming requests must keep the SSE client boundary"
    );
    let second_body = second_response.text().await.unwrap();
    assert!(
        second_body.contains("direct-interface"),
        "the SSE response must preserve sibling business output: {second_body}"
    );
    let second_success = tokio::time::timeout(Duration::from_secs(2), success_rx.recv())
        .await
        .expect("the healthy sibling must serve the second request")
        .unwrap();
    assert_eq!(second_success.path, "/v1/responses");
    assert!(
        failure_rx.try_recv().is_err(),
        "the cooled sibling interface must not be retried on the next request"
    );

    handle.shutdown().await;
    failure_shutdown_tx.send(()).unwrap();
    success_shutdown_tx.send(()).unwrap();
    std::env::remove_var("V3_MULTI_INTERFACE_FAILURE_KEY");
}

#[tokio::test]
async fn responses_relay_keeps_business_output_under_http_200_provider_error_policy() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_MULTI_INTERFACE_POLICY_KEY", "controlled-policy-secret");

    let chat_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let chat_addr = chat_listener.local_addr().unwrap();
    let sibling_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let sibling_addr = sibling_listener.local_addr().unwrap();
    let (chat_tx, mut chat_rx) = mpsc::unbounded_channel();
    let (sibling_tx, mut sibling_rx) = mpsc::unbounded_channel();
    let chat_state = Arc::new(ProviderState { captures: chat_tx });
    let sibling_state = Arc::new(ProviderState {
        captures: sibling_tx,
    });
    let (chat_shutdown_tx, chat_shutdown_rx) = oneshot::channel();
    let (sibling_shutdown_tx, sibling_shutdown_rx) = oneshot::channel();

    let chat_app = Router::new()
        .route(
            "/v1/chat/completions",
            post(controlled_openai_chat_upstream),
        )
        .with_state(chat_state);
    tokio::spawn(async move {
        axum::serve(chat_listener, chat_app)
            .with_graceful_shutdown(async move {
                let _ = chat_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let sibling_app = Router::new()
        .route("/v1/responses", post(controlled_responses_upstream))
        .with_state(sibling_state);
    tokio::spawn(async move {
        axum::serve(sibling_listener, sibling_app)
            .with_graceful_shutdown(async move {
                let _ = sibling_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let handle = spawn_v3_server_aggregate(multi_interface_http_200_policy_manifest(
        free_port(),
        chat_addr.port(),
        sibling_addr.port(),
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::new();

    for input in ["business output one", "business output two"] {
        let response = client
            .post(&endpoint)
            .json(&json!({
                "model": "relay-client",
                "input": input
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["output_text"], "relay-interface");
    }

    for expected_input in ["business output one", "business output two"] {
        let capture = tokio::time::timeout(Duration::from_secs(2), chat_rx.recv())
            .await
            .expect("the relay chat interface must serve both requests")
            .unwrap();
        assert_eq!(capture.path, "/v1/chat/completions");
        assert_eq!(capture.body["messages"][0]["content"], expected_input);
    }
    assert!(
        sibling_rx.try_recv().is_err(),
        "a successful business response must not be reclassified as a provider error"
    );

    let pool: Value = client
        .get(format!(
            "http://{}/_routecodex/health/cooldown-pool",
            handle.listeners[0].addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        pool["entries"].as_array().is_some_and(Vec::is_empty),
        "successful business output must not cool the relay interface: {pool}"
    );

    handle.shutdown().await;
    chat_shutdown_tx.send(()).unwrap();
    sibling_shutdown_tx.send(()).unwrap();
    std::env::remove_var("V3_MULTI_INTERFACE_POLICY_KEY");
}

#[tokio::test]
async fn responses_entry_preserves_interface_selected_tool_dispatch_json_and_sse() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_MULTI_INTERFACE_KEY", "controlled-multi-secret");

    let responses_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let responses_addr = responses_listener.local_addr().unwrap();
    let chat_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let chat_addr = chat_listener.local_addr().unwrap();
    let (responses_tx, mut responses_rx) = mpsc::unbounded_channel();
    let (chat_tx, mut chat_rx) = mpsc::unbounded_channel();
    let responses_state = Arc::new(ProviderState {
        captures: responses_tx,
    });
    let chat_state = Arc::new(ProviderState { captures: chat_tx });
    let (responses_shutdown_tx, responses_shutdown_rx) = oneshot::channel();
    let (chat_shutdown_tx, chat_shutdown_rx) = oneshot::channel();

    let responses_app = Router::new()
        .route("/v1/responses", post(controlled_responses_tool_upstream))
        .with_state(responses_state);
    tokio::spawn(async move {
        axum::serve(responses_listener, responses_app)
            .with_graceful_shutdown(async move {
                let _ = responses_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let chat_app = Router::new()
        .route(
            "/v1/chat/completions",
            post(controlled_openai_chat_tool_upstream),
        )
        .with_state(chat_state);
    tokio::spawn(async move {
        axum::serve(chat_listener, chat_app)
            .with_graceful_shutdown(async move {
                let _ = chat_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        responses_addr.port(),
        chat_addr.port(),
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let cases = [
        (
            "direct-json",
            "direct-client",
            false,
            "/v1/responses",
            "call_direct_invalid_arguments",
            "direct-follow-up",
        ),
        (
            "relay-json",
            "relay-client",
            false,
            "/v1/chat/completions",
            "call_relay_invalid_arguments",
            "relay-follow-up",
        ),
        (
            "direct-sse",
            "direct-client",
            true,
            "/v1/responses",
            "call_direct_invalid_arguments",
            "direct-follow-up",
        ),
        (
            "relay-sse",
            "relay-client",
            true,
            "/v1/chat/completions",
            "call_relay_invalid_arguments",
            "relay-follow-up",
        ),
    ];

    for (label, model, stream, expected_path, call_id, expected_final_text) in cases {
        let first = client
            .post(&endpoint)
            .json(&json!({
                "model": model,
                "input": "execute the declared tool",
                "stream": stream,
                "tools": [{
                    "type": "namespace",
                    "name": TOOL_NAMESPACE,
                    "tools": [{
                        "type": "function",
                        "name": TOOL_NAME,
                        "parameters": {
                            "type": "object",
                            "properties": {"q": {"type": "string"}},
                            "required": ["q"]
                        }
                    }]
                }]
            }))
            .send()
            .await
            .unwrap_or_else(|error| panic!("{label}: first request failed: {error}"));
        assert_eq!(first.status(), StatusCode::OK, "{label}");

        let call = if stream {
            let body = first.text().await.unwrap();
            client_events(&body)
                .into_iter()
                .find_map(|event| {
                    (event["type"] == "response.output_item.done"
                        && event["item"]["call_id"] == call_id)
                        .then(|| event["item"].clone())
                })
                .unwrap_or_else(|| panic!("{label} SSE must expose the provider tool call: {body}"))
        } else {
            let body: Value = first.json().await.unwrap();
            body["output"]
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item["call_id"] == call_id)
                        .cloned()
                })
                .unwrap_or_else(|| {
                    panic!("{label} JSON must expose the provider tool call: {body}")
                })
        };
        assert_eq!(call["type"], "function_call", "{label}: {call}");
        assert_eq!(call["namespace"], TOOL_NAMESPACE, "{label}: {call}");
        assert_eq!(call["name"], TOOL_NAME, "{label}: {call}");
        assert_eq!(call["call_id"], call_id, "{label}: {call}");
        assert_eq!(
            call["arguments"], INVALID_TOOL_ARGUMENTS,
            "{label}: invalid provider arguments must be preserved for correction: {call}"
        );

        let parse_error = serde_json::from_str::<Value>(
            call["arguments"]
                .as_str()
                .expect("function call arguments must be a string"),
        )
        .expect_err("the controlled provider arguments must be invalid JSON");
        let execution_error = format!("Tool validation failed: {parse_error}");

        let first_capture = if expected_path == "/v1/responses" {
            next_provider_capture(&mut responses_rx, label).await
        } else {
            next_provider_capture(&mut chat_rx, label).await
        };
        assert_eq!(first_capture.path, expected_path, "{label}");
        assert_eq!(first_capture.body["model"], "wire-model", "{label}");
        if expected_path == "/v1/responses" {
            assert_eq!(
                first_capture.body["tools"][0]["type"], "function",
                "{label}: Responses provider wire must use the flattened function tool"
            );
            assert_eq!(
                first_capture.body["tools"][0]["name"], CHAT_PROVIDER_TOOL_NAME,
                "{label}: Responses provider wire must retain the flattened tool name"
            );
        } else {
            assert_eq!(
                first_capture.body["tools"][0]["function"]["name"], CHAT_PROVIDER_TOOL_NAME,
                "{label}: relay interface must flatten the namespace for Chat wire"
            );
        }

        let follow_up = client
            .post(&endpoint)
            .json(&json!({
                "model": model,
                "stream": stream,
                "input": [
                    {"role": "user", "content": "execute the declared tool"},
                    call,
                    {
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": execution_error.clone()
                    }
                ]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(follow_up.status(), StatusCode::OK, "{label}");

        let second_capture = if expected_path == "/v1/responses" {
            next_provider_capture(&mut responses_rx, label).await
        } else {
            next_provider_capture(&mut chat_rx, label).await
        };
        assert_eq!(second_capture.path, expected_path, "{label}");

        if expected_path == "/v1/responses" {
            let input = second_capture.body["input"]
                .as_array()
                .unwrap_or_else(|| panic!("{label}: provider input must be an array"));
            let provider_call = input
                .iter()
                .find(|item| item["type"] == "function_call" && item["call_id"] == call_id)
                .unwrap_or_else(|| {
                    panic!("{label}: provider follow-up must retain the call: {input:?}")
                });
            assert_eq!(provider_call["name"], CHAT_PROVIDER_TOOL_NAME, "{label}");
            assert_eq!(
                provider_call["arguments"], INVALID_TOOL_ARGUMENTS,
                "{label}: provider follow-up must retain invalid arguments"
            );
            let result = input
                .iter()
                .find(|item| item["type"] == "function_call_output" && item["call_id"] == call_id)
                .unwrap_or_else(|| {
                    panic!("{label}: provider follow-up must retain the result: {input:?}")
                });
            assert_eq!(result["output"], execution_error, "{label}");
        } else {
            let messages = second_capture.body["messages"]
                .as_array()
                .unwrap_or_else(|| panic!("{label}: chat provider messages must be an array"));
            let provider_call = messages
                .iter()
                .filter_map(|message| message["tool_calls"].as_array())
                .flatten()
                .find(|tool_call| tool_call["id"] == call_id)
                .unwrap_or_else(|| {
                    panic!("{label}: chat follow-up must retain the call: {messages:?}")
                });
            assert_eq!(
                provider_call["function"]["name"], CHAT_PROVIDER_TOOL_NAME,
                "{label}"
            );
            assert_eq!(
                provider_call["function"]["arguments"], INVALID_TOOL_ARGUMENTS,
                "{label}: chat follow-up must retain invalid arguments"
            );
            let result = messages
                .iter()
                .find(|message| message["role"] == "tool" && message["tool_call_id"] == call_id)
                .unwrap_or_else(|| {
                    panic!("{label}: chat follow-up must retain the result: {messages:?}")
                });
            assert_eq!(result["content"], execution_error, "{label}");
        }

        if stream {
            let body = follow_up.text().await.unwrap();
            assert!(
                body.contains(expected_final_text),
                "{label}: follow-up SSE must carry the final provider text: {body}"
            );
        } else {
            let body: Value = follow_up.json().await.unwrap();
            assert_eq!(
                body["output_text"], expected_final_text,
                "{label}: follow-up JSON must carry the final provider text"
            );
        }
    }

    handle.shutdown().await;
    responses_shutdown_tx.send(()).unwrap();
    chat_shutdown_tx.send(()).unwrap();
    std::env::remove_var("V3_MULTI_INTERFACE_KEY");
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn manifest(
    server_port: u16,
    responses_port: u16,
    chat_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let relay_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#;
    let hub_v1_declaration = hub_v1_test_declaration().replace(
        r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#,
        relay_binding,
    );
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.controlled]
bind = "127.0.0.1"
port = {server_port}
routing_group = "controlled"
endpoints = ["responses", "openai_chat"]

{server_execution}

[providers.multi]
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_MULTI_INTERFACE_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.multi.models.wire-model]
wire_name = "wire-model"
aliases = ["direct-client", "relay-client"]
capabilities = ["text", "tools"]
supports_streaming = true

[providers.multi.interfaces.responses]
type = "responses"
base_url = "http://127.0.0.1:{responses_port}/v1"
responses = {{ process = "chat", streaming = "never" }}

[providers.multi.interfaces.chat]
type = "openai_chat"
base_url = "http://127.0.0.1:{chat_port}/v1"

[route_groups.controlled.pools.direct_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["direct-client"] }}
targets = [{{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "responses", priority = 1 }}]

[route_groups.controlled.pools.relay_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["relay-client"] }}
targets = [{{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "chat", priority = 1 }}]

[route_groups.controlled.pools.relay_client_from_responses]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["relay-client"] }}
targets = [{{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "chat", priority = 1 }}]

[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "responses", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_declaration,
        server_execution = hub_v1_server_execution("controlled"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn multi_interface_failure_manifest(
    server_port: u16,
    failure_port: u16,
    success_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let hub_v1_declaration = hub_v1_test_declaration();
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.controlled]
bind = "127.0.0.1"
port = {server_port}
routing_group = "controlled"
endpoints = ["responses"]

{server_execution}

[providers.multi]
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_MULTI_INTERFACE_FAILURE_KEY" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.multi.models.wire-model]
wire_name = "wire-model"
aliases = ["direct-client"]
capabilities = ["text", "tools"]
supports_streaming = true

[providers.multi.interfaces.failure]
type = "responses"
base_url = "http://127.0.0.1:{failure_port}/v1"
responses = {{ process = "chat", streaming = "never" }}

[providers.multi.interfaces.success]
type = "responses"
base_url = "http://127.0.0.1:{success_port}/v1"
responses = {{ process = "chat", streaming = "never" }}

[route_groups.controlled.pools.direct_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["direct-client"] }}
targets = [
  {{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "failure", priority = 2 }},
  {{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "success", priority = 1 }}
]

[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "failure", priority = 2 }},
  {{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "success", priority = 1 }}
]
"#,
        hub_v1_declaration = hub_v1_declaration,
        server_execution = hub_v1_server_execution("controlled"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn multi_interface_http_200_policy_manifest(
    server_port: u16,
    chat_port: u16,
    sibling_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let hub_v1_declaration = hub_v1_test_declaration();
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.controlled]
bind = "127.0.0.1"
port = {server_port}
routing_group = "controlled"
endpoints = ["responses"]

{server_execution}

[providers.multi]
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_MULTI_INTERFACE_POLICY_KEY" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.multi.models.wire-model]
wire_name = "wire-model"
aliases = ["relay-client"]
capabilities = ["text", "tools"]
supports_streaming = true

[providers.multi.interfaces.chat]
type = "openai_chat"
base_url = "http://127.0.0.1:{chat_port}/v1"

[providers.multi.interfaces.sibling]
type = "responses"
base_url = "http://127.0.0.1:{sibling_port}/v1"
responses = {{ process = "chat", streaming = "never" }}

[route_groups.controlled.pools.relay_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["relay-client"] }}
targets = [
  {{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "chat", priority = 2 }},
  {{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "sibling", priority = 1 }}
]

[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "chat", priority = 2 }},
  {{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "sibling", priority = 1 }}
]

[[error.provider_error_action_policy]]
policy_id = "multi_chat_200"
match = {{ http_status = 200 }}
path = [
  {{ step = "wait_retry", retry_mode = "reselect_before_client_projection", max_attempts = 2, backoff_ms = 0 }},
  {{ step = "project", reason_code = "provider_http_200_policy" }}
]
"#,
        hub_v1_declaration = hub_v1_declaration,
        server_execution = hub_v1_server_execution("controlled"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}
