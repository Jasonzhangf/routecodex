use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

// Stable public-entry regression ID: issue13d6279_representable_history_roundtrip.
#[tokio::test]
async fn issue13d6279_representable_history_roundtrip() {
    let _guard = TEST_LOCK.lock().await;
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    std::env::set_var("V3_OPENAI_CHAT_CONTROLLED_KEY", "controlled-secret");
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream.local_addr().unwrap().port();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(req04_shape_checking_upstream))
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let upstream_task = tokio::spawn(async move { axum::serve(upstream, app).await.unwrap() });
    let handle = spawn_v3_server_aggregate(manifest(free_port(), upstream_port))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let mut history = json!([
        {"role":"tool","tool_call_id":"trimmed-call","content":"prior error: invalid arguments"},
        {"role":"assistant","content":null,"tool_calls":[{"id":"older-call","type":"function","function":{"name":"lookup","arguments":"{broken"}}]},
        {"role":"assistant","content":"intervening assistant"},
        {"role":"tool","tool_call_id":"older-call","content":"client error: invalid JSON"},
        {"role":"user","content":"try again"}
    ]);
    let tools = json!([{"type":"function","function":{"name":"lookup","parameters":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}}}]);
    let result = client
        .post(&endpoint)
        .json(&json!({"model":"chat-client-alias","messages":history,"tools":tools}))
        .send()
        .await;
    if let Err(error) = &result {
        assert!(
            captures_rx.try_recv().is_err(),
            "provider was attempted before failure"
        );
        panic!("Req04 rejected representable history; provider_attempts=0: {error}");
    }
    let response: Value = result
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let first = captures_rx.recv().await.unwrap();
    assert_eq!(first.body["messages"], history);
    assert_eq!(first.body["tools"], tools);
    assert!(
        captures_rx.try_recv().is_err(),
        "first request must use one provider attempt"
    );
    let assistant = response.pointer("/choices/0/message").unwrap().clone();
    let call = &assistant["tool_calls"][0];
    assert_eq!(call["id"], "invalid-call");
    assert_eq!(call["function"]["arguments"], "{invalid");
    // The client actually invokes its tool argument parser and returns its error receipt.
    let arguments = call["function"]["arguments"].as_str().unwrap();
    let tool_error = serde_json::from_str::<Value>(arguments).unwrap_err();
    let receipt = json!({"role":"tool","tool_call_id":call["id"],"content":format!("client tool error: {tool_error}")});
    history.as_array_mut().unwrap().extend([assistant, receipt]);
    let followup: Value = client
        .post(&endpoint)
        .json(&json!({"model":"chat-client-alias","messages":history,"tools":tools}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        followup.pointer("/choices/0/message/content"),
        Some(&json!("corrected"))
    );
    assert_eq!(captures_rx.recv().await.unwrap().body["messages"], history);
    assert!(captures_rx.try_recv().is_err());
    handle.shutdown().await;
    upstream_task.abort();
    std::env::remove_var("V3_OPENAI_CHAT_CONTROLLED_KEY");
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(None);
}

async fn req04_shape_checking_upstream(
    State(state): State<Arc<ProviderState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            authorization: None,
            body: body.clone(),
        })
        .unwrap();
    let messages = &body["messages"];
    let valid = messages
        .as_array()
        .is_some_and(|items| matches!(items.len(), 5 | 7))
        && messages[0]["tool_call_id"] == "trimmed-call"
        && messages[1]["tool_calls"][0]["function"]["arguments"] == "{broken"
        && messages[2]["content"] == "intervening assistant"
        && messages[3]["tool_call_id"] == "older-call"
        && body["tools"][0]["function"]["name"] == "lookup";
    let followup = messages.as_array().is_some_and(|items| items.len() == 7);
    let valid = valid
        && (!followup
            || (messages[5]["tool_calls"][0]["id"] == "invalid-call"
                && messages[6]["tool_call_id"] == "invalid-call"
                && messages[6]["content"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("client tool error:"))));
    let message = if followup {
        json!({"role":"assistant","content":"corrected"})
    } else {
        json!({"role":"assistant","content":null,"tool_calls":[{"id":"invalid-call","type":"function","function":{"name":"lookup","arguments":"{invalid"}}]})
    };
    Response::builder().status(if valid { StatusCode::OK } else { StatusCode::BAD_REQUEST })
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&json!({"id":"req04-controlled","object":"chat.completion","model":"chat-wire-model","choices":[{"index":0,"message":message,"finish_reason":if followup {"stop"} else {"tool_calls"}}]})).unwrap())).unwrap()
}

#[derive(Debug)]
struct ProviderCapture {
    authorization: Option<String>,
    body: Value,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

async fn controlled_openai_chat_upstream(
    State(state): State<Arc<ProviderState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            authorization: headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            body: body.clone(),
        })
        .unwrap();

    if body.pointer("/messages/0/content").and_then(Value::as_str) == Some("fail") {
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"type":"rate_limit_error","message":"controlled rate limit"}}"#,
            ))
            .unwrap();
    }
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let stream = futures_util::stream::unfold(0_u8, |step| async move {
            match step {
                0 => Some((
                    Ok::<_, std::convert::Infallible>(
                        br#"data: {"id":"chatcmpl-controlled","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"first"},"finish_reason":null}]}

"#
                        .to_vec(),
                    ),
                    1,
                )),
                1 => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    Some((
                        Ok(
                            br#"data: {"id":"chatcmpl-controlled","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#
                            .to_vec(),
                        ),
                        2,
                    ))
                }
                _ => None,
            }
        });
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream))
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "id":"chatcmpl-controlled",
                "object":"chat.completion",
                "model":"chat-wire-model",
                "choices":[{
                    "index":0,
                    "message":{"role":"assistant","content":"controlled json"},
                    "finish_reason":"stop"
                }],
                "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}
            }))
            .unwrap(),
        ))
        .unwrap()
}

#[tokio::test]
async fn server_executes_controlled_json_sse_error_and_isolation_without_second_owner() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_OPENAI_CHAT_CONTROLLED_KEY", "controlled-secret");
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (upstream_shutdown_tx, upstream_shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(controlled_openai_chat_upstream),
        )
        .with_state(Arc::new(ProviderState {
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

    let handle = spawn_v3_server_aggregate(manifest(free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);
    let client = reqwest::Client::new();

    let json_response = client
        .post(&endpoint)
        .json(&json!({
            "model":"chat-client-alias",
            "messages":[{"role":"user","content":"json"}],
            "tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}],
            "stream":false,
            "metadata":{"client_visible":"kept"}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(json_response.status(), StatusCode::OK);
    let json_body: Value = json_response.json().await.unwrap();
    assert_eq!(
        json_body["choices"][0]["message"]["content"],
        "controlled json"
    );
    assert_eq!(json_body["usage"]["total_tokens"], 5);
    let json_capture = captures_rx.recv().await.unwrap();
    assert_eq!(
        json_capture.authorization.as_deref(),
        Some("Bearer controlled-secret")
    );
    assert_eq!(json_capture.body["model"], "chat-wire-model");
    assert_eq!(json_capture.body["metadata"]["client_visible"], "kept");
    assert!(json_capture.body.get("metadata_center").is_none());

    let sse_response = client
        .post(&endpoint)
        .json(&json!({
            "model":"chat-client-alias",
            "messages":[{"role":"user","content":"sse"}],
            "stream":true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(sse_response.status(), StatusCode::OK);
    assert_eq!(
        sse_response.headers().get("content-type").unwrap(),
        "text/event-stream"
    );
    let mut stream = sse_response.bytes_stream();
    let mut frames = Vec::new();
    match tokio::time::timeout(Duration::from_millis(150), stream.next()).await {
        Ok(Some(Ok(bytes))) => {
            assert_eq!(
                bytes.as_ref(),
                b": keepalive\n\n",
                "provider semantic frames must remain client-invisible until terminal validation"
            );
            frames.push(bytes);
        }
        Ok(Some(Err(error))) => panic!("pre-terminal client stream failed: {error}"),
        Ok(None) => panic!("client stream closed before the provider attempt reached terminal"),
        Err(_) => {}
    }
    let remaining_frames = tokio::time::timeout(Duration::from_secs(1), stream.collect::<Vec<_>>())
        .await
        .unwrap();
    frames.extend(remaining_frames.into_iter().map(Result::unwrap));
    let body = frames
        .into_iter()
        .flat_map(|bytes| bytes.to_vec())
        .collect::<Vec<_>>();
    let body = String::from_utf8(body).unwrap();
    assert!(body.contains("first"));
    assert!(body.contains(r#""finish_reason":"stop""#));
    assert_eq!(body.matches("data: [DONE]").count(), 1, "{body}");
    let _sse_capture = captures_rx.recv().await.unwrap();

    let error_result = client
        .post(&endpoint)
        .json(&json!({
            "model":"chat-client-alias",
            "messages":[{"role":"user","content":"fail"}],
            "stream":false
        }))
        .send()
        .await;
    match error_result {
        Ok(response) => panic!(
            "a provider-terminal 429 must not reach the chat client, got {}",
            response.status()
        ),
        Err(error) => assert!(
            error.is_request(),
            "expected an aborted chat client transport: {error}"
        ),
    }
    let error_capture = tokio::time::timeout(Duration::from_secs(2), captures_rx.recv())
        .await
        .expect("provider failure must produce a capture")
        .unwrap();
    assert_eq!(
        error_capture.body.pointer("/messages/0/content"),
        Some(&json!("fail"))
    );
    assert!(error_capture.body.get("metadata_center").is_none());

    let sse_error_result = client
        .post(&endpoint)
        .json(&json!({
            "model":"chat-client-alias",
            "messages":[{"role":"user","content":"fail"}],
            "stream":true
        }))
        .send()
        .await;
    match sse_error_result {
        Ok(response) => {
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers().get("content-type").unwrap(),
                "text/event-stream"
            );
            let break_error = tokio::time::timeout(Duration::from_secs(2), response.text())
                .await
                .expect("streaming provider terminal must settle within the transport break")
                .expect_err("a streaming provider terminal must break the client transport");
            assert!(
                !break_error.to_string().contains("rate_limit_error"),
                "the provider body must not reach the client: {break_error}"
            );
        }
        Err(error) => assert!(
            error.is_request(),
            "expected an aborted chat client transport: {error}"
        ),
    }
    let sse_failure_capture = loop {
        let capture = tokio::time::timeout(Duration::from_secs(2), captures_rx.recv())
            .await
            .expect("stream provider failure must produce a capture")
            .unwrap();
        if capture
            .body
            .pointer("/messages/0/content")
            .and_then(Value::as_str)
            == Some("fail")
        {
            break capture;
        }
    };
    assert_eq!(
        sse_failure_capture
            .body
            .pointer("/messages/0/content")
            .and_then(Value::as_str),
        Some("fail")
    );
    assert!(sse_failure_capture.body.get("metadata_center").is_none());

    let opaque_business = json!({"route":"business-route","requiredCapabilities":["read"]});
    let isolation_response = client
        .post(&endpoint)
        .json(&json!({
            "model":"chat-client-alias",
            "messages":[{"role":"user","content":"isolation"}],
            "metadata_center":opaque_business.clone()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(isolation_response.status(), StatusCode::OK);
    let isolation_body: Value = isolation_response.json().await.unwrap();
    assert_eq!(
        isolation_body["choices"][0]["message"]["content"],
        "controlled json"
    );
    let isolation_capture = captures_rx.recv().await.unwrap();
    assert_eq!(isolation_capture.body["metadata_center"], opaque_business);
    assert_eq!(
        isolation_capture.body["messages"][0]["content"],
        "isolation"
    );
    // Typed route/model/auth stay independent from the ordinary business field.
    assert_eq!(isolation_capture.body["model"], "chat-wire-model");
    assert_eq!(
        isolation_capture.authorization.as_deref(),
        Some("Bearer controlled-secret")
    );

    let unlisted_model_response = client
        .post(&endpoint)
        .json(&json!({
            "model":"controlled.unknown-model",
            "messages":[{"role":"user","content":"unlisted"}],
            "stream":false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        unlisted_model_response.status(),
        StatusCode::OK,
        "a client model that is not a declared provider.model must fall back to normal routing"
    );
    let unlisted_model_body: Value = unlisted_model_response.json().await.unwrap();
    assert_eq!(
        unlisted_model_body["choices"][0]["message"]["content"],
        "controlled json"
    );
    let unlisted_model_capture = loop {
        let capture = tokio::time::timeout(Duration::from_secs(2), captures_rx.recv())
            .await
            .expect("a client model that is not a declared provider.model must reach the provider")
            .unwrap();
        if capture
            .body
            .pointer("/messages/0/content")
            .and_then(Value::as_str)
            == Some("unlisted")
        {
            break capture;
        }
    };
    assert_eq!(
        unlisted_model_capture.body["model"], "chat-wire-model",
        "the fallback must serve the default pool target, not the requested name"
    );

    handle.shutdown().await;
    upstream_shutdown_tx.send(()).unwrap();
    std::env::remove_var("V3_OPENAI_CHAT_CONTROLLED_KEY");
}

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

fn manifest(
    server_port: u16,
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    // This controlled test owns the openai_chat Relay server-entry coverage.
    // The shared hub_v1 fixture now defaults openai_chat to Direct, so this test
    // re-pins its own explicit Relay binding (same pattern as responses_relay_manifest).
    let direct_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#;
    let hub_v1_declaration = hub_v1_test_declaration().replace(direct_binding, relay_binding);
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.controlled]
bind = "127.0.0.1"
port = {server_port}
routing_group = "controlled"
endpoints = ["openai_chat"]

{server_execution}

[providers.controlled]
type = "openai_chat"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "chat-wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "V3_OPENAI_CHAT_CONTROLLED_KEY" }}] }}
[providers.controlled.models.chat-wire-model]
wire_name = "chat-wire-model"
aliases = ["chat-client-alias"]
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.controlled.pools.chat_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["chat-client-alias"] }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "chat-wire-model", key = "controlled", priority = 1 }}]
[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "chat-wire-model", key = "controlled", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_declaration,
        server_execution = hub_v1_server_execution("controlled"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}
