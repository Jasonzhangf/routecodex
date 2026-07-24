use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
};
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{Value, json};
use std::{net::TcpListener, sync::Arc, time::Duration};
use tokio::sync::{Mutex, mpsc, oneshot};

#[path = "../../../tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

static TEST_LOCK: Mutex<()> = Mutex::const_new(());
const EXPECTED_DEFAULT_FLOOR_ERROR_ATTEMPTS: usize = 3;

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
    assert!(
        json_response
            .headers()
            .get("x-routecodex-v3-node-trace")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("V3ServerRespOutbound06ClientFrame")
    );
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
    let mut body_stream = sse_response.bytes_stream();
    let first = tokio::time::timeout(Duration::from_millis(150), body_stream.next())
        .await
        .expect("client first frame must arrive before controlled terminal delay")
        .unwrap()
        .unwrap();
    assert!(String::from_utf8(first.to_vec()).unwrap().contains("first"));
    let rest = tokio::time::timeout(Duration::from_secs(1), body_stream.collect::<Vec<_>>())
        .await
        .unwrap();
    let rest = rest
        .into_iter()
        .map(Result::unwrap)
        .flat_map(|bytes| bytes.to_vec())
        .collect::<Vec<_>>();
    assert!(String::from_utf8(rest).unwrap().contains("data: [DONE]"));
    let _sse_capture = captures_rx.recv().await.unwrap();

    let error_response = client
        .post(&endpoint)
        .json(&json!({
            "model":"chat-client-alias",
            "messages":[{"role":"user","content":"fail"}],
            "stream":false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(error_response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        error_response
            .headers()
            .get("x-routecodex-v3-error-chain")
            .unwrap(),
        "V3Error01SourceRaised,V3Error02Classified,V3Error03TargetLocalAction,V3Error04TargetExhaustionDecision,V3Error05ExecutionDecision,V3Error06ClientProjected"
    );
    let error_body: Value = error_response.json().await.unwrap();
    assert_eq!(error_body["error"]["message"], "controlled rate limit");
    assert_eq!(error_body["error"]["code"], "rate_limit_error");
    assert_eq!(error_body["error"]["class"], "provider_failure");
    assert_eq!(
        error_body["error"]["error_node"],
        "V3Error06ClientProjected"
    );
    assert!(
        error_body["error"].get("type").is_none(),
        "provider raw error body must not bypass ErrorErr06 projection: {error_body}"
    );
    let mut error_captures = Vec::new();
    for _ in 0..EXPECTED_DEFAULT_FLOOR_ERROR_ATTEMPTS {
        error_captures.push(captures_rx.recv().await.unwrap());
    }
    for capture in error_captures {
        assert_eq!(
            capture.body.pointer("/messages/0/content"),
            Some(&json!("fail"))
        );
        assert!(capture.body.get("metadata_center").is_none());
    }

    let isolation_response = client
        .post(&endpoint)
        .json(&json!({
            "model":"chat-client-alias",
            "messages":[{"role":"user","content":"isolation"}],
            "metadata_center":{"route":"must-not-leak"}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        isolation_response.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), captures_rx.recv())
            .await
            .is_err()
    );

    handle.shutdown().await;
    upstream_shutdown_tx.send(()).unwrap();
    std::env::remove_var("V3_OPENAI_CHAT_CONTROLLED_KEY");
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
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
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
[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "chat-wire-model", key = "controlled", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("controlled"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}
