use super::*;

#[test]
fn post_commit_sse_preserves_declared_diagnostic_status() {
    let source = routecodex_v3_error::build_v3_error_01_source_raised(
        routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
        "V3RuntimeObservability",
        "runtime_observability_contract",
        "missing required timing",
    );
    let projected =
        routecodex_v3_runtime::foundation::project_v3_post_commit_sse_source_via_sdk(source, 500)
            .expect("post-commit diagnostic must project");
    assert_eq!(projected.status, 500);
}

async fn force_accepted_sse_transport(body: Body) -> Body {
    let runtime_outcome: Pin<Box<dyn Future<Output = Response<Body>> + Send>> =
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(body)
                .expect("test post-commit SSE response")
        });
    accept_v3_client_sse_transport(
        runtime_outcome,
        None,
        Box::new(|outcome| outcome),
        Duration::from_millis(2),
        None,
    )
    .await
    .into_body()
}

async fn drain_accepted_sse_until_error(body: Body) -> (String, axum::Error) {
    let mut stream = body.into_data_stream();
    let mut wire = Vec::new();
    for _ in 0..20 {
        match tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("accepted SSE transport must make progress")
        {
            Some(Ok(chunk)) => wire.extend_from_slice(chunk.as_ref()),
            Some(Err(error)) => {
                assert!(
                    stream.next().await.is_none(),
                    "the accepted SSE transport must close after its terminal error"
                );
                return (String::from_utf8(wire).unwrap(), error);
            }
            None => panic!("accepted SSE transport ended without a terminal error"),
        }
    }
    panic!("accepted SSE transport did not terminate");
}

/// A post-commit SDK fault must keep both typed diagnostics in the
/// production console record and in the accepted client body's error chain.
#[tokio::test]
async fn post_commit_sse_sdk_fault_preserves_policy_and_original_source() {
    let log_file = test_v3_console_log_file("post-commit-sse-sdk-fault");
    let _ = fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 5555);
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-post-commit-sse-sdk-fault",
        &test_direct_console_headers(),
        &json!({"model": "gpt-5.5", "stream": true}),
    );
    let finalizer = V3DirectSseConsoleFinalizer {
        context,
        status: 200,
        node_trace: vec!["V3ServerRespOutbound06ClientFrame"],
        observability: test_direct_observability(Vec::new()),
        stream_observation: None,
        started_at: Instant::now(),
    };
    let original_source = V3Error01SourceRaised {
        source_kind: V3ErrorSourceKind::ProviderFailure,
        source_stage: "V3ProviderRespInbound01Raw",
        code: "upstream_midstream_reset".to_string(),
        message: "upstream stream reset after commit".to_string(),
        internal_error: Some(routecodex_v3_error::build_v3_internal_error_envelope(
            routecodex_v3_error::V3InternalErrorCode::V3Server16HttpFrame,
            "V3ProviderRespInbound01Raw",
        )),
        external_error: None,
    };
    let chunks = stream::iter(vec![
        Ok(b"event: response.output_text.delta\ndata: {}\n\n".to_vec()),
        Err(original_source.clone()),
    ]);
    let body = v3_live_client_sse_body_for_protocol(
        Box::pin(chunks),
        Some(finalizer),
        None,
        V3SseClientProtocol::Responses,
    );
    let (wire, error) =
        drain_accepted_sse_until_error(force_accepted_sse_transport(body).await).await;

    assert!(!wire.contains("event: error"), "{wire}");
    assert!(!wire.contains("\"error\""), "{wire}");
    let typed = find_v3_post_commit_sse_transport_error(&error)
        .expect("accepted transport must preserve the typed post-commit SDK fault");
    match typed {
        V3PostCommitSseTransportError::OperatorFault(observed) => {
            assert_eq!(
                observed.policy_failure.code,
                "relay_error_operator_sdk_failure"
            );
            assert_eq!(observed.original_source, Some(original_source.clone()));
        }
        V3PostCommitSseTransportError::Projected(projected) => {
            panic!("an SDK fault must not become a client projection: {projected:?}")
        }
    }

    let log = strip_test_ansi(&fs::read_to_string(&log_file).unwrap());
    assert!(
        log.contains("code=relay_error_operator_sdk_failure"),
        "the SDK policy failure must reach the production debug ledger: {log}"
    );
    assert!(
        log.contains("cause_stage=V3ProviderRespInbound01Raw"),
        "the original Source stage must reach the production debug ledger: {log}"
    );
    assert!(
        log.contains("cause_code=upstream_midstream_reset"),
        "the original Source code must reach the production debug ledger: {log}"
    );
    assert!(
        log.contains("cause_message=upstream stream reset after commit"),
        "the original Source message must reach the production debug ledger: {log}"
    );
    drop(state);
    let _ = fs::remove_file(&log_file);
}
