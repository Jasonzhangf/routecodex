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
    drop(client);
    tokio::time::timeout(Duration::from_secs(1), accept)
        .await
        .expect("peer EOF must terminate the front connection")
        .unwrap();

    let socket = broker
        .front_sockets
        .lock()
        .expect("front socket registry lock")
        .get(&connection_identity)
        .cloned()
        .expect("accepted front socket must remain inspectable");
    assert!(socket.is_closed(), "peer EOF must close the write worker");
}
