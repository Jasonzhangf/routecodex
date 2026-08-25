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
