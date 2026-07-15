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
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        Message,
    },
};

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
    V3ResponsesProviderTarget {
        provider_id: "ws-provider".into(),
        base_url: "https://http-endpoint.invalid/v1".into(),
        canonical_model_id: "model".into(),
        wire_model: "model".into(),
        auth: V3ProviderAuthHandle {
            alias: "primary".into(),
            secret: V3ProviderAuthSecretHandle::Environment("V3_WS_KEY".into()),
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
