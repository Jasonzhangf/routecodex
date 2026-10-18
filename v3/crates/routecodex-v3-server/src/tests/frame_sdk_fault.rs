use super::*;

fn frame_sdk_fault_sources() -> (
    routecodex_v3_error::V3Error01SourceRaised,
    routecodex_v3_error::V3Error01SourceRaised,
) {
    let source = routecodex_v3_error::build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3Debug01NodeEventRegistered",
        "relay_error_operator_sdk_failure",
        "synthetic Error06 operator failure",
    );
    let cause = routecodex_v3_error::build_v3_error_01_source_raised(
        V3ErrorSourceKind::PendingEndpoint,
        "V3Server03HttpRequestRaw",
        "not_implemented",
        "pending endpoint",
    );
    (source, cause)
}

#[tokio::test]
async fn frame_sdk_fault_breaks_front_transport_and_preserves_typed_diagnostics() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (source, cause) = frame_sdk_fault_sources();
    let log =
        std::env::temp_dir().join(format!("rcc-m4-frame-sdk-fault-{}.log", std::process::id()));
    let _ = fs::remove_file(&log);
    let state = test_v3_listener_state_with_debug(&log, 5555, false, false, None, false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let connection = state.front_transport_broker.allocate_connection_identity();
    let broker = state.front_transport_broker.clone();
    let route_source = source.clone();
    let route_cause = cause.clone();
    let consumed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = consumed.clone();
    let router = axum::Router::new().route(
        "/v1/responses",
        axum::routing::post(move || {
            let state = state.clone();
            let consumed = consumed.clone();
            async move {
                let frame = build_v3_server_16_http_frame_from_error_sdk_result(
                    "V3Server03HttpRequestRaw",
                    Err(routecodex_v3_runtime::V3RelayErrorOperatorFault {
                        policy_failure: route_source.clone(),
                        original_source: Some(route_cause.clone()),
                    }),
                );
                let response = responses_direct_output_response(frame, None);
                let response = commit_model_transport_outcome(&state, Some(connection), response);
                consumed.store(true, std::sync::atomic::Ordering::SeqCst);
                response
            }
        }),
    );
    let server = tokio::spawn(async move {
        let (accepted, remote) = listener.accept().await.unwrap();
        crate::restart_handoff::serve_v3_front_http_connection(
            accepted, remote, connection, broker, router,
        )
        .await
    });

    let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
    client
        .write_all(b"POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}")
        .await
        .unwrap();
    let mut bytes = vec![0_u8; 1024];
    let read = tokio::time::timeout(Duration::from_secs(5), client.read(&mut bytes))
        .await
        .expect("the accepted client socket must terminate")
        .expect("the accepted client socket must close normally");
    bytes.truncate(read);
    assert!(
        bytes.is_empty(),
        "the model client must receive no HTTP head, 599 error payload or null success: {bytes:?}"
    );

    let _connection_result = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("Front connection task must settle")
        .expect("Front connection task must not panic");
    assert!(observed.load(std::sync::atomic::Ordering::SeqCst));
    let log = fs::read_to_string(&log).expect("the typed terminal diagnostic must reach Debug");
    assert!(
        log.contains(&format!(
            "v3 model transport terminal source_kind={:?} source_stage={} code={} message={}",
            source.source_kind, source.source_stage, source.code, source.message
        )),
        "the exact typed source must reach the Debug sink: {log}"
    );
    assert!(
        log.contains(&format!(
            "cause_kind={:?} cause_stage={} cause_code={} cause_message={}",
            cause.source_kind, cause.source_stage, cause.code, cause.message
        )),
        "the exact typed cause must reach the Debug sink: {log}"
    );
}

#[tokio::test]
async fn server_boundary_sdk_result_reaches_front_consumer_with_original_source() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let projected = routecodex_v3_runtime::foundation::project_v3_server_boundary_error_via_sdk(
        V3ErrorSourceKind::RuntimeFailure,
        "V3Server03HttpRequestRaw",
        "anthropic_client_headers_invalid",
        "synthetic invalid Anthropic client headers",
        Some(598),
    )
    .expect("a plain Server boundary source must project through Error01..Error06");
    let source = projected.diagnostic_source.clone();
    let frame = build_v3_server_16_http_frame_from_error_sdk_result(
        "V3Server03HttpRequestRaw",
        Ok(projected),
    );
    assert_eq!(frame.status, 598);
    assert_eq!(
        frame.error_chain,
        routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
    );
    assert_eq!(frame.diagnostic_source.as_ref(), Some(&source));

    let log = std::env::temp_dir().join(format!(
        "rcc-m4-frame-sdk-result-{}.log",
        std::process::id()
    ));
    let _ = fs::remove_file(&log);
    let state = test_v3_listener_state_with_debug(&log, 5555, false, false, None, false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let connection = state.front_transport_broker.allocate_connection_identity();
    let broker = state.front_transport_broker.clone();
    let frame = std::sync::Arc::new(std::sync::Mutex::new(Some(frame)));
    let router = axum::Router::new().route(
        "/v1/responses",
        axum::routing::post(move || {
            let state = state.clone();
            let frame = frame.clone();
            async move {
                let frame = frame
                    .lock()
                    .expect("single test request owns the error frame")
                    .take()
                    .expect("single test request consumes the error frame");
                let response = responses_direct_output_response(frame, None);
                commit_model_transport_outcome(&state, Some(connection), response)
            }
        }),
    );
    let server = tokio::spawn(async move {
        let (accepted, remote) = listener.accept().await.unwrap();
        crate::restart_handoff::serve_v3_front_http_connection(
            accepted, remote, connection, broker, router,
        )
        .await
    });

    let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
    client
        .write_all(b"POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}")
        .await
        .unwrap();
    let mut bytes = vec![0_u8; 1024];
    let read = tokio::time::timeout(Duration::from_secs(5), client.read(&mut bytes))
        .await
        .expect("the accepted client socket must terminate")
        .expect("the accepted client socket must close normally");
    bytes.truncate(read);
    assert!(
        bytes.is_empty(),
        "the model client must receive no HTTP head or error payload: {bytes:?}"
    );

    let _connection_result = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("Front connection task must settle")
        .expect("Front connection task must not panic");
    let log = fs::read_to_string(&log).expect("the typed terminal diagnostic must reach Debug");
    assert!(
        log.contains(&format!(
            "v3 model transport terminal source_kind={:?} source_stage={} code={} message={}",
            source.source_kind, source.source_stage, source.code, source.message
        )),
        "the SDK-projected original source must reach the Debug sink: {log}"
    );
}
