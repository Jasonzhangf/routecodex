use super::super::*;

#[test]
fn restart_closeout_has_explicit_terminal_for_request_before_response_headers() {
    let frame = V3FrontTransportCloseoutState::new();
    frame.mark_request_started();
    frame.close_for_exec_replacement();
    let frame = frame.take_frame().expect("restart closeout frame");
    let text = String::from_utf8(frame).expect("restart response is HTTP bytes");
    assert!(text.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
    assert!(text.contains("server_restart_in_progress"));
    let unstarted = V3FrontTransportCloseoutState::new();
    unstarted.close_for_exec_replacement();
    assert!(unstarted.take_frame().is_none());
    let started = V3FrontTransportCloseoutState::new();
    started.mark_request_started();
    started.mark_response_started();
    started.close_for_exec_replacement();
    assert!(started.take_frame().is_none());
}

#[test]
fn persistent_connection_second_request_gets_preheader_restart_terminal() {
    let state = V3FrontTransportCloseoutState::new();

    state.mark_request_started();
    state.mark_response_started();
    state.set_frame(b"event: response.failed\ndata: stale\n\n".to_vec());

    state.mark_request_started();
    state.close_for_exec_replacement();

    let frame = state
        .take_frame()
        .expect("a new keep-alive request must not inherit the previous response phase");
    let text = String::from_utf8(frame).expect("restart response is HTTP bytes");
    assert!(text.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
    assert!(text.contains("server_restart_in_progress"));
}

#[test]
fn suppressed_streaming_terminal_defers_the_restart_closeout() {
    let state = V3FrontTransportCloseoutState::new();
    state.mark_request_started();
    state.set_frame(b"HTTP/1.1 503 Service Unavailable\r\n\r\n".to_vec());
    assert!(state.suppress_restart_closeout_frame());
    assert!(
        !state.close_for_exec_replacement(),
        "a suppressed streaming terminal must defer the restart closeout"
    );
    assert!(
        state.take_frame().is_none(),
        "a deferred restart closeout must not queue a frame"
    );
    assert!(
        !state.is_closed(),
        "a deferred restart closeout must leave the transport writable for the SSE head"
    );
    assert!(state.terminal_frame_suppressed());
}

#[test]
fn committed_restart_closeout_keeps_its_frame_over_a_late_suppression() {
    let state = V3FrontTransportCloseoutState::new();
    state.mark_request_started();
    assert!(state.close_for_exec_replacement());
    assert!(
        !state.suppress_restart_closeout_frame(),
        "a committed restart closeout must not be cleared by a late suppression"
    );
    let frame = state
        .take_frame()
        .expect("committed restart closeout frame");
    let text = String::from_utf8(frame).expect("restart response is HTTP bytes");
    assert!(text.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
    assert!(text.contains("server_restart_in_progress"));
}

#[tokio::test]
async fn front_socket_deferred_closeout_keeps_the_sse_head_writable() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let accept = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (_, write_half) = stream.into_split();
        let socket = V3StableFrontSocket::spawn(write_half);
        socket.mark_request_started();
        assert!(socket.suppress_restart_closeout_frame());
        socket.close_for_exec_replacement();
        assert!(
            !socket.is_closed(),
            "a deferred restart closeout must leave the front socket writable"
        );
        socket
            .write_tx
            .send(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n\
                  : routecodex provider transport break\n\n"
                    .to_vec(),
            )
            .await
            .expect("the deferred transport must still accept the SSE boundary frame");
        socket
    });
    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
    let mut buffer = [0u8; 256];
    let received = tokio::time::timeout(
        Duration::from_secs(1),
        tokio::io::AsyncReadExt::read(&mut client, &mut buffer),
    )
    .await
    .expect("the SSE boundary frame must reach the client")
    .expect("client read");
    let text = String::from_utf8_lossy(&buffer[..received]).into_owned();
    assert!(
        text.starts_with("HTTP/1.1 200"),
        "the deferred closeout must let the SSE response head reach the client: {text:?}"
    );
    assert!(
        text.contains(": routecodex provider transport break"),
        "the deferred closeout must let the transport break reach the client: {text:?}"
    );
    assert!(
        !text.contains("503"),
        "a deferred closeout must not write the restart frame: {text:?}"
    );
    let socket = accept.await.unwrap();
    assert!(socket.closeout_state.take_frame().is_none());
}

#[tokio::test]
async fn front_socket_committed_closeout_keeps_the_restart_503() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let accept = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (_, write_half) = stream.into_split();
        let socket = V3StableFrontSocket::spawn(write_half);
        socket.mark_request_started();
        socket.close_for_exec_replacement();
        assert!(
            !socket.suppress_restart_closeout_frame(),
            "a late suppression must not clear a committed restart closeout"
        );
    });
    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(1),
        tokio::io::AsyncReadExt::read_to_end(&mut client, &mut response),
    )
    .await
    .expect("a committed restart closeout must terminate the client transport")
    .expect("client read must succeed");
    let response = String::from_utf8(response).expect("restart response must be HTTP bytes");
    assert!(
        response.starts_with("HTTP/1.1 503 Service Unavailable\r\n"),
        "a committed restart closeout stays the client boundary: {response:?}"
    );
    assert!(response.contains("server_restart_in_progress"));
    accept.await.unwrap();
}

#[tokio::test]
async fn front_socket_writes_restart_terminal_after_request_acceptance() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let accept = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (_, write_half) = stream.into_split();
        let socket = V3StableFrontSocket::spawn(write_half);
        socket.mark_request_started();
        socket.close_for_exec_replacement();
    });
    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(1),
        tokio::io::AsyncReadExt::read_to_end(&mut client, &mut response),
    )
    .await
    .expect("restart closeout must terminate the client transport")
    .expect("client read must succeed");
    let response = String::from_utf8(response).expect("restart response must be HTTP bytes");
    assert!(response.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
    assert!(response.contains("server_restart_in_progress"));
    accept.await.unwrap();
}

#[tokio::test]
async fn front_socket_writes_configured_sse_terminal_after_headers() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let expected = b"event: response.failed\ndata: {}\n\n".to_vec();
    let accept_expected = expected.clone();
    let accept = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (_, write_half) = stream.into_split();
        let socket = V3StableFrontSocket::spawn(write_half);
        socket.mark_request_started();
        socket.closeout_state.mark_response_started();
        socket.set_exec_closeout_frame(accept_expected);
        socket.close_for_exec_replacement();
    });
    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(1),
        tokio::io::AsyncReadExt::read_to_end(&mut client, &mut response),
    )
    .await
    .expect("SSE restart closeout must terminate the client transport")
    .expect("client read must succeed");
    assert_eq!(response, expected);
    accept.await.unwrap();
}

#[tokio::test]
async fn peer_eof_closes_front_socket_and_write_worker() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let broker = V3FrontTransportBroker::new(0);
    let connection_identity = broker.allocate_connection_identity();
    let service = axum::Router::new().into_service();
    let accept_broker = broker.clone();
    let accept = tokio::spawn(async move {
        let (stream, remote_addr) = listener.accept().await.unwrap();
        serve_v3_front_http_connection(
            stream,
            remote_addr,
            connection_identity,
            accept_broker,
            service,
        )
        .await
        .unwrap();
    });

    let client = tokio::net::TcpStream::connect(address).await.unwrap();
    let socket = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Some(socket) = broker.front_socket(connection_identity) {
                break socket;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("accepted front socket must be registered before peer EOF");
    drop(client);
    tokio::time::timeout(Duration::from_secs(1), accept)
        .await
        .expect("peer EOF must terminate the front connection")
        .unwrap();

    assert!(
        broker.front_socket(connection_identity).is_none(),
        "completed connection must release its socket registry entry"
    );
    assert!(socket.is_closed(), "peer EOF must close the write worker");
}
