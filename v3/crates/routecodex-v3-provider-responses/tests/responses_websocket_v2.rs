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
        handshake::server::{Request, Response},
        Message,
    },
};

struct ControlledWebSocket {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    shutdown: oneshot::Sender<()>,
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
        let mut socket = accept_hdr_async(stream, |request: &Request, response: Response| {
            assert_eq!(
                request.headers().get("authorization").unwrap(),
                "Bearer websocket-secret"
            );
            Ok(response)
        })
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

    let bad_target = V3ResponsesProviderTarget {
        websocket_v2_url: Some("ws://127.0.0.1:1/v1/responses".into()),
        ..target(&controlled.url)
    };
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
