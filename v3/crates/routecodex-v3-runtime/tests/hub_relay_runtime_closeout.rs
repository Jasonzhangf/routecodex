use async_trait::async_trait;
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS;
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderAvailabilityReader, V3ProviderError, V3ProviderHealthStore,
    V3ProviderHttpFailure, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_anthropic_relay_runtime,
    execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile,
    execute_v3_responses_relay_runtime,
    execute_v3_responses_relay_runtime_with_health_and_retry_policy,
    execute_v3_responses_relay_runtime_with_retry_policy, V3AnthropicRelayLocalContinuationScope,
    V3AnthropicRelayLocalContinuationState, V3AnthropicRelayRuntimeInput,
    V3ResponsesRelayClientBody, V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayRetryPolicy,
    V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

const EXPECTED_RELAY_TRACE: [&str; 17] = [
    "V3HubReqInbound01ClientRaw",
    "V3HubReqInbound02Normalized",
    "V3HubReqContinuation03Classified",
    "V3HubReqChatProcess04Governed",
    "V3HubReqExecution05Planned",
    "V3HubReqTarget06Resolved",
    "V3HubReqOutbound07ProviderSemantic",
    "ProviderReqCompat06ProviderCompat",
    "V3ProviderReqOutbound08WirePayload",
    "V3ProviderReqOutbound09TransportRequest",
    "V3ProviderRespInbound01Raw",
    "ProviderRespCompat02ProviderCompat",
    "V3HubRespInbound02Normalized",
    "V3HubRespChatProcess03Governed",
    "V3HubRespContinuation04Committed",
    "V3HubRespOutbound05ClientSemantic",
    "V3ServerRespOutbound06ClientFrame",
];

struct JsonThenSseTransport {
    captures: Mutex<Vec<Value>>,
    turn: AtomicUsize,
}

#[async_trait]
impl ResponsesTransport for JsonThenSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures.lock().unwrap().push(request.body().clone());
        if self.turn.fetch_add(1, Ordering::SeqCst) == 0 {
            return Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                serde_json::to_vec(&json!({
                    "id":"resp_closeout_json",
                    "status":"completed",
                    "output":[{"type":"output_text","text":"json ok"}],
                    "usage":{
                        "input_tokens":11,
                        "input_tokens_details":{"cached_tokens":3},
                        "output_tokens":5,
                        "total_tokens":16
                    }
                }))
                .unwrap(),
            ));
        }
        let stream = futures_util::stream::iter([
            Ok(b"event: response.reasoning_summary_text.delta\ndata: {\"delta\":\"sse ".to_vec()),
            Ok(b"ok\"}\n\n".to_vec()),
            Ok(b"event: response.output_item.added\ndata: {\"item\":{\"type\":\"function_call\",\"call_id\":\"call_closeout_sse\",\"name\":\"lookup\",\"arguments\":\"\"}}\n\n".to_vec()),
            Ok(b"event: response.function_call_arguments.delta\ndata: {\"delta\":\"{\\\"q\\\":\\\"closeout\\\"}\"}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_closeout_sse\",\"status\":\"completed\",\"usage\":{\"input_tokens\":13,\"input_tokens_details\":{\"cached_tokens\":4},\"output_tokens\":7,\"total_tokens\":20}}}\n\n".to_vec()),
        ]);
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream),
        ))
    }
}

#[tokio::test]
async fn controlled_json_and_sse_e2e_use_fixed_topology_and_one_response_exit() {
    let transport = JsonThenSseTransport {
        captures: Mutex::new(Vec::new()),
        turn: AtomicUsize::new(0),
    };

    let json_output = execute_v3_anthropic_relay_runtime(
        &manifest(),
        request(
            "req-closeout-json",
            json!([{"role":"user","content":"json"}]),
            false,
        ),
        &transport,
    )
    .await
    .unwrap();
    assert_eq!(json_output.status, 200);
    assert_eq!(json_output.node_trace, EXPECTED_RELAY_TRACE);
    assert_eq!(
        json_output
            .node_trace
            .iter()
            .filter(|node| **node == "V3ServerRespOutbound06ClientFrame")
            .count(),
        1
    );
    assert_eq!(json_output.client_response["stop_reason"], "end_turn");

    let sse_output = execute_v3_anthropic_relay_runtime(
        &manifest(),
        request(
            "req-closeout-sse",
            json!([{"role":"user","content":"sse"}]),
            true,
        ),
        &transport,
    )
    .await
    .unwrap();
    assert_eq!(sse_output.status, 200);
    assert_eq!(sse_output.node_trace, EXPECTED_RELAY_TRACE);
    assert_eq!(
        sse_output.client_response["events"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["event"],
        "message_stop"
    );

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(captures[0]["stream"], false);
    assert_eq!(captures[1]["stream"], true);
}

#[tokio::test]
async fn responses_relay_json_and_sse_enter_fixed_topology_without_p6_direct_nodes() {
    let transport = JsonThenSseTransport {
        captures: Mutex::new(Vec::new()),
        turn: AtomicUsize::new(0),
    };

    let json_output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-responses-relay-json".into(),
            payload: json!({
                "model":"client-responses",
                "input":"json",
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    assert_eq!(json_output.status, 200);
    assert_eq!(json_output.node_trace, EXPECTED_RELAY_TRACE);
    assert!(!json_output
        .node_trace
        .contains(&"V3Req04StandardizedResponses"));
    let direct_policy_node = format!("{}{}{}", "V3Responses", "Direct", "11Policy");
    assert!(!json_output
        .node_trace
        .iter()
        .any(|node| *node == direct_policy_node));
    assert!(!json_output.node_trace.contains(&"V3TargetLocalReselected"));
    let json_observability = json_output
        .observability
        .as_ref()
        .expect("Responses Relay JSON output must carry console observability");
    assert_eq!(
        json_observability.routing_group_id.as_deref(),
        Some("controlled")
    );
    assert_eq!(json_observability.pool_id.as_deref(), Some("default"));
    assert_eq!(
        json_observability.provider_id.as_deref(),
        Some("controlled")
    );
    assert_eq!(
        json_observability.provider_key.as_deref(),
        Some("controlled:controlled:responses-wire-model")
    );
    assert_eq!(
        json_observability.model_id.as_deref(),
        Some("responses-wire-model")
    );
    assert_eq!(
        json_observability.wire_model.as_deref(),
        Some("responses-wire-model")
    );
    assert_eq!(json_observability.provider_status, Some(200));
    assert_eq!(
        json_observability.response_status.as_deref(),
        Some("completed")
    );
    assert_eq!(
        json_observability.finish_reason.as_deref(),
        Some("stop"),
        "ordinary completed Responses Relay JSON without provider finish_reason must infer stop for console observability"
    );
    assert_eq!(
        json_observability
            .usage
            .as_ref()
            .and_then(|usage| usage.input_tokens),
        Some(11)
    );
    assert_eq!(
        json_observability
            .usage
            .as_ref()
            .and_then(|usage| usage.output_tokens),
        Some(5)
    );
    assert_eq!(
        json_observability
            .usage
            .as_ref()
            .and_then(|usage| usage.cached_tokens),
        Some(3)
    );
    match json_output.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["id"], "resp_closeout_json");
            assert_eq!(body["status"], "completed");
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("JSON request must project JSON body"),
    }

    let sse_output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-responses-relay-sse".into(),
            payload: json!({
                "model":"client-responses",
                "input":"sse",
                "stream":true
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    assert_eq!(sse_output.status, 200);
    assert_eq!(sse_output.node_trace, EXPECTED_RELAY_TRACE);
    let sse_observability = sse_output
        .observability
        .as_ref()
        .expect("Responses Relay SSE output must carry console observability");
    assert_eq!(sse_observability.transport, "sse");
    assert_eq!(
        sse_observability.response_status.as_deref(),
        Some("completed")
    );
    assert_eq!(
        sse_observability.finish_reason.as_deref(),
        Some("tool_calls"),
        "Responses Relay SSE with materialized local tool calls must keep tool_calls observability"
    );
    assert_eq!(sse_observability.provider_status, Some(200));
    let stream_observation = sse_output
        .stream_observation
        .clone()
        .expect("Responses Relay SSE output must expose stream observability");
    match sse_output.client_body {
        V3ResponsesRelayClientBody::Sse(mut stream) => {
            let mut forwarded = Vec::new();
            while let Some(chunk) = stream.next().await {
                forwarded.extend(chunk.expect("controlled SSE chunk must pass through unchanged"));
            }
            assert!(String::from_utf8(forwarded)
                .unwrap()
                .contains("\"input_tokens\":13"));
        }
        V3ResponsesRelayClientBody::Json(_) => panic!("SSE request must project SSE stream"),
    }
    let stream_snapshot = stream_observation
        .snapshot()
        .expect("SSE usage observation state must stay readable");
    assert_eq!(
        stream_snapshot.response_status.as_deref(),
        Some("completed")
    );
    assert_eq!(
        stream_snapshot.finish_reason.as_deref(),
        Some("tool_calls"),
        "stream observation used by closeout must preserve local tool-call finish reason"
    );
    assert_eq!(
        stream_snapshot
            .usage
            .as_ref()
            .and_then(|usage| usage.input_tokens),
        Some(13)
    );
    assert_eq!(
        stream_snapshot
            .usage
            .as_ref()
            .and_then(|usage| usage.output_tokens),
        Some(7)
    );
    assert_eq!(
        stream_snapshot
            .usage
            .as_ref()
            .and_then(|usage| usage.cached_tokens),
        Some(4)
    );
    assert_eq!(
        stream_snapshot
            .usage
            .as_ref()
            .and_then(|usage| usage.total_tokens),
        Some(20)
    );

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(captures[0]["model"], "responses-wire-model");
    assert_eq!(captures[0]["input"], "json");
    assert_eq!(captures[1]["model"], "responses-wire-model");
    assert_eq!(captures[1]["stream"], true);
}

struct CompletedTextSseTransport;

#[async_trait]
impl ResponsesTransport for CompletedTextSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let completed = json!({
            "type":"response.completed",
            "response":{
                "id":"resp_completed_text_sse",
                "status":"completed",
                "output":[{"type":"output_text","text":"done"}],
                "usage":{
                    "input_tokens":17,
                    "input_tokens_details":{"cached_tokens":5},
                    "output_tokens":3,
                    "total_tokens":20
                }
            }
        });
        let stream = futures_util::stream::iter([
            Ok(format!("event: response.completed\ndata: {completed}\n\n").into_bytes()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]);
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream),
        ))
    }
}

#[tokio::test]
async fn responses_relay_sse_completed_without_provider_finish_reason_infers_stop_observability() {
    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-responses-relay-sse-stop-observability".into(),
            payload: json!({
                "model":"client-responses",
                "input":"sse text",
                "stream":true
            }),
        },
        &CompletedTextSseTransport,
    )
    .await
    .unwrap();
    let observability = output
        .observability
        .as_ref()
        .expect("Responses Relay SSE text output must carry console observability");
    assert_eq!(observability.response_status.as_deref(), Some("completed"));
    assert_eq!(
        observability.finish_reason.as_deref(),
        Some("stop"),
        "completed text SSE without provider finish_reason must infer stop for console observability"
    );
    assert_eq!(
        observability
            .usage
            .as_ref()
            .and_then(|usage| usage.cached_tokens),
        Some(5)
    );
    let stream_observation = output
        .stream_observation
        .clone()
        .expect("Responses Relay SSE text output must expose stream observability");
    match output.client_body {
        V3ResponsesRelayClientBody::Sse(mut stream) => {
            let mut forwarded = Vec::new();
            while let Some(chunk) = stream.next().await {
                forwarded.extend(chunk.expect("controlled SSE text chunk must project"));
            }
            let text = String::from_utf8(forwarded).unwrap();
            assert!(text.contains("event: response.output_item.done"));
            assert!(text.contains("event: response.completed"));
            assert!(text.contains("data: [DONE]"));
        }
        V3ResponsesRelayClientBody::Json(_) => panic!("SSE request must project SSE stream"),
    }
    let snapshot = stream_observation
        .snapshot()
        .expect("SSE text observation state must stay readable");
    assert_eq!(snapshot.response_status.as_deref(), Some("completed"));
    assert_eq!(snapshot.finish_reason.as_deref(), Some("stop"));
    assert_eq!(
        snapshot.usage.as_ref().and_then(|usage| usage.total_tokens),
        Some(20)
    );
}

struct ServertoolContinuationTransport {
    captures: Mutex<Vec<Value>>,
    responses: Mutex<VecDeque<Value>>,
}

#[async_trait]
impl ResponsesTransport for ServertoolContinuationTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures.lock().unwrap().push(request.body().clone());
        let response = self.responses.lock().unwrap().pop_front().unwrap();
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&response).unwrap(),
        ))
    }
}

#[tokio::test]
async fn local_continuation_servertool_roundtrip_is_runtime_e2e() {
    let transport = ServertoolContinuationTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_servertool_1",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_servertool_1",
                    "name":"servertool.exec",
                    "arguments":"{\"cmd\":\"pwd\"}"
                }]
            }),
            json!({
                "id":"resp_servertool_2",
                "status":"completed",
                "output":[{"type":"output_text","text":"done"}]
            }),
        ])),
    };
    let state = V3AnthropicRelayLocalContinuationState::default();
    let scope = V3AnthropicRelayLocalContinuationScope::anthropic(
        "/v1/messages",
        "session-closeout",
        "conversation-closeout",
        5555,
        "controlled",
    );

    let first = execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile(
        &manifest(),
        request(
            "req-servertool-1",
            json!([{"role":"user","content":"run pwd"}]),
            false,
        ),
        &transport,
        &state,
        scope.clone(),
        1_000,
        ["servertool.exec"],
    )
    .await
    .unwrap();
    assert_eq!(first.node_trace, EXPECTED_RELAY_TRACE);
    assert!(first.servertool_followup_required);
    assert_eq!(first.client_response["stop_reason"], "tool_use");
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile(
        &manifest(),
        request(
            "req-servertool-2",
            json!([{"role":"user","content":[{
                "type":"tool_result",
                "tool_use_id":"call_servertool_1",
                "content":"ok"
            }]}]),
            false,
        ),
        &transport,
        &state,
        scope,
        2_000,
        ["servertool.exec"],
    )
    .await
    .unwrap();
    assert_eq!(second.node_trace, EXPECTED_RELAY_TRACE);
    assert!(!second.servertool_followup_required);
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(
        captures[1]["input"],
        json!([
            {
                "type":"function_call",
                "call_id":"call_servertool_1",
                "name":"servertool.exec",
                "arguments":"{\"cmd\":\"pwd\"}"
            },
            {
                "type":"function_call_output",
                "call_id":"call_servertool_1",
                "output":"ok"
            }
        ])
    );
    let provider_wire = serde_json::to_string(&captures[1]).unwrap();
    let client_wire = serde_json::to_string(&second.client_response).unwrap();
    for forbidden in [
        "session-closeout",
        "conversation-closeout",
        "routecodex",
        "continuation_store",
        "metadata_center",
    ] {
        assert!(!provider_wire.contains(forbidden));
        assert!(!client_wire.contains(forbidden));
    }
}

struct ErrorTransport;

#[async_trait]
impl ResponsesTransport for ErrorTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Err(V3ProviderError::HttpStatus {
            response: Box::new(V3ProviderHttpFailure {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                status: 429,
                headers: vec![],
                body: br#"{"error":{"type":"rate_limit_error","message":"controlled"}}"#.to_vec(),
            }),
        })
    }
}

struct ResponsesContextErrorThenSuccessTransport {
    captures: Mutex<Vec<(String, Value)>>,
}

#[async_trait]
impl ResponsesTransport for ResponsesContextErrorThenSuccessTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures
            .lock()
            .unwrap()
            .push((request.provider_id().to_string(), request.body().clone()));
        if request.provider_id() == "limited" {
            return Err(V3ProviderError::HttpStatus {
                response: Box::new(V3ProviderHttpFailure {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    status: 400,
                    headers: vec![],
                    body: br#"{"error":{"code":"bad_response_status_code","type":"bad_response_status_code","message":"This model's maximum context length is 202752 tokens. However, your messages resulted in 206624 tokens. Please reduce the length of the messages."}}"#.to_vec(),
                }),
            });
        }
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"resp_context_retry",
                "status":"completed",
                "output":[{"type":"output_text","text":"retried"}],
                "usage":{
                    "input_tokens":206624,
                    "input_tokens_details":{"cached_tokens":205000},
                    "output_tokens":4,
                    "total_tokens":206628
                }
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn responses_relay_provider_context_error_reselects_next_candidate_before_projection() {
    let transport = ResponsesContextErrorThenSuccessTransport {
        captures: Mutex::new(Vec::new()),
    };
    let output = execute_v3_responses_relay_runtime(
        &responses_reselect_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-responses-context-reselect".into(),
            payload: json!({
                "model":"client-responses",
                "input":"same large payload",
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    assert!(output.error_chain.is_none());
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    let observability = output
        .observability
        .as_ref()
        .expect("successful retry must keep console observability");
    assert_eq!(observability.provider_id.as_deref(), Some("minimax"));
    assert_eq!(
        observability.provider_key.as_deref(),
        Some("minimax:key1:MiniMax-M3")
    );
    assert_eq!(observability.provider_status, Some(200));
    assert_eq!(observability.attempts, Some(2));
    assert_eq!(
        observability.unavailable_candidates,
        vec!["limited:key1:gpt-5.5".to_string()]
    );
    assert_eq!(
        observability
            .usage
            .as_ref()
            .and_then(|usage| usage.input_tokens),
        Some(206624)
    );

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(captures[0].0, "limited");
    assert_eq!(captures[1].0, "minimax");
}

#[tokio::test]
async fn responses_relay_shared_health_cools_provider_key_after_three_cross_request_failures() {
    let manifest = responses_reselect_manifest();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let transport = ResponsesContextErrorThenSuccessTransport {
        captures: Mutex::new(Vec::new()),
    };

    for turn in 0..3 {
        let output = execute_v3_responses_relay_runtime_with_health_and_retry_policy(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "controlled".into(),
                request_id: format!("req-responses-context-reselect-{turn}"),
                payload: json!({
                    "model":"client-responses",
                    "input":"same large payload",
                    "stream":false
                }),
            },
            &transport,
            &provider_health,
            V3ResponsesRelayRetryPolicy {
                same_candidate_retries: 3,
                retry_delay_ms: 0,
            },
        )
        .await
        .unwrap();
        assert_eq!(output.status, 200);
        assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
        assert_eq!(
            output
                .observability
                .as_ref()
                .and_then(|observability| observability.provider_key.as_deref()),
            Some("minimax:key1:MiniMax-M3")
        );
    }

    let output = execute_v3_responses_relay_runtime_with_health_and_retry_policy(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-responses-context-reselect-cooled".into(),
            payload: json!({
                "model":"client-responses",
                "input":"same large payload",
                "stream":false
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 3,
            retry_delay_ms: 0,
        },
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    let observability = output
        .observability
        .as_ref()
        .expect("cooled provider run must keep route observability");
    assert_eq!(
        observability.provider_key.as_deref(),
        Some("minimax:key1:MiniMax-M3")
    );
    assert_eq!(observability.attempts, Some(1));
    assert!(observability
        .unavailable_candidates
        .contains(&"limited:key1:gpt-5.5".to_string()));

    let captures = transport.captures.lock().unwrap();
    let provider_sequence: Vec<&str> = captures
        .iter()
        .map(|(provider_id, _)| provider_id.as_str())
        .collect();
    assert_eq!(
        provider_sequence,
        vec!["limited", "minimax", "limited", "minimax", "limited", "minimax", "minimax"]
    );
}

#[tokio::test]
async fn responses_relay_provider_error_projects_only_after_candidate_exhaustion() {
    let transport = ResponsesContextErrorThenSuccessTransport {
        captures: Mutex::new(Vec::new()),
    };
    let output = execute_v3_responses_relay_runtime_with_retry_policy(
        &responses_single_limited_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-responses-context-exhausted".into(),
            payload: json!({
                "model":"client-responses",
                "input":"same large payload",
                "stream":false
            }),
        },
        &transport,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 3,
            retry_delay_ms: 0,
        },
    )
    .await
    .unwrap();

    assert_eq!(output.status, 400);
    assert_eq!(
        output.error_chain.as_ref().unwrap(),
        &V3_ERROR_CHAIN_NODE_IDS
    );
    assert!(!output.node_trace.contains(&"V3ProviderRespInbound01Raw"));
    assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
    let observability = output
        .observability
        .as_ref()
        .expect("exhausted error must keep console observability");
    assert_eq!(observability.provider_id.as_deref(), Some("limited"));
    assert_eq!(observability.provider_status, Some(400));
    assert_eq!(observability.response_status.as_deref(), Some("error"));
    assert_eq!(observability.attempts, Some(4));
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 4);
    assert!(captures
        .iter()
        .all(|(provider_id, _)| provider_id == "limited"));
}

#[test]
fn provider_key_consecutive_failures_cool_for_fifteen_minutes_without_cross_model_pollution() {
    let store = V3ProviderHealthStore::from_manifest(&responses_single_limited_manifest());
    for (index, now_ms) in [1_000, 2_000, 3_000].into_iter().enumerate() {
        let record = store
            .record_provider_failure(
                "limited",
                Some("key1"),
                Some("gpt-5.5"),
                Some(&format!("controlled failure {}", index + 1)),
                now_ms,
            )
            .unwrap();
        if index < 2 {
            assert_eq!(record.state, "healthy");
            assert_eq!(record.cooldown_until_ms, None);
        } else {
            assert_eq!(record.state, "cooldown");
            assert_eq!(record.failure_count, 3);
            assert_eq!(record.cooldown_until_ms, Some(903_000));
        }
    }
    assert!(
        !store
            .availability("limited", Some("key1"), Some("gpt-5.5"), 902_999)
            .available
    );
    assert!(
        store
            .availability("limited", Some("key1"), Some("gpt-5.5"), 903_000)
            .available
    );
    assert!(
        store
            .availability("limited", Some("key1"), Some("other-model"), 3_001)
            .available
    );
    assert!(
        store
            .availability("limited", Some("other-key"), Some("gpt-5.5"), 3_001)
            .available
    );
}

#[tokio::test]
async fn provider_error_closeout_enters_error01_06_without_success_projection() {
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(),
        request(
            "req-closeout-error",
            json!([{"role":"user","content":"fail"}]),
            false,
        ),
        &ErrorTransport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 429);
    assert_eq!(output.client_response["type"], "error");
    assert_eq!(
        output.error_chain.as_ref().unwrap(),
        &V3_ERROR_CHAIN_NODE_IDS
    );
    assert!(!output.node_trace.contains(&"V3ProviderRespInbound01Raw"));
    assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
    assert!(!output.servertool_followup_required);
}

fn responses_reselect_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 5555
routing_group = "controlled"
endpoints = ["responses"]
[providers.limited]
type = "responses"
base_url = "http://limited.invalid/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [{ alias = "key1", env = "LIMITED_KEY" }] }
[providers.limited.models."gpt-5.5"]
wire_name = "gpt-5.5"
supports_streaming = true
supports_thinking = true
max_context_tokens = 200000
capabilities = ["text", "tools", "reasoning", "streaming"]
[providers.minimax]
type = "responses"
base_url = "http://minimax.invalid/v1"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MINIMAX_KEY" }] }
[providers.minimax.models."MiniMax-M3"]
wire_name = "MiniMax-M3"
supports_streaming = true
supports_thinking = true
max_context_tokens = 1000000
capabilities = ["text", "tools", "reasoning", "streaming"]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "limited", model = "gpt-5.5", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", priority = 2 }
]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn responses_single_limited_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 5555
routing_group = "controlled"
endpoints = ["responses"]
[providers.limited]
type = "responses"
base_url = "http://limited.invalid/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [{ alias = "key1", env = "LIMITED_KEY" }] }
[providers.limited.models."gpt-5.5"]
wire_name = "gpt-5.5"
supports_streaming = true
supports_thinking = true
max_context_tokens = 200000
capabilities = ["text", "tools", "reasoning", "streaming"]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "limited", model = "gpt-5.5", key = "key1", priority = 1 }
]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn request(request_id: &str, messages: Value, stream: bool) -> V3AnthropicRelayRuntimeInput {
    V3AnthropicRelayRuntimeInput {
        server_id: "controlled".into(),
        request_id: request_id.into(),
        payload: json!({
            "model":"claude-client-alias",
            "messages":messages,
            "tools":[{"name":"servertool.exec","input_schema":{"type":"object"}}],
            "stream":stream
        }),
    }
}

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 5555
routing_group = "controlled"
endpoints = ["anthropic"]
[providers.controlled]
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "responses-wire-model"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "CONTROLLED_KEY" }] }
[providers.controlled.models.responses-wire-model]
wire_name = "responses-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning", "streaming"]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}
