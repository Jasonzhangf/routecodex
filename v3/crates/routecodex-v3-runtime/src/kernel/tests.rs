use super::*;
use async_trait::async_trait;
use routecodex_v3_config::*;
use routecodex_v3_provider_responses::{
    V3ProviderError, V3ProviderHttpFailure, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use serde_json::json;
use std::time::Duration;

use crate::V3_PROVIDER_ACTION_ISOLATED_DELAY_MS;

mod exact_pin;
mod fixtures;
mod preplanned_target_revalidation;
mod protocol_mode_lock;
use fixtures::*;

fn test_failure_session_scope(routing_group: &str) -> V3ProviderFailureSessionScope {
    test_failure_session_scope_for(routing_group, &format!("test-session:{routing_group}"))
}

fn test_failure_session_scope_for(
    routing_group: &str,
    session_id: &str,
) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("test", routing_group, session_id)
        .expect("test failure session scope")
}

struct CaptureTransport;

#[async_trait]
impl ResponsesTransport for CaptureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        assert_eq!(request.body(), &json!({"model":"gpt-test","input":"hello"}));
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            br#"{"id":"resp_test","output_text":"ok"}"#.to_vec(),
        ))
    }
}

#[tokio::test]
async fn runtime_executes_adjacent_responses_direct_chain() {
    let manifest = test_manifest();
    let raw = test_responses_raw(
        "test",
        "req",
        "exec",
        json!({"model":"client-model","input":"hello"}),
    );
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &CaptureTransport,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{output:?}");
    let timing = output
        .observability
        .as_ref()
        .and_then(|observability| observability.timing)
        .expect("Direct JSON success must publish Runtime timing");
    assert_eq!(
        timing.internal.checked_add(timing.external),
        Some(timing.runtime_total)
    );
    match output.client_payload.body {
        V3ClientBody::Json(value) => {
            assert_eq!(value, json!({"id":"resp_test","output_text":"ok"}));
        }
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => {
            panic!("direct JSON response must remain JSON")
        }
    }
    assert_eq!(
        output.node_trace,
        vec![
            "V3Config05ManifestPublished",
            "V3Server03HttpRequestRaw",
            "V3Req04StandardizedResponses",
            "V3Router05RequestClassified",
            "V3Router06RoutePoolResolved",
            "V3Router07OpaqueTargetHitOnce",
            "V3Target08KindClassified",
            "V3Target09CandidateSetExpanded",
            "V3Target10ConcreteProviderSelected",
            "V3Execution11ProtocolDecision",
            "V3ResponsesDirect11Policy",
            "V3Provider12ResponsesWirePayload",
            "V3Transport13ResponsesHttpRequest",
            "V3ProviderResp14Raw",
            "V3DirectResp14ProviderProjectionPrepared",
            "V3DirectResp15ClientPayloadReady",
            "V3Resp15ClientPayload",
        ]
    );
}

fn scoped_test_manifest(
    mut manifest: V3Config05ManifestPublished,
    routing_group: &str,
) -> V3Config05ManifestPublished {
    let source_group_id = manifest
        .servers
        .get("test")
        .expect("test server")
        .routing_group
        .clone();
    let mut group = manifest
        .route_groups
        .get(&source_group_id)
        .expect("test route group")
        .clone();
    group.id = routing_group.to_string();
    manifest
        .route_groups
        .insert(routing_group.to_string(), group);
    manifest
        .servers
        .get_mut("test")
        .expect("test server")
        .routing_group = routing_group.to_string();
    manifest
}

fn test_plan_http_request(
    routing_group: &str,
    request_id: &str,
    execution_id: &str,
) -> V3Server03HttpRequestRaw {
    V3Server03HttpRequestRaw {
        server_id: "test".to_string(),
        failure_session_scope: test_failure_session_scope(routing_group),
        request_id: request_id.to_string(),
        execution_id: execution_id.to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        body: json!({"model":"client-model","input":"hello"}),
    }
}

fn test_responses_raw(
    routing_group: &str,
    request_id: &str,
    execution_id: &str,
    body: serde_json::Value,
) -> V3Server03HttpRequestRaw {
    V3Server03HttpRequestRaw {
        server_id: "test".to_string(),
        failure_session_scope: test_failure_session_scope(routing_group),
        request_id: request_id.to_string(),
        execution_id: execution_id.to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        body,
    }
}

fn test_protocol_plan(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    provider_health: V3ProviderFailureRuntimeHealth,
    now_epoch_ms: u64,
) -> V3ResponsesProtocolExecutionPlan {
    plan_v3_responses_protocol_execution_with_provider_health(
        manifest,
        raw,
        provider_health,
        now_epoch_ms,
    )
    .expect("test protocol plan")
}

fn test_direct_sse_provider_outcome(routing_group: &str) -> V3DirectSseProviderOutcome {
    let manifest = scoped_test_manifest(test_manifest(), routing_group);
    V3DirectSseProviderOutcome {
        provider_health: V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        failure_session_scope: test_failure_session_scope(routing_group),
        provider_id: "openai".to_string(),
        auth_alias: "key1".to_string(),
        model_id: "gpt-test".to_string(),
        terminal: false,
        seen_done: false,
        recorded: false,
        provider_health_neutral: false,
        _provider_action_permit: None,
    }
}

#[tokio::test]
async fn direct_sse_runtime_timing_publishes_only_after_clean_eof() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
            .to_vec(),
    )]));
    let observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let mut governed = wrap_direct_sse_provider_outcome_stream(observed, test_direct_sse_provider_outcome("direct_sse_runtime_timing_clean_eof"), runtime_timing, observation.clone());

    while governed.next().await.is_some() {}

    let timing = observation
        .snapshot()
        .unwrap()
        .timing
        .expect("clean EOF must publish terminal Runtime timing");
    assert_eq!(
        timing.internal.checked_add(timing.external),
        Some(timing.runtime_total)
    );
}

#[tokio::test]
async fn direct_sse_strip_client_response_id_empties_nested_response_id() {
    let observation = V3RuntimeStreamObservation::default();
    let runtime_timing = V3RuntimeTimingState::start();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"status\":\"in_progress\"}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\"}}\n\n"
            .to_vec(),
    )]));
    let mut observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), true, true);
    let mut first = observed.next().await.unwrap().unwrap();
    assert!(
        String::from_utf8_lossy(&first).contains("event: response.created"),
        "event line must be preserved"
    );
    assert!(
        String::from_utf8_lossy(&first).contains("\"id\":\"\""),
        "nested response.id must be emptied"
    );
    assert!(
        !String::from_utf8_lossy(&first).contains("\"id\":\"resp_1\""),
        "original response id must not leak"
    );
}

#[tokio::test]
async fn direct_sse_strip_disabled_passes_chunk_through_unchanged() {
    let observation = V3RuntimeStreamObservation::default();
    let runtime_timing = V3RuntimeTimingState::start();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"status\":\"in_progress\"}}\n\n"
            .to_vec(),
    )]));
    let mut observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, false);
    let first = observed.next().await.unwrap().unwrap();
    assert!(
        String::from_utf8_lossy(&first).contains("\"id\":\"resp_1\""),
        "strip disabled must keep original id"
    );
}

#[tokio::test]
async fn direct_sse_strips_encrypted_content_when_retain_false() {
    let observation = V3RuntimeStreamObservation::default();
    let runtime_timing = V3RuntimeTimingState::start();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_1\",\"encrypted_content\":\"rsn_CIPHER\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"plain\"}]}}\n\n".to_vec(),
    )]));
    let mut observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, false);
    let first = observed.next().await.unwrap().unwrap();
    let text = String::from_utf8_lossy(&first);
    assert!(
        !text.contains("rsn_CIPHER"),
        "retain=false 必须剥离密文: {text}"
    );
    assert!(text.contains("plain"), "明文 summary 必须保留: {text}");
    assert!(
        text.contains("response.output_item.added"),
        "事件语义必须保留: {text}"
    );
}

#[tokio::test]
async fn direct_sse_keeps_encrypted_content_when_retain_true() {
    let observation = V3RuntimeStreamObservation::default();
    let runtime_timing = V3RuntimeTimingState::start();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_1\",\"encrypted_content\":\"rsn_KEEP\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"plain\"}]}}\n\n".to_vec(),
    )]));
    let mut observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let first = observed.next().await.unwrap().unwrap();
    let text = String::from_utf8_lossy(&first);
    assert!(
        text.contains("rsn_KEEP"),
        "retain=true（单 gpt provider）必须保留密文: {text}"
    );
}

#[tokio::test]
async fn direct_sse_retain_false_passes_cipher_free_frames_byte_for_byte() {
    let observation = V3RuntimeStreamObservation::default();
    let runtime_timing = V3RuntimeTimingState::start();
    let raw = b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n".to_vec();
    let source = Box::pin(stream::iter(vec![Ok(raw.clone())]));
    let mut observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let first = observed.next().await.unwrap().unwrap();
    assert_eq!(
        first, raw,
        "retain=false 且帧无密文时必须逐字节透传（direct SSE 字节保真）"
    );
}

#[tokio::test]
async fn direct_sse_terminal_event_before_eof_does_not_publish_runtime_timing() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(
        stream::iter(vec![Ok(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
                .to_vec(),
        )])
        .chain(stream::pending()),
    );
    let observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let mut governed = wrap_direct_sse_provider_outcome_stream(observed, test_direct_sse_provider_outcome("direct_sse_terminal_before_eof"), runtime_timing, observation.clone());

    governed.next().await.unwrap().unwrap();
    assert!(
        observation.snapshot().unwrap().timing.is_none(),
        "terminal event without clean EOF must not publish Runtime timing"
    );
    drop(governed);
    assert!(observation.snapshot().unwrap().timing.is_none());
}

#[tokio::test]
async fn direct_sse_malformed_tail_does_not_publish_runtime_timing() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\ndata: {"
            .to_vec(),
    )]));
    let observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let mut governed = wrap_direct_sse_provider_outcome_stream(observed, test_direct_sse_provider_outcome("direct_sse_malformed_tail"), runtime_timing, observation.clone());

    let mut saw_error = false;
    while let Some(result) = governed.next().await {
        if result.is_err() {
            saw_error = true;
        }
    }
    assert!(saw_error, "malformed SSE tail must fail closeout");
    assert!(
        observation.snapshot().unwrap().timing.is_none(),
        "malformed SSE tail must not publish successful Runtime timing"
    );
}

#[tokio::test]
async fn direct_sse_response_done_without_completed_is_terminal_missing() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(stream::iter(vec![Ok(concat!(
        "event: response.done\n",
        "data: {\"type\":\"response.done\",\"response\":{\"status\":\"completed\"}}\n\n",
        "data: [DONE]\n\n",
    )
    .as_bytes()
    .to_vec())]));
    let observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let mut governed = wrap_direct_sse_provider_outcome_stream(observed, test_direct_sse_provider_outcome("direct_sse_done_without_completed"), runtime_timing, observation.clone());

    let mut error = None;
    while let Some(result) = governed.next().await {
        if let Err(source) = result {
            error = Some(source);
        }
    }
    let error = error.expect("response.done without response.completed must fail closeout");
    assert_eq!(error.code, "provider_response_sse_terminal_missing");
    assert!(error.message.contains("[DONE] without response.completed"));
    assert!(
        observation.snapshot().unwrap().timing.is_none(),
        "terminal-missing provider stream must not publish successful Runtime timing"
    );
}

#[tokio::test]
async fn direct_sse_failed_event_without_error_code_is_protocol_invalid() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"quota exhausted\"}}}\n\n"
            .to_vec(),
    )]));
    let observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let mut governed = wrap_direct_sse_provider_outcome_stream(observed, test_direct_sse_provider_outcome("direct_sse_failed_missing_error_code"), runtime_timing, observation.clone());

    let error = governed
        .next()
        .await
        .expect("invalid failure event must terminate the stream")
        .expect_err("missing provider error.code must fail explicitly");
    assert_eq!(error.code, "provider_response_sse_event_invalid");
    assert!(
        error.message.contains("non-empty error code"),
        "{}",
        error.message
    );
    assert!(observation.snapshot().unwrap().timing.is_none());
}

#[tokio::test]
async fn direct_sse_incomplete_event_without_error_message_is_protocol_invalid() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"error\":{\"code\":\"HTTP_429\"}}}\n\n"
            .to_vec(),
    )]));
    let observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let mut governed = wrap_direct_sse_provider_outcome_stream(observed, test_direct_sse_provider_outcome("direct_sse_incomplete_missing_error_message"), runtime_timing, observation.clone());

    let error = governed
        .next()
        .await
        .expect("invalid incomplete event must terminate the stream")
        .expect_err("missing provider error.message must fail explicitly");
    assert_eq!(error.code, "provider_response_sse_event_invalid");
    assert!(
        error.message.contains("non-empty error message"),
        "{}",
        error.message
    );
    assert!(observation.snapshot().unwrap().timing.is_none());
}

#[tokio::test]
async fn direct_sse_incomplete_details_reason_is_a_valid_json_failure() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(stream::iter(vec![Ok(
        b"data: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n".to_vec(),
    )]));
    let stream = wrap_direct_sse_provider_outcome_stream(source, test_direct_sse_provider_outcome("direct_sse_incomplete_details_reason"), runtime_timing, observation);
    let items = stream.collect::<Vec<_>>().await;
    let error = items
        .into_iter()
        .find_map(Result::err)
        .expect("JSON incomplete_details must produce provider failure");
    assert_eq!(error.code, "response_incomplete");
    assert_eq!(error.message, "max_output_tokens");
}

#[tokio::test]
async fn direct_sse_failed_event_accepts_top_level_error_envelope() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.failed\ndata: {\"type\":\"response.failed\",\"error\":{\"code\":\"HTTP_429\",\"message\":\"alternate envelope\"}}\n\n"
            .to_vec(),
    )]));
    let observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let mut governed = wrap_direct_sse_provider_outcome_stream(observed, test_direct_sse_provider_outcome("direct_sse_failed_top_level_error"), runtime_timing, observation.clone());

    let error = governed
        .next()
        .await
        .expect("alternate failure envelope must terminate the stream")
        .expect_err("top-level JSON error must terminate the stream");
    assert_eq!(error.code, "HTTP_429");
    assert!(error.message.contains("alternate envelope"), "{}", error.message);
    assert!(observation.snapshot().unwrap().timing.is_none());
}

#[tokio::test]
async fn direct_sse_json_type_remains_provider_semantic_source() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.completed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"HTTP_429\",\"message\":\"quota exhausted\"}}}\n\n"
            .to_vec(),
    )]));
    let observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let mut governed = wrap_direct_sse_provider_outcome_stream(observed, test_direct_sse_provider_outcome("direct_sse_event_type_mismatch"), runtime_timing, observation.clone());

    let mut error = None;
    while let Some(result) = governed.next().await {
        if let Err(source) = result {
            error = Some(source);
        }
    }
    let error = error.expect("JSON response.failed must remain a provider failure");
    assert_eq!(error.code, "HTTP_429");
    assert!(error.message.contains("quota exhausted"), "{}", error.message);
    assert!(
        observation.snapshot().unwrap().timing.is_none(),
        "mismatched provider terminal semantics must not publish successful timing"
    );
}

#[tokio::test]
async fn red_sse_semantics_must_use_json_type_not_event_name() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.created\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"HTTP_429\",\"message\":\"quota exhausted\"}}}\n\n"
            .to_vec(),
    )]));
    let observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let mut governed = wrap_direct_sse_provider_outcome_stream(observed, test_direct_sse_provider_outcome("red_json_type_authority"), runtime_timing, observation);

    let mut error = None;
    while let Some(result) = governed.next().await {
        if let Err(source) = result {
            error = Some(source);
        }
    }
    let error = error.expect("JSON response.failed must remain a provider failure");
    assert_eq!(
        error.code, "HTTP_429",
        "provider JSON type is authoritative; SSE event label is opaque"
    );
}

#[tokio::test]
async fn red_sse_semantics_ignore_event_name_when_json_is_completed() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: provider-specific-label\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
            .to_vec(),
    )]));
    let observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let mut governed = wrap_direct_sse_provider_outcome_stream(observed, test_direct_sse_provider_outcome("red_json_completed_authority"), runtime_timing, observation);

    let mut results = Vec::new();
    while let Some(result) = governed.next().await {
        results.push(result);
    }
    assert!(
        results.iter().all(Result::is_ok),
        "JSON response.completed must not be rejected because SSE event label differs"
    );
}

#[tokio::test]
async fn direct_sse_failure_after_client_commit_does_not_reselect_current_request() {
    let runtime_timing = V3RuntimeTimingState::start();
    runtime_timing.start_external().unwrap();
    let observation = V3RuntimeStreamObservation::default();
    let source = Box::pin(stream::iter(vec![
        Ok(b"event: provider-label\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"committed\"}\n\n".to_vec()),
        Ok(b"event: provider-label\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"HTTP_429\",\"message\":\"after commit\"}}}\n\n".to_vec()),
    ]));
    let observed = wrap_direct_sse_provider_event_json_observation_stream(source, observation.clone(), runtime_timing.clone(), false, true);
    let mut governed = wrap_direct_sse_provider_outcome_stream(observed, test_direct_sse_provider_outcome("direct_sse_failure_after_commit"), runtime_timing, observation);

    assert!(governed.next().await.expect("committed frame").is_ok());
    let error = governed
        .next()
        .await
        .expect("post-commit failure")
        .expect_err("post-commit provider failure must close current stream");
    assert_eq!(error.code, "HTTP_429");
    assert!(governed.next().await.is_none(), "current stream must not reroute");
}

#[tokio::test]
async fn normal_direct_request_does_not_consume_unrelated_provider_failure_gate() {
    let routing_group = "normal_direct_bypasses_provider_action_gate";
    let manifest = scoped_test_manifest(test_manifest(), routing_group);
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope = test_failure_session_scope(routing_group);
    provider_health
        .record_provider_action_failure_in_scope(
            &failure_session_scope,
            "other-provider",
            Some("key1"),
            Some("other-model"),
            "provider_http_503",
        )
        .expect("seed unrelated provider failure gate");

    let raw = test_responses_raw(
        routing_group,
        "req-normal-bypass-gate",
        "exec",
        json!({"model":"client-model","input":"hello"}),
    );
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let output = tokio::time::timeout(
        Duration::from_millis(V3_PROVIDER_ACTION_ISOLATED_DELAY_MS / 2),
        execute_v3_responses_direct_runtime_kernel_core(
            V3ResponsesDirectRuntimeCoreState::no_continuation()
                .with_provider_health(provider_health.clone())
                .with_initial_plan(&plan),
            &manifest,
            raw,
            crate::register_responses_direct_hooks(),
            &CaptureTransport,
        ),
    )
    .await
    .expect("fresh normal request must not wait on unrelated group failure gate");

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    assert!(
        !output
            .node_trace
            .contains(&"V3ProviderActionGateTerminalReevaluation"),
        "normal request must not re-evaluate terminal provider-action gate"
    );
    assert!(
        !output.node_trace.contains(&"V3ProviderActionGateAdmission"),
        "normal request must not consume provider-action gate admission"
    );

    provider_health
        .record_provider_success_in_failure_scope(
            &failure_session_scope,
            "other-provider",
            Some("key1"),
            Some("other-model"),
            0,
        )
        .expect("cleanup seeded provider failure gate");
}

#[tokio::test]
async fn provider_error_enters_error_chain_not_success() {
    struct ErrorTransport;
    #[async_trait]
    impl ResponsesTransport for ErrorTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            Err(V3ProviderError::Transport {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                reason: "boom".to_string(),
            })
        }
    }
    let routing_group = "provider_error_terminal";
    let manifest = scoped_test_manifest(test_manifest(), routing_group);
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let raw = test_responses_raw(
        routing_group,
        "req",
        "exec",
        json!({"model":"client-model","input":"hello"}),
    );
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &ErrorTransport,
    )
    .await;
    assert_eq!(output.client_payload.status, 502);
    assert_eq!(output.error_chain.unwrap()[0], "V3Error01SourceRaised");
    match output.client_payload.body {
        V3ClientBody::Json(body) => {
            assert!(body["error"]["message"].as_str().unwrap().contains("boom"))
        }
        V3ClientBody::Bytes(_) => panic!("error response must be JSON"),
        V3ClientBody::Sse(_) => panic!("error response must be JSON"),
    }
}

#[tokio::test]
async fn direct_json_response_strips_encrypted_content_for_multi_provider_route() {
    struct CipherTransport;
    #[async_trait]
    impl ResponsesTransport for CipherTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                br#"{"id":"resp_1","status":"completed","output":[{"type":"reasoning","id":"rs_1","encrypted_content":"rsn_MULTI","summary":[{"type":"summary_text","text":"plain"}]}]}"#.to_vec(),
            ))
        }
    }
    // 两个 gpt 候选（多 provider）→ retain=false → 响应密文必须在进客户端前剥离。
    let manifest = multi_candidate_test_manifest();
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let raw = test_responses_raw(
        "default",
        "req-cipher-json",
        "exec",
        json!({"model":"client-model","input":"hello","stream":false}),
    );
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &CipherTransport,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{output:?}");
    match output.client_payload.body {
        V3ClientBody::Json(body) => {
            assert!(
                !body.to_string().contains("rsn_MULTI"),
                "多 provider 场景响应密文必须剥离: {body}"
            );
            assert_eq!(body["output"][0]["summary"][0]["text"], "plain");
        }
        other => panic!("expected JSON body, got {other:?}"),
    }
}

#[tokio::test]
async fn direct_runtime_rejects_routecodex_control_payload_before_provider_send() {
    struct NoSendTransport;
    #[async_trait]
    impl ResponsesTransport for NoSendTransport {
        async fn send(
            &self,
            _request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            panic!("side-channel control payload must fail before provider transport")
        }
    }

    let output = execute_v3_responses_direct_runtime_kernel(
        &test_manifest(),
        V3Server03HttpRequestRaw {
            server_id: "test".to_string(),
            failure_session_scope: test_failure_session_scope("test"),
            request_id: "req-control-leak".to_string(),
            execution_id: "exec".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            body: json!({
                "model":"client-model",
                "input":"hello",
                "metadata": {"client": "kept"},
                "metadataCenter": {"providerKey": "must-not-enter-body"}
            }),
        },
        crate::register_responses_direct_hooks(),
        &NoSendTransport,
    )
    .await;

    assert_eq!(output.client_payload.status, 500);
    assert!(output.node_trace.contains(&"V3Req04StandardizedResponses"));
    assert!(!output
        .node_trace
        .contains(&"V3Provider12ResponsesWirePayload"));
    match output.client_payload.body {
        V3ClientBody::Json(body) => {
            assert!(body["error"]["message"]
                .as_str()
                .expect("error message")
                .contains("metadataCenter"));
        }
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => panic!("error response must be JSON"),
    }
}

#[tokio::test]
async fn direct_runtime_rejects_invalid_current_data_image_before_provider_send() {
    struct NoSendTransport;
    #[async_trait]
    impl ResponsesTransport for NoSendTransport {
        async fn send(
            &self,
            _request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            panic!("invalid current-turn image must fail before provider transport")
        }
    }

    let manifest = test_manifest();
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let raw = test_responses_raw(
        "test",
        "req-invalid-image",
        "exec",
        json!({
            "model":"client-model",
            "input":[{
                "type":"message",
                "role":"user",
                "content":[
                    {"type":"input_text","text":"current turn"},
                    {"type":"input_image","image_url":"data:image/png;base64,AAAA"}
                ]
            }]
        }),
    );
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &NoSendTransport,
    )
    .await;

    assert_eq!(output.client_payload.status, 400);
    assert!(!output
        .node_trace
        .contains(&"V3Transport13ResponsesHttpRequest"));
    match output.client_payload.body {
        V3ClientBody::Json(body) => {
            assert_eq!(body["error"]["code"], "invalid_provider_request_payload");
            assert!(body["error"]["message"]
                .as_str()
                .expect("error message")
                .contains("invalid data:image/png payload"));
        }
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => panic!("error response must be JSON"),
    }
}

#[test]
fn direct_protocol_plan_uses_session_bound_cooldown_before_initial_target() {
    let routing_group = "protocol_plan_session_cooldown";
    let manifest = scoped_test_manifest(reselection_manifest(), routing_group);
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session_a = test_failure_session_scope_for(routing_group, "session-a");
    let session_b = test_failure_session_scope_for(routing_group, "session-b");
    let now = 1_000_000;

    for offset in 0..3 {
        provider_health
            .record_provider_failure_record(
                &session_a,
                "first",
                Some("key"),
                Some("test"),
                Some("controlled protocol plan cooldown"),
                now + offset,
            )
            .expect("session A failure should be recorded");
    }

    let plan_a = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        V3Server03HttpRequestRaw {
            server_id: "test".to_string(),
            failure_session_scope: session_a,
            request_id: "req-plan-session-a".to_string(),
            execution_id: "exec-plan-session-a".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            body: json!({"model":"client-model","input":"hello"}),
        },
        provider_health.clone(),
        now + 10,
    )
    .expect("session A protocol plan should reselect available candidate");
    assert_eq!(plan_a.decision.target.candidate.provider_id, "second");
    assert_eq!(plan_a.decision.target.candidate.auth_alias, "key");
    assert_eq!(plan_a.decision.target.candidate.model_id, "test");
    assert_eq!(plan_a.decision.target.unavailable_candidates.len(), 1);
    assert!(
        plan_a.decision.target.unavailable_candidates[0]
            .starts_with("first:key:test:availability("),
        "{:?}",
        plan_a.decision.target.unavailable_candidates
    );
    assert!(
        plan_a.decision.target.unavailable_candidates[0].contains("session-a"),
        "{:?}",
        plan_a.decision.target.unavailable_candidates
    );

    let plan_b = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        V3Server03HttpRequestRaw {
            server_id: "test".to_string(),
            failure_session_scope: session_b,
            request_id: "req-plan-session-b".to_string(),
            execution_id: "exec-plan-session-b".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            body: json!({"model":"client-model","input":"hello"}),
        },
        provider_health,
        now + 10,
    )
    .expect("session B protocol plan should not inherit session A cooldown");
    assert_eq!(plan_b.decision.target.candidate.provider_id, "first");
    assert!(plan_b.decision.target.unavailable_candidates.is_empty());
}

#[tokio::test]
async fn provider_failure_reselects_without_router_reentry() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    struct FirstFailsSecondSucceeds {
        sends: AtomicUsize,
        realtime_events: Arc<Mutex<Vec<String>>>,
        route_events: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl ResponsesTransport for FirstFailsSecondSucceeds {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            assert!(
                !self.route_events.lock().unwrap().is_empty(),
                "route selection event must be published before provider transport send"
            );
            if self.sends.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(V3ProviderError::HttpStatus {
                    response: Box::new(V3ProviderHttpFailure {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                        status: 400,
                        headers: Vec::new(),
                        body: br#"{"error":{"code":"HTTP_400","message":"first provider rejected request"}}"#.to_vec(),
                        body_read_failure: None,
                    }),
                });
            }
            assert_eq!(
                self.realtime_events.lock().unwrap().as_slice(),
                &["first:key:test".to_string()],
                "provider failure event must be published before the next provider send"
            );
            assert_eq!(request.provider_id(), "second");
            assert_eq!(request.body()["model"], "wire-second");
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                br#"{"id":"resp_second","output_text":"ok"}"#.to_vec(),
            ))
        }
    }

    let realtime_events = Arc::new(Mutex::new(Vec::<String>::new()));
    let route_events = Arc::new(Mutex::new(Vec::<String>::new()));
    let transport = FirstFailsSecondSucceeds {
        sends: AtomicUsize::new(0),
        realtime_events: Arc::clone(&realtime_events),
        route_events: Arc::clone(&route_events),
    };
    let routing_group = "provider_failure_reselection";
    let manifest = scoped_test_manifest(reselection_manifest(), routing_group);
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let raw = test_responses_raw(
        routing_group,
        "req",
        "exec",
        json!({"model":"client-model","input":"hello"}),
    );
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let sink_events = Arc::clone(&realtime_events);
    let route_sink_events = Arc::clone(&route_events);
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan)
            .with_provider_failure_event_sink(Some(Arc::new(move |_observability, event| {
                sink_events.lock().unwrap().push(event.provider_key.clone());
            })))
            .with_route_selection_event_sink(Some(Arc::new(move |observability| {
                route_sink_events
                    .lock()
                    .unwrap()
                    .push(observability.provider_key.clone().unwrap_or_default());
            }))),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    assert_eq!(transport.sends.load(Ordering::SeqCst), 2);
    assert_eq!(route_events.lock().unwrap().len(), 2);
    assert_eq!(realtime_events.lock().unwrap().len(), 1);
    assert_eq!(
        output
            .node_trace
            .iter()
            .filter(|node| **node == "V3Router07OpaqueTargetHitOnce")
            .count(),
        1
    );
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    let observability = output
        .observability
        .as_ref()
        .expect("Responses Direct must expose provider failure observability for V3 console");
    assert_eq!(observability.provider_id.as_deref(), Some("second"));
    assert_eq!(observability.provider_failure_events.len(), 1);
    assert_eq!(observability.provider_failure_events[0].status, 400);
    assert_eq!(
        observability.provider_failure_events[0]
            .external_error_kind
            .as_deref(),
        Some("provider")
    );
    assert_eq!(
        observability.provider_failure_events[0]
            .external_error_code
            .as_deref(),
        Some("HTTP_400")
    );
    assert_eq!(
        observability.provider_failure_events[0].external_error_status,
        Some(400)
    );
    assert_eq!(observability.provider_failure_events[0].internal_code, None);
    assert_eq!(
        observability.provider_failure_events[0]
            .next_provider_key
            .as_deref(),
        Some("second:key:test")
    );
}

#[test]
fn responses_provider_process_chat_forces_hub_relay() {
    let routing_group = "responses_process_chat";
    let manifest = scoped_test_manifest(responses_process_chat_manifest(), routing_group);
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        test_plan_http_request(routing_group, "req-process-chat", "exec-process-chat"),
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("process=chat responses provider should plan");

    assert_eq!(
        plan.decision.mode,
        V3Execution11ProtocolDecisionMode::HubRelay,
        "provider.responses.process=chat is the explicit force-Relay override"
    );
    assert_eq!(plan.decision.target.candidate.provider_id, "grok");
    assert_eq!(plan.decision.target.candidate.provider_type, "responses");
    assert_eq!(
        plan.decision.target.candidate.responses_process.as_deref(),
        Some("chat")
    );
    assert!(!plan.node_trace.contains(&"V3ResponsesDirect11Policy"));
}

#[test]
fn responses_provider_process_direct_keeps_same_protocol_direct() {
    let routing_group = "responses_process_direct";
    let mut manifest = scoped_test_manifest(responses_process_chat_manifest(), routing_group);
    manifest
        .providers
        .get_mut("grok")
        .expect("grok provider")
        .responses
        .as_mut()
        .expect("responses config")
        .process = "direct".to_string();
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        test_plan_http_request(routing_group, "req-process-direct", "exec-process-direct"),
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("process=direct responses provider should plan");

    assert_eq!(
        plan.decision.mode,
        V3Execution11ProtocolDecisionMode::SameProtocolDirect
    );
    assert_eq!(
        plan.decision.target.candidate.responses_process.as_deref(),
        Some("direct")
    );
}

#[test]
fn responses_provider_process_chat_without_relay_fails_fast() {
    let routing_group = "responses_process_chat_direct_only";
    let mut manifest = scoped_test_manifest(responses_process_chat_manifest(), routing_group);
    manifest
        .servers
        .get_mut("test")
        .expect("test server")
        .execution
        .as_mut()
        .expect("test server execution")
        .allowed_modes = vec!["direct".to_string()];
    let error = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        test_plan_http_request(
            routing_group,
            "req-process-chat-direct-only",
            "exec-process-chat-direct-only",
        ),
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect_err("process=chat is an explicit Relay override and must fail if Relay is disabled");

    assert_eq!(
        error.source.code,
        "responses_process_chat_relay_not_allowed"
    );
}

#[tokio::test]
async fn provider_response_decode_failure_reselects_without_router_reentry() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FirstMalformedSecondSucceeds {
        sends: AtomicUsize,
    }

    #[async_trait]
    impl ResponsesTransport for FirstMalformedSecondSucceeds {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            if self.sends.fetch_add(1, Ordering::SeqCst) < 3 {
                assert_eq!(request.provider_id(), "first");
                return Ok(V3ProviderResp14Raw::from_json(
                    request.request_id(),
                    request.provider_id(),
                    200,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"application/json".to_vec(),
                    }],
                    b"{\"id\":\"broken\"".to_vec(),
                ));
            }
            assert_eq!(request.provider_id(), "second");
            assert_eq!(request.body()["model"], "wire-second");
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                br#"{"id":"resp_second","output_text":"ok"}"#.to_vec(),
            ))
        }
    }

    let transport = FirstMalformedSecondSucceeds {
        sends: AtomicUsize::new(0),
    };
    let routing_group = "provider_decode_reselection";
    let manifest = scoped_test_manifest(reselection_manifest(), routing_group);
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let raw = test_responses_raw(
        routing_group,
        "req",
        "exec",
        json!({"model":"client-model","input":"hello"}),
    );
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    assert_eq!(
        transport.sends.load(Ordering::SeqCst),
        4,
        "2xx decode failure must retry same provider 3 times then switch: {output:?}"
    );
    assert_eq!(
        output
            .node_trace
            .iter()
            .filter(|node| **node == "V3Router07OpaqueTargetHitOnce")
            .count(),
        1
    );
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    assert!(output.node_trace.contains(&"V3DirectTransientRetrySame"));
    let observability = output
        .observability
        .as_ref()
        .expect("decode failure switch must be observable");
    assert_eq!(observability.provider_failure_events.len(), 1);
    assert_eq!(
        observability.provider_failure_events[0].health_state, "transient_exhausted",
        "2xx decode failure is transient: must not write provider health"
    );
}

#[tokio::test]
async fn provider_sse_failure_event_reselects_before_client_stream() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FirstSseFailureSecondSucceeds {
        sends: AtomicUsize,
    }

    #[async_trait]
    impl ResponsesTransport for FirstSseFailureSecondSucceeds {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            if self.sends.fetch_add(1, Ordering::SeqCst) < 3 {
                // 前 3 次尝试：同一 provider first 每次都在 HTTP 200 SSE 流内
                // 报失败事件（瞬态流内失败 → health-neutral 同 provider 重试）。
                assert_eq!(
                    request.provider_id(),
                    "first",
                    "attempt {} must hit first",
                    self.sends.load(Ordering::SeqCst)
                );
                return Ok(V3ProviderResp14Raw::from_sse(
                    request.request_id().to_string(),
                    request.provider_id().to_string(),
                    200,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"text/event-stream".to_vec(),
                    }],
                    Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
                        b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"HTTP_429\",\"message\":\"first quota exhausted\"}}}\n\n".to_vec(),
                    )])),
                ));
            }
            assert_eq!(
                request.provider_id(),
                "second",
                "attempt {} must hit second",
                self.sends.load(Ordering::SeqCst)
            );
            assert_eq!(request.body()["model"], "wire-second");
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                br#"{"id":"resp_second","output_text":"ok"}"#.to_vec(),
            ))
        }
    }

    let transport = FirstSseFailureSecondSucceeds {
        sends: AtomicUsize::new(0),
    };
    let routing_group = "provider_sse_failure_reselection";
    let manifest = scoped_test_manifest(reselection_manifest(), routing_group);
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let raw = test_responses_raw(
        routing_group,
        "req",
        "exec",
        json!({"model":"client-model","input":"hello","stream":true}),
    );
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    assert_eq!(
        transport.sends.load(Ordering::SeqCst),
        4,
        "transient SSE failure must retry same provider 3 times then switch: {output:?}"
    );
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    assert!(
        output.node_trace.contains(&"V3DirectTransientRetrySame"),
        "transient failures must retry same provider: {:?}",
        output.node_trace
    );
    let observability = output
        .observability
        .as_ref()
        .expect("provider SSE failure switch must be observable");
    assert_eq!(
        observability.provider_failure_events.len(),
        1,
        "only the 3rd transient failure reports once to the error center: {output:?}"
    );
    assert_eq!(
        observability.provider_failure_events[0].message,
        "first quota exhausted"
    );
    assert_eq!(
        observability.provider_failure_events[0]
            .next_provider_key
            .as_deref(),
        Some("second:key:test")
    );
    assert_eq!(
        observability.provider_failure_events[0].health_state, "transient_exhausted",
        "transient failure must not write provider health (no cooldown)"
    );
    match output.client_payload.body {
        V3ClientBody::Json(value) => assert_eq!(value["id"], "resp_second"),
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => {
            panic!("provider SSE failure must be reselected before client stream starts")
        }
    }
}

#[tokio::test]
async fn direct_sse_deepseek_console_go_compat_follows_compatibility_profile() {
    // 正向：provider_id 不是 opencode-go，但 manifest 声明了
    // responses:deepseek-console-go profile，SSE 帧内 function_call 必须回射为
    // custom_tool_call（客户端声明的 custom 工具形态）。
    struct ProfileSseTransport;

    #[async_trait]
    impl ResponsesTransport for ProfileSseTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            assert_eq!(request.provider_id(), "ds");
            assert_eq!(request.body()["model"], "deepseek-v4-flash");
            Ok(V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"text/event-stream".to_vec(),
                }],
                Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
                    b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_ds_1\",\"status\":\"in_progress\"}}\n\nevent: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"exec_command\",\"arguments\":\"{\\\"input\\\":\\\"ls -la\\\"}\"}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_ds_1\",\"status\":\"completed\"}}\n\n"
                        .to_vec(),
                )])),
            ))
        }
    }

    let routing_group = "direct_sse_profile_compat";
    let manifest = scoped_test_manifest(deepseek_console_go_profile_manifest(), routing_group);
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let raw = test_responses_raw(
        routing_group,
        "req",
        "exec",
        json!({"model":"client-model","input":"hello","stream":true}),
    );
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &ProfileSseTransport,
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    let V3ClientBody::Sse(mut stream) = output.client_payload.body else {
        panic!("expected SSE client body: {:?}", output.client_payload.body);
    };
    let mut text = String::new();
    while let Some(chunk) = stream.next().await {
        text.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
    }
    assert!(
        text.contains("custom_tool_call"),
        "profile compat must rewrite function_call -> custom_tool_call: {text}"
    );
    assert!(!text.contains("\"type\":\"function_call\""), "{text}");
}

#[tokio::test]
async fn matched_optional_failure_uses_captured_default_without_router_reentry() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct OptionalFailsDefaultSucceeds {
        sends: AtomicUsize,
    }

    #[async_trait]
    impl ResponsesTransport for OptionalFailsDefaultSucceeds {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            let attempt = self.sends.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                assert_eq!(request.provider_id(), "optional");
                return Err(V3ProviderError::Transport {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    reason: "optional exhausted".to_string(),
                });
            }
            assert_eq!(request.provider_id(), "default");
            assert_eq!(request.body()["model"], "wire-default");
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                br#"{"id":"resp_default","output_text":"ok"}"#.to_vec(),
            ))
        }
    }

    let transport = OptionalFailsDefaultSucceeds {
        sends: AtomicUsize::new(0),
    };
    let routing_group = "matched_optional_default_reselection";
    let manifest = scoped_test_manifest(optional_default_manifest(), routing_group);
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let raw = test_responses_raw(
        routing_group,
        "req",
        "exec",
        json!({
            "model": "client-model",
            "input": "hello"
        }),
    );
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    assert_eq!(transport.sends.load(Ordering::SeqCst), 2);
    assert_eq!(
        output
            .node_trace
            .iter()
            .filter(|node| **node == "V3Router07OpaqueTargetHitOnce")
            .count(),
        1
    );
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
}

#[tokio::test]
async fn pinned_unavailable_provider_consumes_error05_gate_before_terminal_release() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    struct NoSendTransport {
        sends: AtomicUsize,
    }

    #[async_trait]
    impl ResponsesTransport for NoSendTransport {
        async fn send(
            &self,
            _request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            self.sends.fetch_add(1, Ordering::SeqCst);
            panic!("health-unavailable exact pin must never enter provider transport")
        }
    }

    let mut manifest = test_manifest();
    let gate_routing_group = "pinned_unavailable_provider_terminal_release";
    manifest.servers.get_mut("test").unwrap().routing_group = gate_routing_group.to_string();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let continuation_scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-pinned-unavailable",
        "conversation-pinned-unavailable",
        4444,
        gate_routing_group,
    );
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let transport = NoSendTransport {
        sends: AtomicUsize::new(0),
    };
    let pin = V3RemoteContinuationPin::new("openai", "gpt-test", "key1");
    let capability_revision = capability_revision_for_pin(&manifest, &pin).unwrap();
    continuation_state
        .store
        .lock()
        .unwrap()
        .commit(V3RemoteContinuationCommitInput::locator_only(
            V3RemoteContinuationLocator::new_direct(
                "resp_pinned_unavailable",
                continuation_scope.key.clone(),
                pin,
                capability_revision,
                1_000,
                60_000,
            ),
        ))
        .unwrap();
    assert_eq!(continuation_state.len().unwrap(), 1);

    for failure_at in 2_000..2_003 {
        provider_health
            .record_provider_failure_record(
                &V3ProviderFailureSessionScope::new(
                    "test",
                    gate_routing_group,
                    "session-pinned-unavailable",
                )
                .expect("test failure session scope"),
                "openai",
                Some("key1"),
                Some("gpt-test"),
                Some("controlled health failure"),
                failure_at,
            )
            .unwrap();
    }
    let started = Instant::now();
    let terminal = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::with_continuation(
            &continuation_state,
            continuation_scope,
            2_001,
        )
        .with_provider_health(provider_health),
        &manifest,
        V3Server03HttpRequestRaw {
            server_id: "test".to_string(),
            failure_session_scope: test_failure_session_scope("test"),
            request_id: "req-pinned-unavailable-retry".to_string(),
            execution_id: "exec-pinned-unavailable-retry".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            body: json!({
                "model":"client-model",
                "previous_response_id":"resp_pinned_unavailable",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_pinned_unavailable",
                    "output":"ok"
                }]
            }),
        },
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(transport.sends.load(Ordering::SeqCst), 0);
    assert_eq!(
        terminal.error_chain.as_deref(),
        Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
    );
    assert!(
        started.elapsed() >= Duration::from_millis(6_000),
        "pinned health-unavailable path bypassed isolated 1s plus sustained 5s gates"
    );
    assert_eq!(
        continuation_state.len().unwrap(),
        0,
        "typed terminal Error05 must release only the matching continuation locator"
    );
    assert!(!terminal
        .node_trace
        .contains(&"V3Router07OpaqueTargetHitOnce"));
}

/// direct 模式 Mode B websearch 全链：Req04 激活（web_search 声明本地化为
/// websearch）、Resp03 拦截剥离、异步搜索 hop（backend direct pin）、
/// hosted web_search_call + 原 call_id 配对投影、状态机 SearchResultCaptured。
struct WebSearchHopTransport;
#[async_trait]
impl ResponsesTransport for WebSearchHopTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let body = request.body();
        if body.get("model").and_then(serde_json::Value::as_str) == Some("gpt-search") {
            // 搜索 hop 响应：Responses 格式 message + output_text。
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                br#"{"id":"resp_search","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"search result for routecodex"}]}]}"#
                    .to_vec(),
            ))
        } else {
            // 主模型响应：本地 websearch function_call（Mode B 需拦截）。
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                br#"{"id":"resp_main","output":[{"type":"function_call","name":"websearch","call_id":"call_ws_1","arguments":"{\"query\":\"routecodex\"}"}]}"#
                    .to_vec(),
            ))
        }
    }
}

fn direct_web_search_mode_b_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.openai]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_TEST_KEY" }] }

[providers.openai.models.gpt-test]
supports_streaming = true
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "openai.gpt-search"
capabilities = ["text", "web_search"]

[providers.openai.models.gpt-search]
supports_streaming = true
capabilities = ["text"]

[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "openai", model = "gpt-test", priority = 1 }]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "forwarder", id = "responses", priority = 1 },
  { kind = "provider_model", provider = "openai", model = "gpt-search", priority = 2 },
]
"#,
    )
    .unwrap();
    compile_v3_config_05_manifest(authoring).unwrap()
}

#[tokio::test]
async fn direct_mode_b_websearch_intercepts_hosts_search_and_pairs() {
    let manifest = direct_web_search_mode_b_manifest();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    let continuation_scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-ws-direct",
        "conversation-ws-direct",
        4444,
        "default",
    );
    let raw = test_responses_raw(
        "default",
        "req-ws-direct",
        "exec-ws-direct",
        json!({
            "model": "client-model",
            "input": "search routecodex",
            "tools": [{"type": "web_search"}]
        }),
    );
    let output = execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        &continuation_state,
        &stopless_control,
        &manifest,
        raw,
        continuation_scope.clone(),
        crate::register_responses_direct_hooks(),
        &WebSearchHopTransport,
        1_000,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{output:?}");
    let value = match output.client_payload.body {
        V3ClientBody::Json(value) => value,
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => {
            panic!("direct JSON response must remain JSON")
        }
    };
    let output_arr = value["output"].as_array().expect("output array");
    // 拦截剥离：客户端看不到本地 websearch function_call。
    assert!(!output_arr.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("function_call")
            && item.get("name").and_then(Value::as_str) == Some("websearch")
    }));
    // hosted web_search_call 等价结果（Codex 契约）。
    let call = output_arr
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("web_search_call"))
        .expect("hosted web_search_call projected");
    assert_eq!(call["status"], "completed");
    assert_eq!(call["action"]["type"], "search");
    assert_eq!(call["action"]["query"], "routecodex");
    assert_eq!(call["results"][0]["text"], "search result for routecodex");
    // 原 call_id 配对 function_call_output。
    let paired = output_arr
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("function_call_output"))
        .expect("paired function_call_output");
    assert_eq!(paired["call_id"], "call_ws_1");
    assert_eq!(paired["output"], "search result for routecodex");
    // ServerToolCenter websearch 桶状态：SearchResultCaptured。
    let scope = V3ResponsesDirectStoplessControlScope::from(&continuation_scope);
    let state = stopless_control
        .web_search_load_for_scope(&scope)
        .expect("center load")
        .expect("websearch state present");
    assert_eq!(
        state.phase(),
        crate::hub_v1::V3WebSearchCenterPhase::SearchResultCaptured
    );
    assert_eq!(state.query(), Some("routecodex"));
    assert_eq!(state.original_call_id(), Some("call_ws_1"));
}

mod direct_websearch_mode_b;
