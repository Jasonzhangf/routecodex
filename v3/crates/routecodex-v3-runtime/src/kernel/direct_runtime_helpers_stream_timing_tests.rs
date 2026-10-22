use super::*;

fn expect_ordinary_source<T>(
    result: crate::shared::V3DirectSourceResult<T>,
) -> V3Error01SourceRaised {
    match result {
        Err(Ok(source)) => source,
        Err(Err(fault)) => panic!("unexpected SDK fault: {fault:?}"),
        Ok(_) => panic!("expected an ordinary source"),
    }
}

#[tokio::test]
async fn compact_direct_projected_stream_reaches_collector_without_loopback() {
    let expected = serde_json::json!({"id":"compact-response","object":"response",
        "status":"completed","output":[{"id":"compact-message","type":"message",
        "role":"assistant","text":"compact answer"}]});
    let bytes = format!(
        "event: response.completed\ndata: {}\n\n",
        serde_json::json!({"type":"response.completed","response":expected})
    )
    .into_bytes();
    let timing = V3RuntimeTimingState::start();
    timing.start_external().unwrap();
    let projected = wrap_direct_sse_provider_event_json_observation_stream_with_compat(
        V3ProviderAttemptSseStream::new(Box::pin(stream::iter([Ok(bytes)]))),
        V3RuntimeStreamObservation::default(),
        timing.clone(),
        false,
        false,
        V3HubProviderWireProtocol::Responses,
        false,
        false,
        None,
        None,
        V3DirectSseTypedHookCatalog::default(),
        false,
        false,
        None,
        None,
        None,
        true,
        std::collections::HashMap::new(),
    );
    let result = collect_direct_sse_attempt_after_terminal(
        projected,
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await;
    let committed = result.unwrap_or_else(|source| {
        panic!(
            "original compact collector source: {source:?}; timing_finished={:?}",
            timing.is_finished()
        )
    });
    let frames = committed.collect::<Vec<_>>().await;
    let body = String::from_utf8(frames.concat()).unwrap();
    let event: serde_json::Value = serde_json::from_str(
        body.lines()
            .find_map(|line| line.strip_prefix("data:"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(event["response"]["output"], expected["output"]);
}

#[test]
fn direct_sse_missing_projection_observation_is_bound_before_stream_closeout() {
    let mut projection_observation = None;
    let target = crate::kernel::bind_direct_sse_stream_observation(&mut projection_observation);
    target
        .record_timing(V3RuntimeTimingSummary {
            runtime_total: std::time::Duration::from_millis(3),
            external: std::time::Duration::from_millis(2),
            internal: std::time::Duration::from_millis(1),
        })
        .unwrap();
    assert_eq!(
        projection_observation
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .timing,
        target.snapshot().unwrap().timing,
    );
}

#[tokio::test]
async fn empty_direct_attempt_keeps_original_error_and_timing_open_for_recovery() {
    let timing = V3RuntimeTimingState::start();
    timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let projected = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(Box::pin(stream::iter([Ok(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n".to_vec(),
        )]))), observation.clone(), timing.clone(), false, false,
        V3HubProviderWireProtocol::Responses,
    );
    let source = expect_ordinary_source(
        collect_direct_sse_attempt_after_terminal(
            projected,
            V3HubProviderWireProtocol::Responses,
            crate::nodes::V3AttemptBudget::process_default(),
        )
        .await,
    );
    assert_eq!(source.source_kind, V3ErrorSourceKind::ProviderFailure);
    assert_eq!(source.code, "provider_response_empty");
    timing
        .finish_external_if_active()
        .expect("failure cleanup must not mask original source");
    assert!(!timing.is_finished().unwrap());
    assert!(observation.snapshot().unwrap().timing.is_none());
    timing
        .start_external()
        .expect("next candidate must share the open runtime interval");
    timing.finish_external_if_active().unwrap();
    timing.finish_runtime().unwrap();
}

#[tokio::test]
async fn direct_sse_provider_error_after_partial_attempt_is_recoverable_by_resident_owner() {
    let source: V3ClientSseStream = Box::pin(stream::iter([
            Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"status\":\"in_progress\",\"content\":[]}}\n\n".to_vec()),
            Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "provider_response_sse_stream",
                "provider stream failed after the first semantic item",
            )),
        ]));
    let error = expect_ordinary_source(
        collect_direct_sse_attempt_after_terminal(
            test_direct_sse_attempt_stream(
                source,
                crate::hub_v1::V3HubProviderWireProtocol::Responses,
            ),
            crate::hub_v1::V3HubProviderWireProtocol::Responses,
            crate::nodes::V3AttemptBudget::process_default(),
        )
        .await,
    );
    assert_eq!(error.code, "provider_response_sse_stream");

    let replacement: V3ClientSseStream = Box::pin(stream::iter([Ok(
            b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"recovered\",\"status\":\"in_progress\",\"output\":[]}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"recovered\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"recovered\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n\n".to_vec(),
        )]));
    let frames = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            replacement,
            crate::hub_v1::V3HubProviderWireProtocol::Responses,
        ),
        crate::hub_v1::V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("replacement attempt must seal")
    .collect::<Vec<_>>()
    .await;
    let text = String::from_utf8(frames.concat()).unwrap();
    assert!(text.contains("recovered"));
}

#[tokio::test]
async fn direct_sse_committed_client_projection_removes_memory_from_delta_done_completed() {
    use futures_util::StreamExt;
    use routecodex_v3_agent_memory::ROUTE_CODEX_MEMORY_RAW_ENTRY_V1;
    use serde_json::json;
    use std::fs;

    let root = std::env::temp_dir().join(format!(
        "memory-runtime-sse-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut manifest = routecodex_v3_config::compile_v3_config_05_manifest(
        routecodex_v3_config::parse_v3_config_02_authoring(
            r#"
version = 3
[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client"]
allowed_transports = ["sse"]
[providers.openai]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_TEST_KEY" }] }
[providers.openai.models.gpt-test]
supports_streaming = true
[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "openai", model = "gpt-test", priority = 1 }]
[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap();
    manifest.memory_raw_capture.enabled = true;
    manifest.memory_raw_capture.project_root = root.clone();
    manifest.memory_raw_capture.host_id_prefix = "runtime-test-".to_owned();

    let envelope = serde_json::to_string(&json!({
        "memory": {"entries": [{
            "schema": ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
            "category": "knowledge",
            "title": "Runtime SSE capture",
            "content": "The committed client projection strips this envelope.",
            "tags": ["runtime", "sse"]
        }]}
    }))
    .unwrap();
    let full_text = format!("Answer kept for client. {envelope}");
    let split = full_text.len() / 2;
    let (first, second) = full_text.split_at(split);
    let source: V3ClientSseStream = Box::pin(stream::iter([Ok(format!(
        "event: response.output_text.delta\ndata: {}\n\nevent: response.output_text.delta\ndata: {}\n\nevent: response.output_text.done\ndata: {}\n\nevent: response.completed\ndata: {}\n\n",
        json!({"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": first}),
        json!({"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": second}),
        json!({"type": "response.output_text.done", "output_index": 0, "content_index": 0, "text": full_text}),
        json!({"type": "response.completed", "response": {
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": full_text}]}]
        }}),
    )
    .into_bytes())]));
    let committed = collect_direct_sse_attempt_after_terminal_with_memory(
        test_direct_sse_attempt_stream(source, crate::hub_v1::V3HubProviderWireProtocol::Responses),
        crate::hub_v1::V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
        Some(&manifest),
        Some("runtime-sse-request"),
    )
    .await
    .expect("memory-enabled direct SSE attempt must commit");
    let client_bytes = committed.collect::<Vec<_>>().await.concat();
    let client_text = String::from_utf8(client_bytes).unwrap();
    assert!(client_text.contains("Answer kept for client."));
    assert!(!client_text.contains(ROUTE_CODEX_MEMORY_RAW_ENTRY_V1));
    assert!(!client_text.contains("\"memory\""));
    assert!(root.join("memory/L3").is_dir());
    assert_eq!(fs::read_dir(root.join("memory/L3")).unwrap().count(), 1);
    fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn direct_sse_event_only_frame_cannot_supply_provider_json_type() {
    let source = Box::pin(stream::iter(vec![Ok(
            b"event: response.completed\ndata: {\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n"
                .to_vec(),
        )])) as V3ClientSseStream;
    let result = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(source, V3HubProviderWireProtocol::Responses),
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await;
    assert!(
        result.is_err(),
        "event: must not fabricate provider JSON type"
    );
}

#[tokio::test]
async fn openai_chat_direct_sse_rejects_done_before_finish_reason() {
    let source = Box::pin(stream::iter([
            Ok(b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\ndata: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n".to_vec()),
        ]));
    let error = expect_ordinary_source(
        collect_direct_sse_attempt_after_terminal(
            test_direct_sse_attempt_stream(
                Box::pin(source),
                crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
            ),
            crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
            crate::nodes::V3AttemptBudget::process_default(),
        )
        .await,
    );
    assert_eq!(error.code, "provider_response_sse_stream");
    assert!(error
        .message
        .contains("[DONE] before terminal finish_reason"));
}

#[tokio::test]
async fn openai_chat_direct_sse_releases_only_after_finish_reason_and_done() {
    let source = Box::pin(stream::iter([
            Ok(b"data: {\"id\":\"chatcmpl_direct\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".to_vec()),
        ]));
    let frames = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            Box::pin(source),
            crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        ),
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("terminal attempt must seal")
    .collect::<Vec<_>>()
    .await;

    let text = String::from_utf8(frames.concat()).unwrap();
    assert!(text.contains("finish_reason"));
    assert_eq!(
        text.matches("data: [DONE]").count(),
        1,
        "chat closeout must be delivered exactly once: {text}"
    );
}

#[test]
fn direct_responses_done_event_does_not_bypass_provider_codec_terminal_contract() {
    let observation = V3RuntimeStreamObservation::default();
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut consumer = V3DirectSseContentConsumer {
        provider_protocol: Some(crate::hub_v1::V3HubProviderWireProtocol::Responses),
        ..Default::default()
    };
    let mut semantic_state = V3DirectSseSemanticState::new();
    let frame = record_direct_sse_provider_event_json_chunk(
        br#"data: {"type":"response.done","response":{"status":"completed"}}

"#,
        &mut decoder,
        &observation,
        &mut consumer,
        &mut semantic_state,
    )
    .expect("provider codec should classify response.done without transport failure");

    assert!(
        !frame
            .is_some_and(|frame| { frame.disposition == V3SseFrameDisposition::SemanticTerminal }),
        "response.done must not bypass the codec terminal contract"
    );
}

#[test]
fn direct_sse_observation_retains_provider_raw_bytes_for_capture() {
    let observation = V3RuntimeStreamObservation::default();
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut consumer = V3DirectSseContentConsumer {
        provider_protocol: Some(crate::hub_v1::V3HubProviderWireProtocol::Responses),
        ..Default::default()
    };
    let chunk = b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"raw\"}\n\n";
    let mut semantic_state = V3DirectSseSemanticState::new();
    record_direct_sse_provider_event_json_chunk(
        chunk,
        &mut decoder,
        &observation,
        &mut consumer,
        &mut semantic_state,
    )
    .expect("provider event should be observed");
    assert_eq!(
        observation.snapshot().unwrap().provider_raw_sse,
        std::str::from_utf8(chunk).unwrap()
    );
}

#[test]
fn direct_sse_keepalive_objects_are_not_forwarded_to_client() {
    let observation = V3RuntimeStreamObservation::default();
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut consumer = V3DirectSseContentConsumer {
        provider_protocol: Some(crate::hub_v1::V3HubProviderWireProtocol::Responses),
        ..Default::default()
    };
    let mut semantic_state = V3DirectSseSemanticState::new();
    for chunk in [
        &br#"data: {"type":"keepalive"}

"#[..],
        &br#"event: keepalive
data: {"heartbeat":true}

"#[..],
        &br#"event: keepalive
data: not-json

"#[..],
        &br#"event: keepalive

"#[..],
    ] {
        let frame = record_direct_sse_provider_event_json_chunk(
            chunk,
            &mut decoder,
            &observation,
            &mut consumer,
            &mut semantic_state,
        )
        .expect("transport keepalive must not abort Direct projection");
        assert!(
            frame.is_none(),
            "keepalive must not be forwarded to the client"
        );
    }
}

#[test]
fn direct_sse_keepalive_object_before_completed_is_consumed() {
    let observation = V3RuntimeStreamObservation::default();
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut consumer = V3DirectSseContentConsumer {
        provider_protocol: Some(crate::hub_v1::V3HubProviderWireProtocol::Responses),
        ..Default::default()
    };
    let mut semantic_state = V3DirectSseSemanticState::new();
    let chunk = b"data: {\"type\":\"keepalive\"}\n\n\
data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_keepalive_direct\",\"status\":\"completed\",\"output\":[]}}\n\n";
    let frame = record_direct_sse_provider_event_json_chunk(
        chunk,
        &mut decoder,
        &observation,
        &mut consumer,
        &mut semantic_state,
    )
    .expect("keepalive then completed must project terminal");
    let frame = frame.expect("response.completed must be terminal");
    assert_eq!(frame.disposition, V3SseFrameDisposition::SemanticTerminal);
    let bytes = String::from_utf8(frame.bytes).expect("projected SSE bytes");
    assert!(
        !bytes.contains(r#""type":"keepalive""#),
        "keepalive frame must be consumed"
    );
    assert!(bytes.contains("response.completed"));
}

#[tokio::test]
async fn direct_sse_toolreason_records_typed_observation_at_resp03() {
    let request_id = format!("{}-request-live-observation", module_path!());
    let observation = V3RuntimeStreamObservation::default();
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let source = V3ProviderAttemptSseStream::new(Box::pin(stream::iter(vec![Ok(
            r#"event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_live_observation","type":"function_call","name":"pwd","call_id":"call_live_observation","arguments":""}}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","output_index":0,"item_id":"call_live_observation","arguments":"{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\"}"}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"id":"call_live_observation","type":"function_call","name":"pwd","call_id":"call_live_observation","arguments":"{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\"}"}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_live_observation","status":"completed","output":[{"id":"call_live_observation","type":"function_call","name":"pwd","call_id":"call_live_observation","arguments":"{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\"}"}]}}

"#
            .as_bytes()
            .to_vec(),
        )])));
    let mut projected = wrap_direct_sse_provider_event_json_observation_stream_with_compat(
        source,
        observation.clone(),
        runtime_timing,
        false,
        false,
        V3HubProviderWireProtocol::Responses,
        false,
        false,
        None,
        None,
        crate::hooks::register_responses_direct_hooks().direct_sse_typed_hooks(),
        false,
        false,
        Some("session-live-observation".to_string()),
        Some(request_id.clone()),
        Some("gpt-5.6-sol".to_string()),
        true,
        std::collections::HashMap::new(),
    );

    while let Some(chunk) = projected.next().await {
        chunk.expect("live-equivalent Direct Toolreason SSE must project");
    }

    let snapshot = observation.snapshot().expect("observation snapshot");
    assert!(snapshot.toolreason.is_none());
}

#[tokio::test]
async fn direct_sse_toolreason_missing_records_typed_observation_without_projection() {
    let request_id = format!("{}-request-live-missing", module_path!());
    let observation = V3RuntimeStreamObservation::default();
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let source = V3ProviderAttemptSseStream::new(Box::pin(stream::iter(vec![Ok(
            r#"event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_live_missing","type":"function_call","name":"pwd","call_id":"call_live_missing","arguments":""}}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"id":"call_live_missing","type":"function_call","name":"pwd","call_id":"call_live_missing","arguments":"{\"cmd\":\"pwd\"}"}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_live_missing","status":"completed","output":[{"id":"call_live_missing","type":"function_call","name":"pwd","call_id":"call_live_missing","arguments":"{\"cmd\":\"pwd\"}"}]}}

"#
            .as_bytes()
            .to_vec(),
        )])));
    let mut projected = wrap_direct_sse_provider_event_json_observation_stream_with_compat(
        source,
        observation.clone(),
        runtime_timing,
        false,
        false,
        V3HubProviderWireProtocol::Responses,
        false,
        false,
        None,
        None,
        crate::hooks::register_responses_direct_hooks().direct_sse_typed_hooks(),
        false,
        false,
        Some("session-live-missing".to_string()),
        Some(request_id.clone()),
        Some("gpt-5.6-sol".to_string()),
        true,
        std::collections::HashMap::new(),
    );
    let mut client_sse = Vec::new();
    while let Some(chunk) = projected.next().await {
        client_sse.extend_from_slice(
            chunk
                .expect("missing Toolreason must preserve the native call")
                .as_ref(),
        );
    }

    let client_sse = String::from_utf8(client_sse).unwrap();
    assert!(!client_sse.contains("rcc_reason_"));
    assert!(!client_sse.contains("response.output_text.delta"));
    assert!(client_sse.contains("call_live_missing"));
    assert!(client_sse.contains(r#"{\"cmd\":\"pwd\"}"#));
    assert!(observation
        .snapshot()
        .expect("observation snapshot")
        .toolreason
        .is_none());
}

#[tokio::test]
async fn direct_sse_broker_waits_for_provider_terminal_before_client_release() {
    let provider = Box::pin(stream::unfold(0usize, |index| async move {
        if index == 0 {
            return Some((
                        Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"status\":\"in_progress\",\"content\":[]}}\n\n".to_vec()),
                        1,
                    ));
        }
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        None
    }));
    let collect = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            Box::pin(provider),
            crate::hub_v1::V3HubProviderWireProtocol::Responses,
        ),
        crate::hub_v1::V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), collect)
            .await
            .is_err(),
        "partial provider bytes must remain buffered before protocol terminal"
    );
}

#[tokio::test]
async fn direct_sse_seals_at_terminal_before_late_transport_close_error() {
    let provider = Box::pin(stream::iter(vec![
            Ok(b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".to_vec()),
            Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "test",
                "late_transport_error",
                "late provider read failed",
            )),
        ]));
    let frames = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            Box::pin(provider),
            crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        ),
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("semantic terminal must seal before transport close noise")
    .collect::<Vec<_>>()
    .await;
    let text = String::from_utf8(frames.concat()).unwrap();
    assert!(
        text.contains(r#""finish_reason":"stop""#),
        "terminal frame must be projected: {text}"
    );
    assert_eq!(
        text.matches("data: [DONE]").count(),
        1,
        "chat closeout must be delivered exactly once: {text}"
    );
}

#[tokio::test]
async fn direct_sse_terminal_does_not_validate_same_chunk_tail() {
    let provider = Box::pin(stream::iter(vec![Ok(
            b"data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: {not-json}\n\n"
                .to_vec(),
        )]));
    let frames = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            Box::pin(provider),
            crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        ),
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("same-chunk provider tail must not reopen a sealed attempt")
    .collect::<Vec<_>>()
    .await;

    let output = String::from_utf8(frames.concat()).expect("SSE output is UTF-8");
    assert!(output.contains("finish_reason"));
    assert!(!output.contains("not-json"));
    assert_eq!(
        output.matches("data: [DONE]").count(),
        1,
        "chat closeout must be delivered exactly once: {output}"
    );
}

#[tokio::test]
async fn successful_collection_finishes_runtime_and_publishes_typed_timing() {
    let observation = V3RuntimeStreamObservation::default();
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let source = Box::pin(stream::iter(vec![Ok(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"success\"}]}}\n\n"
                .to_vec(),
        )]));
    let observed = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        observation.clone(),
        runtime_timing.clone(),
        false,
        false,
        crate::hub_v1::V3HubProviderWireProtocol::Responses,
    );

    let _committed = collect_direct_sse_attempt_after_terminal(
        observed,
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("business attempt must seal");
    assert!(observation.snapshot().unwrap().timing.is_none());
    crate::kernel::finish_v3_direct_runtime_timing(
        true,
        false,
        Some(&observation),
        &runtime_timing,
    )
    .expect("successful full-attempt closeout owns timing publication");

    let timing = observation
        .snapshot()
        .expect("stream observation snapshot")
        .timing
        .expect("successful collection must publish runtime timing");
    assert_eq!(
        timing.internal.checked_add(timing.external),
        Some(timing.runtime_total)
    );
}

#[test]
fn direct_responses_terminal_without_usage_materializes_required_counters() {
    let frame = br#"data: {"type":"response.completed","response":{"status":"completed"}}

"#;
    let output = String::from_utf8(materialize_direct_responses_terminal_usage(frame)).unwrap();
    let value: serde_json::Value =
        serde_json::from_str(output.strip_prefix("data: ").unwrap().trim_end()).unwrap();
    assert_eq!(value["response"]["usage"]["input_tokens"], 0);
    assert_eq!(value["response"]["usage"]["output_tokens"], 0);
    assert_eq!(value["response"]["usage"]["total_tokens"], 0);
}

#[tokio::test]
async fn direct_chat_sse_keeps_terminal_done_when_provider_splits_closeout() {
    // Provider transport frame-splits SSE events, so a chat-wire `[DONE]`
    // arrives in a chunk AFTER the finish_reason terminal. The Direct
    // observation wrapper must keep reading past SemanticTerminal so the
    // following LegalCloseout is collected and the client protocol still
    // receives its terminal `[DONE]` (parity with the relay path).
    let provider = Box::pin(stream::iter(vec![
        Ok(br#"data: {"id":"chatcmpl-controlled","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"first"},"finish_reason":null}]}

"#
            .to_vec()),
        Ok(br#"data: {"id":"chatcmpl-controlled","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

"#
            .to_vec()),
        Ok(b"data: [DONE]\n\n".to_vec()),
    ]));
    let frames = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            provider,
            crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        ),
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("seal")
    .collect::<Vec<_>>()
    .await;
    let text = String::from_utf8(frames.concat()).unwrap();
    assert!(
        text.contains(r#""finish_reason":"stop""#),
        "terminal frame must be projected: {text}"
    );
    assert_eq!(
        text.matches("[DONE]").count(),
        1,
        "split-chunk [DONE] must be delivered to the client: {text}"
    );
}

#[tokio::test]
async fn direct_chat_sse_seals_at_terminal_when_done_splits_before_late_transport_error() {
    // A chat-wire provider may emit the semantic terminal (finish_reason) and
    // then close the transport without ever sending `[DONE]`; a late transport
    // read error is post-terminal noise and must not reopen the completed
    // attempt (parity with the relay path, which ignores post-terminal errors).
    let provider = Box::pin(stream::iter(vec![
        Ok(br#"data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}

"#
        .to_vec()),
        Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "test",
            "late_transport_error",
            "late provider read failed",
        )),
    ]));
    let frames = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            provider,
            crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        ),
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("post-terminal transport noise must not reopen a sealed chat attempt")
    .collect::<Vec<_>>()
    .await;
    let text = String::from_utf8(frames.concat()).unwrap();
    assert!(
        text.contains(r#""finish_reason":"stop""#),
        "terminal frame must be projected: {text}"
    );
    assert_eq!(
        text.matches("data: [DONE]").count(),
        1,
        "chat client closeout must be synthesized after a sealed terminal: {text}"
    );
}

#[tokio::test]
async fn direct_sse_collector_never_swallows_post_terminal_sdk_fault_as_success() {
    let original = build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3DirectResp14ProviderProjectionPrepared",
        "seeded_post_terminal_original",
        "seeded post-terminal original source",
    );
    let policy_failure = build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3Error01SourceRaised",
        "seeded_post_terminal_sdk_fault",
        "seeded post-terminal SDK fault",
    );
    let fault = crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault {
        policy_failure: policy_failure.clone(),
        original_source: Some(original.clone()),
    };
    let source: V3SseAttemptStream = Box::pin(stream::iter(vec![
        Ok(V3SseAttemptFrame::new(
            br#"data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}

"#
            .to_vec(),
            V3SseFrameDisposition::SemanticTerminal,
        )),
        Err(Err(fault.clone())),
    ]));
    let result = collect_direct_sse_attempt_after_terminal(
        source,
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await;

    match result {
        Err(Err(returned)) => {
            assert_eq!(returned.policy_failure, policy_failure);
            assert_eq!(returned.original_source, Some(original));
        }
        Err(Ok(source)) => panic!("fault was collapsed into an ordinary source: {source:?}"),
        Ok(_) => panic!("post-terminal SDK fault was incorrectly sealed as success"),
    }
}

#[tokio::test]
async fn direct_chat_sse_seals_at_terminal_with_unterminated_tail_bytes() {
    // Trailing partial bytes after the chat terminal leave the incremental
    // decoder unterminated; that post-terminal tail must not fail the attempt.
    let provider = Box::pin(stream::iter(vec![Ok(
        br#"data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}

data: {"partial":"tail-without-blank-line""#
            .to_vec(),
    )]));
    let frames = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            provider,
            crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        ),
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("post-terminal tail bytes must not reopen a sealed chat attempt")
    .collect::<Vec<_>>()
    .await;
    let text = String::from_utf8(frames.concat()).unwrap();
    assert!(
        text.contains(r#""finish_reason":"stop""#),
        "terminal frame must be projected: {text}"
    );
    assert_eq!(
        text.matches("data: [DONE]").count(),
        1,
        "chat client closeout must be synthesized after a sealed terminal: {text}"
    );
}

#[tokio::test]
async fn direct_chat_sse_synthesizes_client_done_when_provider_omits_it() {
    // OpenAI Chat's client protocol terminal is the `data: [DONE]` sentinel.
    // A chat-wire provider may close after the semantic terminal without ever
    // emitting it; the committed client stream must still end with the
    // protocol closeout (parity with the chat relay path).
    let provider = Box::pin(stream::iter(vec![Ok(
        br#"data: {"id":"chatcmpl-controlled","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}

"#
        .to_vec(),
    )]));
    let frames = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            provider,
            crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        ),
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("provider omitting [DONE] must still seal a valid chat attempt")
    .collect::<Vec<_>>()
    .await;
    let text = String::from_utf8(frames.concat()).unwrap();
    assert!(
        text.ends_with("data: [DONE]\n\n"),
        "chat client stream must end with the protocol [DONE] sentinel: {text}"
    );
    assert_eq!(text.matches("data: [DONE]").count(), 1, "{text}");
}

#[tokio::test]
async fn direct_sse_empty_complete_anthropic_terminal_is_provider_failure() {
    // A complete Anthropic success with no business content
    // (`message_start content:[] -> end_turn -> message_stop`) must not seal a
    // normal empty completion on the Direct path. It is a typed provider
    // failure for the resident owner to reselect/abort, never a client error.
    let provider: V3ClientSseStream = Box::pin(stream::iter([Ok(
        concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_empty\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude\",\"content\":[]}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        )
        .as_bytes()
        .to_vec(),
    )]));
    let error = expect_ordinary_source(
        collect_direct_sse_attempt_after_terminal(
            test_direct_sse_attempt_stream(
                provider,
                crate::hub_v1::V3HubProviderWireProtocol::Anthropic,
            ),
            crate::hub_v1::V3HubProviderWireProtocol::Anthropic,
            crate::nodes::V3AttemptBudget::process_default(),
        )
        .await,
    );
    assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
    assert_eq!(error.code, "provider_response_empty");
}

#[tokio::test]
async fn direct_sse_text_anthropic_terminal_still_seals() {
    // Non-empty business content must still pass the Direct complete-attempt
    // judgment and seal a normal client stream.
    let provider: V3ClientSseStream = Box::pin(stream::iter([Ok(
        concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_text\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude\",\"content\":[]}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        )
        .as_bytes()
        .to_vec(),
    )]));
    let frames = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            provider,
            crate::hub_v1::V3HubProviderWireProtocol::Anthropic,
        ),
        crate::hub_v1::V3HubProviderWireProtocol::Anthropic,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("a text-bearing Direct SSE attempt must seal")
    .collect::<Vec<_>>()
    .await;
    let text = String::from_utf8(frames.concat()).unwrap();
    assert!(text.contains("done"), "{text}");
}

/// Paced provider: the thinking delta arrives immediately, the terminal only
/// after a delay. The client channel must observe a business frame before the
/// provider terminal resolves, and the streamed bytes must equal the fully
/// buffered attempt byte for byte.
#[tokio::test]
async fn first_frame_commit_delivers_business_frame_before_provider_terminal() {
    let delta = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"hello\"}\n\n";
    let terminal = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"output\":[{\"id\":\"m1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}]}}\n\n";
    let paced = stream::iter([Ok(delta.as_bytes().to_vec())]).chain(stream::once(async {
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        Ok(terminal.as_bytes().to_vec())
    }));
    let source: crate::nodes::V3ProviderAttemptSseInnerStream = Box::pin(paced);
    let projected = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        V3RuntimeStreamObservation::default(),
        V3RuntimeTimingState::start(),
        false,
        false,
        V3HubProviderWireProtocol::Responses,
    );
    let (sink, mut rx) = crate::nodes::V3CommittedClientFrameSink::channel();
    let collector = tokio::spawn(
        collect_direct_sse_attempt_after_terminal_with_hooks_and_client_frames(
            projected,
            V3HubProviderWireProtocol::Responses,
            crate::nodes::V3AttemptBudget::process_default(),
            None,
            None,
            None,
            Some(sink),
        ),
    );
    let first = tokio::time::timeout(std::time::Duration::from_millis(900), rx.recv())
        .await
        .expect(
            "first committable frame must reach the client channel before the provider terminal",
        )
        .expect("client channel frame");
    assert!(
        String::from_utf8_lossy(&first).contains("response.output_text.delta"),
        "first delivered frame: {}",
        String::from_utf8_lossy(&first)
    );
    let sealed = collector
        .await
        .expect("collector task")
        .expect("sealed attempt");
    let mut streamed = vec![first];
    while let Ok(frame) = rx.try_recv() {
        streamed.push(frame);
    }
    streamed.extend(sealed.collect::<Vec<_>>().await);
    let buffered = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            stream::iter([
                Ok(delta.as_bytes().to_vec()),
                Ok(terminal.as_bytes().to_vec()),
            ])
            .boxed(),
            V3HubProviderWireProtocol::Responses,
        ),
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("buffered attempt")
    .collect::<Vec<_>>()
    .await;
    assert_eq!(
        String::from_utf8_lossy(&streamed.concat()),
        String::from_utf8_lossy(&buffered.concat()),
        "streamed client bytes must equal the buffered attempt"
    );
}

/// A realistic Responses business-item sequence: the item identity is bound
/// before its text carriers, which is what the whole-attempt text owners use to
/// associate wire events with the terminal output.
fn responses_text_item_sequence(text: &str) -> Vec<Vec<u8>> {
    [
        serde_json::json!({"type":"response.created","response":{"id":"r1","status":"in_progress","output":[]}}),
        serde_json::json!({"type":"response.output_item.added","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","status":"in_progress","content":[]}}),
        serde_json::json!({"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}),
        serde_json::json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":text}),
        serde_json::json!({"type":"response.output_text.done","output_index":0,"content_index":0,"text":text}),
        serde_json::json!({"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":text}}),
        serde_json::json!({"type":"response.output_item.done","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text}]}}),
        serde_json::json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}]}}),
    ]
    .into_iter()
    .map(|value| {
        format!(
            "event: {}\ndata: {}\n\n",
            value["type"].as_str().unwrap_or("message"),
            value
        )
        .into_bytes()
    })
    .collect()
}

/// Build a Responses item sequence whose visible text arrives as explicit
/// deltas, so a governed marker can be split across provider frames exactly as
/// a streaming provider would split it.
fn responses_split_delta_sequence(deltas: &[&str], full: &str) -> Vec<Vec<u8>> {
    let mut events = vec![
        serde_json::json!({"type":"response.created","response":{"id":"r1","status":"in_progress","output":[]}}),
        serde_json::json!({"type":"response.output_item.added","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","status":"in_progress","content":[]}}),
        serde_json::json!({"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}),
    ];
    for delta in deltas {
        events.push(serde_json::json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "content_index": 0,
            "delta": delta
        }));
    }
    events.extend([
        serde_json::json!({"type":"response.output_text.done","output_index":0,"content_index":0,"text":full}),
        serde_json::json!({"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":full}}),
        serde_json::json!({"type":"response.output_item.done","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":full}]}}),
        serde_json::json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":full}]}]}}),
    ]);
    events
        .into_iter()
        .map(|value| {
            format!(
                "event: {}\ndata: {}\n\n",
                value["type"].as_str().unwrap_or("message"),
                value
            )
            .into_bytes()
        })
        .collect()
}

struct EarlyCommitRun {
    frames: Vec<Vec<u8>>,
    committed: bool,
    failed: bool,
}

/// Run one Responses Direct attempt through the early-commit collector with an
/// explicit Direct response hook selection.
async fn run_early_commit_attempt_with_hooks(
    chunks: Vec<Vec<u8>>,
    hook: Option<(
        &crate::hooks::V3HookRegistry,
        &crate::direct_response_hooks::V3DirectDsmlContext,
    )>,
) -> EarlyCommitRun {
    let chunks: Vec<crate::shared::V3DirectSourceResult<Vec<u8>>> =
        chunks.into_iter().map(Ok).collect();
    let source: crate::nodes::V3ProviderAttemptSseInnerStream = Box::pin(stream::iter(chunks));
    let projected = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        V3RuntimeStreamObservation::default(),
        V3RuntimeTimingState::start(),
        false,
        false,
        V3HubProviderWireProtocol::Responses,
    );
    let (sink, mut rx) = crate::nodes::V3CommittedClientFrameSink::channel();
    let probe_sink = sink.clone();
    let outcome = collect_direct_sse_attempt_after_terminal_with_hooks_and_client_frames(
        projected,
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
        None,
        None,
        hook,
        Some(sink),
    )
    .await;
    let committed = probe_sink.is_committed();
    let mut frames = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        frames.push(frame);
    }
    match outcome {
        Ok(sealed) => {
            frames.extend(sealed.collect::<Vec<_>>().await);
            EarlyCommitRun {
                frames,
                committed,
                failed: false,
            }
        }
        Err(_) => EarlyCommitRun {
            frames,
            committed,
            failed: true,
        },
    }
}

/// Run one Responses Direct attempt with the production Direct response hooks.
async fn run_early_commit_attempt(chunks: Vec<Vec<u8>>) -> EarlyCommitRun {
    let registry = crate::hooks::register_responses_direct_hooks();
    let context = crate::direct_response_hooks::V3DirectDsmlContext::from_request(
        &serde_json::json!({}),
        &std::collections::HashMap::new(),
    );
    run_early_commit_attempt_with_hooks(chunks, Some((&registry, &context))).await
}

/// Fully buffered reference: the same attempt collected without any early
/// client commit but with the same Direct response hook.
async fn buffered_with_hooks(chunks: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    let registry = crate::hooks::register_responses_direct_hooks();
    let context = crate::direct_response_hooks::V3DirectDsmlContext::from_request(
        &serde_json::json!({}),
        &std::collections::HashMap::new(),
    );
    let chunks: Vec<crate::shared::V3DirectSourceResult<Vec<u8>>> =
        chunks.into_iter().map(Ok).collect();
    let source: crate::nodes::V3ProviderAttemptSseInnerStream = Box::pin(stream::iter(chunks));
    let projected = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        V3RuntimeStreamObservation::default(),
        V3RuntimeTimingState::start(),
        false,
        false,
        V3HubProviderWireProtocol::Responses,
    );
    collect_direct_sse_attempt_after_terminal_with_hooks(
        projected,
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
        None,
        None,
        Some((&registry, &context)),
    )
    .await
    .expect("buffered attempt")
    .collect::<Vec<_>>()
    .await
}

/// Fully buffered reference that reports whether the attempt sealed, so a test
/// can compare a refused early commit against the buffered verdict.
async fn buffered_with_hooks_seals(chunks: Vec<Vec<u8>>) -> bool {
    let registry = crate::hooks::register_responses_direct_hooks();
    let context = crate::direct_response_hooks::V3DirectDsmlContext::from_request(
        &serde_json::json!({}),
        &std::collections::HashMap::new(),
    );
    let chunks: Vec<crate::shared::V3DirectSourceResult<Vec<u8>>> =
        chunks.into_iter().map(Ok).collect();
    let source: crate::nodes::V3ProviderAttemptSseInnerStream = Box::pin(stream::iter(chunks));
    let projected = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        V3RuntimeStreamObservation::default(),
        V3RuntimeTimingState::start(),
        false,
        false,
        V3HubProviderWireProtocol::Responses,
    );
    collect_direct_sse_attempt_after_terminal_with_hooks(
        projected,
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
        None,
        None,
        Some((&registry, &context)),
    )
    .await
    .is_ok()
}

/// Governance regression for the early-commit gap: a passthrough Responses
/// provider with no declared tools and no ThinkingTags compat block still gets
/// the unconditional whole-attempt thinking rewrite. The commit probe must
/// never flush a raw `<thinking>` wrapper ahead of that rewrite, so the attempt
/// stays fully buffered and the governed byte stream reaches the client.
#[tokio::test]
async fn first_frame_commit_matches_buffered_thinking_governance() {
    let text = "<thinking>secret</thinking>answer";
    let chunks = responses_text_item_sequence(text);
    let registry = crate::hooks::register_responses_direct_hooks();
    let context = crate::direct_response_hooks::V3DirectDsmlContext::from_request(
        &serde_json::json!({}),
        &std::collections::HashMap::new(),
    );
    let run =
        run_early_commit_attempt_with_hooks(chunks.clone(), Some((&registry, &context))).await;
    assert!(
        !run.committed,
        "a thinking-wrapped prefix must never commit early"
    );
    let streamed = String::from_utf8(run.frames.concat()).unwrap();
    assert!(
        !streamed.contains("<thinking>"),
        "the client stream leaked the raw thinking wrapper: {streamed}"
    );
    assert!(
        streamed.contains("answer"),
        "visible text must survive: {streamed}"
    );
    assert!(
        streamed.contains("response.reasoning_summary_text.delta"),
        "thinking must be preserved as reasoning: {streamed}"
    );
    let buffered = buffered_with_hooks(chunks).await;
    assert_eq!(
        streamed,
        String::from_utf8(buffered.concat()).unwrap(),
        "the governed client stream must equal the buffered attempt"
    );
}

/// Reasoning cannot rescue an explicit blank assistant final. Before the fix,
/// the reasoning delta committed the channel, then `client_committed` skipped
/// the complete-attempt judgment and sealed the blank final as success.
#[tokio::test]
async fn first_frame_commit_reasoning_does_not_mask_blank_final() {
    let reasoning = "event: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"item_id\":\"rs_0\",\"summary_index\":0,\"delta\":\"thinking aloud\"}\n\n";
    let terminal = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"output\":[{\"id\":\"rs_0\",\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"thinking aloud\"}]},{\"id\":\"m1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"    \"}]}]}}\n\n";
    let run = run_early_commit_attempt(vec![
        reasoning.as_bytes().to_vec(),
        terminal.as_bytes().to_vec(),
    ])
    .await;
    assert!(
        !run.committed,
        "reasoning alone must not commit the client channel"
    );
    assert!(
        run.failed,
        "a reasoning + blank final attempt must stay a typed provider failure"
    );
    assert!(
        run.frames.is_empty(),
        "no provider payload may reach the client: {:?}",
        run.frames
    );
}

/// The invisible-final contract is the same: non-displayable characters are
/// not business content, so they must not commit and must fail the attempt.
#[tokio::test]
async fn first_frame_commit_invisible_final_never_commits() {
    let invisible = "\u{200b}\u{200b}";
    let delta = format!(
        "event: response.output_text.delta\ndata: {}\n\n",
        serde_json::json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":invisible})
    );
    let terminal = format!(
        "event: response.completed\ndata: {}\n\n",
        serde_json::json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":invisible}]}]}})
    );
    let run = run_early_commit_attempt(vec![delta.into_bytes(), terminal.into_bytes()]).await;
    assert!(
        !run.committed,
        "an invisible-only delta must not commit the channel"
    );
    assert!(
        run.failed,
        "an invisible-only final must stay a typed provider failure"
    );
    assert!(
        run.frames.is_empty(),
        "no invisible payload may reach the client"
    );
}

/// A pure reasoning attempt with no explicit final is preserved as reasoning,
/// but reasoning alone never authorizes success. The complete attempt is an
/// internal empty state, so it never commits early and never reaches the client.
#[tokio::test]
async fn first_frame_commit_pure_reasoning_without_final_still_seals() {
    let reasoning = "event: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"item_id\":\"rs_0\",\"summary_index\":0,\"delta\":\"plan\"}\n\n";
    let terminal = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"output\":[{\"id\":\"rs_0\",\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"plan\"}]}]}}\n\n";
    let run = run_early_commit_attempt(vec![
        reasoning.as_bytes().to_vec(),
        terminal.as_bytes().to_vec(),
    ])
    .await;
    assert!(!run.committed, "pure reasoning must stay fully buffered");
    assert!(
        run.failed,
        "reasoning alone must not authorize a successful complete attempt"
    );
    assert!(
        run.frames.is_empty(),
        "the empty attempt must not project any client payload"
    );
}

/// The DSML owner also strips standalone analysis labels even without declared
/// tools. Such prose must stay fully buffered and be governed, never committed
/// ahead of the hook, so the label cannot leak as visible output text.
#[tokio::test]
async fn first_frame_commit_analysis_label_stays_governed() {
    let text = "Visible prose.\n<|end\u{2581}of\u{2581}analysis|>\n";
    let chunks = responses_text_item_sequence(text);
    let run = run_early_commit_attempt(chunks.clone()).await;
    assert!(
        !run.committed,
        "analysis-label prose must not commit ahead of the DSML owner"
    );
    assert!(
        !run.failed,
        "visible prose with a removable label is still deliverable"
    );
    let streamed = String::from_utf8(run.frames.concat()).unwrap();
    assert!(
        !streamed.contains("end\u{2581}of\u{2581}analysis"),
        "analysis label leaked: {streamed}"
    );
    assert!(
        streamed.contains("Visible prose."),
        "visible prose must be preserved: {streamed}"
    );
    let buffered = buffered_with_hooks(chunks).await;
    assert_eq!(
        streamed,
        String::from_utf8(buffered.concat()).unwrap(),
        "the governed client stream must equal the buffered attempt"
    );
}

/// The early commit must not bypass the registered complete-attempt hook: the
/// hook still runs after the terminal and the sealed remainder keeps byte
/// identity with the fully buffered attempt.
#[tokio::test]
async fn first_frame_commit_keeps_governance_after_commit() {
    let chunks = responses_text_item_sequence("hello world");
    let run = run_early_commit_attempt(chunks.clone()).await;
    assert!(
        run.committed,
        "clean visible text must commit the client channel"
    );
    assert!(!run.failed, "a clean text attempt must seal");
    let streamed = String::from_utf8(run.frames.concat()).unwrap();
    let buffered = buffered_with_hooks(chunks).await;
    assert_eq!(
        streamed,
        String::from_utf8(buffered.concat()).unwrap(),
        "post-commit governance must keep byte identity with the buffered attempt"
    );
}

/// A marker that appears only after the commit cannot be governed in place.
/// The builder must refuse to rewrite already flushed frames, so the transport
/// ends detectably and no raw marker reaches the client.
#[tokio::test]
async fn first_frame_commit_marker_after_commit_breaks_visibly_without_leaking() {
    let first = "hello";
    let second = " <thinking>x</thinking>";
    let full = format!("{first}{second}");
    let chunks: Vec<Vec<u8>> = [
        serde_json::json!({"type":"response.created","response":{"id":"r1","status":"in_progress","output":[]}}),
        serde_json::json!({"type":"response.output_item.added","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","status":"in_progress","content":[]}}),
        serde_json::json!({"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}),
        serde_json::json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":first}),
        serde_json::json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":second}),
        serde_json::json!({"type":"response.output_text.done","output_index":0,"content_index":0,"text":full}),
        serde_json::json!({"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":full}}),
        serde_json::json!({"type":"response.output_item.done","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":full}]}}),
        serde_json::json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":full}]}]}}),
    ]
    .into_iter()
    .map(|value| {
        format!(
            "event: {}\ndata: {}\n\n",
            value["type"].as_str().unwrap_or("message"),
            value
        )
        .into_bytes()
    })
    .collect();
    let run = run_early_commit_attempt(chunks).await;
    assert!(run.committed, "the clean first delta must commit");
    assert!(
        run.failed,
        "a post-commit whole-attempt rewrite must end the transport detectably"
    );
    let streamed = String::from_utf8(run.frames.concat()).unwrap();
    assert!(
        !streamed.contains("<thinking>"),
        "no raw marker may reach the client after a committed prefix: {streamed}"
    );
    assert!(
        streamed.contains("hello"),
        "the certified prefix must still reach the client: {streamed}"
    );
}

/// A marker-like token inside a protected range is business text. The probe
/// cannot know that (only the registered owner knows fenced and inline code),
/// so the committed channel must hold the tail and let the owner decide: the
/// owner protects the fenced text, the tail is replayed unchanged, and the
/// response is not truncated into a transport break.
#[tokio::test]
async fn first_frame_commit_protected_marker_text_is_delivered_after_commit() {
    let deltas = ["example:\n```\n", "<thinking>literal</thinking>\n```\ndone"];
    let full = deltas.concat();
    let chunks = responses_split_delta_sequence(&deltas, &full);
    let run = run_early_commit_attempt(chunks.clone()).await;
    assert!(
        run.committed,
        "the clean first delta must commit so the tail is decided post-commit"
    );
    assert!(
        !run.failed,
        "protected business text must not truncate a committed response"
    );
    let streamed = String::from_utf8(run.frames.concat()).unwrap();
    assert!(
        streamed.contains("<thinking>literal</thinking>"),
        "protected fenced text must reach the client unchanged: {streamed}"
    );
    assert!(
        streamed.contains("done"),
        "the tail after the protected range must reach the client: {streamed}"
    );
    let buffered = buffered_with_hooks(chunks).await;
    assert_eq!(
        run.frames, buffered,
        "the committed stream must carry exactly the buffered bytes"
    );
}

/// A governed marker split across provider frames is one marker in the
/// streamed text even though neither frame contains it. The commit must stay
/// closed, otherwise the client receives raw reasoning text. After governance
/// the attempt carries no deliverable business content, so it becomes the same
/// typed empty attempt the buffered path produces and projects nothing.
#[tokio::test]
async fn first_frame_commit_marker_split_across_deltas_never_commits() {
    let full = "<thinking>secret</thinking>";
    let chunks = responses_split_delta_sequence(&["<", "thinking>secret</thinking>"], full);
    let run = run_early_commit_attempt(chunks.clone()).await;
    assert!(
        !run.committed,
        "a marker split across deltas must never be certified"
    );
    let streamed = String::from_utf8(run.frames.concat()).unwrap();
    assert!(
        !streamed.contains("<thinking>") && !streamed.contains("</thinking>"),
        "the split marker must not reach the client as text: {streamed}"
    );
    let buffered_seals = buffered_with_hooks_seals(chunks).await;
    assert_eq!(
        run.failed, !buffered_seals,
        "a refused commit must fail exactly when the buffered attempt does"
    );
    assert!(
        run.failed,
        "a marker-only attempt is an internal empty state"
    );
    assert!(
        run.frames.is_empty(),
        "the empty attempt must not project any client payload: {streamed}"
    );
}

/// The same split after a certified prefix: the held frame and the frame that
/// confirms the marker must not be projected.
#[tokio::test]
async fn first_frame_commit_marker_split_after_commit_breaks_without_leaking() {
    let full = "hello <thinking>secret</thinking>";
    let chunks =
        responses_split_delta_sequence(&["hello ", "<thin", "king>secret</thinking>"], full);
    let run = run_early_commit_attempt(chunks).await;
    assert!(run.committed, "the clean prefix must commit");
    assert!(
        run.failed,
        "the split marker must end the committed channel detectably"
    );
    let streamed = String::from_utf8(run.frames.concat()).unwrap();
    assert!(
        streamed.contains("hello"),
        "the certified prefix must still reach the client: {streamed}"
    );
    assert!(
        !streamed.contains("<thin") && !streamed.contains("secret"),
        "neither the held prefix frame nor the reasoning body may reach the client: {streamed}"
    );
}

/// A marker that only appears in the terminal snapshot is still governed,
/// because the complete-attempt owners read that snapshot.
#[tokio::test]
async fn first_frame_commit_marker_only_in_terminal_snapshot_breaks_without_leaking() {
    let clean = "hello";
    let governed = "hello <thinking>secret</thinking>";
    let chunks: Vec<Vec<u8>> = [
        serde_json::json!({"type":"response.created","response":{"id":"r1","status":"in_progress","output":[]}}),
        serde_json::json!({"type":"response.output_item.added","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","status":"in_progress","content":[]}}),
        serde_json::json!({"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}),
        serde_json::json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":clean}),
        serde_json::json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":governed}]}]}}),
    ]
    .into_iter()
    .map(|value| {
        format!(
            "event: {}\ndata: {}\n\n",
            value["type"].as_str().unwrap_or("message"),
            value
        )
        .into_bytes()
    })
    .collect();
    let run = run_early_commit_attempt(chunks).await;
    assert!(run.committed, "the clean delta must commit");
    assert!(
        run.failed,
        "a governed terminal snapshot must end the committed channel detectably"
    );
    let streamed = String::from_utf8(run.frames.concat()).unwrap();
    assert!(
        streamed.contains("hello"),
        "the certified prefix must still reach the client: {streamed}"
    );
    assert!(
        !streamed.contains("<thinking>") && !streamed.contains("secret"),
        "the terminal snapshot marker must not reach the client: {streamed}"
    );
}

/// Ordinary comparison operators are not governed markers. A post-commit text
/// frame with `<` must stream normally and keep byte identity with the fully
/// buffered attempt, so the first-frame commit does not truncate code or math.
#[tokio::test]
async fn first_frame_commit_plain_angle_bracket_text_streams_normally() {
    let chunks = responses_text_item_sequence("if a < b then b > a");
    let run = run_early_commit_attempt(chunks.clone()).await;
    assert!(run.committed, "plain comparison text must commit");
    assert!(
        !run.failed,
        "plain comparison text must not break the transport"
    );
    let streamed = String::from_utf8(run.frames.concat()).unwrap();
    let buffered = buffered_with_hooks(chunks).await;
    assert_eq!(
        streamed,
        String::from_utf8(buffered.concat()).unwrap(),
        "plain angle brackets must keep byte identity with the buffered attempt"
    );
}

/// A standalone orphan tool close label is a removable DSML label, so the
/// complete attempt drops it and flags an unharvestable tool invocation. A
/// committed prefix must never carry it to the client.
#[tokio::test]
async fn first_frame_commit_orphan_tool_close_label_never_reaches_the_client() {
    let label = "</\u{FF5C}DSML\u{FF5C}tool_calls>";
    let full = format!("hello\n{label}\n");
    let chunks = responses_split_delta_sequence(&["hello", "\n", label, "\n"], &full);
    let run = run_early_commit_attempt(chunks.clone()).await;
    assert!(
        run.committed,
        "the clean visible prefix must commit before the label arrives"
    );
    let streamed = String::from_utf8(run.frames.concat()).unwrap();
    assert!(
        !streamed.contains(label),
        "the orphan tool close label must never reach the client: {streamed}"
    );
    assert!(
        run.failed,
        "an unharvestable tool invocation must end the attempt detectably"
    );
}

/// A bare `>` residue line that ends with a newline is still removed together
/// with the close label that follows it. A committed prefix must not carry the
/// `>` byte to the client ahead of that owner.
#[tokio::test]
async fn first_frame_commit_bare_gt_residue_with_newline_never_leaks() {
    let close = "</\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C} calls>";
    let full = format!("hello\n>\n{close}");
    let chunks = responses_split_delta_sequence(&["hello\n>\n", close], &full);
    let run = run_early_commit_attempt(chunks.clone()).await;
    assert!(
        !run.committed,
        "the residue line must stay pending and never certify the prefix"
    );
    assert!(
        !run.failed,
        "the DSML owner must remove the residue and seal the buffered attempt"
    );
    let streamed = String::from_utf8(run.frames.concat()).unwrap();
    assert!(
        !streamed.contains('>'),
        "the bare close residue must never reach the client: {streamed}"
    );
    let buffered = buffered_with_hooks(chunks).await;
    assert_eq!(
        streamed,
        String::from_utf8(buffered.concat()).unwrap(),
        "the committed attempt must stay byte-identical with the buffered attempt"
    );
}
