use axum::{
    body::Body,
    extract::State,
    http::{Response, StatusCode},
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

async fn upstream(
    State(captures): State<Arc<mpsc::UnboundedSender<Value>>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    captures
        .send(body.clone())
        .expect("capture receiver remains open");
    if body.pointer("/messages/0/content").and_then(Value::as_str) == Some("fail") {
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"type":"rate_limit_error","message":"controlled failure"}}"#,
            ))
            .unwrap();
    }
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let stream = futures_util::stream::unfold(0_u8, |step| async move {
            match step {
                0 => Some((Ok::<_, std::convert::Infallible>(
                    br#"data: {"id":"chatcmpl-typed-ingress","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"first"},"finish_reason":null}]}

"#.to_vec()), 1)),
                1 => {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    Some((Ok(br#"data: {"id":"chatcmpl-typed-ingress","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#.to_vec()), 2))
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
                "id": "chatcmpl-typed-ingress",
                "object": "chat.completion",
                "model": "wire-model",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "ok"},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
            }))
            .unwrap(),
        ))
        .unwrap()
}

fn manifest(
    server_port: u16,
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3
{}
[servers.ingress]
bind = "127.0.0.1"
port = {server_port}
routing_group = "ingress"
endpoints = ["openai_chat"]
{}
[providers.ingress]
type = "openai_chat"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_HTTP_INGRESS_TEST_KEY" }}] }}
[providers.ingress.models.wire-model]
wire_name = "wire-model"
aliases = ["client-model"]
capabilities = ["text", "tools"]
[route_groups.ingress.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "ingress", model = "wire-model", key = "key", priority = 1 }}]
"#,
        hub_v1_test_declaration(),
        hub_v1_server_execution("ingress"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

#[tokio::test]
async fn selected_http_chat_entry_accepts_different_body_shapes() {
    std::env::set_var("V3_HTTP_INGRESS_TEST_KEY", "controlled-key");
    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(upstream))
        .with_state(Arc::new(captures_tx));
    let upstream_task = tokio::spawn(async move {
        axum::serve(upstream_listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let server_port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let handle = spawn_v3_server_aggregate(manifest(server_port, upstream_port))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let bodies = [
        json!({"model":"wire-model", "messages":[{"role":"user","content":"plain"}]}),
        json!({
            "model":"wire-model",
            "messages":[{"role":"user","content":[{"type":"text","text":"content-part shape"}]}]
        }),
    ];
    for body in &bodies {
        let response = client.post(&endpoint).json(body).send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        assert_eq!(status, StatusCode::OK, "{text}");
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap()["choices"][0]["message"]["content"],
            "ok"
        );
        let captured = captures_rx
            .recv()
            .await
            .expect("real provider receives request");
        assert_eq!(captured["messages"], body["messages"]);
    }
    let mut streaming = client
        .post(&endpoint)
        .json(&json!({
            "model":"wire-model", "messages":[{"role":"user","content":"disconnect"}], "stream":true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(streaming.status(), StatusCode::OK);
    let first_chunk = streaming.chunk().await.unwrap().expect("first SSE chunk");
    assert!(!String::from_utf8_lossy(&first_chunk).contains("[DONE]"));
    drop(streaming);
    assert_eq!(
        captures_rx.recv().await.unwrap()["messages"][0]["content"],
        "disconnect"
    );

    let failed = client
        .post(&endpoint)
        .json(&json!({
            "model":"wire-model", "messages":[{"role":"user","content":"fail"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(failed.status(), StatusCode::BAD_GATEWAY);
    let failure_body = failed.text().await.unwrap();
    assert!(failure_body.contains("network_error"), "{failure_body}");
    assert!(!failure_body.contains("controlled failure"));
    assert_eq!(
        captures_rx.recv().await.unwrap()["messages"][0]["content"],
        "fail"
    );

    handle.shutdown().await;
    shutdown_tx.send(()).unwrap();
    upstream_task.await.unwrap();
    std::env::remove_var("V3_HTTP_INGRESS_TEST_KEY");
}
