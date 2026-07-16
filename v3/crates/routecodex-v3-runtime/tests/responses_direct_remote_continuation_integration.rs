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
    execute_v3_responses_direct_runtime_kernel_with_continuation, register_responses_direct_hooks,
    V3ClientBody, V3ResponsesDirectContinuationScope, V3ResponsesDirectContinuationState,
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

#[derive(Default)]
struct TwoTurnSseTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct TerminalSseWithoutRemoteContinuationTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct PendingSseWithoutRemoteContinuationTransport {
    requests: Mutex<Vec<Value>>,
}

#[derive(Default)]
struct ThreeTurnTransport {
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
impl ResponsesTransport for PendingSseWithoutRemoteContinuationTransport {
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
                .into_iter()
                .map(Ok),
            )),
        ))
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
            json!({"model":"client","input":"use tool","tools":[{"type":"function","name":"lookup"}]})
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
                "model":"client",
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
            json!({"model":"client","stream":true,"input":"use tool","tools":[{"type":"function","name":"lookup"}]}),
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
                "model":"client",
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
            json!({"model":"client","stream":true,"input":"say done"}),
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
async fn http_only_sse_function_call_errors_without_remote_continuation_capability() {
    let manifest = http_only_manifest_without_remote_continuation();
    let state = V3ResponsesDirectContinuationState::default();
    let transport = PendingSseWithoutRemoteContinuationTransport::default();
    let first = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-http-sse-pending",
            json!({"model":"client","stream":true,"input":"use tool","tools":[{"type":"function","name":"lookup"}]}),
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
    let error = stream
        .next()
        .await
        .expect("function-call chunk must fail explicitly")
        .expect_err("HTTP-only function call must not be delivered as continuable success");
    assert!(error
        .message
        .contains("provider p model m lacks required remote_continuation capability"));
    assert_eq!(state.len().unwrap(), 0);

    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_control_truth_isolated(&requests[0]);
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
        request("req-duplicate-1", json!({"model":"client","input":"one"})),
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
        request("req-duplicate-2", json!({"model":"client","input":"two"})),
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
            json!({"model":"client","previous_response_id":"never_committed","input":[]}),
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
    assert_eq!(output.client_payload.status, 200);
    assert_eq!(state.len().unwrap(), 1);
    let V3ClientBody::Sse(mut stream) = output.client_payload.body else {
        panic!("SSE provider body failure must remain a stream error")
    };
    let error = stream
        .next()
        .await
        .expect("controlled stream error must be yielded")
        .expect_err("stream must fail explicitly");
    assert_eq!(error.code, "provider_response_body_error");
    assert!(error
        .message
        .contains("controlled stream failure after restore"));
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
            json!({"model":"client","input":"use tool","tools":[{"type":"function","name":"lookup"}]}),
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
                "model":"client",
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
    manifest_variant("a", true, &[])
}

fn http_only_manifest_without_remote_continuation(
) -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
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
capabilities = ["text", "tools", "streaming"]
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
    let mut capabilities = vec!["tools", "streaming", "tool_outputs", "remote_continuation"];
    capabilities.extend_from_slice(extra_capabilities);
    let capabilities = capabilities
        .into_iter()
        .map(|capability| format!("\"{capability}\""))
        .collect::<Vec<_>>()
        .join(", ");
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            &format!(
                r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "g"
endpoints = ["responses"]
[providers.p]
enabled = {enabled}
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "m"
auth = {{ type = "api_key", entries = [{{ alias = "{auth_alias}", env = "TEST_KEY" }}] }}
responses = {{ process = "chat", streaming = "always", transport = "websocket_v2", websocket_v2_url = "wss://controlled.invalid/v1/responses" }}
[providers.p.models.m]
wire_name = "wire-m"
capabilities = [{capabilities}]
supports_streaming = true
[route_groups.g.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "p", model = "m", key = "{auth_alias}", priority = 1 }}]
"#,
            ),
        )
        .unwrap(),
    )
    .unwrap()
}
