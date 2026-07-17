use async_trait::async_trait;
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS;
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderHttpFailure, V3ProviderResp14Raw,
    V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_anthropic_relay_runtime,
    execute_v3_anthropic_relay_runtime_with_local_continuation_and_servertool_profile,
    execute_v3_responses_relay_runtime, V3AnthropicRelayLocalContinuationScope,
    V3AnthropicRelayLocalContinuationState, V3AnthropicRelayRuntimeInput,
    V3ResponsesRelayClientBody, V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

const EXPECTED_RELAY_TRACE: [&str; 15] = [
    "V3HubReqInbound01ClientRaw",
    "V3HubReqInbound02Normalized",
    "V3HubReqContinuation03Classified",
    "V3HubReqChatProcess04Governed",
    "V3HubReqExecution05Planned",
    "V3HubReqTarget06Resolved",
    "V3HubReqOutbound07ProviderSemantic",
    "V3ProviderReqOutbound08WirePayload",
    "V3ProviderReqOutbound09TransportRequest",
    "V3ProviderRespInbound01Raw",
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
        Some("streaming")
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
