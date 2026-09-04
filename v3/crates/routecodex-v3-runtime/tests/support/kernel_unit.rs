use super::*;
use async_trait::async_trait;
use routecodex_v3_config::*;
use routecodex_v3_provider_responses::{
    V3ProviderError, V3ProviderFailureCooldownScope, V3ProviderFailurePolicy,
    V3ProviderHttpFailure, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use serde_json::json;
use std::time::Duration;

use crate::V3_PROVIDER_ACTION_ISOLATED_DELAY_MS;

#[path = "../../src/kernel/tests/exact_pin.rs"]
mod exact_pin;
#[path = "../../src/kernel/tests/fixtures.rs"]
mod fixtures;
#[path = "../../src/kernel/tests/preplanned_target_revalidation.rs"]
mod preplanned_target_revalidation;
#[path = "../../src/kernel/tests/protocol_mode_lock.rs"]
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
        .with_transport_handoff_scope(format!("test-pipeline:{session_id}"), 7777, 1)
        .expect("test provider transport handoff scope")
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

struct ToolreasonCaptureTransport;

#[async_trait]
impl ResponsesTransport for ToolreasonCaptureTransport {
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
            serde_json::to_vec(&json!({
                "id": "resp_toolreason",
                "status": "completed",
                "output": [{
                    "type": "function_call",
                    "call_id": "call_pwd",
                    "name": "pwd",
                    "arguments": "{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\"}"
                }]
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn direct_response_hook_uses_server_toolreason_override_when_global_is_disabled() {
    let mut manifest = test_manifest();
    manifest
        .servers
        .get_mut("test")
        .expect("test server")
        .features
        .extend([
            ("tool_thinking".to_string(), true),
            ("toolreason_client_projection".to_string(), true),
        ]);
    assert_eq!(manifest.features.get("tool_thinking"), Some(&false));
    let raw = test_responses_raw(
        "test",
        "req-toolreason-override",
        "exec-toolreason-override",
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
        &ToolreasonCaptureTransport,
    )
    .await;
    let V3ClientBody::Json(body) = output.client_payload.body else {
        panic!("direct JSON response must remain JSON: {output:?}");
    };
    assert_eq!(body["output"][0]["type"], "reasoning");
    assert_eq!(
        body["output"][0]["summary"][0],
        json!({"type":"summary_text","text":"调用工具 pwd：确认当前工作目录"})
    );
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
        .and_then(|o| o.timing)
        .expect("Direct JSON success must publish Runtime timing");
    assert_eq!(
        timing.internal.checked_add(timing.external),
        Some(timing.runtime_total)
    );
    match output.client_payload.body {
        V3ClientBody::Json(value) => {
            assert_eq!(value, json!({"id":"resp_test","output_text":"ok"}));
        }
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) | V3ClientBody::CommittedSse(_) => {
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
        request_purpose: V3RequestPurpose::Conversation,
        port: Some(7777),
        pipeline_id: Some(format!("test-pipeline:{request_id}")),
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
        request_purpose: V3RequestPurpose::Conversation,
        port: Some(7777),
        pipeline_id: Some(format!("test-pipeline:{request_id}")),
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

#[tokio::test]
async fn direct_sse_strip_client_response_id_empties_nested_response_id() {
    let observation = V3RuntimeStreamObservation::default();
    let runtime_timing = V3RuntimeTimingState::start();
    let source = Box::pin(stream::iter(vec![Ok(
        b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"status\":\"in_progress\"}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\"}}\n\n"
            .to_vec(),
    )]));
    let mut observed = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        observation.clone(),
        runtime_timing.clone(),
        true,
        true,
        V3HubProviderWireProtocol::Responses,
    );
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
    let mut observed = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        observation.clone(),
        runtime_timing.clone(),
        false,
        false,
        V3HubProviderWireProtocol::Responses,
    );
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
    let mut observed = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        observation.clone(),
        runtime_timing.clone(),
        false,
        false,
        V3HubProviderWireProtocol::Responses,
    );
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
    let mut observed = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        observation.clone(),
        runtime_timing.clone(),
        false,
        true,
        V3HubProviderWireProtocol::Responses,
    );
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
    let mut observed = wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        observation.clone(),
        runtime_timing.clone(),
        false,
        true,
        V3HubProviderWireProtocol::Responses,
    );
    let first = observed.next().await.unwrap().unwrap();
    assert_eq!(
        first.as_ref(),
        raw.as_slice(),
        "retain=false 且帧无密文时必须逐字节透传（direct SSE 字节保真）"
    );
}

pub(super) async fn run_normal_direct_request_does_not_consume_unrelated_provider_failure_gate() {
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
            &V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
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
            assert_eq!(body["error"]["message"], "provider_transport_error")
        }
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => panic!("error response must be JSON"),
        V3ClientBody::CommittedSse(_) => panic!("error response must be JSON"),
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
            request_purpose: V3RequestPurpose::Conversation,
            port: None,
            pipeline_id: None,
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

    assert_eq!(output.client_payload.status, 599);
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
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) | V3ClientBody::CommittedSse(_) => {
            panic!("error response must be JSON")
        }
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
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) | V3ClientBody::CommittedSse(_) => {
            panic!("error response must be JSON")
        }
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
            .store()
            .record_provider_failure_in_session_with_policy(
                &session_a,
                "first",
                Some("key"),
                Some("test"),
                Some("controlled protocol plan cooldown"),
                now + offset,
                Some(V3ProviderFailurePolicy {
                    failure_threshold: 3,
                    cooldown_ms: 900_000,
                    probe_interval_ms: 900_000,
                    until_restart: false,
                    cooldown_scope: V3ProviderFailureCooldownScope::Session,
                }),
            )
            .expect("session A failure should be recorded");
    }
    let plan_a = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        V3Server03HttpRequestRaw {
            request_purpose: V3RequestPurpose::Conversation,
            port: None,
            pipeline_id: None,
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
            request_purpose: V3RequestPurpose::Conversation,
            port: None,
            pipeline_id: None,
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
    .expect("session B protocol plan should preserve session isolation from session A");
    assert_eq!(plan_b.decision.target.candidate.provider_id, "first");
    assert_eq!(plan_b.decision.target.unavailable_candidates.len(), 0);
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
    assert_eq!(
        observability.provider_failure_events.len(),
        3,
        "each transient decode retry remains observable while provider errors stay off the client stream"
    );
    assert_eq!(
        observability.provider_failure_events[0].health_state, "transient_exhausted",
        "2xx decode failure is transient: must not write provider health"
    );
}

#[tokio::test]
async fn direct_sse_precommit_failures_reselect_before_client_stream() {
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
            let attempt = self.sends.fetch_add(1, Ordering::SeqCst);
            if attempt < 3 {
                // 前 3 次尝试覆盖显式 failure、empty completed.output=[]、
                // empty completed.output 缺失；都必须在 Resp15 前进入 Error01，
                // 由既有瞬态策略同 provider 重试并最终 reselect。
                assert_eq!(
                    request.provider_id(),
                    "first",
                    "attempt {} must hit first",
                    self.sends.load(Ordering::SeqCst)
                );
                let frames = match attempt {
                    0 => vec![
                        Ok::<Vec<u8>, V3ProviderError>(
                            b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"status\":\"in_progress\",\"content\":[]}}\n\n".to_vec(),
                        ),
                        Ok::<Vec<u8>, V3ProviderError>(
                            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"HTTP_429\",\"message\":\"first quota exhausted\"}}}\n\n".to_vec(),
                        ),
                    ],
                    1 => vec![Ok::<Vec<u8>, V3ProviderError>(
                        b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_empty_array\",\"output\":[]}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_empty_array\",\"status\":\"completed\",\"output\":[]}}\n\n".to_vec(),
                    )],
                    2 => vec![Ok::<Vec<u8>, V3ProviderError>(
                        b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_empty_absent\",\"output\":[]}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_empty_absent\",\"status\":\"completed\"}}\n\n".to_vec(),
                    )],
                    _ => unreachable!("attempt is bounded above"),
                };
                return Ok(V3ProviderResp14Raw::from_sse(
                    request.request_id().to_string(),
                    request.provider_id().to_string(),
                    200,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"text/event-stream".to_vec(),
                    }],
                    Box::pin(stream::iter(frames)),
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
    assert_eq!(
        plan.decision.target.candidate.provider_id, "first",
        "the immutable preplanned Target10 must begin with the priority-1 candidate"
    );
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
        "precommit SSE failures must retry same provider 3 times then switch: {output:?}"
    );
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    assert!(
        output.node_trace.contains(&"V3DirectTransientRetrySame"),
        "precommit failures must retry same provider: {:?}",
        output.node_trace
    );
    let observability = output
        .observability
        .as_ref()
        .expect("provider SSE precommit failure switch must be observable");
    assert_eq!(
        observability.provider_failure_events.len(),
        3,
        "each transient SSE retry is observable while no provider error reaches the client stream: {output:?}"
    );
    assert_eq!(
        observability.provider_failure_events[0]
            .error_type
            .as_deref(),
        Some("HTTP_429"),
        "the first malformed terminal is observable before transient retries"
    );
    let final_event = observability
        .provider_failure_events
        .last()
        .expect("the reselect event must be present");
    assert_eq!(
        final_event.error_type.as_deref(),
        Some("provider_response_sse_empty")
    );
    assert_eq!(
        final_event.message,
        "provider SSE completed before content or tool output"
    );
    assert_eq!(
        final_event.next_provider_key.as_deref(),
        Some("second:key:test")
    );
    assert_eq!(
        final_event.health_state, "transient_exhausted",
        "transient failure must not write provider health (no cooldown)"
    );
    match output.client_payload.body {
        V3ClientBody::Json(value) => assert_eq!(value["id"], "resp_second"),
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) | V3ClientBody::CommittedSse(_) => {
            panic!("provider SSE failure must be reselected before client stream starts")
        }
    }
}

#[tokio::test]
async fn direct_sse_full_attempt_commit_reselects_after_partial_network_failure() {
    use futures_util::StreamExt;

    let source: V3ClientSseStream = Box::pin(stream::iter([
        Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"status\":\"in_progress\",\"content\":[]}}\n\n".to_vec()),
        Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_stream",
            "network failure after partial provider output",
        )),
    ]));
    let error = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(source, V3HubProviderWireProtocol::Responses),
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect_err("resident owner must receive the partial attempt failure");
    assert_eq!(error.code, "provider_response_sse_stream");
    let replacement: V3ClientSseStream = Box::pin(stream::iter([Ok(
        b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"recovered\",\"status\":\"in_progress\",\"output\":[]}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"recovered\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"recovered\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n\n".to_vec(),
    )]));
    let frames = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(replacement, V3HubProviderWireProtocol::Responses),
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("resident owner must seal the replacement attempt")
    .collect::<Vec<_>>()
    .await;
    let text = String::from_utf8(
        frames
            .into_iter()
            .flatten()
            .collect(),
    )
    .unwrap();
    assert!(text.contains("recovered"));
    assert!(!text.contains("failed-partial"));
}

#[tokio::test]
async fn execution_control_payload_architecture_real_tcp_sse_reselection_stays_on_resident_runtime() {
    use futures_util::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    std::env::set_var("TCP_FIRST_KEY", "first-secret");
    std::env::set_var("TCP_SECOND_KEY", "second-secret");
    let first_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind first TCP provider");
    let first_address = first_listener
        .local_addr()
        .expect("first TCP provider address");
    let second_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind second TCP provider");
    let second_address = second_listener
        .local_addr()
        .expect("second TCP provider address");

    let first_server = tokio::spawn(async move {
        for _ in 0..3 {
            let (mut socket, _) = first_listener.accept().await.expect("first provider accept");
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request).await.expect("first provider request");
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
                )
                .await
                .expect("first provider headers");
            socket
                .write_all(b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"provider-a-must-not-commit\"}\n\n")
                .await
                .expect("first provider partial frame");
            socket.shutdown().await.expect("first provider disconnect");
        }
    });
    let second_server = tokio::spawn(async move {
        let (mut socket, _) = second_listener
            .accept()
            .await
            .expect("second provider accept");
        let mut request = [0_u8; 4096];
        let _ = socket.read(&mut request).await.expect("second provider request");
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
            )
            .await
            .expect("second provider headers");
        socket
            .write_all(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"provider-b\",\"status\":\"in_progress\",\"output\":[]}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"provider-b-only\"}\n\n")
            .await
            .expect("second provider first frames");
        tokio::time::sleep(Duration::from_millis(25)).await;
        socket
            .write_all(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"provider-b\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"provider-b-only\"}]}}\n\n")
            .await
            .expect("second provider terminal frame");
        socket.shutdown().await.expect("second provider shutdown");
    });

    let authoring = parse_v3_config_02_authoring(&format!(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "tcp_lifecycle"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = {{ allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }}
attempt_store = {{ request_max_attempts = 8, attempt_max_bytes = 67108864, attempt_max_frames = 262144, request_max_bytes = 67108864, process_max_bytes = 536870912, residence_timeout_ms = 600000 }}

[providers.tcp_first]
type = "responses"
base_url = "http://{first_address}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "TCP_FIRST_KEY" }}] }}
[providers.tcp_first.models.test]
wire_name = "wire-first"
[providers.tcp_first.health]
enabled = true
failure_threshold = 3
cooldown_ms = 900000

[providers.tcp_second]
type = "responses"
base_url = "http://{second_address}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "TCP_SECOND_KEY" }}] }}
[providers.tcp_second.models.test]
wire_name = "wire-second"
[providers.tcp_second.health]
enabled = true
failure_threshold = 3
cooldown_ms = 900000

[forwarders.tcp]
model = "client-model"
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "tcp_first", model = "test", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "tcp_second", model = "test", key = "key", priority = 1 }}
]

[route_groups.tcp_lifecycle.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "tcp", priority = 1 }}]
"#
    ))
    .expect("real TCP SSE authoring config");
    let manifest = compile_v3_config_05_manifest(authoring).expect("real TCP SSE manifest");
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let raw = test_responses_raw(
        "tcp_lifecycle",
        "req-real-tcp-sse",
        "exec-real-tcp-sse",
        json!({"model":"client-model","input":"hello","stream":true}),
    );
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let request_execution_control =
        V3RequestExecutionControl::from_manifest(&manifest, "test").expect("request control");
    let attempt_budget = request_execution_control.attempt_budget();
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan)
            .with_request_execution_control(Some(request_execution_control)),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &ReqwestResponsesTransport::default(),
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    assert_eq!(attempt_budget.transport_attempts(), 4);
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    let V3ClientBody::CommittedSse(stream) = output.client_payload.body else {
        panic!("replacement TCP stream must be atomically committed")
    };
    let committed = stream.collect::<Vec<_>>().await;
    let text = String::from_utf8(committed.into_iter().flatten().collect()).unwrap();
    assert!(text.contains("provider-b-only"));
    assert!(!text.contains("provider-a-must-not-commit"));
    first_server.await.expect("first provider task");
    second_server.await.expect("second provider task");
}

#[tokio::test]
async fn direct_sse_full_attempt_commit_rejects_eof_without_terminal() {
    use futures_util::StreamExt;

    let source: V3ClientSseStream = Box::pin(stream::iter([Ok(
        b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"status\":\"in_progress\",\"content\":[]}}\n\n".to_vec(),
    )]));
    let error = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(source, V3HubProviderWireProtocol::Responses),
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect_err("EOF without terminal must be an error");
    assert_eq!(error.code, "provider_response_sse_stream");
}

#[tokio::test]
async fn direct_sse_full_attempt_commit_does_not_mix_failed_attempt_bytes() {
    use futures_util::StreamExt;

    let source: V3ClientSseStream = Box::pin(stream::iter([
        Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"status\":\"in_progress\",\"content\":[]}}\n\n".to_vec()),
        Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_stream",
            "provider A disconnected",
        )),
    ]));
    let error = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(source, V3HubProviderWireProtocol::Responses),
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect_err("provider A must fail before any bytes are committed");
    assert_eq!(error.code, "provider_response_sse_stream");
    let replacement: V3ClientSseStream = Box::pin(stream::iter([Ok(
        b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"provider-b\",\"status\":\"in_progress\",\"output\":[]}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"provider-b-only\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"provider-b\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n\n".to_vec(),
    )]));
    let committed = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(replacement, V3HubProviderWireProtocol::Responses),
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("provider B must complete");
    let text = String::from_utf8(
        committed
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .flatten()
            .collect(),
    )
    .unwrap();
    assert!(text.contains("provider-b-only"));
    assert!(!text.contains("provider-a-only"));
}

#[tokio::test]
async fn direct_sse_full_attempt_commit_ignores_late_error_after_terminal() {
    use futures_util::StreamExt;

    let source: V3ClientSseStream = Box::pin(stream::iter([
        Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"completed\",\"status\":\"in_progress\",\"output\":[]}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"completed\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n\n".to_vec()),
        Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_stream",
            "late provider close error",
        )),
    ]));
    let frames = collect_direct_sse_attempt_after_terminal(
        test_direct_sse_attempt_stream(source, V3HubProviderWireProtocol::Responses),
        V3HubProviderWireProtocol::Responses,
        crate::nodes::V3AttemptBudget::process_default(),
    )
    .await
    .expect("terminal stream must seal")
    .collect::<Vec<_>>()
    .await;
    assert_eq!(frames.len(), 1);
    let text = String::from_utf8(frames.into_iter().next().unwrap()).unwrap();
    assert!(text.contains("response.completed"));
}

#[tokio::test]
async fn direct_sse_no_continuation_stream_error_is_not_silent_eof() {
    struct FailedSseTransport;

    #[async_trait]
    impl ResponsesTransport for FailedSseTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            Ok(V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"text/event-stream".to_vec(),
                }],
                Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
                    b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"
                        .to_vec(),
                )])),
            ))
        }
    }

    let routing_group = "direct_sse_no_continuation_error";
    let manifest = scoped_test_manifest(test_manifest(), routing_group);
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
        &FailedSseTransport,
    )
    .await;

    assert_eq!(
        output.client_payload.status, 502,
        "pre-terminal EOF must finish Error01-06 before any client body is committed: {output:?}"
    );
    let V3ClientBody::Json(body) = output.client_payload.body else {
        panic!("exhausted pre-terminal SSE failure must be a typed terminal error: {output:?}");
    };
    assert_eq!(body["error"]["code"], "provider_response_sse_stream");
    assert!(
        !body.to_string().contains("partial"),
        "failed attempt bytes must never enter the terminal client payload: {body}"
    );
    assert_eq!(
        output.error_chain.as_deref(),
        Some(V3_ERROR_CHAIN_NODE_IDS.as_slice()),
        "the resident controller must consume the complete Error01-06 chain"
    );
    assert!(output.stream_observation.is_none());
    assert_eq!(
        output
            .observability
            .as_ref()
            .and_then(|observability| observability.attempts),
        Some(3),
        "one request-level lifecycle must retain all same-provider attempts"
    );
}

#[tokio::test]
async fn responses_direct_debug_entrypoint_retries_post_frame_failure_before_front_commit() {
    use futures_util::StreamExt;
    use std::sync::{Arc, Mutex};

    struct PostCommitResponsesTransport {
        calls: Arc<Mutex<usize>>,
    }

    #[async_trait]
    impl ResponsesTransport for PostCommitResponsesTransport {
        fn handoff_handle(&self) -> Option<Arc<dyn ResponsesTransport>> {
            Some(Arc::new(Self {
                calls: self.calls.clone(),
            }))
        }

        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            if *calls == 1 {
                return Ok(V3ProviderResp14Raw::from_sse(
                    request.request_id().to_string(),
                    request.provider_id().to_string(),
                    200,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"text/event-stream".to_vec(),
                    }],
                    Box::pin(stream::iter([
                        Ok::<Vec<u8>, V3ProviderError>(
                            b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_first\",\"status\":\"in_progress\"}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec(),
                        ),
                        Ok::<Vec<u8>, V3ProviderError>(
                            b"event: response.in_progress\ndata: {\"type\":\"response.in_progress\"}\n\n".to_vec(),
                        ),
                        Err(V3ProviderError::ResponseBody {
                            request_id: request.request_id().to_string(),
                            provider_id: request.provider_id().to_string(),
                            reason: "post-first-frame failure".to_string(),
                        }),
                    ])),
                ));
            }
            Ok(V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"text/event-stream".to_vec(),
                }],
                Box::pin(stream::iter([Ok::<Vec<u8>, V3ProviderError>(
                    b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_recovered\",\"status\":\"in_progress\",\"output\":[]}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"recovered\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_recovered\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n\n".to_vec(),
                )])),
            ))
        }
    }

    let routing_group = "responses_direct_debug_handoff";
    let manifest = scoped_test_manifest(reselection_manifest(), routing_group);
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let raw = test_responses_raw(
        routing_group,
        "req-responses-direct-debug-handoff",
        "exec",
        json!({"model":"client-model","input":"hello","stream":true}),
    );
    let plan = test_protocol_plan(&manifest, raw.clone(), provider_health.clone(), 0);
    let debug = V3DebugRuntime::new(Default::default()).unwrap();
    let calls = Arc::new(Mutex::new(0));
    let output = execute_v3_responses_direct_runtime_kernel_with_transport_debug_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &PostCommitResponsesTransport { calls: calls.clone() },
        &debug,
    )
    .await;

    let V3ClientBody::CommittedSse(mut stream) = output.client_payload.body else {
        panic!("expected committed direct SSE client body: {output:?}");
    };
    let mut bytes = Vec::new();
    while let Some(frame) = stream.next().await {
        bytes.extend_from_slice(&frame);
    }
    let text = String::from_utf8(bytes).expect("committed client frames must be UTF-8");
    assert!(text.contains("recovered"), "{text}");
    assert!(!text.contains("partial"), "failed-attempt bytes leaked: {text}");
    assert!(!text.contains("post-first-frame failure"), "{text}");
    assert_eq!(
        *calls.lock().unwrap(),
        2,
        "post-frame failure must be retried entirely inside the Broker"
    );
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
            request_purpose: V3RequestPurpose::Conversation,
            port: None,
            pipeline_id: None,
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
        started.elapsed() >= Duration::from_millis(2_000),
        "pinned health-unavailable path bypassed the configured isolated and sustained gates"
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
        V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) | V3ClientBody::CommittedSse(_) => {
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

#[path = "../../src/kernel/tests/direct_websearch_mode_b.rs"]
mod direct_websearch_mode_b;
