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
use std::{net::TcpListener, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug)]
struct ProviderCapture {
    body: Value,
}

#[derive(Clone)]
struct ProviderState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

async fn controlled_openai_chat_upstream(
    State(state): State<Arc<ProviderState>>,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture { body: body.clone() })
        .unwrap();

    if body.pointer("/messages/0/content").and_then(Value::as_str) == Some("fail") {
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"error":{"type":"rate_limit_error","message":"raw provider secret detail"}}"#,
            ))
            .unwrap();
    }
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let omit_done =
            body.pointer("/messages/0/content").and_then(Value::as_str) == Some("omit-done");
        let stream = futures_util::stream::unfold(0_u8, move |step| async move {
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
                    let terminal = if omit_done {
                        br#"data: {"id":"chatcmpl-controlled","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

"#
                            .to_vec()
                    } else {
                        br#"data: {"id":"chatcmpl-controlled","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#
                            .to_vec()
                    };
                    Some((Ok(terminal), 2))
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
async fn chat_entry_same_protocol_provider_runs_direct_isolated() {
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

    // 1. Same-protocol chat entry must reach the isolated Direct skeleton and
    //    return the projected client body.
    let json_response = client
        .post(&endpoint)
        .json(&json!({
            "model":"chat-client-alias",
            "messages":[{"role":"user","content":"json"}],
            "tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}],
            "stream":false
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
    assert_eq!(json_capture.body["model"], "chat-wire-model");

    // 2. The entry must have resolved to Direct, not Relay. The Server03 raw
    //    request event records the binding-resolved execution mode.
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
    let events = logs["logs"].as_array().expect("debug logs array");
    let entry_modes = events
        .iter()
        .filter(|event| event["node_id"] == "V3Server03HttpRequestRaw")
        .filter_map(|event| event["details"]["execution_mode"].as_str())
        .collect::<Vec<_>>();
    assert!(
        !entry_modes.is_empty(),
        "chat entry must record its binding-resolved execution mode: {logs}"
    );
    assert!(
        entry_modes.iter().all(|mode| *mode == "direct"),
        "chat entry with a chat-wire provider must resolve Direct, saw {entry_modes:?}"
    );

    // 3. Full-attempt buffering: the provider semantic frames must remain
    //    client-invisible until the attempt reaches a validated terminal.
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

    // 3b. OpenAI Chat's client protocol terminal is the `data: [DONE]`
    //     sentinel. A chat-wire provider that closes after the semantic
    //     terminal without emitting it must still yield the client closeout
    //     (parity with the chat relay path).
    let omit_done_response = client
        .post(&endpoint)
        .json(&json!({
            "model":"chat-client-alias",
            "messages":[{"role":"user","content":"omit-done"}],
            "stream":true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(omit_done_response.status(), StatusCode::OK);
    let omit_done_body = tokio::time::timeout(Duration::from_secs(2), omit_done_response.bytes())
        .await
        .unwrap()
        .unwrap();
    let omit_done_text = String::from_utf8(omit_done_body.to_vec()).unwrap();
    assert!(
        omit_done_text.contains(r#""finish_reason":"stop""#),
        "{omit_done_text}"
    );
    assert_eq!(
        omit_done_text.matches("data: [DONE]").count(),
        1,
        "provider omitting [DONE] must still yield exactly one client closeout: {omit_done_text}"
    );
    let _omit_done_capture = captures_rx.recv().await.unwrap();

    // 4. Provider error must enter the typed Error chain and never leak the raw
    //    provider error body to the client.  The provider transport failure is
    //    projected through the shared V3 error center (network_error / 502),
    //    exactly as the relay path does; the raw 429 body is not surfaced.
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
    assert_eq!(error_response.status(), StatusCode::BAD_GATEWAY);
    let error_body: Value = error_response.json().await.unwrap();
    let serialized = serde_json::to_string(&error_body).unwrap();
    assert!(
        !serialized.contains("raw provider secret detail"),
        "raw provider error body must not leak to client: {error_body}"
    );
    assert!(
        error_body["error"].get("class").is_none()
            && error_body["error"].get("error_node").is_none()
            && error_body["error"].get("stage").is_none()
            && error_body["error"].get("decision").is_none(),
        "Error06 body must not carry control-plane fields: {error_body}"
    );
    let error_capture = tokio::time::timeout(Duration::from_secs(2), captures_rx.recv())
        .await
        .expect("provider failure must produce a capture")
        .unwrap();
    assert_eq!(
        error_capture.body.pointer("/messages/0/content"),
        Some(&json!("fail"))
    );

    handle.shutdown().await;
    upstream_shutdown_tx.send(()).unwrap();
    std::env::remove_var("V3_OPENAI_CHAT_CONTROLLED_KEY");
}

#[tokio::test]
async fn chat_direct_isolated_applies_configured_provider_compat_profile() {
    // Regression: the Direct chat flip routed chat-wire providers through the
    // Direct kernel, which rejected any non-`responses:*` compatibility
    // profile (hard 599) and skipped the provider request/response compat the
    // Relay path applied. A chat-wire provider declaring
    // `chat:glm-unsupported-prompt-cache-key-verbosity` must run Direct, strip
    // the unsupported fields through the single compat owner, and still return
    // the projected client body.
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

    let handle = spawn_v3_server_aggregate(manifest_with_profile(
        free_port(),
        upstream_addr.port(),
        Some("chat:glm-unsupported-prompt-cache-key-verbosity"),
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);
    let client = reqwest::Client::new();

    let response = client
        .post(&endpoint)
        .json(&json!({
            "model":"chat-client-alias",
            "messages":[{"role":"user","content":"json"}],
            "prompt_cache_key":"client-supplied-cache-key",
            "verbosity":"high",
            "stream":false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "a chat-wire provider with a chat:* profile must not 599 on the Direct path"
    );
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["choices"][0]["message"]["content"], "controlled json");

    let capture = captures_rx.recv().await.unwrap();
    assert_eq!(capture.body["model"], "chat-wire-model");
    assert!(
        capture.body.get("prompt_cache_key").is_none(),
        "provider request compat owner must strip prompt_cache_key: {}",
        capture.body
    );
    assert!(
        capture.body.get("verbosity").is_none(),
        "provider request compat owner must strip verbosity: {}",
        capture.body
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
    manifest_with_profile(server_port, upstream_port, None)
}

fn manifest_with_profile(
    server_port: u16,
    upstream_port: u16,
    compatibility_profile: Option<&str>,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    // The shared hub_v1 fixture now defaults openai_chat to Direct, which is the
    // behavior under test: a chat entry with a chat-wire provider must run the
    // isolated Direct skeleton.
    let compatibility_profile = compatibility_profile
        .map(|profile| format!("compatibility_profile = \"{profile}\"\n"))
        .unwrap_or_default();
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
{compatibility_profile}auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "V3_OPENAI_CHAT_CONTROLLED_KEY" }}] }}
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
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("controlled"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}
