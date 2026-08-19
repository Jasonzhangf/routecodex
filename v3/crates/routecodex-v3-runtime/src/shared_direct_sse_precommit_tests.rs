#[tokio::test]
async fn anthropic_direct_sse_lifecycle_waits_for_first_business_frame() {
    let raw = V3ProviderResp14Raw::from_sse(
        "req".to_string(),
        "anthropic-provider".to_string(),
        200,
        vec![V3ProviderResponseHeader {
            name: "content-type".to_string(),
            value: b"text/event-stream".to_vec(),
        }],
        Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
            b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec(),
        )])),
    );

    let projection =
        project_provider_raw_to_client_payload(V3HubProviderWireProtocol::Anthropic, raw)
            .await
            .expect("Anthropic business delta must authorize Direct client commit");
    let V3ClientBody::Sse(mut stream) = projection.client_payload.body else {
        panic!("expected Anthropic Direct SSE body");
    };
    let chunk = stream.next().await.unwrap().unwrap();
    assert!(std::str::from_utf8(&chunk).unwrap().contains("hello"));
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn anthropic_direct_sse_empty_message_stop_fails_before_client_commit() {
    let raw = V3ProviderResp14Raw::from_sse(
        "req".to_string(),
        "anthropic-provider".to_string(),
        200,
        vec![V3ProviderResponseHeader {
            name: "content-type".to_string(),
            value: b"text/event-stream".to_vec(),
        }],
        Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
            b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec(),
        )])),
    );

    let error = project_provider_raw_to_client_payload(V3HubProviderWireProtocol::Anthropic, raw)
        .await
        .expect_err("Anthropic lifecycle-only terminal must stay precommit");
    assert_eq!(error.code, "provider_response_sse_empty");
}

#[tokio::test]
async fn openai_chat_direct_sse_role_frame_waits_for_first_business_delta() {
    let raw = V3ProviderResp14Raw::from_sse(
        "req".to_string(),
        "chat-provider".to_string(),
        200,
        vec![V3ProviderResponseHeader {
            name: "content-type".to_string(),
            value: b"text/event-stream".to_vec(),
        }],
        Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
            b"data: {\"id\":\"chatcmpl_1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl_1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl_1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".to_vec(),
        )])),
    );

    let projection =
        project_provider_raw_to_client_payload(V3HubProviderWireProtocol::OpenAiChat, raw)
            .await
            .expect("Chat content delta must authorize Direct client commit");
    let V3ClientBody::Sse(mut stream) = projection.client_payload.body else {
        panic!("expected OpenAI Chat Direct SSE body");
    };
    let chunk = stream.next().await.unwrap().unwrap();
    assert!(std::str::from_utf8(&chunk).unwrap().contains("hello"));
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn openai_chat_direct_sse_finish_only_fails_before_client_commit() {
    let raw = V3ProviderResp14Raw::from_sse(
        "req".to_string(),
        "chat-provider".to_string(),
        200,
        vec![V3ProviderResponseHeader {
            name: "content-type".to_string(),
            value: b"text/event-stream".to_vec(),
        }],
        Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
            b"data: {\"id\":\"chatcmpl_1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl_1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".to_vec(),
        )])),
    );

    let error = project_provider_raw_to_client_payload(V3HubProviderWireProtocol::OpenAiChat, raw)
        .await
        .expect_err("Chat lifecycle-only terminal must stay precommit");
    assert_eq!(error.code, "provider_response_sse_empty");
}

#[tokio::test]
async fn responses_direct_sse_empty_completed_fails_before_client_commit() {
    for completed in [
        r#"{"type":"response.completed","response":{"id":"resp_empty","status":"completed","output":[]}}"#,
        r#"{"type":"response.completed","response":{"id":"resp_empty","status":"completed"}}"#,
    ] {
        let wire = format!(
            "data: {{\"type\":\"response.created\",\"response\":{{\"id\":\"resp_empty\",\"output\":[]}}}}\n\ndata: {completed}\n\n"
        )
        .into_bytes();
        let raw = V3ProviderResp14Raw::from_sse(
            "req".to_string(),
            "empty-provider".to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(wire)])),
        );

        let error =
            project_provider_raw_to_client_payload(V3HubProviderWireProtocol::Responses, raw)
                .await
                .expect_err("empty response.completed must stay before Resp15 client commit");
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(error.source_stage, "V3ProviderResp14Raw");
        assert_eq!(error.code, "provider_response_sse_empty");
        assert_eq!(
            error
                .external_error
                .as_ref()
                .and_then(|external| external.code.as_deref()),
            Some("provider_response_sse_empty")
        );
    }
}

#[tokio::test]
async fn responses_direct_sse_reasoning_text_terminal_does_not_fail_after_partial_output() {
    let wire = b"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_reasoning\",\"output\":[]}}\n\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"reasoning_1\",\"status\":\"in_progress\",\"content\":[],\"summary\":[]}}\n\ndata: {\"type\":\"response.reasoning_text.delta\",\"item_id\":\"reasoning_1\",\"output_index\":0,\"content_index\":0,\"delta\":\"We need answer exactly.\"}\n\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"reasoning_1\",\"status\":\"incomplete\",\"content\":[{\"type\":\"reasoning_text\",\"text\":\"We need answer exactly.\"}],\"summary\":[],\"encrypted_content\":\"cipher-1\"}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_reasoning\",\"status\":\"completed\",\"output\":[{\"type\":\"reasoning\",\"id\":\"reasoning_1\",\"status\":\"incomplete\",\"content\":[{\"type\":\"reasoning_text\",\"text\":\"We need answer exactly.\"}],\"summary\":[],\"encrypted_content\":\"cipher-1\"}]}}\n\n".to_vec();
    let raw = V3ProviderResp14Raw::from_sse(
        "req".to_string(),
        "opencode-go".to_string(),
        200,
        vec![V3ProviderResponseHeader {
            name: "content-type".to_string(),
            value: b"text/event-stream".to_vec(),
        }],
        Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
            wire.clone(),
        )])),
    );

    let projection =
        project_provider_raw_to_client_payload(V3HubProviderWireProtocol::Responses, raw)
            .await
            .expect("reasoning delta must authorize Direct client commit");
    let V3ClientBody::Sse(mut stream) = projection.client_payload.body else {
        panic!("expected Responses Direct SSE body");
    };
    assert_eq!(
        stream
            .next()
            .await
            .expect("reasoning SSE chunk must be replayed")
            .expect("reasoning_text terminal must stay on the success stream"),
        wire
    );
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn direct_sse_empty_output_item_then_failed_projects_error_before_client_commit() {
    let raw = V3ProviderResp14Raw::from_sse(
        "req".to_string(),
        "provider".to_string(),
        201,
        vec![V3ProviderResponseHeader {
            name: "content-type".to_string(),
            value: b"text/event-stream".to_vec(),
        }],
        Box::pin(stream::iter(vec![
            Ok::<Vec<u8>, V3ProviderError>(
                b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"status\":\"in_progress\",\"content\":[]}}\n\n".to_vec(),
            ),
            Ok::<Vec<u8>, V3ProviderError>(
                b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"provider_failed\",\"message\":\"provider failed after empty lifecycle frame\"}}}\n\n".to_vec(),
            ),
        ])),
    );

    let error = project_provider_raw_to_client_payload(V3HubProviderWireProtocol::Responses, raw)
        .await
        .expect_err("empty lifecycle frames must not commit Resp15 before provider failure");
    assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
    assert_eq!(error.code, "provider_failed");
}

#[tokio::test]
async fn direct_sse_empty_output_item_then_eof_projects_error_before_client_commit() {
    let raw = V3ProviderResp14Raw::from_sse(
        "req".to_string(),
        "provider".to_string(),
        201,
        vec![V3ProviderResponseHeader {
            name: "content-type".to_string(),
            value: b"text/event-stream".to_vec(),
        }],
        Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
            b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"status\":\"in_progress\",\"content\":[]}}\n\n".to_vec(),
        )])),
    );

    let error = project_provider_raw_to_client_payload(V3HubProviderWireProtocol::Responses, raw)
        .await
        .expect_err("empty lifecycle frames followed by EOF must fail before Resp15 commit");
    assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
    assert_eq!(error.code, "provider_response_sse_empty");
}

#[tokio::test]
async fn direct_sse_first_non_failure_frame_replays_buffered_chunk() {
    let raw = V3ProviderResp14Raw::from_sse(
        "req".to_string(),
        "provider".to_string(),
        200,
        vec![V3ProviderResponseHeader {
            name: "content-type".to_string(),
            value: b"text/event-stream".to_vec(),
        }],
        Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
            b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec(),
        )])),
    );

    let projection =
        project_provider_raw_to_client_payload(V3HubProviderWireProtocol::Responses, raw)
            .await
            .unwrap();
    match projection.client_payload.body {
        V3ClientBody::Sse(mut stream) => {
            let chunk = stream.next().await.unwrap().unwrap();
            let text = std::str::from_utf8(&chunk).unwrap();
            assert!(text.contains("response.output_text.delta"), "{text}");
            assert!(text.contains("ok"), "{text}");
            assert!(stream.next().await.is_none());
        }
        other => panic!("expected direct SSE body, got {other:?}"),
    }
}

#[tokio::test]
async fn direct_sse_projection_starts_client_stream_before_provider_eof() {
    let raw = V3ProviderResp14Raw::from_sse(
        "req".to_string(),
        "provider".to_string(),
        200,
        vec![V3ProviderResponseHeader {
            name: "content-type".to_string(),
            value: b"text/event-stream".to_vec(),
        }],
        Box::pin(
            stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
                b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"early\"}\n\n".to_vec(),
            )])
            .chain(futures_util::stream::pending()),
        ),
    );

    let projection =
        project_provider_raw_to_client_payload(V3HubProviderWireProtocol::Responses, raw)
            .await
            .unwrap();
    let V3ClientBody::Sse(mut stream) = projection.client_payload.body else {
        panic!("expected direct SSE body");
    };
    let chunk = tokio::time::timeout(std::time::Duration::from_millis(100), stream.next())
        .await
        .expect("client stream must start before provider EOF")
        .expect("provider first chunk must be forwarded")
        .expect("provider first chunk must be valid");
    assert!(std::str::from_utf8(&chunk).unwrap().contains("early"));
}

#[tokio::test]
async fn direct_sse_projection_times_out_after_provider_stalls_between_frames() {
    let first = b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"early\"}\n\n".to_vec();
    let mut stream = observed_sse_client_stream_with_timeout(
        V3HubProviderWireProtocol::Responses,
        "provider".to_string(),
        Box::pin(
            stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(first)])
                .chain(futures_util::stream::pending()),
        ),
        V3SseRemoteContinuationObservationState::default(),
        V3RuntimeStreamObservation::default(),
        std::time::Duration::from_millis(20),
    );
    let first = stream
        .next()
        .await
        .expect("first frame")
        .expect("valid first frame");
    assert!(std::str::from_utf8(&first).unwrap().contains("early"));
    let error = stream
        .next()
        .await
        .expect("mid-stream stall must become an explicit error")
        .expect_err("mid-stream stall must not become silent EOF");
    assert_eq!(error.code, "provider_response_sse_inter_event_timeout");
}
