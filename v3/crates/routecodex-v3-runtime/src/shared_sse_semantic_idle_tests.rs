#[tokio::test]
async fn direct_sse_first_word_does_not_keep_alive_on_comments_only() {
    let error = guard_initial_direct_sse_provider_failure_with_timeout(
        "provider",
        Box::pin(stream::unfold(0u8, |index| async move {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            Some((
                Ok::<Vec<u8>, V3ProviderError>(b": keepalive\n\n".to_vec()),
                index.wrapping_add(1),
            ))
        })),
        std::time::Duration::from_millis(20),
        None,
        V3HubProviderWireProtocol::Responses,
    )
    .await
    .err()
    .expect("comments must not satisfy semantic first word");
    assert_eq!(error.code, "provider_response_sse_first_event_timeout");
}

#[tokio::test]
async fn direct_sse_projection_allows_pause_after_first_word() {
    let first = b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n".to_vec();
    let expected_first = first.clone();
    let stream = Box::pin(stream::unfold(0, move |index| {
        let first = first.clone();
        async move {
            match index {
                0 => Some((Ok::<Vec<u8>, V3ProviderError>(first), 1)),
                1 => {
                    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                    Some((Ok(b"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"status\":\"completed\",\"output\":[]}}\n\n".to_vec()), 2))
                }
                _ => None,
            }
        }
    }));
    let mut observed = observed_sse_client_stream_with_timeout(
        "provider".to_string(),
        stream,
        V3RuntimeStreamObservation::default(),
        std::time::Duration::from_millis(10),
        None,
        false,
    );
    assert_eq!(observed.next().await.unwrap().unwrap(), expected_first);
    assert!(
        observed.next().await.unwrap().is_ok(),
        "post-first-word pause must not time out"
    );
    assert!(observed.next().await.is_none());
}
