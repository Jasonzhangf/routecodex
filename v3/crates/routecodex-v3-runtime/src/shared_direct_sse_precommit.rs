async fn project_sse_stream(
    provider_id: &str,
    stream: V3ProviderSseStream,
    sse_first_frame_timeout_ms: Option<u64>,
) -> Result<
    (
        V3ClientBody,
        V3RemoteContinuationObservation,
        Option<V3RuntimeStreamObservation>,
    ),
    V3Error01SourceRaised,
> {
    let stream =
        guard_initial_direct_sse_provider_failure(provider_id, stream, sse_first_frame_timeout_ms)
            .await?;
    let observation_state = V3SseRemoteContinuationObservationState::default();
    let usage_observation = V3RuntimeStreamObservation::default();
    let client_stream = observed_sse_client_stream(
        provider_id.to_string(),
        stream,
        observation_state.clone(),
        usage_observation.clone(),
    );
    Ok((
        V3ClientBody::Sse(client_stream),
        V3RemoteContinuationObservation::Streaming {
            state: observation_state,
        },
        Some(usage_observation),
    ))
}

async fn guard_initial_direct_sse_provider_failure(
    provider_id: &str,
    stream: V3ProviderSseStream,
    sse_first_frame_timeout_ms: Option<u64>,
) -> Result<V3ProviderSseStream, V3Error01SourceRaised> {
    let first_event_timeout = sse_first_frame_timeout_ms
        .map(std::time::Duration::from_millis)
        .unwrap_or(V3_DIRECT_SSE_FIRST_EVENT_TIMEOUT);
    guard_initial_direct_sse_provider_failure_with_timeout(provider_id, stream, first_event_timeout)
        .await
}

async fn guard_initial_direct_sse_provider_failure_with_timeout(
    provider_id: &str,
    mut stream: V3ProviderSseStream,
    first_event_timeout: std::time::Duration,
) -> Result<V3ProviderSseStream, V3Error01SourceRaised> {
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut buffered = Vec::<Vec<u8>>::new();
    loop {
        // 首帧超时守卫：provider 返回 200 但 SSE 首帧挂起（连接保持、无数据）时，
        // 必须 fail-fast 产生显式 provider 错误（而不是无限等待 -> 客户端超时/EOF
        // 且无 console 打印）。超时错误进入 provider 失败链，可触发 reselect 与
        // console 错误投影；客户端连接由 server 侧 keepalive 保持存活，与 provider
        // 状态解耦。
        let next = tokio::time::timeout(first_event_timeout, stream.next())
            .await
            .map_err(|_| {
                build_v3_error_01_source_raised_external(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider_response_sse_first_event_timeout",
                    "provider response SSE stream did not produce a first semantic event within timeout",
                    V3ExternalErrorLink {
                        kind: V3ExternalErrorKind::Provider,
                        status: None,
                        code: Some("PROVIDER_RESPONSE_SSE_FIRST_EVENT_TIMEOUT".to_string()),
                        provider_id: Some(provider_id.to_string()),
                        upstream_request_id: None,
                        message: Some(
                            "provider response SSE stream did not produce a first semantic event within timeout"
                                .to_string(),
                        ),
                    },
                )
            })?;
        let Some(next) = next else {
            decoder
                .finish()
                .map_err(|error| sse_transport_source(provider_id, error))?;
            return Err(build_v3_error_01_source_raised_external(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "provider_response_sse_empty",
                "provider response SSE stream ended before first semantic event",
                V3ExternalErrorLink {
                    kind: V3ExternalErrorKind::Provider,
                    status: None,
                    code: Some("PROVIDER_RESPONSE_SSE_EMPTY".to_string()),
                    provider_id: Some(provider_id.to_string()),
                    upstream_request_id: None,
                    message: Some(
                        "provider response SSE stream ended before first semantic event"
                            .to_string(),
                    ),
                },
            ));
        };
        let chunk = next.map_err(provider_body_source)?;
        let frames = decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(&chunk))
            .map_err(|error| sse_transport_source(provider_id, error))?;
        let mut should_start_client_stream = false;
        for frame in frames {
            match classify_v3_direct_sse_precommit_frame(provider_id, frame.frame().fields())? {
                V3DirectSsePrecommitDecision::ContinueBuffering => {}
                V3DirectSsePrecommitDecision::StartClientStream => {
                    should_start_client_stream = true;
                }
                V3DirectSsePrecommitDecision::TerminalWithoutOutput => {
                    if !should_start_client_stream {
                        return Err(build_v3_provider_sse_json_error(
                            provider_id,
                            "provider_response_sse_empty",
                            "provider Responses SSE completed with no content or tool output"
                                .to_string(),
                        ));
                    }
                }
            }
        }
        buffered.push(chunk);
        if should_start_client_stream {
            let replay = stream::iter(buffered.into_iter().map(Ok)).chain(stream);
            return Ok(Box::pin(replay));
        }
    }
}

fn classify_v3_direct_sse_precommit_frame(
    provider_id: &str,
    fields: &[SseField],
) -> Result<V3DirectSsePrecommitDecision, V3Error01SourceRaised> {
    let data = collect_v3_provider_sse_json_data(fields);
    let parsed = classify_v3_provider_generic_sse_json_data(&data).map_err(|message| {
        build_v3_provider_sse_json_error(
            provider_id,
            "provider_response_sse_event_invalid",
            message,
        )
    })?;
    let Some(outcome) = parsed else {
        return Ok(V3DirectSsePrecommitDecision::ContinueBuffering);
    };
    build_v3_direct_sse_precommit_decision_from_v3_provider_responses_json_frame_outcome(
        provider_id,
        outcome,
    )
}

fn build_v3_direct_sse_precommit_decision_from_v3_provider_responses_json_frame_outcome(
    provider_id: &str,
    outcome: V3ProviderResponsesJsonFrameOutcome,
) -> Result<V3DirectSsePrecommitDecision, V3Error01SourceRaised> {
    match outcome {
        V3ProviderResponsesJsonFrameOutcome::ContinueBuffering => {
            Ok(V3DirectSsePrecommitDecision::ContinueBuffering)
        }
        V3ProviderResponsesJsonFrameOutcome::StartClientStream
        | V3ProviderResponsesJsonFrameOutcome::Terminal => {
            Ok(V3DirectSsePrecommitDecision::StartClientStream)
        }
        V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput => {
            Ok(V3DirectSsePrecommitDecision::TerminalWithoutOutput)
        }
        V3ProviderResponsesJsonFrameOutcome::Failure { code, message } => Err(
            build_v3_provider_sse_json_error(provider_id, &code, message),
        ),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3DirectSsePrecommitDecision {
    ContinueBuffering,
    StartClientStream,
    TerminalWithoutOutput,
}

fn build_v3_provider_sse_json_error(
    provider_id: &str,
    code: &str,
    message: String,
) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        code,
        message.clone(),
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some(code.to_string()),
            provider_id: Some(provider_id.to_string()),
            upstream_request_id: None,
            message: Some(message),
        },
    )
}
