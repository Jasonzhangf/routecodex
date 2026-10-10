use super::*;
use futures_util::StreamExt;

/// provider SSE 空流：guard 必须 fail-fast 返回 Transport 错误（进入错误链切 provider），
/// 而不是让客户端收到 200 后流立即结束的半截响应。
#[tokio::test]
async fn guard_rejects_empty_sse_stream() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream =
        Box::pin(futures_util::stream::empty());
    let result = guard_relay_sse_first_frame(
        "req-empty",
        "provider-1",
        V3HubProviderWireProtocol::Responses,
        stream,
        Some(30_000),
        false,
    )
    .await;
    assert!(result.is_err(), "empty SSE stream must fail the guard");
}

/// provider 首帧正常：guard 必须保真重放首帧后继续 provider 流（语义不变）。
#[tokio::test]
async fn guard_accepts_first_frame_and_replays_it() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream =
            Box::pin(futures_util::stream::iter(vec![
                Ok(b"data: {\"type\":\"response.created\",\"response\":{}}\n\n".to_vec()),
                Ok(
                    b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n"
                        .to_vec(),
                ),
                Ok(b"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}]}}\n\n".to_vec()),
            ]));
    let mut guarded = guard_relay_sse_first_frame(
        "req-ok",
        "provider-1",
        V3HubProviderWireProtocol::Responses,
        stream,
        Some(30_000),
        false,
    )
    .await
    .expect("non-empty stream must pass the guard");
    let first = guarded
        .next()
        .await
        .expect("replayed first frame")
        .expect("frame is ok");
    assert_eq!(
        first,
        b"data: {\"type\":\"response.created\",\"response\":{}}\n\n".to_vec()
    );
    let second = guarded
        .next()
        .await
        .expect("provider stream continues")
        .expect("frame is ok");
    assert_eq!(
        second,
        b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n".to_vec()
    );
    assert!(guarded.next().await.is_some(), "terminal frame is replayed");
    assert!(
        guarded.next().await.is_none(),
        "stream must end after provider frames"
    );
}

/// provider 首帧错误：guard 必须原样上抛（错误链切 provider），不吞错。
#[tokio::test]
async fn guard_propagates_first_frame_provider_error() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream = Box::pin(
        futures_util::stream::iter(vec![Err(V3ProviderError::Transport {
            request_id: "req-err".to_string(),
            provider_id: "provider-1".to_string(),
            reason: "upstream reset".to_string(),
        })]),
    );
    let result = guard_relay_sse_first_frame(
        "req-err",
        "provider-1",
        V3HubProviderWireProtocol::Responses,
        stream,
        Some(30_000),
        false,
    )
    .await;
    assert!(result.is_err(), "first frame error must propagate");
}

/// 响应头等待超时是 health-neutral 瞬态 transport hang；OpenAI Chat/Gemini
/// 共享 relay 的失败构造必须保留 canonical code 供下游策略识别，不能降成
/// 通用 provider_error 后触发全局 provider cooldown。
#[test]
fn shared_relay_header_wait_timeout_keeps_health_neutral_hang_code() {
    let reason = format!(
        "{} {}",
        routecodex_v3_error::V3_PROVIDER_RESPONSE_HEADER_TIMEOUT_REASON_PREFIX,
        "after 120000ms"
    );
    let failure = provider_runtime_failure(
        V3ProviderError::Transport {
            request_id: "req-header-timeout".to_string(),
            provider_id: "provider-1".to_string(),
            reason,
        },
        "provider-1",
    );

    assert_eq!(
        crate::hub_v1::relay_runtime_shared::failure_error_type(&failure).as_deref(),
        Some(routecodex_v3_error::V3_TRANSIENT_TRANSPORT_HANG_CODE)
    );
}

#[tokio::test]
async fn guard_keeps_client_disconnect_out_of_provider_failure_policy() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream = Box::pin(
        futures_util::stream::iter(vec![Err(V3ProviderError::ClientDisconnect {
            request_id: "req-client-disconnect".to_string(),
            provider_id: "provider-1".to_string(),
        })]),
    );
    let result = guard_relay_sse_first_frame(
        "req-client-disconnect",
        "provider-1",
        V3HubProviderWireProtocol::Responses,
        stream,
        Some(30_000),
        false,
    )
    .await;
    assert!(matches!(
        result,
        Err(V3ProviderError::ClientDisconnect { .. })
    ));
}

#[tokio::test]
async fn guard_honors_configured_first_frame_timeout() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream =
        Box::pin(futures_util::stream::pending());
    let result = guard_relay_sse_first_frame(
        "req-timeout",
        "provider-1",
        V3HubProviderWireProtocol::Responses,
        stream,
        Some(1),
        false,
    )
    .await;
    assert!(
        result.is_err(),
        "configured first-frame timeout must fail pending SSE"
    );
}

#[tokio::test]
async fn guard_rejects_zero_first_frame_timeout() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream =
        Box::pin(futures_util::stream::pending());
    let result = guard_relay_sse_first_frame(
        "req-zero-timeout",
        "provider-1",
        V3HubProviderWireProtocol::Responses,
        stream,
        Some(0),
        false,
    )
    .await;
    assert!(result.is_err(), "zero first-frame timeout must fail fast");
}

#[tokio::test]
async fn guard_rejects_chat_shape_from_responses_provider_before_client_commit() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream =
        Box::pin(futures_util::stream::iter(vec![Ok(
            b"data: {\"id\":\"chatcmpl_1\",\"choices\":[]}\n\n".to_vec(),
        )]));
    let result = guard_relay_sse_first_frame(
        "req-protocol-mismatch",
        "cc-sol",
        V3HubProviderWireProtocol::Responses,
        stream,
        Some(30_000),
        false,
    )
    .await;
    let error = match result {
        Ok(_) => panic!("a Chat-shaped event must not enter a Responses relay stream"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("type"));
}

#[tokio::test]
async fn guard_rejects_late_malformed_responses_frame_before_client_output() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream =
        Box::pin(futures_util::stream::iter(vec![
            Ok(b"data: {\"type\":\"response.created\",\"response\":{}}\n\n".to_vec()),
            Ok(b"data: {\"choices\":[]}\n\n".to_vec()),
        ]));
    let result = guard_relay_sse_first_frame(
        "req-late-protocol-mismatch",
        "cc-sol",
        V3HubProviderWireProtocol::Responses,
        stream,
        Some(30_000),
        false,
    )
    .await;
    assert!(
        result.is_err(),
        "a malformed Responses frame before first output must reselect before client commit"
    );
}

/// First-word guard preserves normal provider bytes and EOF.
#[tokio::test]
async fn guard_first_word_passes_through_chunks_until_eof() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream =
        Box::pin(futures_util::stream::iter(vec![
            Ok(b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n".to_vec()),
            Ok(b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\n".to_vec()),
        ]));
    let mut guarded = super::relay_runtime_shared::guard_v3_provider_sse_first_word(
        "req-idle-ok",
        "provider-1",
        V3HubProviderWireProtocol::OpenAiChat,
        stream,
        tokio::time::Instant::now() + std::time::Duration::from_secs(5),
    );
    let first = guarded
        .next()
        .await
        .expect("first frame")
        .expect("frame ok");
    assert_eq!(first, b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n".to_vec());
    let second = guarded
        .next()
        .await
        .expect("second frame")
        .expect("frame ok");
    assert_eq!(second, b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\n".to_vec());
    assert!(
        guarded.next().await.is_none(),
        "stream must end after provider frames"
    );
}

/// 空闲守卫：provider 流数据挂起（无新帧）超过窗口 -> 产出 Transport 错误并终止
/// （进入 provider 失败链切 provider），而不是无限等待。
#[tokio::test]
async fn guard_first_word_times_out_on_hung_stream() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream =
        Box::pin(futures_util::stream::pending());
    let mut guarded = super::relay_runtime_shared::guard_v3_provider_sse_first_word(
        "req-idle-hung",
        "provider-1",
        V3HubProviderWireProtocol::OpenAiChat,
        stream,
        tokio::time::Instant::now() + std::time::Duration::from_millis(50),
    );
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), guarded.next()).await;
    match outcome {
        Ok(Some(Err(V3ProviderError::Transport { reason, .. }))) => {
            assert!(
                reason.contains("semantic first frame"),
                "hung stream must produce semantic first-word timeout, got {reason}"
            );
        }
        other => panic!("hung stream must produce Transport error, got {other:?}"),
    }
    assert!(
        guarded.next().await.is_none(),
        "guard must terminate stream after first-word timeout"
    );
}

/// After first semantic output the guard applies no time cutoff.
#[tokio::test]
async fn guard_first_word_does_not_time_out_after_first_frame() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream = Box::pin(
        futures_util::stream::iter(vec![Ok(b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n".to_vec())])
            .chain(futures_util::stream::pending()),
    );
    let mut guarded = super::relay_runtime_shared::guard_v3_provider_sse_first_word(
        "req-idle-after-first",
        "provider-1",
        V3HubProviderWireProtocol::OpenAiChat,
        stream,
        tokio::time::Instant::now() + std::time::Duration::from_millis(50),
    );
    assert_eq!(
        guarded
            .next()
            .await
            .expect("first frame")
            .expect("first frame must pass"),
        b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n".to_vec()
    );
    let outcome = tokio::time::timeout(std::time::Duration::from_millis(100), guarded.next()).await;
    assert!(
        outcome.is_err(),
        "caller cancellation is the only time bound after first word"
    );
}

#[tokio::test]
async fn relay_first_word_deadline_stops_continuous_keepalives() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream = Box::pin(
        futures_util::stream::iter(vec![Ok(b": keepalive\n\n".to_vec())]).chain(
            futures_util::stream::unfold((), |_| async {
                Some((
                    Ok::<Vec<u8>, V3ProviderError>(b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n".to_vec()),
                    (),
                ))
            }),
        ),
    );
    let mut stream = super::relay_runtime_shared::guard_v3_provider_sse_first_word(
        "req-residence-deadline",
        "provider-1",
        V3HubProviderWireProtocol::OpenAiChat,
        stream,
        tokio::time::Instant::now() + std::time::Duration::from_millis(50),
    );
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            match stream.next().await {
                Some(Ok(_)) => {}
                other => break other,
            }
        }
    })
    .await
    .expect("attempt deadline guard must not hang");
    assert!(matches!(
        result,
        Some(Err(V3ProviderError::Transport { reason, .. }))
            if reason.contains("semantic first frame")
    ));
}

#[tokio::test]
async fn provider_raw_sse_observation_is_preserved_on_side_channel() {
    let observation = V3RuntimeStreamObservation::default();
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream = Box::pin(
        futures_util::stream::iter(vec![Ok(b"data: semantic\n\n".to_vec())]),
    );
    let mut observed = observe_v3_provider_sse(stream, observation.clone());

    assert_eq!(
        observed.next().await.unwrap().unwrap(),
        b"data: semantic\n\n"
    );
    assert_eq!(
        observation.snapshot().unwrap().provider_raw_sse,
        "data: semantic\n\n"
    );
    assert_eq!(observation.snapshot().unwrap().observation_error, None);
}
