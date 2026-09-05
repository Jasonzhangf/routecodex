use super::*;
#[path = "restart_handoff/tests/restart_handoff_closeout.rs"]
mod closeout;

fn key() -> V3FrontRequestLeaseKey {
    V3FrontRequestLeaseKey {
        request_id: "req-1".into(),
        pipeline_id: "pipe-1".into(),
        server_id: "server-1".into(),
        port: 7777,
        session_scope: "session-1".into(),
        generation: 4,
    }
}

fn test_front_socket(write_tx: mpsc::Sender<Vec<u8>>) -> V3StableFrontSocket {
    let (close_tx, _close_rx) = oneshot::channel();
    V3StableFrontSocket {
        write_tx,
        close_tx: Arc::new(Mutex::new(Some(close_tx))),
        closeout_state: V3FrontTransportCloseoutState::new(),
    }
}

fn lease(now: Instant) -> V3FrontRequestLease {
    V3FrontRequestLease {
        key: key(),
        execution_mode: V3FrontExecutionMode::Relay,
        continuation_owner: V3FrontContinuationOwner::Relay,
        runtime_generation: 4,
        state: V3FrontLeaseState::Running,
        semantic_commit: false,
        closeout_state: V3FrontCloseoutState::Open,
        frame_sequence: V3FrontFrameSequence::default(),
        deadline: V3FrontDeadlineBudget::new(
            now,
            Duration::from_secs(120),
            Duration::from_secs(15),
        ),
    }
}
#[test]
fn frame_sequence_rejects_duplicate_and_out_of_order_frames() {
    let mut sequence = V3FrontFrameSequence::default();
    assert_eq!(sequence.observe_client(0), V3FrontFrameDecision::New);
    assert_eq!(sequence.observe_client(0), V3FrontFrameDecision::Duplicate);
    assert_eq!(sequence.observe_client(2), V3FrontFrameDecision::OutOfOrder);
    assert_eq!(sequence.observe_client(1), V3FrontFrameDecision::New);
}
#[test]
fn reattach_preserves_mode_owner_commit_and_sequence() {
    let now = Instant::now();
    let mut lease = lease(now);
    assert_eq!(
        lease.frame_sequence.observe_client(0),
        V3FrontFrameDecision::New
    );
    assert_eq!(
        lease.frame_sequence.observe_provider(0),
        V3FrontFrameDecision::New
    );
    lease.semantic_commit = true;
    let checkpoint = lease.checkpoint(now + Duration::from_secs(1));
    let restored = V3FrontRequestLease::reattach(&checkpoint, now + Duration::from_secs(2), 5);
    assert_eq!(restored.execution_mode, V3FrontExecutionMode::Relay);
    assert_eq!(restored.continuation_owner, V3FrontContinuationOwner::Relay);
    assert!(restored.semantic_commit);
    assert_eq!(restored.runtime_generation, 5);
    assert_eq!(restored.key.generation, 5);
    assert_eq!(restored.frame_sequence.client_next(), 1);
    assert_eq!(restored.frame_sequence.provider_next(), 1);
}
#[test]
fn reattach_never_extends_the_absolute_deadline() {
    let now = Instant::now();
    let lease = lease(now);
    let checkpoint = lease.checkpoint(now + Duration::from_secs(119));
    let restored = V3FrontRequestLease::reattach(&checkpoint, now + Duration::from_secs(119), 5);
    let (absolute, _) = restored.deadline.remaining(now + Duration::from_secs(120));
    assert!(absolute.is_zero());
}
#[test]
fn registry_is_keyed_by_full_request_scope() {
    let now = Instant::now();
    let lease = lease(now);
    let mut registry = V3FrontRequestLeaseRegistry::default();
    assert_eq!(registry.insert(&lease), None);
    assert_eq!(registry.state(&lease.key), Some(V3FrontLeaseState::Running));
    assert_eq!(
        registry.remove(&lease.key),
        Some(V3FrontLeaseState::Running)
    );
    assert_eq!(registry.state(&lease.key), None);
}
#[test]
fn broker_reattach_increments_generation_without_resetting_deadline() {
    let now = Instant::now();
    let broker = V3FrontTransportBroker::new(4);
    let lease = lease(now);
    broker.register(&lease, now);
    let checkpoint = broker.freeze(now).pop().expect("registered checkpoint");
    assert_eq!(
        broker.observe_provider_frame(&checkpoint.key, 0),
        Ok(V3FrontFrameDecision::New)
    );
    assert_eq!(
        broker.observe_provider_frame(&checkpoint.key, 0),
        Ok(V3FrontFrameDecision::Duplicate)
    );
    let restored = broker.reattach(&checkpoint, now + Duration::from_secs(1));
    assert_eq!(restored.runtime_generation, 5);
    assert_eq!(restored.key.generation, 5);
    assert!(restored
        .deadline
        .remaining(now + Duration::from_secs(120))
        .0
        .is_zero());
}
#[test]
fn broker_binds_front_connection_identity_to_full_request_lease() {
    let now = Instant::now();
    let broker = V3FrontTransportBroker::new(4);
    let connection = broker.allocate_connection_identity();
    let lease = lease(now);

    broker
        .bind_connection_lease(connection, lease.clone(), now)
        .expect("front connection lease binding");

    assert_eq!(broker.connection_lease(connection), Some(lease.key.clone()));
    assert_eq!(
        broker.lease_for_connection(connection).unwrap().key,
        lease.key
    );
}
#[test]
fn broker_rejects_duplicate_front_connection_identity_binding() {
    let now = Instant::now();
    let broker = V3FrontTransportBroker::new(4);
    let connection = broker.allocate_connection_identity();
    let first = lease(now);
    broker
        .bind_connection_lease(connection, first, now)
        .expect("first front connection lease binding");

    let mut second = lease(now);
    second.key.request_id = "req-2".into();
    assert!(broker
        .bind_connection_lease(connection, second, now)
        .is_err());
    assert_eq!(
        broker.connection_lease(connection).unwrap().request_id,
        "req-1"
    );
}

#[test]
fn broker_moves_front_socket_from_connection_identity_to_request_lease() {
    let now = Instant::now();
    let broker = V3FrontTransportBroker::new(4);
    let connection = broker.allocate_connection_identity();
    let lease = lease(now);
    let (write_tx, _write_rx) = mpsc::channel(1);
    let socket = test_front_socket(write_tx);

    broker
        .register_front_socket(connection, socket)
        .expect("front socket registration");
    assert!(broker.front_socket(connection).is_some());

    broker
        .bind_connection_lease(connection, lease.clone(), now)
        .expect("front connection lease binding");

    assert!(broker.front_socket(connection).is_none());
    assert!(broker.client_socket(&lease.key).is_some());
}
#[test]
fn broker_closes_active_client_transports_before_exec_replacement() {
    let broker = V3FrontTransportBroker::new(4);
    let connection = broker.allocate_connection_identity();
    let (write_tx, _write_rx) = mpsc::channel(1);
    let socket = test_front_socket(write_tx);
    broker
        .register_front_socket(connection, socket.clone())
        .expect("front socket registration");

    broker.close_active_client_transports();

    assert!(socket.is_closed());
}
#[tokio::test]
async fn broker_close_finishes_active_tcp_client_before_exec_replacement() {
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
    });

    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
    for _ in 0..100 {
        if broker
            .front_sockets
            .lock()
            .expect("front socket registry lock")
            .contains_key(&connection_identity)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert!(
        broker
            .front_sockets
            .lock()
            .expect("front socket registry lock")
            .contains_key(&connection_identity),
        "accepted client must be registered before restart closeout"
    );

    broker.close_active_client_transports();
    let mut response = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(1),
        tokio::io::AsyncReadExt::read_to_end(&mut client, &mut response),
    )
    .await
    .expect("restart closeout must not leave a half-open client transport")
    .expect("client EOF read must succeed");
    assert!(
        response.is_empty(),
        "no HTTP response should be fabricated by closeout"
    );
    tokio::io::AsyncWriteExt::shutdown(&mut client)
        .await
        .expect("client write half shutdown");
    let _ = accept.await;
}
#[test]
fn broker_reattach_moves_client_socket_to_new_generation_key() {
    let now = Instant::now();
    let broker = V3FrontTransportBroker::new(4);
    let connection = broker.allocate_connection_identity();
    let lease = lease(now);
    let (write_tx, _write_rx) = mpsc::channel(1);

    broker
        .register_front_socket(connection, test_front_socket(write_tx))
        .expect("front socket registration");
    broker
        .bind_connection_lease(connection, lease.clone(), now)
        .expect("front connection lease binding");
    let checkpoint = broker.freeze(now).pop().expect("front checkpoint");

    let restored = broker.reattach(&checkpoint, now + Duration::from_secs(1));

    assert!(broker.client_socket(&lease.key).is_none());
    assert!(broker.client_socket(&restored.key).is_some());
}
#[test]
fn broker_restores_checkpoint_with_new_generation_and_same_deadline_budget() {
    let now = Instant::now();
    let source = V3FrontTransportBroker::new(4);
    let lease = lease(now);
    source.register(&lease, now);
    let checkpoint = source.freeze(now + Duration::from_secs(1));

    let restored = V3FrontTransportBroker::new(4);
    assert_eq!(
        restored.restore_checkpoints_at(
            &checkpoint,
            now + Duration::from_secs(2),
            checkpoint[0].captured_at_epoch_ms + 1_000,
        ),
        Ok(1)
    );
    assert_eq!(restored.generation(), 5);
    let restored_checkpoint = restored.freeze(now + Duration::from_secs(2));
    assert_eq!(restored_checkpoint[0].key.generation, 5);
    assert!(restored_checkpoint[0].absolute_remaining_ms < checkpoint[0].absolute_remaining_ms);
}
#[test]
fn broker_rejects_checkpoint_with_incomplete_request_scope() {
    let now = Instant::now();
    let mut lease = lease(now);
    lease.key.pipeline_id.clear();
    let checkpoint = [lease.checkpoint(now)];
    let restored = V3FrontTransportBroker::new(4);

    assert!(restored.restore_checkpoints(&checkpoint, now).is_err());
    assert!(restored.freeze(now).is_empty());
}
#[tokio::test]
async fn stable_front_keeps_client_socket_open_while_runtime_detaches() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let client = tokio::net::TcpStream::connect(address).await.unwrap();
    let (server, _) = listener.accept().await.unwrap();
    let now = Instant::now();
    let original_lease = lease(now);
    let old_key = original_lease.key.clone();
    let front = V3StableFrontConnection::spawn(server, original_lease.clone());
    let broker = V3FrontTransportBroker::new(original_lease.runtime_generation);
    broker.register_client_connection(front.clone());
    broker.register(&original_lease, now);
    let checkpoint = broker.freeze(now).pop().expect("front checkpoint");
    let restored = broker.reattach(&checkpoint, now + Duration::from_secs(1));
    broker
        .reattach_client_connection(&old_key, restored.clone())
        .unwrap();
    assert!(broker.client_connection(&old_key).is_none());
    let mut mismatched = restored.clone();
    mismatched.key.session_scope = "different-session".into();
    assert!(broker
        .reattach_client_connection(&restored.key, mismatched)
        .is_err());
    assert!(broker.client_connection(&restored.key).is_some());
    let front = broker
        .client_connection(&restored.key)
        .expect("front connection registered in broker");

    front.detach_runtime().await.unwrap();
    front
        .send_client_frame(0, b"data: still-alive\n\n")
        .await
        .unwrap();

    let mut client = client;
    let mut received = [0_u8; 64];
    let read = tokio::time::timeout(
        Duration::from_millis(100),
        tokio::io::AsyncReadExt::read(&mut client, &mut received),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(&received[..read], b"data: still-alive\n\n");
    front
        .send_client_terminal(1, b"data: terminal\n\n")
        .await
        .unwrap();
    assert!(front
        .send_client_terminal(2, b"data: duplicate\n\n")
        .await
        .is_err());
    assert!(front
        .send_client_frame(2, b"data: after-terminal\n\n")
        .await
        .is_err());
    front.close().await.unwrap();
}
#[tokio::test]
async fn stable_front_rejects_client_frame_after_absolute_deadline() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let _client = tokio::net::TcpStream::connect(address).await.unwrap();
    let (server, _) = listener.accept().await.unwrap();
    let now = Instant::now();
    let expired = V3FrontRequestLease {
        key: key(),
        execution_mode: V3FrontExecutionMode::Direct,
        continuation_owner: V3FrontContinuationOwner::Direct,
        runtime_generation: 1,
        state: V3FrontLeaseState::Running,
        semantic_commit: false,
        closeout_state: V3FrontCloseoutState::Open,
        frame_sequence: V3FrontFrameSequence::default(),
        deadline: V3FrontDeadlineBudget::new(now, Duration::ZERO, Duration::ZERO),
    };
    let front = V3StableFrontConnection::spawn(server, expired);

    let error = front.send_client_frame(0, b"data: must-not-send\n\n").await;
    assert_eq!(
        error,
        Err("stable front request deadline expired".to_string())
    );
    front.close().await.unwrap();
}

#[tokio::test]
async fn front_http_adapter_preserves_existing_router_service() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let broker = V3FrontTransportBroker::new(0);
    let connection_identity = broker.allocate_connection_identity();
    let expected_identity = connection_identity;
    let app = axum::Router::new().route(
        "/",
        axum::routing::get(
            move |axum::extract::Extension(identity): axum::extract::Extension<
                V3FrontConnectionIdentity,
            >| async move {
                assert_eq!(identity, expected_identity);
                axum::http::StatusCode::NO_CONTENT
            },
        ),
    );
    let accept = tokio::spawn(async move {
        let (stream, remote) = listener.accept().await.unwrap();
        serve_v3_front_http_connection(
            stream,
            remote,
            connection_identity,
            V3FrontTransportBroker::new(0),
            app.into_service(),
        )
        .await
        .unwrap();
    });
    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
    tokio::io::AsyncWriteExt::write_all(
        &mut client,
        b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )
    .await
    .unwrap();
    let mut response = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut client, &mut response)
        .await
        .unwrap();
    accept.await.unwrap();
    assert!(String::from_utf8_lossy(&response).contains("204 No Content"));
}
