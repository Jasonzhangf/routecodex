#[tokio::test]
async fn direct_sse_projection_does_not_keep_alive_on_comments_only() {
    let mut stream = observed_sse_client_stream_with_timeout(
        "provider".to_string(),
        Box::pin(stream::unfold(0u8, |index| async move {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            Some((
                Ok::<Vec<u8>, V3ProviderError>(b": keepalive\n\n".to_vec()),
                index.wrapping_add(1),
            ))
        })),
        V3SseRemoteContinuationObservationState::default(),
        V3RuntimeStreamObservation::default(),
        std::time::Duration::from_millis(20),
    );
    let error = loop {
        match stream.next().await {
            Some(Ok(_)) => continue,
            Some(Err(error)) => break error,
            None => panic!("comment-only provider stream must not end silently"),
        }
    };
    assert_eq!(error.code, "provider_response_sse_inter_event_timeout");
}
