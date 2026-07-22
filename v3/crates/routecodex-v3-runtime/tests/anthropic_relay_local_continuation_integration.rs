use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderHttpFailure, V3ProviderResp14Raw,
    V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_anthropic_relay_runtime_with_local_continuation,
    V3AnthropicRelayLocalContinuationScope, V3AnthropicRelayLocalContinuationState,
    V3AnthropicRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

struct SequentialJsonTransport {
    captures: Mutex<Vec<Value>>,
    responses: Mutex<VecDeque<Value>>,
}

#[async_trait]
impl ResponsesTransport for SequentialJsonTransport {
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
async fn json_two_turn_save_restore_order_and_terminal_release() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_local_1",
                "status":"completed",
                "output":[
                    {"type":"reasoning","summary":[{"type":"summary_text","text":"Need lookup"}]},
                    {"type":"function_call","call_id":"call_local_1","name":"lookup","arguments":"{\"q\":\"alpha\"}"}
                ]
            }),
            json!({
                "id":"resp_local_2",
                "status":"completed",
                "output":[{"type":"output_text","text":"alpha result"}]
            }),
        ])),
    };
    let state = V3AnthropicRelayLocalContinuationState::default();
    let scope = V3AnthropicRelayLocalContinuationScope::anthropic(
        "/v1/messages",
        "session-local",
        "conversation-local",
        5555,
        "controlled",
    );

    let first = execute_v3_anthropic_relay_runtime_with_local_continuation(
        &manifest(),
        V3AnthropicRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-local-1".into(),
            payload: json!({
                "model":"claude-client-alias",
                "messages":[{"role":"user","content":"Lookup alpha"}],
                "tools":[{"name":"lookup","input_schema":{"type":"object"}}],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        1_000,
    )
    .await
    .unwrap();
    assert_eq!(first.client_response["stop_reason"], "tool_use");
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_anthropic_relay_runtime_with_local_continuation(
        &manifest(),
        V3AnthropicRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-local-2".into(),
            payload: json!({
                "model":"claude-client-alias",
                "messages":[{"role":"user","content":[{
                    "type":"tool_result",
                    "tool_use_id":"call_local_1",
                    "content":"alpha"
                }]}],
                "tools":[{"name":"lookup","input_schema":{"type":"object"}}],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        2_000,
    )
    .await
    .unwrap();
    assert_eq!(second.client_response["stop_reason"], "end_turn");
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(
        captures[1]["input"],
        json!([
            {"type":"reasoning","summary":[{"type":"summary_text","text":"Need lookup"}]},
            {"type":"function_call","call_id":"call_local_1","name":"lookup","arguments":"{\"q\":\"alpha\"}"},
            {"type":"function_call_output","call_id":"call_local_1","output":"alpha"}
        ])
    );
    for payload in captures.iter() {
        let text = serde_json::to_string(payload).unwrap();
        for forbidden in [
            "routecodex_local",
            "session-local",
            "conversation-local",
            "store_key",
        ] {
            assert!(
                !text.contains(forbidden),
                "provider payload leaked {forbidden}"
            );
        }
    }
}

struct SseThenJsonTransport {
    captures: Mutex<Vec<Value>>,
    turn: AtomicUsize,
}

#[async_trait]
impl ResponsesTransport for SseThenJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures.lock().unwrap().push(request.body().clone());
        if self.turn.fetch_add(1, Ordering::SeqCst) == 0 {
            let stream = futures_util::stream::iter([
                Ok(b"event: response.reasoning_summary_text.delta\ndata: {\"delta\":\"Need gamma\"}\n\n".to_vec()),
                Ok(b"event: response.output_item.added\ndata: {\"item\":{\"type\":\"function_call\",\"call_id\":\"call_sse_local\",\"name\":\"lookup\",\"arguments\":\"\"}}\n\n".to_vec()),
                Ok(b"event: response.function_call_arguments.delta\ndata: {\"delta\":\"{\\\"q\\\":\\\"gamma\\\"}\"}\n\n".to_vec()),
                Ok(b"event: response.completed\ndata: {\"response\":{\"id\":\"resp_sse_local\",\"status\":\"completed\"}}\n\n".to_vec()),
            ]);
            return Ok(V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"text/event-stream".to_vec(),
                }],
                Box::pin(stream),
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
                "id":"resp_sse_local_2",
                "status":"completed",
                "output":[{"type":"output_text","text":"gamma result"}]
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn sse_first_turn_and_json_second_turn_share_the_same_immutable_lifecycle() {
    let transport = SseThenJsonTransport {
        captures: Mutex::new(Vec::new()),
        turn: AtomicUsize::new(0),
    };
    let state = V3AnthropicRelayLocalContinuationState::default();
    let scope = V3AnthropicRelayLocalContinuationScope::anthropic(
        "/v1/messages",
        "session-sse",
        "conversation-sse",
        5555,
        "controlled",
    );
    let first = execute_v3_anthropic_relay_runtime_with_local_continuation(
        &manifest(),
        request(
            "req-sse-1",
            json!([{"role":"user","content":"Lookup gamma"}]),
            true,
        ),
        &transport,
        &state,
        scope.clone(),
        10_000,
    )
    .await
    .unwrap();
    assert_eq!(
        first.client_response["events"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["event"],
        "message_stop"
    );
    assert_eq!(state.len().unwrap(), 1);

    execute_v3_anthropic_relay_runtime_with_local_continuation(
        &manifest(),
        request(
            "req-sse-2",
            json!([{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_sse_local","content":"gamma"}]}]),
            false,
        ),
        &transport,
        &state,
        scope,
        11_000,
    )
    .await
    .unwrap();
    assert!(state.is_empty().unwrap());
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures[1]["input"][0]["type"], "reasoning");
    assert_eq!(captures[1]["input"][1]["type"], "function_call");
    assert_eq!(captures[1]["input"][2]["type"], "function_call_output");
}

#[tokio::test]
async fn scope_mismatch_fails_before_provider_send_and_preserves_saved_truth() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_scope_1",
            "status":"requires_action",
            "output":[{"type":"function_call","call_id":"call_scope_1","name":"lookup","arguments":"{}"}]
        })])),
    };
    let state = V3AnthropicRelayLocalContinuationState::default();
    let scope = V3AnthropicRelayLocalContinuationScope::anthropic(
        "/v1/messages",
        "session-a",
        "conversation-a",
        5555,
        "controlled",
    );
    execute_v3_anthropic_relay_runtime_with_local_continuation(
        &manifest(),
        request(
            "req-scope-1",
            json!([{"role":"user","content":"lookup"}]),
            false,
        ),
        &transport,
        &state,
        scope,
        20_000,
    )
    .await
    .unwrap();
    let wrong_scope = V3AnthropicRelayLocalContinuationScope::anthropic(
        "/v1/messages",
        "session-b",
        "conversation-a",
        5555,
        "controlled",
    );
    let error = execute_v3_anthropic_relay_runtime_with_local_continuation(
        &manifest(),
        request(
            "req-scope-2",
            json!([{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_scope_1","content":"x"}]}]),
            false,
        ),
        &transport,
        &state,
        wrong_scope,
        21_000,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("scope mismatch"));
    assert_eq!(transport.captures.lock().unwrap().len(), 1);
    assert_eq!(state.len().unwrap(), 1);
}

struct SaveThenErrorTransport {
    turn: AtomicUsize,
}

#[async_trait]
impl ResponsesTransport for SaveThenErrorTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        if self.turn.fetch_add(1, Ordering::SeqCst) == 0 {
            return Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![],
                serde_json::to_vec(&json!({
                    "id":"resp_error_keep",
                    "status":"requires_action",
                    "output":[{"type":"function_call","call_id":"call_error_keep","name":"lookup","arguments":"{}"}]
                }))
                .unwrap(),
            ));
        }
        Err(V3ProviderError::HttpStatus {
            response: Box::new(V3ProviderHttpFailure {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                status: 429,
                headers: vec![],
                body: br#"{"error":{"message":"retry later"}}"#.to_vec(),
            }),
        })
    }
}

#[tokio::test]
async fn provider_error_after_restore_does_not_release_or_project_success() {
    let transport = SaveThenErrorTransport {
        turn: AtomicUsize::new(0),
    };
    let state = V3AnthropicRelayLocalContinuationState::default();
    let scope = V3AnthropicRelayLocalContinuationScope::anthropic(
        "/v1/messages",
        "session-error",
        "conversation-error",
        5555,
        "controlled",
    );
    execute_v3_anthropic_relay_runtime_with_local_continuation(
        &manifest(),
        request(
            "req-error-1",
            json!([{"role":"user","content":"lookup"}]),
            false,
        ),
        &transport,
        &state,
        scope.clone(),
        30_000,
    )
    .await
    .unwrap();
    let output = execute_v3_anthropic_relay_runtime_with_local_continuation(
        &manifest(),
        request(
            "req-error-2",
            json!([{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_error_keep","content":"x"}]}]),
            false,
        ),
        &transport,
        &state,
        scope,
        31_000,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 429);
    assert_eq!(output.client_response["type"], "error");
    assert_eq!(output.error_chain.as_ref().unwrap().len(), 6);
    assert_eq!(state.len().unwrap(), 1);
}

#[tokio::test]
async fn multiple_pending_tool_calls_restore_one_canonical_context_and_release_all_aliases() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_multi_1",
                "status":"requires_action",
                "output":[
                    {"type":"function_call","call_id":"call_multi_a","name":"lookup","arguments":"{\"q\":\"a\"}"},
                    {"type":"function_call","call_id":"call_multi_b","name":"lookup","arguments":"{\"q\":\"b\"}"}
                ]
            }),
            json!({"id":"resp_multi_2","status":"completed","output":[{"type":"output_text","text":"done"}]}),
        ])),
    };
    let state = V3AnthropicRelayLocalContinuationState::default();
    let scope = V3AnthropicRelayLocalContinuationScope::anthropic(
        "/v1/messages",
        "session-multi",
        "conversation-multi",
        5555,
        "controlled",
    );
    execute_v3_anthropic_relay_runtime_with_local_continuation(
        &manifest(),
        request(
            "req-multi-1",
            json!([{"role":"user","content":"lookup both"}]),
            false,
        ),
        &transport,
        &state,
        scope.clone(),
        40_000,
    )
    .await
    .unwrap();
    assert_eq!(state.len().unwrap(), 2);
    execute_v3_anthropic_relay_runtime_with_local_continuation(
        &manifest(),
        request(
            "req-multi-2",
            json!([{"role":"user","content":[
                {"type":"tool_result","tool_use_id":"call_multi_a","content":"a"},
                {"type":"tool_result","tool_use_id":"call_multi_b","content":"b"}
            ]}]),
            false,
        ),
        &transport,
        &state,
        scope,
        41_000,
    )
    .await
    .unwrap();
    assert!(state.is_empty().unwrap());
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures[1]["input"].as_array().unwrap().len(), 4);
    assert_eq!(captures[1]["input"][0]["call_id"], "call_multi_a");
    assert_eq!(captures[1]["input"][1]["call_id"], "call_multi_b");
    assert_eq!(captures[1]["input"][2]["type"], "function_call_output");
    assert_eq!(captures[1]["input"][3]["type"], "function_call_output");
}

fn request(request_id: &str, messages: Value, stream: bool) -> V3AnthropicRelayRuntimeInput {
    V3AnthropicRelayRuntimeInput {
        server_id: "controlled".into(),
        request_id: request_id.into(),
        payload: json!({
            "model":"claude-client-alias",
            "messages":messages,
            "tools":[{"name":"lookup","input_schema":{"type":"object"}}],
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
capabilities = ["text", "tools", "tool_outputs", "local_materialization", "reasoning"]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}
