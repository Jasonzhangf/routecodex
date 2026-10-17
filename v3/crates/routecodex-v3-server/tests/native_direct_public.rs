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
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::hub_v1_server_execution;

const NATIVE_HUB_DECLARATION: &str = "[pipelines.hub_v1]\nskeleton = \"hub_v1\"\n";

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());
const PROVIDER_KEY_ENV: &str = "V3_NATIVE_DIRECT_PUBLIC_KEY";

#[derive(Debug)]
struct ProviderCapture {
    provider: &'static str,
    path: String,
    query: Option<String>,
    body: Value,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

fn capture(state: &ProviderState, provider: &'static str, uri: &Uri, body: &Value) {
    state
        .captures
        .send(ProviderCapture {
            provider,
            path: uri.path().to_string(),
            query: uri.query().map(ToOwned::to_owned),
            body: body.clone(),
        })
        .unwrap();
}

async fn anthropic_http_error(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture(&state, "anthropic-http-error", &uri, &body);
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"type":"error","error":{"type":"api_error","message":"ANTHROPIC_HTTP_PRIVATE_MARKER"}}"#,
        ))
        .unwrap()
}

async fn anthropic_sse_error(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture(&state, "anthropic-sse-error", &uri, &body);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(
            "event: error\n\
             data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"ANTHROPIC_SSE_PRIVATE_MARKER\"}}\n\n",
        ))
        .unwrap()
}

async fn anthropic_success(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture(&state, "anthropic-success", &uri, &body);
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(
                "event: message_start\n\
                 data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_native_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"anthropic-success-wire\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":9,\"output_tokens\":0}}}\n\n\
                 event: content_block_start\n\
                 data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_native_1\",\"name\":\"native_add\",\"input\":{}}}\n\n\
                 event: content_block_delta\n\
                 data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"left\\\":17,\\\"right\\\":25}\"}}\n\n\
                 event: content_block_stop\n\
                 data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
                 event: message_delta\n\
                 data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":7}}\n\n\
                 event: message_stop\n\
                 data: {\"type\":\"message_stop\"}\n\n",
            ))
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "id":"msg_native_2",
                "type":"message",
                "role":"assistant",
                "model":"anthropic-success-wire",
                "content":[{"type":"text","text":"anthropic roundtrip complete"}],
                "stop_reason":"end_turn",
                "stop_sequence":null,
                "usage":{"input_tokens":12,"output_tokens":4}
            }))
            .unwrap(),
        ))
        .unwrap()
}

async fn gemini_native(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture(&state, "gemini-native", &uri, &body);
    if uri.path() == "/v1beta/models/gemini-native-wire:generateContent" {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "candidates":[{
                        "index":0,
                        "content":{"role":"model","parts":[{
                            "functionCall":{
                                "id":"call_native_1",
                                "name":"native_multiply",
                                "args":{"left":6,"right":7}
                            }
                        }]},
                        "finishReason":"STOP",
                        "metadata":{"native_marker":"GEMINI_BUSINESS_METADATA"}
                    }],
                    "usageMetadata":{
                        "promptTokenCount":4,
                        "candidatesTokenCount":3,
                        "totalTokenCount":7
                    }
                }))
                .unwrap(),
            ))
            .unwrap();
    }
    if uri.path() == "/v1beta/models/gemini-native-wire:streamGenerateContent"
        && uri.query() == Some("alt=sse")
    {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(
                "data: {\"candidates\":[{\"index\":0,\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"gemini roundtrip complete\"}]},\"finishReason\":\"STOP\",\"metadata\":{\"native_marker\":\"GEMINI_BUSINESS_METADATA\"}}],\"usageMetadata\":{\"promptTokenCount\":8,\"candidatesTokenCount\":4,\"totalTokenCount\":12}}\n\n",
            ))
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"error":"unexpected native Gemini request"}"#,
        ))
        .unwrap()
}

async fn anthropic_exhausted(
    State(state): State<Arc<ProviderState>>,
    uri: Uri,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    capture(&state, "anthropic-exhausted", &uri, &body);
    Response::builder()
        .status(StatusCode::TOO_MANY_REQUESTS)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"ANTHROPIC_EXHAUSTION_PRIVATE_MARKER"}}"#,
        ))
        .unwrap()
}

#[tokio::test]
async fn anthropic_default_direct_recovers_native_http_and_sse_errors_then_preserves_tool_roundtrip(
) {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(PROVIDER_KEY_ENV, "native-direct-secret");

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/http-failure/v1/messages", post(anthropic_http_error))
        .route("/sse-failure/v1/messages", post(anthropic_sse_error))
        .route("/success/v1/messages", post(anthropic_success))
        .with_state(Arc::new(ProviderState {
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

    let handle = spawn_v3_server_aggregate(anthropic_manifest(free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let client = http_client();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let initial = client
        .post(&endpoint)
        .json(&json!({
            "model":"anthropic-recover-client",
            "max_tokens":1024,
            "messages":[{"role":"user","content":"Call native_add with 17 and 25"}],
            "tools":[{
                "name":"native_add",
                "description":"Add two integers",
                "input_schema":{
                    "type":"object",
                    "properties":{"left":{"type":"integer"},"right":{"type":"integer"}},
                    "required":["left","right"]
                }
            }],
            "metadata":{"native_request_marker":"keep-me"},
            "stream":true
        }))
        .send()
        .await;

    assert_native_direct_default(&client, handle.listeners[0].addr).await;

    let response = initial.expect("Anthropic client transport must survive provider recovery");
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream")),
        "Anthropic Direct must return the native SSE channel"
    );
    let client_body = response.text().await.unwrap();
    assert!(
        !client_body.contains("ANTHROPIC_HTTP_PRIVATE_MARKER"),
        "provider HTTP error body reached Anthropic client: {client_body}"
    );
    assert!(
        !client_body.contains("ANTHROPIC_SSE_PRIVATE_MARKER"),
        "provider SSE error body reached Anthropic client: {client_body}"
    );

    let (call_id, call_name, call_args) = anthropic_tool_call(&client_body);
    assert_eq!(call_id, "toolu_native_1");
    assert_eq!(call_name, "native_add");
    assert_eq!(call_args, json!({"left":17,"right":25}));

    let mut recovery_captures = Vec::new();
    loop {
        let capture = recv_capture(&mut captures_rx).await;
        let completed = capture.provider == "anthropic-success";
        recovery_captures.push(capture);
        if completed {
            break;
        }
    }
    let http_capture = recovery_captures.first().unwrap();
    let sse_capture = recovery_captures
        .iter()
        .find(|capture| capture.provider == "anthropic-sse-error")
        .unwrap();
    let success_capture = recovery_captures.last().unwrap();
    assert_eq!(http_capture.provider, "anthropic-http-error");
    assert_eq!(sse_capture.provider, "anthropic-sse-error");
    assert_eq!(success_capture.provider, "anthropic-success");
    for capture in &recovery_captures {
        assert_eq!(capture.query.as_deref(), Some("beta=true"));
        assert!(
            capture.body.get("messages").is_some(),
            "Anthropic provider request lost native messages: {capture:?}"
        );
        assert!(
            capture.body.get("tool_calls").is_none(),
            "Anthropic provider request was Chat-normalized: {capture:?}"
        );
    }
    assert_eq!(http_capture.path, "/http-failure/v1/messages");
    assert_eq!(sse_capture.path, "/sse-failure/v1/messages");
    assert_eq!(success_capture.path, "/success/v1/messages");
    assert_eq!(
        success_capture.body["model"], "anthropic-success-wire",
        "native Anthropic request must bind the selected wire model"
    );
    assert_eq!(
        success_capture.body["tools"][0]["input_schema"]["type"],
        "object"
    );
    assert_eq!(
        success_capture.body["metadata"]["native_request_marker"],
        "keep-me"
    );

    let left = call_args["left"]
        .as_i64()
        .expect("native tool argument left");
    let right = call_args["right"]
        .as_i64()
        .expect("native tool argument right");
    let tool_result = left + right;
    assert_eq!(tool_result, 42);

    let follow_up = client
        .post(&endpoint)
        .json(&json!({
            "model":"anthropic-ok-client",
            "max_tokens":1024,
            "messages":[
                {"role":"user","content":"Call native_add with 17 and 25"},
                {"role":"assistant","content":[{
                    "type":"tool_use",
                    "id":call_id,
                    "name":call_name,
                    "input":call_args
                }]},
                {"role":"user","content":[{
                    "type":"tool_result",
                    "tool_use_id":"toolu_native_1",
                    "content":tool_result.to_string()
                }]}
            ],
            "tools":[{
                "name":"native_add",
                "description":"Add two integers",
                "input_schema":{
                    "type":"object",
                    "properties":{"left":{"type":"integer"},"right":{"type":"integer"}},
                    "required":["left","right"]
                }
            }],
            "stream":false
        }))
        .send()
        .await
        .expect("Anthropic follow-up transport");
    assert_eq!(follow_up.status(), StatusCode::OK);
    let follow_up_body: Value = follow_up.json().await.unwrap();
    assert_eq!(
        follow_up_body["content"][0]["text"],
        "anthropic roundtrip complete"
    );

    let follow_up_capture = recv_capture(&mut captures_rx).await;
    assert_eq!(follow_up_capture.provider, "anthropic-success");
    assert_eq!(follow_up_capture.path, "/success/v1/messages");
    assert_eq!(follow_up_capture.body["model"], "anthropic-success-wire");
    assert_eq!(
        follow_up_capture.body["messages"].as_array().unwrap().len(),
        3
    );
    assert_eq!(
        follow_up_capture.body["messages"][1]["content"][0]["type"],
        "tool_use"
    );
    assert_eq!(
        follow_up_capture.body["messages"][1]["content"][0]["id"],
        "toolu_native_1"
    );
    assert_eq!(
        follow_up_capture.body["messages"][1]["content"][0]["name"],
        "native_add"
    );
    assert_eq!(
        follow_up_capture.body["messages"][1]["content"][0]["input"],
        json!({"left":17,"right":25})
    );
    assert_eq!(
        follow_up_capture.body["messages"][2]["content"][0]["type"],
        "tool_result"
    );
    assert_eq!(
        follow_up_capture.body["messages"][2]["content"][0]["tool_use_id"],
        "toolu_native_1"
    );
    assert_eq!(
        follow_up_capture.body["messages"][2]["content"][0]["content"],
        "42"
    );

    handle.shutdown().await;
    let _ = shutdown_tx.send(());
    std::env::remove_var(PROVIDER_KEY_ENV);
}

#[tokio::test]
async fn gemini_default_direct_preserves_native_json_and_sse_business_terminals_and_tool_roundtrip()
{
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(PROVIDER_KEY_ENV, "native-direct-secret");

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1beta/models/:operation", post(gemini_native))
        .with_state(Arc::new(ProviderState {
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

    let handle = spawn_v3_server_aggregate(gemini_manifest(free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let client = http_client();
    let base = format!("http://{}", handle.listeners[0].addr);
    let json_endpoint = format!("{base}/v1beta/models/gemini-client:generateContent");
    let json_request = json!({
        "contents":[{"role":"user","parts":[{"text":"Call native_multiply with 6 and 7"}]}],
        "tools":[{"functionDeclarations":[{
            "name":"native_multiply",
            "description":"Multiply two integers",
            "parameters":{
                "type":"object",
                "properties":{"left":{"type":"integer"},"right":{"type":"integer"}},
                "required":["left","right"]
            }
        }]}]
    });
    let initial = client.post(&json_endpoint).json(&json_request).send().await;

    assert_native_direct_default(&client, handle.listeners[0].addr).await;

    let response = initial.expect("Gemini JSON client transport");
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("application/json")),
        "Gemini generateContent must return native JSON"
    );
    let json_body: Value = response.json().await.unwrap();
    let function_call = &json_body["candidates"][0]["content"]["parts"][0]["functionCall"];
    assert_eq!(function_call["id"], "call_native_1");
    assert_eq!(function_call["name"], "native_multiply");
    assert_eq!(function_call["args"], json!({"left":6,"right":7}));
    assert_eq!(json_body["candidates"][0]["finishReason"], "STOP");
    assert_eq!(
        json_body["candidates"][0]["metadata"]["native_marker"],
        "GEMINI_BUSINESS_METADATA"
    );

    let json_capture = recv_capture(&mut captures_rx).await;
    assert_eq!(json_capture.provider, "gemini-native");
    assert_eq!(
        json_capture.path,
        "/v1beta/models/gemini-native-wire:generateContent"
    );
    assert_eq!(json_capture.query, None);
    assert!(
        json_capture.body.get("model").is_none(),
        "Gemini wire body must keep the selected model in the URL: {json_capture:?}"
    );
    assert!(
        json_capture.body.get("stream").is_none(),
        "Gemini wire body must keep stream intent in the endpoint action: {json_capture:?}"
    );
    assert_eq!(
        json_capture.body["contents"][0]["parts"][0]["text"],
        "Call native_multiply with 6 and 7"
    );
    assert_eq!(
        json_capture.body["tools"][0]["functionDeclarations"][0]["name"],
        "native_multiply"
    );
    assert!(
        json_capture.body.get("messages").is_none()
            && json_capture.body.get("tool_calls").is_none(),
        "Gemini provider request was Chat-normalized: {json_capture:?}"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(150), captures_rx.recv())
            .await
            .is_err(),
        "valid Gemini STOP/metadata business terminal triggered provider reselection"
    );

    let left = function_call["args"]["left"]
        .as_i64()
        .expect("native Gemini left argument");
    let right = function_call["args"]["right"]
        .as_i64()
        .expect("native Gemini right argument");
    let tool_result = left * right;
    assert_eq!(tool_result, 42);

    let stream_endpoint =
        format!("{base}/v1beta/models/gemini-client:streamGenerateContent?alt=sse");
    let stream_response = client
        .post(&stream_endpoint)
        .json(&json!({
            "contents":[
                {"role":"user","parts":[{"text":"Call native_multiply with 6 and 7"}]},
                {"role":"model","parts":[{
                    "functionCall":{
                        "id":"call_native_1",
                        "name":"native_multiply",
                        "args":{"left":6,"right":7}
                    }
                }]},
                {"role":"user","parts":[{
                    "functionResponse":{
                        "name":"native_multiply",
                        "response":{"result":tool_result}
                    }
                }]}
            ],
            "tools":[{"functionDeclarations":[{
                "name":"native_multiply",
                "parameters":{
                    "type":"object",
                    "properties":{"left":{"type":"integer"},"right":{"type":"integer"}}
                }
            }]}]
        }))
        .send()
        .await
        .expect("Gemini SSE follow-up transport");
    assert_eq!(stream_response.status(), StatusCode::OK);
    assert!(
        stream_response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream")),
        "Gemini streamGenerateContent must return native SSE"
    );
    let stream_body = stream_response.text().await.unwrap();
    let stream_events = sse_json_values(&stream_body);
    let terminal = stream_events
        .iter()
        .find(|event| event["candidates"][0]["finishReason"] == "STOP")
        .expect("Gemini SSE STOP business terminal");
    assert_eq!(
        terminal["candidates"][0]["content"]["parts"][0]["text"],
        "gemini roundtrip complete"
    );
    assert_eq!(
        terminal["candidates"][0]["metadata"]["native_marker"],
        "GEMINI_BUSINESS_METADATA"
    );

    let stream_capture = recv_capture(&mut captures_rx).await;
    assert_eq!(stream_capture.provider, "gemini-native");
    assert_eq!(
        stream_capture.path,
        "/v1beta/models/gemini-native-wire:streamGenerateContent"
    );
    assert_eq!(stream_capture.query.as_deref(), Some("alt=sse"));
    assert!(
        stream_capture.body.get("model").is_none() && stream_capture.body.get("stream").is_none(),
        "Gemini SSE wire body gained Chat/stream fields: {stream_capture:?}"
    );
    assert_eq!(stream_capture.body["contents"].as_array().unwrap().len(), 3);
    assert_eq!(
        stream_capture.body["contents"][1]["parts"][0]["functionCall"]["id"],
        "call_native_1"
    );
    assert_eq!(
        stream_capture.body["contents"][1]["parts"][0]["functionCall"]["name"],
        "native_multiply"
    );
    assert_eq!(
        stream_capture.body["contents"][1]["parts"][0]["functionCall"]["args"],
        json!({"left":6,"right":7})
    );
    assert_eq!(
        stream_capture.body["contents"][2]["parts"][0]["functionResponse"]["name"],
        "native_multiply"
    );
    assert_eq!(
        stream_capture.body["contents"][2]["parts"][0]["functionResponse"]["response"]["result"],
        42
    );
    assert!(
        stream_capture.body.get("messages").is_none()
            && stream_capture.body.get("tool_calls").is_none(),
        "Gemini SSE follow-up was Chat-normalized: {stream_capture:?}"
    );

    handle.shutdown().await;
    let _ = shutdown_tx.send(());
    std::env::remove_var(PROVIDER_KEY_ENV);
}

#[tokio::test]
async fn native_direct_all_provider_exhaustion_closes_only_the_request_transport() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(PROVIDER_KEY_ENV, "native-direct-secret");

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/exhausted/v1/messages", post(anthropic_exhausted))
        .with_state(Arc::new(ProviderState {
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

    let handle = spawn_v3_server_aggregate(exhaustion_manifest(free_port(), upstream_addr.port()))
        .await
        .unwrap();
    let client = http_client();
    let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
    let initial = client
        .post(&endpoint)
        .json(&json!({
            "model":"anthropic-exhaust-client",
            "max_tokens":256,
            "messages":[{"role":"user","content":"exhaust the only provider"}],
            "stream":false
        }))
        .send()
        .await;

    assert_native_direct_default(&client, handle.listeners[0].addr).await;

    let error = initial.expect_err(
        "all-provider exhaustion must not return a provider status or fabricated business response",
    );
    assert!(
        error.is_request(),
        "all-provider exhaustion must detectably close only the request transport: {error:?}"
    );
    assert!(
        !error
            .to_string()
            .contains("ANTHROPIC_EXHAUSTION_PRIVATE_MARKER"),
        "provider exhaustion body reached the client: {error}"
    );
    let capture = recv_capture(&mut captures_rx).await;
    assert_eq!(capture.provider, "anthropic-exhausted");
    assert_eq!(capture.path, "/exhausted/v1/messages");
    assert_eq!(capture.query.as_deref(), Some("beta=true"));
    assert_eq!(capture.body["model"], "anthropic-exhaust-wire");

    let logs = client
        .get(format!(
            "http://{}/_routecodex/debug/logs",
            handle.listeners[0].addr
        ))
        .send()
        .await
        .expect("server must remain responsive after request-local exhaustion");
    assert_eq!(logs.status(), StatusCode::OK);

    handle.shutdown().await;
    let _ = shutdown_tx.send(());
    std::env::remove_var(PROVIDER_KEY_ENV);
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap()
}

async fn recv_capture(captures: &mut mpsc::UnboundedReceiver<ProviderCapture>) -> ProviderCapture {
    tokio::time::timeout(Duration::from_secs(3), captures.recv())
        .await
        .expect("controlled upstream request")
        .expect("controlled upstream capture channel")
}

async fn assert_native_direct_default(client: &reqwest::Client, addr: SocketAddr) {
    let logs: Value = client
        .get(format!("http://{addr}/_routecodex/debug/logs"))
        .send()
        .await
        .expect("debug logs request")
        .json()
        .await
        .expect("debug logs JSON");
    let events = logs["logs"].as_array().expect("debug logs array");
    let entry_modes = events
        .iter()
        .filter(|event| event["node_id"] == "V3Server03HttpRequestRaw")
        .filter_map(|event| event["details"]["execution_mode"].as_str())
        .collect::<Vec<_>>();
    assert!(
        !entry_modes.is_empty(),
        "native entry must record its binding-resolved execution mode: {logs}"
    );
    assert!(
        entry_modes.iter().all(|mode| *mode == "direct"),
        "shared default native entry must resolve Direct, saw {entry_modes:?}"
    );
}

fn sse_json_values(body: &str) -> Vec<Value> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .filter(|data| !data.is_empty())
        .filter_map(|data| serde_json::from_str(data).ok())
        .collect()
}

fn anthropic_tool_call(body: &str) -> (String, String, Value) {
    let events = sse_json_values(body);
    let mut id = None;
    let mut name = None;
    let mut input = None;
    let mut partial_json = String::new();
    for event in &events {
        if event["type"] == "content_block_start" && event["content_block"]["type"] == "tool_use" {
            id = event["content_block"]["id"].as_str().map(ToOwned::to_owned);
            name = event["content_block"]["name"]
                .as_str()
                .map(ToOwned::to_owned);
            input = event["content_block"].get("input").cloned();
        }
        if event["type"] == "content_block_delta" && event["delta"]["type"] == "input_json_delta" {
            if let Some(partial) = event["delta"]["partial_json"].as_str() {
                partial_json.push_str(partial);
            }
        }
    }
    let args = if partial_json.is_empty() {
        input.expect("Anthropic native tool input")
    } else {
        serde_json::from_str(&partial_json).expect("Anthropic native tool input JSON")
    };
    (
        id.expect("Anthropic native tool call id"),
        name.expect("Anthropic native tool name"),
        args,
    )
}

fn anthropic_manifest(
    server_port: u16,
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.anthropic_native]
bind = "127.0.0.1"
port = {server_port}
routing_group = "anthropic_native"
endpoints = ["anthropic"]

{server_execution}

[providers.anthropic_http_failure]
type = "anthropic"
base_url = "http://127.0.0.1:{upstream_port}/http-failure"
default_model = "anthropic-http-failure-wire"
auth = {{ type = "api_key", entries = [{{ alias = "native", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.anthropic_http_failure.models.anthropic-http-failure-wire]
wire_name = "anthropic-http-failure-wire"
aliases = ["anthropic-http-failure-internal"]
supports_streaming = true
capabilities = ["text", "tools"]

[providers.anthropic_sse_failure]
type = "anthropic"
base_url = "http://127.0.0.1:{upstream_port}/sse-failure"
default_model = "anthropic-sse-failure-wire"
auth = {{ type = "api_key", entries = [{{ alias = "native", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.anthropic_sse_failure.models.anthropic-sse-failure-wire]
wire_name = "anthropic-sse-failure-wire"
aliases = ["anthropic-sse-failure-internal"]
supports_streaming = true
capabilities = ["text", "tools"]

[providers.anthropic_success]
type = "anthropic"
base_url = "http://127.0.0.1:{upstream_port}/success"
default_model = "anthropic-success-wire"
auth = {{ type = "api_key", entries = [{{ alias = "native", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.anthropic_success.models.anthropic-success-wire]
wire_name = "anthropic-success-wire"
aliases = ["anthropic-recover-client", "anthropic-ok-client"]
supports_streaming = true
capabilities = ["text", "tools"]

[route_groups.anthropic_native.pools.recover]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "anthropic", models = ["anthropic-recover-client"] }}
targets = [
  {{ kind = "provider_model", provider = "anthropic_http_failure", model = "anthropic-http-failure-wire", key = "native", priority = 3 }},
  {{ kind = "provider_model", provider = "anthropic_sse_failure", model = "anthropic-sse-failure-wire", key = "native", priority = 2 }},
  {{ kind = "provider_model", provider = "anthropic_success", model = "anthropic-success-wire", key = "native", priority = 1 }}
]

[route_groups.anthropic_native.pools.follow_up]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "anthropic", models = ["anthropic-ok-client"] }}
targets = [{{ kind = "provider_model", provider = "anthropic_success", model = "anthropic-success-wire", key = "native", priority = 1 }}]

[route_groups.anthropic_native.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "anthropic_success", model = "anthropic-success-wire", key = "native", priority = 1 }}]
"#,
        hub_v1_declaration = NATIVE_HUB_DECLARATION,
        server_execution = hub_v1_server_execution("anthropic_native"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn gemini_manifest(
    server_port: u16,
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.gemini_native]
bind = "127.0.0.1"
port = {server_port}
routing_group = "gemini_native"
endpoints = ["gemini"]

{server_execution}

[providers.gemini_native]
type = "gemini"
base_url = "http://127.0.0.1:{upstream_port}/v1beta"
default_model = "gemini-native-wire"
auth = {{ type = "api_key", entries = [{{ alias = "native", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}

[providers.gemini_native.models.gemini-native-wire]
wire_name = "gemini-native-wire"
aliases = ["gemini-client"]
supports_streaming = true
capabilities = ["text", "tools"]

[route_groups.gemini_native.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "gemini", models = ["gemini-client"] }}
targets = [{{ kind = "provider_model", provider = "gemini_native", model = "gemini-native-wire", key = "native", priority = 1 }}]

[route_groups.gemini_native.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "gemini_native", model = "gemini-native-wire", key = "native", priority = 1 }}]
"#,
        hub_v1_declaration = NATIVE_HUB_DECLARATION,
        server_execution = hub_v1_server_execution("gemini_native"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn exhaustion_manifest(
    server_port: u16,
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.anthropic_exhaustion]
bind = "127.0.0.1"
port = {server_port}
routing_group = "anthropic_exhaustion"
endpoints = ["anthropic"]

{server_execution}

[providers.anthropic_exhausted]
type = "anthropic"
base_url = "http://127.0.0.1:{upstream_port}/exhausted"
default_model = "anthropic-exhaust-wire"
auth = {{ type = "api_key", entries = [{{ alias = "native", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.anthropic_exhausted.models.anthropic-exhaust-wire]
wire_name = "anthropic-exhaust-wire"
aliases = ["anthropic-exhaust-client"]
supports_streaming = true
capabilities = ["text", "tools"]

[route_groups.anthropic_exhaustion.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "anthropic", models = ["anthropic-exhaust-client"] }}
targets = [{{ kind = "provider_model", provider = "anthropic_exhausted", model = "anthropic-exhaust-wire", key = "native", priority = 1 }}]

[route_groups.anthropic_exhaustion.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "anthropic_exhausted", model = "anthropic-exhaust-wire", key = "native", priority = 1 }}]
"#,
        hub_v1_declaration = NATIVE_HUB_DECLARATION,
        server_execution = hub_v1_server_execution("anthropic_exhaustion"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}
