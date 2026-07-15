use futures_util::{SinkExt, StreamExt};
use routecodex_v3_config::V3ResponsesTransportKind;
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload,
    build_v3_transport_13_responses_request_from_v3_provider_12, ProviderResponsesTransport,
    ResponsesTransport, V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderError,
    V3ProviderResponseBodyKind, V3ResponsesProviderTarget,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        protocol::frame::{
            coding::{Data, OpCode},
            Frame,
        },
        Message,
    },
};

const RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE: &str = "responses_websockets=2026-02-06";

struct ControlledWebSocket {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    shutdown: oneshot::Sender<()>,
}

struct ControlledIncrementalWebSocket {
    url: String,
    release_terminal: oneshot::Sender<()>,
}

#[allow(clippy::result_large_err)]
fn require_websocket_auth(
    request: &Request,
    response: Response,
) -> Result<Response, ErrorResponse> {
    assert_eq!(
        request.headers().get("authorization").unwrap(),
        "Bearer websocket-secret"
    );
    assert_eq!(
        request.headers().get("openai-beta").unwrap(),
        RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE
    );
    Ok(response)
}

#[allow(clippy::result_large_err)]
async fn start_controlled_websocket(binary_terminal: bool) -> ControlledWebSocket {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let requests_task = requests.clone();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        let (stream, _) = tokio::select! {
            accepted = listener.accept() => accepted.unwrap(),
            _ = &mut shutdown_rx => return,
        };
        let mut socket = accept_hdr_async(stream, require_websocket_auth)
            .await
            .unwrap();
        let mut turn = 0usize;
        while let Some(message) = socket.next().await {
            let message = message.unwrap();
            let text = match message {
                Message::Text(text) => text.to_string(),
                Message::Binary(bytes) => String::from_utf8(bytes.to_vec()).unwrap(),
                Message::Close(_) => break,
                Message::Ping(bytes) => {
                    socket.send(Message::Pong(bytes)).await.unwrap();
                    continue;
                }
                Message::Pong(_) | Message::Frame(_) => continue,
            };
            let request: Value = serde_json::from_str(&text).unwrap();
            requests_task.lock().unwrap().push(request.clone());
            turn += 1;
            let response = if turn == 1 {
                json!({
                    "type":"response.completed",
                    "response":{
                        "id":"resp_ws_1",
                        "status":"completed",
                        "output":[{"type":"function_call","call_id":"call_ws_1","name":"lookup","arguments":"{}"}]
                    }
                })
            } else {
                assert_eq!(request["previous_response_id"], "resp_ws_1");
                json!({
                    "type":"response.completed",
                    "response":{
                        "id":"resp_ws_2",
                        "status":"completed",
                        "output":[{"type":"output_text","text":"done"}]
                    }
                })
            };
            let encoded = serde_json::to_vec(&response).unwrap();
            if binary_terminal {
                socket.send(Message::Binary(encoded)).await.unwrap();
            } else {
                socket
                    .send(Message::Text(String::from_utf8(encoded).unwrap()))
                    .await
                    .unwrap();
            }
        }
    });
    ControlledWebSocket {
        url: format!("ws://{address}/v1/responses"),
        requests,
        shutdown: shutdown_tx,
    }
}

async fn start_incremental_controlled_websocket() -> ControlledIncrementalWebSocket {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (release_terminal, release_terminal_rx) = oneshot::channel();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(stream, require_websocket_auth)
            .await
            .unwrap();
        let request = socket.next().await.unwrap().unwrap();
        assert!(matches!(request, Message::Text(_) | Message::Binary(_)));
        socket
            .send(Message::Text(
                serde_json::to_string(&json!({
                    "type":"response.output_text.delta",
                    "delta":"first"
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
        release_terminal_rx.await.unwrap();
        socket
            .send(Message::Text(
                serde_json::to_string(&json!({
                    "type":"response.completed",
                    "response":{
                        "id":"resp_ws_incremental",
                        "status":"completed",
                        "output":[{"type":"output_text","text":"first"}]
                    }
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
    });
    ControlledIncrementalWebSocket {
        url: format!("ws://{address}/v1/responses"),
        release_terminal,
    }
}

fn target(url: &str) -> V3ResponsesProviderTarget {
    target_with_env(url, "V3_WS_KEY")
}

fn target_with_env(url: &str, env: &str) -> V3ResponsesProviderTarget {
    V3ResponsesProviderTarget {
        provider_id: "ws-provider".into(),
        base_url: "https://http-endpoint.invalid/v1".into(),
        canonical_model_id: "model".into(),
        wire_model: "model".into(),
        auth: V3ProviderAuthHandle {
            alias: "primary".into(),
            secret: V3ProviderAuthSecretHandle::Environment(env.into()),
        },
        responses_transport: V3ResponsesTransportKind::WebsocketV2,
        websocket_v2_url: Some(url.into()),
    }
}

#[tokio::test]
async fn websocket_v2_reuses_one_connection_for_exact_incremental_continuation() {
    let controlled = start_controlled_websocket(false).await;
    std::env::set_var("V3_WS_KEY", "websocket-secret");
    let transport = ProviderResponsesTransport::default();

    let first_wire = build_v3_provider_12_responses_wire_payload(
        "req-ws-1",
        target(&controlled.url),
        json!({"model":"client","input":"use a tool","stream":false,"background":false}),
    )
    .unwrap();
    let first = transport
        .send(build_v3_transport_13_responses_request_from_v3_provider_12(first_wire).unwrap())
        .await
        .unwrap();
    assert_eq!(first.body_kind(), V3ProviderResponseBodyKind::Json);
    let first_body: Value =
        serde_json::from_slice(&first.into_body_bytes().await.unwrap()).unwrap();
    assert_eq!(first_body["id"], "resp_ws_1");

    let second_wire = build_v3_provider_12_responses_wire_payload(
        "req-ws-2",
        target(&controlled.url),
        json!({
            "model":"client",
            "previous_response_id":"resp_ws_1",
            "input":[{"type":"function_call_output","call_id":"call_ws_1","output":"ok"}],
            "stream":false
        }),
    )
    .unwrap();
    let second = transport
        .send(build_v3_transport_13_responses_request_from_v3_provider_12(second_wire).unwrap())
        .await
        .unwrap();
    let second_body: Value =
        serde_json::from_slice(&second.into_body_bytes().await.unwrap()).unwrap();
    assert_eq!(second_body["id"], "resp_ws_2");

    let requests = controlled.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["type"], "response.create");
    assert!(requests[0].get("stream").is_none());
    assert!(requests[0].get("background").is_none());
    assert_eq!(requests[1]["previous_response_id"], "resp_ws_1");
    assert_eq!(requests[1]["input"].as_array().unwrap().len(), 1);
    drop(requests);

    std::env::remove_var("V3_WS_KEY");
    let _ = controlled.shutdown.send(());
}

#[tokio::test]
async fn websocket_v2_binary_events_project_as_equivalent_sse_and_errors_never_fallback() {
    let controlled = start_controlled_websocket(true).await;
    std::env::set_var("V3_WS_KEY_BINARY", "websocket-secret");
    let mut selected = target(&controlled.url);
    selected.auth.secret = V3ProviderAuthSecretHandle::Environment("V3_WS_KEY_BINARY".into());
    let transport = ProviderResponsesTransport::default();
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-ws-sse",
        selected,
        json!({"model":"client","input":"hello","stream":true}),
    )
    .unwrap();
    let raw = transport
        .send(build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap())
        .await
        .unwrap();
    assert_eq!(raw.body_kind(), V3ProviderResponseBodyKind::Sse);
    let text = String::from_utf8(raw.into_body_bytes().await.unwrap()).unwrap();
    assert!(text.contains("event: response.completed\n"));
    assert!(text.contains("data: [DONE]\n\n"));

    let mut bad_target = V3ResponsesProviderTarget {
        websocket_v2_url: Some("ws://127.0.0.1:1/v1/responses".into()),
        ..target(&controlled.url)
    };
    bad_target.auth.secret = V3ProviderAuthSecretHandle::Environment("V3_WS_KEY_BINARY".into());
    let bad = build_v3_provider_12_responses_wire_payload(
        "req-ws-connect-error",
        bad_target,
        json!({"model":"client","input":"hello"}),
    )
    .unwrap();
    assert!(matches!(
        transport
            .send(build_v3_transport_13_responses_request_from_v3_provider_12(bad).unwrap())
            .await
            .unwrap_err(),
        V3ProviderError::WebSocketTransport { .. }
    ));

    std::env::remove_var("V3_WS_KEY_BINARY");
    let _ = controlled.shutdown.send(());
}

#[tokio::test]
async fn websocket_v2_sse_returns_first_frame_before_terminal_event() {
    let controlled = start_incremental_controlled_websocket().await;
    std::env::set_var("V3_WS_KEY_INCREMENTAL", "websocket-secret");
    let transport = ProviderResponsesTransport::default();
    let mut selected = target(&controlled.url);
    selected.auth.secret = V3ProviderAuthSecretHandle::Environment("V3_WS_KEY_INCREMENTAL".into());
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-ws-incremental",
        selected,
        json!({"model":"client","input":"hello","stream":true}),
    )
    .unwrap();
    let raw = tokio::time::timeout(
        std::time::Duration::from_millis(250),
        transport.send(build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap()),
    )
    .await
    .expect("SSE transport must return before the terminal provider event")
    .unwrap();
    let mut body = match raw.into_body() {
        routecodex_v3_provider_responses::V3ProviderResponseBody::Sse(body) => body,
        routecodex_v3_provider_responses::V3ProviderResponseBody::Json(_) => {
            panic!("expected incremental SSE body")
        }
    };
    let first = tokio::time::timeout(std::time::Duration::from_millis(250), body.next())
        .await
        .expect("first provider event must be projected incrementally")
        .unwrap()
        .unwrap();
    assert!(String::from_utf8(first)
        .unwrap()
        .contains("event: response.output_text.delta"));

    controlled.release_terminal.send(()).unwrap();
    let completed = body.next().await.unwrap().unwrap();
    assert!(String::from_utf8(completed)
        .unwrap()
        .contains("event: response.completed"));
    assert_eq!(body.next().await.unwrap().unwrap(), b"data: [DONE]\n\n");
    assert!(body.next().await.is_none());
    std::env::remove_var("V3_WS_KEY_INCREMENTAL");
}

#[derive(Clone)]
struct WebSocketMatrixServer {
    url: String,
    connection_count: Arc<Mutex<usize>>,
    requests: Arc<Mutex<Vec<Value>>>,
}

fn completed_event(id: &str, text: &str) -> Message {
    Message::Text(
        serde_json::to_string(&json!({
            "type":"response.completed",
            "response":{
                "id": id,
                "status":"completed",
                "output":[{"type":"output_text","text": text}]
            }
        }))
        .unwrap(),
    )
}

async fn start_early_drop_server() -> WebSocketMatrixServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let connection_count = Arc::new(Mutex::new(0usize));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let connection_count_task = connection_count.clone();
    let requests_task = requests.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let turn = {
                let mut count = connection_count_task.lock().unwrap();
                *count += 1;
                *count
            };
            let requests_task = requests_task.clone();
            tokio::spawn(async move {
                let mut socket = accept_hdr_async(stream, require_websocket_auth)
                    .await
                    .unwrap();
                let Some(Ok(message)) = socket.next().await else {
                    return;
                };
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Binary(bytes) => String::from_utf8(bytes.to_vec()).unwrap(),
                    _ => return,
                };
                requests_task
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(&text).unwrap());
                if turn == 1 {
                    socket
                        .send(Message::Text(
                            serde_json::to_string(&json!({
                                "type":"response.output_text.delta",
                                "delta":"early"
                            }))
                            .unwrap(),
                        ))
                        .await
                        .unwrap();
                    tokio::time::sleep(Duration::from_secs(10)).await;
                } else {
                    socket
                        .send(completed_event("resp_after_drop", "fresh"))
                        .await
                        .unwrap();
                }
            });
        }
    });
    WebSocketMatrixServer {
        url: format!("ws://{address}/v1/responses"),
        connection_count,
        requests,
    }
}

async fn start_bad_then_good_server(bad_message: Message) -> WebSocketMatrixServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let connection_count = Arc::new(Mutex::new(0usize));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let connection_count_task = connection_count.clone();
    let requests_task = requests.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let turn = {
                let mut count = connection_count_task.lock().unwrap();
                *count += 1;
                *count
            };
            let requests_task = requests_task.clone();
            let bad_message = bad_message.clone();
            tokio::spawn(async move {
                let mut socket = accept_hdr_async(stream, require_websocket_auth)
                    .await
                    .unwrap();
                let Some(Ok(message)) = socket.next().await else {
                    return;
                };
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Binary(bytes) => String::from_utf8(bytes.to_vec()).unwrap(),
                    _ => return,
                };
                requests_task
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(&text).unwrap());
                if turn == 1 {
                    let _ = socket.send(bad_message).await;
                } else {
                    socket
                        .send(completed_event("resp_after_error", "fresh"))
                        .await
                        .unwrap();
                }
            });
        }
    });
    WebSocketMatrixServer {
        url: format!("ws://{address}/v1/responses"),
        connection_count,
        requests,
    }
}

async fn send_json(
    transport: &ProviderResponsesTransport,
    request_id: &str,
    url: &str,
    env: &str,
) -> Result<Value, V3ProviderError> {
    let wire = build_v3_provider_12_responses_wire_payload(
        request_id,
        target_with_env(url, env),
        json!({"model":"client","input":"hello","stream":false}),
    )
    .unwrap();
    let raw = transport
        .send(build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap())
        .await?;
    serde_json::from_slice(&raw.into_body_bytes().await?).map_err(|error| {
        V3ProviderError::WebSocketProtocol {
            request_id: request_id.to_string(),
            provider_id: "ws-provider".to_string(),
            reason: error.to_string(),
        }
    })
}

#[tokio::test]
async fn websocket_v2_early_sse_drop_discards_connection_before_next_turn() {
    let controlled = start_early_drop_server().await;
    std::env::set_var("V3_WS_KEY_EARLY_DROP", "websocket-secret");
    let transport = ProviderResponsesTransport::default();
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-ws-early-drop",
        target_with_env(&controlled.url, "V3_WS_KEY_EARLY_DROP"),
        json!({"model":"client","input":"hello","stream":true}),
    )
    .unwrap();
    let raw = transport
        .send(build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap())
        .await
        .unwrap();
    let mut body = match raw.into_body() {
        routecodex_v3_provider_responses::V3ProviderResponseBody::Sse(body) => body,
        routecodex_v3_provider_responses::V3ProviderResponseBody::Json(_) => {
            panic!("expected SSE body")
        }
    };
    let first = body.next().await.unwrap().unwrap();
    assert!(String::from_utf8(first).unwrap().contains("early"));
    drop(body);

    let second = send_json(
        &transport,
        "req-ws-after-early-drop",
        &controlled.url,
        "V3_WS_KEY_EARLY_DROP",
    )
    .await
    .unwrap();
    assert_eq!(second["id"], "resp_after_drop");
    assert_eq!(*controlled.connection_count.lock().unwrap(), 2);
    assert_eq!(controlled.requests.lock().unwrap().len(), 2);
    std::env::remove_var("V3_WS_KEY_EARLY_DROP");
}

#[tokio::test]
async fn websocket_v2_provider_and_protocol_errors_discard_connection_before_reuse() {
    let cases = vec![
        (
            "V3_WS_KEY_ERROR_EVENT",
            Message::Text(
                serde_json::to_string(&json!({
                    "type":"error",
                    "status":429,
                    "error":{"code":"rate_limit","message":"limited"}
                }))
                .unwrap(),
            ),
            "event",
        ),
        (
            "V3_WS_KEY_FAILED_EVENT",
            Message::Text(
                serde_json::to_string(&json!({
                    "type":"response.failed",
                    "response":{"error":{"message":"failed"}}
                }))
                .unwrap(),
            ),
            "failed",
        ),
        (
            "V3_WS_KEY_INCOMPLETE_EVENT",
            Message::Text(
                serde_json::to_string(&json!({
                    "type":"response.incomplete",
                    "response":{"incomplete_details":{"reason":"max_output_tokens"}}
                }))
                .unwrap(),
            ),
            "incomplete",
        ),
        (
            "V3_WS_KEY_MISSING_TYPE",
            Message::Text(serde_json::to_string(&json!({"response":{}})).unwrap()),
            "missing-type",
        ),
        (
            "V3_WS_KEY_MALFORMED_JSON",
            Message::Text("{".to_string()),
            "malformed",
        ),
        (
            "V3_WS_KEY_CLOSE_BEFORE_TERMINAL",
            Message::Close(None),
            "close",
        ),
    ];

    for (env, bad_message, label) in cases {
        let controlled = start_bad_then_good_server(bad_message).await;
        std::env::set_var(env, "websocket-secret");
        let transport = ProviderResponsesTransport::default();
        let first = send_json(
            &transport,
            &format!("req-ws-bad-{label}"),
            &controlled.url,
            env,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(
                first,
                V3ProviderError::WebSocketProviderEvent { .. }
                    | V3ProviderError::WebSocketProtocol { .. }
                    | V3ProviderError::WebSocketTransport { .. }
            ),
            "{label}: unexpected error {first:?}"
        );
        let second = send_json(
            &transport,
            &format!("req-ws-good-after-{label}"),
            &controlled.url,
            env,
        )
        .await
        .unwrap();
        assert_eq!(second["id"], "resp_after_error");
        assert_eq!(
            *controlled.connection_count.lock().unwrap(),
            2,
            "{label}: failed connection must be discarded before reuse"
        );
        std::env::remove_var(env);
    }
}

#[tokio::test]
async fn websocket_v2_read_cancellation_discards_connection_before_reuse() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let connection_count = Arc::new(Mutex::new(0usize));
    let requests = Arc::new(Mutex::new(0usize));
    let (first_request_seen_tx, first_request_seen_rx) = oneshot::channel();
    let first_request_seen = Arc::new(Mutex::new(Some(first_request_seen_tx)));
    let connection_count_task = connection_count.clone();
    let requests_task = requests.clone();
    let first_request_seen_task = first_request_seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let turn = {
                let mut count = connection_count_task.lock().unwrap();
                *count += 1;
                *count
            };
            let requests_task = requests_task.clone();
            let first_request_seen_task = first_request_seen_task.clone();
            tokio::spawn(async move {
                let mut socket = accept_hdr_async(stream, require_websocket_auth)
                    .await
                    .unwrap();
                let Some(Ok(_message)) = socket.next().await else {
                    return;
                };
                *requests_task.lock().unwrap() += 1;
                if turn == 1 {
                    if let Some(sender) = first_request_seen_task.lock().unwrap().take() {
                        let _ = sender.send(());
                    }
                    tokio::time::sleep(Duration::from_secs(10)).await;
                } else {
                    socket
                        .send(completed_event("resp_after_cancel", "fresh"))
                        .await
                        .unwrap();
                }
            });
        }
    });
    let url = format!("ws://{address}/v1/responses");
    std::env::set_var("V3_WS_KEY_READ_CANCEL", "websocket-secret");
    let transport = ProviderResponsesTransport::default();
    let cancellation = routecodex_v3_provider_responses::V3ProviderCancellation::new();
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-ws-read-cancel",
        target_with_env(&url, "V3_WS_KEY_READ_CANCEL"),
        json!({"model":"client","input":"hello","stream":false}),
    )
    .unwrap();
    let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire)
        .unwrap()
        .with_cancellation(cancellation.clone());
    let first_send = tokio::spawn({
        let transport = transport.clone();
        async move { transport.send(request).await }
    });
    first_request_seen_rx.await.unwrap();
    cancellation.cancel();
    assert!(matches!(
        first_send.await.unwrap().unwrap_err(),
        V3ProviderError::ClientDisconnect { .. }
    ));
    let second = send_json(
        &transport,
        "req-ws-after-read-cancel",
        &url,
        "V3_WS_KEY_READ_CANCEL",
    )
    .await
    .unwrap();
    assert_eq!(second["id"], "resp_after_cancel");
    assert_eq!(*connection_count.lock().unwrap(), 2);
    assert_eq!(*requests.lock().unwrap(), 2);
    std::env::remove_var("V3_WS_KEY_READ_CANCEL");
}

#[tokio::test]
async fn websocket_v2_concurrent_streams_are_serialized_without_cross_frame_leakage() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let requests_task = requests.clone();
    let (release_first_tx, mut release_first_rx) = oneshot::channel();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(stream, require_websocket_auth)
            .await
            .unwrap();
        let first = socket.next().await.unwrap().unwrap();
        let first_text = match first {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8(bytes.to_vec()).unwrap(),
            _ => panic!("unexpected first message"),
        };
        requests_task
            .lock()
            .unwrap()
            .push(serde_json::from_str::<Value>(&first_text).unwrap());
        socket
            .send(Message::Text(
                serde_json::to_string(&json!({
                    "type":"response.output_text.delta",
                    "delta":"first-stream"
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
        tokio::select! {
            _ = &mut release_first_rx => {}
            _ = tokio::time::sleep(Duration::from_secs(10)) => panic!("first stream not released"),
        }
        socket
            .send(completed_event("resp_first_stream", "first"))
            .await
            .unwrap();
        let second = socket.next().await.unwrap().unwrap();
        let second_text = match second {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8(bytes.to_vec()).unwrap(),
            _ => panic!("unexpected second message"),
        };
        requests_task
            .lock()
            .unwrap()
            .push(serde_json::from_str::<Value>(&second_text).unwrap());
        socket
            .send(completed_event("resp_second_stream", "second"))
            .await
            .unwrap();
    });
    let url = format!("ws://{address}/v1/responses");
    std::env::set_var("V3_WS_KEY_CONCURRENT", "websocket-secret");
    let transport = ProviderResponsesTransport::default();
    let first_wire = build_v3_provider_12_responses_wire_payload(
        "req-ws-concurrent-1",
        target_with_env(&url, "V3_WS_KEY_CONCURRENT"),
        json!({"model":"client","input":"first","stream":true}),
    )
    .unwrap();
    let first_raw = transport
        .send(build_v3_transport_13_responses_request_from_v3_provider_12(first_wire).unwrap())
        .await
        .unwrap();
    let mut first_body = match first_raw.into_body() {
        routecodex_v3_provider_responses::V3ProviderResponseBody::Sse(body) => body,
        routecodex_v3_provider_responses::V3ProviderResponseBody::Json(_) => {
            panic!("expected SSE body")
        }
    };
    assert!(String::from_utf8(first_body.next().await.unwrap().unwrap())
        .unwrap()
        .contains("first-stream"));

    let second_send = tokio::spawn({
        let transport = transport.clone();
        let url = url.clone();
        async move {
            send_json(
                &transport,
                "req-ws-concurrent-2",
                &url,
                "V3_WS_KEY_CONCURRENT",
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        requests.lock().unwrap().len(),
        1,
        "second request must wait until first SSE stream terminal drain"
    );
    release_first_tx.send(()).unwrap();
    while first_body.next().await.is_some() {}
    let second = second_send.await.unwrap().unwrap();
    assert_eq!(second["id"], "resp_second_stream");
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 2);
    assert_eq!(captured[0]["input"], "first");
    assert_eq!(captured[1]["input"], "hello");
    drop(captured);
    std::env::remove_var("V3_WS_KEY_CONCURRENT");
}

#[tokio::test]
async fn websocket_v2_ping_pong_and_split_utf8_frames_preserve_one_terminal_event() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(stream, require_websocket_auth)
            .await
            .unwrap();
        assert!(matches!(
            socket.next().await.unwrap().unwrap(),
            Message::Text(_) | Message::Binary(_)
        ));
        socket
            .send(Message::Ping(b"health".as_slice().into()))
            .await
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            Message::Pong(b"health".as_slice().into())
        );
        let encoded = serde_json::to_vec(&json!({
            "type":"response.completed",
            "response":{
                "id":"resp_split_utf8",
                "status":"completed",
                "output":[{"type":"output_text","text":"你好"}]
            }
        }))
        .unwrap();
        let split = encoded
            .windows(3)
            .position(|window| window == "你".as_bytes())
            .unwrap()
            + 1;
        socket
            .send(Message::Frame(Frame::message(
                encoded[..split].to_vec(),
                OpCode::Data(Data::Text),
                false,
            )))
            .await
            .unwrap();
        socket
            .send(Message::Frame(Frame::message(
                encoded[split..].to_vec(),
                OpCode::Data(Data::Continue),
                true,
            )))
            .await
            .unwrap();
    });
    let url = format!("ws://{address}/v1/responses");
    std::env::set_var("V3_WS_KEY_SPLIT_UTF8", "websocket-secret");
    let transport = ProviderResponsesTransport::default();
    let response = send_json(
        &transport,
        "req-ws-split-utf8",
        &url,
        "V3_WS_KEY_SPLIT_UTF8",
    )
    .await
    .unwrap();
    assert_eq!(response["id"], "resp_split_utf8");
    assert_eq!(response["output"][0]["text"], "你好");
    std::env::remove_var("V3_WS_KEY_SPLIT_UTF8");
}

#[tokio::test]
async fn websocket_v2_cancellation_before_connect_or_reused_send_is_client_disconnect() {
    std::env::set_var("V3_WS_KEY_CANCEL_BEFORE_CONNECT", "websocket-secret");
    let transport = ProviderResponsesTransport::default();
    let cancelled_before_connect = routecodex_v3_provider_responses::V3ProviderCancellation::new();
    cancelled_before_connect.cancel();
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-ws-cancel-before-connect",
        target_with_env(
            "ws://127.0.0.1:1/v1/responses",
            "V3_WS_KEY_CANCEL_BEFORE_CONNECT",
        ),
        json!({"model":"client","input":"hello","stream":false}),
    )
    .unwrap();
    let error = transport
        .send(
            build_v3_transport_13_responses_request_from_v3_provider_12(wire)
                .unwrap()
                .with_cancellation(cancelled_before_connect),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, V3ProviderError::ClientDisconnect { .. }));
    std::env::remove_var("V3_WS_KEY_CANCEL_BEFORE_CONNECT");

    let controlled = start_controlled_websocket(false).await;
    std::env::set_var("V3_WS_KEY_CANCEL_BEFORE_SEND", "websocket-secret");
    let transport = ProviderResponsesTransport::default();
    let first = send_json(
        &transport,
        "req-ws-before-send-prime",
        &controlled.url,
        "V3_WS_KEY_CANCEL_BEFORE_SEND",
    )
    .await
    .unwrap();
    assert_eq!(first["id"], "resp_ws_1");

    let cancelled_before_send = routecodex_v3_provider_responses::V3ProviderCancellation::new();
    cancelled_before_send.cancel();
    let wire = build_v3_provider_12_responses_wire_payload(
        "req-ws-cancel-before-send",
        target_with_env(&controlled.url, "V3_WS_KEY_CANCEL_BEFORE_SEND"),
        json!({"model":"client","input":"must not send","stream":false}),
    )
    .unwrap();
    let error = transport
        .send(
            build_v3_transport_13_responses_request_from_v3_provider_12(wire)
                .unwrap()
                .with_cancellation(cancelled_before_send),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, V3ProviderError::ClientDisconnect { .. }));

    let second_wire = build_v3_provider_12_responses_wire_payload(
        "req-ws-after-cancel-before-send",
        target_with_env(&controlled.url, "V3_WS_KEY_CANCEL_BEFORE_SEND"),
        json!({
            "model":"client",
            "previous_response_id":"resp_ws_1",
            "input":[{"type":"function_call_output","call_id":"call_ws_1","output":"ok"}],
            "stream":false
        }),
    )
    .unwrap();
    let second_raw = transport
        .send(build_v3_transport_13_responses_request_from_v3_provider_12(second_wire).unwrap())
        .await
        .unwrap();
    let second: Value =
        serde_json::from_slice(&second_raw.into_body_bytes().await.unwrap()).unwrap();
    assert_eq!(second["id"], "resp_ws_2");
    assert_eq!(controlled.requests.lock().unwrap().len(), 2);
    std::env::remove_var("V3_WS_KEY_CANCEL_BEFORE_SEND");
    let _ = controlled.shutdown.send(());
}
