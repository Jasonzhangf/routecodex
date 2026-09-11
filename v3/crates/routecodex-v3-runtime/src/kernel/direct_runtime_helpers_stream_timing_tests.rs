use super::*;

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
    let error = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(source, crate::hub_v1::V3HubProviderWireProtocol::Responses),
        crate::hub_v1::V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect_err("partial attempt must return its provider failure to the resident owner");
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
continuation = { allowed_owners = ["none"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
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
    let error = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(
            Box::pin(source),
            crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        ),
        crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect_err("pre-terminal [DONE] must not release a client frame");
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

    assert_eq!(frames.len(), 1);
    assert!(String::from_utf8(frames[0].clone())
        .unwrap()
        .contains("finish_reason"));
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
        crate::hooks::register_responses_direct_hooks().direct_sse_typed_hooks(),
        false,
        false,
        Some("session-live-observation".to_string()),
        Some(request_id.clone()),
        Some("gpt-5.6-sol".to_string()),
        true,
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
        crate::hooks::register_responses_direct_hooks().direct_sse_typed_hooks(),
        false,
        false,
        Some("session-live-missing".to_string()),
        Some(request_id.clone()),
        Some("gpt-5.6-sol".to_string()),
        true,
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
    assert_eq!(frames.len(), 1);
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

    assert_eq!(frames.len(), 1);
    let output = String::from_utf8(frames[0].clone()).expect("SSE output is UTF-8");
    assert!(output.contains("finish_reason"));
    assert!(!output.contains("not-json"));
}

#[tokio::test]
async fn clean_eof_finishes_runtime_and_publishes_typed_timing() {
    let observation = V3RuntimeStreamObservation::default();
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let source = Box::pin(stream::iter(vec![Ok(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
                .to_vec(),
        )]));
    let mut observed = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        observation.clone(),
        runtime_timing,
        false,
        false,
        crate::hub_v1::V3HubProviderWireProtocol::Responses,
    );

    while let Some(chunk) = observed.next().await {
        chunk.expect("clean Direct SSE must not fail");
    }

    let timing = observation
        .snapshot()
        .expect("stream observation snapshot")
        .timing
        .expect("clean EOF must publish runtime timing");
    assert_eq!(
        timing.internal.checked_add(timing.external),
        Some(timing.runtime_total)
    );
}
