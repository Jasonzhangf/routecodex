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

fn frame_sdk_fault_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    cause: routecodex_v3_error::V3Error01SourceRaised,
) -> V3FoundationRuntimeOutput {
    V3FoundationRuntimeOutput {
        status: 599,
        body: Value::Null,
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        node_trace: vec!["V3Server03HttpRequestRaw"],
        stopped_before_provider_send: true,
        diagnostic_source: Some(source),
        diagnostic_cause: Some(cause),
    }
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
                let frame = build_v3_server_16_http_frame_from_v3_foundation_output(
                    frame_sdk_fault_output(route_source.clone(), route_cause.clone()),
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
