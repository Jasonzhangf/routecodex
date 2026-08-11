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
    time::{Duration, Instant},
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

fn assert_relay_trace(trace: &[&'static str]) {
    let semantic_trace = trace
        .iter()
        .copied()
        .filter(|node| *node != "V3ProviderActionGateAdmission")
        .collect::<Vec<_>>();
    assert_eq!(semantic_trace, EXPECTED_RELAY_TRACE);
}

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

struct SingleJsonCaptureTransport {
    captures: Mutex<Vec<Value>>,
    response: Value,
}

#[async_trait]
impl ResponsesTransport for SingleJsonCaptureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures.lock().unwrap().push(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&self.response).unwrap(),
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
    assert_relay_trace(&json_output.node_trace);
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
    assert_relay_trace(&sse_output.node_trace);
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
    assert_relay_trace(&json_output.node_trace);
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
    assert_eq!(
        json_observability.pool_id.as_deref(),
        Some("client_responses")
    );
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
    let json_timing = json_observability
        .timing
        .expect("Responses Relay JSON success must publish Runtime timing");
    assert_eq!(
        json_timing.internal.checked_add(json_timing.external),
        Some(json_timing.runtime_total)
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
    assert_relay_trace(&sse_output.node_trace);
    let sse_observability = sse_output
        .observability
        .as_ref()
        .expect("Responses Relay SSE output must carry console observability");
    assert_eq!(sse_observability.transport, "sse");
    assert_eq!(
        sse_observability.response_status.as_deref(),
        Some("requires_action"),
        "Hub response hooks must finalize tool-call SSE semantics before client SSE framing"
    );
    assert_eq!(
        sse_observability.finish_reason.as_deref(),
        Some("tool_calls"),
        "Responses Relay must keep SSE as transport-only: Responses event payload codec builds Hub semantic, hooks run in Hub, and client event payload codec encodes finalized frames"
    );
    assert_eq!(sse_observability.provider_status, Some(200));
    let sse_timing = sse_observability
        .timing
        .expect("materialized Responses Relay SSE must publish Runtime timing");
    assert_eq!(
        sse_timing.internal.checked_add(sse_timing.external),
        Some(sse_timing.runtime_total)
    );
    let stream_observation = sse_output
        .stream_observation
        .clone()
        .expect("Responses Relay SSE output must expose stream observability");
    assert_eq!(
        stream_observation.snapshot().unwrap().timing,
        Some(sse_timing)
    );
    match sse_output.client_body {
        V3ResponsesRelayClientBody::Sse(mut stream) => {
            let mut forwarded = Vec::new();
            while let Some(chunk) = stream.next().await {
                forwarded.extend(chunk.expect("controlled SSE chunk must project"));
            }
            let text = String::from_utf8(forwarded).unwrap();
            assert!(text.contains("event: response.output_item.added"));
            assert!(text.contains("event: response.function_call_arguments.done"));
            assert!(text.contains("event: response.output_item.done"));
            assert!(text.contains("event: response.completed"));
            assert!(text.contains("event: response.done"));
            assert!(!text.contains("event: response.requires_action"));
            assert!(text.contains("\"status\":\"requires_action\""));
            assert!(
                text.find("event: response.output_item.added").unwrap()
                    < text
                        .find("event: response.function_call_arguments.done")
                        .unwrap()
                    && text
                        .find("event: response.function_call_arguments.done")
                        .unwrap()
                        < text.find("event: response.output_item.done").unwrap()
                    && text.find("event: response.output_item.done").unwrap()
                        < text.find("event: response.completed").unwrap()
                    && text.find("event: response.completed").unwrap()
                    < text.find("event: response.done").unwrap()
                    && text.find("event: response.done").unwrap()
                        < text.find("data: [DONE]").unwrap(),
                "Responses Relay client tool-call SSE ordering must be output_item.added -> function_call_arguments.done -> output_item.done -> response.completed -> response.done -> [DONE]: {text}"
            );
            assert!(text.contains("\"input_tokens\":13"));
            assert!(
                !text.contains("event: response.function_call_arguments.delta"),
                "Responses Relay client SSE transport must not raw-pass provider argument event payloads around Hub: {text}"
            );
        }
        V3ResponsesRelayClientBody::Json(_) => panic!("SSE request must project SSE stream"),
    }
    let stream_snapshot = stream_observation
        .snapshot()
        .expect("SSE usage observation state must stay readable");
    assert_eq!(
        stream_snapshot.response_status.as_deref(),
        Some("requires_action")
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
    assert!(captures[0].get("instructions").is_none());
    assert_eq!(captures[0]["input"][0]["content"][0]["text"], "json");
    assert!(!captures[0].to_string().contains("当前轮推进准则"));
    assert_eq!(captures[1]["model"], "responses-wire-model");
    assert_eq!(captures[1]["stream"], true);
    assert!(captures[1].get("instructions").is_none());
    assert_eq!(captures[1]["input"][0]["content"][0]["text"], "sse");
    assert!(!captures[1].to_string().contains("当前轮推进准则"));
}

#[tokio::test]
async fn responses_relay_client_sse_request_projects_sse_even_when_provider_returns_json() {
    let transport = SingleJsonCaptureTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"resp_sse_request_json_provider",
            "status":"completed",
            "output":[{"type":"output_text","text":"json upstream"}],
            "usage":{"input_tokens":8,"output_tokens":2,"total_tokens":10}
        }),
    };

    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-relay-client-sse-provider-json".into(),
            payload: json!({
                "model":"client-responses",
                "input":"provider may return json",
                "stream":true
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    assert_relay_trace(&output.node_trace);
    let observability = output
        .observability
        .as_ref()
        .expect("client SSE projection must keep console observability");
    assert_eq!(
        observability.transport, "sse",
        "transport observability must describe the client response projection, not downgrade to provider JSON"
    );
    assert_eq!(observability.response_status.as_deref(), Some("completed"));
    match output.client_body {
        V3ResponsesRelayClientBody::Sse(mut stream) => {
            let mut forwarded = Vec::new();
            while let Some(chunk) = stream.next().await {
                forwarded.extend(chunk.expect("JSON provider response must project as client SSE"));
            }
            let text = String::from_utf8(forwarded).unwrap();
            assert!(text.contains("event: response.created"));
            assert!(text.contains("event: response.output_item.done"));
            assert!(text.contains("event: response.completed"));
            assert!(text.contains("event: response.done"));
            assert!(text.contains("data: [DONE]"));
            assert!(text.contains("json upstream"));
        }
        V3ResponsesRelayClientBody::Json(_) => {
            panic!("client stream=true must not be downgraded to JSON when provider returned JSON")
        }
    }

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    assert_eq!(
        captures[0]["stream"], true,
        "provider request side must still ask upstream for stream/SSE"
    );
}

#[tokio::test]
async fn responses_relay_responses_target_builds_responses_standard_payload_from_chat_canonical() {
    let transport = SingleJsonCaptureTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"resp_responses_standard_payload",
            "status":"completed",
            "output":[{"type":"output_text","text":"ok"}],
            "usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}
        }),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-standard-payload".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "tools":[
                    {
                        "type":"tool_search",
                        "execution":"client",
                        "description":"Search deferred tools",
                        "parameters":{
                            "type":"object",
                            "properties":{"query":{"type":"string"},"limit":{"type":"number"}},
                            "required":["query"],
                            "additionalProperties":false
                        }
                    },
                    {"type":"web_search","external_web_access":true}
                ],
                "input":[{
                    "type":"message",
                    "role":"user",
                    "content":[{"type":"input_text","text":"search docs"}]
                }]
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 200);

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    let body = &captures[0];
    assert!(
        body.get("input").and_then(Value::as_array).is_some(),
        "Responses target must receive OpenAI Responses standard input built from Chat canonical: {body}"
    );
    assert!(
        body.get("messages").is_none(),
        "Responses target must not receive Chat canonical messages directly: {body}"
    );
    assert!(body.get("instructions").is_none());
    assert_eq!(body["input"][0]["type"], "message");
    assert_eq!(body["input"][0]["role"], "user");
    assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
    assert_eq!(body["input"][0]["content"][0]["text"], "search docs");
    assert_eq!(body["input"].as_array().map(Vec::len), Some(1));
    assert!(!body.to_string().contains("当前轮推进准则"));
    assert_eq!(body["tools"][0]["type"], "tool_search");
    let serialized = serde_json::to_string(body).unwrap();
    assert!(!serialized.contains("\"name\":\"exec\""));
    assert!(!serialized.contains("\"name\":\"script\""));
}

#[tokio::test]
async fn responses_relay_openai_chat_target_projects_registered_builtin_tools() {
    let transport = SingleJsonCaptureTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"chatcmpl_tool_search",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{
                "index":0,
                "message":{"role":"assistant","content":"ok"},
                "finish_reason":"stop"
            }],
            "usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}
        }),
    };
    let output = execute_v3_responses_relay_runtime(
        &openai_chat_target_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-openai-chat-tool-search".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "tools":[
                    {
                        "type":"tool_search",
                        "execution":"client",
                        "description":"Search deferred tools",
                        "parameters":{
                            "type":"object",
                            "properties":{"query":{"type":"string"},"limit":{"type":"number"}},
                            "required":["query"],
                            "additionalProperties":false
                        }
                    },
                    {"type":"web_search","external_web_access":true}
                ],
                "input":[{
                    "type":"message",
                    "role":"user",
                    "content":[{"type":"input_text","text":"search docs"}]
                }]
            }),
        },
        &transport,
    )
    .await
    .expect("Responses builtin tools must project a client-visible error");

    assert_eq!(output.status, 200);
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    assert!(captures[0].get("web_search_options").is_some());
}

#[tokio::test]
async fn responses_relay_openai_chat_target_passes_through_redacted_tool_schema_placeholders() {
    let transport = SingleJsonCaptureTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"chatcmpl_redacted_schema",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{
                "index":0,
                "message":{"role":"assistant","content":"ok"},
                "finish_reason":"stop"
            }],
            "usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}
        }),
    };
    let output = execute_v3_responses_relay_runtime(
        &openai_chat_target_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-openai-chat-redacted-tool-schema".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "tools":[{
                    "type":"function",
                    "name":"exec_command",
                    "description":"Runs a command.",
                    "parameters":{
                        "type":"object",
                        "properties":{
                            "cmd":{"type":"string"},
                            "max_output_tokens":"[REDACTED]",
                            "token_budget":"[REDACTED]"
                        },
                        "required":["cmd"],
                        "additionalProperties":false
                    },
                    "strict":false
                }],
                "input":[{
                    "type":"message",
                    "role":"user",
                    "content":[{"type":"input_text","text":"continue"}]
                }]
            }),
        },
        &transport,
    )
    .await
    .expect("redacted schema placeholders must pass through to provider wire");

    assert_eq!(output.status, 200);
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1, "redacted schema placeholders must reach provider wire");
    let wire_text = serde_json::to_string(&captures[0]).expect("wire serializable");
    assert!(
        wire_text.contains("[REDACTED]"),
        "client [REDACTED] schema placeholders must be passed through, got {wire_text}"
    );
}

#[tokio::test]
async fn responses_relay_openai_chat_target_keeps_tool_result_immediately_after_tool_call() {
    let transport = SingleJsonCaptureTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"chatcmpl_tool_pair_order",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{
                "index":0,
                "message":{"role":"assistant","content":"ok"},
                "finish_reason":"stop"
            }],
            "usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}
        }),
    };
    let output = execute_v3_responses_relay_runtime(
        &openai_chat_target_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-openai-chat-tool-pair-order".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "tools":[{
                    "type":"function",
                    "name":"exec_command",
                    "description":"run command",
                    "parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}
                }],
                "input":[
                    {
                        "type":"message",
                        "role":"user",
                        "content":[{"type":"input_text","text":"start"}]
                    },
                    {
                        "type":"function_call",
                        "id":"fc_call_order",
                        "call_id":"call_order",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"pwd\"}"
                    },
                    {
                        "type":"message",
                        "role":"assistant",
                        "content":[{"type":"output_text","text":"I will inspect the result next."}]
                    },
                    {
                        "type":"function_call_output",
                        "id":"fc_call_order",
                        "call_id":"call_order",
                        "output":"ok"
                    },
                    {
                        "type":"message",
                        "role":"user",
                        "content":[{"type":"input_text","text":"continue"}]
                    }
                ]
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    let captures = transport.captures.lock().unwrap();
    let body = captures.first().expect("provider request body");
    let messages = body["messages"]
        .as_array()
        .expect("OpenAI Chat provider messages");
    let tool_call_index = messages
        .iter()
        .position(|message| {
            message["tool_calls"].as_array().is_some_and(|tool_calls| {
                tool_calls
                    .iter()
                    .any(|call| call["id"].as_str() == Some("call_order"))
            })
        })
        .expect("assistant tool call message");
    assert_eq!(
        messages[tool_call_index]["content"],
        "I will inspect the result next.",
        "assistant text between Responses function_call and function_call_output must stay on the same Chat assistant tool-call turn"
    );
    let tool_result = messages
        .get(tool_call_index + 1)
        .expect("tool result must immediately follow assistant tool call");
    assert_eq!(tool_result["role"], "tool");
    assert_eq!(tool_result["tool_call_id"], "call_order");
    let next_user = messages
        .get(tool_call_index + 2)
        .expect("user turn must remain after the tool result");
    assert_eq!(next_user["role"], "user");
    assert_eq!(next_user["content"], "continue");
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
    assert_eq!(observability.finish_reason.as_deref(), Some("stop"));
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
            assert!(
                !text.contains("event: response.output_text.delta"),
                "Responses Relay client SSE transport must not raw-pass provider text event payloads around Hub: {text}"
            );
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

#[tokio::test]
async fn responses_relay_client_json_request_projects_json_even_when_provider_returns_sse() {
    let output = execute_v3_responses_relay_runtime(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-relay-client-json-provider-sse".into(),
            payload: json!({
                "model":"client-responses",
                "input":"provider may stream",
                "stream":false
            }),
        },
        &CompletedTextSseTransport,
    )
    .await
    .unwrap();
    let observability = output
        .observability
        .as_ref()
        .expect("client JSON projection must keep console observability");
    assert_eq!(
        observability.transport, "json",
        "client stream=false must not be upgraded to SSE just because provider returned SSE"
    );
    assert!(
        output.stream_observation.is_none(),
        "client JSON projection must not leave a server-side SSE closeout finalizer pending"
    );
    match output.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["id"], "resp_completed_text_sse");
            assert_eq!(body["status"], "completed");
            assert_eq!(body["output"][0]["text"], "done");
        }
        V3ResponsesRelayClientBody::Sse(_) => {
            panic!("client stream=false must not be upgraded to SSE when provider returned SSE")
        }
    }
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
    assert_relay_trace(&first.node_trace);
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
    assert_relay_trace(&second.node_trace);
    assert!(!second.servertool_followup_required);
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(
        captures[1]["input"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                let mut item = item.clone();
                item.as_object_mut().unwrap().remove("id");
                item
            })
            .collect::<Vec<_>>(),
        vec![
            {
                json!({"type":"function_call","call_id":"call_servertool_1","name":"servertool.exec","arguments":"{\"cmd\":\"pwd\"}"})
            },
            { json!({"type":"function_call_output","call_id":"call_servertool_1","output":"ok"}) }
        ]
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

struct ResponsesCompatStormTransport {
    sends: Mutex<Vec<Instant>>,
}

#[async_trait]
impl ResponsesTransport for ResponsesCompatStormTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.sends.lock().unwrap().push(Instant::now());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"resp_compat_storm_retry",
                "status":"completed",
                "output":[{"type":"output_text","text":"serialized"}]
            }))
            .unwrap(),
        ))
    }
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

struct ResponsesMalformedJsonThenSuccessTransport {
    captures: Mutex<Vec<(String, Value)>>,
}

#[async_trait]
impl ResponsesTransport for ResponsesMalformedJsonThenSuccessTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures
            .lock()
            .unwrap()
            .push((request.provider_id().to_string(), request.body().clone()));
        if request.provider_id() == "limited" {
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
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"resp_malformed_retry",
                "status":"completed",
                "output":[{"type":"output_text","text":"retried after malformed provider JSON"}],
                "usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}
            }))
            .unwrap(),
        ))
    }
}

struct ResponsesDuplicateToolIdentityThenSuccessTransport {
    captures: Mutex<Vec<(String, Value)>>,
    stream_response: bool,
}

#[async_trait]
impl ResponsesTransport for ResponsesDuplicateToolIdentityThenSuccessTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures
            .lock()
            .unwrap()
            .push((request.provider_id().to_string(), request.body().clone()));
        let response = if request.provider_id() == "limited" {
            json!({
                "id":"resp_duplicate_tool_identity",
                "status":"requires_action",
                "output":[
                    {
                        "type":"function_call",
                        "id":"fc_duplicate_a",
                        "call_id":"call_duplicate",
                        "name":"lookup",
                        "arguments":"{\"query\":\"first\"}"
                    },
                    {
                        "type":"function_call",
                        "id":"fc_duplicate_b",
                        "call_id":"call_duplicate",
                        "name":"lookup_again",
                        "arguments":"{\"query\":\"second\"}"
                    }
                ]
            })
        } else {
            json!({
                "id":"resp_after_duplicate_tool_identity",
                "status":"requires_action",
                "output":[
                    {
                        "type":"function_call",
                        "id":"fc_distinct_a",
                        "call_id":"call_distinct_a",
                        "name":"lookup",
                        "arguments":"{\"query\":\"first\"}"
                    },
                    {
                        "type":"function_call",
                        "id":"fc_distinct_b",
                        "call_id":"call_distinct_b",
                        "name":"lookup_again",
                        "arguments":"{\"query\":\"second\"}"
                    }
                ],
                "usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}
            })
        };
        let headers = vec![V3ProviderResponseHeader {
            name: "content-type".to_string(),
            value: if self.stream_response {
                b"text/event-stream".to_vec()
            } else {
                b"application/json".to_vec()
            },
        }];
        if self.stream_response {
            let frame = format!(
                "event: response.completed\ndata: {}\n\ndata: [DONE]\n\n",
                json!({"type":"response.completed","response":response})
            );
            return Ok(V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                headers,
                Box::pin(futures_util::stream::iter([Ok(frame.into_bytes())])),
            ));
        }
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            headers,
            serde_json::to_vec(&response).unwrap(),
        ))
    }
}

struct ResponsesDefaultFloorFailsThenSucceedsTransport {
    captures: Mutex<Vec<(String, Value)>>,
    fail_count: usize,
}

#[async_trait]
impl ResponsesTransport for ResponsesDefaultFloorFailsThenSucceedsTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut captures = self.captures.lock().unwrap();
        captures.push((request.provider_id().to_string(), request.body().clone()));
        if captures.len() <= self.fail_count {
            return Err(V3ProviderError::HttpStatus {
                response: Box::new(V3ProviderHttpFailure {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    status: 429,
                    headers: vec![],
                    body: br#"{"error":{"type":"rate_limit_error","message":"controlled default floor backoff"}}"#.to_vec(),
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
                "id":"resp_default_floor_retry",
                "status":"completed",
                "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],
                "usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}
            }))
            .unwrap(),
        ))
    }
}

struct ResponsesSseBodyReadErrorTransport;

#[async_trait]
impl ResponsesTransport for ResponsesSseBodyReadErrorTransport {
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
            Box::pin(futures_util::stream::iter([Err(
                V3ProviderError::ResponseBody {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    reason: "controlled response body read failure".to_string(),
                },
            )])),
        ))
    }
}

struct ResponsesSseInvalidUtf8Transport;

#[async_trait]
impl ResponsesTransport for ResponsesSseInvalidUtf8Transport {
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
            Box::pin(futures_util::stream::iter([Ok(b"data: \xff\n\n".to_vec())])),
        ))
    }
}

struct ResponsesSseMalformedEventJsonTransport;

#[async_trait]
impl ResponsesTransport for ResponsesSseMalformedEventJsonTransport {
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
            Box::pin(futures_util::stream::iter([Ok(
                b"event: response.output_item.added\ndata: {\"item\"\n\n".to_vec(),
            )])),
        ))
    }
}

struct ResponsesSseTerminalMissingTransport;

#[async_trait]
impl ResponsesTransport for ResponsesSseTerminalMissingTransport {
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
            Box::pin(futures_util::stream::iter([Ok(concat!(
                "event: response.output_text.delta\n",
                "data: {\"type\":\"response.output_text.delta\",\"response_id\":\"resp_missing_terminal\",\"delta\":\"partial\"}\n\n",
                "data: [DONE]\n\n",
            )
            .as_bytes()
            .to_vec())])),
        ))
    }
}

#[tokio::test]
async fn responses_relay_provider_context_error_reselects_next_candidate_before_projection() {
    let server_id = "responses_context_reselect";
    let manifest = responses_reselect_manifest_for_scope(server_id);
    let transport = ResponsesContextErrorThenSuccessTransport {
        captures: Mutex::new(Vec::new()),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
    let timing = observability
        .timing
        .expect("successful retry must publish accumulated Runtime timing");
    assert_eq!(
        timing.internal.checked_add(timing.external),
        Some(timing.runtime_total)
    );
    assert_eq!(
        observability.unavailable_candidates,
        vec!["limited:key1:gpt-5.5:availability(request_local_provider_failure)".to_string()]
    );
    assert_eq!(
        observability
            .usage
            .as_ref()
            .and_then(|usage| usage.input_tokens),
        Some(206624)
    );
    assert_eq!(observability.provider_failure_events.len(), 1);
    let provider_event = &observability.provider_failure_events[0];
    assert_eq!(provider_event.provider_key, "limited:key1:gpt-5.5");
    assert_eq!(provider_event.status, 400);
    assert_eq!(provider_event.action, "switch_provider");

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(captures[0].0, "limited");
    assert_eq!(captures[0].1["model"], "gpt-5.5");
    assert_eq!(captures[1].0, "minimax");
    assert_eq!(captures[1].1["model"], "MiniMax-M3");
    assert_ne!(
        captures[0].1["model"], captures[1].1["model"],
        "target-local reselection must bind each attempt from its own selected target"
    );
    assert_ne!(
        captures[1].1["model"], "client-responses",
        "the client route model must not leak into the reselected provider attempt"
    );
}

#[tokio::test]
async fn responses_relay_provider_response_decode_error_reselects_next_candidate_before_projection()
{
    let server_id = "responses_decode_reselect";
    let manifest = responses_reselect_manifest_for_scope(server_id);
    let transport = ResponsesMalformedJsonThenSuccessTransport {
        captures: Mutex::new(Vec::new()),
    };
    let output = execute_v3_responses_relay_runtime(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-malformed-provider-json-reselect".into(),
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
    assert_eq!(observability.provider_status, Some(200));
    assert_eq!(observability.attempts, Some(2));
    assert_eq!(
        observability.unavailable_candidates,
        vec!["limited:key1:gpt-5.5:availability(request_local_provider_failure)".to_string()]
    );
    assert_eq!(observability.provider_failure_events.len(), 1);
    let provider_event = &observability.provider_failure_events[0];
    assert_eq!(provider_event.provider_key, "limited:key1:gpt-5.5");
    assert_eq!(provider_event.status, 502);
    assert_eq!(provider_event.action, "switch_provider");
    assert_eq!(
        provider_event.next_provider_key.as_deref(),
        Some("minimax:key1:MiniMax-M3")
    );
    assert_eq!(provider_event.failure_count, 1);
    assert_eq!(provider_event.health_state, "healthy");

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(captures[0].0, "limited");
    assert_eq!(captures[1].0, "minimax");
}

#[tokio::test]
async fn responses_relay_provider_duplicate_tool_identity_reselects_before_projection_for_json_and_sse(
) {
    for (suffix, stream_response) in [("json", false), ("sse", true)] {
        let server_id = format!("responses_duplicate_tool_identity_{suffix}");
        let manifest = responses_reselect_manifest_for_scope(&server_id);
        let transport = ResponsesDuplicateToolIdentityThenSuccessTransport {
            captures: Mutex::new(Vec::new()),
            stream_response,
        };
        let output = execute_v3_responses_relay_runtime(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id,
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: format!("req-responses-duplicate-tool-identity-{suffix}"),
                payload: json!({
                    "model":"client-responses",
                    "input":"reject duplicate provider tool identity and reselect",
                    "stream":stream_response
                }),
            },
            &transport,
        )
        .await
        .expect("provider-origin Resp03 malformed tool identity must enter Error05 reselection");

        assert_eq!(output.status, 200);
        assert!(output.error_chain.is_none());
        assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
        let observability = output
            .observability
            .as_ref()
            .expect("successful retry must keep console observability");
        assert_eq!(observability.provider_id.as_deref(), Some("minimax"));
        assert_eq!(observability.provider_status, Some(200));
        assert_eq!(observability.attempts, Some(2));
        assert_eq!(observability.provider_failure_events.len(), 1);
        let provider_event = &observability.provider_failure_events[0];
        assert_eq!(provider_event.provider_key, "limited:key1:gpt-5.5");
        assert_eq!(provider_event.status, 502);
        assert_eq!(provider_event.action, "switch_provider");
        assert_eq!(
            provider_event.next_provider_key.as_deref(),
            Some("minimax:key1:MiniMax-M3")
        );

        let captures = transport.captures.lock().unwrap();
        assert_eq!(captures.len(), 2);
        assert_eq!(captures[0].0, "limited");
        assert_eq!(captures[1].0, "minimax");
    }
}

#[tokio::test]
async fn responses_relay_provider_duplicate_tool_identity_projects_typed_error_after_exhaustion() {
    let server_id = "responses_duplicate_tool_identity_terminal";
    let transport = ResponsesDuplicateToolIdentityThenSuccessTransport {
        captures: Mutex::new(Vec::new()),
        stream_response: false,
    };
    let output = execute_v3_responses_relay_runtime_with_retry_policy(
        &responses_single_limited_manifest_for_scope(server_id),
        V3ResponsesRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-duplicate-tool-identity-terminal".into(),
            payload: json!({
                "model":"client-responses",
                "input":"reject duplicate provider tool identity without a backup target",
                "stream":false
            }),
        },
        &transport,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 0,
        },
    )
    .await
    .expect("provider-origin Resp03 failure must terminate through typed Error05/Error06");

    assert_eq!(output.status, 502);
    assert_eq!(
        output.error_chain.as_ref().unwrap(),
        &V3_ERROR_CHAIN_NODE_IDS
    );
    assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
    let V3ResponsesRelayClientBody::Json(error_body) = output.client_body else {
        panic!("terminal provider response failure must project standard Responses JSON error")
    };
    assert!(error_body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .is_some_and(|message| message.contains("duplicate call_id/id")));
    assert_eq!(
        error_body.pointer("/error/stage").and_then(Value::as_str),
        Some("V3HubRespChatProcess03Governed")
    );
    assert_eq!(transport.captures.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn responses_relay_shared_health_cools_provider_key_after_three_cross_request_failures() {
    let server_id = "responses_shared_health";
    let manifest = responses_reselect_manifest_for_scope(server_id);
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let transport = ResponsesContextErrorThenSuccessTransport {
        captures: Mutex::new(Vec::new()),
    };
    let failure_session_scope = routecodex_v3_error::V3ProviderFailureSessionScope::new(
        "test-server",
        "test-group",
        "responses-shared-health-session",
    )
    .expect("test provider failure session scope");

    for turn in 0..3 {
        let output = execute_v3_responses_relay_runtime_with_health_and_retry_policy(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: server_id.into(),
                failure_session_scope: failure_session_scope.clone(),
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
        let observability = output
            .observability
            .as_ref()
            .expect("successful reroute must keep provider failure observability");
        assert_eq!(observability.provider_failure_events.len(), 1);
        assert_eq!(
            observability.provider_failure_events[0].action,
            "switch_provider"
        );
        assert_eq!(
            observability.provider_failure_events[0].wait_ms,
            Some(1_000)
        );
        if turn == 2 {
            assert_eq!(observability.provider_failure_events[0].failure_count, 3);
            assert_eq!(
                observability.provider_failure_events[0].health_state,
                "cooldown"
            );
            assert!(observability.provider_failure_events[0]
                .cooldown_until_ms
                .is_some());
        }
    }

    let output = execute_v3_responses_relay_runtime_with_health_and_retry_policy(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope,
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
        .iter()
        .any(|candidate| { candidate.starts_with("limited:key1:gpt-5.5:availability(") }));
    assert!(
        observability.provider_failure_events.is_empty(),
        "cooled provider must be skipped before network send; observed events: {:?}",
        observability.provider_failure_events
    );

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
async fn responses_relay_default_floor_retries_until_success_within_cap() {
    let server_id = "responses_default_floor_success";
    let transport = ResponsesDefaultFloorFailsThenSucceedsTransport {
        captures: Mutex::new(Vec::new()),
        fail_count: 2,
    };
    let output = execute_v3_responses_relay_runtime_with_retry_policy(
        &responses_single_limited_manifest_for_scope(server_id),
        V3ResponsesRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-context-exhausted".into(),
            payload: json!({
                "model":"gpt-5.5",
                "input":"same large payload",
                "stream":false
            }),
        },
        &transport,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: V3ResponsesRelayRetryPolicy::default().same_candidate_retries,
        },
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    assert_eq!(output.error_chain, None);
    assert!(output.node_trace.contains(&"V3DefaultFloorBackoffWait"));
    let observability = output
        .observability
        .as_ref()
        .expect("default floor retry success must keep console observability");
    assert_eq!(observability.provider_id.as_deref(), Some("limited"));
    assert_eq!(observability.provider_status, Some(200));
    assert_eq!(observability.response_status.as_deref(), Some("completed"));
    assert_eq!(observability.attempts, Some(3));
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 3);
    assert!(captures
        .iter()
        .all(|(provider_id, _)| provider_id == "limited"));
}

#[tokio::test]
async fn responses_relay_default_floor_projects_error_after_retry_cap() {
    let server_id = "responses_default_floor_terminal";
    let transport = ResponsesDefaultFloorFailsThenSucceedsTransport {
        captures: Mutex::new(Vec::new()),
        fail_count: usize::MAX,
    };
    let output = tokio::time::timeout(
        Duration::from_secs(14),
        execute_v3_responses_relay_runtime_with_retry_policy(
            &responses_single_limited_manifest_for_scope(server_id),
            V3ResponsesRelayRuntimeInput {
                server_id: server_id.into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-responses-default-floor-cap".into(),
                payload: json!({
                    "model":"gpt-5.5",
                    "input":"same large payload",
                    "stream":false
                }),
            },
            &transport,
            V3ResponsesRelayRetryPolicy {
                same_candidate_retries: 2,
            },
        ),
    )
    .await
    .expect("default floor must honor retry cap instead of storm-looping forever")
    .unwrap();

    assert_eq!(output.status, 429);
    assert_eq!(
        output.error_chain.as_ref().unwrap(),
        &V3_ERROR_CHAIN_NODE_IDS
    );
    assert!(!output.node_trace.contains(&"V3ProviderRespInbound01Raw"));
    assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
    assert_eq!(
        output
            .node_trace
            .iter()
            .filter(|node| **node == "V3DefaultFloorBackoffWait")
            .count(),
        2
    );
    let observability = output
        .observability
        .as_ref()
        .expect("default floor capped error must keep console observability");
    assert_eq!(observability.provider_id.as_deref(), Some("limited"));
    assert_eq!(observability.provider_status, Some(429));
    assert_eq!(observability.response_status.as_deref(), Some("error"));
    assert_eq!(observability.attempts, Some(3));
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 3);
    assert!(captures
        .iter()
        .all(|(provider_id, _)| provider_id == "limited"));
}

#[tokio::test]
async fn responses_relay_default_floor_retry_wait_blocks_between_errors() {
    let server_id = "responses_default_floor_wait";
    let transport = ResponsesDefaultFloorFailsThenSucceedsTransport {
        captures: Mutex::new(Vec::new()),
        fail_count: 1,
    };
    let started = Instant::now();
    let output = execute_v3_responses_relay_runtime_with_retry_policy(
        &responses_single_limited_manifest_for_scope(server_id),
        V3ResponsesRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-default-floor-waits".into(),
            payload: json!({
                "model":"gpt-5.5",
                "input":"same large payload",
                "stream":false
            }),
        },
        &transport,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 1,
        },
    )
    .await
    .unwrap();

    assert_eq!(output.status, 200);
    assert!(
        started.elapsed() >= Duration::from_millis(1_000),
        "default floor retry must consume the isolated one-second action gate"
    );
    assert_eq!(transport.captures.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn responses_relay_provider_request_compat_failure_reselects_without_action_gate() {
    let transport = ResponsesContextErrorThenSuccessTransport {
        captures: Mutex::new(Vec::new()),
    };
    let started = Instant::now();
    let output = execute_v3_responses_relay_runtime_with_retry_policy(
        &responses_request_compat_reselect_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "compat_reselect".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-provider-compat-reselect".into(),
            payload: json!({
                "model":"client-responses",
                "messages":[{"role":"user","content":"provider compat must reselect"}],
                "store":true,
                "stream":false
            }),
        },
        &transport,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 0,
        },
    )
    .await
    .expect("provider-bound request compat failure must reselect instead of bypassing Error05");

    assert_eq!(output.status, 200);
    assert_eq!(output.error_chain, None);
    assert!(
        started.elapsed() < Duration::from_millis(1_000),
        "request-local provider compat reselect must not consume provider action gate delay"
    );
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    let captures = transport.captures.lock().unwrap();
    assert_eq!(
        captures
            .iter()
            .map(|(provider_id, _)| provider_id.as_str())
            .collect::<Vec<_>>(),
        vec!["minimax"],
        "the incompatible Anthropic request must fail before send and only the reselected Responses provider may reach transport"
    );
}

#[tokio::test]
async fn concurrent_provider_request_compat_failures_do_not_serialize_request_local_reselects() {
    let manifest = responses_request_compat_storm_manifest();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let transport = ResponsesCompatStormTransport {
        sends: Mutex::new(Vec::new()),
    };
    let run = |request_id: &'static str| {
        execute_v3_responses_relay_runtime_with_health_and_retry_policy(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "compat_storm".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: request_id.into(),
                payload: json!({
                    "model":"client-responses",
                    "messages":[{"role":"user","content":"serialize provider compat failures"}],
                    "store":true,
                    "stream":false
                }),
            },
            &transport,
            &provider_health,
            V3ResponsesRelayRetryPolicy {
                same_candidate_retries: 0,
            },
        )
    };

    let (first, second) = tokio::join!(run("req-compat-storm-a"), run("req-compat-storm-b"));
    let first = first.expect("first compat failure must reselect through Error05");
    let second = second.expect("second compat failure must reselect through Error05");
    assert_eq!(first.status, 200);
    assert_eq!(second.status, 200);
    assert!(first.error_chain.is_none());
    assert!(second.error_chain.is_none());

    let sends = transport.sends.lock().unwrap();
    assert_eq!(sends.len(), 2, "only the compatible provider may be sent");
    let separation = sends[1].duration_since(sends[0]);
    assert!(
        separation < Duration::from_millis(1_000),
        "request-local compat reselects must not be serialized by provider action gate; observed {separation:?}"
    );
}

#[tokio::test]
async fn responses_relay_sse_body_read_error_is_not_projected_as_transport_malformed_sse() {
    let output = execute_v3_responses_relay_runtime_with_retry_policy(
        &responses_single_limited_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-sse-body-read-error".into(),
            payload: json!({
                "model":"client-responses",
                "input":"same payload",
                "stream":true
            }),
        },
        &ResponsesSseBodyReadErrorTransport,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 0,
        },
    )
    .await
    .unwrap();

    assert_eq!(output.status, 502);
    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("provider failure must project a JSON error body")
    };
    let message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .expect("projected provider error message");
    assert!(
        !message.contains("malformed SSE"),
        "SSE transport must not own provider response body/event codec failures: {message}"
    );
    assert!(
        message.contains("response body failed")
            || message.contains("provider response event codec failed"),
        "provider response failure must stay in response/body codec owner: {message}"
    );
}

#[tokio::test]
async fn responses_relay_terminal_missing_fails_explicitly_but_fresh_request_bypasses_recovery() {
    let server_id = "responses_terminal_missing_fresh_isolation";
    let manifest = responses_single_limited_manifest_for_scope(server_id);
    let failed = execute_v3_responses_relay_runtime_with_retry_policy(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-terminal-missing".into(),
            payload: json!({
                "model":"client-responses",
                "input":"truncated stream",
                "stream":true
            }),
        },
        &ResponsesSseTerminalMissingTransport,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 0,
        },
    )
    .await
    .unwrap();

    assert_eq!(failed.status, 502);
    let V3ResponsesRelayClientBody::Json(error_body) = failed.client_body else {
        panic!("terminal-missing provider stream must project an explicit JSON error")
    };
    assert!(error_body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .is_some_and(|message| message.contains("response.completed")));

    let success_transport = SingleJsonCaptureTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id":"resp_after_terminal_missing",
            "status":"completed",
            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fresh request succeeded"}]}]
        }),
    };
    let fresh = tokio::time::timeout(
        Duration::from_millis(500),
        execute_v3_responses_relay_runtime_with_retry_policy(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: server_id.into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-responses-after-terminal-missing".into(),
                payload: json!({
                    "model":"client-responses",
                    "input":"fresh request",
                    "stream":false
                }),
            },
            &success_transport,
            V3ResponsesRelayRetryPolicy {
                same_candidate_retries: 0,
            },
        ),
    )
    .await
    .expect("fresh Responses request consumed the prior terminal-missing recovery lane")
    .unwrap();
    assert_eq!(fresh.status, 200);
    assert_eq!(success_transport.captures.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn responses_relay_invalid_sse_framing_stays_transport_malformed_sse() {
    let output = execute_v3_responses_relay_runtime_with_retry_policy(
        &responses_single_limited_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-sse-invalid-utf8".into(),
            payload: json!({
                "model":"client-responses",
                "input":"same payload",
                "stream":true
            }),
        },
        &ResponsesSseInvalidUtf8Transport,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 0,
        },
    )
    .await
    .unwrap();

    assert_eq!(output.status, 502);
    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("provider failure must project a JSON error body")
    };
    let message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .expect("projected provider error message");
    assert!(
        message.contains("malformed SSE"),
        "actual frame/UTF-8 failures remain SSE transport-owned: {message}"
    );
    assert!(
        message.contains("provider SSE transport failed"),
        "transport error must name transport owner: {message}"
    );
}

#[tokio::test]
async fn responses_relay_event_payload_json_error_is_not_transport_malformed_sse() {
    let output = execute_v3_responses_relay_runtime_with_retry_policy(
        &responses_single_limited_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-sse-malformed-event-json".into(),
            payload: json!({
                "model":"client-responses",
                "input":"same payload",
                "stream":true
            }),
        },
        &ResponsesSseMalformedEventJsonTransport,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 0,
        },
    )
    .await
    .unwrap();

    assert_eq!(output.status, 502);
    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("provider failure must project a JSON error body")
    };
    let message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .expect("projected provider error message");
    assert!(
        !message.contains("malformed SSE"),
        "provider event payload JSON/schema failures are codec-owned, not SSE transport-owned: {message}"
    );
    assert!(
        message.contains("provider response event codec failed"),
        "event payload JSON/schema failures must name provider event codec owner: {message}"
    );
}

#[test]
fn provider_key_consecutive_failures_cool_for_fifteen_minutes_without_cross_model_pollution() {
    let store = V3ProviderHealthStore::from_manifest(&responses_single_limited_manifest());
    let failure_session_scope = routecodex_v3_error::V3ProviderFailureSessionScope::new(
        "test-server",
        "test-group",
        "provider-key-cooldown",
    )
    .expect("test provider failure session scope");
    for (index, now_ms) in [1_000, 2_000, 3_000].into_iter().enumerate() {
        let record = store
            .record_provider_failure_in_session(
                &failure_session_scope,
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
            .availability_for_session(
                &failure_session_scope,
                "limited",
                Some("key1"),
                Some("gpt-5.5"),
                902_999
            )
            .available
    );
    assert!(
        store
            .availability_for_session(
                &failure_session_scope,
                "limited",
                Some("key1"),
                Some("gpt-5.5"),
                903_000
            )
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
    let server_id = "provider_error_terminal_closeout";
    let output = execute_v3_anthropic_relay_runtime(
        &manifest_for_scope(server_id),
        V3AnthropicRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-closeout-error".into(),
            payload: json!({
                "model":"claude-client-alias",
                "messages":[{"role":"user","content":"fail"}],
                "tools":[{"name":"servertool.exec","input_schema":{"type":"object"}}],
                "stream":false
            }),
        },
        &ErrorTransport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 429);
    assert_eq!(output.client_response["error"]["code"], "rate_limit_error");
    assert_eq!(output.client_response["error"]["class"], "provider_failure");
    assert_eq!(
        output.client_response["error"]["stage"],
        "V3ProviderReqOutbound09TransportRequest"
    );
    assert_eq!(
        output.client_response["error"]["decision"],
        "project_client_error"
    );
    assert_eq!(
        output.client_response["error"]["error_node"],
        "V3Error06ClientProjected"
    );
    assert_eq!(
        output.error_chain.as_ref().unwrap(),
        &V3_ERROR_CHAIN_NODE_IDS
    );
    assert!(!output.node_trace.contains(&"V3ProviderRespInbound01Raw"));
    assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
    assert!(!output.servertool_followup_required);
}

fn responses_reselect_manifest_for_scope(
    scope: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
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
capabilities = ["text", "tools", "reasoning"]
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
capabilities = ["text", "tools", "reasoning"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "limited", model = "gpt-5.5", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", priority = 2 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "limited", model = "gpt-5.5", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", priority = 2 }
]
"#;
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source.replace("__SCOPE__", scope)).unwrap(),
    )
    .unwrap()
}

fn responses_request_compat_reselect_manifest() -> routecodex_v3_config::V3Config05ManifestPublished
{
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.compat_reselect]
bind = "127.0.0.1"
port = 5555
routing_group = "compat_reselect"
endpoints = ["responses"]
[providers.limited]
type = "anthropic"
base_url = "http://limited.invalid/v1"
default_model = "claude-fable-5"
auth = { type = "api_key", entries = [{ alias = "key1", env = "LIMITED_KEY" }] }
[providers.limited.models."claude-fable-5"]
wire_name = "claude-fable-5"
supports_streaming = true
supports_thinking = true
max_context_tokens = 200000
capabilities = ["text", "tools", "reasoning"]
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
capabilities = ["text", "tools", "reasoning"]
[route_groups.compat_reselect.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "limited", model = "claude-fable-5", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", priority = 2 }
]
[route_groups.compat_reselect.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "limited", model = "claude-fable-5", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", priority = 2 }
]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn responses_request_compat_storm_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.compat_storm]
bind = "127.0.0.1"
port = 5555
routing_group = "compat_storm"
endpoints = ["responses"]
[providers.compat_storm_anthropic]
type = "anthropic"
base_url = "http://compat-storm-anthropic.invalid/v1"
default_model = "claude-fable-5"
auth = { type = "api_key", entries = [{ alias = "key1", env = "COMPAT_STORM_ANTHROPIC_KEY" }] }
[providers.compat_storm_anthropic.models."claude-fable-5"]
wire_name = "claude-fable-5"
supports_streaming = true
supports_thinking = true
max_context_tokens = 200000
capabilities = ["text", "tools", "reasoning"]
[providers.compat_storm_responses]
type = "responses"
base_url = "http://compat-storm-responses.invalid/v1"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "COMPAT_STORM_RESPONSES_KEY" }] }
[providers.compat_storm_responses.models."MiniMax-M3"]
wire_name = "MiniMax-M3"
supports_streaming = true
supports_thinking = true
max_context_tokens = 1000000
capabilities = ["text", "tools", "reasoning"]
[route_groups.compat_storm.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "compat_storm_anthropic", model = "claude-fable-5", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "compat_storm_responses", model = "MiniMax-M3", key = "key1", priority = 2 }
]
[route_groups.compat_storm.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "compat_storm_anthropic", model = "claude-fable-5", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "compat_storm_responses", model = "MiniMax-M3", key = "key1", priority = 2 }
]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn responses_single_limited_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    responses_single_limited_manifest_for_scope("controlled")
}

fn responses_single_limited_manifest_for_scope(
    scope: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
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
capabilities = ["text", "tools", "reasoning"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "limited", model = "gpt-5.5", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "limited", model = "gpt-5.5", key = "key1", priority = 1 }
]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn request(request_id: &str, messages: Value, stream: bool) -> V3AnthropicRelayRuntimeInput {
    V3AnthropicRelayRuntimeInput {
        server_id: "controlled".into(),
        failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
            "test-server",
            "test-group",
            concat!(module_path!(), ":", line!()),
        )
        .expect("test provider failure session scope"),
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
    manifest_for_scope("controlled")
}

fn manifest_for_scope(scope: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
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
capabilities = ["text", "tools", "local_materialization", "tool_outputs", "reasoning", "web_search"]
[route_groups.__SCOPE__.pools.claude_client]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "anthropic", models = ["claude-client-alias"] }
targets = [{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn openai_chat_target_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 5555
routing_group = "controlled"
endpoints = ["responses"]
[servers.controlled.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
[providers.chat]
type = "openai_chat"
base_url = "http://controlled.invalid/v1"
default_model = "chat-wire-model"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "CONTROLLED_KEY" }] }
[providers.chat.models.chat-wire-model]
wire_name = "chat-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "local_materialization", "tool_outputs", "reasoning", "web_search"]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "chat", model = "chat-wire-model", key = "controlled", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}
