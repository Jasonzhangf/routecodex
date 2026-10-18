use super::*;

fn foundation_fault_sources() -> (
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

fn foundation_fault_output() -> V3FoundationRuntimeOutput {
    let (source, cause) = foundation_fault_sources();
    V3FoundationRuntimeOutput {
        status: 599,
        body: Value::Null,
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        node_trace: vec!["V3Server03HttpRequestRaw"],
        stopped_before_provider_send: true,
        diagnostic_source: Some(source.clone()),
        diagnostic_cause: Some(cause.clone()),
    }
}

#[tokio::test]
async fn foundation_nochain_fault_marks_model_no_response_and_keeps_control_diagnostics() {
    let (source, cause) = foundation_fault_sources();
    let response = foundation_output_response(foundation_fault_output());

    assert_eq!(response.status(), StatusCode::from_u16(599).unwrap());
    let marker = response
        .extensions()
        .get::<V3ModelClientNoResponse>()
        .expect("Foundation fault must mark the model transport");
    assert!(!marker.streaming);
    assert_eq!(marker.diagnostic_source.as_ref(), Some(&source));
    assert_eq!(marker.diagnostic_cause.as_ref(), Some(&cause));
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], b"null");
    let body = std::str::from_utf8(&body).unwrap();
    assert!(!body.contains("synthetic Error06 operator failure"));
    assert!(!body.contains("pending endpoint"));
    assert!(!body.contains("diagnostic_source"));
    assert!(!body.contains("diagnostic_cause"));
}

#[test]
fn foundation_pending_consumer_persists_exact_terminal_source_and_cause() {
    let _home_lock = TEST_HOME_LOCK.lock().unwrap();
    let root = std::env::temp_dir().join(format!(
        "routecodex-v3-foundation-pending-source-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let _home = TestHomeGuard::set(&root);
    let state =
        test_v3_listener_state_with_debug(&root.join("server.log"), 5555, false, true, None, false);
    let (sample_runtime, mut sample_worker) = start_test_codex_sample_worker(&state);
    let (source, cause) = foundation_fault_sources();

    let response = pending_binding_output_response(
        &state,
        foundation_fault_output(),
        "responses",
        "/v1/responses",
        "foundation-pending-source-retained",
        "pending_not_implemented",
        "pending_owner",
    );
    let marker = response
        .extensions()
        .get::<V3ModelClientNoResponse>()
        .expect("pending Foundation fault must mark the model transport");
    assert_eq!(marker.diagnostic_source.as_ref(), Some(&source));
    assert_eq!(marker.diagnostic_cause.as_ref(), Some(&cause));

    sample_runtime
        .block_on(sample_worker.wait_until_idle())
        .expect("pending Foundation evidence must persist");
    let evidence_path = root.join(
        ".rcc/codex-samples/openai-responses/ports/5555/\
         foundation-pending-source-retained/provider-failed-attempts.json",
    );
    let evidence: Value =
        serde_json::from_str(&fs::read_to_string(&evidence_path).unwrap()).unwrap();
    assert_eq!(
        evidence["terminal_source"],
        serde_json::to_value(&source).unwrap()
    );
    assert_eq!(
        evidence["terminal_cause"],
        serde_json::to_value(&cause).unwrap()
    );
    assert_eq!(
        evidence["request_id"],
        json!("foundation-pending-source-retained")
    );
    assert_eq!(
        evidence["attempts"],
        json!([]),
        "the pending Foundation consumer has no provider attempt to fabricate"
    );

    sample_runtime.block_on(sample_worker.shutdown());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn foundation_nochain_fault_breaks_model_transport_without_client_payload() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (source, cause) = foundation_fault_sources();
    let log = std::env::temp_dir().join(format!("rcc-m4-foundation-{}.log", std::process::id()));
    let _ = fs::remove_file(&log);
    let state = test_v3_listener_state_with_debug(&log, 5555, false, false, None, false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let connection = state.front_transport_broker.allocate_connection_identity();
    let broker = state.front_transport_broker.clone();
    let consumed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = consumed.clone();
    let router = axum::Router::new().route(
        "/v1/responses",
        axum::routing::post(move || {
            let state = state.clone();
            let consumed = consumed.clone();
            async move {
                let response = foundation_output_response(foundation_fault_output());
                let response = commit_model_transport_outcome(&state, Some(connection), response);
                consumed.store(true, std::sync::atomic::Ordering::SeqCst);
                response
            }
        }),
    );
    // The ordinary Front HTTP owner registers the socket before invoking the
    // real Server consumer. Only the typed fault output is seeded by this test.
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
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut bytes))
        .await
        .expect("the accepted client socket must terminate")
        .expect("the accepted client socket must close normally");
    assert!(
        bytes.is_empty(),
        "no HTTP head, error body or fabricated success: {bytes:?}"
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
async fn http_boundary_sdk_fault_preserves_typed_source_cause_and_model_transport_break() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (policy_source, original_source) = foundation_fault_sources();
    let fault = routecodex_v3_runtime::V3RelayErrorOperatorFault {
        policy_failure: policy_source.clone(),
        original_source: Some(original_source.clone()),
    };

    let log = std::env::temp_dir().join(format!(
        "rcc-m4-http-boundary-fault-{}.log",
        std::process::id()
    ));
    let _ = fs::remove_file(&log);
    let state = test_v3_listener_state_with_debug(&log, 5555, false, false, None, false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let connection = state.front_transport_broker.allocate_connection_identity();
    let broker = state.front_transport_broker.clone();
    let router = axum::Router::new().route(
        "/v1/responses",
        axum::routing::post(move || {
            let state = state.clone();
            let fault = fault.clone();
            async move {
                let response = error_output_response_for_server(
                    &state.server,
                    "/v1/responses",
                    "pre-request",
                    Err(fault),
                );
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
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut bytes))
        .await
        .expect("the accepted model client socket must terminate")
        .expect("the accepted model client socket must close normally");
    assert!(
        bytes.is_empty(),
        "an SDK fault must not become an HTTP status, error payload or null success: {bytes:?}"
    );
    let _connection_result = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("Front connection task must settle")
        .expect("Front connection task must not panic");
    let log = fs::read_to_string(&log).expect("typed fault diagnostics must reach Debug");
    assert!(
        log.contains(&format!(
            "source_kind={:?} source_stage={} code={} message={}",
            policy_source.source_kind,
            policy_source.source_stage,
            policy_source.code,
            policy_source.message
        )),
        "the typed SDK policy source must be retained: {log}"
    );
    assert!(
        log.contains(&format!(
            "cause_kind={:?} cause_stage={} cause_code={} cause_message={}",
            original_source.source_kind,
            original_source.source_stage,
            original_source.code,
            original_source.message
        )),
        "the original HTTP boundary source must be retained as cause: {log}"
    );
}
