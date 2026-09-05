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
    )
    .await;
    assert!(result.is_err(), "first frame error must propagate");
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
    )
    .await;
    assert!(
        result.is_err(),
        "a malformed Responses frame before first output must reselect before client commit"
    );
}

/// 空闲守卫：正常 provider 流逐帧透传、EOF 原样结束（不改变语义）。
#[tokio::test]
async fn guard_idle_passes_through_chunks_until_eof() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream =
        Box::pin(futures_util::stream::iter(vec![
            Ok(b"data: a\n\n".to_vec()),
            Ok(b"data: b\n\n".to_vec()),
        ]));
    let mut guarded = guard_v3_provider_sse_idle(
        "req-idle-ok",
        "provider-1",
        stream,
        std::time::Duration::from_secs(5),
    );
    let first = guarded
        .next()
        .await
        .expect("first frame")
        .expect("frame ok");
    assert_eq!(first, b"data: a\n\n".to_vec());
    let second = guarded
        .next()
        .await
        .expect("second frame")
        .expect("frame ok");
    assert_eq!(second, b"data: b\n\n".to_vec());
    assert!(
        guarded.next().await.is_none(),
        "stream must end after provider frames"
    );
}

/// 空闲守卫：provider 流数据挂起（无新帧）超过窗口 -> 产出 Transport 错误并终止
/// （进入 provider 失败链切 provider），而不是无限等待。
#[tokio::test]
async fn guard_idle_times_out_on_hung_stream() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream =
        Box::pin(futures_util::stream::pending());
    let mut guarded = guard_v3_provider_sse_idle(
        "req-idle-hung",
        "provider-1",
        stream,
        std::time::Duration::from_millis(50),
    );
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), guarded.next()).await;
    match outcome {
        Ok(Some(Err(V3ProviderError::Transport { reason, .. }))) => {
            assert!(
                reason.contains("idle timeout"),
                "hung stream must produce idle timeout transport error, got {reason}"
            );
            assert!(
                reason.contains("50ms"),
                "idle timeout error must report the configured window, got {reason}"
            );
        }
        other => panic!("hung stream must produce Transport error, got {other:?}"),
    }
    assert!(
        guarded.next().await.is_none(),
        "guard must terminate stream after idle timeout"
    );
}

/// 首帧已提交后 provider 再挂起：后续 idle guard 仍必须生效，避免客户端
/// 在已收到部分响应后无限等待。
#[tokio::test]
async fn guard_idle_times_out_after_first_frame() {
    let stream: routecodex_v3_provider_responses::V3ProviderSseStream = Box::pin(
        futures_util::stream::iter(vec![Ok(b"data: first\n\n".to_vec())])
            .chain(futures_util::stream::pending()),
    );
    let mut guarded = guard_v3_provider_sse_idle(
        "req-idle-after-first",
        "provider-1",
        stream,
        std::time::Duration::from_millis(50),
    );
    assert_eq!(
        guarded
            .next()
            .await
            .expect("first frame")
            .expect("first frame must pass"),
        b"data: first\n\n".to_vec()
    );
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), guarded.next()).await;
    match outcome {
        Ok(Some(Err(V3ProviderError::Transport { reason, .. }))) => {
            assert!(
                reason.contains("idle timeout"),
                "unexpected reason: {reason}"
            );
        }
        other => panic!("post-first-frame hang must produce Transport error, got {other:?}"),
    }
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
