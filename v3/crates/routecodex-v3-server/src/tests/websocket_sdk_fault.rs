use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

/// A typed SDK fault is not a client payload. The real WebSocket consumer must
/// close the transport and retain both the policy failure and original cause
/// through the existing private diagnostic owner.
#[tokio::test]
async fn websocket_sdk_fault_consumer_breaks_transport_and_retains_both_diagnostics() {
    let policy_source = routecodex_v3_error::build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3Error06ClientProjected",
        "relay_error_operator_sdk_failure",
        "synthetic WebSocket SDK failure",
    );
    let original_source = routecodex_v3_error::build_v3_error_01_source_raised(
        V3ErrorSourceKind::InvalidRequest,
        "V3ServerRespOutbound06ClientFrame",
        "invalid_client_event",
        "client WebSocket event is missing type",
    );
    let fault = routecodex_v3_runtime::V3RelayErrorOperatorFault {
        policy_failure: policy_source.clone(),
        original_source: Some(original_source.clone()),
    };

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app_fault = fault.clone();
    let app = axum::Router::new().route(
        "/v1/responses",
        axum::routing::get(move |ws: axum::extract::WebSocketUpgrade| {
            let fault = app_fault.clone();
            async move {
                ws.on_upgrade(move |mut socket| async move {
                    let _ = socket.next().await;
                    let _ =
                        send_responses_websocket_error_sdk_result(&mut socket, Err(fault)).await;
                })
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let (mut socket, handshake) =
        tokio_tungstenite::connect_async(format!("ws://{address}/v1/responses"))
            .await
            .expect("test-only SDK fault route must accept the real WebSocket upgrade");
    assert_eq!(handshake.status(), StatusCode::SWITCHING_PROTOCOLS);
    socket
        .send(Message::Text("{}".to_string()))
        .await
        .expect("client must send the request.create frame that activates the fault consumer");
    let terminal = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("the SDK fault must terminate the WebSocket transport");
    match terminal {
        None | Some(Ok(Message::Close(_))) | Some(Err(_)) => {}
        Some(Ok(message)) => {
            panic!(
                "the SDK fault must not send a text, binary, or application payload: {message:?}"
            )
        }
    }
    let diagnostics = take_responses_websocket_sdk_fault_diagnostics();
    assert_eq!(
        diagnostics.len(),
        1,
        "the consumer must record one typed fault"
    );
    assert!(
        diagnostics[0].contains(&format!(
            "policy_kind={:?} policy_stage={} policy_code={} policy_message={:?}",
            policy_source.source_kind,
            policy_source.source_stage,
            policy_source.code,
            policy_source.message
        )),
        "the policy source must survive the Server consumer: {}",
        diagnostics[0]
    );
    assert!(
        diagnostics[0].contains(&format!(
            "original_kind={:?} original_stage={} original_code={} original_message={:?}",
            original_source.source_kind,
            original_source.source_stage,
            original_source.code,
            original_source.message
        )),
        "the original cause must survive the Server consumer: {}",
        diagnostics[0]
    );
    let _ = socket.close(None).await;
    server.abort();
    let _ = server.await;
}
