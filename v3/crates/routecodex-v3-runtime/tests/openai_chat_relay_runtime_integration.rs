use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderAvailabilityReader, V3ProviderError, V3ProviderHttpFailure,
    V3ProviderResp14Raw, V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_openai_chat_relay_runtime,
    execute_v3_openai_chat_relay_runtime_with_provider_health, V3OpenAiChatRelayClientBody,
    V3OpenAiChatRelayRuntimeInput, V3ResponsesRelayProviderHealthHandle,
};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct JsonTransport {
    captured_url: Mutex<Option<String>>,
    captured_body: Mutex<Option<Value>>,
}

#[async_trait]
impl ResponsesTransport for JsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.captured_url.lock().unwrap() = Some(request.url().to_string());
        *self.captured_body.lock().unwrap() = Some(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"chatcmpl-json-1",
                "object":"chat.completion",
                "model":"chat-wire-model",
                "created":1234567890,
                "choices":[{
                    "index":0,
                    "message":{
                        "role":"assistant",
                        "content":null,
                        "refusal":null,
                        "tool_calls":[
                            {"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"alpha\"}"}},
                            {"id":"call_b","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"beta\"}"}}
                        ]
                    },
                    "logprobs":{"content":[]},
                    "finish_reason":"tool_calls"
                }],
                "usage":{
                    "prompt_tokens":10,
                    "prompt_tokens_details":{"cached_tokens":6},
                    "completion_tokens":4,
                    "completion_tokens_details":{"reasoning_tokens":2},
                    "total_tokens":14
                }
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn json_runtime_executes_one_hub_lifecycle_and_preserves_chat_semantics() {
    run_openai_chat_same_protocol_field_parity_request_response_matrix().await;
}

#[tokio::test]
async fn openai_chat_same_protocol_field_parity_request_response_matrix() {
    run_openai_chat_same_protocol_field_parity_request_response_matrix().await;
}

async fn run_openai_chat_same_protocol_field_parity_request_response_matrix() {
    let transport = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let payload = json!({
        "model":"chat-client-alias",
        "messages":[
            {"role":"user","content":"lookup alpha and beta"},
            {"role":"assistant","content":null,"tool_calls":[
                {"id":"prior_a","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"old\"}"}}
            ]},
            {"role":"tool","tool_call_id":"prior_a","content":"old-result"}
        ],
        "tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}],
        "tool_choice":{"type":"function","function":{"name":"lookup"}},
        "parallel_tool_calls":false,
        "stop":["<END>"],
        "temperature":0.4,
        "top_p":0.7,
        "presence_penalty":0.1,
        "frequency_penalty":0.2,
        "logit_bias":{"42":1},
        "seed":777,
        "response_format":{"type":"json_object"},
        "stream_options":{"include_usage":true},
        "user":"chat-user",
        "stream":false,
        "metadata":{"client_visible":"kept"}
    });
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest(),
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-json".into(),
            payload: payload.clone(),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(
        transport.captured_url.lock().unwrap().as_deref(),
        Some("http://controlled.invalid/v1/chat/completions")
    );
    let captured = transport.captured_body.lock().unwrap().clone().unwrap();
    assert_eq!(captured["model"], "chat-wire-model");
    assert_eq!(captured["messages"], payload["messages"]);
    assert_eq!(captured["tools"], payload["tools"]);
    assert_eq!(captured["tool_choice"], payload["tool_choice"]);
    assert_eq!(
        captured["parallel_tool_calls"],
        payload["parallel_tool_calls"]
    );
    assert_eq!(captured["stop"], payload["stop"]);
    assert_eq!(captured["temperature"], payload["temperature"]);
    assert_eq!(captured["top_p"], payload["top_p"]);
    assert_eq!(captured["presence_penalty"], payload["presence_penalty"]);
    assert_eq!(captured["frequency_penalty"], payload["frequency_penalty"]);
    assert_eq!(captured["logit_bias"], payload["logit_bias"]);
    assert_eq!(captured["seed"], payload["seed"]);
    assert_eq!(captured["response_format"], payload["response_format"]);
    assert_eq!(captured["stream_options"], payload["stream_options"]);
    assert_eq!(captured["user"], payload["user"]);
    assert_eq!(captured["metadata"], payload["metadata"]);
    assert_eq!(output.status, 200);
    assert_eq!(output.node_trace.len(), 17);
    assert_eq!(output.node_trace[0], "V3HubReqInbound01ClientRaw");
    assert!(output
        .node_trace
        .contains(&"ProviderReqCompat06ProviderCompat"));
    assert!(output
        .node_trace
        .contains(&"ProviderRespCompat02ProviderCompat"));
    assert_eq!(output.node_trace[16], "V3ServerRespOutbound06ClientFrame");
    let client_response = match output.client_body {
        V3OpenAiChatRelayClientBody::Json(value) => value,
        V3OpenAiChatRelayClientBody::Sse(_) => panic!("expected JSON client body"),
    };
    assert_eq!(client_response["model"], "chat-wire-model");
    assert_eq!(client_response["created"], 1234567890);
    assert_eq!(client_response["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        client_response["choices"][0]["message"]["tool_calls"][1]["id"],
        "call_b"
    );
    assert_eq!(
        client_response["choices"][0]["message"]["refusal"],
        Value::Null
    );
    assert_eq!(
        client_response["choices"][0]["logprobs"],
        json!({"content":[]})
    );
    assert_eq!(
        client_response["usage"]["prompt_tokens_details"]["cached_tokens"],
        6
    );
    assert_eq!(
        client_response["usage"]["completion_tokens_details"]["reasoning_tokens"],
        2
    );
    assert_eq!(client_response["usage"]["total_tokens"], 14);
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
                body: br#"{"error":{"type":"rate_limit_error","message":"controlled rate limit"}}"#
                    .to_vec(),
            }),
        })
    }
}

struct ClientDisconnectTransport;

#[async_trait]
impl ResponsesTransport for ClientDisconnectTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Err(V3ProviderError::ClientDisconnect {
            request_id: request.request_id().to_string(),
            provider_id: request.provider_id().to_string(),
        })
    }
}

#[tokio::test]
async fn client_disconnect_is_typed_terminal_and_does_not_mutate_health_or_action_gate() {
    let manifest = manifest();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    for index in 0..3 {
        let started = Instant::now();
        let output = execute_v3_openai_chat_relay_runtime_with_provider_health(
            &manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: "controlled".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: format!("req-client-disconnect-{index}"),
                payload: json!({
                    "model":"chat-client-alias",
                    "messages":[{"role":"user","content":"disconnect"}],
                    "stream":false
                }),
            },
            &ClientDisconnectTransport,
            provider_health.runtime_health(),
        )
        .await
        .expect("client disconnect has a typed terminal projection");
        assert_eq!(output.status, 499);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "client disconnect entered the provider action wait gate"
        );
    }

    let availability = provider_health.store().availability(
        "controlled",
        Some("controlled"),
        Some("chat-wire-model"),
        u64::MAX,
    );
    assert!(availability.available);
    assert!(availability.blocked_scopes.is_empty());
}

struct ReselectTransport {
    provider_ids: Mutex<Vec<String>>,
}

#[async_trait]
impl ResponsesTransport for ReselectTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let provider_id = request.provider_id().to_string();
        self.provider_ids.lock().unwrap().push(provider_id.clone());
        if provider_id == "primary" {
            return Err(V3ProviderError::HttpStatus {
                response: Box::new(V3ProviderHttpFailure {
                    request_id: request.request_id().to_string(),
                    provider_id,
                    status: 500,
                    headers: vec![],
                    body: br#"{"error":{"type":"server_error","message":"primary failed"}}"#
                        .to_vec(),
                }),
            });
        }
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id().to_string(),
            provider_id,
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"chatcmpl-reselect",
                "object":"chat.completion",
                "model":"chat-wire-model",
                "created":1234567890,
                "choices":[{
                    "index":0,
                    "message":{"role":"assistant","content":"secondary success","refusal":null},
                    "finish_reason":"stop"
                }]
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn provider_http_failure_reselects_next_candidate_before_client_projection() {
    let server_id = "openai_chat_provider_http_reselect";
    let transport = ReselectTransport {
        provider_ids: Mutex::new(Vec::new()),
    };
    let started = Instant::now();
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest_with_two_providers_for_scope(server_id),
        V3OpenAiChatRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-provider-reselect".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"use the available provider"}],
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(
        transport.provider_ids.lock().unwrap().as_slice(),
        ["primary", "secondary"]
    );
    assert!(
        started.elapsed() >= Duration::from_millis(1_000),
        "the first provider failure must block the reselected provider action for at least one second"
    );
    assert_eq!(output.status, 200);
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    assert!(output.error_chain.is_none());
    let client_response = match output.client_body {
        V3OpenAiChatRelayClientBody::Json(value) => value,
        V3OpenAiChatRelayClientBody::Sse(_) => panic!("expected JSON client body"),
    };
    assert_eq!(
        client_response["choices"][0]["message"]["content"],
        "secondary success"
    );
    assert!(
        !client_response.to_string().contains("primary failed"),
        "failed candidate error must not be projected while another candidate succeeds"
    );
}

#[tokio::test]
async fn provider_error_enters_error01_06_without_success_projection() {
    let server_id = "openai_chat_provider_error_projection";
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest_with_identity(server_id),
        V3OpenAiChatRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-error".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"fail"}],
                "stream":false
            }),
        },
        &ErrorTransport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 429);
    let client_response = match output.client_body {
        V3OpenAiChatRelayClientBody::Json(value) => value,
        V3OpenAiChatRelayClientBody::Sse(_) => panic!("expected JSON error body"),
    };
    assert_eq!(client_response["error"]["message"], "controlled rate limit");
    assert_eq!(client_response["error"]["code"], "rate_limit_error");
    assert_eq!(
        client_response["error"]["stage"],
        "V3ProviderReqOutbound09TransportRequest"
    );
    assert_eq!(client_response["error"]["class"], "provider_failure");
    assert_eq!(
        client_response["error"]["error_node"],
        "V3Error06ClientProjected"
    );
    assert!(
        client_response["error"].get("type").is_none(),
        "provider raw error body must not bypass ErrorErr06 projection: {client_response}"
    );
    assert_eq!(output.error_chain.as_ref().unwrap().len(), 6);
    assert!(!output.node_trace.contains(&"V3ProviderRespInbound01Raw"));
    assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
}

struct SseTransport;

#[async_trait]
impl ResponsesTransport for SseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let stream = futures_util::stream::iter([
            Ok(b"data: {\"id\":\"chatcmpl-sse-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_sse\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"\"}}]},\"finish_reason\":null}]".to_vec()),
            Ok(b"}\n\ndata: {\"id\":\"chatcmpl-sse-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"q\\\":\\\"beta\\\"}\"}}]},\"finish_reason\":null}]}\n\n".to_vec()),
            Ok(b"data: {\"id\":\"chatcmpl-sse-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n".to_vec()),
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
async fn sse_runtime_preserves_split_frames_tool_delta_terminal_and_done_order() {
    use futures_util::StreamExt;
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest(),
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-sse".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"lookup beta"}],
                "stream":true
            }),
        },
        &SseTransport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 200);
    let stream = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let events = stream.collect::<Vec<_>>().await;
    let events = events
        .into_iter()
        .map(Result::unwrap)
        .map(|bytes| String::from_utf8(bytes).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 4);
    assert_eq!(
        serde_json::from_str::<Value>(events[0].trim_start_matches("data: ").trim()).unwrap()
            ["choices"][0]["delta"]["role"],
        "assistant",
    );
    assert_eq!(
        serde_json::from_str::<Value>(events[1].trim_start_matches("data: ").trim()).unwrap()
            ["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"],
        "{\"q\":\"beta\"}"
    );
    assert_eq!(
        serde_json::from_str::<Value>(events[2].trim_start_matches("data: ").trim()).unwrap()
            ["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(events[3], "data: [DONE]\n\n");
}

#[tokio::test]
async fn sse_runtime_enters_response_chat_process_and_preserves_reasoning_content() {
    use futures_util::StreamExt;
    let transport = StaticSseTransport {
        chunks: Mutex::new(Some(vec![br#"data: {"id":"chatcmpl-reasoning","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"private chain"},"finish_reason":null}]}

data: {"id":"chatcmpl-reasoning","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"visible answer"},"finish_reason":"stop"}]}

data: [DONE]

"#
        .to_vec()])),
    };
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest(),
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-sse-reasoning-chain".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"think then answer"}],
                "stream":true
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 200);
    assert_eq!(
        &output.node_trace[10..],
        &[
            "V3ProviderRespInbound01Raw",
            "ProviderRespCompat02ProviderCompat",
            "V3HubRespInbound02Normalized",
            "V3HubRespChatProcess03Governed",
            "V3HubRespContinuation04Committed",
            "V3HubRespOutbound05ClientSemantic",
            "V3ServerRespOutbound06ClientFrame"
        ],
        "native OpenAI Chat SSE must enter the same response chain as JSON before client projection"
    );
    let stream = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let events = stream.collect::<Vec<_>>().await;
    let events = events
        .into_iter()
        .map(Result::unwrap)
        .map(|bytes| String::from_utf8(bytes).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 3);
    let reasoning_payload: Value =
        serde_json::from_str(events[0].trim_start_matches("data: ").trim()).unwrap();
    assert_eq!(
        reasoning_payload["choices"][0]["delta"]["reasoning_content"],
        "private chain"
    );
    let text_payload: Value =
        serde_json::from_str(events[1].trim_start_matches("data: ").trim()).unwrap();
    assert_eq!(
        text_payload["choices"][0]["delta"]["content"],
        "visible answer"
    );
    assert_eq!(events[2], "data: [DONE]\n\n");
}

#[tokio::test]
async fn deepseek_max_sse_preserves_empty_delta_terminal_and_done() {
    use futures_util::StreamExt;
    let transport = StaticSseTransport {
        chunks: Mutex::new(Some(vec![br#"data: {"id":"chatcmpl-live-ds4","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}

data: {"id":"chatcmpl-live-ds4","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-live-ds4","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":1,"total_tokens":8}}

data: [DONE]

"#
        .to_vec()])),
    };
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest_with_deepseek_max_profile(),
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-sse-live-ds4-terminal".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"reply OK"}],
                "stream":true
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    let stream = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let events = stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(Result::unwrap)
        .map(|bytes| String::from_utf8(bytes).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 4);
    let terminal: Value =
        serde_json::from_str(events[1].trim_start_matches("data: ").trim()).unwrap();
    assert_eq!(terminal["choices"][0]["delta"], json!({}));
    assert_eq!(terminal["choices"][0]["finish_reason"], "stop");
    let usage: Value = serde_json::from_str(events[2].trim_start_matches("data: ").trim()).unwrap();
    assert_eq!(usage["choices"], json!([]));
    assert_eq!(usage["usage"]["total_tokens"], 8);
    assert_eq!(events[3], "data: [DONE]\n\n");
}

type ControlledSseReceiver = tokio::sync::mpsc::Receiver<Result<Vec<u8>, V3ProviderError>>;

struct ControlledSseTransport {
    receiver: Mutex<Option<ControlledSseReceiver>>,
}

struct RecoverySseTransport {
    receiver: Mutex<Option<ControlledSseReceiver>>,
}

struct StaticSseTransport {
    chunks: Mutex<Option<Vec<Vec<u8>>>>,
}

#[async_trait]
impl ResponsesTransport for StaticSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let chunks = self.chunks.lock().unwrap().take().unwrap();
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![],
            Box::pin(futures_util::stream::iter(chunks.into_iter().map(Ok))),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for ControlledSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let receiver = self.receiver.lock().unwrap().take().unwrap();
        let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
            receiver.recv().await.map(|item| (item, receiver))
        });
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![],
            Box::pin(stream),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for RecoverySseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        if request.provider_id() == "primary" {
            return Err(V3ProviderError::HttpStatus {
                response: Box::new(V3ProviderHttpFailure {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    status: 500,
                    headers: vec![],
                    body: br#"{"error":{"type":"server_error","message":"primary failed"}}"#
                        .to_vec(),
                }),
            });
        }
        let receiver = self.receiver.lock().unwrap().take().unwrap();
        let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
            receiver.recv().await.map(|item| (item, receiver))
        });
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![],
            Box::pin(stream),
        ))
    }
}

#[tokio::test]
async fn sse_first_client_frame_is_observable_before_provider_terminal() {
    use futures_util::StreamExt;
    let (sender, receiver) = tokio::sync::mpsc::channel(2);
    sender
        .send(Ok(br#"data: {"id":"early","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"early"},"finish_reason":null}]}

"#.to_vec()))
        .await
        .unwrap();
    let transport = ControlledSseTransport {
        receiver: Mutex::new(Some(receiver)),
    };
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest(),
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-sse-timing".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"stream now"}],
                "stream":true
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    let mut stream = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let first = tokio::time::timeout(std::time::Duration::from_millis(100), stream.next())
        .await
        .expect("first frame must not wait for terminal")
        .unwrap()
        .unwrap();
    assert!(String::from_utf8(first).unwrap().contains("early"));
    sender
        .send(Ok(br#"data: {"id":"early","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#.to_vec()))
        .await
        .unwrap();
    drop(sender);
    let remaining = stream.collect::<Vec<_>>().await;
    assert_eq!(remaining.len(), 2);
    assert!(remaining.into_iter().all(|item| item.is_ok()));
}

#[tokio::test]
async fn sse_done_before_terminal_and_terminal_without_done_fail_explicitly() {
    use futures_util::StreamExt;
    let cases = [
        (vec![b"data: [DONE]\n\n".to_vec()], "before terminal"),
        (
            vec![br#"data: {"id":"bad","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

"#
            .to_vec()],
            "or [DONE]",
        ),
        (
            vec![
                br#"data: {"id":"bad","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

"#
                .to_vec(),
                br#"data: {"id":"bad","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"late"},"finish_reason":null}]}

"#
                .to_vec(),
            ],
            "after terminal finish_reason",
        ),
    ];
    for (chunks, expected) in cases {
        let transport = StaticSseTransport {
            chunks: Mutex::new(Some(chunks)),
        };
        let output = execute_v3_openai_chat_relay_runtime(
            &manifest(),
            V3OpenAiChatRelayRuntimeInput {
                server_id: "controlled".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-sse-negative".into(),
                payload: json!({
                    "model":"chat-client-alias",
                    "messages":[{"role":"user","content":"invalid stream"}],
                    "stream":true
                }),
            },
            &transport,
        )
        .await
        .unwrap();
        let stream = match output.client_body {
            V3OpenAiChatRelayClientBody::Sse(stream) => stream,
            V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE client body"),
        };
        let items = stream.collect::<Vec<_>>().await;
        assert!(items
            .iter()
            .any(|item| item.as_ref().is_err_and(|error| error.contains(expected))));
    }
}

#[tokio::test]
async fn post_commit_sse_failure_records_failure_but_does_not_block_a_fresh_request() {
    use futures_util::StreamExt;
    let manifest = manifest();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let failing = StaticSseTransport {
        chunks: Mutex::new(Some(vec![
            br#"data: {"id":"partial","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}

"#
            .to_vec(),
            b"data: {malformed-json}\n\n".to_vec(),
        ])),
    };
    let first = execute_v3_openai_chat_relay_runtime_with_provider_health(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-post-commit-failure".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"stream"}],
                "stream":true
            }),
        },
        &failing,
        provider_health.runtime_health(),
    )
    .await
    .expect("first provider action returns a lazy stream");
    let stream = match first.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE"),
    };
    let items = stream.collect::<Vec<_>>().await;
    assert!(items.iter().any(Result::is_err));

    let succeeding = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let second = execute_v3_openai_chat_relay_runtime_with_provider_health(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-after-post-commit-failure".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"next"}],
                "stream":false
            }),
        },
        &succeeding,
        provider_health.runtime_health(),
    )
    .await
    .expect("second provider action");
    assert_eq!(second.status, 200);
}

#[tokio::test]
async fn terminal_sse_recovery_does_not_block_a_fresh_request() {
    use futures_util::StreamExt;
    let manifest = manifest_with_identity("clean_eof");
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let failing = StaticSseTransport {
        chunks: Mutex::new(Some(vec![b"data: {malformed-json}\n\n".to_vec()])),
    };
    let failed = execute_v3_openai_chat_relay_runtime_with_provider_health(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "clean_eof".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-seed-active-gate".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"seed"}],
                "stream":true
            }),
        },
        &failing,
        provider_health.runtime_health(),
    )
    .await
    .expect("failing provider action returns a lazy stream");
    let failed_stream = match failed.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE"),
    };
    assert!(failed_stream
        .collect::<Vec<_>>()
        .await
        .iter()
        .any(Result::is_err));

    let (terminal_sender, terminal_receiver) = tokio::sync::mpsc::channel(2);
    terminal_sender
        .send(Ok(
            br#"data: {"id":"terminal","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}

data: [DONE]

"#
            .to_vec(),
        ))
        .await
        .unwrap();
    let terminal = ControlledSseTransport {
        receiver: Mutex::new(Some(terminal_receiver)),
    };
    let successful = execute_v3_openai_chat_relay_runtime_with_provider_health(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "clean_eof".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-terminal-reset".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"reset"}],
                "stream":true
            }),
        },
        &terminal,
        provider_health.runtime_health(),
    )
    .await
    .expect("terminal provider action");
    let successful_stream = match successful.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE"),
    };
    let mut successful_stream = successful_stream;

    let waiting_manifest = manifest.clone();
    let waiting_health = provider_health.runtime_health();
    let waiter = tokio::spawn(async move {
        let succeeding = JsonTransport {
            captured_url: Mutex::new(None),
            captured_body: Mutex::new(None),
        };
        execute_v3_openai_chat_relay_runtime_with_provider_health(
            &waiting_manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: "clean_eof".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-released-by-terminal-success".into(),
                payload: json!({
                    "model":"chat-client-alias",
                    "messages":[{"role":"user","content":"released"}],
                    "stream":false
                }),
            },
            &succeeding,
            waiting_health,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        waiter.is_finished(),
        "fresh OpenAI Chat request consumed an unrelated Error05 recovery lane"
    );
    let fresh = waiter
        .await
        .expect("fresh request task panicked")
        .expect("fresh request failed");
    assert_eq!(fresh.status, 200);

    assert!(successful_stream.next().await.unwrap().is_ok());
    assert!(successful_stream.next().await.unwrap().is_ok());

    drop(terminal_sender);
    assert!(
        successful_stream.next().await.is_none(),
        "clean EOF must finish the client stream"
    );
}

#[tokio::test]
async fn active_recovery_sse_blocks_a_second_recovery_beyond_five_seconds() {
    use futures_util::StreamExt;
    let server_id = "openai_chat_active_recovery";
    const FAILURE_SESSION_ID: &str = "openai-chat-active-recovery-session";
    let manifest = manifest_with_two_providers_for_scope(server_id);
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let (terminal_sender, terminal_receiver) = tokio::sync::mpsc::channel(2);
    terminal_sender
        .send(Ok(
            br#"data: {"id":"terminal","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}

data: [DONE]

"#
            .to_vec(),
        ))
        .await
        .unwrap();
    let first = execute_v3_openai_chat_relay_runtime_with_provider_health(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                FAILURE_SESSION_ID,
            )
            .expect("test provider failure session scope"),
            request_id: "req-active-recovery-stream".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"recover as a lazy stream"}],
                "stream":true
            }),
        },
        &RecoverySseTransport {
            receiver: Mutex::new(Some(terminal_receiver)),
        },
        provider_health.runtime_health(),
    )
    .await
    .expect("first request must reach a lazy recovery stream");
    assert!(
        first.node_trace.contains(&"V3ProviderActionGateAdmission"),
        "the controlled lazy SSE must be a recovery action"
    );
    let mut first_stream = match first.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE"),
    };
    assert!(first_stream.next().await.unwrap().is_ok());
    assert!(first_stream.next().await.unwrap().is_ok());

    let waiting_manifest = manifest.clone();
    let waiting_health = provider_health.runtime_health();
    let waiter = tokio::spawn(async move {
        execute_v3_openai_chat_relay_runtime_with_provider_health(
            &waiting_manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: server_id.into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    FAILURE_SESSION_ID,
                )
                .expect("test provider failure session scope"),
                request_id: "req-second-recovery-action".into(),
                payload: json!({
                    "model":"chat-client-alias",
                    "messages":[{"role":"user","content":"also fail then recover"}],
                    "stream":false
                }),
            },
            &ReselectTransport {
                provider_ids: Mutex::new(Vec::new()),
            },
            waiting_health,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(5_200)).await;
    assert!(
        !waiter.is_finished(),
        "active recovery permit expired by wall clock before terminal success"
    );

    let success_completed_at = Instant::now();
    drop(terminal_sender);
    assert!(
        first_stream.next().await.is_none(),
        "clean EOF must finish the first recovery stream"
    );
    let released = tokio::time::timeout(Duration::from_secs(6), waiter)
        .await
        .expect("clean EOF did not release the queued recovery action")
        .expect("queued recovery task panicked")
        .expect("queued recovery action failed");
    assert_eq!(released.status, 200);
    assert!(
        released
            .node_trace
            .contains(&"V3ProviderActionGateAdmission"),
        "the competing request must also enter Error05 recovery"
    );
    assert!(
        success_completed_at.elapsed() >= Duration::from_millis(4_800),
        "terminal success must preserve the sustained five-second recovery spacing"
    );
}

#[tokio::test]
async fn sse_transport_error_after_done_is_failure() {
    use futures_util::StreamExt;
    let manifest = manifest_with_identity("post_done_transport");
    let (sender, receiver) = tokio::sync::mpsc::channel(2);
    sender
        .send(Ok(
            br#"data: {"id":"post-done-transport","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#
            .to_vec(),
        ))
        .await
        .unwrap();
    sender
        .send(Err(V3ProviderError::Transport {
            request_id: "req-post-done-transport".into(),
            provider_id: "post_done_transport".into(),
            reason: "transport failed after done".into(),
        }))
        .await
        .unwrap();
    drop(sender);
    let transport = ControlledSseTransport {
        receiver: Mutex::new(Some(receiver)),
    };
    let output = execute_v3_openai_chat_relay_runtime(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "post_done_transport".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-post-done-transport".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"stream"}],
                "stream":true
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    let stream = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream,
        V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE"),
    };
    let items = stream.collect::<Vec<_>>().await;
    assert!(items.iter().any(|item| item
        .as_ref()
        .is_err_and(|error| error.contains("transport failed after done"))));
}

#[tokio::test]
async fn sse_malformed_frame_and_incomplete_tail_after_done_are_failures() {
    use futures_util::StreamExt;
    let terminal_and_done =
        br#"data: {"id":"post-done-tail","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#
        .to_vec();
    let cases = [
        (b"data: {malformed-json}\n\n".to_vec(), "frame after [DONE]"),
        (b"event: unexpected-tail\n\n".to_vec(), "frame after [DONE]"),
        (b"data: {unterminated".to_vec(), "final frame delimiter"),
    ];
    for (index, (tail, expected)) in cases.into_iter().enumerate() {
        let identity = format!("post_done_tail_{index}");
        let manifest = manifest_with_identity(&identity);
        let transport = StaticSseTransport {
            chunks: Mutex::new(Some(vec![terminal_and_done.clone(), tail])),
        };
        let output = execute_v3_openai_chat_relay_runtime(
            &manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: identity,
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: format!("req-post-done-{}", expected.replace(' ', "-")),
                payload: json!({
                    "model":"chat-client-alias",
                    "messages":[{"role":"user","content":"stream"}],
                    "stream":true
                }),
            },
            &transport,
        )
        .await
        .unwrap();
        let stream = match output.client_body {
            V3OpenAiChatRelayClientBody::Sse(stream) => stream,
            V3OpenAiChatRelayClientBody::Json(_) => panic!("expected SSE"),
        };
        let items = stream.collect::<Vec<_>>().await;
        assert!(
            items
                .iter()
                .any(|item| item.as_ref().is_err_and(|error| error.contains(expected))),
            "{expected}: {items:?}"
        );
    }
}

#[tokio::test]
async fn request_side_channel_is_rejected_before_provider_transport() {
    let error = execute_v3_openai_chat_relay_runtime(
        &manifest(),
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-isolation".into(),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"hello"}],
                "metadata_center":{"route":"must-not-leak"},
                "stream":false
            }),
        },
        &ErrorTransport,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("metadata_center"));
}

#[tokio::test]
async fn openai_chat_unknown_direct_provider_model_returns_model_not_found() {
    let manifest = manifest();
    let runtime = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let error = execute_v3_openai_chat_relay_runtime(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "controlled",
                "controlled",
                "session-openai-chat-404",
            )
            .expect("test provider failure session scope"),
            request_id: "req-openai-chat-404".into(),
            payload: json!({
                "model":"controlled.unknown-model",
                "messages":[{"role":"user","content":"ping"}],
                "stream":false
            }),
        },
        &runtime,
    )
    .await
    .unwrap_err();
    assert!(
        error.to_string().contains("direct provider model controlled.unknown-model is not configured"),
        "openai_chat provider.model absence must surface ModelNotFound: {error}"
    );
}

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 1
routing_group = "controlled"
endpoints = ["openai_chat"]
[providers.controlled]
type = "openai_chat"
base_url = "http://controlled.invalid/v1"
default_model = "chat-wire-model"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "CONTROLLED_KEY" }] }
[providers.controlled.models.chat-wire-model]
wire_name = "chat-wire-model"
supports_streaming = true
capabilities = ["text", "tools", "web_search"]
[route_groups.controlled.pools.chat_client]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "openai_chat", models = ["chat-client-alias"] }
targets = [{ kind = "provider_model", provider = "controlled", model = "chat-wire-model", key = "controlled", priority = 1 }]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "chat-wire-model", key = "controlled", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn manifest_with_deepseek_max_profile() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 1
routing_group = "controlled"
endpoints = ["openai_chat"]
[providers.controlled]
type = "openai_chat"
base_url = "http://controlled.invalid/v1"
default_model = "chat-wire-model"
compatibility_profile = "chat:deepseek-max"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "CONTROLLED_KEY" }] }
[providers.controlled.models.chat-wire-model]
wire_name = "chat-wire-model"
supports_streaming = true
capabilities = ["text", "tools", "web_search"]
[route_groups.controlled.pools.chat_client]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "openai_chat", models = ["chat-client-alias"] }
targets = [{ kind = "provider_model", provider = "controlled", model = "chat-wire-model", key = "controlled", priority = 1 }]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "chat-wire-model", key = "controlled", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn manifest_with_identity(identity: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&format!(
            r#"
version = 3
[servers.{identity}]
bind = "127.0.0.1"
port = 1
routing_group = "{identity}"
endpoints = ["openai_chat"]
[providers.{identity}]
type = "openai_chat"
base_url = "http://{identity}.invalid/v1"
default_model = "chat-wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "{identity}", env = "CONTROLLED_KEY" }}] }}
[providers.{identity}.models.chat-wire-model]
wire_name = "chat-wire-model"
supports_streaming = true
capabilities = ["text", "tools", "web_search"]
[route_groups.{identity}.pools.chat_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["chat-client-alias"] }}
targets = [{{ kind = "provider_model", provider = "{identity}", model = "chat-wire-model", key = "{identity}", priority = 1 }}]
[route_groups.{identity}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{identity}", model = "chat-wire-model", key = "{identity}", priority = 1 }}]
"#
        ))
        .unwrap(),
    )
    .unwrap()
}

fn manifest_with_two_providers_for_scope(
    scope: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 1
routing_group = "__SCOPE__"
endpoints = ["openai_chat"]
[providers.primary]
type = "openai_chat"
base_url = "http://primary.invalid/v1"
default_model = "chat-wire-model"
auth = { type = "api_key", entries = [{ alias = "primary", env = "V3_OPENAI_CHAT_PRIMARY_KEY" }] }
[providers.primary.models.chat-wire-model]
wire_name = "chat-wire-model"
aliases = ["chat-client-alias"]
supports_streaming = true
capabilities = ["text", "tools", "web_search"]
[providers.secondary]
type = "openai_chat"
base_url = "http://secondary.invalid/v1"
default_model = "chat-wire-model"
auth = { type = "api_key", entries = [{ alias = "secondary", env = "V3_OPENAI_CHAT_SECONDARY_KEY" }] }
[providers.secondary.models.chat-wire-model]
wire_name = "chat-wire-model"
aliases = ["chat-client-alias"]
supports_streaming = true
capabilities = ["text", "tools", "web_search"]
[route_groups.__SCOPE__.pools.chat_client]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "openai_chat", models = ["chat-client-alias"] }
targets = [
  { kind = "provider_model", provider = "primary", model = "chat-wire-model", key = "primary", priority = 1 },
  { kind = "provider_model", provider = "secondary", model = "chat-wire-model", key = "secondary", priority = 2 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "primary", model = "chat-wire-model", key = "primary", priority = 1 },
  { kind = "provider_model", provider = "secondary", model = "chat-wire-model", key = "secondary", priority = 2 }
]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}
