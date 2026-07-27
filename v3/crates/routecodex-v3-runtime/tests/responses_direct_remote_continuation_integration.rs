use async_trait::async_trait;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS;
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw,
    execute_v3_responses_direct_runtime_kernel_with_continuation,
    execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control,
    register_responses_direct_hooks, V3ClientBody, V3ResponsesDirectContinuationScope,
    V3ResponsesDirectContinuationState, V3ResponsesDirectStoplessControlScope,
    V3ResponsesDirectStoplessControlState, V3RuntimeUsageSummary, V3StoplessCenterState,
    V3StoplessCenterSteering,
};
use serde_json::{json, Value};
use std::sync::Mutex;

#[derive(Default)]
struct TwoTurnTransport {
    requests: Mutex<Vec<Value>>,
}

#[async_trait]
impl ResponsesTransport for TwoTurnTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.body().clone());
        let body = if requests.len() == 1 {
            json!({
                "id":"resp_remote_1",
                "status":"requires_action",
                "output":[{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{}"}]
            })
        } else {
            json!({
                "id":"resp_remote_2",
                "status":"completed",
                "output":[{"type":"output_text","text":"done"}]
            })
        };
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&body).unwrap(),
        ))
    }
}

#[tokio::test]
async fn direct_json_completed_without_summary_passes_through_without_synthetic_stopless_continuation(
) {
    let manifest = manifest();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = DirectStoplessNoSummaryThenSummaryTransport::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-stopless-direct",
        "conversation-stopless-direct",
        5555,
        "g",
    );

    let first = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(),
            "req-direct-stopless-1".into(),
            "exec-direct-stopless-1".into(),
            "POST".into(),
            "/v1/responses".into(),
            json!({"model":"gpt-5.5","input":"continue until summary","tools":[{"type":"function","name":"exec_command"}]}),
        ),
        scope,
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 200, "{:#?}", first);
    assert_eq!(
        state.len().unwrap(),
        0,
        "direct completed response must not commit a synthetic remote continuation locator"
    );
    let V3ClientBody::Json(first_body) = &first.client_payload.body else {
        panic!("first direct response must be JSON: {first:#?}");
    };
    assert_eq!(first_body["status"], "completed", "{first_body}");
    let first_serialized = serde_json::to_string(first_body).unwrap();
    assert!(first_serialized.contains("partial direct answer without summary"));
    assert!(!first_serialized.contains("call_stopless_reasoning"));
    assert!(!first_serialized.contains("routecodex hook run reasoningStop"));

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let provider_request = serde_json::to_string(&requests[0]).unwrap();
    assert!(!provider_request.contains("call_stopless_reasoning"));
    assert!(!provider_request.contains("routecodex hook run reasoningStop"));
}

#[tokio::test]
async fn direct_server_stopless_false_disables_direct_stopless_even_when_direct_flag_true() {
    let manifest = manifest_with_direct_stopless_server_stopless_disabled();
    let state = V3ResponsesDirectContinuationState::default();
    let stopless = V3ResponsesDirectStoplessControlState::default();
    let transport = DirectStoplessNoSummaryThenSummaryTransport::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-stopless-direct-server-disabled",
        "conversation-stopless-direct-server-disabled",
        5555,
        "g",
    );

    let first = execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        &state,
        &stopless,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(),
            "req-direct-stopless-server-disabled".into(),
            "exec-direct-stopless-server-disabled".into(),
            "POST".into(),
            "/v1/responses".into(),
            json!({"model":"gpt-5.5","input":"server stopless disabled","tools":[{"type":"function","name":"exec_command"}]}),
        ),
        scope,
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 200, "{first:#?}");
    assert!(
        !first
            .node_trace
            .iter()
            .any(|node| node.contains("V3DirectStopless")),
        "server stopless false must disable all Direct stopless nodes: {:?}",
        first.node_trace
    );
    assert_eq!(stopless.len().unwrap(), 0);
    let V3ClientBody::Json(first_body) = &first.client_payload.body else {
        panic!("server-disabled direct response must be JSON: {first:#?}");
    };
    let first_serialized = serde_json::to_string(first_body).unwrap();
    assert!(!first_serialized.contains("call_stopless_reasoning"));
    assert!(!first_serialized.contains("routecodex hook run reasoningStop"));

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let provider_request = serde_json::to_string(&requests[0]).unwrap();
    assert!(!provider_request.contains("reasoningStop"));
    assert!(!provider_request.contains("call_stopless_reasoning"));
    assert!(!provider_request.contains("routecodex hook run reasoningStop"));
}

#[tokio::test]
async fn direct_sse_completed_without_summary_passes_through_without_synthetic_stopless_continuation(
) {
    let manifest = manifest();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = DirectStoplessSseNoSummaryThenSummaryTransport::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-stopless-direct-sse",
        "conversation-stopless-direct-sse",
        5555,
        "g",
    );

    let first = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(),
            "req-direct-stopless-sse-1".into(),
            "exec-direct-stopless-sse-1".into(),
            "POST".into(),
            "/v1/responses".into(),
            json!({"model":"gpt-5.5","stream":true,"input":"stream until summary","tools":[{"type":"function","name":"exec_command"}]}),
        ),
        scope,
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 200, "{:#?}", first);
    assert!(matches!(&first.client_payload.body, V3ClientBody::Sse(_)));
    assert_eq!(
        state.len().unwrap(),
        0,
        "direct completed SSE must not commit a synthetic remote continuation locator"
    );
    let first_body = collect_sse_body_text(first.client_payload.body).await;
    assert!(first_body.contains("response.completed"), "{first_body}");
    assert!(first_body.contains("response.done"), "{first_body}");
    assert!(first_body.contains("data: [DONE]"), "{first_body}");
    assert!(
        first_body.contains("\"status\":\"completed\""),
        "{first_body}"
    );
    assert!(first_body.contains("partial direct SSE answer without summary"));
    assert!(!first_body.contains("call_stopless_reasoning"));
    assert!(!first_body.contains("routecodex hook run reasoningStop"));

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let provider_request = serde_json::to_string(&requests[0]).unwrap();
    assert!(!provider_request.contains("call_stopless_reasoning"));
    assert!(!provider_request.contains("routecodex hook run reasoningStop"));
}

#[tokio::test]
async fn direct_json_stopless_metadata_center_projects_noop_and_continues_on_remote_direct_locator()
{
    let manifest = manifest_with_direct_stopless();
    let state = V3ResponsesDirectContinuationState::default();
    let stopless = V3ResponsesDirectStoplessControlState::default();
    let transport = DirectStoplessNoSummaryThenSummaryTransport::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-stopless-direct-active",
        "conversation-stopless-direct-active",
        5555,
        "g",
    );

    let first = execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        &state,
        &stopless,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(),
            "req-direct-stopless-active-1".into(),
            "exec-direct-stopless-active-1".into(),
            "POST".into(),
            "/v1/responses".into(),
            json!({"model":"gpt-5.5","input":"continue until summary","tools":[{"type":"function","name":"exec_command"}]}),
        ),
        scope.clone(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 200, "{first:#?}");
    assert!(first
        .node_trace
        .contains(&"V3DirectStoplessReq03GuidanceToolInjected"));
    assert!(first
        .node_trace
        .contains(&"V3DirectStoplessResp02RuntimeControlUpdated"));
    assert!(!first.node_trace.contains(&"V3HubRespChatProcess03Governed"));
    let V3ClientBody::Json(first_body) = &first.client_payload.body else {
        panic!("first direct stopless response must be JSON: {first:#?}");
    };
    assert_eq!(first_body["status"], "requires_action", "{first_body}");
    let first_serialized = serde_json::to_string(first_body).unwrap();
    assert!(first_serialized.contains("partial direct answer without summary"));
    assert!(first_serialized.contains("call_stopless_reasoning"));
    assert!(first_serialized.contains("routecodex hook run reasoningStop"));
    assert_eq!(
        state.len().unwrap(),
        1,
        "active Direct stopless must commit a Direct remote locator for the native response id"
    );
    assert_eq!(
        stopless.len().unwrap(),
        1,
        "active Direct stopless must store Direct-scoped MetadataCenter control state"
    );

    let second =
        execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
            &state,
            &stopless,
            &manifest,
            build_v3_server_03_http_request_raw(
                "s".into(),
                "req-direct-stopless-active-2".into(),
                "exec-direct-stopless-active-2".into(),
                "POST".into(),
                "/v1/responses".into(),
                json!({
                    "model":"gpt-5.5",
                    "previous_response_id":"resp_direct_stopless_1",
                    "input":[{"type":"function_call_output","call_id":"call_stopless_reasoning","output":""}]
                }),
            ),
            scope,
            register_responses_direct_hooks(),
            &transport,
            2_000,
        )
        .await;
    assert_eq!(second.client_payload.status, 200, "{second:#?}");
    assert!(second
        .node_trace
        .contains(&"V3HubReqContinuation03Classified"));
    assert!(second
        .node_trace
        .contains(&"V3DirectStoplessReq02NoopCliConsumed"));
    assert_eq!(
        state.len().unwrap(),
        0,
        "terminal summary releases Direct locator"
    );
    assert_eq!(
        stopless.len().unwrap(),
        0,
        "terminal summary clears Direct stopless control"
    );
    let V3ClientBody::Json(second_body) = &second.client_payload.body else {
        panic!("second direct stopless response must be JSON: {second:#?}");
    };
    assert_eq!(second_body["status"], "completed", "{second_body}");
    assert!(serde_json::to_string(second_body)
        .unwrap()
        .contains("Completed after direct stopless continuation."));

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let first_request = serde_json::to_string(&requests[0]).unwrap();
    assert_eq!(
        first_request.matches("\"name\":\"reasoningStop\"").count(),
        1,
        "Direct request must inject exactly one provider-visible reasoningStop tool: {first_request}"
    );
    let second_request = serde_json::to_string(&requests[1]).unwrap();
    assert_eq!(
        requests[1]["previous_response_id"],
        "resp_direct_stopless_1"
    );
    assert!(second_request.contains("继续当前目标"));
    assert!(!second_request.contains("call_stopless_reasoning"));
    assert_eq!(
        second_request.matches("\"name\":\"reasoningStop\"").count(),
        1,
        "Direct continuation request must re-inject exactly one reasoningStop tool: {second_request}"
    );
}

#[tokio::test]
async fn direct_json_stopless_noop_continuation_uses_native_reasoning_stop_call_id_not_local_cli_id(
) {
    let manifest = manifest_with_direct_stopless();
    let state = V3ResponsesDirectContinuationState::default();
    let stopless = V3ResponsesDirectStoplessControlState::default();
    let transport = DirectNativeReasoningStopThenSummaryTransport::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-stopless-direct-native-call",
        "conversation-stopless-direct-native-call",
        5555,
        "g",
    );

    let first = execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        &state,
        &stopless,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(),
            "req-direct-stopless-native-1".into(),
            "exec-direct-stopless-native-1".into(),
            "POST".into(),
            "/v1/responses".into(),
            json!({
                "model":"gpt-5.5",
                "input":"use reasoningStop to say continue",
                "tools":[{"type":"function","name":"exec_command"}]
            }),
        ),
        scope.clone(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 200, "{first:#?}");
    let V3ClientBody::Json(first_body) = &first.client_payload.body else {
        panic!("first direct stopless response must be JSON: {first:#?}");
    };
    assert_eq!(first_body["id"], "resp_direct_native_reasoning_stop_1");
    assert_eq!(first_body["status"], "requires_action", "{first_body}");
    let first_serialized = serde_json::to_string(first_body).unwrap();
    assert!(first_serialized.contains("call_stopless_reasoning"));
    assert!(!first_serialized.contains("call_provider_native_reasoning_stop"));
    assert_eq!(state.len().unwrap(), 1);
    assert_eq!(stopless.len().unwrap(), 1);

    let second = execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        &state,
        &stopless,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(),
            "req-direct-stopless-native-2".into(),
            "exec-direct-stopless-native-2".into(),
            "POST".into(),
            "/v1/responses".into(),
            json!({
                "model":"gpt-5.5",
                "previous_response_id":"resp_direct_native_reasoning_stop_1",
                "input":[{"type":"function_call_output","call_id":"call_stopless_reasoning","output":""}]
            }),
        ),
        scope,
        register_responses_direct_hooks(),
        &transport,
        2_000,
    )
    .await;
    assert_eq!(second.client_payload.status, 200, "{second:#?}");
    assert!(second
        .node_trace
        .contains(&"V3DirectStoplessReq02NoopCliConsumed"));
    assert_eq!(state.len().unwrap(), 0);
    assert_eq!(stopless.len().unwrap(), 0);

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let second_request = serde_json::to_string(&requests[1]).unwrap();
    assert_eq!(
        requests[1]["previous_response_id"],
        "resp_direct_native_reasoning_stop_1"
    );
    assert!(
        second_request.contains("call_provider_native_reasoning_stop"),
        "Direct second turn must acknowledge upstream native reasoningStop call id, not the local CLI bridge id: {second_request}"
    );
    assert!(
        !second_request.contains("call_stopless_reasoning"),
        "Direct second turn must not leak local no-op call id upstream: {second_request}"
    );
    assert!(
        second_request.contains("继续当前目标"),
        "Direct second turn must still carry continuation guidance: {second_request}"
    );
    assert_eq!(
        second_request.matches("\"name\":\"reasoningStop\"").count(),
        1,
        "Direct second turn must still inject exactly one current-turn reasoningStop tool: {second_request}"
    );
}

#[tokio::test]
async fn direct_stopless_native_reasoning_stop_without_call_id_fails_fast() {
    let manifest = manifest_with_direct_stopless();
    let state = V3ResponsesDirectContinuationState::default();
    let stopless = V3ResponsesDirectStoplessControlState::default();
    let transport = DirectNativeReasoningStopMissingCallIdTransport::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-stopless-direct-missing-call-id",
        "conversation-stopless-direct-missing-call-id",
        5555,
        "g",
    );

    let output = execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        &state,
        &stopless,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(),
            "req-direct-stopless-missing-call-id".into(),
            "exec-direct-stopless-missing-call-id".into(),
            "POST".into(),
            "/v1/responses".into(),
            json!({
                "model":"gpt-5.5",
                "input":"malformed native reasoningStop",
                "tools":[{"type":"function","name":"exec_command"}]
            }),
        ),
        scope,
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;

    assert_error_chain(&output);
    let V3ClientBody::Json(body) = &output.client_payload.body else {
        panic!("malformed native reasoningStop must project JSON error: {output:#?}");
    };
    let serialized = serde_json::to_string(body).unwrap();
    assert!(
        serialized.contains("reasoningStop tool call missing call_id"),
        "missing native reasoningStop call_id must be explicit, not silently skipped: {serialized}"
    );
}

#[tokio::test]
async fn direct_stopless_real_user_turn_after_stale_noop_resets_guard_count() {
    let manifest = manifest_with_direct_stopless();
    let state = V3ResponsesDirectContinuationState::default();
    let stopless = V3ResponsesDirectStoplessControlState::default();
    let transport = DirectAlwaysReasoningContinueTransport::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-stopless-direct-real-user-reset",
        "conversation-stopless-direct-real-user-reset",
        5555,
        "g",
    );
    let stopless_scope = V3ResponsesDirectStoplessControlScope::from(&scope);
    stopless
        .store_for_scope(
            &stopless_scope,
            V3StoplessCenterState::new(4, 5, V3StoplessCenterSteering::Continue)
                .provider_turn_in_flight(Some("req-old-stopless"), Some(999)),
        )
        .unwrap();

    let output = execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        &state,
        &stopless,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(),
            "req-direct-stopless-real-user-reset".into(),
            "exec-direct-stopless-real-user-reset".into(),
            "POST".into(),
            "/v1/responses".into(),
            json!({
                "model":"gpt-5.5",
                "input":"real user turn after stale local stopless bridge",
                "tools":[{"type":"function","name":"exec_command"}]
            }),
        ),
        scope,
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{output:#?}");
    let V3ClientBody::Json(body) = &output.client_payload.body else {
        panic!("Direct real-user reset response must be JSON: {output:#?}");
    };
    let serialized = serde_json::to_string(body).unwrap();
    assert!(
        serialized.contains("call_stopless_reasoning"),
        "real user turn must reset stale guard count before current activation: {serialized}"
    );
    assert_eq!(stopless.len().unwrap(), 1);
}

#[tokio::test]
async fn direct_stopless_fifth_activation_guards_clears_and_next_request_reactivates() {
    let manifest = manifest_with_direct_stopless();
    let state = V3ResponsesDirectContinuationState::default();
    let stopless = V3ResponsesDirectStoplessControlState::default();
    let transport = DirectAlwaysReasoningContinueTransport::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-stopless-direct-guard-five",
        "conversation-stopless-direct-guard-five",
        5555,
        "g",
    );

    for round in 1..=5 {
        let payload = if round == 1 {
            json!({
                "model":"gpt-5.5",
                "input":"continue until stopless guard",
                "tools":[{"type":"function","name":"exec_command"}]
            })
        } else {
            json!({
                "model":"gpt-5.5",
                "previous_response_id":format!("resp_direct_reasoning_continue_{}", round - 1),
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":""
                }]
            })
        };
        let output =
            execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
                &state,
                &stopless,
                &manifest,
                build_v3_server_03_http_request_raw(
                    "s".into(),
                    format!("req-direct-stopless-guard-{round}"),
                    format!("exec-direct-stopless-guard-{round}"),
                    "POST".into(),
                    "/v1/responses".into(),
                    payload,
                ),
                scope.clone(),
                register_responses_direct_hooks(),
                &transport,
                1_000 + round,
            )
            .await;
        assert_eq!(output.client_payload.status, 200, "{output:#?}");
        let V3ClientBody::Json(body) = &output.client_payload.body else {
            panic!("Direct stopless guard response must be JSON: {output:#?}");
        };
        let serialized = serde_json::to_string(body).unwrap();
        if round < 5 {
            assert_eq!(body["status"], "requires_action", "{body}");
            assert!(serialized.contains("call_stopless_reasoning"), "{body}");
            assert_eq!(stopless.len().unwrap(), 1);
        } else {
            assert_eq!(body["status"], "completed", "{body}");
            assert!(!serialized.contains("call_stopless_reasoning"), "{body}");
            assert!(
                !serialized.contains("routecodex hook run reasoningStop"),
                "{body}"
            );
            assert!(
                !serialized.contains("call_provider_reasoning_continue_5"),
                "{body}"
            );
            assert!(stopless.is_empty().unwrap());
            assert_eq!(state.len().unwrap(), 0);
        }
    }

    let fresh = execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        &state,
        &stopless,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(),
            "req-direct-stopless-after-guard".into(),
            "exec-direct-stopless-after-guard".into(),
            "POST".into(),
            "/v1/responses".into(),
            json!({
                "model":"gpt-5.5",
                "input":"fresh request after guard pass-through",
                "tools":[{"type":"function","name":"exec_command"}]
            }),
        ),
        scope,
        register_responses_direct_hooks(),
        &transport,
        2_000,
    )
    .await;
    assert_eq!(fresh.client_payload.status, 200, "{fresh:#?}");
    let V3ClientBody::Json(body) = &fresh.client_payload.body else {
        panic!("Direct post-guard response must be JSON: {fresh:#?}");
    };
    let serialized = serde_json::to_string(body).unwrap();
    assert_eq!(body["status"], "requires_action", "{body}");
    assert!(serialized.contains("call_stopless_reasoning"), "{body}");
    assert_eq!(stopless.len().unwrap(), 1);
}

#[tokio::test]
async fn direct_sse_stopless_metadata_center_projects_terminal_frames_without_sse_owning_semantics()
{
    let manifest = manifest_with_direct_stopless();
    let state = V3ResponsesDirectContinuationState::default();
    let stopless = V3ResponsesDirectStoplessControlState::default();
    let transport = DirectStoplessSseNoSummaryThenSummaryTransport::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-stopless-direct-sse-active",
        "conversation-stopless-direct-sse-active",
        5555,
        "g",
    );

    let first = execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        &state,
        &stopless,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(),
            "req-direct-stopless-sse-active-1".into(),
            "exec-direct-stopless-sse-active-1".into(),
            "POST".into(),
            "/v1/responses".into(),
            json!({"model":"gpt-5.5","stream":true,"input":"stream until summary","tools":[{"type":"function","name":"exec_command"}]}),
        ),
        scope,
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 200, "{first:#?}");
    assert!(matches!(&first.client_payload.body, V3ClientBody::Sse(_)));
    let first_body = collect_sse_body_text(first.client_payload.body).await;
    assert!(first_body.contains("response.completed"), "{first_body}");
    assert!(first_body.contains("response.done"), "{first_body}");
    assert!(first_body.contains("partial direct SSE answer without summary"));
    assert!(first_body.contains("call_stopless_reasoning"));
    assert!(first_body.contains("routecodex hook run reasoningStop"));
    assert!(first_body.contains("data: [DONE]"));
    assert_eq!(state.len().unwrap(), 1);
    assert_eq!(stopless.len().unwrap(), 1);

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let provider_request = serde_json::to_string(&requests[0]).unwrap();
    assert_eq!(
        provider_request.matches("\"name\":\"reasoningStop\"").count(),
        1,
        "Direct SSE provider request must inject exactly one reasoningStop tool: {provider_request}"
    );
}

#[derive(Default)]
struct TwoTurnSseTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct TerminalSseWithoutRemoteContinuationTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct ObservedTerminalSseTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct ObservedFailedTerminalOnlySseTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct PendingSseWithoutRemoteContinuationTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct PendingJsonWithoutRemoteContinuationTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct ThreeTurnTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct DirectStoplessNoSummaryThenSummaryTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct DirectStoplessSseNoSummaryThenSummaryTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct DirectNativeReasoningStopThenSummaryTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct DirectNativeReasoningStopMissingCallIdTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct DirectAlwaysReasoningContinueTransport {
    requests: Mutex<Vec<Value>>,
}

#[async_trait]
impl ResponsesTransport for ThreeTurnTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.body().clone());
        let attempt = requests.len();
        let body = match attempt {
            1 => {
                json!({"id":"resp_running_1","status":"requires_action","output":[{"type":"function_call","call_id":"call_running_1","name":"lookup","arguments":"{}"}]})
            }
            2 => {
                json!({"id":"resp_running_2","status":"in_progress","output":[{"type":"function_call","call_id":"call_running_2","name":"lookup","arguments":"{}"}]})
            }
            _ => {
                json!({"id":"resp_running_3","status":"completed","output":[{"type":"output_text","text":"done"}]})
            }
        };
        json_response(&request, 200, body)
    }
}

#[async_trait]
impl ResponsesTransport for DirectStoplessNoSummaryThenSummaryTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.body().clone());
        let body = if requests.len() == 1 {
            json!({
                "object": "response",
                "id": "resp_direct_stopless_1",
                "status": "completed",
                "output": [{"type": "output_text", "text": "partial direct answer without summary"}]
            })
        } else {
            json!({
                "object": "response",
                "id": "resp_direct_stopless_2",
                "status": "completed",
                "output": [
                    {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Completed after direct stopless continuation."}]},
                    {"type": "output_text", "text": "done after direct continuation"}
                ]
            })
        };
        json_response(&request, 200, body)
    }
}

#[async_trait]
impl ResponsesTransport for DirectStoplessSseNoSummaryThenSummaryTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.body().clone());
        if requests.len() == 1 {
            let chunks = vec![
                concat!(
                    "event: response.created\n",
                    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_direct_stopless_sse_1\",\"object\":\"response\",\"status\":\"in_progress\",\"output\":[]}}\n\n"
                )
                .as_bytes()
                .to_vec(),
                concat!(
                    "event: response.completed\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_direct_stopless_sse_1\",\"object\":\"response\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"partial direct SSE answer without summary\"}]}}\n\n",
                    "event: response.done\n",
                    "data: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_direct_stopless_sse_1\",\"object\":\"response\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"partial direct SSE answer without summary\"}]}}\n\n",
                    "data: [DONE]\n\n"
                )
                .as_bytes()
                .to_vec(),
            ];
            return Ok(V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".into(),
                    value: b"text/event-stream".to_vec(),
                }],
                Box::pin(stream::iter(chunks.into_iter().map(Ok))),
            ));
        }
        json_response(
            &request,
            200,
            json!({
                "object": "response",
                "id": "resp_direct_stopless_sse_2",
                "status": "completed",
                "output": [
                    {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Completed after direct SSE stopless continuation."}]},
                    {"type": "output_text", "text": "done after direct SSE continuation"}
                ]
            }),
        )
    }
}

#[async_trait]
impl ResponsesTransport for DirectAlwaysReasoningContinueTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.body().clone());
        let round = requests.len();
        json_response(
            &request,
            200,
            json!({
                "object": "response",
                "id": format!("resp_direct_reasoning_continue_{round}"),
                "status": "requires_action",
                "output": [{
                    "type": "function_call",
                    "call_id": format!("call_provider_reasoning_continue_{round}"),
                    "name": "reasoningStop",
                    "arguments": r#"{"stopreason":2,"reason":"continue"}"#
                }]
            }),
        )
    }
}

#[async_trait]
impl ResponsesTransport for DirectNativeReasoningStopThenSummaryTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.body().clone());
        let body = if requests.len() == 1 {
            json!({
                "object": "response",
                "id": "resp_direct_native_reasoning_stop_1",
                "status": "requires_action",
                "output": [{
                    "type": "function_call",
                    "call_id": "call_provider_native_reasoning_stop",
                    "name": "reasoningStop",
                    "arguments": "{\"stopreason\":2,\"reason\":\"continue\"}"
                }]
            })
        } else {
            json!({
                "object": "response",
                "id": "resp_direct_native_reasoning_stop_2",
                "status": "completed",
                "output": [
                    {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Native reasoningStop continuation completed."}]},
                    {"type": "output_text", "text": "done after native reasoningStop continuation"}
                ]
            })
        };
        json_response(&request, 200, body)
    }
}

#[async_trait]
impl ResponsesTransport for DirectNativeReasoningStopMissingCallIdTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.requests.lock().unwrap().push(request.body().clone());
        json_response(
            &request,
            200,
            json!({
                "object": "response",
                "id": "resp_direct_native_reasoning_stop_missing_call_id",
                "status": "requires_action",
                "output": [{
                    "type": "function_call",
                    "name": "reasoningStop",
                    "arguments": "{\"stopreason\":2,\"reason\":\"continue\"}"
                }]
            }),
        )
    }
}

#[derive(Default)]
struct AlwaysSamePendingTransport {
    requests: Mutex<Vec<Value>>,
}

#[async_trait]
impl ResponsesTransport for AlwaysSamePendingTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.requests.lock().unwrap().push(request.body().clone());
        json_response(
            &request,
            200,
            json!({"id":"resp_duplicate","status":"requires_action","output":[{"type":"function_call","call_id":"call_duplicate","name":"lookup","arguments":"{}"}]}),
        )
    }
}

#[derive(Default)]
struct PendingThenProviderFailureTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct PendingThenSseStreamFailureTransport {
    requests: Mutex<Vec<Value>>,
}

#[async_trait]
impl ResponsesTransport for PendingThenProviderFailureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.body().clone());
        if requests.len() == 1 {
            json_response(
                &request,
                200,
                json!({"id":"resp_failure_1","status":"requires_action","output":[{"type":"function_call","call_id":"call_failure_1","name":"lookup","arguments":"{}"}]}),
            )
        } else {
            json_response(
                &request,
                500,
                json!({"error":{"message":"controlled terminal provider failure"}}),
            )
        }
    }
}

#[async_trait]
impl ResponsesTransport for PendingThenSseStreamFailureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.body().clone());
        if requests.len() == 1 {
            json_response(
                &request,
                200,
                json!({"id":"resp_sse_failure_1","status":"requires_action","output":[{"type":"function_call","call_id":"call_sse_failure_1","name":"lookup","arguments":"{}"}]}),
            )
        } else {
            Ok(V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".into(),
                    value: b"text/event-stream".to_vec(),
                }],
                Box::pin(stream::iter(vec![Err(V3ProviderError::ResponseBody {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    reason: "controlled stream failure after restore".to_string(),
                })])),
            ))
        }
    }
}

#[async_trait]
impl ResponsesTransport for TwoTurnSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.body().clone());
        let chunks = if requests.len() == 1 {
            vec![
                concat!(
                "event: response.created\n",
                    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_sse_1\",\"status\":\"in_progress\",\"output\":[]}}\n\n",
                )
                .as_bytes()
                .to_vec(),
                concat!(
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"response_id\":\"resp_sse_1\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_sse_1\",\"name\":\"lookup\",\"arguments\":\"{}\"}}\n\n",
                "data: [DONE]\n\n"
            )
                .as_bytes()
                .to_vec(),
            ]
        } else {
            vec![
                concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_sse_2\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n\n",
            )
                .as_bytes()
                .to_vec(),
                "data: [DONE]\n\n".as_bytes().to_vec(),
            ]
        };
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(chunks.into_iter().map(Ok))),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for TerminalSseWithoutRemoteContinuationTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.requests.lock().unwrap().push(request.body().clone());
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(
                vec![
                    concat!(
                        "event: response.created\n",
                        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_http_sse_terminal\",\"status\":\"in_progress\",\"output\":[]}}\n\n",
                    )
                    .as_bytes()
                    .to_vec(),
                    concat!(
                        "event: response.completed\n",
                        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_http_sse_terminal\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n\n",
                        "data: [DONE]\n\n",
                    )
                    .as_bytes()
                    .to_vec(),
                ]
                .into_iter()
                .map(Ok),
            )),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for ObservedTerminalSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.requests.lock().unwrap().push(request.body().clone());
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(
                vec![
                    concat!(
                        "event: response.created\n",
                        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_observed_terminal\",\"status\":\"in_progress\",\"output\":[]}}\n\n",
                    )
                    .as_bytes()
                    .to_vec(),
                    concat!(
                        "event: response.in_progress\n",
                        "data: {\"type\":\"response.in_progress\",\"response\":{\"id\":\"resp_observed_terminal\",\"status\":\"in_progress\"}}\n\n",
                    )
                    .as_bytes()
                    .to_vec(),
                    concat!(
                        "event: response.completed\n",
                        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_observed_terminal\",\"output\":[{\"type\":\"output_text\",\"text\":\"done\"}],\"usage\":{\"input_tokens\":17,\"input_tokens_details\":{\"cached_tokens\":5},\"output_tokens\":3,\"total_tokens\":20}}}\n\n",
                        "data: [DONE]\n\n",
                    )
                    .as_bytes()
                    .to_vec(),
                ]
                .into_iter()
                .map(Ok),
            )),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for ObservedFailedTerminalOnlySseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.requests.lock().unwrap().push(request.body().clone());
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(
                vec![
                    concat!(
                        "event: response.created\n",
                        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_observed_failed\",\"status\":\"in_progress\",\"output\":[]}}\n\n",
                    )
                    .as_bytes()
                    .to_vec(),
                    concat!(
                        "event: response.failed\n",
                        "data: {\"type\":\"response.failed\",\"response\":{\"id\":\"resp_observed_failed\",\"status\":\"failed\",\"error\":{\"message\":\"upstream failed terminal\"}}}\n\n",
                        "data: [DONE]\n\n",
                    )
                    .as_bytes()
                    .to_vec(),
                ]
                .into_iter()
                .map(Ok),
            )),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for PendingSseWithoutRemoteContinuationTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.body().clone());
        let chunks = if requests.len() == 1 {
            vec![
                concat!(
                    "event: response.created\n",
                    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_http_sse_pending\",\"status\":\"in_progress\",\"output\":[]}}\n\n",
                )
                .as_bytes()
                .to_vec(),
                concat!(
                    "event: response.output_item.done\n",
                    "data: {\"type\":\"response.output_item.done\",\"response_id\":\"resp_http_sse_pending\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_http_sse_pending\",\"name\":\"lookup\",\"arguments\":\"{}\"}}\n\n",
                    "data: [DONE]\n\n",
                )
                .as_bytes()
                .to_vec(),
            ]
        } else {
            vec![
                concat!(
                    "event: response.completed\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_http_sse_done\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n\n",
                    "data: [DONE]\n\n",
                )
                .as_bytes()
                .to_vec(),
            ]
        };
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(chunks.into_iter().map(Ok))),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for PendingJsonWithoutRemoteContinuationTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.body().clone());
        let body = if requests.len() == 1 {
            json!({
                "id":"resp_http_json_pending",
                "status":"requires_action",
                "output":[{"type":"function_call","call_id":"call_http_json_pending","name":"lookup","arguments":"{}"}]
            })
        } else {
            json!({
                "id":"resp_http_json_done",
                "status":"completed",
                "output":[{"type":"output_text","text":"done"}]
            })
        };
        json_response(&request, 200, body)
    }
}

#[tokio::test]
async fn json_two_turn_remote_continuation_commits_loads_and_uses_exact_pin_without_router_reentry()
{
    let manifest = manifest();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = TwoTurnTransport::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-a",
        "conversation-a",
        5555,
        "g",
    );

    let first = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(), "req-1".into(), "exec-1".into(), "POST".into(),
            "/v1/responses".into(),
            json!({"model":"gpt-5.5","input":"use tool","tools":[{"type":"function","name":"lookup"}]})
        ),
        scope.clone(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    ).await;
    assert_eq!(first.client_payload.status, 200);
    assert_eq!(count(&first.node_trace, "V3Router07OpaqueTargetHitOnce"), 1);
    assert!(first
        .node_trace
        .contains(&"V3HubRespContinuation04Committed"));
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        build_v3_server_03_http_request_raw(
            "s".into(),
            "req-2".into(),
            "exec-2".into(),
            "POST".into(),
            "/v1/responses".into(),
            json!({
                "model":"gpt-5.5",
                "previous_response_id":"resp_remote_1",
                "input":[{"type":"function_call_output","call_id":"call_1","output":"ok"}]
            }),
        ),
        scope,
        register_responses_direct_hooks(),
        &transport,
        2_000,
    )
    .await;
    assert_eq!(second.client_payload.status, 200);
    assert_eq!(
        count(&second.node_trace, "V3Router07OpaqueTargetHitOnce"),
        0
    );
    assert_eq!(count(&second.node_trace, "V3TargetLocalReselected"), 0);
    assert!(second
        .node_trace
        .contains(&"V3HubReqContinuation03Classified"));
    assert!(second.node_trace.contains(&"V3HubReqTarget06Resolved"));
    assert_eq!(state.len().unwrap(), 0);
    assert!(matches!(second.client_payload.body, V3ClientBody::Json(_)));

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["previous_response_id"], "resp_remote_1");
    assert_eq!(requests[1]["input"][0]["type"], "function_call_output");
    for forbidden in [
        "provider_id",
        "auth_alias",
        "continuation_owner",
        "capability_revision",
        "routecodex_internal",
    ] {
        assert!(requests[1].get(forbidden).is_none(), "{forbidden}");
    }
}

#[tokio::test]
async fn sse_two_turn_remote_continuation_commits_and_finishes_on_the_same_exact_pin() {
    let manifest = manifest();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = TwoTurnSseTransport::default();
    let scope = scope();

    let first = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-sse-1",
            json!({"model":"gpt-5.5","stream":true,"input":"use tool","tools":[{"type":"function","name":"lookup"}]}),
        ),
        scope.clone(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 200);
    assert_eq!(count(&first.node_trace, "V3Router07OpaqueTargetHitOnce"), 1);
    assert_eq!(state.len().unwrap(), 0);
    let V3ClientBody::Sse(mut first_stream) = first.client_payload.body else {
        panic!("SSE response must remain stream")
    };
    let first_chunk = first_stream
        .next()
        .await
        .expect("first SSE chunk must be forwarded before provider terminal")
        .expect("first SSE chunk must be successful");
    let first_chunk_text = String::from_utf8(first_chunk).unwrap();
    assert!(first_chunk_text.contains("resp_sse_1"));
    assert!(!first_chunk_text.contains("[DONE]"));
    assert_eq!(state.len().unwrap(), 0);
    let first_remainder = collect_sse_text(first_stream).await;
    assert!(first_remainder.contains("call_sse_1"));
    assert!(first_remainder.contains("[DONE]"));
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-sse-2",
            json!({
                "model":"gpt-5.5",
                "stream":true,
                "previous_response_id":"resp_sse_1",
                "input":[{"type":"function_call_output","call_id":"call_sse_1","output":"ok"}]
            }),
        ),
        scope,
        register_responses_direct_hooks(),
        &transport,
        2_000,
    )
    .await;
    assert_eq!(second.client_payload.status, 200);
    assert_eq!(
        count(&second.node_trace, "V3Router07OpaqueTargetHitOnce"),
        0
    );
    assert_eq!(count(&second.node_trace, "V3TargetLocalReselected"), 0);
    assert!(second
        .node_trace
        .contains(&"V3HubReqContinuation03Classified"));
    assert!(second.node_trace.contains(&"V3HubReqTarget06Resolved"));
    assert_eq!(state.len().unwrap(), 1);
    let second_body = collect_sse_body_text(second.client_payload.body).await;
    assert!(second_body.contains("resp_sse_2"));
    assert!(second_body.contains("[DONE]"));
    assert_eq!(state.len().unwrap(), 0);

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["previous_response_id"], "resp_sse_1");
    assert_eq!(requests[1]["input"][0]["type"], "function_call_output");
    assert_control_truth_isolated(&requests[1]);
}

#[tokio::test]
async fn http_only_sse_terminal_response_streams_without_remote_continuation_commit() {
    let manifest = http_only_manifest_without_remote_continuation();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = TerminalSseWithoutRemoteContinuationTransport::default();
    let first = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-http-sse-terminal",
            json!({"model":"gpt-5.5","stream":true,"input":"say done"}),
        ),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 200);
    assert_eq!(state.len().unwrap(), 0);
    let body = collect_sse_body_text(first.client_payload.body).await;
    assert!(body.contains("resp_http_sse_terminal"));
    assert!(body.contains("response.completed"));
    assert!(body.contains("[DONE]"));
    assert_eq!(state.len().unwrap(), 0);

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_control_truth_isolated(&requests[0]);
}

#[tokio::test]
async fn direct_provider_event_json_observation_records_usage_and_completed_terminal() {
    let manifest = http_only_manifest_without_remote_continuation();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = ObservedTerminalSseTransport::default();
    let output = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-http-sse-terminal-observed",
            json!({"model":"gpt-5.5","stream":true,"input":"say done"}),
        ),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    let observation = output
        .stream_observation
        .clone()
        .expect("Direct output must expose runtime provider-event JSON observation state");
    let body = collect_sse_body_text(output.client_payload.body).await;
    assert!(body.contains("response.in_progress"));
    assert!(body.contains("response.completed"));
    assert!(body.contains("[DONE]"));

    let snapshot = observation.snapshot().unwrap();
    assert_eq!(snapshot.response_status.as_deref(), Some("completed"));
    assert_eq!(snapshot.finish_reason.as_deref(), Some("stop"));
    assert_eq!(
        snapshot.usage,
        Some(V3RuntimeUsageSummary {
            input_tokens: Some(17),
            output_tokens: Some(3),
            total_tokens: Some(20),
            cached_tokens: Some(5),
        })
    );
    assert_eq!(state.len().unwrap(), 0);
}

#[tokio::test]
async fn direct_provider_failed_terminal_enters_error_chain_before_client_stream() {
    let manifest = http_only_manifest_without_remote_continuation();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = ObservedFailedTerminalOnlySseTransport::default();
    let output = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-http-sse-terminal-observed-failed",
            json!({"model":"gpt-5.5","stream":true,"input":"fail"}),
        ),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;

    assert_error_chain(&output);
    let V3ClientBody::Json(body) = &output.client_payload.body else {
        panic!("provider terminal failed event must project JSON Error06 before client SSE starts")
    };
    assert_eq!(body["error"]["code"], "response.failed");
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("upstream failed terminal"));
    assert!(output.stream_observation.is_none());
    assert_eq!(state.len().unwrap(), 0);
}

#[tokio::test]
async fn direct_provider_event_json_observation_infers_terminal_status_from_event_type_without_payload_status(
) {
    let manifest = http_only_manifest_without_remote_continuation();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = ObservedTerminalSseTransport::default();
    let output = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-http-sse-terminal-inferred",
            json!({"model":"gpt-5.5","stream":true,"input":"turn"}),
        ),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    let observation = output
        .stream_observation
        .clone()
        .expect("Direct output must expose runtime provider-event JSON observation state");
    let body = collect_sse_body_text(output.client_payload.body).await;
    assert!(body.contains("response.completed"));
    assert!(body.contains("response.in_progress"));
    assert!(body.contains("[DONE]"));

    let snapshot = observation.snapshot().unwrap();
    assert_eq!(snapshot.response_status.as_deref(), Some("completed"));
    assert_eq!(snapshot.finish_reason.as_deref(), Some("stop"));
    assert_eq!(
        snapshot.usage.as_ref().map(|usage| usage.total_tokens),
        Some(Some(20))
    );
    assert_eq!(state.len().unwrap(), 0);
}

#[tokio::test]
async fn http_only_json_function_call_uses_v2_direct_http_continuation_without_remote_capability() {
    let manifest = http_only_manifest_without_remote_continuation();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = PendingJsonWithoutRemoteContinuationTransport::default();
    let first = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-http-json-pending",
            json!({"model":"gpt-5.5","input":"use tool","tools":[{"type":"function","name":"lookup"}]}),
        ),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 200, "{first:?}");
    assert!(first
        .node_trace
        .contains(&"V3HubRespContinuation04Committed"));
    assert_eq!(state.len().unwrap(), 1);
    let V3ClientBody::Json(first_body) = &first.client_payload.body else {
        panic!("HTTP direct pending JSON must be projected to client JSON")
    };
    assert_eq!(first_body["id"], "resp_http_json_pending");
    assert_eq!(first_body["status"], "requires_action");

    let second = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-http-json-submit",
            json!({
                "model":"gpt-5.5",
                "previous_response_id":"resp_http_json_pending",
                "input":[{"type":"function_call_output","call_id":"call_http_json_pending","output":"ok"}]
            }),
        ),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        2_000,
    )
    .await;
    assert_eq!(second.client_payload.status, 200, "{second:?}");
    assert!(second
        .node_trace
        .contains(&"V3HubReqContinuation03Classified"));
    assert!(second.node_trace.contains(&"V3HubReqTarget06Resolved"));
    assert_eq!(
        count(&second.node_trace, "V3Router07OpaqueTargetHitOnce"),
        0
    );
    assert_eq!(state.len().unwrap(), 0);

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1]["previous_response_id"],
        "resp_http_json_pending"
    );
    assert_eq!(requests[1]["input"][0]["type"], "function_call_output");
    assert_control_truth_isolated(&requests[1]);
}

#[tokio::test]
async fn http_only_sse_function_call_uses_v2_direct_http_continuation_without_remote_capability() {
    let manifest = http_only_manifest_without_remote_continuation();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = PendingSseWithoutRemoteContinuationTransport::default();
    let first = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-http-sse-pending",
            json!({"model":"gpt-5.5","stream":true,"input":"use tool","tools":[{"type":"function","name":"lookup"}]}),
        ),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 200);
    let V3ClientBody::Sse(mut stream) = first.client_payload.body else {
        panic!("SSE pending response must stay a stream until observed")
    };
    let first_chunk = stream
        .next()
        .await
        .expect("response.created chunk must be yielded")
        .expect("response.created must not be treated as pending continuation");
    assert!(String::from_utf8(first_chunk)
        .unwrap()
        .contains("resp_http_sse_pending"));
    let remainder = collect_sse_text(stream).await;
    assert!(remainder.contains("call_http_sse_pending"));
    assert!(remainder.contains("[DONE]"));
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-http-sse-submit",
            json!({
                "model":"gpt-5.5",
                "stream":true,
                "previous_response_id":"resp_http_sse_pending",
                "input":[{"type":"function_call_output","call_id":"call_http_sse_pending","output":"ok"}]
            }),
        ),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        2_000,
    )
    .await;
    assert_eq!(second.client_payload.status, 200, "{second:?}");
    assert!(second
        .node_trace
        .contains(&"V3HubReqContinuation03Classified"));
    assert!(second.node_trace.contains(&"V3HubReqTarget06Resolved"));
    assert_eq!(
        count(&second.node_trace, "V3Router07OpaqueTargetHitOnce"),
        0
    );
    let second_body = collect_sse_body_text(second.client_payload.body).await;
    assert!(second_body.contains("resp_http_sse_done"));
    assert!(second_body.contains("[DONE]"));
    assert_eq!(state.len().unwrap(), 0);

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_control_truth_isolated(&requests[0]);
    assert_eq!(requests[1]["previous_response_id"], "resp_http_sse_pending");
    assert_eq!(requests[1]["input"][0]["type"], "function_call_output");
    assert_control_truth_isolated(&requests[1]);
}

async fn collect_sse_body_text(body: V3ClientBody) -> String {
    let V3ClientBody::Sse(stream) = body else {
        panic!("SSE response must remain stream")
    };
    collect_sse_text(stream).await
}

async fn collect_sse_text(mut stream: routecodex_v3_runtime::V3ClientSseStream) -> String {
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.expect("SSE stream chunk must be successful"));
    }
    String::from_utf8(bytes).expect("controlled SSE must remain UTF-8")
}

#[tokio::test]
async fn missing_locator_scope_mismatch_and_expiry_fail_before_router_or_provider_send() {
    let manifest = manifest();

    let missing_state = V3ResponsesDirectContinuationState::default();
    let missing_transport = TwoTurnTransport::default();
    let missing = continuation_turn(
        &missing_state,
        &manifest,
        scope(),
        &missing_transport,
        "resp_missing",
        "req-missing",
        2_000,
    )
    .await;
    assert_error_chain(&missing);
    assert_eq!(
        count(&missing.node_trace, "V3Router07OpaqueTargetHitOnce"),
        0
    );
    assert!(missing_transport.requests.lock().unwrap().is_empty());

    let state = V3ResponsesDirectContinuationState::default();
    let transport = TwoTurnTransport::default();
    prime_pending(&state, &manifest, scope(), &transport, 1_000).await;
    for (case, mismatched_scope) in [
        (
            "endpoint",
            V3ResponsesDirectContinuationScope::responses(
                "/v1/responses/other",
                "session-a",
                "conversation-a",
                5555,
                "g",
            ),
        ),
        (
            "session",
            V3ResponsesDirectContinuationScope::responses(
                "/v1/responses",
                "session-b",
                "conversation-a",
                5555,
                "g",
            ),
        ),
        (
            "conversation",
            V3ResponsesDirectContinuationScope::responses(
                "/v1/responses",
                "session-a",
                "conversation-b",
                5555,
                "g",
            ),
        ),
        (
            "port",
            V3ResponsesDirectContinuationScope::responses(
                "/v1/responses",
                "session-a",
                "conversation-a",
                5520,
                "g",
            ),
        ),
        (
            "group",
            V3ResponsesDirectContinuationScope::responses(
                "/v1/responses",
                "session-a",
                "conversation-a",
                5555,
                "other",
            ),
        ),
    ] {
        let output = continuation_turn(
            &state,
            &manifest,
            mismatched_scope,
            &transport,
            "resp_remote_1",
            &format!("req-scope-{case}"),
            2_000,
        )
        .await;
        assert_error_chain(&output);
        assert_eq!(
            count(&output.node_trace, "V3Router07OpaqueTargetHitOnce"),
            0
        );
    }
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
    assert_eq!(state.len().unwrap(), 1);

    let expired = continuation_turn(
        &state,
        &manifest,
        scope(),
        &transport,
        "resp_remote_1",
        "req-expired",
        1_801_000,
    )
    .await;
    assert_error_chain(&expired);
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
    assert_eq!(state.len().unwrap(), 1);
}

#[tokio::test]
async fn still_running_rebinds_locator_then_terminal_success_releases_it_without_router_reentry() {
    let manifest = manifest();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = ThreeTurnTransport::default();
    prime_pending_with_id(
        &state,
        &manifest,
        scope(),
        &transport,
        1_000,
        "req-running-1",
    )
    .await;

    let still_running = continuation_turn(
        &state,
        &manifest,
        scope(),
        &transport,
        "resp_running_1",
        "req-running-2",
        2_000,
    )
    .await;
    assert_eq!(still_running.client_payload.status, 200);
    assert_eq!(
        count(&still_running.node_trace, "V3Router07OpaqueTargetHitOnce"),
        0
    );
    assert_eq!(state.len().unwrap(), 1);

    let terminal = continuation_turn(
        &state,
        &manifest,
        scope(),
        &transport,
        "resp_running_2",
        "req-running-3",
        3_000,
    )
    .await;
    assert_eq!(terminal.client_payload.status, 200);
    assert_eq!(
        count(&terminal.node_trace, "V3Router07OpaqueTargetHitOnce"),
        0
    );
    assert_eq!(count(&terminal.node_trace, "V3TargetLocalReselected"), 0);
    assert_eq!(state.len().unwrap(), 0);
}

#[tokio::test]
async fn duplicate_commit_and_already_terminal_are_explicit_errors_not_success_truth() {
    let manifest = manifest();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = AlwaysSamePendingTransport::default();
    let first = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request("req-duplicate-1", json!({"model":"gpt-5.5","input":"one"})),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 200);
    assert_eq!(state.len().unwrap(), 1);
    let duplicate = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request("req-duplicate-2", json!({"model":"gpt-5.5","input":"two"})),
        scope(),
        register_responses_direct_hooks(),
        &transport,
        2_000,
    )
    .await;
    assert_error_chain(&duplicate);
    assert_eq!(state.len().unwrap(), 1);

    let terminal_state = V3ResponsesDirectContinuationState::default();
    let terminal_transport = TwoTurnTransport::default();
    let terminal = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &terminal_state,
        &manifest,
        request(
            "req-terminal-1",
            json!({"model":"gpt-5.5","previous_response_id":"never_committed","input":[]}),
        ),
        scope(),
        register_responses_direct_hooks(),
        &terminal_transport,
        2_000,
    )
    .await;
    assert_error_chain(&terminal);
    assert!(terminal_transport.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn pinned_terminal_provider_failure_uses_error01_06_without_reselection() {
    let manifest = manifest();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = PendingThenProviderFailureTransport::default();
    prime_pending_with_id(
        &state,
        &manifest,
        scope(),
        &transport,
        1_000,
        "req-failure-1",
    )
    .await;
    let failure = continuation_turn(
        &state,
        &manifest,
        scope(),
        &transport,
        "resp_failure_1",
        "req-failure-2",
        2_000,
    )
    .await;
    assert_error_chain(&failure);
    assert_eq!(
        count(&failure.node_trace, "V3Router07OpaqueTargetHitOnce"),
        0
    );
    assert_eq!(count(&failure.node_trace, "V3TargetLocalReselected"), 0);
    assert!(failure
        .node_trace
        .contains(&"V3HubRespContinuation04Committed"));
    assert_eq!(state.len().unwrap(), 0);
}

#[tokio::test]
async fn sse_stream_error_after_restore_preserves_previous_locator_truth() {
    let manifest = manifest();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = PendingThenSseStreamFailureTransport::default();
    prime_pending_with_id(
        &state,
        &manifest,
        scope(),
        &transport,
        1_000,
        "req-sse-failure-1",
    )
    .await;
    let output = continuation_turn(
        &state,
        &manifest,
        scope(),
        &transport,
        "resp_sse_failure_1",
        "req-sse-failure-2",
        2_000,
    )
    .await;
    assert_error_chain(&output);
    assert_eq!(state.len().unwrap(), 1);
    let V3ClientBody::Json(body) = &output.client_payload.body else {
        panic!("provider body stream failure before client bytes must project Error06 JSON")
    };
    assert_eq!(body["error"]["code"], "provider_response_body_error");
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("controlled stream failure after restore"));
    assert!(!output
        .node_trace
        .contains(&"V3HubRespContinuation04Committed"));
    assert_eq!(state.len().unwrap(), 1);
}

#[tokio::test]
async fn capability_auth_and_provider_availability_drift_fail_at_req06_without_router_or_send() {
    for (case, changed_manifest) in [
        ("capability", manifest_variant("a", true, &["reasoning"])),
        ("auth", manifest_variant("b", true, &[])),
        ("availability", manifest_variant("a", false, &[])),
    ] {
        let state = V3ResponsesDirectContinuationState::default();
        let transport = TwoTurnTransport::default();
        prime_pending(&state, &manifest(), scope(), &transport, 1_000).await;
        let output = continuation_turn(
            &state,
            &changed_manifest,
            scope(),
            &transport,
            "resp_remote_1",
            &format!("req-{case}-drift"),
            2_000,
        )
        .await;
        assert_error_chain(&output);
        assert_eq!(
            count(&output.node_trace, "V3Router07OpaqueTargetHitOnce"),
            0
        );
        assert_eq!(count(&output.node_trace, "V3TargetLocalReselected"), 0);
        assert_eq!(transport.requests.lock().unwrap().len(), 1);
        assert_eq!(state.len().unwrap(), 1);
    }
}

fn count(trace: &[&'static str], node: &'static str) -> usize {
    trace.iter().filter(|item| **item == node).count()
}

fn request(request_id: &str, body: Value) -> routecodex_v3_runtime::V3Server03HttpRequestRaw {
    build_v3_server_03_http_request_raw(
        "s".into(),
        request_id.into(),
        format!("exec-{request_id}"),
        "POST".into(),
        "/v1/responses".into(),
        body,
    )
}

fn scope() -> V3ResponsesDirectContinuationScope {
    V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-a",
        "conversation-a",
        5555,
        "g",
    )
}

fn assert_control_truth_isolated(body: &Value) {
    for forbidden in [
        "provider_id",
        "auth_alias",
        "continuation_owner",
        "capability_revision",
        "routecodex_internal",
    ] {
        assert!(body.get(forbidden).is_none(), "{forbidden}");
    }
}

fn json_response(
    request: &V3Transport13ResponsesHttpRequest,
    status: u16,
    body: Value,
) -> Result<V3ProviderResp14Raw, V3ProviderError> {
    Ok(V3ProviderResp14Raw::from_json(
        request.request_id(),
        request.provider_id(),
        status,
        vec![V3ProviderResponseHeader {
            name: "content-type".into(),
            value: b"application/json".to_vec(),
        }],
        serde_json::to_vec(&body).unwrap(),
    ))
}

async fn prime_pending<T: ResponsesTransport>(
    state: &V3ResponsesDirectContinuationState,
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    scope: V3ResponsesDirectContinuationScope,
    transport: &T,
    now: u64,
) {
    prime_pending_with_id(state, manifest, scope, transport, now, "req-prime").await;
}

async fn prime_pending_with_id<T: ResponsesTransport>(
    state: &V3ResponsesDirectContinuationState,
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    scope: V3ResponsesDirectContinuationScope,
    transport: &T,
    now: u64,
    request_id: &str,
) {
    let output = execute_v3_responses_direct_runtime_kernel_with_continuation(
        state,
        manifest,
        request(
            request_id,
            json!({"model":"gpt-5.5","input":"use tool","tools":[{"type":"function","name":"lookup"}]}),
        ),
        scope,
        register_responses_direct_hooks(),
        transport,
        now,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{output:?}");
    assert_eq!(state.len().unwrap(), 1);
}

async fn continuation_turn<T: ResponsesTransport>(
    state: &V3ResponsesDirectContinuationState,
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    scope: V3ResponsesDirectContinuationScope,
    transport: &T,
    response_id: &str,
    request_id: &str,
    now: u64,
) -> routecodex_v3_runtime::V3ResponsesDirectRuntimeOutput {
    execute_v3_responses_direct_runtime_kernel_with_continuation(
        state,
        manifest,
        request(
            request_id,
            json!({
                "model":"gpt-5.5",
                "previous_response_id":response_id,
                "input":[{"type":"function_call_output","call_id":"call_1","output":"ok"}]
            }),
        ),
        scope,
        register_responses_direct_hooks(),
        transport,
        now,
    )
    .await
}

fn assert_error_chain(output: &routecodex_v3_runtime::V3ResponsesDirectRuntimeOutput) {
    assert_ne!(output.client_payload.status, 200, "{output:?}");
    assert_eq!(
        output.error_chain.as_deref(),
        Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
    );
    let V3ClientBody::Json(body) = &output.client_payload.body else {
        panic!("error projection must be JSON")
    };
    assert_eq!(
        body.pointer("/error/error_node").and_then(Value::as_str),
        Some("V3Error06ClientProjected")
    );
}

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    manifest_variant_with_stopless("a", true, &[], false)
}

fn manifest_with_direct_stopless() -> routecodex_v3_config::V3Config05ManifestPublished {
    manifest_variant_with_stopless("a", true, &[], true)
}

fn manifest_with_direct_stopless_server_stopless_disabled(
) -> routecodex_v3_config::V3Config05ManifestPublished {
    manifest_variant_with_stopless_and_server_override("a", true, &[], true, Some(false))
}

fn http_only_manifest_without_remote_continuation(
) -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[features]
stopless_center = false
[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]
[providers.p]
enabled = true
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "a", env = "TEST_KEY" }] }
responses = { process = "chat", streaming = "always", transport = "http" }
[providers.p.models.m]
wire_name = "wire-m"
capabilities = ["text", "tools"]
supports_streaming = true
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "a", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn manifest_variant(
    auth_alias: &str,
    enabled: bool,
    extra_capabilities: &[&str],
) -> routecodex_v3_config::V3Config05ManifestPublished {
    manifest_variant_with_stopless(auth_alias, enabled, extra_capabilities, false)
}

fn manifest_variant_with_stopless(
    auth_alias: &str,
    enabled: bool,
    extra_capabilities: &[&str],
    stopless_center: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    manifest_variant_with_stopless_and_server_override(
        auth_alias,
        enabled,
        extra_capabilities,
        stopless_center,
        None,
    )
}

fn manifest_variant_with_stopless_and_server_override(
    auth_alias: &str,
    enabled: bool,
    extra_capabilities: &[&str],
    stopless_center: bool,
    server_stopless_center: Option<bool>,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let mut capabilities = vec!["text", "tools"];
    capabilities.extend_from_slice(extra_capabilities);
    let capabilities = capabilities
        .into_iter()
        .map(|capability| format!("\"{capability}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let server_features = server_stopless_center
        .map(|enabled| {
            format!(
                r#"
[servers.s.features]
stopless_center = {enabled}
"#
            )
        })
        .unwrap_or_default();
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            &format!(
                r#"
version = 3
[features]
stopless_center = {stopless_center}
responses_direct_stopless_center = {stopless_center}
[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]
{server_features}
[providers.p]
enabled = {enabled}
type = "responses"
base_url = "http://controlled.invalid/v1"
	default_model = "gpt-5.5"
auth = {{ type = "api_key", entries = [{{ alias = "{auth_alias}", env = "TEST_KEY" }}] }}
responses = {{ process = "chat", streaming = "always", transport = "websocket_v2", websocket_v2_url = "wss://controlled.invalid/v1/responses" }}
	[providers.p.models."gpt-5.5"]
	wire_name = "gpt-5.5"
	capabilities = [{capabilities}]
	supports_streaming = true
	[route_groups.g.pools.default]
	selection = {{ strategy = "priority" }}
	targets = [{{ kind = "provider_model", provider = "p", model = "gpt-5.5", key = "{auth_alias}", priority = 1 }}]
"#,
            ),
        )
        .unwrap(),
    )
    .unwrap()
}
