use super::super::*;

#[test]
fn restart_closeout_closes_without_error_for_request_before_response_headers() {
    let frame = V3FrontTransportCloseoutState::new();
    frame.mark_request_started();
    frame.close_for_exec_replacement();
    assert!(frame.is_closed());
    assert!(frame.take_frame().is_none());
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

    assert!(state.is_closed());
    assert!(
        state.take_frame().is_none(),
        "restart must clear stale response bytes"
    );
}

#[test]
fn deferred_restart_closeout_commits_when_the_enqueued_head_never_reached_the_client() {
    let state = V3FrontTransportCloseoutState::new();
    state.mark_request_started();
    assert!(state.suppress_restart_closeout_frame());
    // Hyper enqueued the SSE response head, but the write worker has not flushed it
    // yet. Deferring on the enqueue instead of the write would let the biased close
    // signal drop the queued head and leave the client with zero bytes.
    state.mark_response_started();
    assert!(!state.transport_wrote());
    assert!(
        !state.close_for_exec_replacement(),
        "a suppressed streaming terminal must defer the restart closeout"
    );
    assert!(
        !state.is_closed(),
        "a deferred restart closeout must leave the transport writable for the SSE head"
    );
    assert!(
        state.commit_deferred_restart_closeout(),
        "the deferred close must commit when the head never reached the client"
    );
    assert!(state.is_closed());
    assert!(state.take_frame().is_none());
}

#[test]
fn deferred_restart_closeout_is_dropped_once_the_transport_wrote_the_response() {
    let state = V3FrontTransportCloseoutState::new();
    state.mark_request_started();
    assert!(state.suppress_restart_closeout_frame());
    assert!(!state.close_for_exec_replacement());
    state.mark_response_started();
    state.mark_transport_wrote();
    assert!(
        !state.commit_deferred_restart_closeout(),
        "response bytes that reached the client keep the SSE transport break as the boundary"
    );
    assert!(!state.is_closed());
    assert!(state.take_frame().is_none());
}

#[test]
fn deferred_restart_closeout_stays_pending_until_the_transport_reports_the_write() {
    let state = V3FrontTransportCloseoutState::new();
    state.mark_request_started();
    assert!(state.suppress_restart_closeout_frame());
    state.mark_response_started();
    assert!(!state.close_for_exec_replacement());
    assert!(
        !state.is_closed(),
        "the queued SSE head must stay writable while the transport has not written"
    );
    // The write worker flushes the queued head, so the SSE break owns the boundary.
    state.mark_transport_wrote();
    assert!(
        !state.commit_deferred_restart_closeout(),
        "a written head keeps the SSE transport break as the client boundary"
    );
    assert!(!state.is_closed());
    assert!(state.take_frame().is_none());
}

#[test]
fn committed_restart_closeout_has_no_frame_after_late_suppression() {
    let state = V3FrontTransportCloseoutState::new();
    state.mark_request_started();
    assert!(state.close_for_exec_replacement());
    assert!(
        !state.suppress_restart_closeout_frame(),
        "a committed restart closeout must not be cleared by a late suppression"
    );
    assert!(state.take_frame().is_none());
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
        // Hyper enqueued the SSE head (poll_write) before the streaming terminal's
        // body future reached its settle call. The closeout must still defer on the
        // suppressed boundary and keep the queued head writable.
        socket.closeout_state.mark_response_started();
        socket.close_for_exec_replacement();
        assert!(
            !socket.is_closed(),
            "a deferred restart closeout must leave the front socket writable"
        );
        socket
            .write_tx
            .send(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n\
                  :\n\n"
                    .to_vec(),
            )
            .await
            .expect("the deferred transport must still accept the SSE boundary frame");
        socket.wait_transport_wrote().await;
        assert!(
            !socket.commit_deferred_restart_closeout(),
            "response bytes that reached the client must keep the transport break as the boundary"
        );
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
        text.ends_with(":\n\n") && !text.contains("provider"),
        "the deferred closeout must preserve neutral SSE framing: {text:?}"
    );
    assert!(
        !text.contains("503"),
        "a deferred closeout must not write the restart frame: {text:?}"
    );
    let socket = accept.await.unwrap();
    assert!(socket.closeout_state.take_frame().is_none());
}

#[tokio::test]
async fn front_socket_deferred_closeout_without_a_head_delivers_zero_bytes() {
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
        assert!(!socket.is_closed());
        assert!(
            socket.commit_deferred_restart_closeout(),
            "a head that never reached the client must commit the deferred closeout"
        );
    });
    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(1),
        tokio::io::AsyncReadExt::read_to_end(&mut client, &mut response),
    )
    .await
    .expect("a committed deferred closeout must terminate the client transport")
    .expect("client read must succeed");
    assert!(
        response.is_empty(),
        "restart must not write an error: {response:?}"
    );
    accept.await.unwrap();
}

#[tokio::test]
async fn front_socket_committed_closeout_delivers_zero_bytes() {
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
    assert!(
        response.is_empty(),
        "restart must not write an error: {response:?}"
    );
    accept.await.unwrap();
}

#[tokio::test]
async fn front_socket_restart_after_request_acceptance_delivers_zero_bytes() {
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
    assert!(
        response.is_empty(),
        "restart must not write an error: {response:?}"
    );
    accept.await.unwrap();
}

#[tokio::test]
async fn front_socket_discards_configured_error_terminal_after_headers() {
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
    assert!(
        response.is_empty(),
        "restart must discard error frames: {response:?}"
    );
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
